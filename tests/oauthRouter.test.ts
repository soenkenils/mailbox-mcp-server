import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeHttpServer, startHttpServer } from "../src/transport/http.js";
import { createOAuthSupport } from "../src/transport/oauth/index.js";

const TOKEN = "b".repeat(64);
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";
const OTHER_REDIRECT_URI = "https://claude.com/api/mcp/auth_callback";
const FORM = { "Content-Type": "application/x-www-form-urlencoded" };
const JSON_BODY = { "Content-Type": "application/json" };

interface RegisteredClient {
  client_id: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  client_id_issued_at?: number;
  [key: string]: unknown;
}

describe("OAuth endpoints", () => {
  let baseUrl: string;
  let issuer: string;
  let httpServer: Awaited<ReturnType<typeof startHttpServer>>;
  // Every request gets its own client address, so the rate limits only come
  // into play in the tests that exercise them.
  let nextAddress = 0;
  const clientAddress = () => {
    nextAddress += 1;
    return `198.51.100.${nextAddress % 250}`;
  };

  const request = (path: string, init: RequestInit = {}) =>
    fetch(`${baseUrl}${path}`, {
      redirect: "manual",
      ...init,
      headers: {
        "X-Forwarded-For": clientAddress(),
        ...(init.headers as Record<string, string>),
      },
    });

  const postForm = (path: string, fields: Record<string, string>) =>
    request(path, {
      method: "POST",
      headers: FORM,
      body: new URLSearchParams(fields),
    });

  const register = async (metadata: Record<string, unknown> = {}) => {
    const response = await request("/register", {
      method: "POST",
      headers: JSON_BODY,
      body: JSON.stringify({
        redirect_uris: [REDIRECT_URI],
        token_endpoint_auth_method: "none",
        ...metadata,
      }),
    });
    return (await response.json()) as RegisteredClient;
  };

  const pkce = () => {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  };

  const authorizeParams = (clientId: string, challenge: string) => ({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "the-state",
  });

  const issueCode = async (clientId: string, challenge: string) => {
    const response = await postForm("/authorize", {
      ...authorizeParams(clientId, challenge),
      mcp_token: TOKEN,
    });
    return new URL(response.headers.get("location") as string);
  };

  beforeAll(async () => {
    const bootstrap = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
      createProtocolServer: () => new Server({ name: "t", version: "1" }),
    });
    const { port } = bootstrap.address() as AddressInfo;
    await closeHttpServer(bootstrap, 50);

    baseUrl = `http://127.0.0.1:${port}`;
    issuer = `${baseUrl}/`;
    const oauth = createOAuthSupport(TOKEN, baseUrl);

    httpServer = await startHttpServer({
      port,
      host: "127.0.0.1",
      authToken: TOKEN,
      createProtocolServer: () => new Server({ name: "t", version: "1" }),
      oauthProvider: oauth.provider,
      authRouter: oauth.authRouter,
      resourceMetadataUrl: oauth.resourceMetadataUrl,
    });
  });

  afterAll(async () => {
    await closeHttpServer(httpServer, 100);
  });

  describe("issuer validation", () => {
    it("should refuse a plain http issuer on a public host", () => {
      expect(() => createOAuthSupport(TOKEN, "http://example.com")).toThrow(
        "HTTPS",
      );
    });

    it("should refuse an issuer with a query string", () => {
      expect(() =>
        createOAuthSupport(TOKEN, "https://example.com/?a=1"),
      ).toThrow("query");
    });

    it("should refuse an issuer with a fragment", () => {
      expect(() => createOAuthSupport(TOKEN, "https://example.com/#a")).toThrow(
        "fragment",
      );
    });

    it("should accept an https issuer", () => {
      expect(() =>
        createOAuthSupport(TOKEN, "https://example.com"),
      ).not.toThrow();
    });
  });

  describe("metadata", () => {
    it("should advertise exactly what the server implements", async () => {
      const response = await request("/.well-known/oauth-authorization-server");

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({
        issuer,
        authorization_endpoint: `${baseUrl}/authorize`,
        token_endpoint: `${baseUrl}/token`,
        registration_endpoint: `${baseUrl}/register`,
        response_types_supported: ["code"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        authorization_response_iss_parameter_supported: true,
      });
    });

    it("should describe the protected resource", async () => {
      const response = await request("/.well-known/oauth-protected-resource");

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toEqual({
        resource: issuer,
        authorization_servers: [issuer],
        resource_name: "Mailbox MCP Server",
      });
    });
  });

  describe("allowed methods", () => {
    it.each([
      ["/authorize", "PUT", "GET, POST"],
      ["/token", "GET", "POST"],
      ["/register", "GET", "POST"],
      ["/.well-known/oauth-authorization-server", "POST", "GET, OPTIONS"],
      ["/.well-known/oauth-protected-resource", "POST", "GET, OPTIONS"],
    ])("should answer %s %s with 405", async (path, method, allow) => {
      const response = await request(path, { method });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe(allow);
      expect(await response.json()).toMatchObject({
        error: "method_not_allowed",
      });
    });

    it.each([
      "/token",
      "/register",
      "/.well-known/oauth-authorization-server",
    ])("should answer the CORS preflight on %s", async path => {
      const response = await request(path, {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
    });

    it("should not enable CORS on the consent page", async () => {
      const response = await request("/authorize", {
        method: "OPTIONS",
        headers: {
          Origin: "https://claude.ai",
          "Access-Control-Request-Method": "POST",
        },
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    });
  });

  describe("client registration", () => {
    it("should register a public client without a secret", async () => {
      const response = await request("/register", {
        method: "POST",
        headers: JSON_BODY,
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          token_endpoint_auth_method: "none",
          client_name: "public",
        }),
      });
      const client = (await response.json()) as RegisteredClient;

      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(client.client_id).toEqual(expect.any(String));
      expect(client.client_id_issued_at).toEqual(expect.any(Number));
      expect(client.client_name).toBe("public");
      expect(client.client_secret).toBeUndefined();
      expect(client.client_secret_expires_at).toBeUndefined();
    });

    it("should issue a secret to a client that did not register as public", async () => {
      const client = await register({
        token_endpoint_auth_method: "client_secret_post",
      });

      expect(client.client_secret).toMatch(/^[0-9a-f]{64}$/);
      expect(client.client_secret_expires_at).toBeGreaterThan(
        Date.now() / 1000,
      );
    });

    it("should not echo metadata fields it does not know", async () => {
      const client = await register({ made_up_field: "x" });

      expect(client.made_up_field).toBeUndefined();
    });

    it.each([
      ["no redirect URIs", { redirect_uris: undefined }],
      ["a malformed redirect URI", { redirect_uris: ["not a url"] }],
      ["a script redirect URI", { redirect_uris: ["javascript:alert(1)"] }],
      ["a mistyped field", { client_name: 42 }],
    ])("should refuse %s", async (_name, metadata) => {
      const response = await request("/register", {
        method: "POST",
        headers: JSON_BODY,
        body: JSON.stringify({
          redirect_uris: [REDIRECT_URI],
          ...metadata,
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: "invalid_client_metadata",
      });
    });

    it("should enforce its rate limit", async () => {
      const send = () =>
        fetch(`${baseUrl}/register`, {
          method: "POST",
          headers: { ...JSON_BODY, "X-Forwarded-For": "203.0.113.20" },
          body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
        });

      const first = await send();
      expect(first.headers.get("ratelimit-limit")).toBe("20");

      const remaining = Number(first.headers.get("ratelimit-remaining"));
      for (let i = 0; i < remaining; i++) {
        await send();
      }

      const limited = await send();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        error: "too_many_requests",
      });
    });
  });

  describe("authorization request", () => {
    it("should answer with JSON when the client cannot be trusted", async () => {
      const { client_id } = await register();
      const cases: [Record<string, string>, string][] = [
        [{}, "invalid_request"],
        [{ client_id: "not-a-client" }, "invalid_client"],
        [{ client_id, redirect_uri: "not a url" }, "invalid_request"],
        [
          { client_id, redirect_uri: "https://claude.ai/other" },
          "invalid_request",
        ],
      ];

      for (const [params, error] of cases) {
        const response = await request(
          `/authorize?${new URLSearchParams(params)}`,
        );

        expect(response.status).toBe(400);
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(await response.json()).toMatchObject({ error });
      }
    });

    it("should require a redirect URI when several are registered", async () => {
      const { client_id } = await register({
        redirect_uris: [REDIRECT_URI, OTHER_REDIRECT_URI],
      });

      const response = await request(
        `/authorize?${new URLSearchParams({ client_id })}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    });

    it("should not blame several redirect URIs when none is registered", async () => {
      const { client_id } = await register({ redirect_uris: [] });

      const response = await request(
        `/authorize?${new URLSearchParams({ client_id })}`,
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "invalid_request",
        error_description:
          "redirect_uri must be specified unless client has exactly one registered URI",
      });
    });

    it("should fall back to the only registered redirect URI", async () => {
      const { client_id } = await register();
      const { challenge } = pkce();
      const { redirect_uri: _omitted, ...params } = authorizeParams(
        client_id,
        challenge,
      );

      const response = await request(
        `/authorize?${new URLSearchParams(params)}`,
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("claude.ai");
    });

    it.each([
      ["a missing challenge", { code_challenge: undefined }],
      ["a plain challenge method", { code_challenge_method: "plain" }],
      ["an implicit grant", { response_type: "token" }],
      ["a malformed resource", { resource: "not a url" }],
    ])("should redirect the error for %s", async (_name, change) => {
      const { client_id } = await register();
      const params: Record<string, string | undefined> = {
        ...authorizeParams(client_id, pkce().challenge),
        ...change,
      };
      const defined = Object.entries(params).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      );

      const response = await request(
        `/authorize?${new URLSearchParams(defined)}`,
      );

      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") as string);
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get("error")).toBe("invalid_request");
      expect(location.searchParams.get("error_description")).toBeTruthy();
      expect(location.searchParams.get("state")).toBe("the-state");
      expect(location.searchParams.get("iss")).toBe(issuer);
      expect(location.searchParams.get("code")).toBeNull();
    });

    it("should identify the issuer on the code redirect", async () => {
      const { client_id } = await register();

      const location = await issueCode(client_id, pkce().challenge);

      expect(location.searchParams.get("code")).toBeTruthy();
      expect(location.searchParams.get("state")).toBe("the-state");
      expect(location.searchParams.get("iss")).toBe(issuer);
    });

    it("should accept any port on a loopback redirect", async () => {
      const { client_id } = await register({
        redirect_uris: ["http://127.0.0.1:1234/callback"],
      });
      const params = {
        ...authorizeParams(client_id, pkce().challenge),
        redirect_uri: "http://127.0.0.1:5678/callback",
      };

      const allowed = await postForm("/authorize", {
        ...params,
        mcp_token: TOKEN,
      });

      expect(allowed.status).toBe(302);
      expect(allowed.headers.get("location")).toContain(
        "http://127.0.0.1:5678/callback?code=",
      );

      const otherPath = await request(
        `/authorize?${new URLSearchParams({
          ...params,
          redirect_uri: "http://127.0.0.1:5678/other",
        })}`,
      );
      expect(otherPath.status).toBe(400);
    });

    it("should not treat a port change as a match on a public host", async () => {
      const { client_id } = await register();

      const response = await request(
        `/authorize?${new URLSearchParams({
          client_id,
          redirect_uri: "https://claude.ai:8443/api/mcp/auth_callback",
        })}`,
      );

      expect(response.status).toBe(400);
    });
  });

  describe("token request", () => {
    it.each([
      [{}, "invalid_request"],
      [{ client_id: "not-a-client" }, "invalid_client"],
    ])("should refuse an unidentified client: %j", async (fields, error) => {
      const response = await postForm("/token", {
        grant_type: "authorization_code",
        ...fields,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error });
    });

    it("should reject a missing or unsupported grant type", async () => {
      const { client_id } = await register();

      const missing = await postForm("/token", { client_id });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toMatchObject({ error: "invalid_request" });

      const unsupported = await postForm("/token", {
        client_id,
        grant_type: "password",
      });
      expect(unsupported.status).toBe(400);
      expect(await unsupported.json()).toMatchObject({
        error: "unsupported_grant_type",
      });
    });

    it("should require the parameters of each grant", async () => {
      const { client_id } = await register();

      for (const fields of [
        { grant_type: "authorization_code", code_verifier: "x" },
        { grant_type: "authorization_code", code: "x" },
        { grant_type: "refresh_token" },
        {
          grant_type: "refresh_token",
          refresh_token: "x",
          resource: "not a url",
        },
      ] as Record<string, string>[]) {
        const response = await postForm("/token", { client_id, ...fields });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: "invalid_request",
        });
      }
    });

    it("should reject an invalid code or refresh token", async () => {
      const { client_id } = await register();

      for (const fields of [
        { grant_type: "authorization_code", code: "x", code_verifier: "y" },
        { grant_type: "refresh_token", refresh_token: "x" },
      ] as Record<string, string>[]) {
        const response = await postForm("/token", { client_id, ...fields });

        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ error: "invalid_grant" });
      }
    });

    it("should reject a code redeemed with a different redirect URI", async () => {
      const { client_id } = await register({
        redirect_uris: [REDIRECT_URI, OTHER_REDIRECT_URI],
      });
      const { verifier, challenge } = pkce();
      const location = await issueCode(client_id, challenge);

      const response = await postForm("/token", {
        client_id,
        grant_type: "authorization_code",
        code: location.searchParams.get("code") as string,
        code_verifier: verifier,
        redirect_uri: OTHER_REDIRECT_URI,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_grant" });
    });

    it("should not cache issued tokens", async () => {
      const { client_id } = await register();
      const { verifier, challenge } = pkce();
      const location = await issueCode(client_id, challenge);

      const response = await postForm("/token", {
        client_id,
        grant_type: "authorization_code",
        code: location.searchParams.get("code") as string,
        code_verifier: verifier,
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      expect(await response.json()).toMatchObject({ token_type: "Bearer" });
    });

    it("should complete the flow for a client sending its secret", async () => {
      const { client_id, client_secret } = await register({
        token_endpoint_auth_method: "client_secret_post",
      });
      const { verifier, challenge } = pkce();
      const location = await issueCode(client_id, challenge);

      const response = await postForm("/token", {
        client_id,
        client_secret: client_secret as string,
        grant_type: "authorization_code",
        code: location.searchParams.get("code") as string,
        code_verifier: verifier,
      });

      expect(response.status).toBe(200);
    });

    it("should enforce its rate limit", async () => {
      const send = () =>
        fetch(`${baseUrl}/token`, {
          method: "POST",
          headers: { ...FORM, "X-Forwarded-For": "203.0.113.21" },
          body: new URLSearchParams({ client_id: "not-a-client" }),
        });

      const first = await send();
      expect(first.headers.get("ratelimit-limit")).toBe("50");

      const remaining = Number(first.headers.get("ratelimit-remaining"));
      for (let i = 0; i < remaining; i++) {
        await send();
      }

      const limited = await send();
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        error: "too_many_requests",
      });
    });
  });

  describe("unreadable request bodies", () => {
    it("should answer malformed JSON with an OAuth error", async () => {
      const response = await request("/register", {
        method: "POST",
        headers: JSON_BODY,
        body: "{not json",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    });

    it("should answer an oversized body with an OAuth error", async () => {
      const response = await request("/register", {
        method: "POST",
        headers: JSON_BODY,
        body: JSON.stringify({ client_name: "x".repeat(200_000) }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: "invalid_request" });
    });
  });
});
