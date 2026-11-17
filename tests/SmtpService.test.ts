import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { ConnectionPoolConfig } from "../src/services/ConnectionPool.js";
import type {
  SmtpConnectionWrapper,
  SmtpPoolConfig,
} from "../src/services/SmtpConnectionPool.js";
import { SmtpService } from "../src/services/SmtpService.js";
import type {
  EmailComposition,
  SmtpConnection,
} from "../src/types/email.types.js";

// Type for accessing service internals in tests
interface TestableSmtpService extends SmtpService {
  pool: {
    acquire: Mock;
    release: Mock;
    destroy: Mock;
    getSmtpMetrics: Mock;
    getMetrics: Mock;
  };
}

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
  let mockPool: {
    acquire: Mock;
    release: Mock;
    destroy: Mock;
    getSmtpMetrics: Mock;
    getMetrics: Mock;
  };
  let mockWrapper: SmtpConnectionWrapper;
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
    (SmtpConnectionPool as Mock).mockImplementation(function () {
      return {
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
      };
    });

    smtpService = new SmtpService(mockConnection, mockPoolConfig);

    // Get the mock pool instance
    mockPool = (smtpService as TestableSmtpService).pool;

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
        to: [{ name: "John Doe", address: "john@example.com" }],
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
          cc: [{ name: "Jane Smith", address: "jane@example.com" }],
          bcc: [{ name: "", address: "secret@example.com" }],
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
          to: [
            { name: "John Doe", address: "john@example.com" },
            { name: "", address: "jane@example.com" },
          ],
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

    // The logger forwards to stderr and to the MCP client's log stream, so a
    // failed send must log its shape only, never the mail itself.
    it("should log only the shape of a failed send", async () => {
      const logError = vi.spyOn(
        (smtpService as unknown as { logger: { error: Mock } }).logger,
        "error",
      );
      mockSendMail.mockRejectedValue(
        Object.assign(
          new Error(
            "Can't send mail - all recipients were rejected: 550 5.1.1 <secret-recipient@example.com>: Recipient address rejected",
          ),
          { code: "EENVELOPE", responseCode: 550 },
        ),
      );

      await smtpService.sendEmail(
        createMockEmailComposition({
          to: [
            { name: "Secret Name", address: "secret-recipient@example.com" },
          ],
          cc: [{ address: "secret-cc@example.com" }],
          bcc: [{ address: "secret-bcc@example.com" }],
          subject: "Confidential subject",
          text: "Confidential body",
          html: "<p>Confidential html</p>",
          attachments: [
            { filename: "secret.pdf", content: "Confidential attachment" },
          ],
        }),
      );

      expect(logError).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(logError.mock.calls);
      expect(logged).not.toMatch(/secret|confidential/i);
      expect(logError.mock.calls[0][2]).toEqual({
        recipients: 3,
        subjectLength: "Confidential subject".length,
        hasText: true,
        hasHtml: true,
        attachments: 1,
        code: "EENVELOPE",
        responseCode: 550,
        error:
          "Can't send mail - all recipients were rejected: 550 5.1.1 <[address]>: Recipient address rejected",
      });
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
      const servicePool = (service as TestableSmtpService).pool;
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
      const servicePool = (service as TestableSmtpService).pool;
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

  describe("network errors", () => {
    // Shaped like nodemailer's errors: `code` is nodemailer's error type,
    // the system errno (if any) is moved to `originalCode`
    const nodemailerError = (
      message: string,
      code: string,
      originalCode?: string,
      extra: Record<string, unknown> = {},
    ) =>
      Object.assign(new Error(message), {
        code,
        ...(originalCode ? { originalCode } : {}),
        command: "CONN",
        ...extra,
      });

    it.each([
      ["ESOCKET", "ECONNREFUSED", "connect ECONNREFUSED 192.0.2.1:465"],
      ["ESOCKET", "ECONNRESET", "read ECONNRESET"],
      ["ESOCKET", "ENETUNREACH", "connect ENETUNREACH 2001:db8::1:465"],
      ["ESOCKET", "EHOSTUNREACH", "connect EHOSTUNREACH 192.0.2.1:465"],
      ["ETIMEDOUT", undefined, "Connection timeout"],
      ["ECONNECTION", undefined, "Connection closed unexpectedly"],
      ["EDNS", "ENOTFOUND", "getaddrinfo ENOTFOUND smtp.example.com"],
    ])("should mark the connection unhealthy when sendMail fails with %s (%s)", async (code, originalCode, message) => {
      mockSendMail.mockRejectedValue(
        nodemailerError(message, code, originalCode),
      );

      const result = await smtpService.sendEmail(createMockEmailComposition());

      expect(result.success).toBe(false);
      expect(mockWrapper.isHealthy).toBe(false);
      expect(mockPool.release).toHaveBeenCalledWith(mockWrapper);
    });

    it("should recognise a raw system errno outside nodemailer's wrapping", async () => {
      mockSendMail.mockRejectedValue(
        Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
      );

      await smtpService.sendEmail(createMockEmailComposition());

      expect(mockWrapper.isHealthy).toBe(false);
    });

    it("should mark the connection unhealthy when verify fails with a network error", async () => {
      mockVerify.mockRejectedValue(
        nodemailerError(
          "connect ENETUNREACH 192.0.2.1:465",
          "ESOCKET",
          "ENETUNREACH",
        ),
      );

      const result = await smtpService.verifyConnection();

      expect(result).toBe(false);
      expect(mockWrapper.isHealthy).toBe(false);
    });

    it.each([
      [
        "EAUTH",
        nodemailerError(
          "Invalid login: 535 Authentication failed",
          "EAUTH",
          undefined,
          { command: "AUTH PLAIN", responseCode: 535 },
        ),
      ],
      [
        "EENVELOPE",
        nodemailerError("No recipients defined", "EENVELOPE", undefined, {
          command: "API",
        }),
      ],
      [
        "EMESSAGE",
        nodemailerError("Message failed: 554 rejected", "EMESSAGE", undefined, {
          command: "DATA",
          responseCode: 554,
        }),
      ],
    ])("should keep the connection healthy for %s", async (_code, error) => {
      mockSendMail.mockRejectedValue(error);

      await smtpService.sendEmail(createMockEmailComposition());

      expect(mockWrapper.isHealthy).toBe(true);
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

  describe("recipients", () => {
    // Display names crafted to read as further recipients if the name were
    // ever parsed as part of an address list
    const CRAFTED_NAMES = [
      'x" <evil@evil.com>, "y',
      "Evil, Inc. <evil@evil.com>",
      'Back\\slash \\" <evil@evil.com>',
      "Line\r\nBcc: evil@evil.com",
      "Jörg Müller <evil@evil.com>, 日本",
    ];

    it("should pass to, cc and bcc recipients to nodemailer as objects", async () => {
      const composition = createMockEmailComposition({
        to: [
          { name: "John Doe", address: "john@example.com" },
          { name: "Jane Smith", address: "jane@example.com" },
        ],
        cc: [{ name: "Carl Copy", address: "carl@example.com" }],
        bcc: [{ name: "Bea Blind", address: "bea@example.com" }],
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [
            { name: "John Doe", address: "john@example.com" },
            { name: "Jane Smith", address: "jane@example.com" },
          ],
          cc: [{ name: "Carl Copy", address: "carl@example.com" }],
          bcc: [{ name: "Bea Blind", address: "bea@example.com" }],
        }),
      );
    });

    it("should keep the address out of the display name when no name is given", async () => {
      const composition = createMockEmailComposition({
        to: [{ address: "john@example.com" }, { address: "jane@example.com" }],
      });

      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: [
            { name: "", address: "john@example.com" },
            { name: "", address: "jane@example.com" },
          ],
        }),
      );
    });

    // Real nodemailer, since what counts is the SMTP envelope it derives: the
    // mocked sendMail above cannot show who the mail would reach.
    it.each(
      CRAFTED_NAMES,
    )("should not add envelope recipients for the name %j", async name => {
      const transporter = nodemailer.createTransport({ jsonTransport: true });
      const sendMail = vi.spyOn(transporter, "sendMail");
      mockWrapper.connection = transporter;

      const result = await smtpService.sendEmail(
        createMockEmailComposition({
          to: [{ name, address: "v@victim.com" }],
          cc: [{ name, address: "c@victim.com" }],
          bcc: [{ name, address: "b@victim.com" }],
        }),
      );

      expect(result.success).toBe(true);
      const info = await sendMail.mock.results[0].value;
      expect(info.envelope).toEqual({
        from: "test@example.com",
        to: ["v@victim.com", "c@victim.com", "b@victim.com"],
      });
    });

    it.each(
      CRAFTED_NAMES,
    )("should keep %j as one display name in the sent message", async name => {
      const transporter = nodemailer.createTransport({
        streamTransport: true,
        buffer: true,
        newline: "unix",
      });
      const sendMail = vi.spyOn(transporter, "sendMail");
      mockWrapper.connection = transporter;

      await smtpService.sendEmail(
        createMockEmailComposition({
          to: [{ name, address: "v@victim.com" }],
          cc: [{ name, address: "c@victim.com" }],
        }),
      );

      const info = await sendMail.mock.results[0].value;
      const raw = info.message.toString();
      const parsed = await simpleParser(info.message);
      expect(parsed.to).toMatchObject({
        value: [{ name, address: "v@victim.com" }],
      });
      expect(parsed.cc).toMatchObject({
        value: [{ name, address: "c@victim.com" }],
      });
      // A CR/LF in the name is RFC 2047-encoded, never a new header line
      expect(raw).not.toMatch(/^Bcc:/im);
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
          to: [],
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
