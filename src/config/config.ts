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

export type TransportMode = "stdio" | "http";

export interface TransportConfig {
  mode: TransportMode;
  port: number;
  /** Shared secret required for HTTP mode; undefined in stdio mode. */
  authToken?: string;
  /**
   * Externally reachable origin. Enables OAuth when set, since discovery
   * metadata and redirects must advertise a stable public URL.
   */
  publicUrl?: string;
  /** Hosts an OAuth client may register a redirect URI for. */
  allowedRedirectHosts?: string[];
}

export interface ServerConfig {
  email: ImapConnection;
  smtp: SmtpConnection;
  calendar: CalDavConnection;
  sieve: SieveConnection;
  cache: CacheConfig;
  pools: PoolsConfig;
  transport: TransportConfig;
  debug: boolean;
}

/** Minimum length for MCP_AUTH_TOKEN; `openssl rand -hex 32` yields 64 chars. */
const MIN_AUTH_TOKEN_LENGTH = 32;

// Environment variables validation schema
const EnvSchema = v.object({
  MAILBOX_EMAIL: v.pipe(v.string(), v.email("Invalid email format")),
  MAILBOX_PASSWORD: v.pipe(v.string(), v.minLength(1, "Password is required")),

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
  POOL_MIN_CONNECTIONS: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.minValue(0),
      v.maxValue(100),
    ),
  ),
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

  // Optional transport configuration (stdio for local clients, http for hosted)
  MCP_TRANSPORT: v.optional(v.picklist(["stdio", "http"])),
  PORT: v.optional(
    v.pipe(
      v.string(),
      v.transform(Number),
      v.number(),
      v.minValue(1),
      v.maxValue(65535),
    ),
  ),
  MCP_AUTH_TOKEN: v.optional(v.string()),
  PUBLIC_URL: v.optional(v.pipe(v.string(), v.url())),
  OAUTH_ALLOWED_REDIRECT_HOSTS: v.optional(v.string()),

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

    const email = validatedEnv.MAILBOX_EMAIL;
    const password = validatedEnv.MAILBOX_PASSWORD;

    // Validate connection security settings
    const imapSecure = validatedEnv.MAILBOX_IMAP_SECURE !== "false";
    const smtpSecure = validatedEnv.MAILBOX_SMTP_SECURE !== "false";

    if (!imapSecure || !smtpSecure) {
      console.warn(
        "⚠️  Security Warning: Non-secure connections detected. Ensure you're connecting over encrypted channels in production.",
      );
    }

    const transportMode: TransportMode = validatedEnv.MCP_TRANSPORT || "stdio";
    const authToken = validatedEnv.MCP_AUTH_TOKEN;

    // HTTP mode exposes the server on a network port, so refuse to start
    // without a usable shared secret rather than serving mailbox tools
    // unauthenticated.
    if (
      transportMode === "http" &&
      (!authToken || authToken.length < MIN_AUTH_TOKEN_LENGTH)
    ) {
      throw new Error(
        `Configuration validation failed: MCP_AUTH_TOKEN: HTTP transport requires a token of at least ${MIN_AUTH_TOKEN_LENGTH} characters`,
      );
    }

    // A warm IMAP connection pays off for a long-lived local process, but a
    // hosted server is often stopped whenever it goes idle: keeping a minimum
    // open only produces repeated background IMAP logins that never get used,
    // which the mail provider may read as suspicious activity. Connect on
    // demand instead.
    const imapMinConnections =
      validatedEnv.POOL_MIN_CONNECTIONS ?? (transportMode === "http" ? 0 : 1);
    const imapMaxConnections = validatedEnv.POOL_MAX_CONNECTIONS || 3;

    // The pool tops itself up to the minimum without consulting the maximum,
    // so an inverted pair would open more IMAP logins than the cap allows.
    if (imapMinConnections > imapMaxConnections) {
      throw new Error(
        `Configuration validation failed: POOL_MIN_CONNECTIONS must not exceed POOL_MAX_CONNECTIONS (${imapMaxConnections})`,
      );
    }

    return {
      email: {
        host: validatedEnv.MAILBOX_IMAP_HOST || "imap.mailbox.org",
        port: validatedEnv.MAILBOX_IMAP_PORT || 993,
        secure: imapSecure,
        user: email,
        password: password,
      },
      smtp: {
        host: validatedEnv.MAILBOX_SMTP_HOST || "smtp.mailbox.org",
        port: validatedEnv.MAILBOX_SMTP_PORT || 465,
        secure: smtpSecure,
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
          minConnections: imapMinConnections,
          maxConnections: imapMaxConnections,
          acquireTimeoutMs: validatedEnv.POOL_TIMEOUT_MS || 15000,
          idleTimeoutMs: validatedEnv.POOL_IDLE_TIMEOUT_MS || 30000,
          maxRetries: 5,
          retryDelayMs: 200,
          healthCheckIntervalMs: validatedEnv.POOL_HEALTH_CHECK_MS || 6000,
        },
        smtp: {
          // Connect on demand: with pool:false every nodemailer verify() is a
          // full TCP+TLS+AUTH session, so a warm idle transporter only costs
          // repeated logins while saving little on the next send.
          minConnections: 0,
          maxConnections: validatedEnv.POOL_MAX_CONNECTIONS
            ? Math.min(5, validatedEnv.POOL_MAX_CONNECTIONS)
            : 2,
          acquireTimeoutMs: validatedEnv.POOL_TIMEOUT_MS || 15000,
          idleTimeoutMs: validatedEnv.POOL_IDLE_TIMEOUT_MS || 30000,
          maxRetries: 5,
          retryDelayMs: 200,
          healthCheckIntervalMs: validatedEnv.POOL_HEALTH_CHECK_MS || 6000,
        },
      },
      transport: {
        mode: transportMode,
        port: validatedEnv.PORT || 8080,
        authToken,
        // Trailing slashes would produce doubled slashes in published metadata.
        publicUrl: validatedEnv.PUBLIC_URL?.replace(/\/+$/, ""),
        allowedRedirectHosts: validatedEnv.OAUTH_ALLOWED_REDIRECT_HOSTS?.split(
          ",",
        )
          .map(host => host.trim())
          .filter(host => host.length > 0),
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
