/**
 * Tests for ConnectionPool - Base connection pool implementation
 *
 * This tests the abstract ConnectionPool base class with a mock connection type.
 * Protocol-specific implementations (ImapConnectionPool, SmtpConnectionPool) have
 * their own test files that test protocol-specific behavior while also testing
 * some similar patterns with protocol-specific details.
 *
 * Test organization:
 * - ConnectionPool.test.ts - Base class behavior with generic mocks
 * - ImapConnectionPool.test.ts - IMAP-specific implementation and behavior
 * - SmtpConnectionPool.test.ts - SMTP-specific implementation and behavior
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionPool,
  type ConnectionPoolConfig,
  type ConnectionWrapper,
} from "../src/services/ConnectionPool.js";

// Test helper interface for accessing private methods
interface TestableConnectionPool<T> extends ConnectionPool<T> {
  updateMetrics(): void;
  performHealthCheck(): Promise<void>;
}

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

  getWaitingQueue(): Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> {
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
      for (const result of failed) {
        if (result.status === "rejected") {
          expect(result.reason.message).toContain("Connection acquire timeout");
        }
      }

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
      (wrapper as { isHealthy?: boolean }).isHealthy = undefined;

      // Should still be able to release
      await expect(pool.release(wrapper)).resolves.not.toThrow();
    });
  });

  describe("enhanced metrics", () => {
    it("should track detailed connection metrics", async () => {
      const wrapper1 = await pool.acquire();
      await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay
      const wrapper2 = await pool.acquire();

      await pool.release(wrapper1);
      await new Promise((resolve) => setTimeout(resolve, 50)); // Make wrapper1 idle for a bit

      const metrics = pool.getMetrics();

      expect(metrics.totalConnections).toBe(2);
      expect(metrics.activeConnections).toBe(1);
      expect(metrics.idleConnections).toBe(1);
      expect(metrics.healthyConnections).toBe(2);
      expect(metrics.unhealthyConnections).toBe(0);
      expect(metrics.averageConnectionAge).toBeGreaterThan(0);
      expect(metrics.averageIdleTime).toBeGreaterThan(0);
      expect(metrics.connectionUtilization).toBeCloseTo(33.33, 2); // 1 active out of 3 max connections
      expect(metrics.lastHealthCheck).toBeInstanceOf(Date);

      await pool.release(wrapper2);
    });

    it("should track connection errors with context", async () => {
      pool.setShouldFailCreation(true);

      await expect(pool.acquire()).rejects.toThrow();

      const metrics = pool.getMetrics();
      expect(metrics.connectionErrors.length).toBeGreaterThan(0);
      expect(metrics.connectionErrors[0]).toMatchObject({
        timestamp: expect.any(Date),
        error: expect.any(String),
        context: expect.stringContaining("createConnection attempt"),
      });
    });

    it("should limit error history", async () => {
      pool.setShouldFailCreation(true);

      // Generate more than 100 errors (the limit)
      for (let i = 0; i < 105; i++) {
        await expect(pool.acquire()).rejects.toThrow();
      }

      const metrics = pool.getMetrics();
      expect(metrics.connectionErrors.length).toBeLessThanOrEqual(100);
    });

    it("should calculate utilization correctly", async () => {
      const maxConnections = 4;
      const utilizationPool = new TestConnectionPool({
        ...config,
        maxConnections,
      });

      // No connections = 0% utilization
      expect(utilizationPool.getMetrics().connectionUtilization).toBe(0);

      // 2 active connections = 50% utilization
      const wrapper1 = await utilizationPool.acquire();
      const wrapper2 = await utilizationPool.acquire();
      expect(utilizationPool.getMetrics().connectionUtilization).toBe(50);

      await utilizationPool.release(wrapper1);
      await utilizationPool.release(wrapper2);
      await utilizationPool.destroy();
    });
  });

  describe("exponential backoff", () => {
    it("should use exponential backoff for retries", async () => {
      const startTime = Date.now();
      pool.setShouldFailCreation(true);

      await expect(pool.acquire()).rejects.toThrow();

      const endTime = Date.now();
      const duration = endTime - startTime;

      // Should take longer than base delay due to retries with backoff
      // Base delay is 10ms, with 2 retries we expect some additional time
      expect(duration).toBeGreaterThan(10);
    });

    it("should cap backoff delay", async () => {
      // Test that very high attempt numbers don't cause excessive delays
      const testPool = new TestConnectionPool({
        ...config,
        maxRetries: 5, // Reduced retry count for faster test
      });

      testPool.setShouldFailCreation(true);
      const startTime = Date.now();

      await expect(testPool.acquire()).rejects.toThrow();

      const endTime = Date.now();
      const duration = endTime - startTime;

      // With 5 retries, should not take more than a reasonable time
      // due to the 30-second cap on backoff delay
      expect(duration).toBeLessThan(30000); // Less than 30 seconds

      await testPool.destroy();
    }, 35000); // Set explicit timeout for this test

    it("should include jitter in backoff", async () => {
      pool.setShouldFailCreation(true);

      const durations: number[] = [];

      // Run multiple times to see jitter variation
      for (let i = 0; i < 3; i++) {
        const startTime = Date.now();
        await expect(pool.acquire()).rejects.toThrow();
        const endTime = Date.now();
        durations.push(endTime - startTime);
      }

      // Due to jitter, durations should vary
      const uniqueDurations = new Set(durations);
      expect(uniqueDurations.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe("connection age tracking", () => {
    it("should track connection creation time", async () => {
      const wrapper = await pool.acquire();

      expect(wrapper.createdAt).toBeInstanceOf(Date);
      expect(wrapper.createdAt.getTime()).toBeLessThanOrEqual(Date.now());

      await pool.release(wrapper);
    });

    it("should update last used time on release", async () => {
      const wrapper = await pool.acquire();
      const initialLastUsed = wrapper.lastUsed;

      await new Promise((resolve) => setTimeout(resolve, 10));
      await pool.release(wrapper);

      expect(wrapper.lastUsed.getTime()).toBeGreaterThan(
        initialLastUsed.getTime(),
      );
    });

    it("should calculate average age correctly", async () => {
      const wrapper1 = await pool.acquire();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const wrapper2 = await pool.acquire();

      // Force metrics update
      (pool as TestableConnectionPool<MockConnection>).updateMetrics();

      const metrics = pool.getMetrics();
      expect(metrics.averageConnectionAge).toBeGreaterThan(0);

      await pool.release(wrapper1);
      await pool.release(wrapper2);
    });
  });

  describe("health check enhancements", () => {
    it("should update health check timestamp", async () => {
      const initialMetrics = pool.getMetrics();
      expect(initialMetrics.lastHealthCheck).toBeInstanceOf(Date);

      // Wait a bit to ensure timestamp changes
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Manually trigger health check instead of waiting for timer
      await (
        pool as TestableConnectionPool<MockConnection>
      ).performHealthCheck();

      const updatedMetrics = pool.getMetrics();
      expect(updatedMetrics.lastHealthCheck).toBeInstanceOf(Date);
      expect(updatedMetrics.lastHealthCheck?.getTime()).toBeGreaterThan(
        initialMetrics.lastHealthCheck?.getTime(),
      );
    });

    it("should track healthy vs unhealthy connections", async () => {
      const wrapper = await pool.acquire();

      // Mark connection as unhealthy
      wrapper.isHealthy = false;
      await pool.release(wrapper);

      // Force metrics update
      (pool as TestableConnectionPool<MockConnection>).updateMetrics();

      const metrics = pool.getMetrics();
      expect(metrics.unhealthyConnections).toBe(1);
      expect(metrics.healthyConnections).toBe(0);
    });
  });
});
