// CalDAV service factory
import type { CalDAVConfig } from "../types/caldav.types.js";
import { CalDavService } from "./CalDavService.js";

export function createCalDavService(config?: Partial<CalDAVConfig>): CalDavService {
  const finalConfig: CalDAVConfig = {
    ...createDefaultCalDavConfig(),
    ...config,
  };

  return new CalDavService(finalConfig);
}

export function createDefaultCalDavConfig(
  overrides: Partial<CalDAVConfig> = {},
): CalDAVConfig {
  return {
    serverUrl: "dav.mailbox.org",
    username: "",
    password: "",
    authTimeout: 3000,
    connTimeout: 10000,
    tls: true,
    tlsOptions: {
      rejectUnauthorized: true,
    },
    ...overrides,
  };
}
