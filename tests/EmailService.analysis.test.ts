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

function makeService() {
  return new EmailService(
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
}

async function* iterate(items: unknown[]) {
  for (const item of items) yield item;
}

describe("EmailService analysis methods", () => {
  beforeEach(() => vi.clearAllMocks());

  it("searchAllFolders searches and fetches by UID (N10)", async () => {
    const connection = {
      search: vi.fn(async () => [7, 9]),
      fetch: vi.fn(() =>
        iterate([
          {
            uid: 9,
            flags: new Set<string>(),
            envelope: {
              subject: "s",
              from: [{ address: "a@b.example" }],
              to: [],
              date: new Date("2026-01-01T00:00:00Z"),
            },
          },
        ]),
      ),
    };
    mockPool.acquireForFolder.mockResolvedValue({ connection });
    const service = makeService();
    const result = await service.searchAllFolders({
      from: "b.example",
      folders: ["Spam"],
    });
    expect(connection.search).toHaveBeenCalledWith(
      { from: "b.example" },
      { uid: true },
    );
    expect(connection.fetch).toHaveBeenCalledWith([9, 7], expect.any(Object), {
      uid: true,
    });
    expect(result.totalMatches).toBe(2);
    expect(result.messages[0].folder).toBe("Spam");
  });

  it("getRawEmailChecked does not download messages over the limit (S5)", async () => {
    const connection = {
      fetchOne: vi.fn(async () => ({ uid: 5, size: 50 * 1024 * 1024 })),
      fetch: vi.fn(),
    };
    mockPool.acquireForFolder.mockResolvedValue({ connection });
    const result = await makeService().getRawEmailChecked(5, "INBOX", 1024);
    expect(result).toEqual({ status: "too_large", size: 50 * 1024 * 1024 });
    expect(connection.fetch).not.toHaveBeenCalled();
    expect(mockPool.releaseFromFolder).toHaveBeenCalled();
  });

  it("getRawEmailChecked reports not_found", async () => {
    const connection = { fetchOne: vi.fn(async () => false) };
    mockPool.acquireForFolder.mockResolvedValue({ connection });
    expect(await makeService().getRawEmailChecked(5, "INBOX", 1024)).toEqual({
      status: "not_found",
    });
  });

  it("getEmailHeaders fetches only the header block", async () => {
    const connection = {
      fetchOne: vi.fn(async () => ({
        uid: 5,
        headers: Buffer.from(
          "From: a@b.example\r\nReply-To: c@d.example\r\n\r\n",
        ),
      })),
    };
    mockPool.acquireForFolder.mockResolvedValue({ connection });
    const result = await makeService().getEmailHeaders(5, "INBOX");
    expect(connection.fetchOne).toHaveBeenCalledWith(
      "5",
      { uid: true, headers: true },
      { uid: true },
    );
    expect(result?.summary.replyToDiffersFromFrom).toBe(true);
  });

  it("getRawEmailChecked never downloads a message of unknown size", async () => {
    const connection = {
      fetchOne: vi.fn(async () => ({ uid: 5 })),
      fetch: vi.fn(),
    };
    mockPool.acquireForFolder.mockResolvedValue({ connection });
    expect(await makeService().getRawEmailChecked(5, "INBOX", 1024)).toEqual({
      status: "size_unknown",
    });
    expect(connection.fetch).not.toHaveBeenCalled();
  });

  it("getEmailHeaders cuts header blocks larger than 1 MB", async () => {
    const { MAX_HEADER_BLOCK_BYTES } = await import(
      "../src/services/EmailService.js"
    );
    const block = Buffer.from(
      `From: a@b.example\r\n${"X-Pad: y\r\n".repeat(200_000)}\r\n`,
    );
    expect(block.length).toBeGreaterThan(MAX_HEADER_BLOCK_BYTES);
    const connection = {
      fetchOne: vi.fn(async () => ({ uid: 5, headers: block })),
    };
    mockPool.acquireForFolder.mockResolvedValue({ connection });
    const result = await makeService().getEmailHeaders(5, "INBOX");
    expect(result?.headersTruncated).toBe(true);
    expect(result?.summary.from).toBe("a@b.example");
    expect(result?.headers.length).toBeLessThan(200_000);
  });
});
