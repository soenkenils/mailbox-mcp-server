export interface ConnectionPoolConfig {
  minConnections: number;
  maxConnections: number;
  acquireTimeoutMs: number;
  idleTimeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
  healthCheckIntervalMs: number;
}

export interface ConnectionWrapper<T> {
  connection: T;
  createdAt: Date;
  lastUsed: Date;
  isHealthy: boolean;
  inUse: boolean;
  id: string;
}

export interface PoolMetrics {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  totalCreated: number;
  totalDestroyed: number;
  totalAcquired: number;
  totalReleased: number;
  totalErrors: number;
  averageConnectionAge: number;
  averageIdleTime: number;
  connectionUtilization: number;
  healthyConnections: number;
  unhealthyConnections: number;
  lastHealthCheck?: Date;
  connectionErrors: Array<{
    timestamp: Date;
    error: string;
    context: string;
  }>;
}

export abstract class ConnectionPool<T> {
  protected config: ConnectionPoolConfig;
  protected connections: Map<string, ConnectionWrapper<T>>;
  protected waitingQueue: Array<{
    resolve: (connection: ConnectionWrapper<T>) => void;
    reject: (error: Error) => void;
    requestedAt: Date;
  }>;
  protected metrics: PoolMetrics;
  private healthCheckInterval?: NodeJS.Timeout;
  private isShuttingDown = false;
  private connectionErrors: Array<{
    timestamp: Date;
    error: string;
    context: string;
  }> = [];
  private maxErrorHistory = 100; // Keep last 100 errors

  constructor(config: ConnectionPoolConfig) {
    this.config = config;
    this.connections = new Map();
    this.waitingQueue = [];
    this.metrics = {
      totalConnections: 0,
      activeConnections: 0,
      idleConnections: 0,
      waitingRequests: 0,
      totalCreated: 0,
      totalDestroyed: 0,
      totalAcquired: 0,
      totalReleased: 0,
      totalErrors: 0,
      averageConnectionAge: 0,
      averageIdleTime: 0,
      connectionUtilization: 0,
      healthyConnections: 0,
      unhealthyConnections: 0,
      connectionErrors: [],
    };

    this.startHealthCheck();
  }

  abstract createConnection(): Promise<T>;
  abstract validateConnection(connection: T): Promise<boolean>;
  abstract destroyConnection(connection: T): Promise<void>;

  async acquire(): Promise<ConnectionWrapper<T>> {
    if (this.isShuttingDown) {
      throw new Error("Connection pool is shutting down");
    }

    this.metrics.waitingRequests++;

    try {
      // Try to find an available idle connection
      const idleConnection = this.findIdleConnection();
      if (idleConnection) {
        this.metrics.waitingRequests--;
        return await this.activateConnection(idleConnection);
      }

      // Try to create a new connection if under max limit
      if (this.connections.size < this.config.maxConnections) {
        const wrapper = await this.createNewConnection();
        this.metrics.waitingRequests--;
        return wrapper;
      }

      // Wait for a connection to become available
      const wrapper = await this.waitForConnection();
      return wrapper;
    } catch (error) {
      this.metrics.waitingRequests--;
      this.metrics.totalErrors++;
      throw error;
    }
  }

  async release(wrapper: ConnectionWrapper<T>): Promise<void> {
    if (!this.connections.has(wrapper.id)) {
      console.warn(`Attempting to release unknown connection ${wrapper.id}`);
      return;
    }

    wrapper.inUse = false;
    wrapper.lastUsed = new Date();
    this.metrics.activeConnections--;
    this.metrics.idleConnections++;
    this.metrics.totalReleased++;

    // Process waiting queue
    if (this.waitingQueue.length > 0) {
      const request = this.waitingQueue.shift()!;
      try {
        const activatedWrapper = await this.activateConnection(wrapper);
        request.resolve(activatedWrapper);
      } catch (error) {
        request.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    this.updateMetrics();
  }

  async destroy(): Promise<void> {
    this.isShuttingDown = true;

    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    // Reject all waiting requests
    while (this.waitingQueue.length > 0) {
      const request = this.waitingQueue.shift()!;
      request.reject(new Error("Connection pool is shutting down"));
    }

    // Destroy all connections
    const promises: Promise<void>[] = [];
    for (const wrapper of this.connections.values()) {
      promises.push(this.destroyConnectionWrapper(wrapper));
    }

    await Promise.allSettled(promises);
    this.connections.clear();
    this.updateMetrics();
  }

  getMetrics(): PoolMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  private findIdleConnection(): ConnectionWrapper<T> | null {
    for (const wrapper of this.connections.values()) {
      if (!wrapper.inUse && wrapper.isHealthy) {
        return wrapper;
      }
    }
    return null;
  }

  private async createNewConnection(): Promise<ConnectionWrapper<T>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const connection = await this.createConnection();
        const wrapper: ConnectionWrapper<T> = {
          connection,
          createdAt: new Date(),
          lastUsed: new Date(),
          isHealthy: true,
          inUse: true,
          id: this.generateConnectionId(),
        };

        this.connections.set(wrapper.id, wrapper);
        this.metrics.totalConnections++;
        this.metrics.activeConnections++;
        this.metrics.totalCreated++;
        this.metrics.totalAcquired++;
        this.updateMetrics();

        return wrapper;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.metrics.totalErrors++;
        this.recordError(
          lastError.message,
          `createConnection attempt ${attempt + 1}`,
        );

        // If this is not the last attempt, wait with exponential backoff
        if (attempt < this.config.maxRetries) {
          const backoffDelay = this.calculateExponentialBackoff(attempt);
          console.error(
            `Connection creation failed (attempt ${attempt + 1}/${this.config.maxRetries + 1}), retrying in ${backoffDelay}ms: ${lastError.message}`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffDelay));
        }
      }
    }

    throw new Error(
      `Failed to create connection after ${this.config.maxRetries + 1} attempts: ${lastError?.message || "Unknown error"}`,
    );
  }

  protected async activateConnection(
    wrapper: ConnectionWrapper<T>,
  ): Promise<ConnectionWrapper<T>> {
    // Validate connection health before activation
    const isValid = await this.validateConnection(wrapper.connection);
    if (!isValid) {
      await this.destroyConnectionWrapper(wrapper);
      throw new Error("Connection validation failed");
    }

    wrapper.inUse = true;
    wrapper.lastUsed = new Date();
    wrapper.isHealthy = true;
    this.metrics.activeConnections++;
    this.metrics.idleConnections--;
    this.metrics.totalAcquired++;

    return wrapper;
  }

  private async waitForConnection(): Promise<ConnectionWrapper<T>> {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const index = this.waitingQueue.findIndex(
          (req) => req.resolve === resolve,
        );
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
          this.metrics.waitingRequests--;
        }
        reject(
          new Error(
            `Connection acquire timeout after ${this.config.acquireTimeoutMs}ms`,
          ),
        );
      }, this.config.acquireTimeoutMs);

      this.waitingQueue.push({
        resolve: (wrapper) => {
          clearTimeout(timeoutId);
          resolve(wrapper);
        },
        reject: (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
        requestedAt: new Date(),
      });
    });
  }

  protected async destroyConnectionWrapper(
    wrapper: ConnectionWrapper<T>,
  ): Promise<void> {
    try {
      await this.destroyConnection(wrapper.connection);
    } catch (error) {
      console.warn(`Error destroying connection ${wrapper.id}:`, error);
    } finally {
      this.connections.delete(wrapper.id);
      if (wrapper.inUse) {
        this.metrics.activeConnections--;
      } else {
        this.metrics.idleConnections--;
      }
      this.metrics.totalConnections--;
      this.metrics.totalDestroyed++;
    }
  }

  private startHealthCheck(): void {
    this.healthCheckInterval = setInterval(async () => {
      await this.performHealthCheck();
    }, this.config.healthCheckIntervalMs);
  }

  private async performHealthCheck(): Promise<void> {
    const now = new Date();
    const idleTimeout = this.config.idleTimeoutMs;
    const connectionsToDestroy: ConnectionWrapper<T>[] = [];

    // Check for idle connections that should be removed
    for (const wrapper of this.connections.values()) {
      if (!wrapper.inUse) {
        const idleTime = now.getTime() - wrapper.lastUsed.getTime();
        if (
          idleTime > idleTimeout &&
          this.connections.size > this.config.minConnections
        ) {
          connectionsToDestroy.push(wrapper);
        } else {
          // Validate idle connections periodically
          try {
            const isValid = await this.validateConnection(wrapper.connection);
            wrapper.isHealthy = isValid;
            if (!isValid) {
              connectionsToDestroy.push(wrapper);
            }
          } catch (error) {
            wrapper.isHealthy = false;
            connectionsToDestroy.push(wrapper);
          }
        }
      }
    }

    // Destroy unhealthy and idle connections
    for (const wrapper of connectionsToDestroy) {
      await this.destroyConnectionWrapper(wrapper);
    }

    // Ensure minimum connections
    while (
      this.connections.size < this.config.minConnections &&
      !this.isShuttingDown
    ) {
      try {
        await this.createNewConnection();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(
          "Failed to create minimum connection during health check:",
          errorMsg,
        );
        this.recordError(errorMsg, "healthCheck createConnection");
        break;
      }
    }

    this.updateMetrics();
  }

  private updateMetrics(): void {
    let active = 0;
    let idle = 0;
    let healthy = 0;
    let unhealthy = 0;
    let totalAge = 0;
    let totalIdleTime = 0;
    let idleCount = 0;
    const now = new Date();

    for (const wrapper of this.connections.values()) {
      if (wrapper.inUse) {
        active++;
      } else {
        idle++;
        totalIdleTime += now.getTime() - wrapper.lastUsed.getTime();
        idleCount++;
      }

      if (wrapper.isHealthy) {
        healthy++;
      } else {
        unhealthy++;
      }

      totalAge += now.getTime() - wrapper.createdAt.getTime();
    }

    this.metrics.totalConnections = this.connections.size;
    this.metrics.activeConnections = active;
    this.metrics.idleConnections = idle;
    this.metrics.healthyConnections = healthy;
    this.metrics.unhealthyConnections = unhealthy;
    this.metrics.averageConnectionAge =
      this.connections.size > 0 ? totalAge / this.connections.size : 0;
    this.metrics.averageIdleTime =
      idleCount > 0 ? totalIdleTime / idleCount : 0;
    this.metrics.connectionUtilization =
      this.config.maxConnections > 0
        ? (active / this.config.maxConnections) * 100
        : 0;
    this.metrics.lastHealthCheck = now;
    this.metrics.connectionErrors = [...this.connectionErrors];
  }

  private calculateExponentialBackoff(attempt: number): number {
    // Exponential backoff: baseDelay * (2^attempt) + jitter
    const baseDelay = this.config.retryDelayMs;
    const exponentialDelay = baseDelay * Math.pow(2, attempt);
    // Add jitter (±25% randomization) to avoid thundering herd
    const jitter = exponentialDelay * 0.25 * (Math.random() - 0.5);
    const maxDelay = 30000; // Cap at 30 seconds

    return Math.min(exponentialDelay + jitter, maxDelay);
  }

  private recordError(error: string, context: string): void {
    this.connectionErrors.push({
      timestamp: new Date(),
      error,
      context,
    });

    // Keep only the last maxErrorHistory errors
    if (this.connectionErrors.length > this.maxErrorHistory) {
      this.connectionErrors.shift();
    }
  }

  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
