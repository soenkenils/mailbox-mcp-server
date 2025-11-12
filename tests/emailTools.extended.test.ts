import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailService } from "../src/services/EmailService.js";
import type { SmtpService } from "../src/services/SmtpService.js";
import { handleEmailTool } from "../src/tools/emailTools.js";
import type { EmailMessage } from "../src/types/email.types.js";

vi.mock("../src/services/EmailService.js");
vi.mock("../src/services/SmtpService.js");

describe("Email Tools - Extended Coverage", () => {
  let mockEmailService: Partial<EmailService>;
  let mockSmtpService: Partial<SmtpService>;

  const mockEmail: EmailMessage = {
    id: "msg-1",
    uid: 123,
    subject: "Test Subject",
    from: [{ name: "Test Sender", address: "sender@example.com" }],
    to: [{ name: "Test Recipient", address: "recipient@example.com" }],
    date: new Date("2024-01-01T10:00:00Z"),
    text: "Test email content",
    flags: [],
    folder: "INBOX",
  };

  beforeEach(() => {
    mockEmailService = {
      searchEmails: vi.fn(),
      getEmail: vi.fn(),
      getEmailThread: vi.fn(),
      getFolders: vi.fn(),
      createDirectory: vi.fn(),
      createDraft: vi.fn(),
      moveEmail: vi.fn(),
      markEmail: vi.fn(),
      deleteEmail: vi.fn(),
    };

    mockSmtpService = {
      sendEmail: vi.fn(),
    };
  });

  describe("send_email", () => {
    it("should send email successfully", async () => {
      vi.mocked(mockSmtpService.sendEmail!).mockResolvedValue({
        success: true,
        message: "Email sent",
        messageId: "msg-123",
      });

      const result = await handleEmailTool(
        "send_email",
        {
          to: [{ address: "recipient@example.com", name: "Recipient" }],
          subject: "Test Email",
          text: "This is a test",
        },
        mockEmailService as EmailService,
        mockSmtpService as SmtpService,
      );

      expect(mockSmtpService.sendEmail).toHaveBeenCalledWith({
        to: [{ address: "recipient@example.com", name: "Recipient" }],
        subject: "Test Email",
        text: "This is a test",
        cc: undefined,
        bcc: undefined,
        html: undefined,
      });
      expect(result.content[0].text).toContain("✅ Email sent successfully!");
      expect(result.content[0].text).toContain("Test Email");
      expect(result.isError).toBe(false);
    });

    it("should send email with CC and BCC", async () => {
      vi.mocked(mockSmtpService.sendEmail!).mockResolvedValue({
        success: true,
        message: "Email sent",
      });

      await handleEmailTool(
        "send_email",
        {
          to: [{ address: "recipient@example.com" }],
          cc: [{ address: "cc@example.com" }],
          bcc: [{ address: "bcc@example.com" }],
          subject: "Test",
          text: "Body",
        },
        mockEmailService as EmailService,
        mockSmtpService as SmtpService,
      );

      expect(mockSmtpService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          cc: [{ address: "cc@example.com" }],
          bcc: [{ address: "bcc@example.com" }],
        }),
      );
    });

    it("should send email with HTML body", async () => {
      vi.mocked(mockSmtpService.sendEmail!).mockResolvedValue({
        success: true,
        message: "Email sent",
      });

      await handleEmailTool(
        "send_email",
        {
          to: [{ address: "recipient@example.com" }],
          subject: "HTML Test",
          html: "<p>HTML content</p>",
        },
        mockEmailService as EmailService,
        mockSmtpService as SmtpService,
      );

      expect(mockSmtpService.sendEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          html: "<p>HTML content</p>",
        }),
      );
    });

    it("should handle send failure", async () => {
      vi.mocked(mockSmtpService.sendEmail!).mockResolvedValue({
        success: false,
        message: "SMTP authentication failed",
      });

      const result = await handleEmailTool(
        "send_email",
        {
          to: [{ address: "recipient@example.com" }],
          subject: "Test",
          text: "Body",
        },
        mockEmailService as EmailService,
        mockSmtpService as SmtpService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("❌ Failed to send email");
    });

    it("should handle missing SMTP service", async () => {
      const result = await handleEmailTool(
        "send_email",
        {
          to: [{ address: "recipient@example.com" }],
          subject: "Test",
          text: "Body",
        },
        mockEmailService as EmailService,
        undefined, // No SMTP service
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("SMTP service not available");
    });
  });

  describe("create_draft", () => {
    it("should create draft successfully", async () => {
      vi.mocked(mockEmailService.createDraft!).mockResolvedValue({
        success: true,
        message: "Draft saved",
        uid: 456,
      });

      const result = await handleEmailTool(
        "create_draft",
        {
          to: [{ address: "recipient@example.com" }],
          subject: "Draft Subject",
          text: "Draft body",
        },
        mockEmailService as EmailService,
      );

      expect(mockEmailService.createDraft).toHaveBeenCalled();
      expect(result.content[0].text).toContain("✅ Draft saved successfully!");
      expect(result.isError).toBe(false);
    });

    it("should create draft in custom folder", async () => {
      vi.mocked(mockEmailService.createDraft!).mockResolvedValue({
        success: true,
        message: "Draft saved",
      });

      await handleEmailTool(
        "create_draft",
        {
          to: [{ address: "recipient@example.com" }],
          subject: "Draft",
          text: "Body",
          folder: "Custom Drafts",
        },
        mockEmailService as EmailService,
      );

      const calls = vi.mocked(mockEmailService.createDraft!).mock.calls;
      expect(calls[0][1]).toBe("Custom Drafts");
    });

    it("should handle draft creation failure", async () => {
      vi.mocked(mockEmailService.createDraft!).mockResolvedValue({
        success: false,
        message: "Drafts folder not found",
      });

      const result = await handleEmailTool(
        "create_draft",
        {
          to: [{ address: "recipient@example.com" }],
          subject: "Draft",
          text: "Body",
        },
        mockEmailService as EmailService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("❌ Failed to save draft");
    });
  });

  describe("move_email", () => {
    it("should move email successfully", async () => {
      vi.mocked(mockEmailService.moveEmail!).mockResolvedValue({
        success: true,
        message: "Email moved",
      });

      const result = await handleEmailTool(
        "move_email",
        {
          uid: 123,
          fromFolder: "INBOX",
          toFolder: "Archive",
        },
        mockEmailService as EmailService,
      );

      expect(mockEmailService.moveEmail).toHaveBeenCalledWith(
        123,
        "INBOX",
        "Archive",
      );
      expect(result.content[0].text).toContain("✅ Email moved successfully!");
      expect(result.isError).toBe(false);
    });

    it("should handle move failure", async () => {
      vi.mocked(mockEmailService.moveEmail!).mockResolvedValue({
        success: false,
        message: "Destination folder not found",
      });

      const result = await handleEmailTool(
        "move_email",
        {
          uid: 123,
          fromFolder: "INBOX",
          toFolder: "NonExistent",
        },
        mockEmailService as EmailService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("❌ Failed to move email");
    });
  });

  describe("mark_email", () => {
    it("should mark email as read", async () => {
      vi.mocked(mockEmailService.markEmail!).mockResolvedValue({
        success: true,
        message: "Email marked",
      });

      const result = await handleEmailTool(
        "mark_email",
        {
          uid: 123,
          folder: "INBOX",
          flags: ["\\Seen"],
          action: "add",
        },
        mockEmailService as EmailService,
      );

      expect(mockEmailService.markEmail).toHaveBeenCalledWith(
        123,
        "INBOX",
        ["\\Seen"],
        "add",
      );
      expect(result.content[0].text).toContain("✅ Email flags updated successfully!");
      expect(result.isError).toBe(false);
    });

    it("should mark email as unread", async () => {
      vi.mocked(mockEmailService.markEmail!).mockResolvedValue({
        success: true,
        message: "Email marked",
      });

      await handleEmailTool(
        "mark_email",
        {
          uid: 123,
          folder: "INBOX",
          flags: ["\\Seen"],
          action: "remove",
        },
        mockEmailService as EmailService,
      );

      expect(mockEmailService.markEmail).toHaveBeenCalledWith(
        123,
        "INBOX",
        ["\\Seen"],
        "remove",
      );
    });

    it("should mark email with multiple flags", async () => {
      vi.mocked(mockEmailService.markEmail!).mockResolvedValue({
        success: true,
        message: "Email marked",
      });

      await handleEmailTool(
        "mark_email",
        {
          uid: 123,
          folder: "INBOX",
          flags: ["\\Seen", "\\Flagged"],
          action: "add",
        },
        mockEmailService as EmailService,
      );

      expect(mockEmailService.markEmail).toHaveBeenCalledWith(
        123,
        "INBOX",
        ["\\Seen", "\\Flagged"],
        "add",
      );
    });

    it("should handle mark failure", async () => {
      vi.mocked(mockEmailService.markEmail!).mockResolvedValue({
        success: false,
        message: "Email not found",
      });

      const result = await handleEmailTool(
        "mark_email",
        {
          uid: 999,
          folder: "INBOX",
          flags: ["\\Seen"],
          action: "add",
        },
        mockEmailService as EmailService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("❌ Failed to update email flags");
    });
  });

  describe("delete_email", () => {
    it("should delete email (soft delete)", async () => {
      vi.mocked(mockEmailService.deleteEmail!).mockResolvedValue({
        success: true,
        message: "Email moved to trash",
      });

      const result = await handleEmailTool(
        "delete_email",
        {
          uid: 123,
          folder: "INBOX",
        },
        mockEmailService as EmailService,
      );

      expect(mockEmailService.deleteEmail).toHaveBeenCalledWith(
        123,
        "INBOX",
        false,
      );
      expect(result.content[0].text).toContain("✅ Email deleted successfully!");
      expect(result.isError).toBe(false);
    });

    it("should delete email permanently", async () => {
      vi.mocked(mockEmailService.deleteEmail!).mockResolvedValue({
        success: true,
        message: "Email permanently deleted",
      });

      await handleEmailTool(
        "delete_email",
        {
          uid: 123,
          folder: "INBOX",
          permanent: true,
        },
        mockEmailService as EmailService,
      );

      expect(mockEmailService.deleteEmail).toHaveBeenCalledWith(
        123,
        "INBOX",
        true,
      );
    });

    it("should handle delete failure", async () => {
      vi.mocked(mockEmailService.deleteEmail!).mockResolvedValue({
        success: false,
        message: "Email not found",
      });

      const result = await handleEmailTool(
        "delete_email",
        {
          uid: 999,
          folder: "INBOX",
        },
        mockEmailService as EmailService,
      );

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("❌ Failed to delete email");
    });
  });

  describe("get_folders", () => {
    it("should list folders successfully", async () => {
      vi.mocked(mockEmailService.getFolders!).mockResolvedValue([
        {
          name: "INBOX",
          path: "INBOX",
          delimiter: "/",
          flags: [],
          specialUse: undefined,
        },
        {
          name: "Sent",
          path: "Sent",
          delimiter: "/",
          flags: [],
          specialUse: "\\Sent",
        },
        {
          name: "Drafts",
          path: "Drafts",
          delimiter: "/",
          flags: [],
          specialUse: "\\Drafts",
        },
      ]);

      const result = await handleEmailTool(
        "get_folders",
        {},
        mockEmailService as EmailService,
      );

      expect(mockEmailService.getFolders).toHaveBeenCalled();
      expect(result.content[0].text).toContain("📁 Available Email Folders");
      expect(result.content[0].text).toContain("INBOX");
      expect(result.content[0].text).toContain("Sent");
      expect(result.content[0].text).toContain("Drafts");
      expect(result.isError).toBeUndefined();
    });

    it("should handle empty folder list", async () => {
      vi.mocked(mockEmailService.getFolders!).mockResolvedValue([]);

      const result = await handleEmailTool(
        "get_folders",
        {},
        mockEmailService as EmailService,
      );

      expect(result.content[0].text).toContain("(0)");
    });
  });
});
