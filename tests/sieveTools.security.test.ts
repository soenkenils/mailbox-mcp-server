import type { CallToolRequest } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/config/config.js";
import { SieveService } from "../src/services/SieveService.js";
import { handleSieveTool } from "../src/tools/sieveTools.js";
import { SieveError } from "../src/types/sieve.types.js";

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
    ["activate_sieve_script", { name: "a\rb" }],
    ["create_sieve_filter", { name: "a\u0000b", content: "keep;" }],
  ])("%s", async (tool, args) => {
    const result = await call(tool, args);
    expect(result.isError).toBe(true);
    const text = String(result.content[0].text);
    expect(text).toMatch(/must not contain control characters/);
    expect(text).not.toMatch(/ECONNREFUSED|connect/i);
  });

  it("rejects names longer than 100 characters", async () => {
    const result = await call("get_sieve_script", { name: "a".repeat(101) });
    expect(result.isError).toBe(true);
    expect(String(result.content[0].text)).not.toMatch(/ECONNREFUSED/);
  });
});

/** Replace the network side of SieveService for tool-level tests */
function stubSieveSession() {
  vi.spyOn(SieveService.prototype, "connect").mockResolvedValue();
  vi.spyOn(SieveService.prototype, "authenticate").mockResolvedValue();
  vi.spyOn(SieveService.prototype, "disconnect").mockResolvedValue();
}

describe("sieve tools accept quotes and backslashes (RFC 5804)", () => {
  // Another client may have created such a script; it must stay reachable.
  const name = 'a"b\\c';

  it.each([
    ["get_sieve_script", "getScript", "keep;"],
    ["delete_sieve_script", "deleteScript", undefined],
    ["activate_sieve_script", "setActiveScript", undefined],
  ] as const)("%s passes the name through", async (tool, method, value) => {
    stubSieveSession();
    const spy = vi
      .spyOn(SieveService.prototype, method)
      .mockResolvedValue(value as never);
    const result = await call(tool, { name });
    expect(result.isError).toBeFalsy();
    expect(spy).toHaveBeenCalledWith(name);
  });
});

describe("sieve tool error reporting", () => {
  it("includes the RFC 5804 response code", async () => {
    stubSieveSession();
    vi.spyOn(SieveService.prototype, "getScript").mockRejectedValue(
      new SieveError(
        "Failed to get script 'x': There is no script by that name",
        "NONEXISTENT",
      ),
    );
    const result = await call("get_sieve_script", { name: "x" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe(
      "Error: Failed to get script 'x': There is no script by that name [NONEXISTENT]",
    );
  });

  it.each(["NO", "BYE"])("omits the bare %s status", async status => {
    stubSieveSession();
    vi.spyOn(SieveService.prototype, "getScript").mockRejectedValue(
      new SieveError("Failed to get script 'x': nope", status),
    );
    const result = await call("get_sieve_script", { name: "x" });
    expect(result.content[0].text).toBe(
      "Error: Failed to get script 'x': nope",
    );
  });
});
