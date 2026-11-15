import { readFileSync } from "node:fs";
import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SieveService } from "../src/services/SieveService.js";

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warning: vi.fn(),
  })),
}));

// Test-only dummy self-signed certificate (see tests/fixtures/)
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
const KEY = read("test-tls-key.pem");
const CERT = read("test-tls-cert.pem");

// STARTTLS deliberately comes before SIEVE: RFC 5804 allows any order
const PRE_TLS_GREETING =
  '"IMPLEMENTATION" "fake-pre-tls"\r\n"STARTTLS"\r\n"SIEVE" "fileinto"\r\nOK "ready"\r\n';
const POST_TLS_CAPS =
  '"IMPLEMENTATION" "fake-post-tls"\r\n"SASL" "PLAIN"\r\n"SIEVE" "fileinto vacation"\r\nOK "ready"\r\n';

interface FakeServer {
  port: number;
  /** Command lines received, in order */
  received: string[];
  /** Command lines received after the TLS handshake */
  receivedSecure: string[];
}

const servers: Server[] = [];
const sockets = new Set<Socket>();

/**
 * Fake ManageSieve server on 127.0.0.1 that upgrades to TLS on STARTTLS.
 * `afterTls` is what the server sends once the handshake is complete.
 */
async function startTlsServer(afterTls: string): Promise<FakeServer> {
  const fake: FakeServer = { port: 0, received: [], receivedSecure: [] };
  const server = createServer(raw => {
    sockets.add(raw);
    raw.on("error", () => {});
    raw.write(PRE_TLS_GREETING);
    const onPlain = (data: Buffer) => {
      for (const line of data.toString("latin1").split("\r\n")) {
        if (!line) continue;
        fake.received.push(line);
        if (line === "STARTTLS") {
          raw.off("data", onPlain);
          raw.write('OK "Begin TLS negotiation now."\r\n');
          const secure = new TLSSocket(raw, {
            isServer: true,
            key: KEY,
            cert: CERT,
          });
          secure.on("error", () => {});
          secure.on("secure", () => secure.write(afterTls));
          secure.on("data", (chunk: Buffer) => {
            for (const secureLine of chunk.toString("latin1").split("\r\n")) {
              if (!secureLine) continue;
              fake.received.push(secureLine);
              fake.receivedSecure.push(secureLine);
              if (secureLine.startsWith("AUTHENTICATE")) {
                secure.write('OK "Logged in."\r\n');
              } else if (secureLine === "LISTSCRIPTS") {
                secure.write('"vacation" ACTIVE\r\n"filters"\r\nOK\r\n');
              } else {
                secure.write("OK\r\n");
              }
            }
          });
        } else {
          raw.write("OK\r\n");
        }
      }
    };
    raw.on("data", onPlain);
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  fake.port = (server.address() as AddressInfo).port;
  return fake;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  while (servers.length) {
    const server = servers.pop();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }
});

const client = (port: number, trustTestCa: boolean) =>
  new SieveService(
    {
      host: "127.0.0.1",
      port,
      secure: false,
      user: "user@example.org",
      password: "not-a-real-password",
    },
    trustTestCa ? { tlsCa: CERT } : {},
  );

const authLines = (lines: string[]) =>
  lines.filter(line => line.startsWith("AUTHENTICATE"));

describe("STARTTLS upgrade", () => {
  it("authenticates after the upgrade and reads the right LISTSCRIPTS answer", async () => {
    const fake = await startTlsServer(POST_TLS_CAPS);
    const sieve = client(fake.port, true);
    await sieve.connect();

    // Greeting capabilities, with STARTTLS listed before SIEVE
    expect(sieve.getServerCapabilities()?.implementation).toBe("fake-pre-tls");
    expect(sieve.getServerCapabilities()?.sieveExtensions).toContain(
      "STARTTLS",
    );

    await sieve.authenticate();
    expect(sieve.isAuthenticated()).toBe(true);

    // Capabilities after TLS replace the ones from the plaintext greeting
    const caps = sieve.getServerCapabilities();
    expect(caps?.implementation).toBe("fake-post-tls");
    expect(caps?.sieveExtensions).toEqual(["fileinto", "vacation"]);

    // AUTHENTICATE only went over the encrypted channel, once
    expect(authLines(fake.received)).toHaveLength(1);
    expect(authLines(fake.receivedSecure)).toEqual([
      // SASL PLAIN (RFC 4616): base64 of NUL authcid NUL password
      `AUTHENTICATE "PLAIN" "${Buffer.from("\0user@example.org\0not-a-real-password").toString("base64")}"`,
    ]);

    // Not shifted by one response: LISTSCRIPTS gets its own answer
    expect(await sieve.listScripts()).toEqual([
      { name: "vacation", content: "", active: true },
      { name: "filters", content: "", active: false },
    ]);
    await sieve.disconnect();
  });

  it("rejects a self-signed certificate and never sends AUTHENTICATE", async () => {
    const fake = await startTlsServer(POST_TLS_CAPS);
    const sieve = client(fake.port, false);
    await sieve.connect();

    await expect(sieve.authenticate()).rejects.toThrow(/TLS upgrade failed/);
    expect(authLines(fake.received)).toHaveLength(0);
    expect(sieve.isConnected()).toBe(false);
    expect(sieve.isAuthenticated()).toBe(false);
  });

  it("tears the session down when the server answers NO after TLS", async () => {
    const fake = await startTlsServer('NO "Go away"\r\n');
    const sieve = client(fake.port, true);
    await sieve.connect();

    await expect(sieve.authenticate()).rejects.toThrow(
      /rejected session after STARTTLS: Go away/,
    );
    // No half-open session with stale (pre-TLS) capabilities
    expect(sieve.isConnected()).toBe(false);
    expect(sieve.isAuthenticated()).toBe(false);
    expect(sieve.getServerCapabilities()).toBeNull();
    expect(authLines(fake.received)).toHaveLength(0);
  });
});
