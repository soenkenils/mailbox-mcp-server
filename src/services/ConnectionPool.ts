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

interface WaitingRequest<T> {
  resolve: (connection: ConnectionWrapper<T>) => void;
  reject: (error: Error) => void;
  requestedAt: Date;
  settled: boolean;
}

export abstract class ConnectionPool<T> {
  protected config: ConnectionPoolConfig;
  protected connections: Map<string, ConnectionWrapper<T>>;
  protected waitingQueue: Array<WaitingRequest<T>>;
  protected metrics: PoolMetrics;
  protected logger = createLogger("ConnectionPool");
  private healthCheckInterval?: NodeJS.Timeout;
  private isShuttingDown = false;
  /**
   * Connections being opened right now. They only join `connections` once the
   * connect completes, so capacity checks count them separately.
   */
  private pendingCreations = 0;
  /**
   * Closes in progress. They still hold their slot, so a replacement is not
   * opened while the old socket is open, and destroy() waits for them.
   */
  private closing = new Map<string, Promise<void>>();
  /** Every close ever started, so a connection is closed only once. */
  private closes = new WeakMap<ConnectionWrapper<T>, Promise<void>>();
  /** Connections whose release is being handed off right now. */
  private releasing = new Set<string>();
  /** The running serveQueuedWaiters() pass, if any. */
  private serving?: Promise<void>;
  private serveAgain = false;
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

  /**
   * Whether an idle connection is due for validation by the health check.
   * Pools whose validation is expensive override this with their own
   * verification interval.
   */
  protected needsVerification(_wrapper: ConnectionWrapper<T>): boolean {
    return true;
  }

  async acquire(): Promise<ConnectionWrapper<T>> {
    if (this.isShuttingDown) {
      throw new Error("Connection pool is shutting down");
    }

    try {
      // Same path as a waiter: the next idle connection that passes
      // validation, else a new one if a slot is free. An idle connection the
      // server dropped is replaced instead of failing the acquire.
      const wrapper = await this.connectionForWaiter();
      if (wrapper) {
        if (this.isShuttingDown) {
          // destroy() ran meanwhile and closed every connection it could see.
          if (this.connections.has(wrapper.id)) {
            this.destroyInBackground(wrapper);
          }
          throw this.shutDownError();
        }
        return wrapper;
      }

      // Wait for a connection to become available
      return await this.waitForConnection();
    } catch (error) {
      this.metrics.totalErrors++;
      // A failed connect or validation frees the slot this call held, which
      // a waiter queued behind it may need.
      if (this.waitingQueue.length > 0) {
        this.serveWaitersInBackground();
      }
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

    if (!wrapper.inUse || this.releasing.has(wrapper.id)) {
      // A second release would hand one connection to two waiters.
      await this.logger.warning(
        "Ignoring release of a connection that is already released",
        {
          operation: "release",
          service: "ConnectionPool",
        },
        { connectionId: wrapper.id },
      );
      return;
    }

    wrapper.lastUsed = new Date();
    this.metrics.totalReleased++;

    this.releasing.add(wrapper.id);
    try {
      await this.handOff(wrapper);
    } finally {
      this.releasing.delete(wrapper.id);
    }
  }

  /**
   * Gives a claimed connection to the next waiter, or returns it to the idle
   * set when nobody is waiting. The connection stays claimed throughout, so
   * nothing else can take it while it is validated for the waiter. Waiters
   * stay queued during that validation, so destroy() or their own timeout can
   * still reach them; the connection goes to whoever is first afterwards.
   */
  private async handOff(wrapper: ConnectionWrapper<T>): Promise<void> {
    if (!this.hasLiveWaiter()) {
      wrapper.inUse = false;
      this.updateMetrics();
      return;
    }

    if (!wrapper.isHealthy) {
      // Unhealthy: destroy it instead of reusing a corrupted connection.
      await this.logger.warning(
        "Destroying unhealthy connection instead of reusing for waiting request",
        {
          operation: "release",
          service: "ConnectionPool",
        },
        { connectionId: wrapper.id },
      );
      this.destroyInBackground(wrapper);
      this.serveWaitersInBackground();
      return;
    }

    let activated: ConnectionWrapper<T>;
    try {
      activated = await this.activateClaimed(wrapper);
    } catch {
      // Failed validation: the connection is gone or no longer claimed.
      // The waiters are served from what is left rather than rejected,
      // without making release() wait for someone else's connect.
      this.serveWaitersInBackground();
      return;
    }

    if (this.isShuttingDown) {
      // destroy() closed the connection and rejected the waiters meanwhile.
      return;
    }
    const request = this.nextWaiter();
    if (!request) {
      // Every waiter gave up during validation.
      activated.inUse = false;
      this.updateMetrics();
      return;
    }
    request.resolve(activated);
  }

  private hasLiveWaiter(): boolean {
    return this.waitingQueue.some(request => !request.settled);
  }

  /**
   * Serves a waiter already taken off the queue: with an idle connection, a
   * new one if a slot is free, or by putting it back at the head of the
   * queue. A failed connect rejects it with that error instead of retrying,
   * so a server that is down cannot keep the pool spinning.
   */
  private async serveWaiter(request: WaitingRequest<T>): Promise<void> {
    if (request.settled) {
      return;
    }

    let wrapper: ConnectionWrapper<T> | null;
    try {
      wrapper = await this.connectionForWaiter();
    } catch (error) {
      request.reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    if (!wrapper) {
      this.waitingQueue.unshift(request);
      return;
    }
    if (this.isShuttingDown) {
      // destroy() ran meanwhile and closed every connection it could see.
      if (this.connections.has(wrapper.id)) {
        this.destroyInBackground(wrapper);
      }
      request.reject(this.shutDownError());
      return;
    }
    if (request.settled) {
      // The waiter gave up while the connection was opened.
      await this.handOff(wrapper);
      return;
    }
    request.resolve(wrapper);
  }

  /**
   * Opens connections for live waiters while slots are free. Only one run
   * at a time, so two callers cannot open two connections for one waiter;
   * a call during a run makes it check the queue once more at the end.
   */
  private serveQueuedWaiters(): Promise<void> {
    if (this.serving) {
      this.serveAgain = true;
      return this.serving;
    }
    this.serving = (async () => {
      do {
        this.serveAgain = false;
        await this.serveWaitersWhileCapacity();
      } while (this.serveAgain && !this.isShuttingDown);
    })().finally(() => {
      this.serving = undefined;
    });
    return this.serving;
  }

  private serveWaitersInBackground(): void {
    this.serveQueuedWaiters().catch(error => {
      this.logger.warning(
        "Error serving waiting requests in background",
        {
          operation: "serveQueuedWaiters",
          service: "ConnectionPool",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    });
  }

  private async serveWaitersWhileCapacity(): Promise<void> {
    while (this.hasCapacity() && !this.isShuttingDown) {
      const request = this.nextWaiter();
      if (!request) {
        return;
      }
      await this.serveWaiter(request);
    }
  }

  /**
   * A claimed connection for a waiter: an idle one that passes validation,
   * else a new one if a slot is free, else null. Each idle connection is
   * tried once, because a failed validation does not have to destroy it.
   */
  private async connectionForWaiter(): Promise<ConnectionWrapper<T> | null> {
    const tried = new Set<string>();
    for (;;) {
      const idle = this.claimIdleConnection(tried);
      if (!idle) {
        break;
      }
      tried.add(idle.id);
      try {
        return await this.activateClaimed(idle);
      } catch {
        // Try the next idle connection, or open a new one.
      }
    }

    if (this.isShuttingDown) {
      throw this.shutDownError();
    }
    return this.hasCapacity() ? await this.createNewConnection() : null;
  }

  private destroyInBackground(wrapper: ConnectionWrapper<T>): void {
    this.destroyConnectionWrapper(wrapper).catch(error => {
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
  }

  /** Next waiter that has not already timed out. */
  private nextWaiter() {
    while (this.waitingQueue.length > 0) {
      const request = this.waitingQueue.shift();
      if (request && !request.settled) {
        return request;
      }
    }
    return undefined;
  }

  /**
   * Rejects waiters and closes every registered connection. Connects still in
   * flight are not awaited: each closes its connection itself once it
   * completes, so nothing opened after this point joins the pool.
   */
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

    // Includes closes started before destroy() was called.
    promises.push(...this.closing.values());
    await Promise.allSettled(promises);
    this.connections.clear();
    this.updateMetrics();
  }

  getMetrics(): PoolMetrics {
    this.updateMetrics();
    return { ...this.metrics };
  }

  private claimIdleConnection(skip?: Set<string>): ConnectionWrapper<T> | null {
    for (const wrapper of this.connections.values()) {
      if (!wrapper.inUse && wrapper.isHealthy && !skip?.has(wrapper.id)) {
        wrapper.inUse = true;
        return wrapper;
      }
    }
    return null;
  }

  /**
   * Activates a connection already claimed by the caller. If activation fails
   * without destroying it, the claim is dropped so it can be checked again.
   */
  private async activateClaimed(
    wrapper: ConnectionWrapper<T>,
  ): Promise<ConnectionWrapper<T>> {
    try {
      return await this.activateConnection(wrapper);
    } catch (error) {
      if (this.connections.has(wrapper.id)) {
        wrapper.inUse = false;
      }
      throw error;
    }
  }

  private hasCapacity(): boolean {
    return (
      this.connections.size + this.pendingCreations + this.closing.size <
      this.config.maxConnections
    );
  }

  /**
   * Opens a connection, holding a slot for it from the start so concurrent
   * callers see the pool's real size while the connect is in flight.
   */
  private async createNewConnection(): Promise<ConnectionWrapper<T>> {
    this.pendingCreations++;
    try {
      return await this.createConnectionWithRetries();
    } finally {
      this.pendingCreations--;
    }
  }

  private async createConnectionWithRetries(): Promise<ConnectionWrapper<T>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await this.createConnectionWrapper();
      } catch (error) {
        if (this.isShuttingDown) {
          throw this.shutDownError();
        }
        lastError = error instanceof Error ? error : new Error(String(error));
        this.recordConnectionCreationError(lastError, attempt);

        // If this is not the last attempt, wait with exponential backoff
        if (attempt < this.config.maxRetries) {
          await this.handleConnectionCreationError(lastError, attempt);
          if (this.isShuttingDown) {
            throw this.shutDownError();
          }
        }
      }
    }

    throw new Error(
      `Failed to create connection after ${this.config.maxRetries + 1} attempts: ${lastError?.message || "Unknown error"}`,
    );
  }

  private async createConnectionWrapper(): Promise<ConnectionWrapper<T>> {
    const connection = await this.createConnection();
    if (this.isShuttingDown) {
      // destroy() already ran and will not see this connection: close it
      // here rather than register it in a pool nobody drains any more.
      try {
        await this.destroyConnection(connection);
      } catch {
        // Already shutting down; nothing left to recover.
      }
      throw this.shutDownError();
    }
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
    await new Promise(resolve => setTimeout(resolve, backoffDelay));
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
      const request: WaitingRequest<T> = {
        resolve: (wrapper: ConnectionWrapper<T>) => {
          if (request.settled) return;
          request.settled = true;
          clearTimeout(timeoutId);
          resolve(wrapper);
        },
        reject: (error: Error) => {
          if (request.settled) return;
          request.settled = true;
          clearTimeout(timeoutId);
          reject(error);
        },
        requestedAt: new Date(),
        settled: false,
      };

      const timeoutId = setTimeout(() => {
        if (request.settled) return;
        const index = this.waitingQueue.indexOf(request);
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
        }
        request.reject(
          new Error(
            `Connection acquire timeout after ${this.config.acquireTimeoutMs}ms`,
          ),
        );
      }, this.config.acquireTimeoutMs);

      this.waitingQueue.push(request);
    });
  }

  protected async destroyConnectionWrapper(
    wrapper: ConnectionWrapper<T>,
  ): Promise<void> {
    const started = this.closes.get(wrapper);
    if (started) {
      return started;
    }
    // Leaves the pool at once but keeps its slot until the close is done.
    this.connections.delete(wrapper.id);
    const close = this.closeWrapper(wrapper);
    this.closes.set(wrapper, close);
    this.closing.set(wrapper.id, close);
    try {
      await close;
    } finally {
      this.closing.delete(wrapper.id);
      // The slot is free now; a waiter may have been queued for it.
      if (!this.isShuttingDown && this.hasLiveWaiter()) {
        this.serveWaitersInBackground();
      }
    }
  }

  private async closeWrapper(wrapper: ConnectionWrapper<T>): Promise<void> {
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
    if (this.isShuttingDown) {
      return;
    }
    const connectionsToDestroy = await this.identifyConnectionsToDestroy();
    await this.destroyUnhealthyConnections(connectionsToDestroy);
    // Destroying freed slots that waiters may be queued for.
    await this.serveQueuedWaiters();
    await this.ensureMinimumConnections();
    this.updateMetrics();
  }

  private async identifyConnectionsToDestroy(): Promise<
    ConnectionWrapper<T>[]
  > {
    const now = new Date();
    const idleTimeout = this.config.idleTimeoutMs;
    const connectionsToDestroy: ConnectionWrapper<T>[] = [];

    for (const wrapper of [...this.connections.values()]) {
      if (wrapper.inUse) {
        continue;
      }

      // Claimed while it is checked, and kept claimed until destroyed, so an
      // acquire in the meantime cannot be handed a connection about to close.
      wrapper.inUse = true;
      const shouldDestroy = await this.shouldDestroyConnection(
        wrapper,
        now,
        idleTimeout,
        // Not yet destroyed, but already counted out of the pool.
        this.connections.size - connectionsToDestroy.length,
      );
      if (shouldDestroy) {
        connectionsToDestroy.push(wrapper);
      } else {
        await this.handOff(wrapper);
      }
    }

    return connectionsToDestroy;
  }

  private async shouldDestroyConnection(
    wrapper: ConnectionWrapper<T>,
    now: Date,
    idleTimeout: number,
    remaining: number,
  ): Promise<boolean> {
    const idleTime = now.getTime() - wrapper.lastUsed.getTime();

    // Check if connection has been idle too long
    if (idleTime > idleTimeout && remaining > this.config.minConnections) {
      return true;
    }

    // Validate idle connections periodically, but no more often than the
    // pool wants them verified: a check may cost a full login.
    if (!this.needsVerification(wrapper)) {
      return false;
    }
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
      // destroy() may have closed it already.
      if (this.connections.has(wrapper.id)) {
        await this.destroyConnectionWrapper(wrapper);
      }
    }
  }

  private async ensureMinimumConnections(): Promise<void> {
    while (
      this.connections.size + this.pendingCreations <
        this.config.minConnections &&
      !this.isShuttingDown
    ) {
      try {
        // New connections start out claimed; hand this one over so it is
        // actually available rather than held by nobody forever.
        await this.handOff(await this.createNewConnection());
      } catch (error) {
        if (this.isShuttingDown) {
          break;
        }
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
    // Derived from the queue rather than counted, so it cannot drift and
    // covers only requests actually queued, not those opening a connection.
    this.metrics.waitingRequests = this.waitingQueue.filter(
      request => !request.settled,
    ).length;
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

  private shutDownError(): Error {
    return new Error("Connection pool is shut down");
  }

  private generateConnectionId(): string {
    return `conn_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}
