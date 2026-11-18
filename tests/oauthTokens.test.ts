import { describe, expect, it } from "vitest";
import {
  deriveSigningKey,
  issueToken,
  readToken,
} from "../src/transport/oauth/tokens.js";

const SECRET = "a".repeat(64);
const key = deriveSigningKey(SECRET);
const NOW = 1_800_000_000_000;

describe("OAuth stateless tokens", () => {
  it("should round-trip claims", () => {
    const token = issueToken(key, "access", { sub: "owner" }, 3600, NOW);

    expect(readToken(key, "access", token, NOW)?.sub).toBe("owner");
  });

  it("should reject a token signed with a different key", () => {
    const token = issueToken(key, "access", {}, 3600, NOW);
    const otherKey = deriveSigningKey("b".repeat(64));

    expect(readToken(otherKey, "access", token, NOW)).toBeUndefined();
  });

  it("should reject a tampered payload", () => {
    const token = issueToken(key, "access", { sub: "owner" }, 3600, NOW);
    const [, signature] = token.split(".");
    const forged = `${Buffer.from(JSON.stringify({ knd: "access", exp: 9_999_999_999, sub: "attacker" })).toString("base64url")}.${signature}`;

    expect(readToken(key, "access", forged, NOW)).toBeUndefined();
  });

  it("should reject a token of the wrong kind", () => {
    const code = issueToken(key, "code", {}, 60, NOW);

    // An authorization code must not be usable as an access token.
    expect(readToken(key, "access", code, NOW)).toBeUndefined();
    expect(readToken(key, "code", code, NOW)).toBeDefined();
  });

  it("should reject an expired token", () => {
    const token = issueToken(key, "code", {}, 60, NOW);

    expect(readToken(key, "code", token, NOW + 61_000)).toBeUndefined();
    expect(readToken(key, "code", token, NOW + 59_000)).toBeDefined();
  });

  it("should reject malformed input without throwing", () => {
    for (const bad of [undefined, "", ".", "no-separator", "a.b.c"]) {
      expect(readToken(key, "access", bad, NOW)).toBeUndefined();
    }
  });

  it("should change the signing key when the secret rotates", () => {
    const token = issueToken(key, "access", {}, 3600, NOW);
    const rotated = deriveSigningKey("c".repeat(64));

    // Rotating MCP_AUTH_TOKEN is the documented way to revoke everything.
    expect(readToken(rotated, "access", token, NOW)).toBeUndefined();
  });

  it("should derive the same key deterministically", () => {
    expect(deriveSigningKey(SECRET).equals(deriveSigningKey(SECRET))).toBe(
      true,
    );
  });
});
