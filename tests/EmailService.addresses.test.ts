import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPool = {
  acquire: vi.fn(),
  acquireForFolder: vi.fn(),
  release: vi.fn(),
  releaseFromFolder: vi.fn(),
  destroy: vi.fn(),
};

vi.mock("../src/services/ImapConnectionPool.js", () => ({
  // biome-ignore lint/complexity/useArrowFunction: vitest mocks need a constructor
  ImapConnectionPool: vi.fn(function () {
    return mockPool;
  }),
}));

vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

import { EmailService } from "../src/services/EmailService.js";
import type { LocalCache } from "../src/types/cache.types.js";

const cache = {
  get: vi.fn(() => null),
  set: vi.fn(),
  delete: vi.fn(),
  clear: vi.fn(),
  has: vi.fn(() => false),
  getStats: vi.fn(),
  cleanup: vi.fn(),
} as unknown as LocalCache;

const makeService = () =>
  new EmailService(
    {
      user: "u@example.org",
      password: "dummy",
      host: "imap.example",
      port: 993,
      secure: true,
    },
    cache,
    {
      minConnections: 1,
      maxConnections: 2,
      acquireTimeoutMs: 1000,
      idleTimeoutMs: 1000,
    } as never,
  );

async function* iterate(items: unknown[]) {
  for (const item of items) yield item;
}

const useRawMessage = (raw: string) => {
  const connection = {
    fetch: vi.fn(() =>
      iterate([
        { uid: 101, flags: new Set<string>(), source: Buffer.from(raw) },
      ]),
    ),
  };
  mockPool.acquireForFolder.mockResolvedValue({
    connection,
    isHealthy: true,
  });
};

const SENT_MAIL = [
  "From: Erika Musterfrau <erika@sender.example>",
  "To: Anna Gärtner <anna@amt.example>, bert@amt.example",
  "Cc: Team: carla@team.example, dora@team.example;, Emil <emil@team.example>",
  "Bcc: archiv@sender.example",
  "Subject: Freie Kapazitaeten",
  "Date: Mon, 02 Mar 2026 09:00:00 +0100",
  "Message-ID: <m1@sender.example>",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "Hallo zusammen",
  "",
].join("\r\n");

describe("EmailService address parsing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("should return From, To, Cc and Bcc when mailparser yields address objects", async () => {
    useRawMessage(SENT_MAIL);

    const email = await makeService().getEmail(101, "Gesendete Objekte");

    expect(email?.from).toEqual([
      { name: "Erika Musterfrau", address: "erika@sender.example" },
    ]);
    expect(email?.to).toEqual([
      { name: "Anna Gärtner", address: "anna@amt.example" },
      { name: undefined, address: "bert@amt.example" },
    ]);
    expect(email?.bcc).toEqual([
      { name: undefined, address: "archiv@sender.example" },
    ]);
  });

  it("should flatten address groups into their members", async () => {
    useRawMessage(SENT_MAIL);

    const email = await makeService().getEmail(101, "Gesendete Objekte");

    expect(email?.cc?.map(a => a.address)).toEqual([
      "carla@team.example",
      "dora@team.example",
      "emil@team.example",
    ]);
  });

  it("should return empty lists when address headers are missing", async () => {
    useRawMessage(
      "Subject: ohne Adressen\r\nContent-Type: text/plain\r\n\r\nx\r\n",
    );

    const email = await makeService().getEmail(101);

    expect(email?.from).toEqual([]);
    expect(email?.to).toEqual([]);
    expect(email?.cc).toEqual([]);
  });
});
