import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config/config.js";

describe("Configuration", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("loadConfig", () => {
    it("should load configuration with required environment variables", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "testpassword";

      const config = loadConfig();

      expect(config.email.user).toBe("test@mailbox.org");
      expect(config.email.password).toBe("testpassword");
      expect(config.email.host).toBe("imap.mailbox.org");
      expect(config.email.port).toBe(993);
      expect(config.email.secure).toBe(true);
    });

    it("should use default values when optional environment variables are not set", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "testpassword";
      delete process.env.MAILBOX_CALDAV_URL;
      delete process.env.MAILBOX_IMAP_HOST;
      delete process.env.DEBUG;

      const config = loadConfig();

      expect(config.email.host).toBe("imap.mailbox.org");
      expect(config.calendar.baseUrl).toBe("https://dav.mailbox.org/");
      expect(config.cache.email.searchTtl).toBe(300000);
      expect(config.debug).toBe(false);
    });

    it("should override defaults with environment variables", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "testpassword";
      process.env.MAILBOX_IMAP_HOST = "custom.imap.server";
      process.env.MAILBOX_IMAP_PORT = "143";
      process.env.MAILBOX_IMAP_SECURE = "false";
      process.env.CACHE_EMAIL_SEARCH_TTL = "600000";
      process.env.DEBUG = "true";

      const config = loadConfig();

      expect(config.email.host).toBe("custom.imap.server");
      expect(config.email.port).toBe(143);
      expect(config.email.secure).toBe(false);
      expect(config.cache.email.searchTtl).toBe(600000);
      expect(config.debug).toBe(true);
    });

    it("should throw error when required environment variables are missing", () => {
      delete process.env.MAILBOX_EMAIL;
      delete process.env.MAILBOX_PASSWORD;

      expect(() => loadConfig()).toThrow(
        "Missing required environment variable: MAILBOX_EMAIL",
      );
    });

    it("should throw error when MAILBOX_PASSWORD is missing", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      delete process.env.MAILBOX_PASSWORD;

      expect(() => loadConfig()).toThrow(
        "Missing required environment variable: MAILBOX_PASSWORD",
      );
    });

    it("should parse calendar list from environment", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "testpassword";
      process.env.MAILBOX_CALENDARS = "personal,work,family";

      const config = loadConfig();

      expect(config.calendar.calendars).toEqual(["personal", "work", "family"]);
    });

    it("should handle empty calendar list", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "testpassword";

      const config = loadConfig();

      expect(config.calendar.calendars).toBeUndefined();
    });
  });
});
