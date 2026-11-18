import { randomUUID } from "node:crypto";
import {
  type AuthInfo,
  type OAuthClientInformationFull,
  OAuthError,
  OAuthErrorCode,
  type OAuthTokens,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";
import type { Response } from "express";
import { verifyToken } from "../auth.js";
import {
  DEFAULT_ALLOWED_REDIRECT_HOSTS,
  rejectedRedirectUris,
} from "./redirectPolicy.js";
import { deriveSigningKey, issueToken, readToken } from "./tokens.js";

/**
 * Single-user OAuth authorization server.
 *
 * There is exactly one resource owner — the person holding MCP_AUTH_TOKEN — so
 * the authorization step is a form asking for that token rather than a user
 * database. Everything else (client registration, authorization codes, access
 * and refresh tokens) is carried in signed tokens, so the flow needs no
 * storage and survives the machine being stopped while idle.
 */

const AUTHORIZATION_CODE_TTL_SECONDS = 60;
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Fields echoed back through the login form so the POST re-validates identically. */
const FORM_FIELDS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
];

/** A validated authorization request. */
export interface AuthorizationParams {
  state?: string;
  scopes: string[];
  redirectUri: string;
  codeChallenge: string;
  /** Returned with the code, per RFC 9207, so clients can detect a mix-up. */
  issuer: string;
}

export interface ConsentDetails {
  /** Name supplied at registration, which is not verified in any way. */
  clientName?: string;
  /** Where the authorization code will be delivered if this is approved. */
  redirectUri: string;
}

/**
 * Renders the consent screen.
 *
 * Client registration is open, so anyone can register a client with an
 * arbitrary redirect URI and send a link to this page. The origin and its
 * certificate would look entirely genuine, and approving would deliver an
 * authorization code — and therefore mailbox access — to that URI. The
 * destination is therefore shown prominently so an unexpected one is visible
 * before the credential is entered.
 */
const renderLoginForm = (
  fields: Record<string, string>,
  consent: ConsentDetails,
  error?: string,
): string => {
  const hidden = FORM_FIELDS.filter(name => fields[name])
    .map(
      name =>
        `<input type="hidden" name="${name}" value="${escapeHtml(fields[name])}">`,
    )
    .join("\n      ");

  const redirectHost = (() => {
    try {
      return new URL(consent.redirectUri).host;
    } catch {
      return consent.redirectUri;
    }
  })();

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Authorize access</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 28rem; margin: 4rem auto; padding: 0 1rem; }
      input[type=password] { width: 100%; padding: .5rem; margin: .5rem 0 1rem; box-sizing: border-box; }
      button { padding: .5rem 1rem; }
      .error { color: #b00020; }
      .details { background: #f4f4f5; border-radius: .5rem; padding: .75rem 1rem; margin: 1rem 0; }
      .details dt { font-size: .8rem; color: #52525b; }
      .details dd { margin: 0 0 .5rem; font-weight: 600; word-break: break-all; }
      .warn { font-size: .9rem; color: #52525b; }
    </style>
  </head>
  <body>
    <h1>Authorize access</h1>
    <p>An application is requesting access to your mailbox, calendar and mail filters.</p>
    <dl class="details">
      <dt>Application</dt>
      <dd>${escapeHtml(consent.clientName || "Unnamed application")}</dd>
      <dt>Will be sent to</dt>
      <dd>${escapeHtml(redirectHost)}</dd>
    </dl>
    <p class="warn">Only continue if you started this and recognise the destination above. The application name is self-reported and not verified.</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <form method="post">
      ${hidden}
      <label for="mcp_token">Access token</label>
      <input id="mcp_token" name="mcp_token" type="password" autocomplete="current-password" autofocus>
      <button type="submit">Authorize</button>
    </form>
  </body>
</html>`;
};

/**
 * Sends the consent page. Framing is refused because the token field is
 * autofillable by password managers, which would let a page embedding this
 * one collect a credential the user never meant to enter there.
 *
 * Browsers also apply form-action to redirects that follow a submission, so
 * the redirect URI's origin must be allowed or the 302 carrying the
 * authorization code back to the client is blocked.
 */
const sendLoginForm = (
  res: Response,
  status: number,
  html: string,
  redirectUri: string,
): void => {
  const formAction = (() => {
    try {
      const { origin } = new URL(redirectUri);
      return origin === "null" ? "'self'" : `'self' ${origin}`;
    } catch {
      return "'self'";
    }
  })();

  res
    .status(status)
    .set({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'`,
      "Referrer-Policy": "no-referrer",
    })
    .type("html")
    .send(html);
};

export class MailboxOAuthProvider implements OAuthTokenVerifier {
  private readonly key: Buffer;
  private readonly authToken: string;
  /**
   * Best-effort single-use enforcement for authorization codes, mapping code id
   * to the moment it can be forgotten. Codes are stateless, so this only spans
   * the current process — but combined with the 60 second lifetime it closes
   * the practical replay window. Entries are swept once they expire, since a
   * code cannot be redeemed after that anyway.
   */
  private readonly usedCodes = new Map<string, number>();

  private readonly allowedRedirectHosts: string[];

  constructor(authToken: string, allowedRedirectHosts?: string[]) {
    this.authToken = authToken;
    this.key = deriveSigningKey(authToken);
    this.allowedRedirectHosts =
      allowedRedirectHosts && allowedRedirectHosts.length > 0
        ? allowedRedirectHosts
        : DEFAULT_ALLOWED_REDIRECT_HOSTS;
  }

  /**
   * Clients are not stored: the client_id is itself a signed token carrying
   * the registration, so it can be verified after a restart.
   */
  readonly clientsStore = {
    getClient: async (
      clientId: string,
    ): Promise<OAuthClientInformationFull | undefined> => {
      const claims = readToken(this.key, "client", clientId);
      if (!claims) {
        return undefined;
      }

      const redirectUris = (claims.rd as string[]) ?? [];

      // Client registrations outlive a policy change, so the allowlist is
      // applied again here: tightening it takes effect immediately rather than
      // when the last registration expires.
      if (
        rejectedRedirectUris(redirectUris, this.allowedRedirectHosts).length > 0
      ) {
        return undefined;
      }

      return {
        client_id: clientId,
        redirect_uris: redirectUris,
        client_name: claims.nm as string | undefined,
      } as OAuthClientInformationFull;
    },

    registerClient: async (
      metadata: Omit<OAuthClientInformationFull, "client_id">,
    ): Promise<OAuthClientInformationFull> => {
      // Registration is open, so this is the point where a client pointing at
      // an attacker-controlled destination is refused.
      const rejected = rejectedRedirectUris(
        metadata.redirect_uris ?? [],
        this.allowedRedirectHosts,
      );
      if (rejected.length > 0) {
        throw new OAuthError(
          OAuthErrorCode.InvalidClientMetadata,
          `redirect_uri not permitted by this server: ${rejected.join(", ")}`,
        );
      }

      const clientId = issueToken(
        this.key,
        "client",
        { rd: metadata.redirect_uris, nm: metadata.client_name },
        REFRESH_TOKEN_TTL_SECONDS,
      );

      return { ...metadata, client_id: clientId };
    },
  };

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    // The handler validated these params already; the request is reachable
    // through the response so the same endpoint can serve form and submission.
    const request = res.req;
    const body = (request.body ?? {}) as Record<string, string>;

    // A POST carries the parameters in its body and a GET in the query string,
    // so the form is always rebuilt from whichever the request actually used.
    const submitted =
      request.method === "POST"
        ? body
        : (request.query as Record<string, string>);

    const consent: ConsentDetails = {
      clientName: client.client_name,
      redirectUri: params.redirectUri,
    };

    if (request.method === "POST" && typeof body.mcp_token === "string") {
      if (verifyToken(body.mcp_token, this.authToken)) {
        const code = issueToken(
          this.key,
          "code",
          {
            cid: client.client_id,
            ch: params.codeChallenge,
            ru: params.redirectUri,
            sc: params.scopes,
            jti: randomUUID(),
          },
          AUTHORIZATION_CODE_TTL_SECONDS,
        );

        const redirect = new URL(params.redirectUri);
        redirect.searchParams.set("code", code);
        if (params.state) {
          redirect.searchParams.set("state", params.state);
        }
        redirect.searchParams.set("iss", params.issuer);

        res.redirect(302, redirect.toString());
        return;
      }

      sendLoginForm(
        res,
        401,
        renderLoginForm(
          { ...submitted, client_id: client.client_id },
          consent,
          "That token is not valid.",
        ),
        params.redirectUri,
      );
      return;
    }

    sendLoginForm(
      res,
      200,
      renderLoginForm({ ...submitted, client_id: client.client_id }, consent),
      params.redirectUri,
    );
  }

  async challengeForAuthorizationCode(
    authorizationCode: string,
  ): Promise<string> {
    const claims = readToken(this.key, "code", authorizationCode);
    if (!claims) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        "Invalid or expired authorization code",
      );
    }

    return claims.ch as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const claims = readToken(this.key, "code", authorizationCode);
    if (!claims) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        "Invalid or expired authorization code",
      );
    }

    if (claims.cid !== client.client_id) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        "Authorization code was issued to a different client",
      );
    }

    if (redirectUri && claims.ru !== redirectUri) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        "Redirect URI does not match the authorization request",
      );
    }

    const jti = claims.jti as string;
    if (this.usedCodes.has(jti)) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        "Authorization code has already been used",
      );
    }
    this.rememberUsedCode(jti, claims.exp);

    return this.issueTokens(
      client.client_id,
      claims.sc as string[] | undefined,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const claims = readToken(this.key, "refresh", refreshToken);
    if (!claims) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        "Invalid or expired refresh token",
      );
    }

    if (claims.cid !== client.client_id) {
      throw new OAuthError(
        OAuthErrorCode.InvalidGrant,
        "Refresh token was issued to a different client",
      );
    }

    // A refresh may narrow the grant but never widen it.
    const granted = (claims.sc as string[] | undefined) ?? [];
    if (scopes?.some(scope => !granted.includes(scope))) {
      throw new OAuthError(
        OAuthErrorCode.InvalidScope,
        "Requested scope exceeds what was originally granted",
      );
    }

    // The refresh token's own expiry is the grant's expiry, inherited down
    // the chain of refreshes: a session cannot be kept alive indefinitely
    // without the credential being entered again.
    return this.issueTokens(client.client_id, scopes ?? granted, claims.exp);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = readToken(this.key, "access", token);
    if (!claims) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        "Invalid or expired access token",
      );
    }

    return {
      token,
      clientId: claims.cid as string,
      scopes: (claims.sc as string[]) ?? [],
      expiresAt: claims.exp,
    };
  }

  /**
   * Records a spent code until its expiry, discarding any that have already
   * lapsed so the map cannot grow without bound on a long-running process.
   */
  private rememberUsedCode(jti: string, expiresAtSeconds: number): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.usedCodes) {
      if (expiresAt <= now) {
        this.usedCodes.delete(id);
      }
    }

    this.usedCodes.set(jti, expiresAtSeconds * 1000);
  }

  /** Exposed for tests: how many spent codes are still being tracked. */
  get trackedUsedCodes(): number {
    return this.usedCodes.size;
  }

  /**
   * Issues an access and refresh token pair. `grantExpiresAt` (seconds since
   * the epoch) caps both lifetimes so nothing outlives the original grant.
   */
  private issueTokens(
    clientId: string,
    scopes?: string[],
    grantExpiresAt?: number,
  ): OAuthTokens {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const cappedTtl = (ttlSeconds: number): number =>
      grantExpiresAt === undefined
        ? ttlSeconds
        : Math.max(0, Math.min(ttlSeconds, grantExpiresAt - nowSeconds));

    const accessTtl = cappedTtl(ACCESS_TOKEN_TTL_SECONDS);

    return {
      access_token: issueToken(
        this.key,
        "access",
        { cid: clientId, sc: scopes },
        accessTtl,
      ),
      token_type: "Bearer",
      expires_in: accessTtl,
      refresh_token: issueToken(
        this.key,
        "refresh",
        { cid: clientId, sc: scopes },
        cappedTtl(REFRESH_TOKEN_TTL_SECONDS),
      ),
      scope: scopes?.join(" "),
    };
  }
}
