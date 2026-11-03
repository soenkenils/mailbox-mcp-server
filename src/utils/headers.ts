/**
 * Helpers for working with raw RFC 5322 message headers.
 *
 * Used by the `get_email_headers` tool and by the Sieve dry-run interpreter.
 * Everything here is pure (no I/O) so it can be unit-tested without IMAP.
 */

export interface HeaderField {
  /** Header name as it appears in the message (original case) */
  name: string;
  /** Unfolded raw value (encoded words are NOT decoded) */
  raw: string;
  /** Unfolded value with RFC 2047 encoded words decoded */
  value: string;
  /** True if the value was longer than MAX_HEADER_VALUE and was cut */
  truncated?: boolean;
}

/**
 * Upper bound for a single (unfolded) header value. Longer values are cut
 * before decoding and matching so a crafted message cannot make header
 * processing slow or memory hungry.
 */
export const MAX_HEADER_VALUE = 16 * 1024;

export interface AuthenticationResult {
  method: string;
  result: string;
  details?: string;
}

export interface HeaderSummary {
  from?: string;
  fromDomain?: string;
  replyTo?: string;
  replyToDomain?: string;
  /** True if Reply-To exists and points to a different domain than From */
  replyToDiffersFromFrom: boolean;
  returnPath?: string;
  returnPathDomain?: string;
  messageId?: string;
  date?: string;
  listUnsubscribe?: string;
  listUnsubscribePost?: string;
  listId?: string;
  precedence?: string;
  mailer?: string;
  receivedCount: number;
  /** Last (= closest to the sender) Received header */
  originReceived?: string;
  authentication: AuthenticationResult[];
  spamHeaders: HeaderField[];
}

/**
 * Split a raw message (or only its header block) into the header block.
 * The header block ends at the first empty line.
 */
export function extractHeaderBlock(raw: Buffer | string): string {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const match = /\r?\n\r?\n/.exec(text);
  return match ? text.slice(0, match.index) : text;
}

/**
 * Extract the body (everything after the first empty line).
 */
export function extractRawBody(raw: Buffer | string): string {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  const match = /\r?\n\r?\n/.exec(text);
  return match ? text.slice(match.index + match[0].length) : "";
}

/**
 * Parse a header block into fields, unfolding continuation lines.
 */
export function parseHeaderBlock(block: string): HeaderField[] {
  const fields: HeaderField[] = [];
  const lines = block.split(/\r?\n/);
  let current: { name: string; raw: string } | null = null;

  const flush = () => {
    if (current) {
      let raw = current.raw.trim();
      const truncated = raw.length > MAX_HEADER_VALUE;
      if (truncated) {
        raw = raw.slice(0, MAX_HEADER_VALUE);
      }
      fields.push({
        name: current.name,
        raw,
        value: decodeEncodedWords(raw),
        ...(truncated ? { truncated: true } : {}),
      });
    }
  };

  for (const line of lines) {
    if (/^[ \t]/.test(line) && current) {
      // Continuation line (folded header). Stop growing once far beyond the
      // limit; the value is cut in flush() anyway.
      if (current.raw.length <= MAX_HEADER_VALUE + 1) {
        current.raw += ` ${line.trim()}`;
      }
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    flush();
    current = {
      name: line.slice(0, colon).trim(),
      raw: line.slice(colon + 1),
    };
  }
  flush();
  return fields;
}

/**
 * Parse all headers of a raw message.
 */
export function parseHeaders(raw: Buffer | string): HeaderField[] {
  return parseHeaderBlock(extractHeaderBlock(raw));
}

/**
 * Return all values of a header (case-insensitive name match), decoded.
 */
export function getHeaderValues(fields: HeaderField[], name: string): string[] {
  const lower = name.toLowerCase();
  return fields.filter(f => f.name.toLowerCase() === lower).map(f => f.value);
}

function decodeQ(text: string): Uint8Array {
  const bytes: number[] = [];
  const input = text.replace(/_/g, " ");
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase(), { fatal: false }).decode(
      bytes,
    );
  } catch {
    // Unknown charset: fall back to UTF-8
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/**
 * Decode RFC 2047 encoded words (`=?charset?B|Q?text?=`).
 * Whitespace between two adjacent encoded words is removed (RFC 2047 §6.2).
 */
export function decodeEncodedWords(value: string): string {
  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  if (!pattern.test(value)) {
    return value;
  }
  pattern.lastIndex = 0;
  // Remove whitespace between adjacent encoded words
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(pattern, (_match, charset, encoding, text) => {
    // Strip RFC 2231 language suffix (charset*lang)
    const cs = String(charset).split("*")[0];
    const bytes =
      String(encoding).toUpperCase() === "B"
        ? Uint8Array.from(Buffer.from(String(text), "base64"))
        : decodeQ(String(text));
    return decodeCharset(bytes, cs);
  });
}

const ADDRESS_DELIMITERS = new Set([
  " ",
  "\t",
  "\r",
  "\n",
  "<",
  ">",
  '"',
  "(",
  ")",
  ",",
  ";",
  ":",
]);

/**
 * Extract all addresses from an address header value in linear time.
 *
 * Returns the content of every `<...>` and every bare token containing "@".
 * Quoted display names and (comments) are skipped. This replaces regex
 * scanning, which was quadratic on long values without "@".
 */
export function extractAddresses(value: string): string[] {
  const addresses: string[] = [];
  let token = "";
  let i = 0;
  const pushToken = () => {
    if (token.includes("@")) {
      addresses.push(token);
    }
    token = "";
  };
  while (i < value.length) {
    const ch = value[i];
    if (ch === '"') {
      // quoted string (display name)
      pushToken();
      i++;
      while (i < value.length && value[i] !== '"') {
        i += value[i] === "\\" ? 2 : 1;
      }
      i++;
      continue;
    }
    if (ch === "(") {
      // comment, may be nested
      pushToken();
      let depth = 0;
      while (i < value.length) {
        const c = value[i];
        if (c === "\\") {
          i += 2;
          continue;
        }
        if (c === "(") depth++;
        if (c === ")") depth--;
        i++;
        if (depth === 0) break;
      }
      continue;
    }
    if (ch === "<") {
      pushToken();
      const end = value.indexOf(">", i + 1);
      const inner = value.slice(i + 1, end === -1 ? value.length : end).trim();
      if (inner && !/\s/.test(inner)) {
        addresses.push(inner);
      }
      i = end === -1 ? value.length : end + 1;
      continue;
    }
    if (ADDRESS_DELIMITERS.has(ch)) {
      pushToken();
    } else {
      token += ch;
    }
    i++;
  }
  pushToken();
  return addresses;
}

/**
 * Extract the bare e-mail address from a header value like
 * `"Name" <user@example.org>` or `user@example.org`.
 */
export function extractAddress(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  return extractAddresses(value).find(a => a.includes("@"));
}

export function domainOf(address: string | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase() : undefined;
}

/**
 * Parse `Authentication-Results` headers into method/result pairs
 * (spf=pass, dkim=fail, dmarc=pass, ...).
 */
export function parseAuthenticationResults(
  values: string[],
): AuthenticationResult[] {
  const results: AuthenticationResult[] = [];
  for (const value of values) {
    // First token is the authserv-id, the rest are ";"-separated results
    const parts = value.split(";").slice(1);
    for (const part of parts) {
      const match = /^\s*([a-zA-Z0-9-]+)\s*=\s*([a-zA-Z0-9-]+)(.*)$/s.exec(
        part,
      );
      if (match) {
        const details = match[3].trim();
        results.push({
          method: match[1].toLowerCase(),
          result: match[2].toLowerCase(),
          ...(details ? { details } : {}),
        });
      }
    }
  }
  return results;
}

/**
 * Build a compact summary of the headers that matter for spam/phishing and
 * filter analysis.
 */
export function summarizeHeaders(fields: HeaderField[]): HeaderSummary {
  const first = (name: string) => getHeaderValues(fields, name)[0];

  const from = first("From");
  const replyTo = first("Reply-To");
  const returnPath = first("Return-Path");
  const fromDomain = domainOf(extractAddress(from));
  const replyToDomain = domainOf(extractAddress(replyTo));
  const returnPathDomain = domainOf(extractAddress(returnPath));
  const received = getHeaderValues(fields, "Received");

  return {
    from,
    fromDomain,
    replyTo,
    replyToDomain,
    replyToDiffersFromFrom: Boolean(
      replyToDomain && fromDomain && replyToDomain !== fromDomain,
    ),
    returnPath,
    returnPathDomain,
    messageId: first("Message-ID"),
    date: first("Date"),
    listUnsubscribe: first("List-Unsubscribe"),
    listUnsubscribePost: first("List-Unsubscribe-Post"),
    listId: first("List-Id"),
    precedence: first("Precedence"),
    mailer: first("X-Mailer") ?? first("User-Agent"),
    receivedCount: received.length,
    originReceived: received.length ? received[received.length - 1] : undefined,
    authentication: parseAuthenticationResults(
      getHeaderValues(fields, "Authentication-Results"),
    ),
    spamHeaders: fields.filter(f => /^x-(spam|rspamd)/i.test(f.name)),
  };
}
