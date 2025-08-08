import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { EmailService } from "../services/EmailService.js";
import type { SmtpService } from "../services/SmtpService.js";
import type { EmailMessage } from "../types/email.types.js";
import {
  EmailError,
  ErrorCode,
  type ErrorContext,
  ErrorUtils,
  ValidationError,
} from "../types/errors.js";
import {
  createDirectorySchema,
  createDraftSchema,
  deleteEmailSchema,
  getEmailSchema,
  getEmailThreadSchema,
  markEmailSchema,
  moveEmailSchema,
  searchEmailsSchema,
  sendEmailSchema,
  validateInput,
} from "../validation/schemas.js";

export function createEmailTools(
  emailService: EmailService,
  smtpService?: SmtpService,
): Tool[] {
  return [
    {
      name: "search_emails",
      description:
        "Search for emails in mailbox.org account with various filters",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query to match against email subject and body",
          },
          folder: {
            type: "string",
            description: "Email folder to search in (default: INBOX)",
            default: "INBOX",
          },
          since: {
            type: "string",
            format: "date-time",
            description:
              "Only return emails newer than this date (ISO 8601 format)",
          },
          before: {
            type: "string",
            format: "date-time",
            description:
              "Only return emails older than this date (ISO 8601 format)",
          },
          limit: {
            type: "number",
            description: "Maximum number of emails to return (default: 50)",
            default: 50,
            minimum: 1,
            maximum: 200,
          },
          offset: {
            type: "number",
            description: "Number of emails to skip for pagination (default: 0)",
            default: 0,
            minimum: 0,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "get_email",
      description: "Get full content of a specific email by UID",
      inputSchema: {
        type: "object",
        properties: {
          uid: {
            type: "number",
            description: "Unique identifier of the email message",
          },
          folder: {
            type: "string",
            description: "Email folder containing the message (default: INBOX)",
            default: "INBOX",
          },
        },
        required: ["uid"],
        additionalProperties: false,
      },
    },
    {
      name: "get_email_thread",
      description: "Get all emails in a conversation thread by message ID",
      inputSchema: {
        type: "object",
        properties: {
          messageId: {
            type: "string",
            description: "Message ID to find the thread for",
          },
          folder: {
            type: "string",
            description: "Email folder to search in (default: INBOX)",
            default: "INBOX",
          },
        },
        required: ["messageId"],
        additionalProperties: false,
      },
    },
    {
      name: "send_email",
      description: "Compose and send an email via SMTP",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                address: { type: "string", format: "email" },
              },
              required: ["address"],
            },
            description: "Recipients of the email",
          },
          cc: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                address: { type: "string", format: "email" },
              },
              required: ["address"],
            },
            description: "CC recipients (optional)",
          },
          bcc: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                address: { type: "string", format: "email" },
              },
              required: ["address"],
            },
            description: "BCC recipients (optional)",
          },
          subject: {
            type: "string",
            description: "Subject line of the email",
          },
          text: {
            type: "string",
            description: "Plain text content of the email",
          },
          html: {
            type: "string",
            description: "HTML content of the email (optional)",
          },
        },
        required: ["to", "subject"],
        additionalProperties: false,
      },
    },
    {
      name: "create_draft",
      description: "Save an email as a draft",
      inputSchema: {
        type: "object",
        properties: {
          to: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                address: { type: "string", format: "email" },
              },
              required: ["address"],
            },
            description: "Recipients of the email",
          },
          cc: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                address: { type: "string", format: "email" },
              },
              required: ["address"],
            },
            description: "CC recipients (optional)",
          },
          bcc: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                address: { type: "string", format: "email" },
              },
              required: ["address"],
            },
            description: "BCC recipients (optional)",
          },
          subject: {
            type: "string",
            description: "Subject line of the email",
          },
          text: {
            type: "string",
            description: "Plain text content of the email",
          },
          html: {
            type: "string",
            description: "HTML content of the email (optional)",
          },
          folder: {
            type: "string",
            description: "Folder to save the draft in (default: Drafts)",
            default: "Drafts",
          },
        },
        required: ["to", "subject"],
        additionalProperties: false,
      },
    },
    {
      name: "move_email",
      description: "Move an email from one folder to another",
      inputSchema: {
        type: "object",
        properties: {
          uid: {
            type: "number",
            description: "Unique identifier of the email message",
          },
          fromFolder: {
            type: "string",
            description: "Source folder containing the email",
          },
          toFolder: {
            type: "string",
            description: "Destination folder for the email",
          },
        },
        required: ["uid", "fromFolder", "toFolder"],
        additionalProperties: false,
      },
    },
    {
      name: "mark_email",
      description: "Add or remove flags from an email (read, important, etc.)",
      inputSchema: {
        type: "object",
        properties: {
          uid: {
            type: "number",
            description: "Unique identifier of the email message",
          },
          folder: {
            type: "string",
            description: "Folder containing the email (default: INBOX)",
            default: "INBOX",
          },
          flags: {
            type: "array",
            items: { type: "string" },
            description:
              "Flags to add or remove (e.g., \\Seen, \\Flagged, \\Important)",
          },
          action: {
            type: "string",
            enum: ["add", "remove"],
            description: "Whether to add or remove the specified flags",
          },
        },
        required: ["uid", "flags", "action"],
        additionalProperties: false,
      },
    },
    {
      name: "delete_email",
      description: "Delete an email (move to trash or permanently delete)",
      inputSchema: {
        type: "object",
        properties: {
          uid: {
            type: "number",
            description: "Unique identifier of the email message",
          },
          folder: {
            type: "string",
            description: "Folder containing the email (default: INBOX)",
            default: "INBOX",
          },
          permanent: {
            type: "boolean",
            description:
              "Whether to permanently delete (true) or move to trash (false, default)",
            default: false,
          },
        },
        required: ["uid"],
        additionalProperties: false,
      },
    },
    {
      name: "get_folders",
      description: "List all available email folders",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "create_directory",
      description: "Create a new email folder/directory",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the folder to create",
          },
          parentPath: {
            type: "string",
            description: "Parent folder path (optional, defaults to root)",
            default: "",
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
  ];
}

export async function handleEmailTool(
  name: string,
  args: unknown,
  emailService: EmailService,
  smtpService?: SmtpService,
): Promise<{
  content: Array<{ type: "text"; text: string; [key: string]: unknown }>;
  isError?: boolean;
}> {
  try {
    switch (name) {
      case "search_emails": {
        const validatedArgs = validateInput(searchEmailsSchema, args);
        const options = {
          query: validatedArgs.query,
          folder: validatedArgs.folder,
          since: validatedArgs.since
            ? new Date(validatedArgs.since)
            : undefined,
          before: validatedArgs.before
            ? new Date(validatedArgs.before)
            : undefined,
          limit: validatedArgs.limit,
          offset: validatedArgs.offset,
        };

        const emails = await emailService.searchEmails(options);

        return {
          content: [
            {
              type: "text",
              text: `Found ${emails.length} emails:\n\n${emails
                .map(
                  (email) =>
                    `**${email.subject}**
From: ${email.from.map((f) => `${f.name || ""} <${f.address}>`).join(", ")}
To: ${email.to.map((t) => `${t.name || ""} <${t.address}>`).join(", ")}
Date: ${email.date.toISOString()}
UID: ${email.uid}
Folder: ${email.folder}
`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "get_email": {
        const validatedArgs = validateInput(getEmailSchema, args);
        let email: EmailMessage | null;
        try {
          email = await emailService.getEmail(
            validatedArgs.uid,
            validatedArgs.folder,
          );
        } catch (error) {
          // Handle connection errors gracefully
          if (
            error instanceof Error &&
            (error.message.includes("ECONNRESET") ||
              error.message.includes("EPIPE"))
          ) {
            return {
              content: [
                {
                  type: "text",
                  text: `Connection error while fetching email UID ${validatedArgs.uid}. The IMAP server may have closed the connection. Please try again.`,
                },
              ],
              isError: true,
            };
          }
          throw error;
        }

        if (!email) {
          return {
            content: [
              {
                type: "text",
                text: `Email with UID ${validatedArgs.uid} not found in folder ${validatedArgs.folder}`,
              },
            ],
          };
        }

        const attachmentInfo =
          email.attachments && email.attachments.length > 0
            ? `\n\n**Attachments:**\n${email.attachments
                .map(
                  (att) =>
                    `- ${att.filename} (${att.contentType}, ${att.size} bytes)`,
                )
                .join("\n")}`
            : "";

        return {
          content: [
            {
              type: "text",
              text: `**Subject:** ${email.subject}

**From:** ${email.from.map((f) => `${f.name || ""} <${f.address}>`).join(", ")}
**To:** ${email.to.map((t) => `${t.name || ""} <${t.address}>`).join(", ")}
${
  email.cc?.length
    ? `**CC:** ${email.cc.map((c) => `${c.name || ""} <${c.address}>`).join(", ")}\n`
    : ""
}**Date:** ${email.date.toISOString()}
**UID:** ${email.uid}
**Folder:** ${email.folder}

**Content:**
${email.text || email.html || "No content available"}${attachmentInfo}`,
            },
          ],
        };
      }

      case "get_email_thread": {
        const validatedArgs = validateInput(getEmailThreadSchema, args);
        const thread = await emailService.getEmailThread(
          validatedArgs.messageId,
          validatedArgs.folder,
        );

        if (!thread) {
          return {
            content: [
              {
                type: "text",
                text: `No thread found for message ID: ${validatedArgs.messageId}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `**Thread:** ${thread.subject}
**Participants:** ${thread.participants.map((p) => `${p.name || ""} <${p.address}>`).join(", ")}
**Last Activity:** ${thread.lastActivity.toISOString()}
**Messages:** ${thread.messages.length}

**Messages in Thread:**
${thread.messages
  .map(
    (msg) =>
      `---
**Subject:** ${msg.subject}
**From:** ${msg.from.map((f) => `${f.name || ""} <${f.address}>`).join(", ")}
**Date:** ${msg.date.toISOString()}
**Content:** ${(msg.text || msg.html || "No content").substring(0, 200)}...
`,
  )
  .join("\n")}`,
            },
          ],
        };
      }

      case "send_email": {
        if (!smtpService) {
          return {
            content: [
              {
                type: "text",
                text: "SMTP service not available. Email sending is not configured.",
              },
            ],
            isError: true,
          };
        }

        const validatedArgs = validateInput(sendEmailSchema, args);
        const composition = {
          to: validatedArgs.to,
          cc: validatedArgs.cc,
          bcc: validatedArgs.bcc,
          subject: validatedArgs.subject,
          text: validatedArgs.text,
          html: validatedArgs.html,
        };

        const result = await smtpService.sendEmail(composition);

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email sent successfully!\n\n**Subject:** ${validatedArgs.subject}\n**To:** ${validatedArgs.to.map((r: { name?: string; address: string }) => `${r.name || ""} <${r.address}>`).join(", ")}\n**Message ID:** ${result.messageId || "Unknown"}`
                : `❌ Failed to send email: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "create_draft": {
        const validatedArgs = validateInput(createDraftSchema, args);
        const composition = {
          to: validatedArgs.to,
          cc: validatedArgs.cc,
          bcc: validatedArgs.bcc,
          subject: validatedArgs.subject,
          text: validatedArgs.text,
          html: validatedArgs.html,
        };

        const result = await emailService.createDraft(
          composition,
          validatedArgs.folder,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Draft saved successfully!\n\n**Subject:** ${validatedArgs.subject}\n**Folder:** ${validatedArgs.folder}\n**UID:** ${result.uid || "Unknown"}`
                : `❌ Failed to save draft: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "move_email": {
        const validatedArgs = validateInput(moveEmailSchema, args);
        const result = await emailService.moveEmail(
          validatedArgs.uid,
          validatedArgs.fromFolder,
          validatedArgs.toFolder,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email moved successfully!\n\n**UID:** ${validatedArgs.uid}\n**From:** ${validatedArgs.fromFolder}\n**To:** ${validatedArgs.toFolder}`
                : `❌ Failed to move email: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "mark_email": {
        const validatedArgs = validateInput(markEmailSchema, args);
        const result = await emailService.markEmail(
          validatedArgs.uid,
          validatedArgs.folder ?? "INBOX",
          validatedArgs.flags,
          validatedArgs.action,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email flags updated successfully!\n\n**UID:** ${validatedArgs.uid}\n**Folder:** ${validatedArgs.folder}\n**Action:** ${validatedArgs.action}\n**Flags:** ${validatedArgs.flags.join(", ")}`
                : `❌ Failed to update email flags: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "delete_email": {
        const validatedArgs = validateInput(deleteEmailSchema, args);
        const result = await emailService.deleteEmail(
          validatedArgs.uid,
          validatedArgs.folder ?? "INBOX",
          validatedArgs.permanent ?? false,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email deleted successfully!\n\n**UID:** ${validatedArgs.uid}\n**Folder:** ${validatedArgs.folder}\n**Type:** ${validatedArgs.permanent ? "Permanent deletion" : "Moved to trash"}`
                : `❌ Failed to delete email: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "get_folders": {
        const folders = await emailService.getFolders();

        return {
          content: [
            {
              type: "text",
              text: `📁 Available Email Folders (${folders.length}):\n\n${folders
                .map(
                  (folder) =>
                    `**${folder.name}**
Path: ${folder.path}
Flags: ${folder.flags.join(", ") || "None"}
${folder.specialUse ? `Special Use: ${folder.specialUse}\n` : ""}`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "create_directory": {
        const validatedArgs = validateInput(createDirectorySchema, args);
        const result = await emailService.createDirectory(
          validatedArgs.name,
          validatedArgs.parentPath,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Directory created successfully!\n\n**Name:** ${validatedArgs.name}\n**Parent:** ${validatedArgs.parentPath || "Root"}`
                : `❌ Failed to create directory: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      default:
        throw new ValidationError(
          `Unknown email tool: ${name}`,
          "tool_name",
          name,
        );
    }
  } catch (error) {
    const context: ErrorContext = {
      operation: name,
      service: "emailTools",
      details: { args },
    };

    // Handle validation errors specifically
    if (
      error instanceof Error &&
      error.message.startsWith("Validation failed:")
    ) {
      const validationError = new ValidationError(
        error.message.replace("Validation failed: ", ""),
        "input_validation",
        args,
        context,
      );

      return {
        content: [
          {
            type: "text",
            text: `❌ Invalid input for ${name}: ${validationError.getUserMessage()}`,
          },
        ],
        isError: true,
      };
    }

    // Convert to structured error if not already
    const mcpError =
      error instanceof Error
        ? ErrorUtils.toMCPError(error, context)
        : new EmailError(
            String(error),
            ErrorCode.OPERATION_FAILED,
            undefined,
            undefined,
            context,
          );

    return {
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${mcpError.getUserMessage()}${mcpError.isRetryable ? " (This operation can be retried)" : ""}`,
        },
      ],
      isError: true,
    };
  }
}
