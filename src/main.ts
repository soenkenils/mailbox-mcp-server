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
      console.log("\nShutting down Mailbox MCP Server...");
      await this.cleanup();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("\nShutting down Mailbox MCP Server...");
      await this.cleanup();
      process.exit(0);
    });
  }

  private loadConfiguration(): void {
    try {
      this.config = loadConfig();
      if (this.config.debug) {
        console.log("Configuration loaded successfully");
      }
    } catch (error) {
      console.error("Failed to load configuration:", error);
      process.exit(1);
    }
  }

  private initializeServices(): void {
    try {
      this.cache = new MemoryCache(this.config.cache);
      this.emailService = new EmailService(this.config.email, this.cache);
      this.smtpService = new SmtpService(this.config.smtp);
      this.calendarService = new CalendarService(
        this.config.calendar,
        this.cache,
      );

      if (this.config.debug) {
        console.log("Services initialized successfully");
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
    ].includes(toolName);
  }

  private isCalendarTool(toolName: string): boolean {
    return ["get_calendar_events", "search_calendar", "get_free_busy"].includes(
      toolName,
    );
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
        console.log(`Executing tool: ${name} with args:`, args);
      }

      try {
        if (this.isEmailTool(name)) {
          return await handleEmailTool(
            name,
            args,
            this.emailService,
            this.smtpService,
          );
        }

        if (this.isCalendarTool(name)) {
          return await handleCalendarTool(name, args, this.calendarService);
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
        console.log("Mailbox MCP Server started successfully");
      }
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  }

  private async cleanup(): Promise<void> {
    try {
      await this.emailService.disconnect();
      await this.smtpService.close();
      this.cache.destroy();

      if (this.config.debug) {
        console.log("Cleanup completed");
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
