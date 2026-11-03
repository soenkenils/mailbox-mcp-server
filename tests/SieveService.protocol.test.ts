import {
  type AddressInfo,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findResponseEnd,
  quoteSieveString,
  SieveService,
  tokenizeSieveData,
} from "../src/services/SieveService.js";

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    warning: vi.fn(),
  })),
}));

const GREETING_NO_TLS =
  '"IMPLEMENTATION" "fake"\r\n"SIEVE" "fileinto"\r\n"SASL" "PLAIN"\r\nOK "ready"\r\n';

type Handler = (line: string, socket: Socket) => void;

interface FakeServer {
  server: Server;
  port: number;
  received: string[];
}

const servers: Server[] = [];

/** Line-based fake ManageSieve server; `handler` answers each command line */
async function startServer(
  greeting: string,
  handler: Handler,
): Promise<FakeServer> {
  const received: string[] = [];
  const server = createServer(socket => {
    socket.write(greeting);
    let buffer = "";
    socket.on("data", data => {
      buffer += data.toString("latin1");
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        received.push(line);
        handler(line, socket);
        index = buffer.indexOf("\r\n");
      }
    });
    socket.on("error", () => {});
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    received,
  };
}

afterEach(async () => {
  while (servers.length) {
    const server = servers.pop();
    await new Promise<void>(resolve => server?.close(() => resolve()));
  }
});

const service = (port: number) =>
  new SieveService({
    host: "127.0.0.1",
    port,
    secure: false,
    user: "user@example.org",
    password: "not-a-real-password",
  });

/**
 * Framing tests run without TLS, so they skip authentication by marking the
 * session as authenticated after connecting. Production code never does
 * this: authenticate() requires TLS.
 */
async function connectedWithoutAuth(port: number): Promise<SieveService> {
  const sieve = service(port);
  await sieve.connect();
  (sieve as unknown as { authenticated: boolean }).authenticated = true;
  return sieve;
}

function literal(content: string): string {
  return `{${Buffer.byteLength(content, "utf8")}}\r\n${content}`;
}

describe("STARTTLS is mandatory without implicit TLS", () => {
  it("never sends AUTHENTICATE if the server does not offer STARTTLS", async () => {
    const fake = await startServer(GREETING_NO_TLS, (_line, socket) =>
      socket.write('OK "done"\r\n'),
    );
    const sieve = service(fake.port);
    await sieve.connect();
    await expect(sieve.authenticate()).rejects.toThrow(
      /does not offer STARTTLS/,
    );
    expect(fake.received.some(line => line.startsWith("AUTHENTICATE"))).toBe(
      false,
    );
    await expect(sieve.listScripts()).rejects.toThrow(/STARTTLS/);
    expect(fake.received.some(line => line.startsWith("AUTHENTICATE"))).toBe(
      false,
    );
    await sieve.disconnect();
  });

  it("does not authenticate when STARTTLS is refused", async () => {
    const fake = await startServer(
      '"IMPLEMENTATION" "fake"\r\n"STARTTLS"\r\nOK\r\n',
      (line, socket) => {
        if (line === "STARTTLS") socket.write('NO "not today"\r\n');
        else socket.write("OK\r\n");
      },
    );
    const sieve = service(fake.port);
    await sieve.connect();
    await expect(sieve.authenticate()).rejects.toThrow(/STARTTLS failed/);
    expect(fake.received.some(line => line.startsWith("AUTHENTICATE"))).toBe(
      false,
    );
    await sieve.disconnect();
  });
});

describe("literal-aware response framing", () => {
  const script =
    'require "vacation";\r\nvacation text:\r\nOK, thanks for your mail.\r\nBYE for now\r\nNO worries\r\n.\r\n;\r\n# Grüße ✓\r\n';

  it("returns a script containing OK/BYE/NO lines completely", async () => {
    const fake = await startServer(GREETING_NO_TLS, (line, socket) => {
      if (line.startsWith("GETSCRIPT")) {
        socket.write(`${literal(script)}\r\nOK "Getscript completed."\r\n`);
      } else {
        socket.write("OK\r\n");
      }
    });
    const sieve = await connectedWithoutAuth(fake.port);
    expect(await sieve.getScript("vacation")).toBe(script);
    await sieve.disconnect();
  });

  it("handles multi-byte characters split across TCP chunks", async () => {
    const payload = Buffer.from(`${literal(script)}\r\nOK "done"\r\n`, "utf8");
    const fake = await startServer(GREETING_NO_TLS, (line, socket) => {
      if (!line.startsWith("GETSCRIPT")) {
        socket.write("OK\r\n");
        return;
      }
      // Send byte by byte around the "ü" so it is split between chunks
      const split = payload.indexOf(Buffer.from("ü", "utf8")) + 1;
      socket.write(payload.subarray(0, split));
      setTimeout(() => socket.write(payload.subarray(split)), 20);
    });
    const sieve = await connectedWithoutAuth(fake.port);
    expect(await sieve.getScript("vacation")).toBe(script);
    await sieve.disconnect();
  });

  it("reports SETACTIVE NO after a long script as an error", async () => {
    const longScript = `${"# OK filler line\r\n".repeat(5000)}keep;\r\n`;
    const fake = await startServer(GREETING_NO_TLS, (line, socket) => {
      if (line.startsWith("GETSCRIPT")) {
        socket.write(`${literal(longScript)}\r\nOK\r\n`);
      } else if (line.startsWith("SETACTIVE")) {
        socket.write('NO "There is no script by that name"\r\n');
      } else {
        socket.write("OK\r\n");
      }
    });
    const sieve = await connectedWithoutAuth(fake.port);
    expect(await sieve.getScript("big")).toBe(longScript);
    await expect(sieve.setActiveScript("missing")).rejects.toThrow(
      /no script by that name/,
    );
    await sieve.disconnect();
  });

  it("closes the connection after a command timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const fake = await startServer(GREETING_NO_TLS, (line, socket) => {
        if (line === "LISTSCRIPTS") return; // never answer
        socket.write("OK\r\n");
      });
      const sieve = await connectedWithoutAuth(fake.port);
      const pending = sieve.listScripts();
      const assertion = expect(pending).rejects.toThrow(
        /Command timeout: LISTSCRIPTS/,
      );
      await vi.advanceTimersByTimeAsync(31000);
      await assertion;
      expect(sieve.isConnected()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LISTSCRIPTS parsing", () => {
  it("parses escaped quoted names and literal names", async () => {
    const fake = await startServer(GREETING_NO_TLS, (line, socket) => {
      if (line === "LISTSCRIPTS") {
        socket.write(
          `"say \\"hi\\"" ACTIVE\r\n"back\\\\slash"\r\n${literal("Grüße")}\r\n${literal("OK")} \r\nOK\r\n`,
        );
      } else {
        socket.write("OK\r\n");
      }
    });
    const sieve = await connectedWithoutAuth(fake.port);
    const scripts = await sieve.listScripts();
    expect(scripts).toEqual([
      { name: 'say "hi"', content: "", active: true },
      { name: "back\\slash", content: "", active: false },
      { name: "Grüße", content: "", active: false },
      { name: "OK", content: "", active: false },
    ]);
    await sieve.disconnect();
  });
});

describe("framing helpers", () => {
  it("finds the response end only outside literals", () => {
    const buf = Buffer.from(`${literal("OK\r\nBYE\r\n")}\r\nOK\r\n`);
    const end = findResponseEnd(buf);
    expect(end?.end).toBe(buf.length);
    expect(findResponseEnd(buf.subarray(0, buf.length - 2))).toBeNull();
  });

  it("tokenizes quoted strings, literals and atoms", () => {
    const tokens = tokenizeSieveData(
      Buffer.from(`"a\\"b" {3}\r\nxyz ACTIVE\r\n`),
    );
    expect(tokens).toEqual([
      [
        { kind: "string", value: 'a"b' },
        { kind: "string", value: "xyz" },
        { kind: "atom", value: "ACTIVE" },
      ],
    ]);
  });
});

describe("sieve-name restrictions (RFC 5804)", () => {
  it.each([
    ["C1 control", "a\u0085b"],
    ["line separator", "a b"],
    ["paragraph separator", "a b"],
    ["byte order mark", "﻿name"],
    ["lone surrogate", "a\ud800b"],
  ])("rejects %s", (_label, name) => {
    expect(() => quoteSieveString(name)).toThrow(/Invalid script name/);
  });

  it("accepts ordinary Unicode names", () => {
    expect(quoteSieveString("Grüße ✓")).toBe('"Grüße ✓"');
  });
});
