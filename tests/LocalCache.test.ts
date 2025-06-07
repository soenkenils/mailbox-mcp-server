import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../src/services/LocalCache.js";
import type { CacheConfig } from "../src/types/cache.types.js";

describe("MemoryCache", () => {
  let cache: MemoryCache;
  let config: CacheConfig;

  beforeEach(() => {
    config = {
      email: {
        searchTtl: 1000,
        messageTtl: 2000,
        threadTtl: 1500,
      },
      calendar: {
        eventsTtl: 3000,
        freeBusyTtl: 1000,
      },
      maxSize: 5,
      cleanupInterval: 10000,
    };
    cache = new MemoryCache(config);
  });

  afterEach(() => {
    cache.destroy();
  });

  describe("Basic Operations", () => {
    it("should store and retrieve data", () => {
      const testData = { message: "test" };
      cache.set("test-key", testData);

      const retrieved = cache.get("test-key");
      expect(retrieved).toEqual(testData);
    });

    it("should return null for non-existent keys", () => {
      const retrieved = cache.get("non-existent");
      expect(retrieved).toBeNull();
    });

    it("should check if key exists", () => {
      cache.set("test-key", "data");

      expect(cache.has("test-key")).toBe(true);
      expect(cache.has("non-existent")).toBe(false);
    });

    it("should delete keys", () => {
      cache.set("test-key", "data");

      expect(cache.delete("test-key")).toBe(true);
      expect(cache.has("test-key")).toBe(false);
      expect(cache.delete("non-existent")).toBe(false);
    });

    it("should clear all data", () => {
      cache.set("key1", "data1");
      cache.set("key2", "data2");

      expect(cache.size()).toBe(2);
      cache.clear();
      expect(cache.size()).toBe(0);
    });
  });

  describe("TTL (Time To Live)", () => {
    it("should expire data after TTL", async () => {
      cache.set("test-key", "data", 100); // 100ms TTL

      expect(cache.has("test-key")).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(cache.has("test-key")).toBe(false);
      expect(cache.get("test-key")).toBeNull();
    });

    it("should use custom TTL when provided", () => {
      cache.set("test-key", "data", 500);

      const entry = (cache as any).cache.get("test-key");
      expect(entry.ttl).toBe(500);
    });

    it("should use default TTL when not provided", () => {
      cache.set("test-key", "data");

      const entry = (cache as any).cache.get("test-key");
      expect(entry.ttl).toBe(300000); // 5 minutes default
    });
  });

  describe("Size Management", () => {
    it("should enforce max size limit", () => {
      // Add more items than max size
      for (let i = 0; i < 10; i++) {
        cache.set(`key${i}`, `data${i}`);
      }

      expect(cache.size()).toBe(config.maxSize);
    });

    it("should remove oldest items when exceeding max size", () => {
      // Add items up to max size
      for (let i = 0; i < config.maxSize; i++) {
        cache.set(`key${i}`, `data${i}`);
      }

      // Add one more item
      cache.set("newest", "newest-data");

      // Check that oldest item was removed
      expect(cache.has("key0")).toBe(false);
      expect(cache.has("newest")).toBe(true);
    });
  });

  describe("Cleanup", () => {
    it("should clean up expired entries", async () => {
      cache.set("expired", "data", 50);
      cache.set("valid", "data", 1000);

      expect(cache.size()).toBe(2);

      await new Promise((resolve) => setTimeout(resolve, 100));

      cache.cleanup();

      expect(cache.size()).toBe(1);
      expect(cache.has("expired")).toBe(false);
      expect(cache.has("valid")).toBe(true);
    });
  });
});
