/**
 * Safe description of an incoming request, for diagnosing how MCP clients
 * actually authenticate.
 *
 * Motivation: claude.ai's "request headers" connector auth is reported to send
 * no header at all and instead start an OAuth authorization_code flow against
 * the server origin. Rejected requests previously logged nothing identifying,
 * so that behaviour was invisible here. This records enough to tell "no
 * credential arrived" from "a credential arrived but did not match", without
 * ever recording the credential itself.
 */

/** Headers a client might carry a shared secret in. Values are never read. */
const CREDENTIAL_HEADERS = ["authorization", "x-api-key", "x-auth-token"];

/**
 * OAuth parameters that are safe to record. Deliberately excludes `code` and
 * `code_challenge`, which are credentials. `client_id` is included because it
 * is the tell for the reported bug: clients hitting it send the configured
 * header's name (e.g. "authorization") as the client_id.
 */
const LOGGABLE_OAUTH_PARAMS = ["response_type", "client_id", "redirect_uri"];

export interface OAuthProbe {
  [param: string]: string | boolean;
}

export interface RequestDescription {
  /** Index signature so the description can be passed straight to the logger. */
  [key: string]: unknown;
  method: string;
  /** Path with any token segment removed. */
  path: string;
  /** Scheme only, e.g. "Bearer" — never the credential. */
  authScheme?: string;
  /** Names of credential-bearing headers present on the request. */
  credentialHeaders: string[];
  userAgent?: string;
  /** Present when the request looks like an OAuth discovery/authorize probe. */
  oauth?: OAuthProbe;
}

/** True for endpoints a client hits when it decides to attempt OAuth. */
export const isOAuthProbe = (pathname: string): boolean =>
  pathname === "/authorize" ||
  pathname === "/token" ||
  pathname === "/register" ||
  pathname.startsWith("/.well-known/oauth");

/**
 * Redacts a credential carried in the path. The server never accepts one
 * there, but a misconfigured client may still send `/mcp/<token>`, and that
 * value must not reach a log.
 */
export const redactPath = (pathname: string): string => {
  const segments = pathname.split("/").filter(segment => segment.length > 0);
  if (segments.length === 2 && segments[0] === "mcp") {
    return "/mcp/<redacted>";
  }
  return pathname;
};

export const describeRequest = (
  method: string | undefined,
  pathname: string,
  searchParams: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
): RequestDescription => {
  const authorization = headers.authorization;
  const authScheme =
    typeof authorization === "string"
      ? authorization.trim().split(/\s+/)[0] || undefined
      : undefined;

  const description: RequestDescription = {
    method: method ?? "UNKNOWN",
    path: redactPath(pathname),
    authScheme,
    credentialHeaders: CREDENTIAL_HEADERS.filter(name => headers[name]),
    userAgent:
      typeof headers["user-agent"] === "string"
        ? headers["user-agent"]
        : undefined,
  };

  if (isOAuthProbe(pathname)) {
    const oauth: OAuthProbe = {
      hasCodeChallenge: searchParams.has("code_challenge"),
    };
    for (const param of LOGGABLE_OAUTH_PARAMS) {
      const value = searchParams.get(param);
      if (value) {
        oauth[param] = value;
      }
    }
    description.oauth = oauth;
  }

  return description;
};
