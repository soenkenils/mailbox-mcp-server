import { describe, expect, it } from "vitest";
import {
  isAllowedRedirectUri,
  rejectedRedirectUris,
} from "../src/transport/oauth/redirectPolicy.js";

describe("redirect URI policy", () => {
  describe("allowed destinations", () => {
    it("should allow the Claude connector callback", () => {
      expect(
        isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"),
      ).toBe(true);
      expect(isAllowedRedirectUri("https://claude.com/api/callback")).toBe(
        true,
      );
    });

    it("should allow loopback on any port, as native clients need", () => {
      // Claude Code and the MCP Inspector listen on an ephemeral local port.
      expect(isAllowedRedirectUri("http://localhost:53211/callback")).toBe(
        true,
      );
      expect(isAllowedRedirectUri("http://127.0.0.1:8080/cb")).toBe(true);
      expect(isAllowedRedirectUri("http://[::1]:9000/cb")).toBe(true);
    });

    it("should honour a configured host list", () => {
      expect(
        isAllowedRedirectUri("https://example.test/cb", ["example.test"]),
      ).toBe(true);
      expect(
        isAllowedRedirectUri("https://claude.ai/cb", ["example.test"]),
      ).toBe(false);
    });
  });

  describe("rejected destinations", () => {
    it("should reject an unknown host", () => {
      expect(isAllowedRedirectUri("https://evil.example/callback")).toBe(false);
    });

    it("should not treat a lookalike host as allowed", () => {
      // Suffix or substring matching would let these through.
      expect(isAllowedRedirectUri("https://claude.ai.evil.example/cb")).toBe(
        false,
      );
      expect(isAllowedRedirectUri("https://evilclaude.ai/cb")).toBe(false);
      expect(isAllowedRedirectUri("https://sub.claude.ai/cb")).toBe(false);
    });

    it("should require https for non-loopback hosts", () => {
      expect(isAllowedRedirectUri("http://claude.ai/cb")).toBe(false);
    });

    it("should reject non-http schemes", () => {
      expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
      expect(isAllowedRedirectUri("file:///etc/passwd")).toBe(false);
    });

    it("should reject malformed input without throwing", () => {
      expect(isAllowedRedirectUri("")).toBe(false);
      expect(isAllowedRedirectUri("not a url")).toBe(false);
    });
  });

  describe("rejectedRedirectUris", () => {
    it("should report only the offending entries", () => {
      const rejected = rejectedRedirectUris([
        "https://claude.ai/api/mcp/auth_callback",
        "https://evil.example/cb",
        "http://localhost:1234/cb",
      ]);

      expect(rejected).toEqual(["https://evil.example/cb"]);
    });

    it("should return nothing when all are permitted", () => {
      expect(rejectedRedirectUris(["https://claude.ai/cb"])).toEqual([]);
    });
  });
});
