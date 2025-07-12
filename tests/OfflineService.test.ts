import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCache } from "../src/services/LocalCache.js";
import { OfflineService } from "../src/services/OfflineService.js";
import type {
  EmailMessage,
  EmailSearchOptions,
} from "../src/types/email.types.js";

describe("OfflineService", () => {
  let offlineService: OfflineService;
  let cache: MemoryCache;

  const mockEmail: EmailMessage = {
    id: "test@example.com",
    uid: 123,
    subject: "Test Email Subject",
    from: [{ name: "John Doe", address: "john@example.com" }],
    to: [{ name: "Jane Smith", address: "jane@example.com" }],
    cc: [],
    date: new Date("2025-01-15T10:00:00Z"),
    flags: ["\\Seen"],
    folder: "INBOX",
    text: "This is a test email content",
  };

  const mockEmails: EmailMessage[] = [
    mockEmail,
    {
      id: "test2@example.com",
      uid: 124,
      subject: "Another Test Email",
      from: [{ name: "Alice Brown", address: "alice@company.com" }],
      to: [{ name: "Bob Wilson", address: "bob@example.com" }],
      cc: [],
      date: new Date("2025-01-14T15:30:00Z"),
      flags: [],
      folder: "INBOX",
      text: "Another test email content",
    },
  ];

  beforeEach(() => {
    const cacheConfig = {
      email: { searchTtl: 300000, messageTtl: 600000, threadTtl: 300000 },
      calendar: { eventsTtl: 900000, freeBusyTtl: 300000 },
      maxSize: 1000,
      cleanupInterval: 300000,
    };
    cache = new MemoryCache(cacheConfig);
    offlineService = new OfflineService(cache);
  });

  describe("getOfflineCapabilities", () => {
    it("should report no capabilities when cache is empty", () => {
      const capabilities = offlineService.getOfflineCapabilities();

      expect(capabilities.canSearchEmails).toBe(false);
      expect(capabilities.canGetEmail).toBe(false);
      expect(capabilities.canGetFolders).toBe(false);
      expect(capabilities.canAccessCachedData).toBe(false);
      expect(capabilities.lastSyncTime).toBeUndefined();
    });

    it("should report capabilities when cache has data", () => {
      cache.set("test-key", "test-data");

      const capabilities = offlineService.getOfflineCapabilities();

      expect(capabilities.canSearchEmails).toBe(true);
      expect(capabilities.canGetEmail).toBe(true);
      expect(capabilities.canGetFolders).toBe(true);
      expect(capabilities.canAccessCachedData).toBe(true);
    });
  });

  describe("searchEmailsOffline", () => {
    beforeEach(() => {
      // Cache some search results with different keys for different test scenarios
      const searchOptions1: EmailSearchOptions = { folder: "INBOX", limit: 10 };
      const cacheKey1 = `email_search:${JSON.stringify(searchOptions1)}`;
      cache.set(cacheKey1, mockEmails);

      // Cache for query test
      const searchOptions2: EmailSearchOptions = {
        folder: "INBOX",
        limit: 10,
        query: "John Doe",
      };
      const cacheKey2 = `email_search:${JSON.stringify(searchOptions2)}`;
      cache.set(cacheKey2, mockEmails);

      // Cache for date test
      const searchOptions3: EmailSearchOptions = {
        folder: "INBOX",
        limit: 10,
        since: new Date("2025-01-15T00:00:00Z"),
      };
      const cacheKey3 = `email_search:${JSON.stringify(searchOptions3)}`;
      cache.set(cacheKey3, mockEmails);

      // Cache for pagination test
      const searchOptions4: EmailSearchOptions = {
        folder: "INBOX",
        limit: 1,
        offset: 1,
      };
      const cacheKey4 = `email_search:${JSON.stringify(searchOptions4)}`;
      cache.set(cacheKey4, mockEmails);

      // Cache base folder for fallback tests
      const baseOptions = { folder: "INBOX" };
      const baseCacheKey = `email_search:${JSON.stringify(baseOptions)}`;
      cache.set(baseCacheKey, mockEmails);
    });

    it("should return cached search results", async () => {
      const options: EmailSearchOptions = { folder: "INBOX", limit: 10 };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toEqual(mockEmails);
    });

    it("should filter results by query", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        limit: 10,
        query: "John Doe",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Test Email Subject");
    });

    it("should filter results by date range", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        limit: 10,
        since: new Date("2025-01-15T00:00:00Z"),
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Test Email Subject");
    });

    it("should apply pagination", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        limit: 1,
        offset: 1,
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Another Test Email");
    });

    it("should return empty array when no cached data found", async () => {
      const options: EmailSearchOptions = { folder: "SENT", limit: 10 };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toEqual([]);
    });

    it("should try multiple cache key variations", async () => {
      // Cache data with different key structure
      const baseOptions = { folder: "INBOX" };
      const cacheKey = `email_search:${JSON.stringify(baseOptions)}`;
      cache.set(cacheKey, mockEmails);

      const options: EmailSearchOptions = {
        folder: "INBOX",
        limit: 5,
        offset: 0,
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toEqual(mockEmails);
    });
  });

  describe("getEmailOffline", () => {
    beforeEach(() => {
      cache.set("email:INBOX:123", mockEmail);
    });

    it("should return cached email", async () => {
      const result = await offlineService.getEmailOffline(123, "INBOX");

      expect(result).toEqual(mockEmail);
    });

    it("should return null when email not found", async () => {
      const result = await offlineService.getEmailOffline(999, "INBOX");

      expect(result).toBeNull();
    });

    it("should work with default folder", async () => {
      const result = await offlineService.getEmailOffline(123);

      expect(result).toEqual(mockEmail);
    });
  });

  describe("getFoldersOffline", () => {
    const mockFolders = [
      {
        name: "INBOX",
        path: "INBOX",
        delimiter: "/",
        flags: [],
        specialUse: undefined,
      },
      {
        name: "Sent",
        path: "Sent",
        delimiter: "/",
        flags: [],
        specialUse: "\\Sent",
      },
    ];

    it("should return cached folders", async () => {
      cache.set("email_folders", mockFolders);

      const result = await offlineService.getFoldersOffline();

      expect(result).toEqual(mockFolders);
    });

    it("should return default folders when no cache", async () => {
      const result = await offlineService.getFoldersOffline();

      expect(result).toHaveLength(4);
      expect(result[0].name).toBe("INBOX");
      expect(result[1].name).toBe("Sent");
      expect(result[2].name).toBe("Drafts");
      expect(result[3].name).toBe("Trash");
    });
  });

  describe("query matching", () => {
    beforeEach(() => {
      const searchOptions: EmailSearchOptions = { folder: "INBOX" };
      const cacheKey = `email_search:${JSON.stringify(searchOptions)}`;
      cache.set(cacheKey, mockEmails);
    });

    it("should match subject content", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "Test Email Subject",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Test Email Subject");
    });

    it("should match sender name", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "John Doe",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
    });

    it("should match sender email", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "john@example.com",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
    });

    it("should match recipient email", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "jane@example.com",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
    });

    it("should match email text content", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "test email content",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(2); // Both emails contain this text
    });

    it("should be case insensitive", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "JOHN DOE",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
    });

    it("should return no results for non-matching query", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "nonexistent content",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(0);
    });
  });

  describe("getCachedEmailsList", () => {
    it("should return empty array", () => {
      const result = offlineService.getCachedEmailsList();

      expect(result).toEqual([]);
    });
  });

  describe("getOfflineStats", () => {
    it("should return basic stats", () => {
      cache.set("test1", "data1");
      cache.set("test2", "data2");

      const stats = offlineService.getOfflineStats();

      expect(stats.totalCacheSize).toBe(2);
      expect(stats.cachedEmails).toBe(0);
      expect(stats.cachedSearches).toBe(0);
      expect(stats.oldestCacheEntry).toBeUndefined();
      expect(stats.newestCacheEntry).toBeUndefined();
    });

    it("should handle empty cache", () => {
      const stats = offlineService.getOfflineStats();

      expect(stats.totalCacheSize).toBe(0);
    });
  });

  describe("date filtering", () => {
    beforeEach(() => {
      const searchOptions: EmailSearchOptions = { folder: "INBOX" };
      const cacheKey = `email_search:${JSON.stringify(searchOptions)}`;
      cache.set(cacheKey, mockEmails);
    });

    it("should filter by since date", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        since: new Date("2025-01-15T00:00:00Z"),
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Test Email Subject");
    });

    it("should filter by before date", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        before: new Date("2025-01-15T00:00:00Z"),
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Another Test Email");
    });

    it("should combine date filters", async () => {
      const options: EmailSearchOptions = {
        folder: "INBOX",
        since: new Date("2025-01-14T00:00:00Z"),
        before: new Date("2025-01-15T00:00:00Z"),
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
      expect(results[0].subject).toBe("Another Test Email");
    });
  });

  describe("edge cases", () => {
    it("should handle emails without text content", async () => {
      const emailWithoutText = { ...mockEmail, text: undefined };
      const searchOptions: EmailSearchOptions = { folder: "INBOX" };
      const cacheKey = `email_search:${JSON.stringify(searchOptions)}`;
      cache.set(cacheKey, [emailWithoutText]);

      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "nonexistent",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(0);
    });

    it("should handle emails without names", async () => {
      const emailWithoutNames = {
        ...mockEmail,
        from: [{ address: "test@example.com" }],
        to: [{ address: "recipient@example.com" }],
      };
      const searchOptions: EmailSearchOptions = { folder: "INBOX" };
      const cacheKey = `email_search:${JSON.stringify(searchOptions)}`;
      cache.set(cacheKey, [emailWithoutNames]);

      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "test@example.com",
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(1);
    });

    it("should handle complex search options", async () => {
      const searchOptions: EmailSearchOptions = { folder: "INBOX" };
      const cacheKey = `email_search:${JSON.stringify(searchOptions)}`;
      cache.set(cacheKey, mockEmails);

      const options: EmailSearchOptions = {
        folder: "INBOX",
        query: "test",
        since: new Date("2025-01-14T00:00:00Z"),
        before: new Date("2025-01-16T00:00:00Z"),
        limit: 5,
        offset: 0,
      };

      const results = await offlineService.searchEmailsOffline(options);

      expect(results).toHaveLength(2);
    });
  });
});
