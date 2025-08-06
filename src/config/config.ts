import * as v from "valibot";
import type { ConnectionPoolConfig } from "../services/ConnectionPool.js";
import type { CacheConfig } from "../types/cache.types.js";
import type { CalDavConnection } from "../types/calendar.types.js";
import type { ImapConnection, SmtpConnection } from "../types/email.types.js";
import type { SieveConnection } from "../types/sieve.types.js";

export interface PoolsConfig {
  imap: ConnectionPoolConfig;
  smtp: ConnectionPoolConfig;
}

export interface ServerConfig {
  email: ImapConnection;
  smtp: SmtpConnection;
  calendar: CalDavConnection;
  sieve: SieveConnection;
  cache: CacheConfig;
  pools: PoolsConfig;
  debug: boolean;
}

// Environment variables validation schema
const EnvSchema = v.object({
  // Required variables
  MAILBOX_EMAIL: v.pipe(v.string(), v.email(), v.minLength(1)),
  MAILBOX_PASSWORD: v.pipe(v.string(), v.minLength(1)),

  // Optional IMAP configuration
  MAILBOX_IMAP_HOST: v.optional(v.pipe(v.string(), v.minLength(1))),
  MAILBOX_IMAP_PORT: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.minValue(1),
      v.maxValue(65535),
    ),
  ),
  MAILBOX_IMAP_SECURE: v.optional(v.picklist(["true", "false"])),

  // Optional SMTP configuration
  MAILBOX_SMTP_HOST: v.optional(v.pipe(v.string(), v.minLength(1))),
  MAILBOX_SMTP_PORT: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.minValue(1),
      v.maxValue(65535),
    ),
  ),
  MAILBOX_SMTP_SECURE: v.optional(v.picklist(["true", "false"])),

  // Optional CalDAV configuration
  MAILBOX_CALDAV_URL: v.optional(v.pipe(v.string(), v.url())),
  MAILBOX_CALENDARS: v.optional(v.string()),

  // Optional Sieve configuration
  MAILBOX_SIEVE_HOST: v.optional(v.pipe(v.string(), v.minLength(1))),
  MAILBOX_SIEVE_PORT: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.minValue(1),
      v.maxValue(65535),
    ),
  ),
  MAILBOX_SIEVE_SECURE: v.optional(v.picklist(["true", "false"])),

  // Optional cache configuration
  CACHE_EMAIL_SEARCH_TTL: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(0)),
  ),
  CACHE_EMAIL_MESSAGE_TTL: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(0)),
  ),
  CACHE_EMAIL_THREAD_TTL: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(0)),
  ),
  CACHE_CALENDAR_EVENTS_TTL: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(0)),
  ),
  CACHE_CALENDAR_FREEBUSY_TTL: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(0)),
  ),
  CACHE_MAX_SIZE: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1)),
  ),
  CACHE_CLEANUP_INTERVAL: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1000)),
  ),

  // Optional pool configuration
  POOL_MAX_CONNECTIONS: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.minValue(1),
      v.maxValue(100),
    ),
  ),
  POOL_TIMEOUT_MS: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1000)),
  ),
  POOL_IDLE_TIMEOUT_MS: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1000)),
  ),
  POOL_HEALTH_CHECK_MS: v.optional(
    v.pipe(v.string(), v.transform(Number), v.number(), v.minValue(1000)),
  ),

  // Optional debug flag
  DEBUG: v.optional(v.picklist(["true", "false"])),
});

function formatValidationError(error: v.ValiError<unknown>): string {
  const issues = v.flatten(error.issues);
  const messages: string[] = [];

  for (const [path, issue] of Object.entries(issues.nested || {})) {
    if (Array.isArray(issue)) {
      for (const i of issue) {
        messages.push(`${path}: ${i}`);
      }
    }
  }

  if (issues.root) {
    for (const issue of issues.root) {
      messages.push(`Configuration: ${issue}`);
    }
  }

  return messages.join(", ");
}

export function loadConfig(): ServerConfig {
  try {
    const validatedEnv = v.parse(EnvSchema, process.env);

    // We've validated these exist, so they're safe to use
    const email = validatedEnv.MAILBOX_EMAIL;
    const password = validatedEnv.MAILBOX_PASSWORD;

    return {
      email: {
        host: validatedEnv.MAILBOX_IMAP_HOST || "imap.mailbox.org",
        port: validatedEnv.MAILBOX_IMAP_PORT || 993,
        secure: validatedEnv.MAILBOX_IMAP_SECURE !== "false",
        user: email,
        password: password,
      },
      smtp: {
        host: validatedEnv.MAILBOX_SMTP_HOST || "smtp.mailbox.org",
        port: validatedEnv.MAILBOX_SMTP_PORT || 465,
        secure: validatedEnv.MAILBOX_SMTP_SECURE !== "false",
        user: email,
        password: password,
      },
      calendar: {
        baseUrl: validatedEnv.MAILBOX_CALDAV_URL || "https://dav.mailbox.org/",
        username: email,
        password: password,
        calendars: validatedEnv.MAILBOX_CALENDARS?.split(",") || undefined,
      },
      sieve: {
        host: validatedEnv.MAILBOX_SIEVE_HOST || "imap.mailbox.org",
        port: validatedEnv.MAILBOX_SIEVE_PORT || 4190,
        secure: validatedEnv.MAILBOX_SIEVE_SECURE === "true",
        user: email,
        password: password,
      },
      cache: {
        email: {
          searchTtl: validatedEnv.CACHE_EMAIL_SEARCH_TTL || 300000, // 5 minutes
          messageTtl: validatedEnv.CACHE_EMAIL_MESSAGE_TTL || 600000, // 10 minutes
          threadTtl: validatedEnv.CACHE_EMAIL_THREAD_TTL || 300000, // 5 minutes
        },
        calendar: {
          eventsTtl: validatedEnv.CACHE_CALENDAR_EVENTS_TTL || 900000, // 15 minutes
          freeBusyTtl: validatedEnv.CACHE_CALENDAR_FREEBUSY_TTL || 300000, // 5 minutes
        },
        maxSize: validatedEnv.CACHE_MAX_SIZE || 1000,
        cleanupInterval: validatedEnv.CACHE_CLEANUP_INTERVAL || 300000, // 5 minutes
      },
      pools: {
        imap: {
          minConnections: 1, // Always 1 - no need to configure
          maxConnections: validatedEnv.POOL_MAX_CONNECTIONS || 2,
          acquireTimeoutMs: validatedEnv.POOL_TIMEOUT_MS || 15000,
          idleTimeoutMs: validatedEnv.POOL_IDLE_TIMEOUT_MS || 30000,
          maxRetries: 3, // Hardcoded - sensible default
          retryDelayMs: 1000, // Hardcoded - sensible default
          healthCheckIntervalMs: validatedEnv.POOL_HEALTH_CHECK_MS || 6000,
        },
        smtp: {
          minConnections: 1, // Always 1 - no need to configure
          maxConnections: Math.min(3, validatedEnv.POOL_MAX_CONNECTIONS || 8), // SMTP needs fewer connections
          acquireTimeoutMs: validatedEnv.POOL_TIMEOUT_MS || 15000,
          idleTimeoutMs: validatedEnv.POOL_IDLE_TIMEOUT_MS || 30000,
          maxRetries: 3, // Hardcoded - sensible default
          retryDelayMs: 1000, // Hardcoded - sensible default
          healthCheckIntervalMs: validatedEnv.POOL_HEALTH_CHECK_MS || 6000,
        },
      },
      debug: validatedEnv.DEBUG === "true",
    };
  } catch (error) {
    if (v.isValiError(error)) {
      const errorMessage = formatValidationError(error);
      throw new Error(`Configuration validation failed: ${errorMessage}`);
    }
    throw error;
  }
}
