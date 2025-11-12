import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import {
  DynamicPoolManager,
  type DynamicPoolConfig,
  type PoolUsageStats,
} from "../src/services/DynamicPoolManager.js";

// Mock the logger
vi.mock("../src/services/Logger.js", () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe("DynamicPoolManager", () => {
  let manager: DynamicPoolManager;
  let mockConfig: DynamicPoolConfig;

  beforeEach(() => {
    vi.clearAllTimers();
    vi.useFakeTimers();
    
    manager = new DynamicPoolManager();
    
    mockConfig = {
      minConnections: 1,
      maxConnections: 5,
      acquireTimeoutMs: 3000,
      idleTimeoutMs: 30000,
      maxRetries: 5,
      retryDelayMs: 200,
      healthCheckIntervalMs: 6000,
      adaptiveScaling: true,
      targetUtilization: 70,
      scaleUpThreshold: 85,
      scaleDownThreshold: 40,
      maxScaleUpSteps: 2,
      scaleDownDelay: 120000,
      minEffectiveConnections: 1,
      maxEffectiveConnections: 10,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("pool registration", () => {
    it("should register a new pool", () => {
      manager.registerPool("test-pool", mockConfig);
      
      const config = manager.getPoolConfig("test-pool");
      expect(config).toEqual(mockConfig);
    });

    it("should initialize empty usage history for new pool", () => {
      manager.registerPool("test-pool", mockConfig);
      
      const stats = manager.getPoolStats("test-pool");
      expect(stats).toEqual([]);
    });

    it("should allow multiple pools to be registered", () => {
      manager.registerPool("imap-pool", mockConfig);
      manager.registerPool("smtp-pool", { ...mockConfig, maxConnections: 3 });
      
      expect(manager.getPoolConfig("imap-pool")).toBeDefined();
      expect(manager.getPoolConfig("smtp-pool")).toBeDefined();
      expect(manager.getPoolConfig("smtp-pool")?.maxConnections).toBe(3);
    });
  });

  describe("pool statistics tracking", () => {
    it("should update pool statistics", () => {
      manager.registerPool("test-pool", mockConfig);
      
      const stats: PoolUsageStats = {
        averageWaitTime: 100,
        peakConnections: 3,
        utilizationRate: 60,
        errorRate: 0.05,
        requestsPerMinute: 50,
      };
      
      manager.updatePoolStats("test-pool", stats);
      
      const history = manager.getPoolStats("test-pool");
      expect(history).toHaveLength(1);
      expect(history[0]).toEqual(stats);
    });

    it("should maintain limited history size", () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add 15 stats (more than the limit of 10)
      for (let i = 0; i < 15; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: i * 10,
          peakConnections: 3,
          utilizationRate: 60,
          errorRate: 0.05,
          requestsPerMinute: 50,
        });
      }
      
      const history = manager.getPoolStats("test-pool");
      expect(history).toHaveLength(10);
      // Should keep most recent entries
      expect(history[0].averageWaitTime).toBe(50); // Entry 5
      expect(history[9].averageWaitTime).toBe(140); // Entry 14
    });

    it("should track stats for multiple pools independently", () => {
      manager.registerPool("pool-1", mockConfig);
      manager.registerPool("pool-2", mockConfig);
      
      manager.updatePoolStats("pool-1", {
        averageWaitTime: 100,
        peakConnections: 3,
        utilizationRate: 60,
        errorRate: 0.05,
        requestsPerMinute: 50,
      });
      
      manager.updatePoolStats("pool-2", {
        averageWaitTime: 200,
        peakConnections: 5,
        utilizationRate: 80,
        errorRate: 0.1,
        requestsPerMinute: 75,
      });
      
      expect(manager.getPoolStats("pool-1")[0].averageWaitTime).toBe(100);
      expect(manager.getPoolStats("pool-2")[0].averageWaitTime).toBe(200);
    });
  });

  describe("pool scaling - scale up", () => {
    it("should scale up when utilization is high", async () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add stats showing high utilization
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 1500, // Above 1000ms threshold
          peakConnections: 5,
          utilizationRate: 90, // Above 85% threshold
          errorRate: 0.05, // Below 0.1
          requestsPerMinute: 100,
        });
      }
      
      // Trigger adjustment cycle
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      expect(updatedConfig?.maxConnections).toBeGreaterThan(mockConfig.maxConnections);
    });

    it("should respect maxEffectiveConnections limit", async () => {
      const limitedConfig = { ...mockConfig, maxConnections: 8, maxEffectiveConnections: 10 };
      manager.registerPool("test-pool", limitedConfig);
      
      // Add stats showing very high utilization
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 2000,
          peakConnections: 8,
          utilizationRate: 95,
          errorRate: 0.05,
          requestsPerMinute: 150,
        });
      }
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      expect(updatedConfig?.maxConnections).toBeLessThanOrEqual(10);
    });

    it("should not scale up if error rate is high", async () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add stats with high errors
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 1500,
          peakConnections: 5,
          utilizationRate: 90,
          errorRate: 0.15, // Above 0.1 threshold
          requestsPerMinute: 100,
        });
      }
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      expect(updatedConfig?.maxConnections).toBe(mockConfig.maxConnections);
    });

    it("should respect maxScaleUpSteps", async () => {
      const stepLimitedConfig = { ...mockConfig, maxScaleUpSteps: 1 };
      manager.registerPool("test-pool", stepLimitedConfig);
      
      // Add high utilization stats
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 1500,
          peakConnections: 5,
          utilizationRate: 90,
          errorRate: 0.05,
          requestsPerMinute: 100,
        });
      }
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      // Should scale up by at most maxScaleUpSteps (1)
      expect(updatedConfig?.maxConnections).toBeLessThanOrEqual(mockConfig.maxConnections + 1);
    });
  });

  describe("pool scaling - scale down", () => {
    it("should scale down when utilization is low", async () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add stats showing low utilization
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 200, // Below 500ms
          peakConnections: 2,
          utilizationRate: 30, // Below 40% threshold
          errorRate: 0.05,
          requestsPerMinute: 20,
        });
      }
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      expect(updatedConfig?.maxConnections).toBeLessThan(mockConfig.maxConnections);
    });

    it("should respect minEffectiveConnections limit", async () => {
      const limitedConfig = { ...mockConfig, maxConnections: 3, minEffectiveConnections: 2 };
      manager.registerPool("test-pool", limitedConfig);
      
      // Add stats showing very low utilization
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 100,
          peakConnections: 1,
          utilizationRate: 10,
          errorRate: 0.01,
          requestsPerMinute: 5,
        });
      }
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      expect(updatedConfig?.maxConnections).toBeGreaterThanOrEqual(2);
    });

    it("should enforce scale down delay", async () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add low utilization stats
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 200,
          peakConnections: 2,
          utilizationRate: 30,
          errorRate: 0.05,
          requestsPerMinute: 20,
        });
      }
      
      // First scale action
      await vi.advanceTimersByTimeAsync(30000);
      const firstConfig = manager.getPoolConfig("test-pool");
      
      // Add more low utilization stats
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 200,
          peakConnections: 1,
          utilizationRate: 20,
          errorRate: 0.05,
          requestsPerMinute: 15,
        });
      }
      
      // Try to scale again immediately (within scaleDownDelay)
      await vi.advanceTimersByTimeAsync(30000);
      const secondConfig = manager.getPoolConfig("test-pool");
      
      // Should not have scaled down again due to delay
      expect(secondConfig?.maxConnections).toBe(firstConfig?.maxConnections);
      
      // Wait for full delay period and try again
      await vi.advanceTimersByTimeAsync(120000);
      const thirdConfig = manager.getPoolConfig("test-pool");
      
      // Now it should be able to scale down again
      if (firstConfig?.maxConnections !== undefined && thirdConfig?.maxConnections !== undefined) {
        expect(thirdConfig.maxConnections).toBeLessThanOrEqual(firstConfig.maxConnections);
      }
    });
  });

  describe("adaptive scaling toggle", () => {
    it("should not scale when adaptiveScaling is disabled", async () => {
      const noScalingConfig = { ...mockConfig, adaptiveScaling: false };
      manager.registerPool("test-pool", noScalingConfig);
      
      // Add high utilization stats
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 1500,
          peakConnections: 5,
          utilizationRate: 90,
          errorRate: 0.05,
          requestsPerMinute: 100,
        });
      }
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      expect(updatedConfig?.maxConnections).toBe(noScalingConfig.maxConnections);
    });
  });

  describe("insufficient data handling", () => {
    it("should not scale with insufficient history", async () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add only 2 stats (need at least 3)
      manager.updatePoolStats("test-pool", {
        averageWaitTime: 1500,
        peakConnections: 5,
        utilizationRate: 90,
        errorRate: 0.05,
        requestsPerMinute: 100,
      });
      
      manager.updatePoolStats("test-pool", {
        averageWaitTime: 1600,
        peakConnections: 5,
        utilizationRate: 92,
        errorRate: 0.05,
        requestsPerMinute: 105,
      });
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      expect(updatedConfig?.maxConnections).toBe(mockConfig.maxConnections);
    });
  });

  describe("getRecommendedConfig", () => {
    it("should return IMAP-specific configuration", () => {
      const config = DynamicPoolManager.getRecommendedConfig("imap");
      
      expect(config.maxConnections).toBe(3);
      expect(config.minEffectiveConnections).toBe(1);
      expect(config.maxEffectiveConnections).toBe(8);
      expect(config.adaptiveScaling).toBe(true);
    });

    it("should return SMTP-specific configuration", () => {
      const config = DynamicPoolManager.getRecommendedConfig("smtp");
      
      expect(config.maxConnections).toBe(2);
      expect(config.minEffectiveConnections).toBe(1);
      expect(config.maxEffectiveConnections).toBe(5);
      expect(config.adaptiveScaling).toBe(true);
    });

    it("should have faster retry settings for both types", () => {
      const imapConfig = DynamicPoolManager.getRecommendedConfig("imap");
      const smtpConfig = DynamicPoolManager.getRecommendedConfig("smtp");
      
      expect(imapConfig.acquireTimeoutMs).toBe(3000);
      expect(imapConfig.retryDelayMs).toBe(200);
      expect(smtpConfig.acquireTimeoutMs).toBe(3000);
      expect(smtpConfig.retryDelayMs).toBe(200);
    });
  });

  describe("edge cases", () => {
    it("should handle non-existent pool gracefully", () => {
      const config = manager.getPoolConfig("non-existent");
      expect(config).toBeUndefined();
      
      const stats = manager.getPoolStats("non-existent");
      expect(stats).toEqual([]);
    });

    it("should handle concurrent scale operations", async () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add high utilization stats
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 1500,
          peakConnections: 5,
          utilizationRate: 90,
          errorRate: 0.05,
          requestsPerMinute: 100,
        });
      }
      
      // Trigger multiple adjustment cycles rapidly
      const promises = [
        vi.advanceTimersByTimeAsync(30000),
        vi.advanceTimersByTimeAsync(30000),
        vi.advanceTimersByTimeAsync(30000),
      ];
      
      await Promise.all(promises);
      
      // Should complete without errors
      const config = manager.getPoolConfig("test-pool");
      expect(config).toBeDefined();
    });

    it("should handle extreme utilization values", async () => {
      manager.registerPool("test-pool", mockConfig);
      
      // Add stats with extreme values
      for (let i = 0; i < 5; i++) {
        manager.updatePoolStats("test-pool", {
          averageWaitTime: 10000,
          peakConnections: 100,
          utilizationRate: 99.9,
          errorRate: 0,
          requestsPerMinute: 1000,
        });
      }
      
      await vi.advanceTimersByTimeAsync(30000);
      
      const updatedConfig = manager.getPoolConfig("test-pool");
      // Should still respect maxEffectiveConnections
      expect(updatedConfig?.maxConnections).toBeLessThanOrEqual(mockConfig.maxEffectiveConnections);
    });
  });
});
