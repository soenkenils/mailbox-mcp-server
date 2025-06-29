import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPoolConfig } from "../src/services/ConnectionPool.js";
import { EmailService } from "../src/services/EmailService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type { EmailMessage, ImapConnection } from "../src/types/email.types.js";

// Mock factories for cleaner test setup
const createMockEmailMessage = (
  overrides: Partial<EmailMessage> = {},
): EmailMessage => ({
  id: "msg-1",
  uid: 1,
  subject: "Test Email",
  from: [{ name: "Test Sender", address: "sender@example.com" }],
  to: [{ name: "Test Recipient", address: "recipient@example.com" }],
  cc: [],
  bcc: [],
  date: new Date("2024-01-01T10:00:00Z"),
  flags: [],
  folder: "INBOX",
  ...overrides,
});

const createMockImapMessage = (overrides: any = {}) => ({
  uid: 1,
  envelope: {
    messageId: "msg-1",
    subject: "Test Email",
    from: [{ name: "Test Sender", address: "sender@example.com" }],
    to: [{ name: "Test Recipient", address: "recipient@example.com" }],
    cc: [],
    date: new Date("2024-01-01T10:00:00Z"),
  },
  flags: [],
  ...overrides,
});

const createMockCache = (): LocalCache => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  clear: vi.fn(),
  cleanup: vi.fn(),
  has: vi.fn(),
  size: vi.fn(),
});

const createMockConnection = (
  overrides: Partial<ImapConnection> = {},
): ImapConnection => ({
  user: "test@example.com",
  password: "password",
  host: "imap.example.com",
  port: 993,
  secure: true,
  ...overrides,
});

// Mock IMAP functions
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockMailboxOpen = vi.fn();
const mockSearch = vi.fn();
const mockFetch = vi.fn();
const mockFetchOne = vi.fn();
const mockOn = vi.fn();

// Mock the imapflow module
vi.mock("imapflow", () => {
  return {
    ImapFlow: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      logout: mockLogout,
      mailboxOpen: mockMailboxOpen,
      search: mockSearch,
      fetch: mockFetch,
      fetchOne: mockFetchOne,
      on: mockOn,
    })),
  };
});

const setupMockDefaults = () => {
  // Reset all mocks
  vi.clearAllMocks();

  // Setup default successful responses
  mockConnect.mockResolvedValue(undefined);
  mockLogout.mockResolvedValue(undefined);
  mockMailboxOpen.mockResolvedValue({ exists: 10 });
  mockSearch.mockResolvedValue([1, 2, 3]);
  mockFetch.mockResolvedValue([
    createMockImapMessage({ uid: 1 }),
    createMockImapMessage({ uid: 2 }),
    createMockImapMessage({ uid: 3 }),
  ]);
  mockFetchOne.mockResolvedValue(createMockImapMessage());
  mockOn.mockImplementation(() => {});
};

describe("EmailService", () => {
  let emailService: EmailService;
  let mockCache: LocalCache;
  let mockConnection: ImapConnection;

  beforeEach(() => {
    setupMockDefaults();

    mockCache = createMockCache();
    mockConnection = createMockConnection();

    // Create mock pool config
    const mockPoolConfig: ConnectionPoolConfig = {
      minConnections: 1,
      maxConnections: 5,
      acquireTimeoutMs: 30000,
      idleTimeoutMs: 300000,
      maxRetries: 3,
      retryDelayMs: 1000,
      healthCheckIntervalMs: 60000,
    };

    emailService = new EmailService(mockConnection, mockCache, mockPoolConfig);
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
        or: [{ subject: "test" }, { body: "test" }],
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
        or: [{ subject: "important" }, { body: "important" }],
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
      createMockEmailMessage({
        id: "1",
        uid: 1,
        subject: "Newsletter from Correctiv",
        from: [{ address: "newsletter@correctiv.org", name: "Correctiv" }],
        date: new Date("2024-01-01T10:00:00Z"),
      }),
      createMockEmailMessage({
        id: "2",
        uid: 2,
        subject: "Article from Krautreporter",
        from: [{ address: "info@krautreporter.de", name: "Krautreporter" }],
        date: new Date("2024-06-01T10:00:00Z"),
      }),
      createMockEmailMessage({
        id: "3",
        uid: 3,
        subject: "Random Email",
        from: [{ address: "random@example.com", name: "Random" }],
        date: new Date("2024-12-01T10:00:00Z"),
      }),
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
      const mockMessages = [createMockEmailMessage()];
      (mockCache.get as Mock).mockReturnValue(mockMessages);

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
      (mockCache.get as Mock).mockReturnValue([createMockEmailMessage()]);

      emailService.searchEmails(options);

      expect(mockCache.get).toHaveBeenCalledWith(
        `email_search:${JSON.stringify(options)}`,
      );
    });
  });

  describe("getEmail", () => {
    it("should return cached email when available", async () => {
      const mockEmail = createMockEmailMessage({ uid: 123 });
      (mockCache.get as Mock).mockReturnValue(mockEmail);

      const result = await emailService.getEmail(123);

      expect(result).toBe(mockEmail);
      expect(mockCache.get).toHaveBeenCalledWith("email:INBOX:123");
    });
  });

  describe("getEmailThread", () => {
    it("should return cached thread when available", async () => {
      const mockThread = {
        threadId: "thread-1",
        messages: [createMockEmailMessage()],
        subject: "Thread Subject",
        participants: [{ name: "User", address: "user@example.com" }],
        lastActivity: new Date(),
      };
      (mockCache.get as Mock).mockReturnValue(mockThread);

      const result = await emailService.getEmailThread("message-id");

      expect(result).toBe(mockThread);
      expect(mockCache.get).toHaveBeenCalledWith("thread:INBOX:message-id");
    });
  });

  describe("parseEmailMessage", () => {
    it("should parse a standard envelope", () => {
      const message = {
        uid: 42,
        envelope: {
          messageId: "msg-42",
          subject: "Hello World",
          from: [{ name: "Alice", address: "alice@example.com" }],
          to: [{ name: "Bob", address: "bob@example.com" }],
          cc: [{ name: "Carol", address: "carol@example.com" }],
          date: new Date("2024-06-01T10:00:00Z"),
        },
        flags: ["Seen"],
      };
      const result = (emailService as any).parseEmailMessage(message, "INBOX");
      expect(result).toMatchObject({
        id: "msg-42",
        uid: 42,
        subject: "Hello World",
        from: [{ name: "Alice", address: "alice@example.com" }],
        to: [{ name: "Bob", address: "bob@example.com" }],
        cc: [{ name: "Carol", address: "carol@example.com" }],
        date: new Date("2024-06-01T10:00:00Z"),
        flags: ["Seen"],
        folder: "INBOX",
      });
    });

    it("should return null if envelope is missing", () => {
      const message = { uid: 1 };
      const result = (emailService as any).parseEmailMessage(message, "INBOX");
      expect(result).toBeNull();
    });

    it("should handle missing optional fields", () => {
      const message = {
        uid: 2,
        envelope: {
          messageId: "msg-2",
          subject: undefined,
          from: undefined,
          to: undefined,
          cc: undefined,
          date: undefined,
        },
        flags: undefined,
      };
      const result = (emailService as any).parseEmailMessage(message, "INBOX");
      expect(result).toMatchObject({
        id: "msg-2",
        uid: 2,
        subject: "",
        from: [],
        to: [],
        cc: [],
        date: expect.any(Date),
        flags: [],
        folder: "INBOX",
      });
    });
  });

  describe("parseAddressesFromEnvelope", () => {
    const parseAddresses = (addresses: any) =>
      (emailService as any).parseAddressesFromEnvelope(addresses);

    it("should handle array of addresses", () => {
      const input = [
        { name: "Alice", address: "alice@example.com" },
        { name: "Bob", address: "bob@example.com" },
      ];
      expect(parseAddresses(input)).toEqual(input);
    });

    it("should handle single address object", () => {
      const input = { name: "Carol", address: "carol@example.com" };
      expect(parseAddresses(input)).toEqual([input]);
    });

    it.each([
      [
        "array of addresses",
        [
          { name: "Alice", address: "alice@example.com" },
          { name: "Bob", address: "bob@example.com" },
        ],
        [
          { name: "Alice", address: "alice@example.com" },
          { name: "Bob", address: "bob@example.com" },
        ],
      ],
      [
        "single address object",
        { name: "Carol", address: "carol@example.com" },
        [{ name: "Carol", address: "carol@example.com" }],
      ],
      ["null addresses", null, []],
      ["undefined addresses", undefined, []],
      ["empty array", [], []],
      [
        "address without name",
        { address: "noreply@example.com" },
        [{ address: "noreply@example.com" }],
      ],
    ])("should handle %s", (_, input, expected) => {
      expect(parseAddresses(input)).toEqual(expected);
    });
  });

  describe("error handling", () => {
    it("should handle cache errors gracefully", async () => {
      (mockCache.get as Mock).mockImplementation(() => {
        throw new Error("Cache error");
      });

      const result = await emailService
        .searchEmails({ query: "test" })
        .catch(() => []);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("edge cases and boundary testing", () => {
    it("should handle malformed envelope data gracefully", () => {
      const message = {
        uid: 1,
        envelope: {
          messageId: "msg-1",
          subject: undefined,
          from: null,
          to: [],
          date: "not-a-date",
        },
        flags: null,
      };

      const result = (emailService as any).parseEmailMessage(message, "INBOX");

      expect(result).toMatchObject({
        uid: 1,
        subject: "",
        from: [],
        to: [],
        flags: [],
        folder: "INBOX",
      });
    });

    it("should handle boundary conditions for search criteria", () => {
      const buildSearchCriteria = (options: any) => {
        return (emailService as any).buildSearchCriteria(options);
      };

      // Test very long query
      const longQuery = "a".repeat(1000);
      const longResult = buildSearchCriteria({ query: longQuery });
      expect(longResult).toBeDefined();

      // Test special characters
      const specialQuery = "test@domain.com AND (subject:äöü OR from:测试)";
      const specialResult = buildSearchCriteria({ query: specialQuery });
      expect(specialResult).toBeDefined();
    });
  });

  describe("additional edge cases", () => {
    it("should handle complex search criteria combinations", () => {
      const buildSearchCriteria = (options: any) => {
        return (emailService as any).buildSearchCriteria(options);
      };

      // Test multiple criteria combinations
      const complexOptions = {
        query: "from:test@example.com AND subject:important",
        since: new Date("2024-01-01"),
        before: new Date("2024-12-31"),
      };

      const result = buildSearchCriteria(complexOptions);
      expect(result).toHaveProperty("since");
      expect(result).toHaveProperty("before");
    });

    it("should handle malformed address parsing edge cases", () => {
      const parseAddresses = (addresses: any) =>
        (emailService as any).parseAddressesFromEnvelope(addresses);

      // Test falsy values return empty array
      expect(parseAddresses(null)).toEqual([]);
      expect(parseAddresses(undefined)).toEqual([]);
      expect(parseAddresses(false)).toEqual([]);
      expect(parseAddresses(0)).toEqual([]);
      expect(parseAddresses("")).toEqual([]);

      // Test empty array stays empty
      expect(parseAddresses([])).toEqual([]);

      // Test truthy non-array values become single-item arrays
      expect(parseAddresses({})).toEqual([{}]);
      expect(parseAddresses("string-instead-of-object")).toEqual([
        "string-instead-of-object",
      ]);
      expect(parseAddresses(123)).toEqual([123]);
    });
  });
});
