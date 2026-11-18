import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
      process.env.MAILBOX_PASSWORD = "TestPass123!";

      const config = loadConfig();

      expect(config.email.user).toBe("test@mailbox.org");
      expect(config.email.password).toBe("TestPass123!");
      expect(config.email.host).toBe("imap.mailbox.org");
      expect(config.email.port).toBe(993);
      expect(config.email.secure).toBe(true);
    });

    it("should use default values when optional environment variables are not set", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
      process.env.MAILBOX_CALDAV_URL = undefined;
      process.env.MAILBOX_IMAP_HOST = undefined;
      process.env.DEBUG = undefined;

      const config = loadConfig();

      expect(config.email.host).toBe("imap.mailbox.org");
      expect(config.calendar.baseUrl).toBe("https://dav.mailbox.org/");
      expect(config.cache.email.searchTtl).toBe(300000);
      expect(config.debug).toBe(false);
    });

    it("should connect SMTP on demand instead of keeping a transporter warm", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";

      const config = loadConfig();

      expect(config.pools.smtp.minConnections).toBe(0);
      expect(config.pools.imap.minConnections).toBe(1);
    });

    it("should override defaults with environment variables", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
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
      process.env.MAILBOX_EMAIL = undefined;
      process.env.MAILBOX_PASSWORD = undefined;

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });

    it("should throw error when MAILBOX_PASSWORD is missing", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = undefined;

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });

    it("should parse calendar list from environment", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
      process.env.MAILBOX_CALENDARS = "personal,work,family";

      const config = loadConfig();

      expect(config.calendar.calendars).toEqual(["personal", "work", "family"]);
    });

    it("should handle empty calendar list", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";

      const config = loadConfig();

      expect(config.calendar.calendars).toBeUndefined();
    });

    it("should validate email format", () => {
      process.env.MAILBOX_EMAIL = "invalid-email";
      process.env.MAILBOX_PASSWORD = "TestPass123!";

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });

    it("should validate port numbers", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
      process.env.MAILBOX_IMAP_PORT = "70000"; // Invalid port > 65535

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });

    it("should validate boolean values", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
      process.env.DEBUG = "maybe"; // Invalid boolean

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });

    it("should validate URL format", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
      process.env.MAILBOX_CALDAV_URL = "not-a-url";

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });

    it("should validate minimum values for cache settings", () => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
      process.env.CACHE_MAX_SIZE = "0"; // Must be >= 1

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });
  });

  describe("transport configuration", () => {
    const validToken = "a".repeat(64);

    beforeEach(() => {
      process.env.MAILBOX_EMAIL = "test@mailbox.org";
      process.env.MAILBOX_PASSWORD = "TestPass123!";
      process.env.MCP_TRANSPORT = undefined;
      process.env.MCP_AUTH_TOKEN = undefined;
      process.env.PORT = undefined;
    });

    it("should default to stdio transport on port 8080 without a token", () => {
      const config = loadConfig();

      expect(config.transport.mode).toBe("stdio");
      expect(config.transport.port).toBe(8080);
      expect(config.transport.authToken).toBeUndefined();
    });

    it("should enable http transport when MCP_TRANSPORT is http", () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = validToken;
      process.env.PORT = "9090";

      const config = loadConfig();

      expect(config.transport.mode).toBe("http");
      expect(config.transport.port).toBe(9090);
      expect(config.transport.authToken).toBe(validToken);
    });

    it("should reject http transport without an auth token", () => {
      process.env.MCP_TRANSPORT = "http";

      expect(() => loadConfig()).toThrow("MCP_AUTH_TOKEN");
    });

    it("should reject http transport with a too-short auth token", () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "short-token";

      expect(() => loadConfig()).toThrow(
        "requires a token of at least 32 characters",
      );
    });

    it("should not echo the auth token in a validation error", () => {
      process.env.MCP_TRANSPORT = "http";
      process.env.MCP_AUTH_TOKEN = "short-secret-value";

      expect(() => loadConfig()).not.toThrow("short-secret-value");
    });

    it("should not require an auth token in stdio mode", () => {
      process.env.MCP_TRANSPORT = "stdio";

      expect(() => loadConfig()).not.toThrow();
    });

    it("should validate unknown transport modes", () => {
      process.env.MCP_TRANSPORT = "carrier-pigeon";

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });

    it("should validate the port range", () => {
      process.env.PORT = "70000";

      expect(() => loadConfig()).toThrow("Configuration validation failed:");
    });
  });
});
