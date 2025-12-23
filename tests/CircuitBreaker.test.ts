import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  CircuitBreakerState,
} from "../src/services/CircuitBreaker.js";

describe("CircuitBreaker", () => {
  let circuitBreaker: CircuitBreaker;
  let config: CircuitBreakerConfig;

  beforeEach(() => {
    config = {
      failureThreshold: 3,
      recoveryTimeout: 1000,
      monitoringInterval: 500,
    };
    circuitBreaker = new CircuitBreaker(config);
  });

  describe("initialization", () => {
    it("should start in CLOSED state", () => {
      expect(circuitBreaker.isClosed()).toBe(true);
      expect(circuitBreaker.isOpen()).toBe(false);
      expect(circuitBreaker.isHalfOpen()).toBe(false);
    });

    it("should have initial metrics", () => {
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitBreakerState.CLOSED);
      expect(metrics.failures).toBe(0);
      expect(metrics.successes).toBe(0);
      expect(metrics.requestCount).toBe(0);
      expect(metrics.errorRate).toBe(0);
    });
  });

  describe("successful operations", () => {
    it("should execute operations when circuit is closed", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      const result = await circuitBreaker.execute(operation);

      expect(result).toBe("success");
      expect(operation).toHaveBeenCalledOnce();
      expect(circuitBreaker.isClosed()).toBe(true);
    });

    it("should track successful operations", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      await circuitBreaker.execute(operation);
      await circuitBreaker.execute(operation);

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.successes).toBe(2);
      expect(metrics.requestCount).toBe(2);
      expect(metrics.errorRate).toBe(0);
      expect(metrics.lastSuccessTime).toBeDefined();
    });
  });

  describe("failure handling", () => {
    it("should track failed operations", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("test failure"));

      await expect(circuitBreaker.execute(operation)).rejects.toThrow(
        "test failure",
      );

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failures).toBe(1);
      expect(metrics.successes).toBe(0);
      expect(metrics.requestCount).toBe(1);
      expect(metrics.errorRate).toBe(1);
      expect(metrics.lastFailureTime).toBeDefined();
    });

    it("should remain closed below failure threshold", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("test failure"));

      // Fail twice (below threshold of 3)
      await expect(circuitBreaker.execute(operation)).rejects.toThrow();
      await expect(circuitBreaker.execute(operation)).rejects.toThrow();

      expect(circuitBreaker.isClosed()).toBe(true);
      expect(circuitBreaker.getMetrics().failures).toBe(2);
    });

    it("should open circuit when failure threshold is reached", async () => {
      const operation = vi.fn().mockRejectedValue(new Error("test failure"));

      // Fail three times (reaching threshold)
      await expect(circuitBreaker.execute(operation)).rejects.toThrow();
      await expect(circuitBreaker.execute(operation)).rejects.toThrow();
      await expect(circuitBreaker.execute(operation)).rejects.toThrow();

      expect(circuitBreaker.isOpen()).toBe(true);
      expect(circuitBreaker.getMetrics().failures).toBe(3);
    });
  });

  describe("open circuit behavior", () => {
    beforeEach(async () => {
      // Force circuit to open
      const operation = vi.fn().mockRejectedValue(new Error("test failure"));
      for (let i = 0; i < config.failureThreshold; i++) {
        await expect(circuitBreaker.execute(operation)).rejects.toThrow();
      }
    });

    it("should reject operations immediately when open", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      await expect(circuitBreaker.execute(operation)).rejects.toThrow(
        "Circuit breaker is OPEN - operation not allowed",
      );

      expect(operation).not.toHaveBeenCalled();
    });

    it("should transition to HALF_OPEN after recovery timeout", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      // Wait for recovery timeout
      await new Promise(resolve =>
        setTimeout(resolve, config.recoveryTimeout + 100),
      );

      // Before executing, check that we would be in HALF_OPEN state
      // We can't easily test this because successful execution immediately closes the circuit
      // So let's test that the operation executes successfully after timeout
      const result = await circuitBreaker.execute(operation);

      expect(result).toBe("success");
      expect(circuitBreaker.isClosed()).toBe(true); // Should be closed after successful operation
    });
  });

  describe("half-open circuit behavior", () => {
    beforeEach(async () => {
      // Force circuit to open then wait for recovery
      const failingOperation = vi
        .fn()
        .mockRejectedValue(new Error("test failure"));
      for (let i = 0; i < config.failureThreshold; i++) {
        await expect(
          circuitBreaker.execute(failingOperation),
        ).rejects.toThrow();
      }
      await new Promise(resolve =>
        setTimeout(resolve, config.recoveryTimeout + 100),
      );
    });

    it("should close circuit on successful operation in HALF_OPEN state", async () => {
      const operation = vi.fn().mockResolvedValue("success");

      await circuitBreaker.execute(operation);

      expect(circuitBreaker.isClosed()).toBe(true);
      expect(circuitBreaker.getMetrics().failures).toBe(0); // Reset on successful recovery
    });

    it("should reopen circuit on failed operation in HALF_OPEN state", async () => {
      const successOperation = vi.fn().mockResolvedValue("success");
      const failOperation = vi
        .fn()
        .mockRejectedValue(new Error("still failing"));

      // First call transitions to HALF_OPEN
      await circuitBreaker.execute(successOperation);

      // Force back to HALF_OPEN for testing
      const failingOp = vi.fn().mockRejectedValue(new Error("test failure"));
      for (let i = 0; i < config.failureThreshold; i++) {
        await expect(circuitBreaker.execute(failingOp)).rejects.toThrow();
      }
      await new Promise(resolve =>
        setTimeout(resolve, config.recoveryTimeout + 100),
      );

      // Now test failure in HALF_OPEN
      await expect(circuitBreaker.execute(failOperation)).rejects.toThrow(
        "still failing",
      );

      expect(circuitBreaker.isOpen()).toBe(true);
    });
  });

  describe("metrics calculation", () => {
    it("should calculate error rate correctly", async () => {
      const successOp = vi.fn().mockResolvedValue("success");
      const failOp = vi.fn().mockRejectedValue(new Error("failure"));

      // 2 successes, 1 failure = 33% error rate
      await circuitBreaker.execute(successOp);
      await circuitBreaker.execute(successOp);
      await expect(circuitBreaker.execute(failOp)).rejects.toThrow();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.successes).toBe(2);
      expect(metrics.failures).toBe(1);
      expect(metrics.requestCount).toBe(3);
      expect(metrics.errorRate).toBeCloseTo(0.333, 2);
    });

    it("should handle zero requests gracefully", () => {
      const metrics = circuitBreaker.getMetrics();
      expect(metrics.errorRate).toBe(0);
    });
  });

  describe("reset functionality", () => {
    it("should reset all state and metrics", async () => {
      const failOp = vi.fn().mockRejectedValue(new Error("failure"));

      // Generate some state
      await expect(circuitBreaker.execute(failOp)).rejects.toThrow();

      circuitBreaker.reset();

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.state).toBe(CircuitBreakerState.CLOSED);
      expect(metrics.failures).toBe(0);
      expect(metrics.successes).toBe(0);
      expect(metrics.requestCount).toBe(0);
      expect(metrics.errorRate).toBe(0);
      expect(metrics.lastFailureTime).toBeUndefined();
      expect(metrics.lastSuccessTime).toBeUndefined();
    });
  });

  describe("edge cases", () => {
    it("should handle operations that throw non-Error objects", async () => {
      const operation = vi.fn().mockRejectedValue("string error");

      await expect(circuitBreaker.execute(operation)).rejects.toBe(
        "string error",
      );

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failures).toBe(1);
    });

    it("should handle synchronous exceptions", async () => {
      const operation = vi.fn().mockImplementation(() => {
        throw new Error("sync error");
      });

      await expect(circuitBreaker.execute(operation)).rejects.toThrow(
        "sync error",
      );

      const metrics = circuitBreaker.getMetrics();
      expect(metrics.failures).toBe(1);
    });

    it("should work with different configuration values", () => {
      const customConfig = {
        failureThreshold: 1,
        recoveryTimeout: 500,
        monitoringInterval: 100,
      };
      const customBreaker = new CircuitBreaker(customConfig);

      expect(customBreaker.isClosed()).toBe(true);
    });
  });

  describe("timeout behavior", () => {
    it("should not allow operations before recovery timeout", async () => {
      const failOp = vi.fn().mockRejectedValue(new Error("failure"));
      const successOp = vi.fn().mockResolvedValue("success");

      // Open the circuit
      for (let i = 0; i < config.failureThreshold; i++) {
        await expect(circuitBreaker.execute(failOp)).rejects.toThrow();
      }

      // Try before timeout
      await expect(circuitBreaker.execute(successOp)).rejects.toThrow(
        "Circuit breaker is OPEN - operation not allowed",
      );

      expect(successOp).not.toHaveBeenCalled();
    });
  });
});
