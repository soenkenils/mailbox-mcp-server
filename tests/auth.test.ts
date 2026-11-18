import { describe, expect, it } from "vitest";
import { extractToken, isMcpPath, verifyToken } from "../src/transport/auth.js";

describe("HTTP transport authentication", () => {
  const token = "a".repeat(64);

  describe("extractToken", () => {
    it("should extract a bearer token from the Authorization header", () => {
      expect(extractToken(`Bearer ${token}`)).toBe(token);
    });

    it("should accept a case-insensitive bearer scheme", () => {
      expect(extractToken(`bearer ${token}`)).toBe(token);
    });

    it("should return undefined for a malformed header", () => {
      expect(extractToken("Basic abc")).toBeUndefined();
      expect(extractToken("Bearer")).toBeUndefined();
    });

    it("should return undefined when no header is present", () => {
      expect(extractToken()).toBeUndefined();
      expect(extractToken("")).toBeUndefined();
    });
  });

  describe("verifyToken", () => {
    it("should accept a matching token", () => {
      expect(verifyToken(token, token)).toBe(true);
    });

    it("should reject a mismatching token of equal length", () => {
      expect(verifyToken("b".repeat(64), token)).toBe(false);
    });

    it("should reject tokens of different lengths without throwing", () => {
      expect(verifyToken("short", token)).toBe(false);
      expect(verifyToken(`${token}extra`, token)).toBe(false);
    });

    it("should reject missing or empty candidates", () => {
      expect(verifyToken(undefined, token)).toBe(false);
      expect(verifyToken("", token)).toBe(false);
    });

    it("should reject when no token is expected", () => {
      expect(verifyToken(token, "")).toBe(false);
    });
  });

  describe("isMcpPath", () => {
    it("should match the MCP endpoint", () => {
      expect(isMcpPath("/mcp")).toBe(true);
      expect(isMcpPath("/mcp/")).toBe(true);
    });

    it("should not match a credential in the path", () => {
      // A token in the URL would end up in proxy and access logs.
      expect(isMcpPath(`/mcp/${token}`)).toBe(false);
    });

    it("should not match other paths", () => {
      expect(isMcpPath("/health")).toBe(false);
      expect(isMcpPath("/")).toBe(false);
      expect(isMcpPath("/mcpx")).toBe(false);
    });
  });
});
