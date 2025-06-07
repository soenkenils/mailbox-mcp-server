import type { CacheConfig } from "../types/cache.types.js";
import type { CalDavConnection } from "../types/calendar.types.js";
import type { ImapConnection } from "../types/email.types.js";

export interface ServerConfig {
  email: ImapConnection;
  calendar: CalDavConnection;
  cache: CacheConfig;
  debug: boolean;
}

export function loadConfig(): ServerConfig {
  const requiredEnvVars = ["MAILBOX_EMAIL", "MAILBOX_PASSWORD"];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      throw new Error(`Missing required environment variable: ${envVar}`);
    }
  }

  return {
    email: {
      host: process.env.MAILBOX_IMAP_HOST || "imap.mailbox.org",
      port: Number.parseInt(process.env.MAILBOX_IMAP_PORT || "993", 10),
      secure: process.env.MAILBOX_IMAP_SECURE !== "false",
      user: process.env.MAILBOX_EMAIL!,
      password: process.env.MAILBOX_PASSWORD!,
    },
    calendar: {
      baseUrl: process.env.MAILBOX_CALDAV_URL || "https://dav.mailbox.org/",
      username: process.env.MAILBOX_EMAIL!,
      password: process.env.MAILBOX_PASSWORD!,
      calendars: process.env.MAILBOX_CALENDARS?.split(",") || undefined,
    },
    cache: {
      email: {
        searchTtl: Number.parseInt(
          process.env.CACHE_EMAIL_SEARCH_TTL || "300000",
          10,
        ), // 5 minutes
        messageTtl: Number.parseInt(
          process.env.CACHE_EMAIL_MESSAGE_TTL || "600000",
          10,
        ), // 10 minutes
        threadTtl: Number.parseInt(
          process.env.CACHE_EMAIL_THREAD_TTL || "300000",
          10,
        ), // 5 minutes
      },
      calendar: {
        eventsTtl: Number.parseInt(
          process.env.CACHE_CALENDAR_EVENTS_TTL || "900000",
          10,
        ), // 15 minutes
        freeBusyTtl: Number.parseInt(
          process.env.CACHE_CALENDAR_FREEBUSY_TTL || "300000",
          10,
        ), // 5 minutes
      },
      maxSize: Number.parseInt(process.env.CACHE_MAX_SIZE || "1000", 10),
      cleanupInterval: Number.parseInt(
        process.env.CACHE_CLEANUP_INTERVAL || "300000",
        10,
      ), // 5 minutes
    },
    debug: process.env.DEBUG === "true",
  };
}
