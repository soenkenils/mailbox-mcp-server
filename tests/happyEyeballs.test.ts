import { EventEmitter } from "node:events";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type HostResolver,
  isIpLiteral,
  resolveReachableHost,
} from "../src/utils/happyEyeballs.js";

const resolverWith = (v4: string[], v6: string[]): HostResolver => ({
  resolve4: vi.fn().mockResolvedValue(v4),
  resolve6: vi.fn().mockResolvedValue(v6),
});

/** A socket stand-in whose events the test fires by hand */
class FakeSocket extends EventEmitter {
  destroyed = false;
  destroy() {
    this.destroyed = true;
    return this;
  }
}

const fakeConnect = () => {
  const sockets = new Map<string, FakeSocket>();
  vi.spyOn(net, "connect").mockImplementation(((options: { host: string }) => {
    const socket = new FakeSocket();
    sockets.set(options.host, socket);
    return socket;
  }) as unknown as typeof net.connect);
  return sockets;
};

describe("isIpLiteral", () => {
  it("should detect IPv4 and IPv6 literals", () => {
    expect(isIpLiteral("192.0.2.10")).toBe(true);
    expect(isIpLiteral("2001:db8::1")).toBe(true);
  });

  it("should not treat hostnames as IP literals", () => {
    expect(isIpLiteral("smtp.example.com")).toBe(false);
    expect(isIpLiteral("123.example")).toBe(false);
  });
});

describe("resolveReachableHost", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return an IP literal unchanged without resolving it", async () => {
    const resolver = resolverWith([], []);
    await expect(
      resolveReachableHost("192.0.2.10", 465, 1000, resolver),
    ).resolves.toBe("192.0.2.10");
    expect(resolver.resolve4).not.toHaveBeenCalled();
  });

  it("should return the hostname when it has no A or AAAA records", async () => {
    const resolver: HostResolver = {
      resolve4: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
      resolve6: vi.fn().mockRejectedValue(new Error("ENOTFOUND")),
    };
    await expect(
      resolveReachableHost("smtp.example.com", 465, 1000, resolver),
    ).resolves.toBe("smtp.example.com");
  });

  it("should return the address that accepts a connection", async () => {
    const server = net.createServer(socket => socket.destroy());
    await new Promise<void>(resolve =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as net.AddressInfo;
    try {
      await expect(
        resolveReachableHost(
          "smtp.example.com",
          port,
          2000,
          resolverWith(["127.0.0.1"], []),
        ),
      ).resolves.toBe("127.0.0.1");
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("should fall back to the hostname when no address is reachable", async () => {
    // Bind and close a port so nothing listens on it
    const server = net.createServer();
    await new Promise<void>(resolve =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    const { port } = server.address() as net.AddressInfo;
    await new Promise<void>(resolve => server.close(() => resolve()));

    await expect(
      resolveReachableHost(
        "smtp.example.com",
        port,
        2000,
        resolverWith(["127.0.0.1"], []),
      ),
    ).resolves.toBe("smtp.example.com");
  });

  it("should pick the other family when one fails", async () => {
    const sockets = fakeConnect();
    const pending = resolveReachableHost(
      "smtp.example.com",
      465,
      1000,
      resolverWith(["192.0.2.10"], ["2001:db8::10"]),
    );
    await vi.waitFor(() => expect(sockets.size).toBe(2));

    sockets.get("2001:db8::10")?.emit("error", new Error("ENETUNREACH"));
    sockets.get("192.0.2.10")?.emit("connect");

    await expect(pending).resolves.toBe("192.0.2.10");
  });

  it("should count a socket that times out and then errors only once", async () => {
    const sockets = fakeConnect();
    const pending = resolveReachableHost(
      "smtp.example.com",
      465,
      1000,
      resolverWith(["192.0.2.10"], ["2001:db8::10"]),
    );
    await vi.waitFor(() => expect(sockets.size).toBe(2));

    // IPv6 times out and later also reports an error. That must not end
    // the race while IPv4 is still connecting.
    const v6 = sockets.get("2001:db8::10");
    v6?.emit("timeout");
    v6?.emit("error", new Error("ETIMEDOUT"));
    sockets.get("192.0.2.10")?.emit("connect");

    await expect(pending).resolves.toBe("192.0.2.10");
  });

  it("should close all probe sockets once a winner is found", async () => {
    const sockets = fakeConnect();
    const pending = resolveReachableHost(
      "smtp.example.com",
      465,
      1000,
      resolverWith(["192.0.2.10"], ["2001:db8::10"]),
    );
    await vi.waitFor(() => expect(sockets.size).toBe(2));

    sockets.get("2001:db8::10")?.emit("connect");
    await expect(pending).resolves.toBe("2001:db8::10");

    expect([...sockets.values()].every(socket => socket.destroyed)).toBe(true);
  });
});
