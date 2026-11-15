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
  /** Widens the await inside creation and validation so races can be hit. */
  creationDelayMs = 0;
  validationDelayMs = 0;
  /** When set, every connect waits for this promise before completing. */
  creationGate?: Promise<void>;
  /** Every connection this pool has opened, including unregistered ones. */
  created: MockConnection[] = [];

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

    if (this.creationDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.creationDelayMs));
    }

    if (this.creationGate) {
      await this.creationGate;
    }

    this.connectionCounter++;
    const connection = new MockConnection(
      `conn-${this.connectionCounter}`,
      true,
      this.shouldFailCreation,
    );
    this.created.push(connection);
    return connection;
  }

  async validateConnection(connection: MockConnection): Promise<boolean> {
    if (this.validationDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.validationDelayMs));
    }

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
    resolve: (connection: ConnectionWrapper<MockConnection>) => void;
    reject: (error: Error) => void;
    requestedAt: Date;
    settled: boolean;
  }> {
    return this.waitingQueue;
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending promise callbacks run without advancing any timer. */
const flush = () => new Promise(resolve => setImmediate(resolve));

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
      const successful = results.filter(r => r.status === "fulfilled");
      const failed = results.filter(r => r.status === "rejected");

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
      await new Promise(resolve => setTimeout(resolve, 10));
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

    it("should skip settled requests and serve next unsettled waiter", async () => {
      // Use a pool with a longer timeout so request 2 doesn't time out
      const longTimeoutPool = new TestConnectionPool({
        ...config,
        acquireTimeoutMs: 500,
      });

      // Fill the pool to max (3 connections)
      const connections = await Promise.all(
        Array.from({ length: config.maxConnections }, () =>
          longTimeoutPool.acquire(),
        ),
      );

      // Start two waiting requests
      const _waitingPromise1 = longTimeoutPool.acquire();
      const waitingPromise2 = longTimeoutPool.acquire();

      // Give time to enter the waiting queue
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(longTimeoutPool.getWaitingQueue().length).toBe(2);

      // Manually settle request 1 by accessing the queue directly
      // This simulates what happens when a timeout fires
      const queue = longTimeoutPool.getWaitingQueue();
      const request1 = queue[0];
      request1.settled = true;
      request1.reject(new Error("simulated timeout"));

      // Now release a connection - it should skip settled request 1
      // and serve the unsettled request 2
      await longTimeoutPool.release(connections[0]);

      // Request 2 should succeed
      const wrapper2 = await waitingPromise2;
      expect(wrapper2).toBeDefined();

      // Cleanup
      await longTimeoutPool.release(wrapper2);
      for (let i = 1; i < connections.length; i++) {
        await longTimeoutPool.release(connections[i]);
      }
      await longTimeoutPool.destroy();
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
      await new Promise(resolve => setTimeout(resolve, 150));

      // Restore original method
      pool.validateConnection = originalValidate;

      // The connection should have been destroyed
      const metrics = pool.getMetrics();
      expect(metrics.totalDestroyed).toBeGreaterThan(0);
    });

    it("should not validate idle connections the pool says need no verification yet", async () => {
      class RecentlyVerifiedPool extends TestConnectionPool {
        protected needsVerification(): boolean {
          return false;
        }
      }
      const verifiedPool = new RecentlyVerifiedPool({
        ...config,
        healthCheckIntervalMs: 60_000,
      });
      try {
        await verifiedPool.release(await verifiedPool.acquire());
        const validate = vi.spyOn(verifiedPool, "validateConnection");

        await (
          verifiedPool as unknown as TestableConnectionPool<MockConnection>
        ).performHealthCheck();

        expect(validate).not.toHaveBeenCalled();
        expect(verifiedPool.getConnections().size).toBe(1);
      } finally {
        await verifiedPool.destroy();
      }
    });

    it("should validate idle connections by default", async () => {
      const checkPool = new TestConnectionPool({
        ...config,
        healthCheckIntervalMs: 60_000,
      });
      try {
        await checkPool.release(await checkPool.acquire());
        const validate = vi.spyOn(checkPool, "validateConnection");

        await (
          checkPool as TestableConnectionPool<MockConnection>
        ).performHealthCheck();

        expect(validate).toHaveBeenCalledTimes(1);
      } finally {
        await checkPool.destroy();
      }
    });

    it("should maintain minimum connections", async () => {
      // Pool should create minimum connections during health check
      await new Promise(resolve => setTimeout(resolve, 150));

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
      await new Promise(resolve => setTimeout(resolve, 10));

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

    describe("with connects in flight", () => {
      let shutdownPool: TestConnectionPool;

      beforeEach(() => {
        shutdownPool = new TestConnectionPool({
          ...config,
          healthCheckIntervalMs: 60_000,
        });
      });

      afterEach(async () => {
        await shutdownPool.destroy();
      });

      it("should close a connection that finishes opening after destroy", async () => {
        const gate = deferred();
        shutdownPool.creationGate = gate.promise;

        const acquiring = shutdownPool.acquire();
        await flush();
        await shutdownPool.destroy();
        gate.resolve();

        await expect(acquiring).rejects.toThrow("Connection pool is shut down");
        expect(shutdownPool.created).toHaveLength(1);
        expect(shutdownPool.created[0].isValid).toBe(false);
        expect(shutdownPool.getConnections().size).toBe(0);
        const metrics = shutdownPool.getMetrics();
        expect(metrics.totalConnections).toBe(0);
        expect(metrics.activeConnections).toBe(0);
      });

      it("should close a minimum connection the health check opens during destroy", async () => {
        const gate = deferred();
        shutdownPool.creationGate = gate.promise;

        const healthCheck = (
          shutdownPool as TestableConnectionPool<MockConnection>
        ).performHealthCheck();
        await flush();
        await shutdownPool.destroy();
        gate.resolve();
        await healthCheck;

        expect(shutdownPool.created).toHaveLength(1);
        expect(shutdownPool.created[0].isValid).toBe(false);
        expect(shutdownPool.getConnections().size).toBe(0);
      });

      it("should not retry a failed connect once the pool is destroyed", async () => {
        shutdownPool.setShouldFailCreation(true);
        const createSpy = vi.spyOn(shutdownPool, "createConnection");

        const acquiring = shutdownPool.acquire();
        await flush();
        await shutdownPool.destroy();

        await expect(acquiring).rejects.toThrow("Connection pool is shut down");
        expect(createSpy).toHaveBeenCalledTimes(1);
      });

      it("should reject acquire immediately once destroyed", async () => {
        await shutdownPool.destroy();
        const createSpy = vi.spyOn(shutdownPool, "createConnection");

        await expect(shutdownPool.acquire()).rejects.toThrow(
          "Connection pool is shutting down",
        );
        expect(createSpy).not.toHaveBeenCalled();
      });

      it("should not hand out an idle connection destroyed while it was validated", async () => {
        await shutdownPool.release(await shutdownPool.acquire());
        const gate = deferred();
        shutdownPool.validateConnection = async () => {
          await gate.promise;
          return true;
        };

        const acquiring = shutdownPool.acquire();
        await flush();
        await shutdownPool.destroy();
        gate.resolve();

        await expect(acquiring).rejects.toThrow("Connection pool is shut down");
      });
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
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
      const wrapper2 = await pool.acquire();

      await pool.release(wrapper1);
      await new Promise(resolve => setTimeout(resolve, 50)); // Make wrapper1 idle for a bit

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

      await new Promise(resolve => setTimeout(resolve, 10));
      await pool.release(wrapper);

      expect(wrapper.lastUsed.getTime()).toBeGreaterThan(
        initialLastUsed.getTime(),
      );
    });

    it("should calculate average age correctly", async () => {
      const wrapper1 = await pool.acquire();
      await new Promise(resolve => setTimeout(resolve, 50));
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
      await new Promise(resolve => setTimeout(resolve, 10));

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

  describe("race conditions", () => {
    // The periodic health check is pushed out of the way so each test
    // controls exactly which operations overlap.
    let racePool: TestConnectionPool;

    beforeEach(() => {
      racePool = new TestConnectionPool({
        ...config,
        healthCheckIntervalMs: 60_000,
      });
    });

    afterEach(async () => {
      await racePool.destroy();
    });

    it("should not hand one idle connection to two concurrent acquires", async () => {
      await racePool.release(await racePool.acquire());
      racePool.validationDelayMs = 20;

      const [first, second] = await Promise.all([
        racePool.acquire(),
        racePool.acquire(),
      ]);

      expect(first.id).not.toBe(second.id);
    });

    it("should not exceed maxConnections when acquires race", async () => {
      racePool.creationDelayMs = 20;

      const results = await Promise.allSettled(
        Array.from({ length: config.maxConnections + 2 }, () =>
          racePool.acquire(),
        ),
      );

      const acquired = results.filter(r => r.status === "fulfilled");
      expect(acquired).toHaveLength(config.maxConnections);
      expect(racePool.getConnections().size).toBe(config.maxConnections);
    });

    it("should not destroy a connection acquired while the health check runs", async () => {
      const expired = await racePool.acquire();
      const other = await racePool.acquire();
      await racePool.release(expired);
      await racePool.release(other);
      // Past the idle timeout, so the health check will close it.
      expired.lastUsed = new Date(0);
      racePool.validationDelayMs = 20;

      const healthCheck = (
        racePool as TestableConnectionPool<MockConnection>
      ).performHealthCheck();
      const acquired = await racePool.acquire();
      await healthCheck;

      expect(racePool.getConnections().has(acquired.id)).toBe(true);
      expect(acquired.connection.isValid).toBe(true);
    });

    it("should leave connections opened by the health check available", async () => {
      await (
        racePool as TestableConnectionPool<MockConnection>
      ).performHealthCheck();
      expect(racePool.getConnections().size).toBe(config.minConnections);

      await racePool.acquire();

      expect(racePool.getMetrics().totalCreated).toBe(config.minConnections);
    });

    it("should offer a connection to the next waiter if one gives up during handoff", async () => {
      const held = await Promise.all(
        Array.from({ length: config.maxConnections }, () => racePool.acquire()),
      );
      const abandoned = racePool.acquire().catch(() => undefined);
      const waiting = racePool.acquire();
      await new Promise(resolve => setTimeout(resolve, 10));

      // The first waiter times out while the released connection is checked.
      racePool.validationDelayMs = 20;
      const [first] = racePool.getWaitingQueue();
      setTimeout(() => first.reject(new Error("gave up")), 5);
      await racePool.release(held[0]);

      expect((await waiting).id).toBe(held[0].id);
      await abandoned;
    });

    it("should validate a connection only once when a waiter gives up during handoff", async () => {
      const held = await Promise.all(
        Array.from({ length: config.maxConnections }, () => racePool.acquire()),
      );
      const abandoned = racePool.acquire().catch(() => undefined);
      const waiting = racePool.acquire();
      await new Promise(resolve => setTimeout(resolve, 10));

      racePool.validationDelayMs = 20;
      const validate = vi.spyOn(racePool, "validateConnection");
      const [first] = racePool.getWaitingQueue();
      setTimeout(() => first.reject(new Error("gave up")), 5);
      await racePool.release(held[0]);

      expect((await waiting).id).toBe(held[0].id);
      expect(validate).toHaveBeenCalledTimes(1);
      await abandoned;
    });
  });

  describe("waiters after a connection is destroyed", () => {
    // A single slot makes every freed slot observable; a long acquire timeout
    // means a stranded waiter shows up as still pending, not as a timeout.
    let slotPool: TestConnectionPool;

    beforeEach(() => {
      slotPool = new TestConnectionPool({
        ...config,
        minConnections: 0,
        maxConnections: 1,
        maxRetries: 0,
        acquireTimeoutMs: 60_000,
        healthCheckIntervalMs: 60_000,
      });
    });

    afterEach(async () => {
      await slotPool.destroy();
    });

    const track = <V>(promise: Promise<V>) => {
      const state: { value?: V; error?: Error } = {};
      promise.then(
        value => {
          state.value = value;
        },
        error => {
          state.error = error;
        },
      );
      return state;
    };

    it("should give a waiter a new connection when the handed-off one fails validation", async () => {
      const held = await slotPool.acquire();
      const waiting = slotPool.acquire();
      await flush();

      slotPool.setShouldFailValidation(true);
      await slotPool.release(held);

      const wrapper = await waiting;
      expect(wrapper.id).not.toBe(held.id);
      expect(wrapper.connection.isValid).toBe(true);
      expect(slotPool.getConnections().size).toBe(1);
    });

    it("should reject every waiter with the connect error when no replacement can be opened", async () => {
      const held = await slotPool.acquire();
      const first = track(slotPool.acquire());
      const second = track(slotPool.acquire());
      await flush();

      slotPool.setShouldFailValidation(true);
      slotPool.setShouldFailCreation(true);
      const createSpy = vi.spyOn(slotPool, "createConnection");
      await slotPool.release(held);
      await flush();

      expect(first.error?.message).toContain("Failed to create connection");
      expect(second.error?.message).toContain("Failed to create connection");
      // One bounded attempt per waiter, no retry loop.
      expect(createSpy).toHaveBeenCalledTimes(2);
    });

    it("should serve a waiter queued behind a connect that fails", async () => {
      const gate = deferred();
      const createConnection = slotPool.createConnection.bind(slotPool);
      let calls = 0;
      slotPool.createConnection = async () => {
        calls++;
        if (calls === 1) {
          await gate.promise;
          throw new Error("connect refused");
        }
        return createConnection();
      };

      const first = track(slotPool.acquire());
      await flush();
      // The slot is held by the connect in flight, so this waits.
      const second = track(slotPool.acquire());
      await flush();
      expect(slotPool.getWaitingQueue()).toHaveLength(1);

      gate.resolve();
      await flush();
      await flush();

      expect(first.error?.message).toContain("connect refused");
      expect(second.error).toBeUndefined();
      expect(second.value?.connection.isValid).toBe(true);
    });

    it("should serve a waiter when the health check destroys the connection it was checking", async () => {
      await slotPool.release(await slotPool.acquire());
      const gate = deferred();
      slotPool.validateConnection = async () => {
        await gate.promise;
        return false;
      };

      const healthCheck = (
        slotPool as TestableConnectionPool<MockConnection>
      ).performHealthCheck();
      await flush();
      // The only connection is claimed by the health check, so this waits.
      const waiting = track(slotPool.acquire());
      await flush();
      expect(slotPool.getWaitingQueue()).toHaveLength(1);

      gate.resolve();
      await healthCheck;
      await flush();

      expect(waiting.error).toBeUndefined();
      expect(waiting.value?.connection.isValid).toBe(true);
    });
  });

  describe("waiting request metric", () => {
    let waitPool: TestConnectionPool;

    beforeEach(() => {
      waitPool = new TestConnectionPool({
        ...config,
        healthCheckIntervalMs: 60_000,
      });
    });

    afterEach(async () => {
      await waitPool.destroy();
    });

    const fillPool = () =>
      Promise.all(
        Array.from({ length: config.maxConnections }, () => waitPool.acquire()),
      );

    it("should count a waiter only while it is waiting", async () => {
      const held = await fillPool();
      const waiting = waitPool.acquire();
      await flush();
      expect(waitPool.getMetrics().waitingRequests).toBe(1);

      await waitPool.release(held[0]);
      await waiting;

      expect(waitPool.getMetrics().waitingRequests).toBe(0);
    });

    it("should not count an acquire that is opening a connection", async () => {
      const gate = deferred();
      waitPool.creationGate = gate.promise;

      const acquiring = waitPool.acquire();
      await flush();
      expect(waitPool.getMetrics().waitingRequests).toBe(0);

      gate.resolve();
      await acquiring;
    });

    it("should not count an acquire that is validating an idle connection", async () => {
      await waitPool.release(await waitPool.acquire());
      const gate = deferred();
      waitPool.validateConnection = async () => {
        await gate.promise;
        return true;
      };

      const acquiring = waitPool.acquire();
      await flush();
      expect(waitPool.getMetrics().waitingRequests).toBe(0);

      gate.resolve();
      await acquiring;
    });

    it("should stop counting a waiter once it times out", async () => {
      await fillPool();

      await expect(waitPool.acquire()).rejects.toThrow(
        "Connection acquire timeout",
      );

      expect(waitPool.getMetrics().waitingRequests).toBe(0);
    });
  });
});
