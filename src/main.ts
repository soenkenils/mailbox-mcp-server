import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { type ServerConfig, loadConfig } from "./config/config.js";
import { CalendarService } from "./services/CalendarService.js";
import { EmailService } from "./services/EmailService.js";
import { MemoryCache } from "./services/LocalCache.js";
import { SmtpService } from "./services/SmtpService.js";
import {
  createCalendarTools,
  handleCalendarTool,
} from "./tools/calendarTools.js";
import { createEmailTools, handleEmailTool } from "./tools/emailTools.js";

class MailboxMcpServer {
  private server: Server;
  private emailService!: EmailService;
  private smtpService!: SmtpService;
  private calendarService!: CalendarService;
  private cache!: MemoryCache;
  private config!: ServerConfig;

  constructor() {
    this.server = new Server(
      {
        name: "mailbox-mcp-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupErrorHandling();
    this.loadConfiguration();
    this.initializeServices();
    this.setupToolHandlers();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on("SIGINT", async () => {
      console.error("\nShutting down Mailbox MCP Server...");
      await this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.error("\nShutting down Mailbox MCP Server...");
      await this.cleanup();
      process.exit(0);
    });
  }

  private loadConfiguration(): void {
    try {
      this.config = loadConfig();
      if (this.config.debug) {
        console.error("Configuration loaded successfully");
      }
    } catch (error) {
      console.error("Failed to load configuration:", error);
      process.exit(1);
    }
  }

  private initializeServices(): void {
    try {
      this.cache = new MemoryCache(this.config.cache);
      this.emailService = new EmailService(
        this.config.email,
        this.cache,
        this.config.pools.imap,
      );
      this.smtpService = new SmtpService(
        this.config.smtp,
        this.config.pools.smtp,
      );
      this.calendarService = new CalendarService(
        this.config.calendar,
        this.cache,
      );

      if (this.config.debug) {
        console.error("Services initialized successfully");
        console.error("IMAP Pool Config:", {
          min: this.config.pools.imap.minConnections,
          max: this.config.pools.imap.maxConnections,
        });
        console.error("SMTP Pool Config:", {
          min: this.config.pools.smtp.minConnections,
          max: this.config.pools.smtp.maxConnections,
        });
      }
    } catch (error) {
      console.error("Failed to initialize services:", error);
      process.exit(1);
    }
  }

  private isEmailTool(toolName: string): boolean {
    return [
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
    ].includes(toolName);
  }

  private isCalendarTool(toolName: string): boolean {
    return ["get_calendar_events", "search_calendar", "get_free_busy"].includes(
      toolName,
    );
  }

  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args !== "object") {
      return args;
    }

    const sanitized = { ...args };

    // Remove invalid UUID parameters that Claude Desktop might pass
    for (const key in sanitized) {
      if (key.includes("uuid") && typeof sanitized[key] === "string") {
        const value = sanitized[key];
        // Check if the value is a valid UUID format
        if (
          value === "null" ||
          value === "none" ||
          value === "undefined" ||
          value === "" ||
          (value.length > 0 &&
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
              value,
            ) &&
            !value.startsWith("urn:uuid:"))
        ) {
          if (this.config.debug) {
            console.error(`Removing invalid UUID parameter: ${key}=${value}`);
          }
          delete sanitized[key];
        }
      }
    }

    return sanitized;
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const emailTools = createEmailTools(this.emailService, this.smtpService);
      const calendarTools = createCalendarTools(this.calendarService);

      return {
        tools: [...emailTools, ...calendarTools],
      };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (this.config.debug) {
        console.error(`Executing tool: ${name} with args:`, args);
      }

      // Filter out invalid UUID parameters that Claude Desktop might pass
      const cleanArgs = this.sanitizeArgs(args as Record<string, unknown>);

      try {
        if (this.isEmailTool(name)) {
          return await handleEmailTool(
            name,
            cleanArgs,
            this.emailService,
            this.smtpService,
          );
        }

        if (this.isCalendarTool(name)) {
          return await handleCalendarTool(
            name,
            cleanArgs,
            this.calendarService,
          );
        }

        throw new Error(`Unknown tool: ${name}`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`Tool execution error for ${name}:`, errorMessage);

        return {
          content: [
            {
              type: "text",
              text: `Error executing ${name}: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  async start(): Promise<void> {
    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      if (this.config.debug) {
        console.error("Mailbox MCP Server started successfully");
      }
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  }

  private async cleanup(): Promise<void> {
    try {
      if (this.config.debug) {
        console.error("Starting cleanup...");

        // Log pool metrics before cleanup
        const emailMetrics = this.emailService.getPoolMetrics();
        const smtpMetrics = this.smtpService.getPoolMetrics();

        console.error("Final IMAP Pool Metrics:", {
          total: emailMetrics.totalConnections,
          active: emailMetrics.activeConnections,
          idle: emailMetrics.idleConnections,
          acquired: emailMetrics.totalAcquired,
          released: emailMetrics.totalReleased,
          errors: emailMetrics.totalErrors,
        });

        console.error("Final SMTP Pool Metrics:", {
          total: smtpMetrics.totalConnections,
          active: smtpMetrics.activeConnections,
          idle: smtpMetrics.idleConnections,
          acquired: smtpMetrics.totalAcquired,
          released: smtpMetrics.totalReleased,
          errors: smtpMetrics.totalErrors,
        });
      }

      await this.emailService.disconnect();
      await this.smtpService.close();
      this.cache.destroy();

      if (this.config.debug) {
        console.error("Cleanup completed successfully");
      }
    } catch (error) {
      console.error("Error during cleanup:", error);
    }
  }
}

async function main(): Promise<void> {
  const server = new MailboxMcpServer();
  await server.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
