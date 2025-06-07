import { beforeEach, describe, expect, it, vi } from "vitest";
import { EmailService } from "../src/services/EmailService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type { ImapConnection } from "../src/types/email.types.js";

// Mock the imapflow module
vi.mock("imapflow", () => {
  const mockImapFlow = vi.fn();
  mockImapFlow.prototype.connect = vi.fn();
  mockImapFlow.prototype.logout = vi.fn();
  mockImapFlow.prototype.mailboxOpen = vi.fn();
  mockImapFlow.prototype.search = vi.fn();
  mockImapFlow.prototype.fetch = vi.fn();
  mockImapFlow.prototype.fetchOne = vi.fn();
  return { ImapFlow: mockImapFlow };
});

describe("EmailService", () => {
  let emailService: EmailService;
  let mockCache: LocalCache;
  let mockConnection: ImapConnection;

  beforeEach(() => {
    mockCache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      cleanup: vi.fn(),
      getStats: vi.fn(),
    };

    mockConnection = {
      user: "test@example.com",
      password: "password",
      host: "imap.example.com",
      port: 993,
      secure: true,
    };

    emailService = new EmailService(mockConnection, mockCache);
  });

  describe("buildSearchCriteria", () => {
    // Access the private method for testing
    const buildSearchCriteria = (options: any) => {
      return (emailService as any).buildSearchCriteria(options);
    };

    it("should return all for empty options", () => {
      const result = buildSearchCriteria({});
      expect(result).toEqual({ all: true });
    });

    it("should build text criteria for simple query search", () => {
      const result = buildSearchCriteria({ query: "test" });
      expect(result).toEqual({
        or: [
          { subject: "test" },
          { body: "test" }
        ]
      });
    });

    it("should build since criteria for date filter", () => {
      const date = new Date("2024-01-01");
      const result = buildSearchCriteria({ since: date });
      expect(result).toEqual({ since: date });
    });

    it("should build before criteria for date filter", () => {
      const date = new Date("2024-01-31");
      const result = buildSearchCriteria({ before: date });
      expect(result).toEqual({ before: date });
    });

    it("should combine both date filters", () => {
      const since = new Date("2024-01-01");
      const before = new Date("2024-01-31");
      const result = buildSearchCriteria({ since, before });
      expect(result).toEqual({
        since: since,
        before: before,
      });
    });

    it("should combine simple query with dates", () => {
      const since = new Date("2024-01-01");
      const result = buildSearchCriteria({
        query: "important",
        since,
      });
      expect(result).toEqual({
        since: since,
        or: [
          { subject: "important" },
          { body: "important" }
        ]
      });
    });

    it("should handle from: queries", () => {
      const result = buildSearchCriteria({ query: "from:test@example.com" });
      expect(result).toEqual({ from: "test@example.com" });
    });

    it("should handle to: queries", () => {
      const result = buildSearchCriteria({ query: "to:test@example.com" });
      expect(result).toEqual({ to: "test@example.com" });
    });

    it("should handle complex OR query with dates using date filters only", () => {
      const since = new Date("2024-01-01");
      const before = new Date("2024-01-31");
      const result = buildSearchCriteria({
        query: "from:correctiv.org OR from:krautreporter.de",
        since,
        before,
      });
      expect(result).toEqual({
        since: since,
        before: before,
      });
    });

    it("should handle complex OR query without dates", () => {
      const result = buildSearchCriteria({
        query: "from:correctiv.org OR from:krautreporter.de",
      });
      expect(result).toEqual({ all: true });
    });

    it("should handle complex query with date by using date filter and in-memory query", () => {
      // This test replicates the exact scenario from the log that causes the error
      const result = buildSearchCriteria({
        query: "from:correctiv.org OR from:krautreporter.de",
        since: new Date("2025-05-31T00:00:00Z"),
      });

      // Should return date filter and let query be handled in memory
      expect(result).toBeDefined();
      expect(result).toEqual({ since: new Date("2025-05-31T00:00:00Z") });
    });
  });

  describe("applyInMemoryFilters", () => {
    const applyInMemoryFilters = (messages: any[], options: any) => {
      return (emailService as any).applyInMemoryFilters(messages, options);
    };

    const mockMessages = [
      {
        id: "1",
        uid: 1,
        subject: "Newsletter from Correctiv",
        from: [{ address: "newsletter@correctiv.org", name: "Correctiv" }],
        to: [{ address: "user@example.com", name: "User" }],
        date: new Date("2024-01-01T10:00:00Z"),
        flags: [],
        folder: "INBOX",
      },
      {
        id: "2",
        uid: 2,
        subject: "Article from Krautreporter",
        from: [{ address: "info@krautreporter.de", name: "Krautreporter" }],
        to: [{ address: "user@example.com", name: "User" }],
        date: new Date("2024-06-01T10:00:00Z"),
        flags: [],
        folder: "INBOX",
      },
      {
        id: "3",
        uid: 3,
        subject: "Random Email",
        from: [{ address: "random@example.com", name: "Random" }],
        to: [{ address: "user@example.com", name: "User" }],
        date: new Date("2024-12-01T10:00:00Z"),
        flags: [],
        folder: "INBOX",
      },
    ];

    it("should filter by complex OR query", () => {
      const result = applyInMemoryFilters(mockMessages, {
        query: "from:correctiv.org OR from:krautreporter.de",
      });
      expect(result).toHaveLength(2);
      expect(result.map((m) => m.subject)).toEqual([
        "Newsletter from Correctiv",
        "Article from Krautreporter",
      ]);
    });

    it("should not filter simple from: queries in memory", () => {
      const result = applyInMemoryFilters(mockMessages, {
        query: "from:correctiv.org",
      });
      expect(result).toHaveLength(3); // Simple from: query doesn't trigger in-memory filtering
    });

    it("should not filter simple text queries in memory", () => {
      const result = applyInMemoryFilters(mockMessages, {
        query: "Newsletter",
      });
      expect(result).toHaveLength(3); // Simple query doesn't trigger in-memory filtering
    });

    it("should return all messages when no complex query", () => {
      const result = applyInMemoryFilters(mockMessages, {
        query: "simple",
      });
      expect(result).toHaveLength(3); // Simple query doesn't trigger in-memory filtering
    });

    it("should return all messages when no filters apply", () => {
      const result = applyInMemoryFilters(mockMessages, {});
      expect(result).toHaveLength(3);
    });
  });

  describe("searchEmails", () => {
    it("should return cached results when available", async () => {
      const mockMessages = [{ id: "1", subject: "Test" }];
      (mockCache.get as any).mockReturnValue(mockMessages);

      const result = await emailService.searchEmails({ query: "test" });

      expect(result).toBe(mockMessages);
      expect(mockCache.get).toHaveBeenCalledWith(
        'email_search:{"query":"test"}',
      );
    });

    it("should generate correct cache key for search options", () => {
      const options = {
        query: "test",
        folder: "INBOX",
        since: new Date("2024-01-01"),
        limit: 10,
      };

      emailService.searchEmails(options);

      expect(mockCache.get).toHaveBeenCalledWith(
        `email_search:${JSON.stringify(options)}`,
      );
    });
  });

  describe("getEmail", () => {
    it("should return cached email when available", async () => {
      const mockEmail = { id: "1", uid: 123, subject: "Test Email" };
      (mockCache.get as any).mockReturnValue(mockEmail);

      const result = await emailService.getEmail(123);

      expect(result).toBe(mockEmail);
      expect(mockCache.get).toHaveBeenCalledWith("email:INBOX:123");
    });
  });

  describe("getEmailThread", () => {
    it("should return cached thread when available", async () => {
      const mockThread = {
        threadId: "thread-1",
        messages: [],
        subject: "Thread Subject",
        participants: [],
        lastActivity: new Date(),
      };
      (mockCache.get as any).mockReturnValue(mockThread);

      const result = await emailService.getEmailThread("message-id");

      expect(result).toBe(mockThread);
      expect(mockCache.get).toHaveBeenCalledWith("thread:INBOX:message-id");
    });
  });
});