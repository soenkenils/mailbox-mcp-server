import type { ConnectionPoolConfig } from "./ConnectionPool.js";
import { createLogger } from "./Logger.js";

export interface PoolUsageStats {
  averageWaitTime: number;
  peakConnections: number;
  utilizationRate: number;
  errorRate: number;
  requestsPerMinute: number;
}

export interface DynamicPoolConfig extends ConnectionPoolConfig {
  adaptiveScaling: boolean;
  targetUtilization: number; // Target utilization percentage (0-100)
  scaleUpThreshold: number; // Utilization threshold to scale up
  scaleDownThreshold: number; // Utilization threshold to scale down
  maxScaleUpSteps: number; // Maximum number of connections to add at once
  scaleDownDelay: number; // Time to wait before scaling down (ms)
  minEffectiveConnections: number; // Minimum connections for effective operation
  maxEffectiveConnections: number; // Maximum connections for effective operation
}

export class DynamicPoolManager {
  private logger = createLogger("DynamicPoolManager");
  private pools = new Map<string, DynamicPoolConfig>();
  private usageHistory = new Map<string, PoolUsageStats[]>();
  private lastScaleAction = new Map<string, Date>();
  private readonly historySize = 10; // Keep last 10 measurements

  constructor() {
    // Start monitoring and adjustment cycle
    setInterval(() => {
      this.adjustPoolSizes();
    }, 30000); // Adjust every 30 seconds
  }

  registerPool(poolName: string, config: DynamicPoolConfig): void {
    this.pools.set(poolName, config);
    this.usageHistory.set(poolName, []);
  }

  updatePoolStats(poolName: string, stats: PoolUsageStats): void {
    const history = this.usageHistory.get(poolName) || [];
    history.push(stats);

    // Keep only recent history
    if (history.length > this.historySize) {
      history.shift();
    }

    this.usageHistory.set(poolName, history);
  }

  private async adjustPoolSizes(): Promise<void> {
    for (const [poolName, config] of this.pools.entries()) {
      if (!config.adaptiveScaling) continue;

      try {
        const newConfig = await this.calculateOptimalPoolSize(poolName, config);
        if (newConfig && this.shouldUpdateConfig(config, newConfig)) {
          await this.updatePoolConfig(poolName, newConfig);
        }
      } catch (error) {
        await this.logger.warning(
          "Failed to adjust pool size",
          {
            operation: "adjustPoolSizes",
            service: "DynamicPoolManager",
          },
          {
            poolName,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
    }
  }

  private async calculateOptimalPoolSize(
    poolName: string,
    currentConfig: DynamicPoolConfig,
  ): Promise<Partial<DynamicPoolConfig> | null> {
    const history = this.usageHistory.get(poolName) || [];
    if (history.length < 3) return null; // Need enough data

    const avgStats = this.calculateAverageStats(history);
    const now = new Date();
    const lastScale = this.lastScaleAction.get(poolName);

    // Prevent too frequent scaling
    if (
      lastScale &&
      now.getTime() - lastScale.getTime() < currentConfig.scaleDownDelay
    ) {
      return null;
    }

    let newMaxConnections = currentConfig.maxConnections;
    let actionTaken = false;

    // Scale up if utilization is high and wait times are increasing
    if (
      avgStats.utilizationRate > currentConfig.scaleUpThreshold &&
      avgStats.averageWaitTime > 1000 && // 1 second wait time threshold
      avgStats.errorRate < 0.1 // Don't scale up if we have high errors
    ) {
      const scaleUpAmount = Math.min(
        currentConfig.maxScaleUpSteps,
        Math.ceil(currentConfig.maxConnections * 0.5), // Scale up by 50% max
      );
      newMaxConnections = Math.min(
        currentConfig.maxEffectiveConnections,
        currentConfig.maxConnections + scaleUpAmount,
      );
      actionTaken = newMaxConnections > currentConfig.maxConnections;

      if (actionTaken) {
        await this.logger.info(
          "Scaling up connection pool",
          {
            operation: "scaleUp",
            service: "DynamicPoolManager",
          },
          {
            poolName,
            oldMax: currentConfig.maxConnections,
            newMax: newMaxConnections,
            utilization: avgStats.utilizationRate,
            waitTime: avgStats.averageWaitTime,
          },
        );
      }
    }
    // Scale down if utilization is consistently low
    else if (
      avgStats.utilizationRate < currentConfig.scaleDownThreshold &&
      avgStats.averageWaitTime < 500 && // Low wait times
      currentConfig.maxConnections > currentConfig.minEffectiveConnections
    ) {
      const scaleDownAmount = Math.max(
        1,
        Math.ceil(currentConfig.maxConnections * 0.25),
      ); // Scale down by 25% max
      newMaxConnections = Math.max(
        currentConfig.minEffectiveConnections,
        currentConfig.maxConnections - scaleDownAmount,
      );
      actionTaken = newMaxConnections < currentConfig.maxConnections;

      if (actionTaken) {
        await this.logger.info(
          "Scaling down connection pool",
          {
            operation: "scaleDown",
            service: "DynamicPoolManager",
          },
          {
            poolName,
            oldMax: currentConfig.maxConnections,
            newMax: newMaxConnections,
            utilization: avgStats.utilizationRate,
            waitTime: avgStats.averageWaitTime,
          },
        );
      }
    }

    if (actionTaken) {
      this.lastScaleAction.set(poolName, now);
      return {
        maxConnections: newMaxConnections,
      };
    }

    return null;
  }

  private calculateAverageStats(history: PoolUsageStats[]): PoolUsageStats {
    const count = history.length;
    return {
      averageWaitTime:
        history.reduce((sum, stat) => sum + stat.averageWaitTime, 0) / count,
      peakConnections: Math.max(...history.map(stat => stat.peakConnections)),
      utilizationRate:
        history.reduce((sum, stat) => sum + stat.utilizationRate, 0) / count,
      errorRate: history.reduce((sum, stat) => sum + stat.errorRate, 0) / count,
      requestsPerMinute:
        history.reduce((sum, stat) => sum + stat.requestsPerMinute, 0) / count,
    };
  }

  private shouldUpdateConfig(
    current: DynamicPoolConfig,
    proposed: Partial<DynamicPoolConfig>,
  ): boolean {
    if (!proposed.maxConnections) return false;
    return proposed.maxConnections !== current.maxConnections;
  }

  private async updatePoolConfig(
    poolName: string,
    newConfig: Partial<DynamicPoolConfig>,
  ): Promise<void> {
    const currentConfig = this.pools.get(poolName);
    if (!currentConfig || !newConfig.maxConnections) return;

    // Update the stored config
    const updatedConfig = { ...currentConfig, ...newConfig };
    this.pools.set(poolName, updatedConfig);

    await this.logger.info(
      "Pool configuration updated",
      {
        operation: "updatePoolConfig",
        service: "DynamicPoolManager",
      },
      {
        poolName,
        newMaxConnections: newConfig.maxConnections,
        previousMaxConnections: currentConfig.maxConnections,
      },
    );
  }

  getPoolConfig(poolName: string): DynamicPoolConfig | undefined {
    return this.pools.get(poolName);
  }

  getPoolStats(poolName: string): PoolUsageStats[] {
    return this.usageHistory.get(poolName) || [];
  }

  // Method to get recommended configuration for a new pool
  static getRecommendedConfig(poolType: "imap" | "smtp"): DynamicPoolConfig {
    const baseConfig = {
      minConnections: 1,
      acquireTimeoutMs: 3000, // Fast fail: 3 seconds instead of 15
      idleTimeoutMs: 30000,
      maxRetries: 5, // More retries to compensate
      retryDelayMs: 200, // Much faster retry: 200ms instead of 1000ms
      healthCheckIntervalMs: 6000,
      // Dynamic scaling configuration
      adaptiveScaling: true,
      targetUtilization: 70,
      scaleUpThreshold: 85,
      scaleDownThreshold: 40,
      maxScaleUpSteps: 2,
      scaleDownDelay: 120000, // 2 minutes
    };

    if (poolType === "imap") {
      return {
        ...baseConfig,
        maxConnections: 3, // Start with moderate size
        minEffectiveConnections: 1,
        maxEffectiveConnections: 8,
      };
    }

    // smtp
    return {
      ...baseConfig,
      maxConnections: 2, // SMTP typically needs fewer connections
      minEffectiveConnections: 1,
      maxEffectiveConnections: 5,
    };
  }
}

export const dynamicPoolManager = new DynamicPoolManager();
