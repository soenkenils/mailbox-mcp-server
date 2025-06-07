#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ListPromptsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
  type ListResourcesRequest,
  type ListPromptsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import {
  createDefaultImapConfig,
  createImapService,
} from "./services/ImapServiceFactory.js";
import {
  createDefaultCalDavConfig,
  createCalDavService,
} from "./services/CalDavServiceFactory.js";
import type { IMAPConfig } from "./types/imap.types.js";
import type { CalDAVConfig } from "./types/caldav.types.js";

// Load configuration from environment variables or use defaults
const imapConfig: IMAPConfig = createDefaultImapConfig({
  host: process.env.IMAP_HOST || "imap.mailbox.org",
  port: Number.parseInt(process.env.IMAP_PORT || "993", 10),
  tls: process.env.IMAP_TLS !== "false",
  user: process.env.IMAP_USER || "",
  password: process.env.IMAP_PASSWORD || "",
  smtpConfig: {
    host: process.env.SMTP_HOST || "smtp.mailbox.org",
    port: Number.parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    user: process.env.SMTP_USER || process.env.IMAP_USER || "",
    password: process.env.SMTP_PASSWORD || process.env.IMAP_PASSWORD || "",
  },
});

// CalDAV configuration
const caldavConfig: CalDAVConfig = createDefaultCalDavConfig({
  serverUrl: process.env.CALDAV_URL || "dav.mailbox.org",
  username: process.env.CALDAV_USER || process.env.IMAP_USER || "",
  password: process.env.CALDAV_PASSWORD || process.env.IMAP_PASSWORD || "",
});

// Initialize services
const imapService = createImapService(imapConfig);
const calDavService = createCalDavService(caldavConfig);

// Initialize the MCP server
const server = new Server(
  {
    name: "mailbox-mcp-server",
    version: "0.1.0",
    description:
      "MCP server for mailbox.org email, calendar integration",
  },
  {
    capabilities: {
      tools: {},
      resources: {
        list: true,
      },
      prompts: {
        list: true,
      },
    },
  },
);

// Register tools available in the MCP server
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  try {
    return {
      tools: [
        {
          name: "search_emails",
          description: "Search for emails in the mailbox",
          inputSchema: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Search query text",
              },
              folder: {
                type: "string",
                description: "Optional folder to search in",
              },
              limit: {
                type: "number",
                description: "Maximum number of results to return",
              },
            },
            required: ["query"],
          },
        },
      ],
    };
  } catch (error) {
    console.error("Error listing tools:", error);
    throw new Error("Failed to list available tools");
  }
});

// Add resources/list handler
server.setRequestHandler(ListResourcesRequestSchema, async (request: ListResourcesRequest) => {
  try {
    return {
      resources: [
        {
          name: "email_folders",
          description: "List of available email folders",
        },
        {
          name: "calendars",
          description: "List of available calendars",
        }
      ],
    };
  } catch (error) {
    console.error("Error listing resources:", error);
    throw new Error("Failed to list available resources");
  }
});

// Add prompts/list handler
server.setRequestHandler(ListPromptsRequestSchema, async (request: ListPromptsRequest) => {
  try {
    return {
      prompts: [
        {
          name: "email_search",
          description: "Search your email inbox",
          template: "Search for emails containing {query}",
        },
        {
          name: "calendar_events",
          description: "View your calendar events",
          template: "Show calendar events for {date}",
        }
      ],
    };
  } catch (error) {
    console.error("Error listing prompts:", error);
    throw new Error("Failed to list available prompts");
  }
});

// Add retry logic for service connections with exponential backoff
async function connectWithRetry(
  service: { connect: () => Promise<void> },
  serviceName: string,
  maxRetries = 5,
  initialDelay = 1000,
): Promise<void> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await service.connect();
      console.log(`${serviceName} service connected successfully`);
      return;
    } catch (error) {
      lastError = error as Error;
      
      // Log the error with more context
      console.warn(
        `${serviceName} connection attempt ${attempt}/${maxRetries} failed:`,
        {
          error: error instanceof Error ? error.message : String(error),
          timestamp: new Date().toISOString(),
          attempt,
          maxRetries,
        }
      );
      
      if (attempt < maxRetries) {
        // Use exponential backoff with jitter
        const backoffDelay = initialDelay * Math.pow(2, attempt - 1);
        const jitter = Math.random() * 1000; // Add up to 1 second of random jitter
        const delay = Math.min(backoffDelay + jitter, 30000); // Cap at 30 seconds
        
        console.log(`Retrying in ${Math.round(delay/1000)} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  
  throw new Error(
    `Failed to connect to ${serviceName} after ${maxRetries} attempts. Last error: ${
      lastError?.message || "Unknown error"
    }. Please check your network connection and service configuration.`,
  );
}

// Start the server with improved error handling
async function main() {
  try {
    // Connect to services with retry logic
    await Promise.all([
      connectWithRetry(imapService, "IMAP"),
      connectWithRetry(calDavService, "CalDAV")
    ]);

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Mailbox MCP server running on stdio");

    let isShuttingDown = false;
    
    // Improved shutdown handler with graceful timeout
    async function shutdown(signal?: string) {
      if (isShuttingDown) {
        console.log("Shutdown already in progress...");
        return;
      }
      
      isShuttingDown = true;
      console.log(`\nInitiating graceful shutdown${signal ? ` (Signal: ${signal})` : ""}...`);
      
      // Set a timeout for graceful shutdown
      const forceShutdownTimeout = setTimeout(() => {
        console.error("Graceful shutdown timed out after 10s, forcing exit");
        process.exit(1);
      }, 10000);
      
      try {
        // Disconnect services in parallel
        await Promise.all([
          imapService.disconnect().catch(err => 
            console.error("Error disconnecting IMAP service:", err)
          ),
          server.close().catch(err => 
            console.error("Error closing MCP server:", err)
          ),
        ]);
        
        console.log("All services disconnected successfully");
        clearTimeout(forceShutdownTimeout);
        process.exit(0);
      } catch (error) {
        console.error("Error during shutdown:", error);
        clearTimeout(forceShutdownTimeout);
        process.exit(1);
      }
    }
    
    // Handle process termination with improved signal handling
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGUSR2"];
    signals.forEach(signal => {
      process.on(signal, () => shutdown(signal));
    });
    
    // Enhanced error handling for uncaught errors
    process.on("uncaughtException", (error) => {
      console.error("FATAL: Uncaught exception:", error);
      shutdown();
    });
    
    process.on("unhandledRejection", (reason, promise) => {
      console.error("FATAL: Unhandled rejection at:", promise, "reason:", reason);
      shutdown();
    });
  } catch (error) {
    console.error("Error starting server:", error);
    process.exit(1);
  }
}

// Helper function for consistent error responses
function createErrorResponse(error: unknown, context: string) {
  const errorMessage = error instanceof Error ? error.message : String(error);
  console.error(`${context}:`, error);
  
  return {
    content: [
      {
        type: "text",
        text: `${context}: ${errorMessage}`,
      },
    ],
    isError: true,
  };
}

// Implement tool handlers with improved error handling
server.setRequestHandler(
  CallToolRequestSchema,
  async (request: CallToolRequest) => {
    // Validate request parameters
    if (!request.params?.name) {
      return createErrorResponse("Tool name is required", "Invalid request");
    }
    
    try {
      switch (request.params.name) {
        // Email tools
        case "search_emails": {
          const {
            query,
            folder = "INBOX",
            limit = 10,
            offset = 0,
            ...filters
          } = request.params.arguments as {
            query?: string;
            folder?: string;
            limit?: number;
            offset?: number;
            unread?: boolean;
            flagged?: boolean;
            hasAttachment?: boolean;
            since?: string;
            before?: string;
          };

          try {
            await imapService.connect();

            const searchOptions = {
              folder,
              text: query,
              unread: filters.unread,
              flagged: filters.flagged,
              hasAttachment: filters.hasAttachment,
              since: filters.since ? new Date(filters.since) : undefined,
              before: filters.before ? new Date(filters.before) : undefined,
            };

            const fetchOptions = {
              headersOnly: true, // Only fetch headers for search results
            };

            // Calculate effective limit with buffer for more accurate pagination
            const effectiveLimit = Math.min(limit + 10, 100); // Add buffer but cap at 100
            
            const emails = await imapService.searchEmails(
              {
                ...searchOptions,
                // Pass limit and offset to IMAP service for more efficient fetching
                limit: effectiveLimit,
                offset: Math.max(0, offset - 10) // Fetch a few extra emails before the requested offset
              },
              {
                ...fetchOptions,
                // For search results, we only need minimal data
                headersOnly: true,
                fetchAttachments: false,
              }
            );

            // Apply pagination after search
            const paginatedEmails = emails
              .slice(offset, offset + limit)
              .filter(Boolean); // Remove any null values that might occur

            const results = paginatedEmails.map((email) => ({
              id: email.uid.toString(),
              subject: email.headers.subject || "(No subject)",
              from: email.headers.from?.[0] ? {
                name: email.headers.from[0].name,
                address: email.headers.from[0].address,
              } : { name: "", address: "unknown" },
              date: email.headers.date.toISOString(),
              snippet: email.text ? email.text.substring(0, 200).trim() : "",
              hasAttachments: email.hasAttachments,
              isRead: email.flags?.includes("\\Seen") || false,
              isFlagged: email.flags?.includes("\\Flagged") || false,
              threadId: email.threadId, // Include thread ID if available
              total: emails.length, // Include total count for pagination
            }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(results, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error searching emails: ${error instanceof Error ? error.message : "Unknown error"}`,
                },
              ],
              isError: true,
            };
          }
        }

        case "get_email": {
          const {
            id,
            folder = "INBOX",
            markAsRead = false,
          } = request.params.arguments as {
            id: string;
            folder?: string;
            markAsRead?: boolean;
          };

          try {
            await imapService.connect();

            const email = await imapService.getEmail(
              Number.parseInt(id, 10),
              folder,
            );

            if (!email) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Email with ID ${id} not found in folder ${folder}`,
                  },
                ],
                isError: true,
              };
            }

            const result = {
              id: email.uid.toString(),
              subject: email.headers.subject || "(No subject)",
              from: email.headers.from?.[0]?.address || "unknown",
              to:
                email.headers.to?.map((addr) => addr.address).join(", ") || "",
              cc:
                email.headers.cc?.map((addr) => addr.address).join(", ") || "",
              date: email.headers.date.toISOString(),
              html: email.html || "",
              text: email.text || "",
              attachments: email.attachments.map((att) => ({
                filename: att.filename || "unknown",
                contentType: att.contentType,
                size: att.size,
              })),
              isRead: email.flags?.includes("\\Seen") || false,
              isFlagged: email.flags?.includes("\\Flagged") || false,
            };

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error getting email: ${error instanceof Error ? error.message : "Unknown error"}`,
                },
              ],
              isError: true,
            };
          }
        }

        case "get_email_thread": {
          const { messageId, folder = "INBOX" } = request.params.arguments as {
            messageId: string;
            folder?: string;
          };

          try {
            const thread = await imapService.getEmailThread(messageId, folder);

            if (!thread) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Thread not found for message ID: ${messageId}`,
                  },
                ],
                isError: true,
              };
            }

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      threadId: thread.threadId,
                      subject: thread.subject,
                      participants: thread.participants,
                      messageCount: thread.messageCount,
                      hasUnread: thread.hasUnread,
                      lastActivity: thread.lastActivity.toISOString(),
                      messages: thread.messages.map((msg) => ({
                        id: msg.uid.toString(),
                        subject: msg.headers.subject,
                        from: msg.headers.from?.[0]?.address || "unknown",
                        date: msg.headers.date.toISOString(),
                        snippet: msg.text ? msg.text.substring(0, 200) : "",
                        isRead: msg.flags.includes("\\Seen"),
                      })),
                    },
                    null,
                    2,
                  ),
                },
              ],
            };
          } catch (error) {
            console.error("Error getting email thread:", error);
            return {
              content: [
                {
                  type: "text",
                  text: `Error getting email thread: ${error instanceof Error ? error.message : "Unknown error"}`,
                },
              ],
              isError: true,
            };
          }
        }

        // Calendar tools
        case "get_calendar_events": {
          const {
            start,
            end,
            calendarUrls,
            limit = 50,
            offset = 0,
          } = request.params.arguments as {
            start: string;
            end: string;
            calendarUrls?: string[];
            limit?: number;
            offset?: number;
          };

          try {
            await calDavService.connect();

            const events = await calDavService.searchEvents({
              start: new Date(start),
              end: new Date(end),
              calendarUrls,
              limit,
              offset,
            });

            const results = events.map((event) => ({
              uid: event.uid,
              summary: event.summary,
              description: event.description || "",
              location: event.location || "",
              start: event.start.toISOString(),
              end: event.end.toISOString(),
              allDay: event.allDay,
              attendees:
                event.attendees?.map((attendee) => ({
                  name: attendee.name || "",
                  email: attendee.email,
                  role: attendee.role || "",
                  status: attendee.status || "",
                })) || [],
              organizer: event.organizer
                ? {
                    name: event.organizer.name || "",
                    email: event.organizer.email,
                  }
                : undefined,
              status: event.status,
              calendarName: event.calendarName,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(results, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error getting calendar events: ${error instanceof Error ? error.message : "Unknown error"}`,
                },
              ],
              isError: true,
            };
          }
        }

        case "search_calendar": {
          const {
            query,
            start,
            end,
            calendarUrls,
            categories,
            limit = 20,
            offset = 0,
          } = request.params.arguments as {
            query: string;
            start: string;
            end: string;
            calendarUrls?: string[];
            categories?: string[];
            limit?: number;
            offset?: number;
          };

          try {
            await calDavService.connect();

            const events = await calDavService.searchEvents({
              query,
              start: new Date(start),
              end: new Date(end),
              calendarUrls,
              categories,
              limit,
              offset,
            });

            const results = events.map((event) => ({
              uid: event.uid,
              summary: event.summary,
              description: event.description || "",
              location: event.location || "",
              start: event.start.toISOString(),
              end: event.end.toISOString(),
              allDay: event.allDay,
              status: event.status,
              calendarName: event.calendarName,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(results, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error searching calendar events: ${error instanceof Error ? error.message : "Unknown error"}`,
                },
              ],
              isError: true,
            };
          }
        }

        case "get_free_busy": {
          const { start, end, calendarUrls } = request.params.arguments as {
            start: string;
            end: string;
            calendarUrls?: string[];
          };

          try {
            await calDavService.connect();

            const freeBusyPeriods = await calDavService.getFreeBusy({
              start: new Date(start),
              end: new Date(end),
              calendarUrls,
            });

            const results = freeBusyPeriods.map((period) => ({
              start: period.start.toISOString(),
              end: period.end.toISOString(),
              type: period.type,
            }));

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(results, null, 2),
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error getting free/busy information: ${error instanceof Error ? error.message : "Unknown error"}`,
                },
              ],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [
              {
                type: "text",
                text: `Unknown tool: ${request.params.name}`,
              },
            ],
            isError: true,
          };
      }
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error processing request: ${error instanceof Error ? error.message : "Unknown error"}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Handle process termination
const shutdown = async () => {
  console.log("Shutting down MCP server...");
  try {
    await imapService.disconnect();
    // Disconnect from other services as needed
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error("Error during shutdown:", error);
    process.exit(1);
  }
};

// Only run main if not in test environment
if (process.env.NODE_ENV !== "test") {
  main();
}
