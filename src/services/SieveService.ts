import { Socket } from "node:net";
import { type TLSSocket, connect as tlsConnect } from "node:tls";
import {
  type SieveCapabilities,
  type SieveConnection,
  SieveError,
  type SieveResponse,
  type SieveScript,
} from "../types/sieve.types.js";
import { createLogger } from "./Logger.js";

/**
 * True if a code point may appear in a sieve-name (RFC 5804 §1.6): no
 * control characters (C0, DEL, C1), no line/paragraph separators, no
 * byte order mark and no unpaired surrogates.
 */
export function isAllowedSieveNameChar(code: number): boolean {
  return !(
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0xfeff ||
    (code >= 0xd800 && code <= 0xdfff)
  );
}

/**
 * Encode a ManageSieve quoted string (RFC 5804 §4). Script names come from
 * tool input, so anything that could terminate the string or the command
 * line (CR, LF, NUL and other control characters) is rejected, and `\` and
 * `"` are escaped. Without this a name like `x"\r\nDELETESCRIPT "y` would
 * smuggle a second command to the server.
 */
export function quoteSieveString(value: string): string {
  for (const char of value) {
    if (!isAllowedSieveNameChar(char.codePointAt(0) ?? 0)) {
      throw new SieveError(
        "Invalid script name: control characters, line separators, BOM and unpaired surrogates are not allowed",
      );
    }
  }
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/**
 * The verb of a ManageSieve command for logs and error messages.
 * Never put the full command line into messages: AUTHENTICATE carries the
 * base64-encoded password, PUTSCRIPT/CHECKSCRIPT carry script content.
 */
export function commandVerb(command: string): string {
  return command.split(/[\s{]/, 1)[0] || "command";
}

/** A token of a ManageSieve response line */
export type SieveToken =
  | { kind: "string"; value: string }
  | { kind: "atom"; value: string };

const CR = 0x0d;
const LF = 0x0a;
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const LBRACE = 0x7b;

/**
 * If the bytes [from, crlf) end with a literal marker `{n}` / `{n+}`,
 * return n, otherwise null.
 */
function literalLengthBefore(
  buf: Buffer,
  from: number,
  crlf: number,
): number | null {
  if (crlf - from < 3 || buf[crlf - 1] !== 0x7d) {
    return null;
  }
  const segment = buf.subarray(from, crlf).toString("latin1");
  const match = /\{(\d{1,9})\+?\}$/.exec(segment);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Find the end of one complete ManageSieve response in `buf`.
 *
 * A response is any number of lines followed by a status line (OK, NO or
 * BYE at the start of a logical line). Literals (`{n}` CRLF followed by
 * exactly n bytes) are skipped as opaque data, so a script line such as
 * "OK, thanks" or "BYE for now" inside GETSCRIPT can never end the
 * response early. Returns null if the response is not complete yet.
 */
export function findResponseEnd(
  buf: Buffer,
): { statusStart: number; end: number } | null {
  let pos = 0;
  while (pos < buf.length) {
    const lineStart = pos;
    let cursor = lineStart;
    for (;;) {
      const crlf = buf.indexOf("\r\n", cursor);
      if (crlf < 0) {
        return null;
      }
      const literal = literalLengthBefore(buf, cursor, crlf);
      if (literal !== null) {
        const literalEnd = crlf + 2 + literal;
        if (buf.length < literalEnd) {
          return null;
        }
        cursor = literalEnd; // the logical line continues after the literal
        continue;
      }
      pos = crlf + 2;
      break;
    }
    const head = buf
      .subarray(lineStart, Math.min(lineStart + 4, buf.length))
      .toString("latin1")
      .toUpperCase();
    if (/^(OK|NO|BYE)(?=[ (\r]|$)/.test(head)) {
      return { statusStart: lineStart, end: pos };
    }
  }
  return null;
}

/**
 * Tokenize ManageSieve response data (wire format, possibly several lines)
 * into lines of tokens. Quoted strings are unescaped, literals are read by
 * exact byte length, everything else becomes an atom.
 */
export function tokenizeSieveData(buf: Buffer): SieveToken[][] {
  const lines: SieveToken[][] = [];
  let line: SieveToken[] = [];
  let i = 0;
  while (i < buf.length) {
    const byte = buf[i];
    if (byte === CR && buf[i + 1] === LF) {
      lines.push(line);
      line = [];
      i += 2;
      continue;
    }
    if (byte === 0x20 || byte === 0x09) {
      i++;
      continue;
    }
    if (byte === QUOTE) {
      const bytes: number[] = [];
      i++;
      while (i < buf.length && buf[i] !== QUOTE) {
        if (buf[i] === BACKSLASH && i + 1 < buf.length) {
          i++;
        }
        bytes.push(buf[i]);
        i++;
      }
      i++; // closing quote
      line.push({ kind: "string", value: Buffer.from(bytes).toString("utf8") });
      continue;
    }
    if (byte === LBRACE) {
      const match = /^\{(\d{1,9})\+?\}\r\n/.exec(
        buf.subarray(i, Math.min(i + 16, buf.length)).toString("latin1"),
      );
      if (match) {
        const length = Number.parseInt(match[1], 10);
        const start = i + match[0].length;
        line.push({
          kind: "string",
          value: buf.subarray(start, start + length).toString("utf8"),
        });
        i = start + length;
        continue;
      }
    }
    let end = i;
    while (
      end < buf.length &&
      buf[end] !== 0x20 &&
      buf[end] !== 0x09 &&
      !(buf[end] === CR && buf[end + 1] === LF)
    ) {
      end++;
    }
    line.push({ kind: "atom", value: buf.subarray(i, end).toString("utf8") });
    i = end;
  }
  if (line.length) {
    lines.push(line);
  }
  return lines;
}

interface ParsedResponse extends SieveResponse {
  /** Raw bytes of the response lines before the status line */
  raw: Buffer;
}

export class SieveService {
  private socket: Socket | TLSSocket | null = null;
  private connected = false;
  private authenticated = false;
  private tlsActive = false;
  private capabilities: SieveCapabilities | null = null;
  private rx: Buffer = Buffer.alloc(0);
  private queue: ParsedResponse[] = [];
  private waiter: {
    resolve: (response: ParsedResponse) => void;
    reject: (error: Error) => void;
  } | null = null;
  private logger = createLogger("SieveService");

  private static readonly COMMAND_TIMEOUT_MS = 30000;
  private static readonly GREETING_TIMEOUT_MS = 15000;

  constructor(private config: SieveConnection) {}

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      this.logger.info(
        "Connecting to ManageSieve server",
        {
          operation: "connect",
          service: "SieveService",
        },
        {
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure,
        },
      );

      this.resetState();
      if (this.config.secure) {
        this.socket = tlsConnect({
          host: this.config.host,
          port: this.config.port,
          servername: this.config.host,
          rejectUnauthorized: true,
        });
        this.tlsActive = true;
      } else {
        this.socket = new Socket();
        this.socket.connect(this.config.port, this.config.host);
      }

      await this.setupSocketHandlers();

      // RFC 5804 §1.7: the greeting is a capability response followed by OK
      const greeting = await this.nextResponse(
        SieveService.GREETING_TIMEOUT_MS,
        "greeting",
      );
      if (!greeting.success) {
        throw new SieveError(
          `Server rejected connection: ${greeting.message ?? ""}`,
        );
      }

      this.connected = true;
      this.capabilities = await this.capabilitiesFrom(greeting);

      this.logger.info(
        "Successfully connected to ManageSieve server",
        {
          operation: "connect",
          service: "SieveService",
        },
        {
          implementation: this.capabilities.implementation,
          version: this.capabilities.version,
        },
      );
    } catch (error) {
      this.teardown();
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(
        "Failed to connect to ManageSieve server",
        {
          operation: "connect",
          service: "SieveService",
        },
        {
          error: errorMsg,
          host: this.config.host,
          port: this.config.port,
        },
      );
      throw new SieveError(
        `Failed to connect to ManageSieve server: ${errorMsg}`,
      );
    }
  }

  async authenticate(): Promise<void> {
    if (!this.connected) {
      throw new SieveError("Not connected to server");
    }

    if (this.authenticated) {
      return;
    }

    try {
      if (!this.tlsActive) {
        // Never send credentials over an unencrypted connection. A server
        // (or a man in the middle) that does not offer STARTTLS gets no
        // AUTHENTICATE at all.
        if (!this.capabilities?.sieveExtensions.includes("STARTTLS")) {
          throw new SieveError(
            "Server does not offer STARTTLS; refusing to send credentials over an unencrypted connection",
          );
        }

        this.logger.info("Starting TLS upgrade for ManageSieve connection", {
          operation: "starttls",
          service: "SieveService",
        });

        const tlsResponse = await this.sendCommand("STARTTLS");
        if (!tlsResponse.success) {
          throw new SieveError(
            `STARTTLS failed: ${tlsResponse.message}`,
            tlsResponse.code,
          );
        }

        await this.upgradeToTLS();

        // RFC 5804 §2.2: after STARTTLS the server sends its capabilities
        // again; they replace the ones from the unencrypted greeting.
        const postTls = await this.nextResponse(10000, "STARTTLS capabilities");
        if (!postTls.success) {
          throw new SieveError(
            `Server rejected session after STARTTLS: ${postTls.message ?? ""}`,
          );
        }
        this.capabilities = await this.capabilitiesFrom(postTls);
      }

      this.logger.info(
        "Authenticating with ManageSieve server",
        {
          operation: "authenticate",
          service: "SieveService",
        },
        {
          user: this.config.user,
        },
      );

      // Use PLAIN SASL mechanism (base64 encoded: \0username\0password)
      const authString = `\0${this.config.user}\0${this.config.password}`;
      const authBase64 = Buffer.from(authString).toString("base64");

      const response = await this.sendCommand(
        `AUTHENTICATE "PLAIN" "${authBase64}"`,
      );

      if (!response.success) {
        throw new SieveError(
          `Authentication failed: ${response.message}`,
          response.code,
        );
      }

      this.authenticated = true;

      this.logger.info("Successfully authenticated with ManageSieve server", {
        operation: "authenticate",
        service: "SieveService",
      });
    } catch (error) {
      this.authenticated = false;
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (!this.tlsActive) {
        // A failed or refused TLS upgrade leaves the connection in an
        // undefined state; close it right away instead of sending LOGOUT
        // over it and waiting for a timeout.
        this.teardown(errorMsg);
      }
      this.logger.error(
        "Authentication failed",
        {
          operation: "authenticate",
          service: "SieveService",
        },
        {
          error: errorMsg,
        },
      );
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    try {
      if (this.connected && this.socket) {
        await this.sendCommand("LOGOUT");
      }
    } catch {
      // Ignore logout errors
    } finally {
      this.teardown();
    }
  }

  async listScripts(): Promise<SieveScript[]> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand("LISTSCRIPTS");
    if (!response.success) {
      throw new SieveError(
        `Failed to list scripts: ${response.message}`,
        response.code,
      );
    }

    return this.parseScriptList(response.raw);
  }

  async getScript(name: string): Promise<string> {
    const quotedName = quoteSieveString(name);
    await this.ensureAuthenticated();

    const response = await this.sendCommand(`GETSCRIPT ${quotedName}`);
    if (!response.success) {
      throw new SieveError(
        `Failed to get script '${name}': ${response.message}`,
        response.code,
      );
    }

    // The script is returned as a literal (or quoted string): return its
    // exact content.
    const first = tokenizeSieveData(response.raw)
      .flat()
      .find(token => token.kind === "string");
    return first ? first.value : "";
  }

  async putScript(name: string, content: string): Promise<void> {
    const quotedName = quoteSieveString(name);
    await this.ensureAuthenticated();

    const response = await this.sendCommand(
      `PUTSCRIPT ${quotedName} {${Buffer.byteLength(content, "utf8")}+}\r\n${content}`,
    );
    if (!response.success) {
      throw new SieveError(
        `Failed to put script '${name}': ${response.message}`,
        response.code,
      );
    }
  }

  async deleteScript(name: string): Promise<void> {
    const quotedName = quoteSieveString(name);
    await this.ensureAuthenticated();

    const response = await this.sendCommand(`DELETESCRIPT ${quotedName}`);
    if (!response.success) {
      throw new SieveError(
        `Failed to delete script '${name}': ${response.message}`,
        response.code,
      );
    }
  }

  async setActiveScript(name: string): Promise<void> {
    const quotedName = quoteSieveString(name);
    await this.ensureAuthenticated();

    const response = await this.sendCommand(`SETACTIVE ${quotedName}`);
    if (!response.success) {
      throw new SieveError(
        `Failed to activate script '${name}': ${response.message}`,
        response.code,
      );
    }
  }

  async checkScript(content: string): Promise<void> {
    await this.ensureAuthenticated();

    const response = await this.sendCommand(
      `CHECKSCRIPT {${Buffer.byteLength(content, "utf8")}+}\r\n${content}`,
    );
    if (!response.success) {
      throw new SieveError(
        `Script validation failed: ${response.message}`,
        response.code,
      );
    }
  }

  getServerCapabilities(): SieveCapabilities | null {
    return this.capabilities;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  // ------------------------------------------------------------- transport

  private resetState(): void {
    this.rx = Buffer.alloc(0);
    this.queue = [];
    this.waiter = null;
    this.tlsActive = false;
  }

  /** Close the connection and fail any waiting command */
  private teardown(reason = "Connection closed"): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.on("error", () => {
        // swallow errors of a socket we are discarding
      });
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
    this.authenticated = false;
    this.tlsActive = false;
    this.capabilities = null;
    this.rx = Buffer.alloc(0);
    this.queue = [];
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(new SieveError(reason));
  }

  private attachDataHandler(socket: Socket | TLSSocket): void {
    socket.on("data", (data: Buffer) => {
      // Do not log content: responses can contain script bodies
      this.logger.debug(`Received ${data.length} bytes`, {
        operation: "socketData",
        service: "SieveService",
      });
      this.onData(data);
    });
  }

  private onData(data: Buffer): void {
    this.rx = this.rx.length ? Buffer.concat([this.rx, data]) : data;
    for (;;) {
      const found = findResponseEnd(this.rx);
      if (!found) {
        return;
      }
      const response = this.buildResponse(
        this.rx.subarray(0, found.statusStart),
        this.rx.subarray(found.statusStart, found.end),
      );
      this.rx = this.rx.subarray(found.end);
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        waiter.resolve(response);
      } else {
        this.queue.push(response);
      }
      if (response.code === "BYE") {
        // BYE means the server is closing the session; never reuse it
        this.teardown("Server closed the session (BYE)");
        return;
      }
    }
  }

  private buildResponse(raw: Buffer, statusLine: Buffer): ParsedResponse {
    const tokens = tokenizeSieveData(statusLine)[0] ?? [];
    const verb = (tokens[0]?.value ?? "").toUpperCase();
    const text = tokens.find(
      (token, index) => index > 0 && token.kind === "string",
    );
    const message =
      text?.value ??
      tokens
        .slice(1)
        .map(token => token.value)
        .join(" ");
    const data = raw.toString("utf8").replace(/\r\n$/, "");
    if (verb === "OK") {
      return { success: true, message, data, raw: Buffer.from(raw) };
    }
    return {
      success: false,
      code: verb === "BYE" ? "BYE" : "NO",
      message,
      data,
      raw: Buffer.from(raw),
    };
  }

  /** Wait for the next complete response (or take a queued one) */
  private nextResponse(
    timeoutMs: number,
    label: string,
  ): Promise<ParsedResponse> {
    const queued = this.queue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }
    if (this.waiter) {
      return Promise.reject(
        new SieveError("Another command is already in progress"),
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.waiter?.resolve === wrappedResolve) {
          this.waiter = null;
        }
        // A late answer would be taken for the reply to the next command,
        // so the connection must not be reused after a timeout.
        this.teardown(`Command timeout: ${label}`);
        reject(new SieveError(`Command timeout: ${label}`));
      }, timeoutMs);
      const wrappedResolve = (response: ParsedResponse) => {
        clearTimeout(timer);
        resolve(response);
      };
      this.waiter = {
        resolve: wrappedResolve,
        reject: (error: Error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
    });
  }

  private async sendCommand(command: string): Promise<ParsedResponse> {
    if (!this.socket) {
      throw new SieveError("Not connected to server");
    }
    // ManageSieve is sequential: one command at a time
    if (this.waiter) {
      throw new SieveError("Another command is already in progress");
    }
    // A response nobody asked for would be taken as the answer to this
    // command; treat it as a protocol error instead.
    if (this.queue.length > 0) {
      this.teardown("Unexpected response from server");
      throw new SieveError("Protocol error: unexpected response from server");
    }
    const pending = this.nextResponse(
      SieveService.COMMAND_TIMEOUT_MS,
      commandVerb(command),
    );
    this.socket.write(`${command}\r\n`);
    return pending;
  }

  private async setupSocketHandlers(): Promise<void> {
    const socket = this.socket;
    if (!socket) {
      throw new SieveError("Socket not initialized");
    }

    this.attachDataHandler(socket);

    socket.on("close", () => {
      if (this.socket === socket) {
        this.teardown("Connection closed by server");
      }
    });

    socket.on("error", error => {
      this.logger.error(
        `Socket error: ${error.message}`,
        {
          operation: "socketError",
          service: "SieveService",
        },
        {
          host: this.config.host,
          port: this.config.port,
          secure: this.config.secure,
        },
      );
      if (this.socket === socket) {
        this.teardown(`Socket error: ${error.message}`);
      }
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new SieveError(
            `Connection timeout to ${this.config.host}:${this.config.port}`,
          ),
        );
      }, 10000);
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onError = (error: Error) => {
        cleanup();
        reject(new SieveError(`Socket error: ${error.message}`));
      };
      const cleanup = () => {
        clearTimeout(timeout);
        socket.removeListener("connect", onReady);
        socket.removeListener("secureConnect", onReady);
        socket.removeListener("error", onError);
      };
      socket.once(this.config.secure ? "secureConnect" : "connect", onReady);
      socket.once("error", onError);
    });
  }

  private async upgradeToTLS(): Promise<void> {
    const plain = this.socket;
    if (!plain) {
      throw new SieveError("Socket not available for TLS upgrade");
    }

    // Nothing may be pending in plaintext after the STARTTLS OK
    this.rx = Buffer.alloc(0);
    this.queue = [];
    plain.removeAllListeners("data");
    plain.removeAllListeners("close");

    return new Promise((resolve, reject) => {
      let tlsSocket: ReturnType<typeof tlsConnect> | undefined;
      const timeout = setTimeout(() => {
        tlsSocket?.destroy();
        plain.destroy();
        reject(new SieveError("TLS upgrade timeout"));
      }, 10000);

      try {
        const upgraded = tlsConnect({
          socket: plain as Socket,
          servername: this.config.host,
          rejectUnauthorized: true,
        });
        tlsSocket = upgraded;
        this.attachDataHandler(upgraded);

        upgraded.once("secureConnect", () => {
          clearTimeout(timeout);
          this.socket = upgraded;
          this.tlsActive = true;
          upgraded.on("close", () => {
            if (this.socket === upgraded) {
              this.teardown("Connection closed by server");
            }
          });
          upgraded.on("error", error => {
            this.logger.error(`TLS socket error: ${error.message}`, {
              operation: "upgradedError",
              service: "SieveService",
            });
            if (this.socket === upgraded) {
              this.teardown(`TLS socket error: ${error.message}`);
            }
          });
          this.logger.info("TLS upgrade successful", {
            operation: "upgradeToTLS",
            service: "SieveService",
          });
          resolve();
        });

        upgraded.once("error", error => {
          clearTimeout(timeout);
          reject(new SieveError(`TLS upgrade failed: ${error.message}`));
        });
      } catch (error) {
        clearTimeout(timeout);
        reject(
          new SieveError(
            `TLS upgrade error: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    });
  }

  /** Capabilities from a capability response; ask explicitly if empty */
  private async capabilitiesFrom(
    response: ParsedResponse,
  ): Promise<SieveCapabilities> {
    const parsed = this.parseCapabilities(response.data as string);
    if (parsed.implementation || parsed.sieveExtensions.length) {
      return parsed;
    }
    const explicit = await this.sendCommand("CAPABILITY");
    if (!explicit.success) {
      throw new SieveError(
        `Failed to get capabilities: ${explicit.message}`,
        explicit.code,
      );
    }
    return this.parseCapabilities(explicit.data as string);
  }

  // --------------------------------------------------------------- parsers

  private parseScriptList(data: string | Buffer): SieveScript[] {
    const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    const scripts: SieveScript[] = [];

    for (const tokens of tokenizeSieveData(buf)) {
      const [first, second] = tokens;
      if (!first) {
        continue;
      }
      // Status lines (only atoms, never quoted names)
      if (first.kind === "atom" && /^(OK|NO|BYE)$/i.test(first.value)) {
        continue;
      }
      if (first.kind === "atom" && first.value.toUpperCase() === "ACTIVE") {
        // Legacy tolerance: "ACTIVE" alone on a line marks the line itself
        // as a script and flags the most recent entry as active.
        scripts.push({ name: first.value, content: "", active: false });
        scripts[scripts.length - 1].active = true;
        continue;
      }
      scripts.push({
        name: first.value,
        content: "",
        active:
          second?.kind === "atom" && second.value.toUpperCase() === "ACTIVE",
      });
    }

    this.logger.debug(`Parsed ${scripts.length} scripts`, {
      operation: "parseScriptList",
      service: "SieveService",
    });

    return scripts;
  }

  private parseCapabilities(data: string): SieveCapabilities {
    const capabilities: SieveCapabilities = {
      implementation: "",
      version: "",
      saslMechanisms: [],
      sieveExtensions: [],
    };

    const lines = data.split("\r\n");

    this.logger.debug(
      `Parsing capabilities from ${lines.length} lines`,
      {
        operation: "parseCapabilities",
        service: "SieveService",
      },
      {
        lines: lines.slice(0, 10), // Show first 10 lines for debugging
      },
    );

    for (const line of lines) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;

      // Handle quoted capability format: "CAPABILITY" "value"
      if (trimmedLine.startsWith('"IMPLEMENTATION"')) {
        const matches = trimmedLine.match(/"IMPLEMENTATION"\s+"([^"]+)"/);
        capabilities.implementation = matches?.[1] || "";
        this.logger.debug(
          `Parsed implementation: ${capabilities.implementation}`,
        );
      } else if (trimmedLine.startsWith('"VERSION"')) {
        const matches = trimmedLine.match(/"VERSION"\s+"([^"]+)"/);
        capabilities.version = matches?.[1] || "";
        this.logger.debug(`Parsed version: ${capabilities.version}`);
      } else if (trimmedLine.startsWith('"SASL"')) {
        const matches = trimmedLine.match(/"SASL"\s+"([^"]+)"/);
        capabilities.saslMechanisms = matches?.[1]?.split(" ") || [];
        this.logger.debug(
          `Parsed SASL mechanisms: ${capabilities.saslMechanisms.join(", ")}`,
        );
      } else if (trimmedLine.startsWith('"SIEVE"')) {
        const matches = trimmedLine.match(/"SIEVE"\s+"([^"]+)"/);
        capabilities.sieveExtensions = matches?.[1]?.split(" ") || [];
        this.logger.debug(
          `Parsed SIEVE extensions: ${capabilities.sieveExtensions.join(", ")}`,
        );
      } else if (trimmedLine === '"STARTTLS"') {
        // STARTTLS is advertised as a single capability
        capabilities.sieveExtensions.push("STARTTLS");
        this.logger.debug("Added STARTTLS extension");
      }
      // Handle unquoted capability format: IMPLEMENTATION value
      else if (trimmedLine.startsWith("IMPLEMENTATION ")) {
        capabilities.implementation = trimmedLine
          .substring(14)
          .trim()
          .replace(/^"(.*)"$/, "$1");
        this.logger.debug(
          `Parsed unquoted implementation: ${capabilities.implementation}`,
        );
      } else if (trimmedLine.startsWith("VERSION ")) {
        capabilities.version = trimmedLine
          .substring(8)
          .trim()
          .replace(/^"(.*)"$/, "$1");
        this.logger.debug(`Parsed unquoted version: ${capabilities.version}`);
      } else if (trimmedLine.startsWith("SASL ")) {
        const saslValue = trimmedLine
          .substring(5)
          .trim()
          .replace(/^"(.*)"$/, "$1");
        capabilities.saslMechanisms = saslValue.split(" ");
        this.logger.debug(
          `Parsed unquoted SASL mechanisms: ${capabilities.saslMechanisms.join(", ")}`,
        );
      } else if (trimmedLine.startsWith("SIEVE ")) {
        const sieveValue = trimmedLine
          .substring(6)
          .trim()
          .replace(/^"(.*)"$/, "$1");
        capabilities.sieveExtensions = sieveValue.split(" ");
        this.logger.debug(
          `Parsed unquoted SIEVE extensions: ${capabilities.sieveExtensions.join(", ")}`,
        );
      } else if (trimmedLine === "STARTTLS") {
        capabilities.sieveExtensions.push("STARTTLS");
        this.logger.debug("Added unquoted STARTTLS extension");
      } else {
        this.logger.debug(`Ignoring capability line: ${trimmedLine}`);
      }
    }

    this.logger.debug(
      "Final parsed capabilities",
      {
        operation: "parseCapabilities",
        service: "SieveService",
      },
      {
        implementation: capabilities.implementation,
        version: capabilities.version,
        saslMechanisms: capabilities.saslMechanisms,
        sieveExtensions: capabilities.sieveExtensions,
      },
    );

    return capabilities;
  }

  private async ensureAuthenticated(): Promise<void> {
    if (!this.connected) {
      await this.connect();
    }
    if (!this.authenticated) {
      await this.authenticate();
    }
  }
}
