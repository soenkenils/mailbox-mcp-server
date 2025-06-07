import type { IMAPConfig } from "./types/imap.types.js";

// Default configuration
const DEFAULT_CONFIG: IMAPConfig = {
  host: process.env.IMAP_HOST || "imap.mailbox.org",
  port: Number.parseInt(process.env.IMAP_PORT || "993", 10),
  tls: process.env.IMAP_TLS !== "false",
  user: process.env.IMAP_USER || "",
  password: process.env.IMAP_PASSWORD || "",
  authTimeout: 10000, // 10 seconds
  connTimeout: 30000, // 30 seconds
  keepalive: true,
  tlsOptions: {
    rejectUnauthorized: true,
  },
};

// Validate required configuration
function validateConfig(config: IMAPConfig): void {
  console.log("Using configuration:", {
    host: config.host,
    port: config.port,
    user: config.user,
    passwordProvided: !!config.password
  });

  if (!config.host) {
    throw new Error("IMAP host is required");
  }

  if (!config.user) {
    throw new Error("IMAP username is required");
  }

  if (!config.password) {
    throw new Error("IMAP password is required");
  }
}

// Get configuration from environment variables
function getConfig(overrides: Partial<IMAPConfig> = {}): IMAPConfig {
  const config = { ...DEFAULT_CONFIG, ...overrides };
  validateConfig(config);
  return config;
}

export { getConfig };
