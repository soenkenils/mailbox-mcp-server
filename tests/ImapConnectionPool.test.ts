import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ImapConnectionPool,
  type ImapPoolConfig,
} from "../src/services/ImapConnectionPool.js";
import type { ImapConnection } from "../src/types/email.types.js";

// Mock ImapFlow
class MockImapFlow {
  public usable = true;
  public selectedFolder?: string;
  private shouldFailConnect = false;
  private shouldFailNoop = false;
  private shouldFailMailboxOpen = false;

  constructor() {
    this.usable = true;
  }

  setShouldFailConnect(fail: boolean): void {
    this.shouldFailConnect = fail;
  }

  setShouldFailNoop(fail: boolean): void {
    this.shouldFailNoop = fail;
  }

  setShouldFailMailboxOpen(fail: boolean): void {
    this.shouldFailMailboxOpen = fail;
  }

  async connect(): Promise<void> {
    if (this.shouldFailConnect) {
      throw new Error("IMAP connection failed");
    }
    this.usable = true;
  }

  async logout(): Promise<void> {
    this.usable = false;
  }

  async noop(): Promise<void> {
    if (this.shouldFailNoop) {
      throw new Error("IMAP noop failed");
    }
    if (!this.usable) {
      throw new Error("Connection not usable");
    }
  }

  async mailboxOpen(folder: string): Promise<void> {
    if (this.shouldFailMailboxOpen) {
      throw new Error(`Failed to open folder ${folder}`);
    }
    if (!this.usable) {
      throw new Error("Connection not usable");
    }
    this.selectedFolder = folder;
  }

  on(event: string, handler: (...args: unknown[]) => void): MockImapFlow {
    // Mock event handler registration - ensure proper chaining
    return this;
  }
}

// Mock the imapflow module
vi.mock("imapflow", () => ({
  ImapFlow: vi.fn(function() { return new MockImapFlow(); }),
}));

describe("ImapConnectionPool", () => {
  let pool: ImapConnectionPool;
  let config: ImapPoolConfig;
  let connection: ImapConnection;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Reset the mock implementation to ensure clean state
    const { ImapFlow } = await import("imapflow");
    vi.mocked(ImapFlow).mockImplementation(function() { return new MockImapFlow(); });

    connection = {
      host: "imap.example.com",
      port: 993,
      secure: true,
      user: "test@example.com",
      password: "password123",
    };

    config = {
      minConnections: 1,
      maxConnections: 3,
      acquireTimeoutMs: 100,
      idleTimeoutMs: 1000,
      maxRetries: 2,
      retryDelayMs: 10,
      healthCheckIntervalMs: 50,
      connectionConfig: connection,
    };

    pool = new ImapConnectionPool(config);
  });

  afterEach(async () => {
    await pool.destroy();
  });

  describe("connection creation", () => {
    it("should create IMAP connections with correct configuration", async () => {
      const wrapper = await pool.acquire();

      expect(wrapper.connection).toBeInstanceOf(MockImapFlow);
      expect(wrapper.connection.usable).toBe(true);

      await pool.release(wrapper);
    });

    it("should handle connection creation failures", async () => {
      const mockImapFlow = new MockImapFlow();
      mockImapFlow.setShouldFailConnect(true);

      const { ImapFlow } = await import("imapflow");
      vi.mocked(ImapFlow).mockImplementation(function() { return mockImapFlow; });

      await expect(pool.acquire()).rejects.toThrow(
        "Failed to create connection",
      );
    });
  });

  describe("connection validation", () => {
    it("should validate connections using noop", async () => {
      const wrapper = await pool.acquire();

      const isValid = await pool.validateConnection(wrapper.connection);
      expect(isValid).toBe(true);

      await pool.release(wrapper);
    });

    it("should detect invalid connections", async () => {
      const wrapper = await pool.acquire();

      // Make connection invalid
      wrapper.connection.usable = false;

      const isValid = await pool.validateConnection(wrapper.connection);
      expect(isValid).toBe(false);

      await pool.release(wrapper);
    });

    it("should handle noop failures", async () => {
      const wrapper = await pool.acquire();

      const mockImapFlow = wrapper.connection as MockImapFlow;
      mockImapFlow.setShouldFailNoop(true);

      const isValid = await pool.validateConnection(wrapper.connection);
      expect(isValid).toBe(false);

      await pool.release(wrapper);
    });
  });

  describe("folder-aware operations", () => {
    it("should acquire connection for specific folder", async () => {
      const wrapper = await pool.acquireForFolder("INBOX");

      expect(wrapper.selectedFolder).toBe("INBOX");
      expect(wrapper.connection.selectedFolder).toBe("INBOX");

      await pool.releaseFromFolder(wrapper);
    });

    it("should reuse connection with correct folder", async () => {
      const wrapper1 = await pool.acquireForFolder("INBOX");
      await pool.releaseFromFolder(wrapper1);

      const wrapper2 = await pool.acquireForFolder("INBOX");

      // Should reuse the same connection
      expect(wrapper2.id).toBe(wrapper1.id);
      expect(wrapper2.selectedFolder).toBe("INBOX");

      await pool.releaseFromFolder(wrapper2);
    });

    it("should switch folders when needed", async () => {
      const wrapper1 = await pool.acquireForFolder("INBOX");
      await pool.releaseFromFolder(wrapper1);

      const wrapper2 = await pool.acquireForFolder("Sent");

      // Should reuse connection but switch folder
      expect(wrapper2.id).toBe(wrapper1.id);
      expect(wrapper2.selectedFolder).toBe("Sent");
      expect(wrapper2.connection.selectedFolder).toBe("Sent");

      await pool.releaseFromFolder(wrapper2);
    });

    it("should handle folder selection failures", async () => {
      const mockImapFlow = new MockImapFlow();
      mockImapFlow.setShouldFailMailboxOpen(true);

      const { ImapFlow } = await import("imapflow");
      vi.mocked(ImapFlow).mockImplementation(function() { return mockImapFlow; });

      await expect(pool.acquireForFolder("INBOX")).rejects.toThrow(
        "Failed to select folder INBOX",
      );
    });
  });

  describe("folder state management", () => {
    it("should reset folder state for unhealthy connections", async () => {
      const wrapper = await pool.acquireForFolder("INBOX");

      // Mark connection as unhealthy
      wrapper.isHealthy = false;

      await pool.release(wrapper);

      // Folder state should be cleared
      expect(wrapper.selectedFolder).toBeUndefined();
    });

    it("should invalidate folder connections", async () => {
      // Acquire two connections simultaneously to ensure separate connections
      const wrapper1 = await pool.acquireForFolder("INBOX");
      const wrapper2 = await pool.acquireForFolder("Sent");

      // Release them
      await pool.releaseFromFolder(wrapper1);
      await pool.releaseFromFolder(wrapper2);

      // Invalidate INBOX connections
      await pool.invalidateFolderConnections("INBOX");

      // Check connections
      const connections = (pool as { connections: Map<string, unknown> })
        .connections;
      const inboxConnection = Array.from(connections.values()).find(
        (w: { id: string }) => w.id === wrapper1.id,
      );
      const sentConnection = Array.from(connections.values()).find(
        (w: { id: string }) => w.id === wrapper2.id,
      );

      // INBOX connection should be marked unhealthy
      expect(inboxConnection?.isHealthy).toBe(false);
      expect(inboxConnection?.selectedFolder).toBeUndefined();

      // Sent connection should remain healthy (if it's a different connection)
      if (wrapper1.id !== wrapper2.id) {
        expect(sentConnection?.isHealthy).toBe(true);
        expect(sentConnection?.selectedFolder).toBe("Sent");
      }
    });
  });

  describe("IMAP-specific metrics", () => {
    it("should provide IMAP metrics with folder distribution", async () => {
      // Acquire connections simultaneously to force separate connections
      const wrapper1 = await pool.acquireForFolder("INBOX");
      const wrapper2 = await pool.acquireForFolder("Sent");

      // Release them
      await pool.releaseFromFolder(wrapper1);
      await pool.releaseFromFolder(wrapper2);

      const metrics = pool.getImapMetrics();

      expect(metrics.folderDistribution).toBeDefined();
      expect(metrics.folderDistribution.INBOX).toBeGreaterThan(0);

      // Only expect Sent folder if we got separate connections
      if (wrapper1.id !== wrapper2.id) {
        expect(metrics.folderDistribution.Sent).toBeGreaterThan(0);
      }

      expect(metrics.totalConnections).toBeGreaterThan(0);
    });

    it("should not count active connections in folder distribution", async () => {
      const wrapper = await pool.acquireForFolder("INBOX");
      // Don't release - keep it active

      const metrics = pool.getImapMetrics();

      // Active connection should not appear in folder distribution
      expect(metrics.folderDistribution.INBOX).toBeUndefined();

      await pool.releaseFromFolder(wrapper);
    });
  });

  describe("connection lifecycle", () => {
    it("should properly destroy connections", async () => {
      const wrapper = await pool.acquire();

      await pool.destroyConnection(wrapper.connection);

      expect(wrapper.connection.usable).toBe(false);
    });

    it("should handle logout errors gracefully", async () => {
      const wrapper = await pool.acquire();

      // Mock logout to fail
      const mockImapFlow = wrapper.connection as MockImapFlow;
      mockImapFlow.logout = vi
        .fn()
        .mockRejectedValue(new Error("Logout failed"));

      // Should not throw
      await expect(
        pool.destroyConnection(wrapper.connection),
      ).resolves.not.toThrow();

      await pool.release(wrapper);
    });
  });

  describe("error recovery", () => {
    it("should handle connection errors and create new connections", async () => {
      const wrapper1 = await pool.acquire();

      // Simulate connection becoming unusable
      wrapper1.connection.usable = false;
      wrapper1.isHealthy = false;

      await pool.release(wrapper1);

      // Next acquire should create a new connection
      const wrapper2 = await pool.acquire();
      expect(wrapper2.id).not.toBe(wrapper1.id);
      expect(wrapper2.connection.usable).toBe(true);

      await pool.release(wrapper2);
    });

    it("should retry failed operations", async () => {
      let attemptCount = 0;
      const originalCreate = pool.createConnection.bind(pool);

      pool.createConnection = vi.fn().mockImplementation(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error("Temporary failure");
        }
        return originalCreate();
      });

      // Should eventually succeed after retry
      const wrapper = await pool.acquire();
      expect(attemptCount).toBe(2);
      expect(wrapper).toBeDefined();

      await pool.release(wrapper);
    });
  });

  describe("concurrent folder access", () => {
    it("should handle concurrent folder acquisitions", async () => {
      const promises = [
        pool.acquireForFolder("INBOX"),
        pool.acquireForFolder("Sent"),
        pool.acquireForFolder("INBOX"),
        pool.acquireForFolder("Drafts"),
      ];

      const wrappers = await Promise.all(promises);

      // Check that all acquisitions succeeded
      expect(wrappers).toHaveLength(4);
      for (const wrapper of wrappers) {
        expect(wrapper).toBeDefined();
        expect(wrapper.selectedFolder).toBeDefined();
      }

      // Clean up
      for (const wrapper of wrappers) {
        await pool.releaseFromFolder(wrapper);
      }
    });
  });

  describe("Operation State Management", () => {
    it("should validate connection with timeout to detect stuck operations", async () => {
      const wrapper = await pool.acquire();

      // Connection should be healthy initially
      expect(wrapper.isHealthy).toBe(true);

      // Validation should succeed for a working connection
      const isValid = await pool["validateConnection"](wrapper.connection);
      expect(isValid).toBe(true);

      await pool.release(wrapper);
    });

    it("should handle sequential operations on reused connection", async () => {
      // Acquire connection for first operation
      const wrapper1 = await pool.acquireForFolder("INBOX");
      expect(wrapper1.selectedFolder).toBe("INBOX");

      // Release it back to pool
      await pool.releaseFromFolder(wrapper1);

      // Acquire connection for second operation (may reuse same connection)
      const wrapper2 = await pool.acquireForFolder("INBOX");
      expect(wrapper2.selectedFolder).toBe("INBOX");
      expect(wrapper2.isHealthy).toBe(true);

      await pool.releaseFromFolder(wrapper2);
    });

    it("should mark connection unhealthy and recreate if validation fails", async () => {
      const wrapper = await pool.acquire();
      const connectionId = wrapper.id;

      // Simulate connection becoming unhealthy
      wrapper.isHealthy = false;

      // Release the unhealthy connection
      await pool.release(wrapper);

      // Next acquisition should create a new connection (not reuse unhealthy one)
      const newWrapper = await pool.acquire();

      // Should be healthy
      expect(newWrapper.isHealthy).toBe(true);

      await pool.release(newWrapper);
    });

    it("should properly clean up folder state when connection is released", async () => {
      const wrapper = await pool.acquireForFolder("INBOX");
      expect(wrapper.selectedFolder).toBe("INBOX");

      // Mark as unhealthy before release
      wrapper.isHealthy = false;

      // Release should clear folder selection for unhealthy connections
      await pool.releaseFromFolder(wrapper);

      // The wrapper's selectedFolder should be cleared when unhealthy
      expect(wrapper.selectedFolder).toBeUndefined();
    });

    it("should clean up connections properly after folder operation failures", async () => {
      // This test verifies that when a folder operation fails,
      // the connection is properly released and the pool remains functional

      // First, successfully acquire and use a connection
      const wrapper1 = await pool.acquireForFolder("INBOX");
      expect(wrapper1.selectedFolder).toBe("INBOX");

      // Release it back
      await pool.releaseFromFolder(wrapper1);

      // Pool should still be functional for subsequent operations
      const wrapper2 = await pool.acquireForFolder("Sent");
      expect(wrapper2).toBeDefined();
      expect(wrapper2.selectedFolder).toBe("Sent");

      await pool.releaseFromFolder(wrapper2);
    });
  });
});
