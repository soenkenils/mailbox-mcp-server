import { createHash, randomBytes } from "node:crypto";
import { OAuthClientMetadataSchema } from "@modelcontextprotocol/core";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import cors from "cors";
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Router,
} from "express";
import { rateLimit } from "express-rate-limit";
import * as v from "valibot";
import { createLogger } from "../../services/Logger.js";
import type { MailboxOAuthProvider } from "./provider.js";
import { redirectUriMatches } from "./redirectPolicy.js";

/**
 * The OAuth authorization server's HTTP endpoints.
 *
 * The MCP SDK dropped these from v2 in favour of dedicated identity providers.
 * That does not suit a single-user server that keeps no state, so they live
 * here instead.
 */

const MINUTE_MS = 60 * 1000;
const CLIENT_SECRET_TTL_SECONDS = 30 * 24 * 60 * 60;

const logger = createLogger("OAuthRouter");

const OptionalUrlSchema = v.optional(v.pipe(v.string(), v.url()));

const ClientParamsSchema = v.object({
  client_id: v.string(),
  redirect_uri: OptionalUrlSchema,
});

const AuthorizationParamsSchema = v.object({
  response_type: v.literal("code"),
  code_challenge: v.string(),
  code_challenge_method: v.literal("S256"),
  scope: v.optional(v.string()),
  state: v.optional(v.string()),
  resource: OptionalUrlSchema,
});

const TokenRequestSchema = v.object({ grant_type: v.string() });

const AuthorizationCodeGrantSchema = v.object({
  code: v.string(),
  code_verifier: v.string(),
  redirect_uri: v.optional(v.string()),
  resource: OptionalUrlSchema,
});

const RefreshTokenGrantSchema = v.object({
  refresh_token: v.string(),
  scope: v.optional(v.string()),
  resource: OptionalUrlSchema,
});

/** Parses request parameters, reporting a mismatch as `invalid_request`. */
const parseParams = <const TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> => {
  const result = v.safeParse(schema, input);
  if (result.success) {
    return result.output;
  }

  const [issue] = result.issues;
  throw new OAuthError(
    OAuthErrorCode.InvalidRequest,
    `${v.getDotPath(issue) ?? "request"}: ${issue.message}`,
  );
};

const allowedMethods =
  (methods: string[]): RequestHandler =>
  (req, res, next) => {
    if (methods.includes(req.method)) {
      next();
      return;
    }

    res
      .status(405)
      .set("Allow", methods.join(", "))
      .json(
        new OAuthError(
          OAuthErrorCode.MethodNotAllowed,
          `The method ${req.method} is not allowed for this endpoint`,
        ).toResponseObject(),
      );
  };

const limitRequests = (name: string, windowMs: number, limit: number) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    message: new OAuthError(
      OAuthErrorCode.TooManyRequests,
      `You have exceeded the rate limit for ${name} requests`,
    ).toResponseObject(),
  });

const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
};

/** Parameters arrive in the body of a POST and the query string of a GET. */
const requestParams = (req: Request): unknown =>
  req.method === "POST" ? req.body : req.query;

/** The request's `state`, for echoing in an error even if validation failed. */
const stateOf = (params: unknown): string | undefined => {
  const state = (params as { state?: unknown } | undefined)?.state;
  return typeof state === "string" ? state : undefined;
};

const errorRedirect = (
  redirectUri: string,
  error: OAuthError,
  issuer: string,
  state?: string,
): string => {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error.code);
  url.searchParams.set("error_description", error.message);
  if (state) {
    url.searchParams.set("state", state);
  }
  url.searchParams.set("iss", issuer);
  return url.href;
};

const authorizationRouter = (
  provider: MailboxOAuthProvider,
  issuer: string,
): Router => {
  const router = express.Router();

  router.use(
    allowedMethods(["GET", "POST"]),
    limitRequests("authorization", 15 * MINUTE_MS, 100),
    express.urlencoded({ extended: false }),
    noStore,
  );

  router.all("/", async (req, res) => {
    const params = requestParams(req);

    // Until the client and redirect URI are verified there is nowhere safe to
    // send an error, so these failures are answered directly. Redirecting them
    // would make this an open redirector.
    const { client_id, redirect_uri } = parseParams(ClientParamsSchema, params);

    const client = await provider.clientsStore.getClient(client_id);
    if (!client) {
      throw new OAuthError(OAuthErrorCode.InvalidClient, "Invalid client_id");
    }

    let redirectUri = redirect_uri;
    if (redirectUri !== undefined) {
      const requested = redirectUri;
      if (
        !client.redirect_uris.some(registered =>
          redirectUriMatches(requested, registered),
        )
      ) {
        throw new OAuthError(
          OAuthErrorCode.InvalidRequest,
          "Unregistered redirect_uri",
        );
      }
    } else if (client.redirect_uris.length === 1) {
      redirectUri = client.redirect_uris[0];
    } else {
      throw new OAuthError(
        OAuthErrorCode.InvalidRequest,
        "redirect_uri must be specified unless client has exactly one registered URI",
      );
    }

    try {
      const { scope, state, code_challenge } = parseParams(
        AuthorizationParamsSchema,
        params,
      );

      await provider.authorize(
        client,
        {
          state,
          scopes: scope === undefined ? [] : scope.split(" "),
          redirectUri,
          codeChallenge: code_challenge,
          issuer,
        },
        res,
      );
    } catch (error) {
      const oauthError =
        error instanceof OAuthError
          ? error
          : new OAuthError(OAuthErrorCode.ServerError, "Internal Server Error");

      res.redirect(
        302,
        errorRedirect(redirectUri, oauthError, issuer, stateOf(params)),
      );
    }
  });

  return router;
};

const tokenRouter = (provider: MailboxOAuthProvider): Router => {
  const router = express.Router();

  router.use(
    cors(),
    allowedMethods(["POST"]),
    limitRequests("token", 15 * MINUTE_MS, 50),
    express.urlencoded({ extended: false }),
    noStore,
  );

  router.post("/", async (req, res) => {
    const { client_id } = parseParams(ClientParamsSchema, req.body);
    const client = await provider.clientsStore.getClient(client_id);
    if (!client) {
      throw new OAuthError(OAuthErrorCode.InvalidClient, "Invalid client_id");
    }

    const { grant_type } = parseParams(TokenRequestSchema, req.body);

    switch (grant_type) {
      case "authorization_code": {
        const { code, code_verifier, redirect_uri } = parseParams(
          AuthorizationCodeGrantSchema,
          req.body,
        );

        const challenge = await provider.challengeForAuthorizationCode(code);
        const computed = createHash("sha256")
          .update(code_verifier)
          .digest("base64url");
        if (computed !== challenge) {
          throw new OAuthError(
            OAuthErrorCode.InvalidGrant,
            "code_verifier does not match the challenge",
          );
        }

        res
          .status(200)
          .json(
            await provider.exchangeAuthorizationCode(
              client,
              code,
              redirect_uri,
            ),
          );
        return;
      }

      case "refresh_token": {
        const { refresh_token, scope } = parseParams(
          RefreshTokenGrantSchema,
          req.body,
        );

        res
          .status(200)
          .json(
            await provider.exchangeRefreshToken(
              client,
              refresh_token,
              scope?.split(" "),
            ),
          );
        return;
      }

      default:
        throw new OAuthError(
          OAuthErrorCode.UnsupportedGrantType,
          "The grant type is not supported by this authorization server.",
        );
    }
  });

  return router;
};

const registrationRouter = (provider: MailboxOAuthProvider): Router => {
  const router = express.Router();

  router.use(
    cors(),
    allowedMethods(["POST"]),
    limitRequests("client registration", 60 * MINUTE_MS, 20),
    express.json(),
    noStore,
  );

  router.post("/", async (req, res) => {
    const parsed = OAuthClientMetadataSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new OAuthError(
        OAuthErrorCode.InvalidClientMetadata,
        parsed.error.message,
      );
    }

    const issuedAt = Math.floor(Date.now() / 1000);

    // A client registering as confidential expects to receive a secret, but
    // nothing stores or checks it: registration keeps no state, and PKCE is
    // what ties an authorization code to the client that asked for it.
    const secret =
      parsed.data.token_endpoint_auth_method === "none"
        ? {}
        : {
            client_secret: randomBytes(32).toString("hex"),
            client_secret_expires_at: issuedAt + CLIENT_SECRET_TTL_SECONDS,
          };

    res.status(201).json(
      await provider.clientsStore.registerClient({
        ...parsed.data,
        ...secret,
        client_id_issued_at: issuedAt,
      }),
    );
  });

  return router;
};

const metadataRouter = (metadata: object): Router => {
  const router = express.Router();

  router.use(cors(), allowedMethods(["GET", "OPTIONS"]));
  router.get("/", (_req, res) => {
    res.status(200).json(metadata);
  });

  return router;
};

/**
 * Every handler above throws rather than responding to a failure. A body that
 * could not be read arrives here too, as an error from the parser carrying a
 * 4xx status.
 */
const handleError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof OAuthError) {
    res.status(400).json(error.toResponseObject());
    return;
  }

  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res
      .status(status)
      .json(
        new OAuthError(
          OAuthErrorCode.InvalidRequest,
          "The request body could not be read",
        ).toResponseObject(),
      );
    return;
  }

  logger.error(
    "Unhandled error in an OAuth endpoint",
    { operation: "oauth", service: "OAuthRouter" },
    { error: error instanceof Error ? error.message : String(error) },
  );
  res
    .status(500)
    .json(
      new OAuthError(
        OAuthErrorCode.ServerError,
        "Internal Server Error",
      ).toResponseObject(),
    );
};

/** Clients trust whatever the issuer publishes, so it has to be unambiguous. */
const assertValidIssuer = (issuer: URL): void => {
  if (
    issuer.protocol !== "https:" &&
    issuer.hostname !== "localhost" &&
    issuer.hostname !== "127.0.0.1"
  ) {
    throw new Error("Issuer URL must be HTTPS");
  }
  if (issuer.hash) {
    throw new Error(`Issuer URL must not have a fragment: ${issuer}`);
  }
  if (issuer.search) {
    throw new Error(`Issuer URL must not have a query string: ${issuer}`);
  }
};

export interface OAuthRouterOptions {
  provider: MailboxOAuthProvider;
  /** Also the resource server, since this server is both. */
  issuerUrl: URL;
  resourceName: string;
}

/** Serves discovery metadata, authorization, token and registration. */
export const createOAuthRouter = ({
  provider,
  issuerUrl,
  resourceName,
}: OAuthRouterOptions): Router => {
  assertValidIssuer(issuerUrl);

  const issuer = issuerUrl.href;
  const endpoint = (path: string) => new URL(path, issuerUrl).href;
  const router = express.Router();

  router.use("/authorize", authorizationRouter(provider, issuer));
  router.use("/token", tokenRouter(provider));
  router.use("/register", registrationRouter(provider));
  router.use(
    "/.well-known/oauth-authorization-server",
    metadataRouter({
      issuer,
      authorization_endpoint: endpoint("/authorize"),
      token_endpoint: endpoint("/token"),
      registration_endpoint: endpoint("/register"),
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      authorization_response_iss_parameter_supported: true,
    }),
  );
  router.use(
    "/.well-known/oauth-protected-resource",
    metadataRouter({
      resource: issuer,
      authorization_servers: [issuer],
      resource_name: resourceName,
    }),
  );
  router.use(handleError);

  return router;
};
