import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Compact signed tokens (HS256 JWS) used for every piece of OAuth state:
 * authorization codes, access tokens, refresh tokens and client identifiers.
 *
 * The hosted server is stopped whenever it goes idle, so anything held in
 * memory is lost between requests. Carrying the state inside a signed token
 * means the flow survives a restart without a database or a volume — which
 * would also cost money and break the deployment's cost profile.
 *
 * Trade-off: tokens cannot be individually revoked before they expire, since
 * there is nothing to delete. Expiries are therefore short, and rotating
 * MCP_AUTH_TOKEN changes the derived signing key, which invalidates every
 * outstanding token at once.
 */

/** Distinguishes token kinds so one cannot be replayed as another. */
export type TokenKind = "code" | "access" | "refresh" | "client";

export interface TokenClaims {
  /** Token kind. */
  knd: TokenKind;
  /** Expiry, seconds since the epoch. */
  exp: number;
  [claim: string]: unknown;
}

const base64UrlEncode = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64url");

/**
 * Derives the signing key from the shared secret. Rotating MCP_AUTH_TOKEN
 * therefore invalidates all issued tokens, which is the intended way to revoke
 * everything at once.
 */
export const deriveSigningKey = (secret: string): Buffer =>
  Buffer.from(
    hkdfSync("sha256", secret, "mailbox-mcp-oauth", "token-signing", 32),
  );

const sign = (key: Buffer, payload: string): string =>
  createHmac("sha256", key).update(payload).digest("base64url");

/** Issues a signed token expiring in `ttlSeconds`. */
export const issueToken = (
  key: Buffer,
  kind: TokenKind,
  claims: Record<string, unknown>,
  ttlSeconds: number,
  now: number = Date.now(),
): string => {
  const body: TokenClaims = {
    ...claims,
    knd: kind,
    exp: Math.floor(now / 1000) + ttlSeconds,
  };

  const payload = base64UrlEncode(JSON.stringify(body));
  return `${payload}.${sign(key, payload)}`;
};

/**
 * Verifies a token's signature, kind and expiry.
 *
 * Returns undefined for anything untrustworthy rather than throwing, so
 * callers cannot accidentally treat a malformed token as valid.
 */
export const readToken = (
  key: Buffer,
  kind: TokenKind,
  token: string | undefined,
  now: number = Date.now(),
): TokenClaims | undefined => {
  if (!token) {
    return undefined;
  }

  const separator = token.lastIndexOf(".");
  if (separator <= 0) {
    return undefined;
  }

  const payload = token.slice(0, separator);
  const presented = token.slice(separator + 1);
  const expected = sign(key, payload);

  const presentedBytes = Buffer.from(presented);
  const expectedBytes = Buffer.from(expected);
  if (
    presentedBytes.length !== expectedBytes.length ||
    !timingSafeEqual(presentedBytes, expectedBytes)
  ) {
    return undefined;
  }

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }

  if (claims?.knd !== kind) {
    return undefined;
  }

  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) {
    return undefined;
  }

  return claims;
};
