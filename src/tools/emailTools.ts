import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { EmailService } from "../services/EmailService.js";

export function createEmailTools(emailService: EmailService): Tool[] {
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
  ];
}

export async function handleEmailTool(
  name: string,
  args: any,
  emailService: EmailService,
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
