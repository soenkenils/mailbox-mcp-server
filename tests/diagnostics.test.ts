import { describe, expect, it } from "vitest";
import {
  describeRequest,
  isOAuthProbe,
  redactPath,
} from "../src/transport/diagnostics.js";

const TOKEN = "a".repeat(64);

const describe_ = (
  method: string,
  url: string,
  headers: Record<string, string> = {},
) => {
  const parsed = new URL(url, "http://localhost");
  return describeRequest(method, parsed.pathname, parsed.searchParams, headers);
};

describe("request diagnostics", () => {
  describe("redactPath", () => {
    it("should remove the token from the path form", () => {
      expect(redactPath(`/mcp/${TOKEN}`)).toBe("/mcp/<redacted>");
    });

    it("should leave paths without a token intact", () => {
      expect(redactPath("/mcp")).toBe("/mcp");
      expect(redactPath("/authorize")).toBe("/authorize");
    });
  });

  describe("isOAuthProbe", () => {
    it("should recognise the endpoints an OAuth client reaches for", () => {
      expect(isOAuthProbe("/authorize")).toBe(true);
      expect(isOAuthProbe("/token")).toBe(true);
      expect(isOAuthProbe("/register")).toBe(true);
      expect(isOAuthProbe("/.well-known/oauth-authorization-server")).toBe(
        true,
      );
      expect(isOAuthProbe("/.well-known/oauth-protected-resource")).toBe(true);
    });

    it("should not flag normal traffic", () => {
      expect(isOAuthProbe("/mcp")).toBe(false);
      expect(isOAuthProbe("/health")).toBe(false);
    });
  });

  describe("credential safety", () => {
    it("should never include the token from a path", () => {
      const description = describe_("POST", `/mcp/${TOKEN}`);

      expect(JSON.stringify(description)).not.toContain(TOKEN);
      expect(description.path).toBe("/mcp/<redacted>");
    });

    it("should record only the auth scheme, never the credential", () => {
      const description = describe_("POST", "/mcp", {
        authorization: `Bearer ${TOKEN}`,
      });

      expect(description.authScheme).toBe("Bearer");
      expect(JSON.stringify(description)).not.toContain(TOKEN);
    });

    it("should not record the values of other credential headers", () => {
      const description = describe_("POST", "/mcp", {
        "x-api-key": TOKEN,
      });

      expect(description.credentialHeaders).toContain("x-api-key");
      expect(JSON.stringify(description)).not.toContain(TOKEN);
    });

    it("should not record OAuth code or code_challenge values", () => {
      const description = describe_(
        "GET",
        `/authorize?response_type=code&code=${TOKEN}&code_challenge=${TOKEN}`,
      );

      expect(JSON.stringify(description)).not.toContain(TOKEN);
      expect(description.oauth?.hasCodeChallenge).toBe(true);
    });
  });

  describe("distinguishing failure modes", () => {
    it("should show when no credential arrived at all", () => {
      const description = describe_("POST", "/mcp");

      expect(description.authScheme).toBeUndefined();
      expect(description.credentialHeaders).toEqual([]);
    });

    it("should show when a credential arrived but did not match", () => {
      const description = describe_("POST", "/mcp", {
        authorization: "Bearer wrong-token",
      });

      expect(description.authScheme).toBe("Bearer");
      expect(description.credentialHeaders).toEqual(["authorization"]);
    });

    it("should capture the client_id of an OAuth attempt", () => {
      // The reported bug sends the configured header's name as client_id.
      const description = describe_(
        "GET",
        "/authorize?response_type=code&client_id=authorization&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback",
      );

      expect(description.oauth).toBeDefined();
      expect(description.oauth?.client_id).toBe("authorization");
      expect(description.oauth?.response_type).toBe("code");
      expect(description.oauth?.redirect_uri).toBe(
        "https://claude.ai/api/mcp/auth_callback",
      );
    });

    it("should record method and user agent", () => {
      const description = describe_("GET", "/authorize", {
        "user-agent": "Claude-User/1.0",
      });

      expect(description.method).toBe("GET");
      expect(description.userAgent).toBe("Claude-User/1.0");
    });
  });
});
