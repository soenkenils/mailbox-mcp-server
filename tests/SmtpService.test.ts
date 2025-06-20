import { type Mock, beforeEach, describe, expect, it, vi } from "vitest";
import { SmtpService } from "../src/services/SmtpService.js";
import type { EmailComposition, SmtpConnection } from "../src/types/email.types.js";

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

// Mock nodemailer
vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(),
  },
}));

// Import after mock setup
import nodemailer from "nodemailer";

describe("SmtpService", () => {
  let smtpService: SmtpService;
  let mockConnection: SmtpConnection;
  let mockSendMail: Mock;
  let mockVerify: Mock;
  let mockClose: Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    
    // Setup mock functions
    mockSendMail = vi.fn();
    mockVerify = vi.fn();
    mockClose = vi.fn();
    
    // Setup mock transporter
    const mockTransporter = {
      sendMail: mockSendMail,
      verify: mockVerify,
      close: mockClose,
    };
    
    (nodemailer.createTransport as Mock).mockReturnValue(mockTransporter);
    
    mockConnection = createMockSmtpConnection();
    smtpService = new SmtpService(mockConnection);
    
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
      
      expect(nodemailer.createTransport).toHaveBeenCalledWith({
        host: "smtp.example.com",
        port: 587,
        secure: true,
        auth: {
          user: "test@example.com",
          pass: "password123",
        },
        tls: {
          rejectUnauthorized: false,
        },
      });

      expect(mockSendMail).toHaveBeenCalledWith({
        from: {
          name: "Test",
          address: "test@example.com",
        },
        to: "\"John Doe\" <john@example.com>",
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
          cc: "\"Jane Smith\" <jane@example.com>",
          bcc: "secret@example.com",
        })
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
        })
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
        })
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
          to: "\"John Doe\" <john@example.com>, jane@example.com",
        })
      );
    });

    it("should handle email sending errors", async () => {
      const composition = createMockEmailComposition();
      const error = new Error("SMTP connection failed");
      mockSendMail.mockRejectedValue(error);
      
      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Failed to send email: SMTP connection failed");
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
      const service = new SmtpService(connection);
      const composition = createMockEmailComposition();
      
      await service.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: {
            name: "John Doe",
            address: "john.doe@example.com",
          },
        })
      );
    });

    it("should handle email with underscores and dashes in name extraction", async () => {
      const connection = createMockSmtpConnection({
        user: "first_last-name@example.com",
      });
      const service = new SmtpService(connection);
      const composition = createMockEmailComposition();
      
      await service.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: {
            name: "First Last Name",
            address: "first_last-name@example.com",
          },
        })
      );
    });
  });

  describe("verifyConnection", () => {
    it("should verify connection successfully", async () => {
      const result = await smtpService.verifyConnection();

      expect(result).toBe(true);
      expect(mockVerify).toHaveBeenCalled();
    });

    it("should handle verification failure", async () => {
      mockVerify.mockRejectedValue(new Error("Connection failed"));
      
      const result = await smtpService.verifyConnection();

      expect(result).toBe(false);
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
          to: "\"John Doe\" <john@example.com>, \"Jane Smith\" <jane@example.com>",
        })
      );
    });

    it("should format addresses without names correctly", async () => {
      const composition = createMockEmailComposition({
        to: [
          { address: "john@example.com" },
          { address: "jane@example.com" },
        ],
      });
      
      await smtpService.sendEmail(composition);

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "john@example.com, jane@example.com",
        })
      );
    });
  });

  describe("transporter reuse", () => {
    it("should reuse transporter for multiple emails", async () => {
      const composition1 = createMockEmailComposition({ subject: "Email 1" });
      const composition2 = createMockEmailComposition({ subject: "Email 2" });
      
      await smtpService.sendEmail(composition1);
      await smtpService.sendEmail(composition2);

      // Should only create transporter once
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      expect(mockSendMail).toHaveBeenCalledTimes(2);
    });
  });

  describe("close", () => {
    it("should close transporter connection", async () => {
      // First create a transporter by sending an email
      await smtpService.sendEmail(createMockEmailComposition());
      
      await smtpService.close();

      expect(mockClose).toHaveBeenCalled();
    });

    it("should handle close when no transporter exists", async () => {
      await smtpService.close();

      expect(mockClose).not.toHaveBeenCalled();
    });

    it("should allow creating new transporter after close", async () => {
      // Send email to create transporter
      await smtpService.sendEmail(createMockEmailComposition());
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(1);
      
      // Close connection
      await smtpService.close();
      
      // Send another email - should create new transporter
      await smtpService.sendEmail(createMockEmailComposition());
      expect(nodemailer.createTransport).toHaveBeenCalledTimes(2);
    });
  });

  describe("error scenarios", () => {
    it("should handle transporter creation failure", async () => {
      (nodemailer.createTransport as Mock).mockImplementationOnce(() => {
        throw new Error("Failed to create transporter");
      });
      
      const composition = createMockEmailComposition();
      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toContain("Failed to create transporter");
    });

    it("should handle authentication errors", async () => {
      mockSendMail.mockRejectedValue(new Error("535 Authentication failed"));
      
      const composition = createMockEmailComposition();
      const result = await smtpService.sendEmail(composition);

      expect(result.success).toBe(false);
      expect(result.message).toBe("Failed to send email: 535 Authentication failed");
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
        })
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
        })
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
});