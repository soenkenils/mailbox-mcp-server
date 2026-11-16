import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoggerLike } from "../src/services/Logger.js";
import type { LocalCache } from "../src/types/cache.types.js";
import { ConnectionError } from "../src/types/errors.js";
import { createCacheFetcher } from "../src/utils/cacheFallback.js";

const createLogger = (): LoggerLike =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    critical: vi.fn(),
    alert: vi.fn(),
    emergency: vi.fn(),
    startTimer: vi.fn(),
  }) as unknown as LoggerLike;

describe("createCacheFetcher", () => {
  // A map-backed stub: `get` sees only fresh entries, `getStale` all.
  let fresh: Map<string, unknown>;
  let stale: Map<string, unknown>;
  let cache: LocalCache;
  let logger: LoggerLike;
  let cachedFetch: ReturnType<typeof createCacheFetcher>;

  beforeEach(() => {
    fresh = new Map();
    stale = new Map();
    cache = {
      get: vi.fn((key: string) => fresh.get(key) ?? null),
      getStale: vi.fn((key: string) => stale.get(key) ?? null),
      set: vi.fn((key: string, value: unknown) => {
        fresh.set(key, value);
        stale.set(key, value);
      }),
    } as unknown as LocalCache;
    logger = createLogger();
    cachedFetch = createCacheFetcher(cache, logger, "TestService");
  });

  it("returns fresh cached data without fetching", async () => {
    fresh.set("key", "cached");
    const fetch = vi.fn();

    await expect(cachedFetch("key", fetch, "op")).resolves.toBe("cached");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetches and caches when a TTL is given", async () => {
    await expect(
      cachedFetch("key", async () => "fresh", "op", 60000),
    ).resolves.toBe("fresh");
    expect(cache.set).toHaveBeenCalledWith("key", "fresh", 60000);
  });

  it("does not cache without a TTL", async () => {
    await cachedFetch("key", async () => "fresh", "op");
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each([
    ["a ConnectionError", new ConnectionError("down")],
    ["a timeout", new Error("Connection timeout")],
    ["a timed-out fetch", new Error("Fetch timed out after 10000ms")],
    ["a reset socket", new Error("read ECONNRESET")],
  ])("returns stale data on %s", async (_label, error) => {
    stale.set("key", "stale");

    await expect(
      cachedFetch("key", () => Promise.reject(error), "op"),
    ).resolves.toBe("stale");
    expect(logger.warning).toHaveBeenCalledWith(
      "Returning stale cached data due to connection failure",
      { operation: "op", service: "TestService" },
    );
  });

  it("returns the fallback value on a connection error with nothing cached", async () => {
    await expect(
      cachedFetch(
        "key",
        () => Promise.reject(new Error("Fetch timed out")),
        "op",
        undefined,
        { defaultValue: [] as string[] },
      ),
    ).resolves.toEqual([]);
    expect(logger.warning).toHaveBeenCalledWith(
      "No cached data available, returning default value due to connection failure",
      { operation: "op", service: "TestService" },
    );
  });

  it("returns a null fallback value when one is given", async () => {
    await expect(
      cachedFetch(
        "key",
        () => Promise.reject(new Error("socket hang up")),
        "op",
        undefined,
        { defaultValue: null },
      ),
    ).resolves.toBeNull();
  });

  it("rethrows a connection error with nothing cached and no fallback", async () => {
    await expect(
      cachedFetch(
        "key",
        () => Promise.reject(new Error("Fetch timed out")),
        "op",
      ),
    ).rejects.toThrow("Fetch timed out");
  });

  it("rethrows other errors even when stale data or a fallback exists", async () => {
    stale.set("key", "stale");

    await expect(
      cachedFetch(
        "key",
        () => Promise.reject(new Error("Invalid credentials")),
        "op",
        undefined,
        { defaultValue: "fallback" },
      ),
    ).rejects.toThrow("Invalid credentials");
    expect(logger.error).toHaveBeenCalledWith(
      "Error in op",
      { operation: "op", service: "TestService" },
      { error: "Invalid credentials" },
    );
  });
});
