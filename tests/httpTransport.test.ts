import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeHttpServer, startHttpServer } from "../src/transport/http.js";

const TOKEN = "a".repeat(64);

const JSON_RPC_HEADERS = {
  "Content-Type": "application/json",
  // The transport requires both content types on the Accept header.
  Accept: "application/json, text/event-stream",
};

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
};

/** Stands in for the real server: same shape, no IMAP/SMTP/CalDAV wiring. */
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

describe("HTTP transport", () => {
  let baseUrl: string;
  let httpServer: Awaited<ReturnType<typeof startHttpServer>>;

  beforeEach(async () => {
    httpServer = await startHttpServer({
      port: 0,
      host: "127.0.0.1",
      authToken: TOKEN,
      createProtocolServer: createStubProtocolServer,
    });
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await closeHttpServer(httpServer, 100);
  });

  const postMcp = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...JSON_RPC_HEADERS, ...headers },
      body: JSON.stringify(initializeRequest),
    });

  describe("health endpoint", () => {
    it("should respond without authentication", async () => {
      const response = await fetch(`${baseUrl}/health`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ok" });
    });

    it("should reject non-GET methods", async () => {
      const response = await fetch(`${baseUrl}/health`, { method: "POST" });

      expect(response.status).toBe(405);
    });
  });

  describe("authentication", () => {
    it("should reject requests without a token", async () => {
      const response = await postMcp("/mcp");

      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe("Bearer");
    });

    it("should reject an incorrect bearer token", async () => {
      const response = await postMcp("/mcp", {
        Authorization: `Bearer ${"b".repeat(64)}`,
      });

      expect(response.status).toBe(401);
    });

    it("should not accept a token in the path", async () => {
      // A token in the URL would end up in proxy and access logs.
      const response = await postMcp(`/mcp/${TOKEN}`);

      expect(response.status).toBe(404);
    });

    it("should log a rejected request without the presented credential", async () => {
      const wrong = "c".repeat(64);
      const stderr = vi.spyOn(console, "error");

      await postMcp("/mcp", { Authorization: `Bearer ${wrong}` });

      const logged = stderr.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("Rejected unauthenticated MCP request");
      expect(logged).not.toContain(wrong);
      expect(logged).not.toContain(TOKEN);
    });

    it("should not leak the token in the response body", async () => {
      const response = await postMcp("/mcp");

      expect(await response.text()).not.toContain(TOKEN);
    });
  });

  describe("MCP requests", () => {
    it("should serve initialize with a bearer token", async () => {
      const response = await postMcp("/mcp", {
        Authorization: `Bearer ${TOKEN}`,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.serverInfo.name).toBe("mailbox-mcp-server");
    });

    it("should run statelessly without issuing a session id", async () => {
      const response = await postMcp("/mcp", {
        Authorization: `Bearer ${TOKEN}`,
      });

      expect(response.headers.get("mcp-session-id")).toBeNull();
    });

    it("should return JSON rather than an SSE stream", async () => {
      const response = await postMcp("/mcp", {
        Authorization: `Bearer ${TOKEN}`,
      });

      expect(response.headers.get("content-type")).toContain(
        "application/json",
      );
    });

    it("should list tools", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result.tools[0].name).toBe("search_emails");
    });
  });

  describe("request limits", () => {
    it("should reject a body larger than the transport allows", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body: "x".repeat(4 * 1024 * 1024 + 1),
      });

      expect(response.status).toBe(413);
    });

    it("should reject an oversized chunked body that declares no length", async () => {
      // A streamed body is sent with Transfer-Encoding: chunked, so there is
      // no Content-Length to check up front; the cap must hold while reading.
      const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent++ < 5) {
            controller.enqueue(chunk);
          } else {
            controller.close();
          }
        },
      });

      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body,
        duplex: "half",
      } as RequestInit);

      expect(response.status).toBe(413);
    });

    it("should answer a malformed body with a JSON-RPC parse error", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { ...JSON_RPC_HEADERS, Authorization: `Bearer ${TOKEN}` },
        body: "{not json",
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error.code).toBe(-32700);
    });
  });

  describe("routing", () => {
    it("should refuse GET on the MCP endpoint so no SSE stream is opened", async () => {
      const response = await fetch(`${baseUrl}/mcp`, {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${TOKEN}`,
        },
      });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
    });

    it("should return 404 for unknown paths", async () => {
      const response = await fetch(`${baseUrl}/nope`);

      expect(response.status).toBe(404);
    });

    it("should return 404 for deeper MCP paths", async () => {
      const response = await postMcp(`/mcp/${TOKEN}/extra`);

      expect(response.status).toBe(404);
    });

    it("should answer an unparseable request target with 400, not a server error", async () => {
      // "//" parses as a scheme-relative URL with an empty host, which the URL
      // constructor rejects. Any client can send it, so it must not surface as
      // a 500 and an error-level log line.
      const errorSpy = vi.spyOn(console, "error");

      const response = await fetch(`${baseUrl}//`);

      expect(response.status).toBe(400);
      const logged = errorSpy.mock.calls.flat().map(String).join("\n");
      expect(logged).not.toContain("Unhandled error while serving request");
      errorSpy.mockRestore();
    });
  });

  describe("shutdown", () => {
    it("should stop accepting connections once closed", async () => {
      await closeHttpServer(httpServer, 100);

      await expect(fetch(`${baseUrl}/health`)).rejects.toThrow();
    });
  });
});
