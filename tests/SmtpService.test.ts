import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionPoolConfig } from "../src/services/ConnectionPool.js";
import type { SmtpPoolConfig } from "../src/services/SmtpConnectionPool.js";
import { SmtpService } from "../src/services/SmtpService.js";
import type {
  EmailComposition,
  SmtpConnection,
} from "../src/types/email.types.js";

// Mock factories for cleaner test setup
const createMockSmtpConnection = (
  overrides: Partial<SmtpConnection> = {},
): SmtpConnection => ({
  host: "smtp.example.com",
  port: 587,
  secure: true,
  user: "test@example.com",
  password: "password123",
  ...overrides,
});

const createMockEmailComposition = (
  overrides: Partial<EmailComposition> = {},
): EmailComposition => ({
  to: [{ name: "John Doe", address: "john@example.com" }],
  subject: "Test Subject",
  text: "Test email content",
  ...overrides,
});

// Mock the SmtpConnectionPool
vi.mock("../src/services/SmtpConnectionPool.js", () => {
  return {
    SmtpConnectionPool: vi.fn(),
  };
});

// Import the mocked class
import { SmtpConnectionPool } from "../src/services/SmtpConnectionPool.js";

describe("SmtpService", () => {
  let smtpService: SmtpService;
  let mockConnection: SmtpConnection;
  let mockPool: any;
  let mockWrapper: any;
  let mockSendMail: Mock;
  let mockVerify: Mock;
  let mockClose: Mock;

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup mock functions
    mockSendMail = vi.fn();
    mockVerify = vi.fn();
    mockClose = vi.fn();

    // Setup mock wrapper
    mockWrapper = {
      connection: {
        sendMail: mockSendMail,
        verify: mockVerify,
        close: mockClose,
      },
      id: "mock-wrapper-id",
      inUse: false,
      isHealthy: true,
      createdAt: new Date(),
      lastUsed: new Date(),
      verificationFailures: 0,
      lastVerified: new Date(),
    };

    mockConnection = createMockSmtpConnection();

    // Create mock pool config
    const mockPoolConfig: SmtpPoolConfig = {
      minConnections: 1,
      maxConnections: 3,
      acquireTimeoutMs: 30000,
      idleTimeoutMs: 180000,
      maxRetries: 3,
      retryDelayMs: 1000,
      healthCheckIntervalMs: 120000,
      connectionConfig: mockConnection,
      verificationIntervalMs: 1000,
      maxVerificationFailures: 2,
    };

    // Set up the mock pool implementation
    (SmtpConnectionPool as any).mockImplementation(() => ({
      acquire: vi.fn().mockResolvedValue(mockWrapper),
      release: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      getSmtpMetrics: vi.fn().mockReturnValue({
        totalVerificationFailures: 0,
        connectionsNeedingVerification: 0,
        verificationIntervalMs: 1000,
        maxVerificationFailures: 2,
        totalConnections: 1,
        activeConnections: 0,
        idleConnections: 1,
      }),
      getMetrics: vi.fn().mockReturnValue({
        totalConnections: 1,
        activeConnections: 0,
        idleConnections: 1,
        totalErrors: 0,
        totalCreated: 1,
        totalDestroyed: 0,
        totalAcquired: 1,
        totalReleased: 1,
      }),
      verifyAllConnections: vi.fn().mockResolvedValue({
        verified: 1,
        failed: 0,
      }),
      connectionConfig: mockConnection,
    }));

    smtpService = new SmtpService(mockConnection, mockPoolConfig);

    // Get the mock pool instance
    mockPool = (smtpService as any).pool;

    // Setup default successful responses
    mockSendMail.mockResolvedValue({
      messageId: "test-message-id-123",
      response: "250 Message accepted",
    });
    mockVerify.mockResolvedValue(true);
  });

  describe("constructor", () => {
    it("should create SmtpService with connection config", () => {
      expect(smtpService).toBeInstanceOf(SmtpService);
    });
  });

  describe("sendEmail", () => {
    it("should send email successfully", async () => {
      const composition = createMockEmailComposition();

      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(true);
      expect(result.message).toBe("Email sent successfully");
      expect(result.messageId).toBe("test-message-id-123");

      // Verify pool operations
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(mockPool.release).toHaveBeenCalledWith(mockWrapper);

      expect(mockSendMail).toHaveBeenCalledWith({
        from: {
          name: "Test",
          address: "test@example.com",
        },
        to: '"John Doe" <john@example.com>',
        cc: undefined,
        bcc: undefined,
        subject: "Test Subject",
        text: "Test email content",
        html: undefined,
        attachments: undefined,
      });
    });

    it("should send email with CC and BCC recipients", async () => {
      const composition = createMockEmailComposition({
        cc: [{ name: "Jane Smith", address: "jane@example.com" }],
        bcc: [{ address: "secret@example.com" }],
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: '"Jane Smith" <jane@example.com>',
          bcc: "secret@example.com",
        }),
      );
    });

    it("should send email with HTML content", async () => {
      const composition = createMockEmailComposition({
        html: "<h1>Test HTML Email</h1>",
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<h1>Test HTML Email</h1>",
        }),
      );
    });

    it("should send email with attachments", async () => {
      const composition = createMockEmailComposition({
        attachments: [
          {
            filename: "test.txt",
            content: "Test file content",
            contentType: "text/plain",
          },
        ],
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          attachments: [
            {
              filename: "test.txt",
              content: "Test file content",
              contentType: "text/plain",
            },
          ],
        }),
      );
    });

    it("should handle multiple recipients", async () => {
      const composition = createMockEmailComposition({
        to: [
          { name: "John Doe", address: "john@example.com" },
          { address: "jane@example.com" },
        ],
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '"John Doe" <john@example.com>, jane@example.com',
        }),
      );
    });

    it("should handle email sending errors", async () => {
      const composition = createMockEmailComposition();
      const error = new Error("SMTP connection failed");
      mockSendMail.mockRejectedValue(error);

      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        "Failed to send email: SMTP connection failed",
      );
      expect(result.messageId).toBeUndefined();
    });

    it("should handle non-Error exceptions", async () => {
      const composition = createMockEmailComposition();
      mockSendMail.mockRejectedValue("String error");

      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Failed to send email: String error");
    });

    it("should extract name from email address correctly", async () => {
      const connection = createMockSmtpConnection({
        user: "john.doe@example.com",
      });
      const poolConfig: SmtpPoolConfig = {
        minConnections: 1,
        maxConnections: 3,
        acquireTimeoutMs: 30000,
        idleTimeoutMs: 180000,
        maxRetries: 3,
        retryDelayMs: 1000,
        healthCheckIntervalMs: 120000,
        connectionConfig: connection,
        verificationIntervalMs: 1000,
        maxVerificationFailures: 2,
      };
      const service = new SmtpService(connection, poolConfig);
      const composition = createMockEmailComposition();

      // Setup the mock pool for this service instance
      const servicePool = (service as any).pool;
      servicePool.acquire.mockResolvedValue(mockWrapper);
      servicePool.release.mockResolvedValue(undefined);
      servicePool.connectionConfig = connection;

      await service.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: {
            name: "John Doe",
            address: "john.doe@example.com",
          },
        }),
      );
    });

    it("should handle email with underscores and dashes in name extraction", async () => {
      const connection = createMockSmtpConnection({
        user: "first_last-name@example.com",
      });
      const poolConfig: SmtpPoolConfig = {
        minConnections: 1,
        maxConnections: 3,
        acquireTimeoutMs: 30000,
        idleTimeoutMs: 180000,
        maxRetries: 3,
        retryDelayMs: 1000,
        healthCheckIntervalMs: 120000,
        connectionConfig: connection,
        verificationIntervalMs: 1000,
        maxVerificationFailures: 2,
      };
      const service = new SmtpService(connection, poolConfig);
      const composition = createMockEmailComposition();

      // Setup the mock pool for this service instance
      const servicePool = (service as any).pool;
      servicePool.acquire.mockResolvedValue(mockWrapper);
      servicePool.release.mockResolvedValue(undefined);
      servicePool.connectionConfig = connection;

      await service.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: {
            name: "First Last Name",
            address: "first_last-name@example.com",
          },
        }),
      );
    });
  });

  describe("verifyConnection", () => {
    it("should verify connection successfully", async () => {
      const result = await smtpService.verifyConnection();

      expect(result).toBe(true);
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(mockPool.release).toHaveBeenCalledWith(mockWrapper);
      expect(mockVerify).toHaveBeenCalled();
    });

    it("should handle verification failure", async () => {
      mockVerify.mockRejectedValue(new Error("Connection failed"));

      const result = await smtpService.verifyConnection();

      expect(result).toBe(false);
      expect(mockPool.acquire).toHaveBeenCalled();
      expect(mockPool.release).toHaveBeenCalledWith(mockWrapper);
    });
  });

  describe("formatAddresses", () => {
    it("should format addresses with names correctly", async () => {
      const composition = createMockEmailComposition({
        to: [
          { name: "John Doe", address: "john@example.com" },
          { name: "Jane Smith", address: "jane@example.com" },
        ],
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: '"John Doe" <john@example.com>, "Jane Smith" <jane@example.com>',
        }),
      );
    });

    it("should format addresses without names correctly", async () => {
      const composition = createMockEmailComposition({
        to: [{ address: "john@example.com" }, { address: "jane@example.com" }],
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "john@example.com, jane@example.com",
        }),
      );
    });
  });

  describe("connection pooling", () => {
    it("should use connection pool for multiple emails", async () => {
      const composition1 = createMockEmailComposition({ subject: "Email 1" });
      const composition2 = createMockEmailComposition({ subject: "Email 2" });

      await smtpService.sendEmail(composition1);
      await smtpService.sendEmail(composition2);

      // Should acquire and release connections for each email
      expect(mockPool.acquire).toHaveBeenCalledTimes(2);
      expect(mockPool.release).toHaveBeenCalledTimes(2);
      expect(mockSendMail).toHaveBeenCalledTimes(2);
    });
  });

  describe("close", () => {
    it("should close connection pool", async () => {
      await smtpService.close();

      expect(mockPool.destroy).toHaveBeenCalled();
    });
  });

  describe("error scenarios", () => {
    it("should handle connection pool acquisition failure", async () => {
      mockPool.acquire.mockRejectedValue(
        new Error("Failed to acquire connection"),
      );

      const composition = createMockEmailComposition();
      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to acquire connection");
    });

    it("should handle authentication errors", async () => {
      mockSendMail.mockRejectedValue(new Error("535 Authentication failed"));

      const composition = createMockEmailComposition();
      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        "Failed to send email: 535 Authentication failed",
      );
    });

    it("should handle network timeouts", async () => {
      mockSendMail.mockRejectedValue(new Error("Connection timeout"));

      const composition = createMockEmailComposition();
      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Failed to send email: Connection timeout");
    });
  });

  describe("edge cases", () => {
    it("should handle empty email compositions", async () => {
      const composition: EmailComposition = {
        to: [],
        subject: "",
        text: "",
      };

      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "",
          subject: "",
          text: "",
        }),
      );
    });

    it("should handle very long email content", async () => {
      const longContent = "a".repeat(10000);
      const composition = createMockEmailComposition({
        text: longContent,
      });

      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(true);
      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          text: longContent,
        }),
      );
    });

    it("should handle special characters in email content", async () => {
      const composition = createMockEmailComposition({
        subject: "Test with émojis 🎉 and spécial chäractërs",
        text: "Content with unicode: 你好世界",
      });

      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(true);
    });
  });

  describe("pool management methods", () => {
    it("should return pool metrics", () => {
      const metrics = smtpService.getPoolMetrics();

      expect(mockPool.getSmtpMetrics).toHaveBeenCalled();
      expect(metrics).toBeDefined();
    });

    it("should validate pool health", async () => {
      const isHealthy = await smtpService.validatePoolHealth();

      expect(mockPool.getMetrics).toHaveBeenCalled();
      expect(isHealthy).toBe(true);
    });

    it("should verify all pool connections", async () => {
      const result = await smtpService.verifyAllPoolConnections();

      expect(mockPool.verifyAllConnections).toHaveBeenCalled();
      expect(result).toEqual({ verified: 1, failed: 0 });
    });
  });
});
