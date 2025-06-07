import type { IMAPConfig } from "../types/imap.types.js";
import { ImapService } from "./ImapService.js";

export function createImapService(config: IMAPConfig): ImapService {
  return new ImapService({
    host: config.host,
    port: config.port,
    tls: config.tls,
    user: config.user,
    password: config.password,
    authTimeout: config.authTimeout,
    connTimeout: config.connTimeout,
    keepalive: config.keepalive,
    tlsOptions: config.tlsOptions,
    socketTimeout: config.socketTimeout,
    smtpConfig: config.smtpConfig,
  });
}

export function createDefaultImapConfig(
  overrides: Partial<IMAPConfig> = {},
): IMAPConfig {
  return {
    host: "imap.mailbox.org",
    port: 993,
    tls: true,
    user: "",
    password: "",
    authTimeout: 3000,
    connTimeout: 10000,
    keepalive: true,
    tlsOptions: {
      rejectUnauthorized: true,
    },
    smtpConfig: {
      host: "smtp.mailbox.org",
      port: 587,
      secure: false,
      user: overrides.user || "",
      password: overrides.password || "",
    },
    ...overrides,
  };
}
