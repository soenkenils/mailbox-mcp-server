import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeHttpServer, startHttpServer } from "../src/transport/http.js";
import {
  createOAuthSupport,
  MailboxOAuthProvider,
} from "../src/transport/oauth/index.js";
import {
  deriveSigningKey,
  issueToken,
  readToken,
} from "../src/transport/oauth/tokens.js";

const STATIC_TOKEN = "a".repeat(64);
const REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const base64Url = (value: Buffer) => value.toString("base64url");

const createStubProtocolServer = (): Server => {
  const server = new Server(
    { name: "mailbox-mcp-server", version: "0.1.0" },
    { capabilities: { tools: {}, logging: {} } },
  );

  server.setRequestHandler("tools/list", () => ({
    tools: [
      {
        name: "search_emails",
        description: "stub",
        inputSchema: { type: "object" as const, properties: {} },
      },
    ],
  }));
  server.setRequestHandler("tools/call", () => ({
    content: [{ type: "text" as const, text: "ok" }],
  }));

  return server;
};

describe("OAuth authorization code flow", () => {
  let baseUrl: string;
  let httpServer: Awaited<ReturnType<typeof startHttpServer>>;

  // The provider publishes its own origin in discovery metadata, so the server
  // must be listening before OAuth can be configured with the final URL.
  beforeAll(async () => {
    const bootstrap = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      authToken: STATIC_TOKEN,
      createProtocolServer: createStubProtocolServer,
    });
    const { port } = bootstrap.address() as AddressInfo;
    await closeHttpServer(bootstrap, 50);

    baseUrl = `http://127.0.0.1:${port}`;
    const oauth = createOAuthSupport(STATIC_TOKEN, baseUrl);

    httpServer = await startHttpServer({
      port,
      host: "127.0.0.1",
      authToken: STATIC_TOKEN,
      createProtocolServer: createStubProtocolServer,
      oauthProvider: oauth.provider,
      authRouter: oauth.authRouter,
      resourceMetadataUrl: oauth.resourceMetadataUrl,
    });
  });

  afterAll(async () => {
    await closeHttpServer(httpServer, 100);
  });

  const callMcp = (token?: string) =>
    fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  const registerClient = async () => {
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "test-client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    return (await response.json()) as { client_id: string };
  };

  /** Runs authorize + token exchange, returning the issued tokens. */
  const completeFlow = async () => {
    const verifier = base64Url(randomBytes(32));
    const challenge = base64Url(createHash("sha256").update(verifier).digest());
    const { client_id } = await registerClient();

    const params = {
      response_type: "code",
      client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    };

    const authorized = await fetch(`${baseUrl}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ...params, mcp_token: STATIC_TOKEN }),
      redirect: "manual",
    });

    const location = new URL(authorized.headers.get("location") as string);
    const code = location.searchParams.get("code") as string;

    return { client_id, code, verifier, location };
  };

  const exchangeCode = (clientId: string, code: string, verifier: string) =>
    fetch(`${baseUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        code_verifier: verifier,
      }),
    });

  describe("discovery", () => {
    it("should publish authorization server metadata", async () => {
      const response = await fetch(
        `${baseUrl}/.well-known/oauth-authorization-server`,
      );
      const metadata = await response.json();

      expect(response.status).toBe(200);
      expect(metadata.authorization_endpoint).toContain("/authorize");
      expect(metadata.token_endpoint).toContain("/token");
      expect(metadata.code_challenge_methods_supported).toContain("S256");
    });

    it("should publish protected resource metadata", async () => {
      const response = await fetch(
        `${baseUrl}/.well-known/oauth-protected-resource`,
      );

      expect(response.status).toBe(200);
    });
  });

  describe("authorization", () => {
    it("should render a login form for a registered client", async () => {
      const { client_id } = await registerClient();
      const url = new URL(`${baseUrl}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client_id);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("code_challenge", base64Url(randomBytes(32)));
      url.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(url);
      const html = await response.text();

      expect(response.status).toBe(200);
      expect(html).toContain('name="mcp_token"');
    });

    it("should forbid framing the consent page", async () => {
      const { client_id } = await registerClient();
      const url = new URL(`${baseUrl}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client_id);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("code_challenge", base64Url(randomBytes(32)));
      url.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(url);

      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
    });

    it("should let the form submission redirect to the client's origin", async () => {
      // Browsers apply form-action to redirects after a POST, so 'self' alone
      // blocks the 302 that delivers the code to the client.
      const { client_id } = await registerClient();
      const url = new URL(`${baseUrl}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client_id);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("code_challenge", base64Url(randomBytes(32)));
      url.searchParams.set("code_challenge_method", "S256");

      const response = await fetch(url);

      expect(response.headers.get("content-security-policy")).toContain(
        "form-action 'self' https://claude.ai;",
      );
    });

    it("should rate limit per forwarded client address, not per proxy", async () => {
      // Behind a reverse proxy every connection shares the proxy's address, so
      // the limiter must key on X-Forwarded-For or one client can exhaust
      // the bucket for everyone.
      const probe = (ip: string) =>
        fetch(`${baseUrl}/authorize`, {
          headers: { "X-Forwarded-For": ip },
        });

      const first = await probe("203.0.113.10");
      const remaining = Number(first.headers.get("ratelimit-remaining"));
      expect(remaining).toBeGreaterThan(0);

      // Drain the first client's bucket completely.
      for (let i = 0; i < remaining; i++) {
        await probe("203.0.113.10");
      }

      expect((await probe("203.0.113.10")).status).toBe(429);
      expect((await probe("203.0.113.11")).status).not.toBe(429);
    });

    it("should show which application is asking and where the code will go", async () => {
      const response = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Totally Legit App",
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const { client_id } = await response.json();

      const url = new URL(`${baseUrl}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client_id);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("code_challenge", base64Url(randomBytes(32)));
      url.searchParams.set("code_challenge_method", "S256");

      const html = await (await fetch(url)).text();

      expect(html).toContain("Totally Legit App");
      expect(html).toContain("claude.ai");
    });

    it("should refuse to register a client pointing at an unknown host", async () => {
      const response = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Phishing App",
          redirect_uris: ["https://evil.example/callback"],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const body = await response.json();

      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(body.error).toBe("invalid_client_metadata");
      expect(body.error_description).toContain("evil.example");
    });

    it("should refuse a client whose redirect host is no longer permitted", async () => {
      // A registration outlives a policy change, so the allowlist is applied
      // again at lookup: tightening it takes effect immediately.
      const permissive = new MailboxOAuthProvider(STATIC_TOKEN, [
        "once-allowed.example",
      ]);
      const registered = await permissive.clientsStore.registerClient?.({
        client_name: "Legacy",
        redirect_uris: ["https://once-allowed.example/cb"],
      } as never);

      const stricter = new MailboxOAuthProvider(STATIC_TOKEN, ["claude.ai"]);

      expect(
        await stricter.clientsStore.getClient(
          (registered as { client_id: string }).client_id,
        ),
      ).toBeUndefined();
    });

    it("should escape client-controlled values in the form", async () => {
      const response = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "<script>alert(1)</script>",
          redirect_uris: [REDIRECT_URI],
          grant_types: ["authorization_code"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        }),
      });
      const { client_id } = await response.json();

      const url = new URL(`${baseUrl}/authorize`);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", client_id);
      url.searchParams.set("redirect_uri", REDIRECT_URI);
      url.searchParams.set("code_challenge", base64Url(randomBytes(32)));
      url.searchParams.set("code_challenge_method", "S256");

      const html = await (await fetch(url)).text();

      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;");
    });

    it("should preserve form state on a POST without a credential", async () => {
      const { client_id } = await registerClient();
      const challenge = base64Url(randomBytes(32));

      // Parameters live in the body on POST, so the re-rendered form must be
      // rebuilt from there rather than from the (empty) query string.
      const response = await fetch(`${baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code",
          client_id,
          redirect_uri: REDIRECT_URI,
          code_challenge: challenge,
          code_challenge_method: "S256",
          state: "kept-state",
        }),
      });
      const html = await response.text();

      expect(html).toContain(challenge);
      expect(html).toContain("kept-state");
    });

    it("should not issue a code for the wrong credential", async () => {
      const { client_id } = await registerClient();
      const response = await fetch(`${baseUrl}/authorize`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          response_type: "code",
          client_id,
          redirect_uri: REDIRECT_URI,
          code_challenge: base64Url(randomBytes(32)),
          code_challenge_method: "S256",
          mcp_token: "wrong-token",
        }),
        redirect: "manual",
      });

      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
    });

    it("should redirect with a code and preserve state", async () => {
      const { location } = await completeFlow();

      expect(location.searchParams.get("code")).toBeTruthy();
      expect(location.searchParams.get("state")).toBe("test-state");
      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
    });
  });

  describe("token exchange", () => {
    it("should reject a mismatched PKCE verifier", async () => {
      const { client_id, code } = await completeFlow();

      const response = await exchangeCode(
        client_id,
        code,
        base64Url(randomBytes(32)),
      );

      expect(response.status).toBeGreaterThanOrEqual(400);
    });

    it("should exchange a code for access and refresh tokens", async () => {
      const { client_id, code, verifier } = await completeFlow();

      const response = await exchangeCode(client_id, code, verifier);
      const tokens = await response.json();

      expect(response.status).toBe(200);
      expect(tokens.access_token).toBeTruthy();
      expect(tokens.refresh_token).toBeTruthy();
      expect(tokens.token_type).toBe("Bearer");
    });

    it("should refuse to reuse an authorization code", async () => {
      const { client_id, code, verifier } = await completeFlow();

      const first = await exchangeCode(client_id, code, verifier);
      const replay = await exchangeCode(client_id, code, verifier);

      expect(first.status).toBe(200);
      expect(replay.status).toBe(400);
      expect((await replay.json()).error).toBe("invalid_grant");
    });

    it("should not accumulate spent codes without bound", async () => {
      const provider = new MailboxOAuthProvider(STATIC_TOKEN);
      const client = { client_id: "c" } as never;
      const key = deriveSigningKey(STATIC_TOKEN);

      const makeCode = (jti: string, ttl: number) =>
        issueToken(key, "code", { cid: "c", ch: "x", jti }, ttl);

      // A short-lived code, then one exchanged after the first has lapsed.
      await provider.exchangeAuthorizationCode(client, makeCode("first", 1));
      expect(provider.trackedUsedCodes).toBe(1);

      await new Promise(resolve => setTimeout(resolve, 1100));
      await provider.exchangeAuthorizationCode(client, makeCode("second", 60));

      // The lapsed entry is swept rather than retained forever.
      expect(provider.trackedUsedCodes).toBe(1);
    });

    it("should issue a new access token from a refresh token", async () => {
      const { client_id, code, verifier } = await completeFlow();
      const { refresh_token } = await (
        await exchangeCode(client_id, code, verifier)
      ).json();

      const response = await fetch(`${baseUrl}/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token,
          client_id,
        }),
      });
      const tokens = await response.json();

      expect(response.status).toBe(200);
      expect(tokens.access_token).toBeTruthy();
    });
  });

  describe("refresh tokens", () => {
    const provider = new MailboxOAuthProvider(STATIC_TOKEN);
    const key = deriveSigningKey(STATIC_TOKEN);
    const client = { client_id: "c" } as never;

    it("should not widen the granted scopes", async () => {
      const refresh = issueToken(
        key,
        "refresh",
        { cid: "c", sc: ["read"] },
        60,
      );

      await expect(
        provider.exchangeRefreshToken(client, refresh, ["read", "write"]),
      ).rejects.toThrow(/scope/i);
    });

    it("should allow narrowing the granted scopes", async () => {
      const refresh = issueToken(
        key,
        "refresh",
        { cid: "c", sc: ["read", "write"] },
        60,
      );

      const tokens = await provider.exchangeRefreshToken(client, refresh, [
        "read",
      ]);

      expect(tokens.scope).toBe("read");
    });

    it("should not extend a session past the original grant", async () => {
      // A refresh token near the end of its life must not mint a fresh
      // 30-day one, or a session could be kept alive forever without the
      // credential ever being entered again.
      const refresh = issueToken(key, "refresh", { cid: "c" }, 60);
      const grantExpiry = readToken(key, "refresh", refresh)?.exp as number;

      const tokens = await provider.exchangeRefreshToken(client, refresh);
      const renewed = readToken(key, "refresh", tokens.refresh_token);
      const access = readToken(key, "access", tokens.access_token);

      expect(renewed?.exp).toBeLessThanOrEqual(grantExpiry);
      expect(access?.exp).toBeLessThanOrEqual(grantExpiry);
    });
  });

  describe("using the tokens against /mcp", () => {
    it("should accept an OAuth access token", async () => {
      const { client_id, code, verifier } = await completeFlow();
      const { access_token } = await (
        await exchangeCode(client_id, code, verifier)
      ).json();

      const response = await callMcp(access_token);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.result.tools[0].name).toBe("search_emails");
    });

    it("should still accept the static token", async () => {
      const response = await callMcp(STATIC_TOKEN);

      expect(response.status).toBe(200);
    });

    it("should reject an invalid token and advertise discovery", async () => {
      const response = await callMcp("not-a-real-token");

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain(
        "resource_metadata=",
      );
    });

    it("should not accept an authorization code as an access token", async () => {
      const { code } = await completeFlow();

      // Token kinds are distinct, so a code must not authenticate a request.
      expect((await callMcp(code)).status).toBe(401);
    });
  });

  describe("logging", () => {
    it("should never log the credential, codes or issued tokens", async () => {
      const stderr = vi.spyOn(console, "error");
      const stdout = vi.spyOn(console, "log");

      const { client_id, code, verifier } = await completeFlow();
      const tokens = await (
        await exchangeCode(client_id, code, verifier)
      ).json();
      // A replayed code and a code presented as a bearer token are both
      // rejected, which is where a careless log line would record them.
      await exchangeCode(client_id, code, verifier);
      await callMcp(code);
      await fetch(
        `${baseUrl}/authorize?response_type=code&client_id=x&code=${code}&code_challenge=${verifier}`,
      );

      const logged = [...stderr.mock.calls, ...stdout.mock.calls]
        .flat()
        .map(String)
        .join("\n");
      expect(logged).toContain("Rejected unauthenticated MCP request");
      for (const secret of [
        STATIC_TOKEN,
        code,
        verifier,
        tokens.access_token,
        tokens.refresh_token,
      ]) {
        expect(logged).not.toContain(secret);
      }
    });
  });
});
