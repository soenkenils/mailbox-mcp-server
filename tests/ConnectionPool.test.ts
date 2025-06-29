import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionPool,
  type ConnectionPoolConfig,
  type ConnectionWrapper,
} from "../src/services/ConnectionPool.js";

// Mock connection class for testing
class MockConnection {
  public id: string;
  public isValid: boolean;
  public shouldFailCreation: boolean;

  constructor(id: string, isValid = true, shouldFailCreation = false) {
    this.id = id;
    this.isValid = isValid;
    this.shouldFailCreation = shouldFailCreation;
  }

  async operation(): Promise<string> {
    if (!this.isValid) {
      throw new Error("Connection is invalid");
    }
    return `operation-${this.id}`;
  }

  async close(): Promise<void> {
    this.isValid = false;
  }
}

// Test implementation of ConnectionPool
class TestConnectionPool extends ConnectionPool<MockConnection> {
  private connectionCounter = 0;
  private shouldFailCreation = false;
  private shouldFailValidation = false;

  setShouldFailCreation(fail: boolean): void {
    this.shouldFailCreation = fail;
  }

  setShouldFailValidation(fail: boolean): void {
    this.shouldFailValidation = fail;
  }

  async createConnection(): Promise<MockConnection> {
    if (this.shouldFailCreation) {
      throw new Error("Failed to create connection");
    }

    this.connectionCounter++;
    return new MockConnection(
      `conn-${this.connectionCounter}`,
      true,
      this.shouldFailCreation,
    );
  }

  async validateConnection(connection: MockConnection): Promise<boolean> {
    if (this.shouldFailValidation) {
      return false;
    }

    try {
      await connection.operation();
      return connection.isValid;
    } catch {
      return false;
    }
  }

  async destroyConnection(connection: MockConnection): Promise<void> {
    await connection.close();
  }

  // Expose protected methods for testing
  getConnections(): Map<string, ConnectionWrapper<MockConnection>> {
    return this.connections;
  }

  getWaitingQueue(): Array<any> {
    return this.waitingQueue;
  }
}

describe("ConnectionPool", () => {
  let pool: TestConnectionPool;
  let config: ConnectionPoolConfig;

  beforeEach(() => {
    config = {
      minConnections: 1,
      maxConnections: 3,
      acquireTimeoutMs: 100,
      idleTimeoutMs: 1000,
      maxRetries: 2,
      retryDelayMs: 10,
      healthCheckIntervalMs: 50,
    };

    pool = new TestConnectionPool(config);
  });

  afterEach(async () => {
    await pool.destroy();
  });

  describe("basic pool operations", () => {
    it("should acquire and release connections", async () => {
      const wrapper = await pool.acquire();

      expect(wrapper).toBeDefined();
      expect(wrapper.connection).toBeInstanceOf(MockConnection);
      expect(wrapper.inUse).toBe(true);
      expect(wrapper.isHealthy).toBe(true);

      const metrics = pool.getMetrics();
      expect(metrics.activeConnections).toBe(1);
      expect(metrics.totalAcquired).toBe(1);

      await pool.release(wrapper);

      const metricsAfter = pool.getMetrics();
      expect(metricsAfter.activeConnections).toBe(0);
      expect(metricsAfter.idleConnections).toBe(1);
      expect(metricsAfter.totalReleased).toBe(1);
    });

    it("should respect max connections limit", async () => {
      const connections: ConnectionWrapper<MockConnection>[] = [];

      // Acquire up to max connections
      for (let i = 0; i < config.maxConnections; i++) {
        const wrapper = await pool.acquire();
        connections.push(wrapper);
      }

      const metrics = pool.getMetrics();
      expect(metrics.activeConnections).toBe(config.maxConnections);
      expect(metrics.totalConnections).toBe(config.maxConnections);

      // Trying to acquire one more should timeout
      const startTime = Date.now();
      await expect(pool.acquire()).rejects.toThrow(
        "Connection acquire timeout",
      );
      const endTime = Date.now();

      expect(endTime - startTime).toBeGreaterThanOrEqual(
        config.acquireTimeoutMs - 20,
      );

      // Release all connections
      for (const wrapper of connections) {
        await pool.release(wrapper);
      }
    });

    it("should reuse idle connections", async () => {
      const wrapper1 = await pool.acquire();
      await pool.release(wrapper1);

      const wrapper2 = await pool.acquire();

      // Should reuse the same connection
      expect(wrapper2.id).toBe(wrapper1.id);
      expect(pool.getMetrics().totalCreated).toBe(1);

      await pool.release(wrapper2);
    });
  });

  describe("connection validation", () => {
    it("should validate connections before activation", async () => {
      const wrapper1 = await pool.acquire();
      await pool.release(wrapper1);

      // Make validation fail
      pool.setShouldFailValidation(true);

      // Should create a new connection instead of reusing invalid one
      await expect(pool.acquire()).rejects.toThrow(
        "Connection validation failed",
      );
    });

    it("should handle connection creation failures", async () => {
      pool.setShouldFailCreation(true);

      await expect(pool.acquire()).rejects.toThrow(
        "Failed to create connection",
      );

      const metrics = pool.getMetrics();
      expect(metrics.totalErrors).toBeGreaterThan(0);
    });
  });

  describe("concurrent access", () => {
    it("should handle concurrent acquire requests", async () => {
      // First acquire maxConnections to fill the pool
      const initialConnections = await Promise.all(
        Array.from({ length: config.maxConnections }, () => pool.acquire()),
      );

      // Now try to acquire more connections - these should timeout
      const additionalPromises = Array.from({ length: 2 }, () =>
        pool.acquire(),
      );

      const results = await Promise.allSettled(additionalPromises);

      // All additional requests should fail due to pool being full
      const successful = results.filter((r) => r.status === "fulfilled");
      const failed = results.filter((r) => r.status === "rejected");

      expect(successful.length).toBe(0);
      expect(failed.length).toBe(2);
      expect(successful.length + failed.length).toBe(2);

      // Verify timeout errors
      failed.forEach((result) => {
        if (result.status === "rejected") {
          expect(result.reason.message).toContain("Connection acquire timeout");
        }
      });

      // Release all initial connections
      for (const connection of initialConnections) {
        await pool.release(connection);
      }
    });

    it("should process waiting queue when connections are released", async () => {
      // Fill the pool
      const connections = await Promise.all(
        Array.from({ length: config.maxConnections }, () => pool.acquire()),
      );

      // Start a request that will wait
      const waitingPromise = pool.acquire();

      // Give it time to enter the waiting queue
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(pool.getWaitingQueue().length).toBe(1);

      // Release one connection
      await pool.release(connections[0]);

      // The waiting request should now succeed
      const waitingWrapper = await waitingPromise;
      expect(waitingWrapper).toBeDefined();

      // Cleanup
      await pool.release(waitingWrapper);
      for (let i = 1; i < connections.length; i++) {
        await pool.release(connections[i]);
      }
    });
  });

  describe("health checking", () => {
    it("should periodically validate idle connections", async () => {
      // Create and release a connection
      const wrapper = await pool.acquire();
      await pool.release(wrapper);

      // Mock the validation to fail
      const originalValidate = pool.validateConnection.bind(pool);
      const validateSpy = vi.fn().mockResolvedValue(false);
      pool.validateConnection = validateSpy;

      // Wait for health check to run (mocked shorter interval)
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Restore original method
      pool.validateConnection = originalValidate;

      // The connection should have been destroyed
      const metrics = pool.getMetrics();
      expect(metrics.totalDestroyed).toBeGreaterThan(0);
    });

    it("should maintain minimum connections", async () => {
      // Pool should create minimum connections during health check
      await new Promise((resolve) => setTimeout(resolve, 150));

      const metrics = pool.getMetrics();
      expect(metrics.totalConnections).toBeGreaterThanOrEqual(
        config.minConnections,
      );
    });
  });

  describe("pool shutdown", () => {
    it("should gracefully shutdown and reject new requests", async () => {
      const wrapper = await pool.acquire();

      // Start shutdown
      const shutdownPromise = pool.destroy();

      // New requests should be rejected
      await expect(pool.acquire()).rejects.toThrow(
        "Connection pool is shutting down",
      );

      // Release existing connection and complete shutdown
      await pool.release(wrapper);
      await shutdownPromise;

      const metrics = pool.getMetrics();
      expect(metrics.totalConnections).toBe(0);
    });

    it("should reject waiting requests during shutdown", async () => {
      // Fill the pool
      const connections = await Promise.all(
        Array.from({ length: config.maxConnections }, () => pool.acquire()),
      );

      // Start a request that will wait
      const waitingPromise = pool.acquire();

      // Give it time to enter the waiting queue
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Start shutdown
      const shutdownPromise = pool.destroy();

      // Waiting request should be rejected
      await expect(waitingPromise).rejects.toThrow(
        "Connection pool is shutting down",
      );

      // Release connections and complete shutdown
      for (const conn of connections) {
        await pool.release(conn);
      }
      await shutdownPromise;
    });
  });

  describe("metrics tracking", () => {
    it("should track comprehensive metrics", async () => {
      const initialMetrics = pool.getMetrics();
      expect(initialMetrics.totalConnections).toBe(0);
      expect(initialMetrics.activeConnections).toBe(0);
      expect(initialMetrics.idleConnections).toBe(0);

      const wrapper = await pool.acquire();

      const afterAcquireMetrics = pool.getMetrics();
      expect(afterAcquireMetrics.totalConnections).toBe(1);
      expect(afterAcquireMetrics.activeConnections).toBe(1);
      expect(afterAcquireMetrics.totalCreated).toBe(1);
      expect(afterAcquireMetrics.totalAcquired).toBe(1);

      await pool.release(wrapper);

      const afterReleaseMetrics = pool.getMetrics();
      expect(afterReleaseMetrics.activeConnections).toBe(0);
      expect(afterReleaseMetrics.idleConnections).toBe(1);
      expect(afterReleaseMetrics.totalReleased).toBe(1);
    });

    it("should track errors correctly", async () => {
      pool.setShouldFailCreation(true);

      await expect(pool.acquire()).rejects.toThrow();

      const metrics = pool.getMetrics();
      expect(metrics.totalErrors).toBeGreaterThan(0);
    });
  });

  describe("edge cases", () => {
    it("should handle zero min connections", async () => {
      const zeroMinPool = new TestConnectionPool({
        ...config,
        minConnections: 0,
      });

      const metrics = zeroMinPool.getMetrics();
      expect(metrics.totalConnections).toBe(0);

      await zeroMinPool.destroy();
    });

    it("should handle connection wrapper with missing properties", async () => {
      const wrapper = await pool.acquire();

      // Simulate corrupted wrapper
      delete (wrapper as any).isHealthy;

      // Should still be able to release
      await expect(pool.release(wrapper)).resolves.not.toThrow();
    });
  });
});
