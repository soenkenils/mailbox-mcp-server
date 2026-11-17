import { type AddressInfo, createServer } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SieveService } from "../src/services/SieveService.js";
import type {
  SieveCapabilities,
  SieveConnection,
  SieveScript,
} from "../src/types/sieve.types.js";

// Private methods of SieveService reached by these tests
type SieveServicePrivates = {
  parseScriptList(data: string): SieveScript[];
  parseCapabilities(data: string): SieveCapabilities;
};

// Testable subclass to access private methods
class TestableSieveService extends SieveService {
  public testParseScriptList(data: string): SieveScript[] {
    return (this as unknown as SieveServicePrivates).parseScriptList(data);
  }

  public testParseCapabilities(data: string): SieveCapabilities {
    return (this as unknown as SieveServicePrivates).parseCapabilities(data);
  }
}

// Mock the logger
vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  })),
}));

describe("SieveService", () => {
  let sieveService: SieveService;

  const mockConfig: SieveConnection = {
    host: "imap.mailbox.org",
    port: 4190,
    secure: false,
    user: "test@mailbox.org",
    password: "test-password",
  };

  beforeEach(() => {
    sieveService = new SieveService(mockConfig);
  });

  describe("connection management", () => {
    it("should start in disconnected state", () => {
      expect(sieveService.isConnected()).toBe(false);
      expect(sieveService.isAuthenticated()).toBe(false);
    });

    it("should expose server capabilities getter", () => {
      const capabilities = sieveService.getServerCapabilities();
      expect(capabilities).toBeNull();
    });
  });

  describe("parseScriptList", () => {
    it("should parse a LISTSCRIPTS response", () => {
      const service = new TestableSieveService(mockConfig);
      const scripts = service.testParseScriptList(
        '"script1" ACTIVE\r\n"script2"\r\n"Spëcial müller"\r\nOK "Listscripts completed."\r\n',
      );
      expect(scripts).toEqual([
        { name: "script1", content: "", active: true },
        { name: "script2", content: "", active: false },
        { name: "Spëcial müller", content: "", active: false },
      ]);
    });
  });

  describe("parseCapabilities", () => {
    it("should parse a Dovecot capability response", () => {
      const service = new TestableSieveService(mockConfig);
      const capabilities = service.testParseCapabilities(
        '"IMPLEMENTATION" "Dovecot Pigeonhole"\r\n"VERSION" "1.0"\r\n"SASL" "PLAIN LOGIN"\r\n"SIEVE" "fileinto envelope body"\r\n"STARTTLS"\r\nOK "Capability completed."\r\n',
      );
      expect(capabilities).toEqual({
        implementation: "Dovecot Pigeonhole",
        version: "1.0",
        saslMechanisms: ["PLAIN", "LOGIN"],
        sieveExtensions: ["fileinto", "envelope", "body", "STARTTLS"],
      });
    });
  });

  describe("error handling", () => {
    it("should require connection before authentication", async () => {
      await expect(sieveService.authenticate()).rejects.toThrow(
        "Not connected to server",
      );
    });

    it("should require authentication before operations", async () => {
      // ensureAuthenticated should connect and authenticate if needed.
      // Use a local closed port so the test is hermetic and fails fast
      // (ECONNREFUSED) instead of depending on network access to mailbox.org.
      const offlineService = new SieveService({
        ...mockConfig,
        host: "127.0.0.1",
        port: 1,
      });
      await expect(offlineService.listScripts()).rejects.toThrow();
    });
  });

  describe("connection state management", () => {
    it("should track connection state", () => {
      expect(sieveService.isConnected()).toBe(false);

      // After successful connection, isConnected() should return true
      // This would be tested in real integration tests
    });

    it("should track authentication state", () => {
      expect(sieveService.isAuthenticated()).toBe(false);

      // After successful authentication, isAuthenticated() should return true
      // This would be tested in real integration tests
    });

    it("should reset state on disconnect", async () => {
      await sieveService.disconnect();

      expect(sieveService.isConnected()).toBe(false);
      expect(sieveService.isAuthenticated()).toBe(false);
      expect(sieveService.getServerCapabilities()).toBeNull();
    });
  });

  describe("edge cases", () => {
    it("should handle multiple connects gracefully", async () => {
      // A second connect() while connected must not open another socket
      let connections = 0;
      const server = createServer(socket => {
        connections++;
        socket.write('"IMPLEMENTATION" "fake"\r\nOK\r\n');
        socket.on("data", () => socket.write("OK\r\n"));
        socket.on("error", () => {});
      });
      await new Promise<void>(resolve =>
        server.listen(0, "127.0.0.1", resolve),
      );
      try {
        const local = new SieveService({
          ...mockConfig,
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
        });
        await local.connect();
        await local.connect();
        expect(local.isConnected()).toBe(true);
        expect(connections).toBe(1);
        await local.disconnect();
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });

    it("should handle disconnect when not connected", async () => {
      await expect(sieveService.disconnect()).resolves.not.toThrow();
    });
  });

  describe("parseScriptList - branch coverage", () => {
    let testableService: TestableSieveService;

    beforeEach(() => {
      testableService = new TestableSieveService(mockConfig);
    });

    it.each([
      [
        "quoted script with ACTIVE",
        '"script1" ACTIVE\r\nOK',
        [{ name: "script1", content: "", active: true }],
      ],
      [
        "quoted script without ACTIVE",
        '"script2"\r\nOK',
        [{ name: "script2", content: "", active: false }],
      ],
      [
        "multiple quoted scripts",
        '"script1" ACTIVE\r\n"script2"\r\n"script3" ACTIVE\r\nOK',
        [
          { name: "script1", content: "", active: true },
          { name: "script2", content: "", active: false },
          { name: "script3", content: "", active: true },
        ],
      ],
    ])("should parse %s", (_description: string, input: string, expected: SieveScript[]) => {
      const result = testableService.testParseScriptList(input);
      expect(result).toEqual(expected);
    });

    it.each([
      [
        "unquoted script with ACTIVE",
        "script1 ACTIVE\r\nOK",
        [{ name: "script1", content: "", active: true }],
      ],
      [
        "unquoted script without ACTIVE",
        "script2\r\nOK",
        [{ name: "script2", content: "", active: false }],
      ],
      [
        "mixed quoted and unquoted",
        '"quoted" ACTIVE\r\nunquoted\r\nOK',
        [
          { name: "quoted", content: "", active: true },
          { name: "unquoted", content: "", active: false },
        ],
      ],
    ])("should parse %s", (_description: string, input: string, expected: SieveScript[]) => {
      const result = testableService.testParseScriptList(input);
      expect(result).toEqual(expected);
    });

    it("should not treat a bare ACTIVE line as a script", () => {
      const result = testableService.testParseScriptList(
        "script1\r\nACTIVE\r\nOK",
      );

      expect(result).toEqual([{ name: "script1", content: "", active: false }]);
    });

    it.each([
      ["empty response", "OK", []],
      ["only OK line", "OK Listscripts completed\r\n", []],
      ["only NO line", "NO Failed\r\n", []],
      ["whitespace lines", "\r\n\r\n\r\nOK", []],
    ])("should handle %s", (_description: string, input: string, expected: SieveScript[]) => {
      const result = testableService.testParseScriptList(input);
      expect(result).toEqual(expected);
    });

    it("should skip lines starting with OK or NO", () => {
      // OK and NO lines are status responses, not script names
      const input = '"script1"\r\nOK Some text\r\n"script2"\r\n';
      const result = testableService.testParseScriptList(input);

      // Both scripts are parsed (OK line is skipped)
      expect(result.length).toBe(2);
      expect(result[0].name).toBe("script1");
      expect(result[1].name).toBe("script2");
    });
  });

  describe("parseCapabilities - branch coverage", () => {
    let testableService: TestableSieveService;

    beforeEach(() => {
      testableService = new TestableSieveService(mockConfig);
    });

    it.each([
      [
        "quoted IMPLEMENTATION",
        '"IMPLEMENTATION" "Dovecot Pigeonhole"\r\nOK',
        {
          implementation: "Dovecot Pigeonhole",
          version: "",
          saslMechanisms: [],
          sieveExtensions: [],
        },
      ],
      [
        "quoted VERSION",
        '"VERSION" "1.0"\r\nOK',
        {
          implementation: "",
          version: "1.0",
          saslMechanisms: [],
          sieveExtensions: [],
        },
      ],
      [
        "quoted SASL",
        '"SASL" "PLAIN LOGIN"\r\nOK',
        {
          implementation: "",
          version: "",
          saslMechanisms: ["PLAIN", "LOGIN"],
          sieveExtensions: [],
        },
      ],
      [
        "quoted SIEVE",
        '"SIEVE" "fileinto envelope body"\r\nOK',
        {
          implementation: "",
          version: "",
          saslMechanisms: [],
          sieveExtensions: ["fileinto", "envelope", "body"],
        },
      ],
      [
        "quoted STARTTLS",
        '"STARTTLS"\r\nOK',
        {
          implementation: "",
          version: "",
          saslMechanisms: [],
          sieveExtensions: ["STARTTLS"],
        },
      ],
    ])("should parse %s", (_description: string, input: string, expected: SieveCapabilities) => {
      const result = testableService.testParseCapabilities(input);
      expect(result).toEqual(expected);
    });

    it.each([
      [
        "unquoted IMPLEMENTATION",
        'IMPLEMENTATION "Dovecot"\r\nOK',
        {
          implementation: "Dovecot",
          version: "",
          saslMechanisms: [],
          sieveExtensions: [],
        },
      ],
      [
        "unquoted VERSION",
        'VERSION "2.0"\r\nOK',
        {
          implementation: "",
          version: "2.0",
          saslMechanisms: [],
          sieveExtensions: [],
        },
      ],
      [
        "unquoted SASL",
        'SASL "PLAIN"\r\nOK',
        {
          implementation: "",
          version: "",
          saslMechanisms: ["PLAIN"],
          sieveExtensions: [],
        },
      ],
      [
        "unquoted SIEVE",
        'SIEVE "fileinto"\r\nOK',
        {
          implementation: "",
          version: "",
          saslMechanisms: [],
          sieveExtensions: ["fileinto"],
        },
      ],
      [
        "unquoted STARTTLS",
        "STARTTLS\r\nOK",
        {
          implementation: "",
          version: "",
          saslMechanisms: [],
          sieveExtensions: ["STARTTLS"],
        },
      ],
    ])("should parse %s", (_description: string, input: string, expected: SieveCapabilities) => {
      const result = testableService.testParseCapabilities(input);
      expect(result).toEqual(expected);
    });

    it.each([
      [
        "complete quoted capabilities",
        '"IMPLEMENTATION" "Dovecot Pigeonhole"\r\n"VERSION" "1.0"\r\n"SASL" "PLAIN LOGIN"\r\n"SIEVE" "fileinto envelope"\r\n"STARTTLS"\r\nOK',
        {
          implementation: "Dovecot Pigeonhole",
          version: "1.0",
          saslMechanisms: ["PLAIN", "LOGIN"],
          sieveExtensions: ["fileinto", "envelope", "STARTTLS"],
        },
      ],
      [
        "complete unquoted capabilities",
        'IMPLEMENTATION "Cyrus"\r\nVERSION "2.0"\r\nSASL "PLAIN"\r\nSIEVE "fileinto"\r\nSTARTTLS\r\nOK',
        {
          implementation: "Cyrus",
          version: "2.0",
          saslMechanisms: ["PLAIN"],
          sieveExtensions: ["fileinto", "STARTTLS"],
        },
      ],
      [
        "STARTTLS listed before SIEVE (quoted)",
        '"IMPLEMENTATION" "Dovecot"\r\n"STARTTLS"\r\n"SIEVE" "fileinto envelope"\r\nOK',
        {
          implementation: "Dovecot",
          version: "",
          saslMechanisms: [],
          sieveExtensions: ["fileinto", "envelope", "STARTTLS"],
        },
      ],
      [
        "STARTTLS listed before SIEVE (unquoted)",
        'IMPLEMENTATION "Cyrus"\r\nSTARTTLS\r\nSIEVE "fileinto"\r\nOK',
        {
          implementation: "Cyrus",
          version: "",
          saslMechanisms: [],
          sieveExtensions: ["fileinto", "STARTTLS"],
        },
      ],
      [
        "mixed quoted and unquoted",
        '"IMPLEMENTATION" "Dovecot"\r\nVERSION "1.0"\r\n"SASL" "PLAIN"\r\nSIEVE "fileinto"\r\nOK',
        {
          implementation: "Dovecot",
          version: "1.0",
          saslMechanisms: ["PLAIN"],
          sieveExtensions: ["fileinto"],
        },
      ],
    ])("should parse %s", (_description: string, input: string, expected: SieveCapabilities) => {
      const result = testableService.testParseCapabilities(input);
      expect(result).toEqual(expected);
    });

    it.each([
      [
        "empty response",
        "OK",
        {
          implementation: "",
          version: "",
          saslMechanisms: [],
          sieveExtensions: [],
        },
      ],
      [
        "whitespace lines",
        "\r\n\r\n\r\nOK",
        {
          implementation: "",
          version: "",
          saslMechanisms: [],
          sieveExtensions: [],
        },
      ],
      [
        "unknown capability line",
        "UNKNOWN_CAP value\r\nOK",
        {
          implementation: "",
          version: "",
          saslMechanisms: [],
          sieveExtensions: [],
        },
      ],
    ])("should handle %s", (_description: string, input: string, expected: SieveCapabilities) => {
      const result = testableService.testParseCapabilities(input);
      expect(result).toEqual(expected);
    });
  });
});

describe("SieveService command safety", () => {
  it("quotes names and escapes quote and backslash", async () => {
    const { quoteSieveString } = await import(
      "../src/services/SieveService.js"
    );
    expect(quoteSieveString("filter")).toBe('"filter"');
    expect(quoteSieveString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });

  it.each([
    'x"\r\nDELETESCRIPT "victim',
    "a\nb",
    "a\u0000b",
    "a\u007fb",
  ])("rejects control characters in script names (%j)", async name => {
    const { quoteSieveString } = await import(
      "../src/services/SieveService.js"
    );
    expect(() => quoteSieveString(name)).toThrow(/control characters/);
  });

  it("rejects an injected name before connecting to the server", async () => {
    const service = new SieveService({
      host: "127.0.0.1",
      port: 1,
      secure: false,
      user: "test@example.org",
      password: "not-a-real-password",
    });
    for (const call of [
      () => service.getScript('x"\r\nDELETESCRIPT "victim'),
      () => service.deleteScript("a\r\nLOGOUT"),
      () => service.setActiveScript("a\nb"),
      () => service.putScript("a\rb", "keep;"),
    ]) {
      await expect(call()).rejects.toThrow(/control characters/);
    }
  });

  it("never exposes more than the command verb", async () => {
    const { commandVerb } = await import("../src/services/SieveService.js");
    const auth = `AUTHENTICATE "PLAIN" "${Buffer.from("\0u\0secret").toString("base64")}"`;
    expect(commandVerb(auth)).toBe("AUTHENTICATE");
    expect(commandVerb('PUTSCRIPT "x" {5+}\r\nkeep;')).toBe("PUTSCRIPT");
    expect(commandVerb("CHECKSCRIPT {5+}\r\nkeep;")).toBe("CHECKSCRIPT");
  });
});
