import { createLogger } from "./Logger.js";

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
  protected logger = createLogger("ConnectionPool");
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
        // Activate the connection - if this fails, the error will be caught below
        // and waitingRequests will be decremented in the catch block
        const activated = await this.activateConnection(idleConnection);
        this.metrics.waitingRequests--;
        return activated;
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
      await this.logger.warning(
        "Attempting to release unknown connection",
        {
          operation: "release",
          service: "ConnectionPool",
        },
        { connectionId: wrapper.id },
      );
      return;
    }

    wrapper.inUse = false;
    wrapper.lastUsed = new Date();
    this.metrics.activeConnections--;
    this.metrics.idleConnections++;
    this.metrics.totalReleased++;

    // Process waiting queue
    if (this.waitingQueue.length > 0) {
      const request = this.waitingQueue.shift();
      if (!request) return; // Safety check

      // CRITICAL FIX: If connection is unhealthy, destroy it immediately
      // and create a new connection for the waiting request instead of
      // trying to validate/activate it (which could hang if the connection
      // is stuck from a timed-out operation)
      if (!wrapper.isHealthy) {
        await this.logger.warning(
          "Destroying unhealthy connection instead of reusing for waiting request",
          {
            operation: "release",
            service: "ConnectionPool",
          },
          { connectionId: wrapper.id },
        );

        // Destroy the unhealthy connection (don't await to avoid blocking)
        this.destroyConnectionWrapper(wrapper).catch((error) => {
          this.logger.warning(
            "Error destroying unhealthy connection in background",
            {
              operation: "release",
              service: "ConnectionPool",
            },
            {
              connectionId: wrapper.id,
              error: error instanceof Error ? error.message : String(error),
            },
          );
        });

        // Try to create a new connection for the waiting request
        try {
          const newWrapper = await this.createNewConnection();
          request.resolve(newWrapper);
        } catch (error) {
          request.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        return;
      }

      // Connection is healthy, try to activate it for the waiting request
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
      const request = this.waitingQueue.shift();
      if (!request) break; // Safety check
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
    return this.createConnectionWithRetries();
  }

  private async createConnectionWithRetries(): Promise<ConnectionWrapper<T>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.createConnectionWrapper();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordConnectionCreationError(lastError, attempt);

        // If this is not the last attempt, wait with exponential backoff
        if (attempt < this.config.maxRetries) {
          await this.handleConnectionCreationError(lastError, attempt);
        }
      }
    }

    throw new Error(
      `Failed to create connection after ${this.config.maxRetries + 1} attempts: ${lastError?.message || "Unknown error"}`,
    );
  }

  private async createConnectionWrapper(): Promise<ConnectionWrapper<T>> {
    const connection = await this.createConnection();
    const wrapper: ConnectionWrapper<T> = {
      connection,
      createdAt: new Date(),
      lastUsed: new Date(),
      isHealthy: true,
      inUse: true,
      id: this.generateConnectionId(),
    };

    this.registerConnection(wrapper);
    return wrapper;
  }

  private registerConnection(wrapper: ConnectionWrapper<T>): void {
    this.connections.set(wrapper.id, wrapper);
    this.metrics.totalConnections++;
    this.metrics.activeConnections++;
    this.metrics.totalCreated++;
    this.metrics.totalAcquired++;
    this.updateMetrics();
  }

  private recordConnectionCreationError(error: Error, attempt: number): void {
    this.metrics.totalErrors++;
    this.recordError(error.message, `createConnection attempt ${attempt + 1}`);
  }

  private async handleConnectionCreationError(
    error: Error,
    attempt: number,
  ): Promise<void> {
    const backoffDelay = this.calculateExponentialBackoff(attempt);
    await this.logger.warning(
      "Connection creation failed, retrying",
      {
        operation: "createNewConnection",
        service: "ConnectionPool",
      },
      {
        attempt: attempt + 1,
        maxRetries: this.config.maxRetries + 1,
        backoffDelay,
        error: error.message,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, backoffDelay));
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
      await this.logger.warning(
        "Error destroying connection",
        {
          operation: "destroyConnectionWrapper",
          service: "ConnectionPool",
        },
        {
          connectionId: wrapper.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
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
    const connectionsToDestroy = await this.identifyConnectionsToDestroy();
    await this.destroyUnhealthyConnections(connectionsToDestroy);
    await this.ensureMinimumConnections();
    this.updateMetrics();
  }

  private async identifyConnectionsToDestroy(): Promise<
    ConnectionWrapper<T>[]
  > {
    const now = new Date();
    const idleTimeout = this.config.idleTimeoutMs;
    const connectionsToDestroy: ConnectionWrapper<T>[] = [];

    for (const wrapper of this.connections.values()) {
      if (!wrapper.inUse) {
        const shouldDestroy = await this.shouldDestroyConnection(
          wrapper,
          now,
          idleTimeout,
        );
        if (shouldDestroy) {
          connectionsToDestroy.push(wrapper);
        }
      }
    }

    return connectionsToDestroy;
  }

  private async shouldDestroyConnection(
    wrapper: ConnectionWrapper<T>,
    now: Date,
    idleTimeout: number,
  ): Promise<boolean> {
    const idleTime = now.getTime() - wrapper.lastUsed.getTime();

    // Check if connection has been idle too long
    if (
      idleTime > idleTimeout &&
      this.connections.size > this.config.minConnections
    ) {
      return true;
    }

    // Validate idle connections periodically
    try {
      const isValid = await this.validateConnection(wrapper.connection);
      wrapper.isHealthy = isValid;
      return !isValid;
    } catch (error) {
      wrapper.isHealthy = false;
      return true;
    }
  }

  private async destroyUnhealthyConnections(
    connectionsToDestroy: ConnectionWrapper<T>[],
  ): Promise<void> {
    for (const wrapper of connectionsToDestroy) {
      await this.destroyConnectionWrapper(wrapper);
    }
  }

  private async ensureMinimumConnections(): Promise<void> {
    while (
      this.connections.size < this.config.minConnections &&
      !this.isShuttingDown
    ) {
      try {
        await this.createNewConnection();
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        await this.logger.warning(
          "Failed to create minimum connection during health check",
          {
            operation: "performHealthCheck",
            service: "ConnectionPool",
          },
          { error: errorMsg },
        );
        this.recordError(errorMsg, "healthCheck createConnection");
        break;
      }
    }
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
    // Linear backoff for faster recovery: baseDelay * (1 + attempt)
    const baseDelay = this.config.retryDelayMs;
    const linearDelay = baseDelay * (1 + attempt);
    // Add small jitter (±10% randomization) to avoid thundering herd
    const jitter = linearDelay * 0.1 * (Math.random() - 0.5);
    const maxDelay = 2000; // Cap at 2 seconds for fast feedback

    return Math.min(linearDelay + jitter, maxDelay);
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
