import nodemailer, { type Transporter } from "nodemailer";
import type { SmtpConnection } from "../types/email.types.js";
import {
  ConnectionPool,
  type ConnectionPoolConfig,
  type ConnectionWrapper,
} from "./ConnectionPool.js";

export interface SmtpConnectionWrapper extends ConnectionWrapper<Transporter> {
  lastVerified?: Date;
  verificationFailures: number;
}

export interface SmtpPoolConfig extends ConnectionPoolConfig {
  connectionConfig: SmtpConnection;
  verificationIntervalMs?: number;
  maxVerificationFailures?: number;
}

export class SmtpConnectionPool extends ConnectionPool<Transporter> {
  private smtpConfig: SmtpConnection;
  private verificationIntervalMs: number;
  private maxVerificationFailures: number;

  get connectionConfig(): SmtpConnection {
    return this.smtpConfig;
  }

  constructor(config: SmtpPoolConfig) {
    super(config);
    this.smtpConfig = config.connectionConfig;
    this.verificationIntervalMs = config.verificationIntervalMs || 300000; // 5 minutes
    this.maxVerificationFailures = config.maxVerificationFailures || 3;
  }

  async createConnection(): Promise<Transporter> {
    const transportOptions = {
      host: this.smtpConfig.host,
      port: this.smtpConfig.port,
      secure: this.smtpConfig.secure,
      auth: {
        user: this.smtpConfig.user,
        pass: this.smtpConfig.password,
      },
      tls: {
        rejectUnauthorized: false,
      },
      pool: false, // We handle pooling ourselves
      maxConnections: 1,
      maxMessages: Number.POSITIVE_INFINITY,
    };

    const transporter = nodemailer.createTransport(transportOptions);

    // Verify the connection immediately after creation
    await transporter.verify();
    return transporter;
  }

  async validateConnection(connection: Transporter): Promise<boolean> {
    try {
      await connection.verify();
      return true;
    } catch (error) {
      await this.logger.warning(
        "SMTP connection validation failed",
        {
          operation: "validateConnection",
          service: "SmtpConnectionPool",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return false;
    }
  }

  // Override activateConnection to handle SMTP-specific verification timing
  protected async activateConnection(
    wrapper: ConnectionWrapper<Transporter>,
  ): Promise<ConnectionWrapper<Transporter>> {
    const smtpWrapper = wrapper as SmtpConnectionWrapper;

    // Only validate if we need verification based on timing
    const needsVerification = this.needsVerification(smtpWrapper);
    if (needsVerification) {
      const isValid = await this.validateConnection(wrapper.connection);
      if (isValid) {
        smtpWrapper.lastVerified = new Date();
        smtpWrapper.verificationFailures = 0;
      } else {
        smtpWrapper.verificationFailures++;
        if (smtpWrapper.verificationFailures >= this.maxVerificationFailures) {
          await this.destroyConnectionWrapper(wrapper);
          throw new Error("SMTP connection failed verification multiple times");
        }
        throw new Error(
          "SMTP connection verification failed: Connection is not valid",
        );
      }
    }

    wrapper.inUse = true;
    wrapper.lastUsed = new Date();
    wrapper.isHealthy = true;
    this.metrics.activeConnections++;
    this.metrics.idleConnections--;
    this.metrics.totalAcquired++;

    return wrapper;
  }

  async destroyConnection(connection: Transporter): Promise<void> {
    try {
      connection.close();
    } catch (error) {
      await this.logger.warning(
        "Error closing SMTP connection",
        {
          operation: "destroyConnection",
          service: "SmtpConnectionPool",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  // Override acquire to handle SMTP-specific logic
  async acquire(): Promise<SmtpConnectionWrapper> {
    const wrapper = (await super.acquire()) as SmtpConnectionWrapper;

    // Initialize SMTP-specific properties if not present
    if (wrapper.verificationFailures === undefined) {
      wrapper.verificationFailures = 0;
    }

    return wrapper;
  }

  // Override release to reset verification failures on successful use
  async release(wrapper: ConnectionWrapper<Transporter>): Promise<void> {
    const smtpWrapper = wrapper as SmtpConnectionWrapper;

    // Reset verification failures if connection was used successfully
    if (smtpWrapper.isHealthy) {
      smtpWrapper.verificationFailures = 0;
    }

    await super.release(wrapper);
  }

  protected needsVerification(wrapper: SmtpConnectionWrapper): boolean {
    if (!wrapper.lastVerified) {
      return true;
    }

    const timeSinceVerification = Date.now() - wrapper.lastVerified.getTime();
    return timeSinceVerification > this.verificationIntervalMs;
  }

  // Get pool status with SMTP-specific information
  getSmtpMetrics() {
    const baseMetrics = this.getMetrics();
    let totalVerificationFailures = 0;
    let connectionsNeedingVerification = 0;

    for (const wrapper of this.connections.values()) {
      const smtpWrapper = wrapper as SmtpConnectionWrapper;
      totalVerificationFailures += smtpWrapper.verificationFailures || 0;

      if (this.needsVerification(smtpWrapper)) {
        connectionsNeedingVerification++;
      }
    }

    return {
      ...baseMetrics,
      totalVerificationFailures,
      connectionsNeedingVerification,
      verificationIntervalMs: this.verificationIntervalMs,
      maxVerificationFailures: this.maxVerificationFailures,
    };
  }

  // Method to force verification of all idle connections
  async verifyAllConnections(): Promise<{ verified: number; failed: number }> {
    let verified = 0;
    let failed = 0;

    const verificationPromises: Promise<void>[] = [];

    for (const wrapper of this.connections.values()) {
      const smtpWrapper = wrapper as SmtpConnectionWrapper;

      if (!smtpWrapper.inUse) {
        const promise = this.validateConnection(smtpWrapper.connection)
          .then(isValid => {
            if (isValid) {
              smtpWrapper.lastVerified = new Date();
              smtpWrapper.verificationFailures = 0;
              smtpWrapper.isHealthy = true;
              verified++;
            } else {
              smtpWrapper.verificationFailures++;
              smtpWrapper.isHealthy = false;
              failed++;

              // Destroy connections that have failed too many times
              if (
                smtpWrapper.verificationFailures >= this.maxVerificationFailures
              ) {
                // Schedule destruction asynchronously
                this.destroyConnection(smtpWrapper.connection)
                  .catch(async err => {
                    await this.logger.warning(
                      "Error destroying connection",
                      {
                        operation: "periodicVerification",
                        service: "SmtpConnectionPool",
                      },
                      {
                        error: err instanceof Error ? err.message : String(err),
                      },
                    );
                  })
                  .finally(() => this.connections.delete(smtpWrapper.id));
              }
            }
          })
          .catch(() => {
            smtpWrapper.verificationFailures++;
            smtpWrapper.isHealthy = false;
            failed++;
          });

        verificationPromises.push(promise);
      }
    }

    await Promise.allSettled(verificationPromises);
    return { verified, failed };
  }
}
