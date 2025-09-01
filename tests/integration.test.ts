import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { CalendarService } from "../src/services/CalendarService.js";
import { EmailService } from "../src/services/EmailService.js";
import { MemoryCache } from "../src/services/LocalCache.js";
import { createCalendarTools } from "../src/tools/calendarTools.js";
import { createEmailTools } from "../src/tools/emailTools.js";

// Mock external libraries for integration tests only
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([1, 2, 3]),
    fetch: vi.fn().mockResolvedValue([
      {
        uid: 1,
        envelope: {
          subject: "Test Email 1",
          from: [{ name: "Test Sender", address: "test@example.com" }],
          to: [{ name: "Test Recipient", address: "recipient@example.com" }],
          date: new Date("2024-01-01T10:00:00Z"),
        },
        source: Buffer.from("Test email content"),
      },
    ]),
    mailboxOpen: vi.fn().mockResolvedValue({
      path: "INBOX",
      uidValidity: 1,
      uidNext: 100,
      exists: 10,
      recent: 0,
    }),
    noop: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    usable: true,
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    emit: vi.fn().mockReturnValue(true),
    addListener: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    removeAllListeners: vi.fn().mockReturnThis(),
    listeners: vi.fn().mockReturnValue([]),
    listenerCount: vi.fn().mockReturnValue(0),
    eventNames: vi.fn().mockReturnValue([]),
    getMaxListeners: vi.fn().mockReturnValue(10),
    setMaxListeners: vi.fn().mockReturnThis(),
    prependListener: vi.fn().mockReturnThis(),
    prependOnceListener: vi.fn().mockReturnThis(),
    rawListeners: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock("tsdav", () => ({
  createDAVClient: vi.fn().mockResolvedValue({
    fetchCalendars: vi.fn().mockResolvedValue([
      {
        url: "https://mailbox.org/caldav/calendar1/",
        displayName: "Personal Calendar",
        components: ["VEVENT"],
      },
    ]),
    fetchCalendarObjects: vi.fn().mockResolvedValue([
      {
        data: `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:event1@example.com
DTSTART:20240101T100000Z
DTEND:20240101T110000Z
SUMMARY:Test Event 1
END:VEVENT
END:VCALENDAR`,
      },
    ]),
  }),
}));

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn().mockReturnValue({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi.fn().mockResolvedValue({
        messageId: "test-message-id@example.com",
        accepted: ["recipient@example.com"],
      }),
      close: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

describe("Integration Tests", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = {
      ...originalEnv,
      MAILBOX_EMAIL: "test@mailbox.org",
      MAILBOX_PASSWORD: "TestPass123!",
      CACHE_EMAIL_SEARCH_TTL: "1000",
      CACHE_CALENDAR_EVENTS_TTL: "2000",
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("Configuration Integration", () => {
    it("should load configuration and create services", () => {
      const config = loadConfig();
      const cache = new MemoryCache(config.cache);

      expect(config.email.user).toBe("test@mailbox.org");
      expect(config.cache.email.searchTtl).toBe(1000);
      expect(cache.size()).toBe(0);

      cache.destroy();
    });
  });

  describe("Tools Registration", () => {
    it("should create and register all tools with real services", async () => {
      const config = loadConfig();
      const cache = new MemoryCache(config.cache);

      // Create real services with mocked libraries
      const emailService = new EmailService(
        config.email,
        cache,
        config.pools.imap,
      );
      const calendarService = new CalendarService(config.calendar, cache);

      const emailTools = createEmailTools(emailService);
      const calendarTools = createCalendarTools(calendarService);

      expect(emailTools).toHaveLength(10);
      expect(calendarTools).toHaveLength(3);

      const allToolNames = [...emailTools, ...calendarTools].map((t) => t.name);
      expect(allToolNames).toEqual([
        "search_emails",
        "get_email",
        "get_email_thread",
        "send_email",
        "create_draft",
        "move_email",
        "mark_email",
        "delete_email",
        "get_folders",
        "create_directory",
        "get_calendar_events",
        "search_calendar",
        "get_free_busy",
      ]);

      await emailService.disconnect();
      cache.destroy();
    });
  });

  describe("Cache Integration", () => {
    it("should integrate cache with tool operations", async () => {
      const config = loadConfig();
      const cache = new MemoryCache(config.cache);

      // Test cache directly since emailService handles caching internally
      cache.set("test-key", "test-data");

      // Verify cache has data
      expect(cache.size()).toBe(1);
      expect(cache.get("test-key")).toBe("test-data");

      cache.destroy();
    });

    it("should respect TTL settings from configuration", async () => {
      const config = loadConfig();
      const cache = new MemoryCache(config.cache);

      cache.set("test-key", "test-data", config.cache.email.searchTtl);

      expect(cache.has("test-key")).toBe(true);

      // Wait for TTL to expire
      await new Promise((resolve) =>
        setTimeout(resolve, config.cache.email.searchTtl + 100),
      );

      expect(cache.has("test-key")).toBe(false);

      cache.destroy();
    });
  });

  describe("Service Integration", () => {
    it("should create email and calendar services without errors", () => {
      const config = loadConfig();
      const cache = new MemoryCache(config.cache);

      // Test service instantiation - this exercises constructor logic
      const emailService = new EmailService(
        config.email,
        cache,
        config.pools.imap,
      );
      const calendarService = new CalendarService(config.calendar, cache);

      expect(emailService).toBeDefined();
      expect(calendarService).toBeDefined();

      cache.destroy();
    });

    it("should properly integrate services with tools", () => {
      const config = loadConfig();
      const cache = new MemoryCache(config.cache);

      const emailService = new EmailService(
        config.email,
        cache,
        config.pools.imap,
      );
      const calendarService = new CalendarService(config.calendar, cache);

      // Test that tools can be created with real services
      const emailTools = createEmailTools(emailService);
      const calendarTools = createCalendarTools(calendarService);

      // Verify tool structure and integration
      expect(
        emailTools.every(
          (tool) => tool.name && tool.description && tool.inputSchema,
        ),
      ).toBe(true);
      expect(
        calendarTools.every(
          (tool) => tool.name && tool.description && tool.inputSchema,
        ),
      ).toBe(true);

      cache.destroy();
    });
  });
});
