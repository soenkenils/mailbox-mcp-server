import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared-secret authentication for the HTTP transport.
 *
 * The credential is presented only as `Authorization: Bearer <token>`. It is
 * never accepted in the URL, where proxies and access logs would record it.
 */

const MCP_PATH_SEGMENT = "mcp";
const BEARER_PATTERN = /^Bearer\s+(\S+)$/i;

/** Extracts the bearer token from a request's Authorization header. */
export const extractToken = (
  authorizationHeader?: string,
): string | undefined => {
  if (!authorizationHeader) {
    return undefined;
  }

  return BEARER_PATTERN.exec(authorizationHeader.trim())?.[1];
};

/**
 * Constant-time token comparison. Both values are hashed first so that
 * timingSafeEqual always receives equal-length buffers and the comparison does
 * not leak the expected token's length.
 */
export const verifyToken = (
  candidate: string | undefined,
  expected: string,
): boolean => {
  if (!candidate || !expected) {
    return false;
  }

  const candidateDigest = createHash("sha256").update(candidate).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();

  return timingSafeEqual(candidateDigest, expectedDigest);
};

/** True only for the MCP endpoint itself; no credential is carried in the path. */
export const isMcpPath = (pathname: string): boolean => {
  const segments = pathname.split("/").filter(segment => segment.length > 0);
  return segments.length === 1 && segments[0] === MCP_PATH_SEGMENT;
};
