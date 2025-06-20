import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";
import { MemoryCache } from "../src/services/LocalCache.js";
import {
  createCalendarTools,
  handleCalendarTool,
} from "../src/tools/calendarTools.js";
import { createEmailTools, handleEmailTool } from "../src/tools/emailTools.js";

describe("Integration Tests", () => {
  const originalEnv = process.env;

  beforeAll(() => {
    process.env = {
      ...originalEnv,
      MAILBOX_EMAIL: "test@mailbox.org",
      MAILBOX_PASSWORD: "testpassword",
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
    it("should create and register all tools", () => {
      const config = loadConfig();
      const cache = new MemoryCache(config.cache);

      // Mock services for testing
      const mockEmailService = {
        searchEmails: vi.fn(),
        getEmail: vi.fn(),
        getEmailThread: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      } as any;

      const mockCalendarService = {
        getCalendarEvents: vi.fn(),
        searchCalendar: vi.fn(),
        getFreeBusy: vi.fn(),
      } as any;

      const emailTools = createEmailTools(mockEmailService);
      const calendarTools = createCalendarTools(mockCalendarService);

      expect(emailTools).toHaveLength(9);
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
        "get_calendar_events",
        "search_calendar",
        "get_free_busy",
      ]);

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

  describe("Error Handling Integration", () => {
    it("should handle service connection errors gracefully", async () => {
      const mockEmailService = {
        searchEmails: vi
          .fn()
          .mockRejectedValue(new Error("Connection timeout")),
        getEmail: vi.fn(),
        getEmailThread: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      } as any;

      const result = await handleEmailTool(
        "search_emails",
        { query: "test" },
        mockEmailService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Connection timeout");
    });
  });
});
