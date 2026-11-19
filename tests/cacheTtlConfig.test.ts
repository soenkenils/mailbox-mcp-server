import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPool = {
  acquire: vi.fn(),
  acquireForFolder: vi.fn(async () => ({})),
  release: vi.fn(),
  releaseFromFolder: vi.fn(async () => {}),
  destroy: vi.fn(),
};

vi.mock("../src/services/ImapConnectionPool.js", () => ({
  ImapConnectionPool: vi.fn(function () {
    return mockPool;
  }),
}));

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { CalendarService } from "../src/services/CalendarService.js";
import { EmailService } from "../src/services/EmailService.js";
import type { LocalCache } from "../src/types/cache.types.js";

const set = vi.fn();
const cache = {
  get: vi.fn(() => null),
  getStale: vi.fn(() => null),
  set,
  delete: vi.fn(),
  clear: vi.fn(),
  has: vi.fn(() => false),
  size: vi.fn(() => 0),
  getStats: vi.fn(),
  cleanup: vi.fn(),
  keys: vi.fn(() => new Set<string>().values()),
} as unknown as LocalCache;

const emailTtls = { searchTtl: 11_000, messageTtl: 22_000, threadTtl: 33_000 };
const calendarTtls = { eventsTtl: 44_000, freeBusyTtl: 55_000 };

const ttlFor = (keyPrefix: string) =>
  set.mock.calls.find(([key]) => String(key).startsWith(keyPrefix))?.[2];

describe("configured cache TTLs", () => {
  beforeEach(() => {
    set.mockClear();
  });

  describe("EmailService", () => {
    const makeService = (ttls?: typeof emailTtls) => {
      const service = new EmailService(
        {
          user: "user@example.org",
          password: "secret",
          host: "127.0.0.1",
          port: 1,
          secure: true,
        },
        cache,
        {
          minConnections: 0,
          maxConnections: 1,
          acquireTimeoutMs: 1000,
          idleTimeoutMs: 1000,
          maxRetries: 0,
          retryDelayMs: 0,
          healthCheckIntervalMs: 1000,
        },
        ttls,
      );
      // biome-ignore lint/suspicious/noExplicitAny: stubbing private IMAP paths
      const internals = service as any;
      internals.performEmailSearch = vi.fn(async () => []);
      internals.fetchEmailByUid = vi.fn(async () => ({ uid: 1 }));
      internals.buildEmailThread = vi.fn(async () => ({ messages: [] }));
      return service;
    };

    it("should cache searches, messages and threads with the configured TTLs", async () => {
      const service = makeService(emailTtls);

      await service.searchEmails({ folder: "INBOX" });
      await service.getEmail(1, "INBOX");
      await service.getEmailThread("<id@example.org>", "INBOX");

      expect(ttlFor("email_search:")).toBe(11_000);
      expect(ttlFor("email:")).toBe(22_000);
      expect(ttlFor("thread:")).toBe(33_000);
    });

    it("should keep the previous TTLs when none are configured", async () => {
      const service = makeService();

      await service.getEmail(1, "INBOX");
      await service.getEmailThread("<id@example.org>", "INBOX");

      expect(ttlFor("email:")).toBe(600_000);
      expect(ttlFor("thread:")).toBe(300_000);
    });
  });

  describe("CalendarService", () => {
    const makeService = (ttls?: typeof calendarTtls) => {
      const service = new CalendarService(
        {
          baseUrl: "https://127.0.0.1:1/",
          username: "user@example.org",
          password: "secret",
        },
        cache,
        undefined,
        ttls,
      );
      // biome-ignore lint/suspicious/noExplicitAny: stubbing the CalDAV fetch
      (service as any).fetchCalendarEvents = vi.fn(async () => []);
      return service;
    };

    it("should cache events, searches and free/busy with the configured TTLs", async () => {
      const service = makeService(calendarTtls);
      const start = new Date("2026-01-01T00:00:00Z");
      const end = new Date("2026-01-02T00:00:00Z");

      await service.getCalendarEvents({ start, end });
      await service.searchCalendar({ start, end, query: "x" });
      await service.getFreeBusy(start, end);

      expect(ttlFor("calendar_events:")).toBe(44_000);
      expect(ttlFor("calendar_search:")).toBe(44_000);
      expect(ttlFor("freebusy:")).toBe(55_000);
    });

    it("should keep the previous TTLs when none are configured", async () => {
      const service = makeService();
      const start = new Date("2026-01-01T00:00:00Z");
      const end = new Date("2026-01-02T00:00:00Z");

      await service.getCalendarEvents({ start, end });
      await service.getFreeBusy(start, end);

      expect(ttlFor("calendar_events:")).toBe(900_000);
      expect(ttlFor("freebusy:")).toBe(300_000);
    });
  });
});
