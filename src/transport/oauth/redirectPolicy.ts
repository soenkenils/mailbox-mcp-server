/**
 * Policy controlling where authorization codes may be delivered.
 *
 * Client registration is open, so without a restriction anyone could register a
 * client pointing at a host they control and send a link to the authorize page.
 * The consent screen shows the destination, but that relies on the reader
 * noticing; this refuses such a registration outright.
 */

/** Hosts permitted by default: the clients this server is actually used from. */
export const DEFAULT_ALLOWED_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

/**
 * Loopback addresses are allowed over plain http on any port, per RFC 8252,
 * because native clients (Claude Code, MCP Inspector) receive their callback on
 * an ephemeral local port.
 */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "::1"];

const isLoopback = (hostname: string): boolean =>
  LOOPBACK_HOSTNAMES.includes(hostname.replace(/^\[|\]$/g, ""));

/**
 * A redirect URI is acceptable when it targets loopback, or an allowed host
 * over https. Subdomains are not implied: hosts must match exactly, so
 * permitting "claude.ai" does not permit "evil.claude.ai.example".
 */
export const isAllowedRedirectUri = (
  redirectUri: string,
  allowedHosts: string[] = DEFAULT_ALLOWED_REDIRECT_HOSTS,
): boolean => {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return false;
  }

  if (isLoopback(url.hostname)) {
    return url.protocol === "http:" || url.protocol === "https:";
  }

  if (url.protocol !== "https:") {
    return false;
  }

  return allowedHosts.some(
    host => host.toLowerCase() === url.hostname.toLowerCase(),
  );
};

/**
 * Whether a requested redirect URI is one the client registered. Matching is
 * exact, except that a loopback URI may use any port, per RFC 8252 §7.3: native
 * clients only learn their port when they request the authorization.
 */
export const redirectUriMatches = (
  requested: string,
  registered: string,
): boolean => {
  if (requested === registered) {
    return true;
  }

  let requestedUrl: URL;
  let registeredUrl: URL;
  try {
    requestedUrl = new URL(requested);
    registeredUrl = new URL(registered);
  } catch {
    return false;
  }

  return (
    isLoopback(requestedUrl.hostname) &&
    requestedUrl.protocol === registeredUrl.protocol &&
    requestedUrl.hostname === registeredUrl.hostname &&
    requestedUrl.pathname === registeredUrl.pathname &&
    requestedUrl.search === registeredUrl.search
  );
};

/** Returns the URIs that policy would refuse, for reporting back to the client. */
export const rejectedRedirectUris = (
  redirectUris: string[],
  allowedHosts?: string[],
): string[] =>
  redirectUris.filter(uri => !isAllowedRedirectUri(uri, allowedHosts));
