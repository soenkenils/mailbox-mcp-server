import * as v from "valibot";
import type { ConnectionPoolConfig } from "../services/ConnectionPool.js";
import { DynamicPoolManager } from "../services/DynamicPoolManager.js";
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

// Custom validation functions for security
const isStrongPassword = (value: string): boolean => {
  // Minimum 8 characters, at least one uppercase, lowercase, and number
  const minLength = value.length >= 8;
  const hasUppercase = /[A-Z]/.test(value);
  const hasLowercase = /[a-z]/.test(value);
  const hasNumber = /\d/.test(value);

  return minLength && hasUppercase && hasLowercase && hasNumber;
};

const isSecureEmail = (value: string): boolean => {
  // Basic email validation plus ensure it's not from common insecure domains
  const insecureDomains = ["example.com", "test.com", "localhost"];
  const domain = value.split("@")[1]?.toLowerCase();
  return !insecureDomains.includes(domain);
};

const strongPasswordTransform = (value: string) => {
  // App passwords from mailbox.org may not follow standard password patterns
  // Just ensure it's not empty
  if (!value || value.trim().length === 0) {
    throw new Error("Password cannot be empty");
  }
  return value;
};

const secureEmailTransform = (value: string) => {
  if (!isSecureEmail(value)) {
    throw new Error("Email domain appears to be insecure or for testing only");
  }
  return value;
};

// Environment variables validation schema
const EnvSchema = v.object({
  // Required variables with enhanced security validation
  MAILBOX_EMAIL: v.pipe(
    v.string(),
    v.email("Invalid email format"),
    v.minLength(5, "Email too short"),
    v.transform(secureEmailTransform),
  ),
  MAILBOX_PASSWORD: v.pipe(
    v.string(),
    v.minLength(1, "Password is required"),
    v.transform(strongPasswordTransform),
  ),

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

function formatValidationError(
  error: v.ValiError<
    | v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
    | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>>
  >,
): string {
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

    // We've validated these exist and are secure, so they're safe to use
    const email = validatedEnv.MAILBOX_EMAIL;
    const password = validatedEnv.MAILBOX_PASSWORD;

    // Security recommendations logging (non-sensitive info only)
    if (password.length < 12) {
      console.warn(
        "⚠️  Security Recommendation: Consider using a password with 12+ characters for enhanced security",
      );
    }

    // Validate connection security settings
    const imapSecure = validatedEnv.MAILBOX_IMAP_SECURE !== "false";
    const smtpSecure = validatedEnv.MAILBOX_SMTP_SECURE !== "false";

    if (!imapSecure || !smtpSecure) {
      console.warn(
        "⚠️  Security Warning: Non-secure connections detected. Ensure you're connecting over encrypted channels in production.",
      );
    }

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
        port: validatedEnv.MAILBOX_SIEVE_PORT || 2000,
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
          // Use dynamic pool configuration with environment overrides
          ...DynamicPoolManager.getRecommendedConfig("imap"),
          // Allow environment variable overrides for specific values
          maxConnections:
            validatedEnv.POOL_MAX_CONNECTIONS ||
            DynamicPoolManager.getRecommendedConfig("imap").maxConnections,
          acquireTimeoutMs: validatedEnv.POOL_TIMEOUT_MS || 15000,
          idleTimeoutMs: validatedEnv.POOL_IDLE_TIMEOUT_MS || 30000,
          healthCheckIntervalMs: validatedEnv.POOL_HEALTH_CHECK_MS || 6000,
        },
        smtp: {
          // Use dynamic pool configuration with environment overrides
          ...DynamicPoolManager.getRecommendedConfig("smtp"),
          // Allow environment variable overrides for specific values
          maxConnections: validatedEnv.POOL_MAX_CONNECTIONS
            ? Math.min(5, validatedEnv.POOL_MAX_CONNECTIONS)
            : // Cap SMTP at 5 even with env override
              DynamicPoolManager.getRecommendedConfig("smtp").maxConnections,
          acquireTimeoutMs: validatedEnv.POOL_TIMEOUT_MS || 15000,
          idleTimeoutMs: validatedEnv.POOL_IDLE_TIMEOUT_MS || 30000,
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
