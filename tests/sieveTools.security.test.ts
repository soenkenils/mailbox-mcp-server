import { describe, expect, it, vi } from "vitest";
import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import type { ServerConfig } from "../src/config/config.js";
import { handleSieveTool } from "../src/tools/sieveTools.js";

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warning: vi.fn(),
  })),
}));

// Closed local port: if validation failed open, the test would show a
// connection error instead of the validation error.
const config = {
  sieve: {
    host: "127.0.0.1",
    port: 1,
    secure: false,
    user: "test@example.org",
    password: "not-a-real-password",
  },
} as unknown as ServerConfig;

const call = (name: string, args: Record<string, unknown>) =>
  handleSieveTool(
    { params: { name, arguments: args } } as CallToolRequest,
    config,
  );

describe("sieve tools reject unsafe script names", () => {
  it.each([
    ["get_sieve_script", { name: 'x"\r\nDELETESCRIPT "victim' }],
    ["delete_sieve_script", { name: "a\nb" }],
    ["activate_sieve_script", { name: 'a"b' }],
    ["create_sieve_filter", { name: "a\\b", content: "keep;" }],
  ])("%s", async (tool, args) => {
    const result = await call(tool, args);
    expect(result.isError).toBe(true);
    const text = String(result.content[0].text);
    expect(text).toMatch(/control characters, quotes or backslashes/);
    expect(text).not.toMatch(/ECONNREFUSED|connect/i);
  });
});
