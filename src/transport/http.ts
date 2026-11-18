import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import type { OAuthTokenVerifier, Server } from "@modelcontextprotocol/server";
import express, { type RequestHandler } from "express";
import { createLogger } from "../services/Logger.js";
import { extractToken, isMcpPath, verifyToken } from "./auth.js";
import { describeRequest } from "./diagnostics.js";

const HEALTH_PATH = "/health";

/**
 * Largest request body accepted on the MCP endpoint. A send_email call with
 * both text and HTML at their schema limits is about 2 MiB; this matches the
 * SDK transport's default limit.
 */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

export interface HttpTransportOptions {
  port: number;
  /** Shared secret required on every MCP request. */
  authToken: string;
  /** Builds a protocol server bound to the shared services. */
  createProtocolServer: () => Server;
  /**
   * Defaults to all interfaces, which is what a container host's proxy
   * expects. TLS is terminated in front of the server, never here.
   */
  host?: string;
  /** Present when OAuth is enabled; also accepts its access tokens on /mcp. */
  oauthProvider?: OAuthTokenVerifier;
  /** Advertised on 401 so OAuth clients can discover how to authenticate. */
  resourceMetadataUrl?: string;
  /** OAuth endpoints (metadata, register, authorize, token) to serve. */
  authRouter?: RequestHandler;
}

const logger = createLogger("HttpTransport");

/** OAuth access tokens are accepted alongside the static shared secret. */
const isValidOAuthToken = async (
  provider: OAuthTokenVerifier | undefined,
  token: string | undefined,
): Promise<boolean> => {
  if (!provider || !token) {
    return false;
  }

  try {
    await provider.verifyAccessToken(token);
    return true;
  } catch {
    return false;
  }
};

const sendJson = (
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};

const sendJsonRpcError = (
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void => {
  sendJson(
    res,
    status,
    { jsonrpc: "2.0", error: { code, message }, id: null },
    headers,
  );
};

/**
 * Handles a single MCP request with its own protocol server and transport.
 *
 * The transport runs stateless (no session IDs) with JSON responses: there is
 * no session state to be lost when the host stops an idle machine, and no
 * long-lived SSE stream to keep it awake.
 */
const handleMcpRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  createProtocolServer: () => Server,
  parsedBody: unknown,
): Promise<void> => {
  const server = createProtocolServer();
  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on("close", () => {
    void transport.close();
    void server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, parsedBody);
};

/**
 * Reads the request body, giving up once it exceeds MAX_BODY_BYTES. The SDK
 * transport's own limit does not cover a body handed to it already parsed, and
 * a chunked request carries no Content-Length to check up front. Resolves
 * undefined when the cap is hit; the rest of the upload is discarded rather
 * than buffered.
 */
const readBody = (req: IncomingMessage): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.off("data", onData);
        req.resume();
        chunks.length = 0;
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    };

    req.on("data", onData);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const handleRequest = async (
  req: IncomingMessage,
  res: ServerResponse,
  options: HttpTransportOptions,
): Promise<void> => {
  // Parsed against a dummy origin because req.url only carries the path.
  const { pathname, searchParams } = new URL(
    req.url ?? "/",
    "http://localhost",
  );

  if (pathname === HEALTH_PATH) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 405, { error: "Method Not Allowed" }, { Allow: "GET" });
      return;
    }
    sendJson(res, 200, { status: "ok" });
    return;
  }

  if (!isMcpPath(pathname)) {
    // Logged so that a client attempting OAuth against this origin — rather
    // than sending its configured credential — is visible rather than a silent
    // 404. describeRequest() redacts credentials.
    const description = describeRequest(
      req.method,
      pathname,
      searchParams,
      req.headers,
    );
    logger.warning(
      description.oauth
        ? "Client attempted an OAuth flow against this server"
        : "Request to unknown path",
      { operation: "route", service: "HttpTransport" },
      description,
    );
    sendJson(res, 404, { error: "Not Found" });
    return;
  }

  const presented = extractToken(req.headers.authorization);
  const authorized =
    verifyToken(presented, options.authToken) ||
    (await isValidOAuthToken(options.oauthProvider, presented));

  if (!authorized) {
    // Records how the client tried to authenticate — never what with — so that
    // "no credential arrived" is distinguishable from "credential mismatched".
    logger.warning(
      "Rejected unauthenticated MCP request",
      {
        operation: "authenticate",
        service: "HttpTransport",
      },
      describeRequest(req.method, pathname, searchParams, req.headers),
    );
    sendJsonRpcError(res, 401, -32001, "Unauthorized", {
      // Points OAuth-capable clients at the metadata describing how to
      // authenticate, per RFC 9728.
      "WWW-Authenticate": options.resourceMetadataUrl
        ? `Bearer resource_metadata="${options.resourceMetadataUrl}"`
        : "Bearer",
    });
    return;
  }

  // Only POST is served. Refusing GET keeps clients from opening a standalone
  // SSE stream, which would hold the connection (and an idle machine) open.
  if (req.method !== "POST") {
    sendJsonRpcError(res, 405, -32000, "Method Not Allowed", { Allow: "POST" });
    return;
  }

  const declaredLength = Number(req.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    sendJsonRpcError(res, 413, -32600, "Request body too large");
    return;
  }

  const body = await readBody(req);
  if (body === undefined) {
    sendJsonRpcError(res, 413, -32600, "Request body too large");
    return;
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    sendJsonRpcError(res, 400, -32700, "Parse error");
    return;
  }

  await handleMcpRequest(req, res, options.createProtocolServer, parsedBody);
};

/**
 * Serves the OAuth endpoints (metadata, registration, authorize, token) ahead
 * of the MCP routes when OAuth is enabled. Express only claims those specific
 * paths, so /mcp request bodies are left untouched for the transport to read.
 */
const createRequestListener = (options: HttpTransportOptions) => {
  const handle = (req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, options).catch(error => {
      logger.error(
        "Unhandled error while serving request",
        { operation: "handleRequest", service: "HttpTransport" },
        { error: error instanceof Error ? error.message : String(error) },
      );

      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    });
  };

  if (!options.authRouter) {
    return handle;
  }

  const app = express();
  // Hosted mode sits behind exactly one reverse proxy (the TLS terminator),
  // which appends the real client address to X-Forwarded-For. Without this,
  // req.ip is the proxy for every request and the OAuth rate limiters share
  // one bucket across all clients.
  app.set("trust proxy", 1);
  app.use(options.authRouter);
  app.use((req, res) => handle(req, res));
  return app;
};

/** Starts the HTTP transport and resolves once it is accepting connections. */
export const startHttpServer = (
  options: HttpTransportOptions,
): Promise<HttpServer> => {
  const httpServer = createServer(createRequestListener(options));

  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host ?? "0.0.0.0", () => {
      httpServer.removeListener("error", reject);
      resolve(httpServer);
    });
  });
};

/**
 * Stops accepting connections and waits for in-flight requests, forcing any
 * stragglers closed so shutdown finishes within the host's kill timeout.
 */
export const closeHttpServer = (
  httpServer: HttpServer,
  drainTimeoutMs = 5000,
): Promise<void> =>
  new Promise(resolve => {
    const forceClose = setTimeout(() => {
      httpServer.closeAllConnections();
    }, drainTimeoutMs);

    httpServer.close(() => {
      clearTimeout(forceClose);
      resolve();
    });
  });
