import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailService } from "../src/services/EmailService.js";
import { createEmailTools, handleEmailTool } from "../src/tools/emailTools.js";
import type { EmailMessage } from "../src/types/email.types.js";

vi.mock("../src/services/EmailService.js");

describe("Email Tools", () => {
  let mockEmailService: EmailService;

  beforeEach(() => {
    mockEmailService = {
      searchEmails: vi.fn(),
      getEmail: vi.fn(),
      getEmailThread: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
    } as any;
  });

  describe("createEmailTools", () => {
    it("should create all email tools", () => {
      const tools = createEmailTools(mockEmailService);

      expect(tools).toHaveLength(10);
      expect(tools.map((t) => t.name)).toEqual([
        "search_emails",
        "get_email",
        "get_email_thread",
        "send_email",
        "create_draft",
        "move_email",
        "mark_email",
        "delete_email",
        "get_folders",
        "create_directory",
      ]);
    });

    it("should have proper schema for search_emails tool", () => {
      const tools = createEmailTools(mockEmailService);
      const searchTool = tools.find((t) => t.name === "search_emails");

      expect(searchTool?.inputSchema.properties).toHaveProperty("query");
      expect(searchTool?.inputSchema.properties).toHaveProperty("folder");
      expect(searchTool?.inputSchema.properties).toHaveProperty("limit");
      expect(searchTool?.inputSchema.properties).toHaveProperty("since");
      expect(searchTool?.inputSchema.properties).toHaveProperty("before");
    });

    it("should have proper schema for get_email tool", () => {
      const tools = createEmailTools(mockEmailService);
      const getTool = tools.find((t) => t.name === "get_email");

      expect(getTool?.inputSchema.required).toContain("uid");
      expect(getTool?.inputSchema.properties).toHaveProperty("uid");
      expect(getTool?.inputSchema.properties).toHaveProperty("folder");
    });
  });

  describe("handleEmailTool", () => {
    const mockEmail: EmailMessage = {
      id: "test@example.com",
      uid: 123,
      subject: "Test Subject",
      from: [{ name: "Test User", address: "test@example.com" }],
      to: [{ name: "Recipient", address: "recipient@example.com" }],
      date: new Date("2024-01-01T10:00:00Z"),
      text: "Test email content",
      flags: [],
      folder: "INBOX",
    };

    describe("search_emails", () => {
      it("should handle search_emails tool", async () => {
        vi.mocked(mockEmailService.searchEmails).mockResolvedValue([mockEmail]);

        const result = await handleEmailTool(
          "search_emails",
          {
            query: "test",
            folder: "INBOX",
            limit: 10,
          },
          mockEmailService,
        );

        expect(mockEmailService.searchEmails).toHaveBeenCalledWith({
          query: "test",
          folder: "INBOX",
          limit: 10,
          offset: 0,
          since: undefined,
          before: undefined,
        });

        expect(result.content[0].text).toContain("Test Subject");
        expect(result.content[0].text).toContain("test@example.com");
      });

      it("should handle date parameters", async () => {
        vi.mocked(mockEmailService.searchEmails).mockResolvedValue([]);

        await handleEmailTool(
          "search_emails",
          {
            since: "2024-01-01T00:00",
            before: "2024-01-31T23:59",
          },
          mockEmailService,
        );

        expect(mockEmailService.searchEmails).toHaveBeenCalledWith({
          query: undefined,
          folder: "INBOX",
          limit: 50,
          offset: 0,
          since: new Date("2024-01-01T00:00"),
          before: new Date("2024-01-31T23:59"),
        });
      });
    });

    describe("get_email", () => {
      it("should handle get_email tool", async () => {
        vi.mocked(mockEmailService.getEmail).mockResolvedValue(mockEmail);

        const result = await handleEmailTool(
          "get_email",
          {
            uid: 123,
            folder: "INBOX",
          },
          mockEmailService,
        );

        expect(mockEmailService.getEmail).toHaveBeenCalledWith(123, "INBOX");
        expect(result.content[0].text).toContain("Test Subject");
        expect(result.content[0].text).toContain("Test email content");
      });

      it("should handle email not found", async () => {
        vi.mocked(mockEmailService.getEmail).mockResolvedValue(null);

        const result = await handleEmailTool(
          "get_email",
          {
            uid: 999,
          },
          mockEmailService,
        );

        expect(result.content[0].text).toContain(
          "Email with UID 999 not found",
        );
      });
    });

    describe("get_email_thread", () => {
      it("should handle get_email_thread tool", async () => {
        const mockThread = {
          threadId: "thread-123",
          messages: [mockEmail],
          subject: "Test Subject",
          participants: mockEmail.from.concat(mockEmail.to),
          lastActivity: mockEmail.date,
        };

        vi.mocked(mockEmailService.getEmailThread).mockResolvedValue(
          mockThread,
        );

        const result = await handleEmailTool(
          "get_email_thread",
          {
            messageId: "test@example.com",
          },
          mockEmailService,
        );

        expect(mockEmailService.getEmailThread).toHaveBeenCalledWith(
          "test@example.com",
          "INBOX",
        );
        expect(result.content[0].text).toContain("Test Subject");
        expect(result.content[0].text).toContain("**Messages:** 1");
      });
    });

    describe("create_directory", () => {
      beforeEach(() => {
        mockEmailService.createDirectory = vi.fn();
      });

      it("should handle create_directory tool", async () => {
        vi.mocked(mockEmailService.createDirectory).mockResolvedValue({
          success: true,
          message: "Directory created successfully",
        });

        const result = await handleEmailTool(
          "create_directory",
          {
            name: "MyNewFolder",
            parentPath: "INBOX",
          },
          mockEmailService,
        );

        expect(mockEmailService.createDirectory).toHaveBeenCalledWith(
          "MyNewFolder",
          "INBOX",
        );
        expect(result.content[0].text).toContain(
          "✅ Directory created successfully!",
        );
        expect(result.content[0].text).toContain("MyNewFolder");
        expect(result.isError).toBe(false);
      });

      it("should handle create_directory with default parent", async () => {
        vi.mocked(mockEmailService.createDirectory).mockResolvedValue({
          success: true,
          message: "Directory created successfully",
        });

        const result = await handleEmailTool(
          "create_directory",
          {
            name: "MyNewFolder",
          },
          mockEmailService,
        );

        expect(mockEmailService.createDirectory).toHaveBeenCalledWith(
          "MyNewFolder",
          "",
        );
      });

      it("should handle create_directory failure", async () => {
        vi.mocked(mockEmailService.createDirectory).mockResolvedValue({
          success: false,
          message: "Folder already exists",
        });

        const result = await handleEmailTool(
          "create_directory",
          {
            name: "ExistingFolder",
          },
          mockEmailService,
        );

        expect(result.content[0].text).toContain(
          "❌ Failed to create directory",
        );
        expect(result.content[0].text).toContain("Folder already exists");
        expect(result.isError).toBe(true);
      });
    });

    describe("Error Handling", () => {
      it("should handle service errors", async () => {
        vi.mocked(mockEmailService.searchEmails).mockRejectedValue(
          new Error("IMAP connection failed"),
        );

        const result = await handleEmailTool(
          "search_emails",
          {},
          mockEmailService,
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          "Unable to connect to the server",
        );
      });

      it("should handle unknown tool", async () => {
        const result = await handleEmailTool(
          "unknown_tool",
          {},
          mockEmailService,
        );

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Unknown email tool");
      });
    });
  });
});
