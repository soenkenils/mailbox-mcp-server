import type { ImapFlow } from "imapflow";
import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import type { ConnectionPoolConfig } from "../src/services/ConnectionPool.js";
import { EmailService } from "../src/services/EmailService.js";
import type { ImapConnectionWrapper } from "../src/services/ImapConnectionPool.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type {
  EmailComposition,
  EmailFolder,
  ImapConnection,
} from "../src/types/email.types.js";
import type { WithPrivates } from "./helpers/privates.js";

// Private methods of EmailService reached by these tests
type TestableEmailService = WithPrivates<
  EmailService,
  {
    isConnectionError(error: unknown): boolean;
    buildEmailContent(composition: EmailComposition): Promise<Buffer>;
    tryGetStaleCache<T>(key: string): T | null;
    clearFolderCache(folder: string): void;
    parseAddressesFromEnvelope(
      addresses: unknown,
    ): Array<{ name?: string; address: string }>;
    parseAddressesFromParsed(
      addresses: unknown,
    ): Array<{ name?: string; address: string }>;
  }
>;

// Mock factories
const createMockCache = (): LocalCache => ({
  get: vi.fn(),
  getStale: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  clear: vi.fn(),
  cleanup: vi.fn(),
  has: vi.fn(),
  size: vi.fn(),
  getStats: vi.fn(),
  keys: vi.fn(() => new Set<string>().values()),
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

const createMockConnectionWrapper = (
  overrides: Partial<ImapConnectionWrapper> = {},
): ImapConnectionWrapper => ({
  connection: {
    mailboxOpen: vi.fn(),
    messageMove: vi.fn().mockResolvedValue({ uidMap: new Map() }),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    capabilities: new Map<string, boolean | number>([["UIDPLUS", true]]),
    append: vi.fn().mockResolvedValue({ destination: "Drafts", uid: 1 }),
    mailboxCreate: vi
      .fn()
      .mockImplementation(async (path: string | string[]) => ({
        path: Array.isArray(path) ? path.join("/") : path,
        created: true,
      })),
    list: vi.fn(),
  } as unknown as ImapFlow,
  id: "test-connection",
  createdAt: new Date(),
  lastUsed: new Date(),
  isHealthy: true,
  inUse: true,
  selectedFolder: "INBOX",
  ...overrides,
});

// Mock IMAP functions
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockMailboxOpen = vi.fn();
const mockMessageMove = vi.fn();
const mockMessageFlagsAdd = vi.fn();
const mockMessageFlagsRemove = vi.fn();
const mockAppend = vi.fn();
const mockMailboxCreate = vi.fn();
const mockList = vi.fn();

// Mock the imapflow module
vi.mock("imapflow", () => {
  return {
    ImapFlow: vi.fn(function () {
      return {
        connect: mockConnect,
        logout: mockLogout,
        mailboxOpen: mockMailboxOpen,
        messageMove: mockMessageMove,
        messageFlagsAdd: mockMessageFlagsAdd,
        messageFlagsRemove: mockMessageFlagsRemove,
        append: mockAppend,
        mailboxCreate: mockMailboxCreate,
        list: mockList,
        on: vi.fn(),
      };
    }),
  };
});

// Mock ImapConnectionPool
const mockPool = {
  acquire: vi.fn(),
  acquireForFolder: vi.fn(),
  release: vi.fn(),
  releaseFromFolder: vi.fn(),
  invalidateFolderConnections: vi.fn(),
  getImapMetrics: vi.fn(),
  getMetrics: vi.fn(),
};

vi.mock("../src/services/ImapConnectionPool.js", () => ({
  ImapConnectionPool: vi.fn(function () {
    return mockPool;
  }),
}));

// Mock Logger
const mockLogger = {
  info: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(function () {
    return mockLogger;
  }),
}));

describe("EmailService - Advanced Coverage", () => {
  let service: TestableEmailService;
  let mockCache: LocalCache;
  let mockImapConnection: ImapConnection;
  let poolConfig: ConnectionPoolConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCache = createMockCache();
    mockImapConnection = createMockConnection();
    poolConfig = {
      minConnections: 1,
      maxConnections: 5,
      acquireTimeoutMs: 5000,
      idleTimeoutMs: 30000,
      maxRetries: 3,
      retryDelayMs: 1000,
      healthCheckIntervalMs: 60000,
    };

    service = new EmailService(
      mockImapConnection,
      mockCache,
      poolConfig,
    ) as unknown as TestableEmailService;

    // Reset mock implementations
    mockPool.getMetrics.mockReturnValue({
      totalConnections: 2,
      activeConnections: 1,
      idleConnections: 1,
      totalErrors: 0,
    });
  });

  describe("buildEmailContent", () => {
    const build = async (composition: EmailComposition) => {
      const raw = (await service.buildEmailContent(composition)).toString();
      const parsed: ParsedMail = await simpleParser(raw);
      return { raw, parsed };
    };

    const addressesOf = (field: AddressObject | AddressObject[] | undefined) =>
      (Array.isArray(field) ? field : field ? [field] : []).flatMap(
        group => group.value,
      );

    it("should build a plain text draft", async () => {
      const { raw, parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        subject: "Test Subject",
        text: "Hello, World!",
      });

      expect(addressesOf(parsed.to).map(a => a.address)).toEqual([
        "recipient@example.com",
      ]);
      expect(parsed.subject).toBe("Test Subject");
      expect(parsed.text?.trim()).toBe("Hello, World!");
      expect(raw).toMatch(/^Content-Type: text\/plain; charset=utf-8/im);
    });

    it("should set From to the account the draft is saved in", async () => {
      const { parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        subject: "Test Subject",
        text: "Test",
      });

      expect(parsed.from?.value).toEqual([
        { name: "Test", address: "test@example.com" },
      ]);
    });

    it("should declare MIME-Version, Date and a Message-ID on the account's domain", async () => {
      const { raw, parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        subject: "Test Subject",
        text: "Test",
      });

      expect(raw).toMatch(/^MIME-Version: 1\.0\r$/m);
      expect(parsed.date).toBeInstanceOf(Date);
      expect(parsed.messageId).toMatch(/^<[^@\s]+@example\.com>$/);
    });

    it("should build an HTML draft", async () => {
      const { parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        subject: "Test Subject",
        html: "<p>Hello, World!</p>",
      });

      expect(parsed.html).toContain("<p>Hello, World!</p>");
    });

    it("should keep both text and HTML when both are given", async () => {
      const { raw, parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        subject: "Test Subject",
        text: "Plain version",
        html: "<p>HTML version</p>",
      });

      expect(raw).toMatch(/^Content-Type: multipart\/alternative/im);
      expect(parsed.text?.trim()).toBe("Plain version");
      expect(parsed.html).toContain("<p>HTML version</p>");
    });

    it("should include CC and keep BCC in the saved draft", async () => {
      const { parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        cc: [{ address: "cc@example.com" }],
        bcc: [{ address: "bcc@example.com" }],
        subject: "Test Subject",
        text: "Test",
      });

      expect(addressesOf(parsed.cc).map(a => a.address)).toEqual([
        "cc@example.com",
      ]);
      expect(addressesOf(parsed.bcc).map(a => a.address)).toEqual([
        "bcc@example.com",
      ]);
    });

    it("should encode non-ASCII subjects and names", async () => {
      const { raw, parsed } = await build({
        to: [{ name: "Jörg Müller", address: "joerg@example.com" }],
        subject: "Grüße aus Kiel",
        text: "Test",
      });

      const headers = raw.slice(0, raw.indexOf("\r\n\r\n"));
      // Header lines are 7-bit; the words come back through RFC 2047.
      expect(headers).not.toMatch(/[^ -~\r\n\t]/);
      expect(parsed.subject).toBe("Grüße aus Kiel");
      expect(addressesOf(parsed.to)).toEqual([
        { name: "Jörg Müller", address: "joerg@example.com" },
      ]);
    });

    // Display names crafted to read as further recipients, or a new header,
    // if they reached the header unescaped
    it.each([
      'X" <evil@example.com>, "Y',
      "Evil, Inc. <evil@example.com>",
      'Back\\slash \\" <evil@example.com>',
      "Line\r\nBcc: evil@example.com",
      "Jörg Müller <evil@example.com>, 日本",
    ])("should keep %j as one display name in to, cc and bcc", async name => {
      const { raw, parsed } = await build({
        to: [{ name, address: "a@example.com" }],
        cc: [{ name, address: "c@example.com" }],
        bcc: [{ name, address: "b@example.com" }],
        subject: "Test Subject",
        text: "Test",
      });

      expect(addressesOf(parsed.to)).toEqual([
        { name, address: "a@example.com" },
      ]);
      expect(addressesOf(parsed.cc)).toEqual([
        { name, address: "c@example.com" },
      ]);
      expect(addressesOf(parsed.bcc)).toEqual([
        { name, address: "b@example.com" },
      ]);
      expect(raw.match(/^Bcc:/gim)).toHaveLength(1);
    });

    it("should end every line with CRLF and keep the body's line breaks", async () => {
      const { raw, parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        subject: "Test Subject",
        text: "Zeile 1\nZeile 2\r\n\nZeile 4\n\tEingerückt",
      });

      expect(raw).not.toMatch(/(?<!\r)\n/);
      expect(parsed.text?.replace(/\r\n/g, "\n").trim()).toBe(
        "Zeile 1\nZeile 2\n\nZeile 4\n\tEingerückt",
      );
    });

    it("should build a draft with no body", async () => {
      const { parsed } = await build({
        to: [{ address: "recipient@example.com" }],
        subject: "Test Subject",
      });

      expect(parsed.subject).toBe("Test Subject");
      expect(parsed.text ?? "").toBe("");
    });
  });

  describe("clearFolderCache", () => {
    it("should delete only cache entries for the given folder", () => {
      mockCache.keys = vi
        .fn()
        .mockReturnValue(
          [
            'email_search:{"folder":"INBOX","limit":10}',
            'email_search:{"folder":"Archive","limit":10}',
            "email:INBOX:42",
            "email:Archive:7",
            "thread:INBOX:abc",
            "email_folders",
          ].values(),
        );

      service.clearFolderCache("INBOX");

      expect(mockCache.delete).toHaveBeenCalledTimes(3);
      expect(mockCache.delete).toHaveBeenCalledWith(
        'email_search:{"folder":"INBOX","limit":10}',
      );
      expect(mockCache.delete).toHaveBeenCalledWith("email:INBOX:42");
      expect(mockCache.delete).toHaveBeenCalledWith("thread:INBOX:abc");
    });

    it("should skip clearing when cache has no keys() method", () => {
      // Older cache implementations predate keys(); clearFolderCache checks
      // for it rather than assuming it exists.
      (mockCache as { keys?: LocalCache["keys"] }).keys = undefined;

      expect(() => service.clearFolderCache("INBOX")).not.toThrow();
      expect(mockCache.delete).not.toHaveBeenCalled();
    });
  });

  describe("delegation methods", () => {
    describe("getPoolMetrics", () => {
      it("should delegate to pool.getImapMetrics()", () => {
        const metrics = {
          folderDistribution: { INBOX: 2 },
          circuitBreakerState: "closed" as const,
        };
        mockPool.getImapMetrics.mockReturnValue(metrics);

        const result = service.getPoolMetrics();

        expect(result).toEqual(metrics);
        expect(mockPool.getImapMetrics).toHaveBeenCalledTimes(1);
      });
    });
  });

  // PHASE 2: Core IMAP Operations
  describe("moveEmail", () => {
    it("should move email successfully", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);
      mockPool.invalidateFolderConnections.mockResolvedValue(undefined);

      const result = await service.moveEmail(123, "INBOX", "Archive");

      expect(result.success).toBe(true);
      expect(result.message).toContain("moved from INBOX to Archive");
      expect(mockWrapper.connection.messageMove).toHaveBeenCalledWith(
        "123:123",
        "Archive",
        { uid: true },
      );
      expect(mockPool.invalidateFolderConnections).toHaveBeenCalledWith(
        "INBOX",
      );
      expect(mockPool.invalidateFolderConnections).toHaveBeenCalledWith(
        "Archive",
      );
    });

    it("should clear cache for both source and destination folders", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);

      // Spy on clearFolderCache
      const clearSpy = vi.spyOn(service, "clearFolderCache");

      await service.moveEmail(123, "INBOX", "Archive");

      expect(clearSpy).toHaveBeenCalledWith("INBOX");
      expect(clearSpy).toHaveBeenCalledWith("Archive");
    });

    it("should handle move failure and return error result", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageMove = vi
        .fn()
        .mockRejectedValue(new Error("Move failed"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.moveEmail(123, "INBOX", "Archive");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to move email");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should report failure when the server refuses the move", async () => {
      const mockWrapper = createMockConnectionWrapper();
      // imapflow resolves false on a NO (e.g. missing destination folder)
      mockWrapper.connection.messageMove = vi.fn().mockResolvedValue(false);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);
      const clearSpy = vi.spyOn(service, "clearFolderCache");

      const result = await service.moveEmail(123, "INBOX", "NoSuchFolder");

      expect(result.success).toBe(false);
      expect(result.message).toContain("NoSuchFolder");
      expect(clearSpy).not.toHaveBeenCalled();
      expect(mockPool.releaseFromFolder).toHaveBeenCalledWith(mockWrapper);
    });

    it("should release connection even on error", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageMove = vi
        .fn()
        .mockRejectedValue(new Error("Move failed"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      await service.moveEmail(123, "INBOX", "Archive");

      expect(mockPool.releaseFromFolder).toHaveBeenCalledWith(mockWrapper);
    });
  });

  describe("getEmailThread", () => {
    const ROOT_ID = "<root@example.com>";

    const threadEnvelope = (
      uid: number,
      messageId: string,
      date: string,
      subject: string,
    ) => ({
      uid,
      flags: new Set<string>(),
      envelope: {
        messageId,
        subject,
        from: [{ name: "Alice", address: "alice@example.com" }],
        to: [{ name: "Bob", address: "bob@example.com" }],
        date: new Date(date),
      },
    });

    it("should match the message and its replies by header", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.search = vi.fn().mockResolvedValue([1, 2]);
      mockWrapper.connection.fetch = vi
        .fn()
        .mockImplementation(async function* () {
          // IMAP returns the reply first to prove the thread gets sorted
          yield threadEnvelope(
            2,
            "<reply@example.com>",
            "2026-09-15T12:00:00Z",
            "Re: Root subject",
          );
          yield threadEnvelope(
            1,
            ROOT_ID,
            "2026-09-15T10:00:00Z",
            "Root subject",
          );
        });
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const thread = await service.getEmailThread(ROOT_ID, "INBOX");

      expect(mockWrapper.connection.search).toHaveBeenCalledWith(
        {
          or: [
            { header: { "message-id": ROOT_ID } },
            { header: { references: ROOT_ID } },
            { header: { "in-reply-to": ROOT_ID } },
          ],
        },
        { uid: true },
      );
      expect(thread?.messages.map(m => m.uid)).toEqual([1, 2]);
      expect(thread?.subject).toBe("Root subject");
      expect(thread?.lastActivity).toEqual(new Date("2026-09-15T12:00:00Z"));
      expect(thread?.participants).toEqual([
        { name: "Alice", address: "alice@example.com" },
        { name: "Bob", address: "bob@example.com" },
      ]);
    });

    it("should find the root when the id is passed without angle brackets", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.search = vi.fn().mockResolvedValue([1, 2]);
      mockWrapper.connection.fetch = vi
        .fn()
        .mockImplementation(async function* () {
          // The root is not the oldest here, so a fallback would pick wrong
          yield threadEnvelope(
            2,
            ROOT_ID,
            "2026-09-15T12:00:00Z",
            "Root subject",
          );
          yield threadEnvelope(
            1,
            "<earlier@example.com>",
            "2026-09-15T10:00:00Z",
            "Unrelated earlier subject",
          );
        });
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const thread = await service.getEmailThread("root@example.com", "INBOX");

      expect(thread?.subject).toBe("Root subject");
    });

    it("should return null when no message matches the id", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.search = vi.fn().mockResolvedValue([]);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const thread = await service.getEmailThread(ROOT_ID, "INBOX");

      expect(thread).toBeNull();
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it("should fail, not report 'not found', when the server refuses the search", async () => {
      const mockWrapper = createMockConnectionWrapper();
      // imapflow resolves false on a failed SEARCH instead of throwing
      mockWrapper.connection.search = vi.fn().mockResolvedValue(false);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      await expect(service.getEmailThread(ROOT_ID, "INBOX")).rejects.toThrow(
        "IMAP search failed",
      );
      expect(mockPool.releaseFromFolder).toHaveBeenCalledWith(mockWrapper);
    });

    it("should surface a connection error instead of returning null", async () => {
      mockPool.acquireForFolder.mockRejectedValue(
        new Error("Connection refused"),
      );

      await expect(service.getEmailThread(ROOT_ID, "INBOX")).rejects.toThrow(
        "Connection refused",
      );
    });

    it("should release the connection when the search fails", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.search = vi
        .fn()
        .mockRejectedValue(new Error("Search failed"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      await expect(service.getEmailThread(ROOT_ID, "INBOX")).rejects.toThrow(
        "Search failed",
      );
      expect(mockPool.releaseFromFolder).toHaveBeenCalledWith(mockWrapper);
    });
  });

  describe("searchEmails connection failures", () => {
    it("should surface a connection error instead of an empty result", async () => {
      mockPool.acquireForFolder.mockRejectedValue(
        new Error("Connection refused"),
      );
      (mockCache.getStale as Mock).mockReturnValue(null);

      await expect(service.searchEmails({ query: "invoice" })).rejects.toThrow(
        "Connection refused",
      );
    });

    it("should serve the stale copy when the connection fails", async () => {
      const stale = [{ uid: 1, subject: "cached" }];
      mockPool.acquireForFolder.mockRejectedValue(
        new Error("Connection refused"),
      );
      (mockCache.getStale as Mock).mockReturnValue(stale);

      await expect(service.searchEmails({ query: "invoice" })).resolves.toBe(
        stale,
      );
    });
  });

  describe("markEmail", () => {
    it("should add flags successfully", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.markEmail(123, "INBOX", ["\\Seen"], "add");

      expect(result.success).toBe(true);
      expect(mockWrapper.connection.messageFlagsAdd).toHaveBeenCalledWith(
        "123:123",
        ["\\Seen"],
        { uid: true },
      );
    });

    it("should remove flags successfully", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.markEmail(
        123,
        "INBOX",
        ["\\Flagged"],
        "remove",
      );

      expect(result.success).toBe(true);
      expect(mockWrapper.connection.messageFlagsRemove).toHaveBeenCalledWith(
        "123:123",
        ["\\Flagged"],
        { uid: true },
      );
    });

    it("should clear cache after flag change", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);

      const clearSpy = vi.spyOn(service, "clearFolderCache");

      await service.markEmail(123, "INBOX", ["\\Seen"], "add");

      expect(clearSpy).toHaveBeenCalledWith("INBOX");
    });

    it("should handle errors gracefully", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageFlagsAdd = vi
        .fn()
        .mockRejectedValue(new Error("Flag operation failed"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.markEmail(123, "INBOX", ["\\Seen"], "add");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to mark email");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it.each([
      ["add", "messageFlagsAdd"],
      ["remove", "messageFlagsRemove"],
    ] as const)("should report failure when the server refuses to %s flags", async (action, method) => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection[method] = vi.fn().mockResolvedValue(false);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.markEmail(123, "INBOX", ["\\Seen"], action);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to mark email");
    });

    it("should handle multiple flags at once", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      await service.markEmail(
        123,
        "INBOX",
        ["\\Seen", "\\Flagged", "\\Important"],
        "add",
      );

      expect(mockWrapper.connection.messageFlagsAdd).toHaveBeenCalledWith(
        "123:123",
        ["\\Seen", "\\Flagged", "\\Important"],
        { uid: true },
      );
    });
  });

  describe("deleteEmail", () => {
    it("should permanently delete (flag and expunge) the email", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", true);

      expect(result.success).toBe(true);
      expect(result.message).toBe("Email permanently deleted");
      // messageDelete sets \Deleted and expunges; flagging alone left the
      // message in the folder.
      expect(mockWrapper.connection.messageDelete).toHaveBeenCalledWith(
        "123:123",
        { uid: true },
      );
    });

    it("should refuse a permanent delete when the server lacks UIDPLUS", async () => {
      const mockWrapper = createMockConnectionWrapper();
      // Without UIDPLUS imapflow falls back to a plain EXPUNGE, which removes
      // every message flagged \\Deleted in the folder, not just this one.
      mockWrapper.connection.capabilities = new Map([["IMAP4rev1", true]]);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", true);

      expect(result.success).toBe(false);
      expect(result.message).toContain(
        "server does not support UIDPLUS; cannot permanently delete a single message safely",
      );
      expect(mockWrapper.connection.messageDelete).not.toHaveBeenCalled();
      expect(mockPool.releaseFromFolder).toHaveBeenCalledWith(mockWrapper);
    });

    it("should permanently delete when the server advertises UIDPLUS", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.capabilities = new Map([
        ["IMAP4rev1", true],
        ["UIDPLUS", true],
      ]);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", true);

      expect(result.success).toBe(true);
      expect(mockWrapper.connection.messageDelete).toHaveBeenCalledWith(
        "123:123",
        { uid: true },
      );
    });

    it("should report failure when the server does not expunge", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageDelete = vi.fn().mockResolvedValue(false);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", true);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to delete email");
      expect(mockCache.delete).not.toHaveBeenCalled();
    });

    const folder = (path: string, specialUse?: string): EmailFolder => ({
      name: path.split("/").pop() ?? path,
      path,
      delimiter: "/",
      flags: [],
      specialUse,
    });

    const withCachedFolders = (folders: EmailFolder[]) => {
      (mockCache.get as Mock).mockImplementation((key: string) =>
        key === "email_folders" ? folders : null,
      );
    };

    it("should prefer the folder the server marks as \\Trash", async () => {
      withCachedFolders([
        folder("INBOX"),
        folder("Trash"),
        folder("Papierkorb", "\\Trash"),
      ]);
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Email moved to trash folder "Papierkorb"');
      expect(mockWrapper.connection.messageMove).toHaveBeenCalledTimes(1);
      expect(mockWrapper.connection.messageMove).toHaveBeenCalledWith(
        "123:123",
        "Papierkorb",
        { uid: true },
      );
    });

    it("should fall back to the common names when the special-use folder refuses", async () => {
      withCachedFolders([folder("Bin", "\\Trash")]);
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageMove = vi
        .fn()
        .mockResolvedValueOnce(false) // "Bin"
        .mockResolvedValueOnce({ uidMap: new Map() }); // "Trash"
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.message).toBe('Email moved to trash folder "Trash"');
    });

    it("should fall back to the common names when the folder list is unavailable", async () => {
      mockPool.acquire.mockRejectedValue(new Error("Connection refused"));
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Email moved to trash folder "Trash"');
    });

    it.each([
      [
        "the special-use trash folder",
        [folder("Papierkorb", "\\Trash")],
        "Papierkorb",
      ],
      ["a common trash name when none is marked", [folder("INBOX")], "Trash"],
    ])("should not move a message that is already in %s", async (_label, folders, source) => {
      withCachedFolders(folders);
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, source, false);

      expect(result.success).toBe(false);
      expect(result.message).toContain("already in the trash");
      expect(result.message).toContain("permanent: true");
      expect(mockWrapper.connection.messageMove).not.toHaveBeenCalled();
      expect(mockWrapper.connection.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it("should move to Trash folder for soft delete", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Email moved to trash folder "Trash"');
      expect(mockWrapper.connection.messageMove).toHaveBeenCalledWith(
        "123:123",
        "Trash",
        { uid: true },
      );
    });

    it("should not claim a trash move when no trash folder exists", async () => {
      const mockWrapper = createMockConnectionWrapper();
      // messageMove resolves false for a missing mailbox; it does not throw
      mockWrapper.connection.messageMove = vi.fn().mockResolvedValue(false);
      mockWrapper.connection.messageFlagsAdd = vi.fn().mockResolvedValue(true);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(true);
      expect(result.message).toBe(
        "Email marked as deleted: no trash folder found",
      );
      expect(mockWrapper.connection.messageMove).toHaveBeenCalledTimes(4);
      expect(mockWrapper.connection.messageFlagsAdd).toHaveBeenCalledWith(
        "123:123",
        ["\\Deleted"],
        { uid: true },
      );
    });

    it("should report failure when no trash exists and flagging is refused", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageMove = vi.fn().mockResolvedValue(false);
      mockWrapper.connection.messageFlagsAdd = vi.fn().mockResolvedValue(false);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to delete email");
    });

    it("should report failure when the move throws", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageMove = vi
        .fn()
        .mockRejectedValue(new Error("Connection lost"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Connection lost");
      expect(mockWrapper.connection.messageFlagsAdd).not.toHaveBeenCalled();
    });

    it("should try alternative trash folder names if Trash doesn't exist", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageMove = vi
        .fn()
        .mockResolvedValueOnce(false) // "Trash" does not exist
        .mockResolvedValueOnce({ uidMap: new Map() }); // "Deleted Items" does

      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(true);
      expect(mockWrapper.connection.messageMove).toHaveBeenCalledTimes(2);
      expect(mockWrapper.connection.messageMove).toHaveBeenNthCalledWith(
        1,
        "123:123",
        "Trash",
        { uid: true },
      );
      expect(mockWrapper.connection.messageMove).toHaveBeenNthCalledWith(
        2,
        "123:123",
        "Deleted Items",
        { uid: true },
      );
    });

    it("should mark as deleted if no trash folder found", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageMove = vi.fn().mockResolvedValue(false);

      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", false);

      expect(result.success).toBe(true);
      // Should have tried: Trash, Deleted Items, Deleted, INBOX.Trash (4 attempts)
      // Then add \\Deleted flag as fallback
      expect(mockWrapper.connection.messageFlagsAdd).toHaveBeenCalledWith(
        "123:123",
        ["\\Deleted"],
        { uid: true },
      );
    });

    it("should clear cache after deletion", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);

      const clearSpy = vi.spyOn(service, "clearFolderCache");

      await service.deleteEmail(123, "INBOX", true);

      expect(clearSpy).toHaveBeenCalledWith("INBOX");
    });

    it("should handle errors and return failure result", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.messageDelete = vi
        .fn()
        .mockRejectedValue(new Error("Delete failed"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.deleteEmail(123, "INBOX", true);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to delete email");
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("createDraft", () => {
    it("should report failure when the server refuses the append", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi.fn().mockResolvedValue(false);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const result = await service.createDraft({
        to: [{ address: "recipient@example.com" }],
        subject: "Draft",
        text: "Body",
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to create draft");
    });

    it("should log the shape of a failed draft, not its content", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi.fn().mockResolvedValue(false);
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      await service.createDraft({
        to: [{ address: "secret-recipient@example.com" }],
        subject: "Secret subject",
        text: "Secret body",
      });

      const logged = JSON.stringify(mockLogger.error.mock.calls);
      expect(logged).not.toContain("Secret");
      expect(logged).not.toContain("secret-recipient");
      expect(logged).toContain('"recipients":1');
    });

    it("should create draft with plain text in default Drafts folder", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi.fn().mockResolvedValue({ uid: 456 });
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const composition: EmailComposition = {
        to: [{ address: "recipient@example.com" }],
        subject: "Draft Subject",
        text: "Draft content",
      };

      const result = await service.createDraft(composition);

      expect(result.success).toBe(true);
      expect(result.uid).toBe(456);
      const appendCall = vi.mocked(mockWrapper.connection.append).mock.calls[0];
      expect(appendCall[0]).toBe("Drafts");
      expect(String(appendCall[1])).toContain("Draft Subject");
      expect(String(appendCall[1])).toContain("Draft content");
      expect(appendCall[2]).toEqual(["\\Draft"]);
    });

    it("should create draft with HTML content", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi.fn().mockResolvedValue({ uid: 456 });
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const composition: EmailComposition = {
        to: [{ address: "recipient@example.com" }],
        subject: "Draft Subject",
        html: "<p>HTML content</p>",
      };

      const result = await service.createDraft(composition);

      expect(result.success).toBe(true);
      const appendCall = vi.mocked(mockWrapper.connection.append).mock.calls[0];
      expect(String(appendCall[1])).toContain("Content-Type: text/html");
      expect(String(appendCall[1])).toContain("<p>HTML content</p>");
    });

    it("should create draft in custom folder", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi.fn().mockResolvedValue({ uid: 456 });
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const composition: EmailComposition = {
        to: [{ address: "recipient@example.com" }],
        subject: "Draft Subject",
        text: "Draft content",
      };

      await service.createDraft(composition, "Custom Drafts");

      const appendCall = vi.mocked(mockWrapper.connection.append).mock.calls[0];
      expect(appendCall[0]).toBe("Custom Drafts");
      expect(appendCall[2]).toEqual(["\\Draft"]);
    });

    it("should include CC and BCC recipients", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi.fn().mockResolvedValue({ uid: 456 });
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const composition: EmailComposition = {
        to: [{ address: "to@example.com" }],
        cc: [{ address: "cc@example.com" }],
        bcc: [{ address: "bcc@example.com" }],
        subject: "Draft Subject",
        text: "Draft content",
      };

      await service.createDraft(composition);

      const appendCall = vi.mocked(mockWrapper.connection.append).mock.calls[0];
      expect(String(appendCall[1])).toMatch(/^Cc: cc@example\.com\r$/im);
      expect(String(appendCall[1])).toMatch(/^Bcc: bcc@example\.com\r$/im);
    });

    it("should clear cache after creating draft", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi.fn().mockResolvedValue({ uid: 456 });
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);

      const clearSpy = vi.spyOn(service, "clearFolderCache");

      const composition: EmailComposition = {
        to: [{ address: "recipient@example.com" }],
        subject: "Draft Subject",
        text: "Draft content",
      };

      await service.createDraft(composition);

      expect(clearSpy).toHaveBeenCalledWith("Drafts");
    });

    it("should handle errors gracefully", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi
        .fn()
        .mockRejectedValue(new Error("Append failed"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const composition: EmailComposition = {
        to: [{ address: "recipient@example.com" }],
        subject: "Draft Subject",
        text: "Draft content",
      };

      const result = await service.createDraft(composition);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to create draft");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should release connection even on error", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.append = vi
        .fn()
        .mockRejectedValue(new Error("Append failed"));
      mockPool.acquireForFolder.mockResolvedValue(mockWrapper);
      mockPool.releaseFromFolder.mockResolvedValue(undefined);

      const composition: EmailComposition = {
        to: [{ address: "recipient@example.com" }],
        subject: "Draft Subject",
        text: "Draft content",
      };

      await service.createDraft(composition);

      expect(mockPool.releaseFromFolder).toHaveBeenCalledWith(mockWrapper);
    });
  });

  // PHASE 3: Folder & Cache Management
  describe("getFolders", () => {
    it("should return cached folders when available", async () => {
      const cachedFolders: EmailFolder[] = [
        { name: "INBOX", path: "INBOX", delimiter: "/", flags: [] },
      ];
      const mockGet = vi.fn().mockReturnValue(cachedFolders);
      mockCache.get = mockGet;

      const result = await service.getFolders();

      expect(result).toEqual(cachedFolders);
      expect(mockGet).toHaveBeenCalledWith("email_folders");
      expect(mockPool.acquire).not.toHaveBeenCalled();
    });

    it("should fetch folders from IMAP when not cached", async () => {
      const mockGet = vi.fn().mockReturnValue(null);
      const mockSet = vi.fn();
      mockCache.get = mockGet;
      mockCache.set = mockSet;

      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.list = vi.fn().mockResolvedValue([
        {
          name: "INBOX",
          path: "INBOX",
          delimiter: "/",
          flags: ["\\NoSelect"],
          specialUse: undefined,
        },
        {
          name: "Sent",
          path: "Sent",
          delimiter: "/",
          flags: [],
          specialUse: "\\Sent",
        },
      ]);
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const result = await service.getFolders();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe("INBOX");
      expect(result[1].name).toBe("Sent");
      expect(mockSet).toHaveBeenCalledWith("email_folders", result, 900000);
    });

    it("should handle non-array flags gracefully", async () => {
      const mockGet = vi.fn().mockReturnValue(null);
      const mockSet = vi.fn();
      const mockGetStale = vi.fn().mockReturnValue(null);
      mockCache.get = mockGet;
      mockCache.set = mockSet;
      mockCache.getStale = mockGetStale;

      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.list = vi.fn().mockResolvedValue([
        {
          name: "INBOX",
          path: "INBOX",
          delimiter: "/",
          flags: "not-an-array", // Invalid flags
        },
      ]);
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const result = await service.getFolders();

      expect(result[0].flags).toEqual([]);
    });

    it("should use default delimiter when none provided", async () => {
      const mockGet = vi.fn().mockReturnValue(null);
      const mockSet = vi.fn();
      const mockGetStale = vi.fn().mockReturnValue(null);
      mockCache.get = mockGet;
      mockCache.set = mockSet;
      mockCache.getStale = mockGetStale;

      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.list = vi.fn().mockResolvedValue([
        {
          name: "INBOX",
          path: "INBOX",
          delimiter: null,
        },
      ]);
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const result = await service.getFolders();

      expect(result[0].delimiter).toBe("/");
    });

    it("should return stale cache on connection error", async () => {
      const mockGet = vi.fn().mockReturnValue(null);
      mockCache.get = mockGet;

      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.list = vi
        .fn()
        .mockRejectedValue(new Error("Connection timeout"));
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const staleFolders: EmailFolder[] = [
        { name: "INBOX", path: "INBOX", delimiter: "/", flags: [] },
      ];
      const mockGetStale = vi.fn().mockReturnValue(staleFolders);
      mockCache.getStale = mockGetStale;

      const result = await service.getFolders();

      expect(result).toEqual(staleFolders);
      expect(mockLogger.warning).toHaveBeenCalledWith(
        "Returning stale cached data due to connection failure",
        expect.any(Object),
      );
    });

    it("should surface a connection error without cache instead of guessing folders", async () => {
      const mockGet = vi.fn().mockReturnValue(null);
      mockCache.get = mockGet;

      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.list = vi
        .fn()
        .mockRejectedValue(new Error("Connection timeout"));
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const mockGetStale = vi.fn().mockReturnValue(null);
      mockCache.getStale = mockGetStale;

      // A made-up INBOX/Sent/Drafts/Trash list would read as the real one.
      await expect(service.getFolders()).rejects.toThrow("Connection timeout");
      expect(mockPool.release).toHaveBeenCalledWith(mockWrapper);
    });

    it("should throw non-connection errors", async () => {
      const mockGet = vi.fn().mockReturnValue(null);
      mockCache.get = mockGet;

      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.list = vi
        .fn()
        .mockRejectedValue(new Error("Invalid credentials"));
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const mockGetStale = vi.fn().mockReturnValue(null);
      mockCache.getStale = mockGetStale;

      await expect(service.getFolders()).rejects.toThrow("Invalid credentials");
    });

    it("should release connection even on error", async () => {
      const mockGet = vi.fn().mockReturnValue(null);
      mockCache.get = mockGet;

      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.list = vi
        .fn()
        .mockRejectedValue(new Error("Invalid credentials"));
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const mockGetStale = vi.fn().mockReturnValue(null);
      mockCache.getStale = mockGetStale;

      try {
        await service.getFolders();
      } catch (_error) {
        // Expected
      }

      expect(mockPool.release).toHaveBeenCalledWith(mockWrapper);
    });
  });

  describe("createDirectory", () => {
    it("should create top-level folder", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const result = await service.createDirectory("NewFolder");

      expect(result.success).toBe(true);
      expect(result.message).toContain("NewFolder");
      expect(mockWrapper.connection.mailboxCreate).toHaveBeenCalledWith(
        "NewFolder",
      );
    });

    it("should not report success when the folder already exists", async () => {
      const mockWrapper = createMockConnectionWrapper();
      // imapflow answers ALREADYEXISTS with created: false, not a throw
      mockWrapper.connection.mailboxCreate = vi
        .fn()
        .mockResolvedValue({ path: "Existing", created: false });
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const result = await service.createDirectory("Existing");

      expect(result.success).toBe(false);
      expect(result.message).toContain("already exists");
    });

    it("should drop the cached folder list so get_folders shows the new folder", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      await service.createDirectory("NewFolder");

      expect(mockCache.delete).toHaveBeenCalledWith("email_folders");
    });

    it("should keep the cached folder list when creation fails", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.mailboxCreate = vi
        .fn()
        .mockRejectedValue(new Error("NO [CANNOT] invalid name"));
      mockPool.acquire.mockResolvedValue(mockWrapper);

      await service.createDirectory("Bad");

      expect(mockCache.delete).not.toHaveBeenCalled();
    });

    it("should create nested folder with parent path", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const result = await service.createDirectory("SubFolder", "INBOX");

      expect(result.success).toBe(true);
      // Passed as parts so imapflow joins them with the server's delimiter.
      expect(mockWrapper.connection.mailboxCreate).toHaveBeenCalledWith([
        "INBOX",
        "SubFolder",
      ]);
    });

    it("should leave the delimiter to the server", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      await service.createDirectory("SubFolder", "Parent/Nested");

      expect(mockWrapper.connection.mailboxCreate).toHaveBeenCalledWith([
        "Parent/Nested",
        "SubFolder",
      ]);
    });

    it("should handle errors gracefully", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.mailboxCreate = vi
        .fn()
        .mockRejectedValue(new Error("Folder already exists"));
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      const result = await service.createDirectory("Existing");

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to create directory");
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it("should release connection even on error", async () => {
      const mockWrapper = createMockConnectionWrapper();
      mockWrapper.connection.mailboxCreate = vi
        .fn()
        .mockRejectedValue(new Error("Folder already exists"));
      mockPool.acquire.mockResolvedValue(mockWrapper);
      mockPool.release.mockResolvedValue(undefined);

      await service.createDirectory("Existing");

      expect(mockPool.release).toHaveBeenCalledWith(mockWrapper);
    });
  });

  describe("parseAddressesFromParsed - branch coverage", () => {
    it.each([
      ["null addresses", null, []],
      ["undefined addresses", undefined, []],
      [
        "address object with several entries",
        {
          value: [
            { name: "Alice Brown", address: "alice@example.com" },
            { name: "Bob Wilson", address: "bob@example.com" },
          ],
        },
        [
          { name: "Alice Brown", address: "alice@example.com" },
          { name: "Bob Wilson", address: "bob@example.com" },
        ],
      ],
      [
        "array of address objects",
        [
          { value: [{ name: "Alice Brown", address: "alice@example.com" }] },
          { value: [{ name: "", address: "bob@example.com" }] },
        ],
        [
          { name: "Alice Brown", address: "alice@example.com" },
          { name: undefined, address: "bob@example.com" },
        ],
      ],
      [
        "entry without name",
        { value: [{ name: "", address: "alice@example.com" }] },
        [{ name: undefined, address: "alice@example.com" }],
      ],
      [
        "group entry",
        {
          value: [
            {
              name: "Team",
              group: [{ name: "", address: "carla@example.com" }],
            },
          ],
        },
        [{ name: undefined, address: "carla@example.com" }],
      ],
      ["entry without address field", { value: [{ name: "Alice Brown" }] }, []],
      ["address object with empty value", { value: [] }, []],
      ["empty array", [], []],
    ])("should parse %s", (_description: string, input: unknown, expected: Array<{
      name?: string;
      address: string;
    }>) => {
      const testableService = service as TestableEmailService;
      const result = testableService.parseAddressesFromParsed(input);
      expect(result).toEqual(expected);
    });
  });
  describe("getEmail fetch failures", () => {
    const rawMessage = {
      uid: 7,
      envelope: { messageId: "<m7@example.com>", subject: "Hi" },
      flags: new Set<string>(),
      source: Buffer.from(
        "From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n\r\nBody\r\n",
      ),
    };

    const wrapperWithFetchOne = (fetchOne: Mock) =>
      createMockConnectionWrapper({
        connection: { fetchOne } as unknown as ImapFlow,
        isHealthy: true,
      } as Partial<ImapConnectionWrapper>);

    afterEach(() => {
      vi.useRealTimers();
    });

    it("surfaces a fetch timeout as an error and retires the connection", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const wrapper = wrapperWithFetchOne(
        vi.fn().mockReturnValue(new Promise(() => {})),
      );
      mockPool.acquireForFolder.mockResolvedValue(wrapper);

      const assertion = expect(service.getEmail(7, "INBOX")).rejects.toThrow(
        /timed out/,
      );
      await vi.advanceTimersByTimeAsync(10000);
      await assertion;

      expect(wrapper.isHealthy).toBe(false);
      expect(mockPool.releaseFromFolder).toHaveBeenCalledWith(wrapper);
    });

    it("surfaces a server NO response as an error, not as a missing email", async () => {
      const wrapper = wrapperWithFetchOne(
        vi.fn().mockRejectedValue(new Error("Command failed: NO [SERVERBUG]")),
      );
      mockPool.acquireForFolder.mockResolvedValue(wrapper);

      await expect(service.getEmail(7, "INBOX")).rejects.toThrow(
        /Command failed/,
      );
      expect(wrapper.isHealthy).toBe(false);
    });

    it("returns stale cached data when the fetch times out", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const stale = { uid: 7, subject: "stale copy" };
      (mockCache.getStale as Mock).mockReturnValue(stale);
      const wrapper = wrapperWithFetchOne(
        vi.fn().mockReturnValue(new Promise(() => {})),
      );
      mockPool.acquireForFolder.mockResolvedValue(wrapper);

      const result = service.getEmail(7, "INBOX");
      await vi.advanceTimersByTimeAsync(10000);

      await expect(result).resolves.toBe(stale);
      expect(mockCache.getStale).toHaveBeenCalledWith("email:INBOX:7");
    });

    it("surfaces an unselected folder (undefined) as an error, not as a missing email", async () => {
      const wrapper = wrapperWithFetchOne(vi.fn().mockResolvedValue(undefined));
      mockPool.acquireForFolder.mockResolvedValue(wrapper);

      await expect(service.getEmail(7, "INBOX")).rejects.toThrow(
        /no folder selected/,
      );
    });

    it("returns null only when the server has no such message", async () => {
      const wrapper = wrapperWithFetchOne(vi.fn().mockResolvedValue(false));
      mockPool.acquireForFolder.mockResolvedValue(wrapper);

      await expect(service.getEmail(7, "INBOX")).resolves.toBeNull();
      expect(wrapper.isHealthy).toBe(true);
    });

    it("clears the fetch timeout after a successful fetch", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const wrapper = wrapperWithFetchOne(
        vi.fn().mockResolvedValue(rawMessage),
      );
      mockPool.acquireForFolder.mockResolvedValue(wrapper);

      const email = await service.getEmail(7, "INBOX");

      expect(email?.subject).toBe("Hi");
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
