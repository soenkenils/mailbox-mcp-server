import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { EmailService } from "../services/EmailService.js";
import type { SmtpService } from "../services/SmtpService.js";

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
  args: any,
  emailService: EmailService,
  smtpService?: SmtpService,
): Promise<any> {
  try {
    switch (name) {
      case "search_emails": {
        const options = {
          query: args.query,
          folder: args.folder || "INBOX",
          since: args.since ? new Date(args.since) : undefined,
          before: args.before ? new Date(args.before) : undefined,
          limit: args.limit || 50,
          offset: args.offset || 0,
        };

        const emails = await emailService.searchEmails(options);

        return {
          content: [
            {
              type: "text",
              text: `Found ${emails.length} emails:\n\n${emails
                .map(
                  (email) =>
                    `**${email.subject}**\n` +
                    `From: ${email.from.map((f) => `${f.name || ""} <${f.address}>`).join(", ")}\n` +
                    `To: ${email.to.map((t) => `${t.name || ""} <${t.address}>`).join(", ")}\n` +
                    `Date: ${email.date.toISOString()}\n` +
                    `UID: ${email.uid}\n` +
                    `Folder: ${email.folder}\n`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "get_email": {
        let email: any;
        try {
          email = await emailService.getEmail(args.uid, args.folder || "INBOX");
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
                  text: `Connection error while fetching email UID ${args.uid}. The IMAP server may have closed the connection. Please try again.`,
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
                text: `Email with UID ${args.uid} not found in folder ${args.folder || "INBOX"}`,
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
              text:
                `**Subject:** ${email.subject}\n\n` +
                `**From:** ${email.from.map((f) => `${f.name || ""} <${f.address}>`).join(", ")}\n` +
                `**To:** ${email.to.map((t) => `${t.name || ""} <${t.address}>`).join(", ")}\n` +
                (email.cc?.length
                  ? `**CC:** ${email.cc.map((c) => `${c.name || ""} <${c.address}>`).join(", ")}\n`
                  : "") +
                `**Date:** ${email.date.toISOString()}\n` +
                `**UID:** ${email.uid}\n` +
                `**Folder:** ${email.folder}\n\n` +
                `**Content:**\n${email.text || email.html || "No content available"}` +
                attachmentInfo,
            },
          ],
        };
      }

      case "get_email_thread": {
        const thread = await emailService.getEmailThread(
          args.messageId,
          args.folder || "INBOX",
        );

        if (!thread) {
          return {
            content: [
              {
                type: "text",
                text: `No thread found for message ID: ${args.messageId}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text:
                `**Thread:** ${thread.subject}\n` +
                `**Participants:** ${thread.participants.map((p) => `${p.name || ""} <${p.address}>`).join(", ")}\n` +
                `**Last Activity:** ${thread.lastActivity.toISOString()}\n` +
                `**Messages:** ${thread.messages.length}\n\n` +
                `**Messages in Thread:**\n${thread.messages
                  .map(
                    (msg) =>
                      `---\n` +
                      `**Subject:** ${msg.subject}\n` +
                      `**From:** ${msg.from.map((f) => `${f.name || ""} <${f.address}>`).join(", ")}\n` +
                      `**Date:** ${msg.date.toISOString()}\n` +
                      `**Content:** ${(msg.text || msg.html || "No content").substring(0, 200)}...\n`,
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

        const composition = {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
        };

        const result = await smtpService.sendEmail(composition);

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email sent successfully!\n\n**Subject:** ${args.subject}\n**To:** ${args.to.map((r: any) => `${r.name || ""} <${r.address}>`).join(", ")}\n**Message ID:** ${result.messageId || "Unknown"}`
                : `❌ Failed to send email: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "create_draft": {
        const composition = {
          to: args.to,
          cc: args.cc,
          bcc: args.bcc,
          subject: args.subject,
          text: args.text,
          html: args.html,
        };

        const result = await emailService.createDraft(composition, args.folder);

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Draft saved successfully!\n\n**Subject:** ${args.subject}\n**Folder:** ${args.folder || "Drafts"}\n**UID:** ${result.uid || "Unknown"}`
                : `❌ Failed to save draft: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "move_email": {
        const result = await emailService.moveEmail(
          args.uid,
          args.fromFolder,
          args.toFolder,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email moved successfully!\n\n**UID:** ${args.uid}\n**From:** ${args.fromFolder}\n**To:** ${args.toFolder}`
                : `❌ Failed to move email: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "mark_email": {
        const result = await emailService.markEmail(
          args.uid,
          args.folder || "INBOX",
          args.flags,
          args.action,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email flags updated successfully!\n\n**UID:** ${args.uid}\n**Folder:** ${args.folder || "INBOX"}\n**Action:** ${args.action}\n**Flags:** ${args.flags.join(", ")}`
                : `❌ Failed to update email flags: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      case "delete_email": {
        const result = await emailService.deleteEmail(
          args.uid,
          args.folder || "INBOX",
          args.permanent,
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Email deleted successfully!\n\n**UID:** ${args.uid}\n**Folder:** ${args.folder || "INBOX"}\n**Type:** ${args.permanent ? "Permanent deletion" : "Moved to trash"}`
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
                    `**${folder.name}**\n` +
                    `Path: ${folder.path}\n` +
                    `Flags: ${folder.flags.join(", ") || "None"}\n` +
                    (folder.specialUse
                      ? `Special Use: ${folder.specialUse}\n`
                      : ""),
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "create_directory": {
        const result = await emailService.createDirectory(
          args.name,
          args.parentPath || "",
        );

        return {
          content: [
            {
              type: "text",
              text: result.success
                ? `✅ Directory created successfully!\n\n**Name:** ${args.name}\n**Parent:** ${args.parentPath || "Root"}`
                : `❌ Failed to create directory: ${result.message}`,
            },
          ],
          isError: !result.success,
        };
      }

      default:
        throw new Error(`Unknown email tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
