import { ImapFlow } from "imapflow";
import type { ImapConnection } from "../types/email.types.js";
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerMetrics,
} from "./CircuitBreaker.js";
import {
  ConnectionPool,
  type ConnectionPoolConfig,
  type ConnectionWrapper,
} from "./ConnectionPool.js";
import { createLogger } from "./Logger.js";

export interface ImapConnectionWrapper extends ConnectionWrapper<ImapFlow> {
  selectedFolder?: string;
}

export interface ImapPoolConfig extends ConnectionPoolConfig {
  connectionConfig: ImapConnection;
  circuitBreaker?: CircuitBreakerConfig;
}

export class ImapConnectionPool extends ConnectionPool<ImapFlow> {
  private connectionConfig: ImapConnection;
  private circuitBreaker: CircuitBreaker;
  protected logger = createLogger("ImapConnectionPool");

  constructor(config: ImapPoolConfig) {
    super(config);
    this.connectionConfig = config.connectionConfig;

    // Initialize circuit breaker with defaults or provided config
    const cbConfig = config.circuitBreaker || {
      failureThreshold: 5,
      recoveryTimeout: 6000, // 6 seconds
      monitoringInterval: 3000, // 3 seconds
    };
    this.circuitBreaker = new CircuitBreaker(cbConfig);
  }

  async createConnection(): Promise<ImapFlow> {
    return this.circuitBreaker.execute(async () => {
      const client = new ImapFlow({
        host: this.connectionConfig.host,
        port: this.connectionConfig.port,
        secure: this.connectionConfig.secure,
        auth: {
          user: this.connectionConfig.user,
          pass: this.connectionConfig.password,
        },
        logger: false, // Disable logging for production
      });

      // Set up error handling
      client.on("error", (error: Error) => {
        this.logger.error(
          "IMAP connection error",
          {
            operation: "createConnection",
            service: "ImapConnectionPool",
          },
          { error: error.message },
        );
      });

      await client.connect();
      return client;
    });
  }

  async validateConnection(connection: ImapFlow): Promise<boolean> {
    try {
      // Check if connection is still alive by getting capabilities
      if (!connection.usable) {
        return false;
      }

      // Try a simple operation to verify the connection with a timeout
      // to prevent hanging on stuck connections
      const noopPromise = connection.noop();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error("Connection validation timeout")),
          3000,
        );
      });

      await Promise.race([noopPromise, timeoutPromise]);
      return true;
    } catch (error) {
      await this.logger.warning(
        "IMAP connection validation failed",
        {
          operation: "validateConnection",
          service: "ImapConnectionPool",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }
  }

  async destroyConnection(connection: ImapFlow): Promise<void> {
    try {
      if (connection.usable) {
        await connection.logout();
      }
    } catch (error) {
      await this.logger.warning(
        "Error during IMAP logout",
        {
          operation: "destroyConnection",
          service: "ImapConnectionPool",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  async acquireForFolder(folder: string): Promise<ImapConnectionWrapper> {
    const wrapper = (await this.acquire()) as ImapConnectionWrapper;

    try {
      // Ensure the correct folder is selected
      if (wrapper.selectedFolder !== folder) {
        // Add timeout protection to prevent hanging on mailboxOpen
        const openPromise = wrapper.connection.mailboxOpen(folder);
        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error("Folder selection timed out after 5000ms")),
            5000,
          );
        });

        await Promise.race([openPromise, timeoutPromise]);
        wrapper.selectedFolder = folder;
      }

      return wrapper;
    } catch (error) {
      // If folder selection fails, mark connection as unhealthy and release
      wrapper.isHealthy = false;
      await this.release(wrapper);
      throw new Error(
        `Failed to select folder ${folder}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async releaseFromFolder(wrapper: ImapConnectionWrapper): Promise<void> {
    // Keep the selected folder information for potential reuse
    await this.release(wrapper);
  }

  // Override release to handle folder state
  async release(wrapper: ConnectionWrapper<ImapFlow>): Promise<void> {
    const imapWrapper = wrapper as ImapConnectionWrapper;

    // Reset folder selection state if connection is unhealthy
    if (!imapWrapper.isHealthy) {
      imapWrapper.selectedFolder = undefined;
    }

    await super.release(wrapper);
  }

  // Get pool status with IMAP-specific information
  getImapMetrics() {
    const baseMetrics = this.getMetrics();
    const folderDistribution: Record<string, number> = {};

    for (const wrapper of this.connections.values()) {
      const imapWrapper = wrapper as ImapConnectionWrapper;
      if (imapWrapper.selectedFolder && !imapWrapper.inUse) {
        folderDistribution[imapWrapper.selectedFolder] =
          (folderDistribution[imapWrapper.selectedFolder] || 0) + 1;
      }
    }

    return {
      ...baseMetrics,
      folderDistribution,
      circuitBreaker: this.circuitBreaker.getMetrics(),
    };
  }

  // Get circuit breaker metrics
  getCircuitBreakerMetrics(): CircuitBreakerMetrics {
    return this.circuitBreaker.getMetrics();
  }

  // Reset circuit breaker (for administrative purposes)
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  // Method to invalidate connections for a specific folder
  async invalidateFolderConnections(folder: string): Promise<void> {
    for (const wrapper of this.connections.values()) {
      const imapWrapper = wrapper as ImapConnectionWrapper;
      if (imapWrapper.selectedFolder === folder) {
        imapWrapper.isHealthy = false;
        imapWrapper.selectedFolder = undefined;
      }
    }
  }
}
