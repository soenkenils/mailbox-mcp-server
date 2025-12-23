import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SmtpConnectionPool,
  type SmtpConnectionWrapper,
  type SmtpPoolConfig,
} from "../src/services/SmtpConnectionPool.js";
import type { SmtpConnection } from "../src/types/email.types.js";

interface SendMailOptions {
  to?: string | string[];
  from?: string;
  subject?: string;
  text?: string;
  html?: string;
  [key: string]: unknown;
}

// Type for accessing pool internals in tests
interface TestableSmtpConnectionPool extends SmtpConnectionPool {
  connections: Map<string, SmtpConnectionWrapper>;
}

// Mock Transporter
class MockTransporter {
  public isValid = true;
  private shouldFailVerify = false;
  private shouldFailSend = false;

  setShouldFailVerify(fail: boolean): void {
    this.shouldFailVerify = fail;
  }

  setShouldFailSend(fail: boolean): void {
    this.shouldFailSend = fail;
  }

  async verify(): Promise<boolean> {
    if (this.shouldFailVerify) {
      throw new Error("SMTP verification failed");
    }
    return this.isValid;
  }

  async sendMail(options: SendMailOptions): Promise<{ messageId: string }> {
    if (this.shouldFailSend) {
      throw new Error("Failed to send email");
    }
    if (!this.isValid) {
      throw new Error("Connection is invalid");
    }
    return { messageId: "test-message-id" };
  }

  close(): void {
    this.isValid = false;
  }
}

// Mock nodemailer
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(function () {
      return new MockTransporter();
    }),
  },
}));

describe("SmtpConnectionPool", () => {
  let pool: SmtpConnectionPool;
  let config: SmtpPoolConfig;
  let connection: SmtpConnection;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Ensure the nodemailer mock is properly set up
    const nodemailer = await import("nodemailer");
    (nodemailer.default.createTransport as Mock).mockImplementation(
      () => new MockTransporter(),
    );

    connection = {
      host: "smtp.example.com",
      port: 587,
      secure: true,
      user: "test@example.com",
      password: "password123",
    };

    config = {
      minConnections: 1,
      maxConnections: 3,
      acquireTimeoutMs: 100,
      idleTimeoutMs: 1000,
      maxRetries: 2,
      retryDelayMs: 10,
      healthCheckIntervalMs: 50,
      connectionConfig: connection,
      verificationIntervalMs: 1000,
      maxVerificationFailures: 2,
    };

    pool = new SmtpConnectionPool(config);
  });

  afterEach(async () => {
    await pool.destroy();
  });

  describe("connection creation", () => {
    it("should create SMTP connections with correct configuration", async () => {
      const wrapper = await pool.acquire();

      expect(wrapper.connection).toBeInstanceOf(MockTransporter);
      expect(wrapper.verificationFailures).toBe(0);

      await pool.release(wrapper);
    });

    it("should verify connection immediately after creation", async () => {
      const mockTransporter = new MockTransporter();
      const verifySpy = vi.spyOn(mockTransporter, "verify");

      const nodemailer = await import("nodemailer");
      (nodemailer.default.createTransport as Mock).mockReturnValue(
        mockTransporter,
      );

      const wrapper = await pool.acquire();

      expect(verifySpy).toHaveBeenCalled();
      await pool.release(wrapper);
    });

    it("should handle connection creation failures", async () => {
      const mockTransporter = new MockTransporter();
      mockTransporter.setShouldFailVerify(true);

      const nodemailer = await import("nodemailer");
      (nodemailer.default.createTransport as Mock).mockReturnValue(
        mockTransporter,
      );

      await expect(pool.acquire()).rejects.toThrow(
        "Failed to create connection",
      );
    });
  });

  describe("connection validation", () => {
    it("should validate connections using verify", async () => {
      const wrapper = await pool.acquire();

      const isValid = await pool.validateConnection(wrapper.connection);
      expect(isValid).toBe(true);

      await pool.release(wrapper);
    });

    it("should detect invalid connections", async () => {
      const wrapper = await pool.acquire();

      const mockTransporter = wrapper.connection as MockTransporter;
      mockTransporter.setShouldFailVerify(true);

      const isValid = await pool.validateConnection(wrapper.connection);
      expect(isValid).toBe(false);

      await pool.release(wrapper);
    });

    it("should handle verification errors gracefully", async () => {
      const wrapper = await pool.acquire();

      const mockTransporter = wrapper.connection as MockTransporter;
      mockTransporter.verify = vi
        .fn()
        .mockRejectedValue(new Error("Network error"));

      const isValid = await pool.validateConnection(wrapper.connection);
      expect(isValid).toBe(false);

      await pool.release(wrapper);
    });
  });

  describe("periodic verification", () => {
    it("should verify connections periodically", async () => {
      const wrapper = await pool.acquire();

      // Set last verified to old timestamp
      wrapper.lastVerified = new Date(Date.now() - 2000); // 2 seconds ago

      await pool.release(wrapper);

      // Acquire again - should trigger verification
      const wrapper2 = await pool.acquire();

      expect(wrapper2.lastVerified).toBeDefined();
      expect(wrapper2.lastVerified?.getTime()).toBeGreaterThan(
        Date.now() - 1000,
      );

      await pool.release(wrapper2);
    });

    it("should not verify recently verified connections", async () => {
      const wrapper = await pool.acquire();

      // Set last verified to recent timestamp
      wrapper.lastVerified = new Date();

      const verifySpy = vi.spyOn(wrapper.connection, "verify");

      await pool.release(wrapper);

      // Acquire again - should not trigger verification
      const wrapper2 = await pool.acquire();

      expect(verifySpy).not.toHaveBeenCalled();

      await pool.release(wrapper2);
    });

    it("should track verification failures", async () => {
      const wrapper = await pool.acquire();
      wrapper.lastVerified = new Date(Date.now() - 2000); // Force verification

      const mockTransporter = wrapper.connection as MockTransporter;
      mockTransporter.setShouldFailVerify(true);

      await pool.release(wrapper);

      // Should fail verification and increment failure count
      await expect(pool.acquire()).rejects.toThrow(
        "SMTP connection verification failed",
      );

      // Check that failure was tracked
      const connections = (pool as TestableSmtpConnectionPool).connections;
      const connection = connections.get(wrapper.id);
      expect(connection?.verificationFailures).toBeGreaterThan(0);
    });

    it("should destroy connections after max verification failures", async () => {
      // Get the connection and set it up to fail verification
      const wrapper = await pool.acquire();
      const connectionId = wrapper.id;

      await pool.release(wrapper);

      // Access the connection directly from the pool's internal map
      const connections = (pool as TestableSmtpConnectionPool).connections;
      const storedWrapper = connections.get(connectionId);

      // Set up the failure scenario
      storedWrapper.verificationFailures =
        (config.maxVerificationFailures || 2) - 1; // Set to 1 (max is 2)
      storedWrapper.lastVerified = new Date(Date.now() - 2000); // Force verification needed

      const mockTransporter = storedWrapper.connection as MockTransporter;
      mockTransporter.setShouldFailVerify(true);

      // Should fail and destroy the connection
      await expect(pool.acquire()).rejects.toThrow(
        "SMTP connection failed verification multiple times",
      );
    });
  });

  describe("SMTP-specific metrics", () => {
    it("should provide SMTP metrics with verification info", async () => {
      const wrapper = await pool.acquire();
      wrapper.verificationFailures = 1;
      wrapper.lastVerified = new Date(Date.now() - 2000); // Needs verification
      wrapper.isHealthy = false; // Mark as unhealthy so release won't reset failures

      await pool.release(wrapper);

      const metrics = pool.getSmtpMetrics();

      expect(metrics.totalVerificationFailures).toBe(1);
      expect(metrics.connectionsNeedingVerification).toBe(1);
      expect(metrics.verificationIntervalMs).toBe(
        config.verificationIntervalMs,
      );
      expect(metrics.maxVerificationFailures).toBe(
        config.maxVerificationFailures,
      );
    });

    it("should track verification metrics correctly", async () => {
      const wrapper1 = await pool.acquire();
      wrapper1.verificationFailures = 2;
      wrapper1.isHealthy = false; // Prevent reset on release
      await pool.release(wrapper1);

      const wrapper2 = await pool.acquire();
      wrapper2.verificationFailures = 1;
      wrapper2.isHealthy = false; // Prevent reset on release
      await pool.release(wrapper2);

      const metrics = pool.getSmtpMetrics();
      expect(metrics.totalVerificationFailures).toBe(3);
    });
  });

  describe("verification management", () => {
    it("should verify all idle connections", async () => {
      // Create multiple connections
      const wrapper1 = await pool.acquire();
      await pool.release(wrapper1);

      const wrapper2 = await pool.acquire();
      await pool.release(wrapper2);

      const result = await pool.verifyAllConnections();

      expect(result.verified).toBeGreaterThan(0);
      expect(result.failed).toBe(0);
    });

    it("should handle verification failures in verifyAllConnections", async () => {
      const wrapper = await pool.acquire();

      const mockTransporter = wrapper.connection as MockTransporter;
      mockTransporter.setShouldFailVerify(true);

      await pool.release(wrapper);

      const result = await pool.verifyAllConnections();

      expect(result.verified).toBe(0);
      expect(result.failed).toBeGreaterThan(0);
    });

    it("should not verify active connections", async () => {
      const wrapper = await pool.acquire();
      // Don't release - keep it active

      const result = await pool.verifyAllConnections();

      // Should be 0 since the connection is active
      expect(result.verified + result.failed).toBe(0);

      await pool.release(wrapper);
    });
  });

  describe("connection lifecycle", () => {
    it("should properly destroy connections", async () => {
      const wrapper = await pool.acquire();

      const closeSpy = vi.spyOn(wrapper.connection, "close");

      await pool.destroyConnection(wrapper.connection);

      expect(closeSpy).toHaveBeenCalled();
      expect(wrapper.connection.isValid).toBe(false);

      await pool.release(wrapper);
    });

    it("should handle close errors gracefully", async () => {
      const wrapper = await pool.acquire();

      const mockTransporter = wrapper.connection as MockTransporter;
      mockTransporter.close = vi.fn(() => {
        throw new Error("Close failed");
      });

      // Should not throw
      await expect(
        pool.destroyConnection(wrapper.connection),
      ).resolves.not.toThrow();

      await pool.release(wrapper);
    });
  });

  describe("connection reuse with verification", () => {
    it("should reset verification failures on successful use", async () => {
      const wrapper = await pool.acquire();
      wrapper.verificationFailures = 1;

      // Simulate successful use
      wrapper.isHealthy = true;

      await pool.release(wrapper);

      expect(wrapper.verificationFailures).toBe(0);
    });

    it("should not reset failures for unhealthy connections", async () => {
      const wrapper = await pool.acquire();
      wrapper.verificationFailures = 1;
      wrapper.isHealthy = false;

      await pool.release(wrapper);

      expect(wrapper.verificationFailures).toBe(1);
    });
  });

  describe("concurrent verification", () => {
    it("should handle concurrent verification requests", async () => {
      // Create multiple connections
      const wrappers = await Promise.all([
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
      ]);

      // Release all
      for (const wrapper of wrappers) {
        await pool.release(wrapper);
      }

      // Verify all concurrently
      const promises = [
        pool.verifyAllConnections(),
        pool.verifyAllConnections(),
        pool.verifyAllConnections(),
      ];

      const results = await Promise.all(promises);

      // All should complete successfully
      expect(results).toHaveLength(3);
      for (const result of results) {
        expect(typeof result.verified).toBe("number");
        expect(typeof result.failed).toBe("number");
      }
    });
  });

  describe("error recovery scenarios", () => {
    it("should recover from temporary verification failures", async () => {
      const wrapper = await pool.acquire();
      wrapper.lastVerified = new Date(Date.now() - 2000);

      const mockTransporter = wrapper.connection as MockTransporter;

      // First verification fails
      mockTransporter.setShouldFailVerify(true);
      await pool.release(wrapper);

      try {
        await pool.acquire();
      } catch {
        // Expected to fail
      }

      // Fix the verification
      mockTransporter.setShouldFailVerify(false);

      // Should be able to acquire new connection
      const newWrapper = await pool.acquire();
      expect(newWrapper).toBeDefined();

      await pool.release(newWrapper);
    });
  });

  describe("configuration access", () => {
    it("should expose connection configuration", () => {
      const connectionConfig = pool.connectionConfig;

      expect(connectionConfig).toEqual(connection);
      expect(connectionConfig.host).toBe("smtp.example.com");
      expect(connectionConfig.user).toBe("test@example.com");
    });
  });
});
