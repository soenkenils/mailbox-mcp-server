import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ServerNotification,
  type ServerRequest,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type ServerConfig } from "./config/config.js";
import { CalendarService } from "./services/CalendarService.js";
import { EmailService } from "./services/EmailService.js";
import { MemoryCache } from "./services/LocalCache.js";
import { createLogger, LogLevel, logger } from "./services/Logger.js";
import { SmtpService } from "./services/SmtpService.js";
import {
  createCalendarTools,
  handleCalendarTool,
  isCalendarTool,
} from "./tools/calendarTools.js";
import {
  createEmailPrompts,
  handleEmailPrompt,
  isEmailPrompt,
} from "./tools/emailPrompts.js";
import {
  listEmailResources,
  readEmailResource,
} from "./tools/emailResources.js";
import {
  createEmailTools,
  handleEmailTool,
  isEmailTool,
} from "./tools/emailTools.js";
import {
  getSieveTools,
  handleSieveTool,
  isSieveTool,
} from "./tools/sieveTools.js";
import { ErrorUtils, ValidationError } from "./types/errors.js";
import {
  createProgressReporter,
  type ToolContext,
} from "./types/tool.types.js";
import { summarizeArgs } from "./utils/toolArgs.js";

/**
 * Lands in the model's system prompt. This is the place for conventions that
 * span tools; repeating them in every description would be noise.
 */
export const SERVER_INSTRUCTIONS = [
  "Mailbox folder names vary by account: call get_folders to discover the real paths before passing a folder argument.",
  "Email UIDs are per-folder. A UID from search_emails is only meaningful in the folder it was returned from, and a message that moves folders gets a new one.",
  "search_emails returns headers only; message bodies come from get_email.",
].join(" ");

class MailboxMcpServer {
  private server: Server;
  private emailService!: EmailService;
  private smtpService!: SmtpService;
  private calendarService!: CalendarService;
  private cache!: MemoryCache;
  private config!: ServerConfig;
  private logger = createLogger("MailboxMcpServer");

  private constructor() {
    this.server = new Server(
      {
        name: "mailbox-mcp-server",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          logging: {},
          prompts: {},
          resources: {},
        },
        instructions: SERVER_INSTRUCTIONS,
      },
    );
  }

  /**
   * Factory method to create and initialize the server.
   * Separates construction from async initialization for better testability.
   */
  static async create(): Promise<MailboxMcpServer> {
    const instance = new MailboxMcpServer();

    // Configure logger with MCP server
    logger.setMcpServer(instance.server);

    instance.setupErrorHandling();
    instance.loadConfiguration();
    instance.initializeServices();
    instance.setupToolHandlers();
    instance.setupPromptAndResourceHandlers();

    return instance;
  }

  private setupErrorHandling(): void {
    this.server.onerror = error => {
      this.logger.error(
        "MCP Server error",
        {
          operation: "mcp_server_error",
          service: "server",
        },
        { error: error.message, stack: error.stack },
      );
    };

    // Unified shutdown handler for both signals
    const handleShutdown = async (signal: string) => {
      this.logger.info(`Received ${signal}, shutting down gracefully`, {
        operation: "shutdown",
        service: "process",
      });
      await this.cleanup();
      process.exit(0);
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }

  private loadConfiguration(): void {
    try {
      this.config = loadConfig();

      // Set logger level based on debug config
      if (this.config.debug) {
        logger.setMinLevel(LogLevel.DEBUG);
        this.logger.debug("Debug mode enabled");
      }

      this.logger.info(
        "Configuration loaded successfully",
        {
          operation: "loadConfiguration",
          service: "config",
        },
        {
          debug: this.config.debug,
          pools: {
            imap: this.config.pools.imap.maxConnections,
            smtp: this.config.pools.smtp.maxConnections,
          },
        },
      );
    } catch (error) {
      this.logger.critical(
        "Failed to load configuration",
        {
          operation: "loadConfiguration",
          service: "config",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
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

      this.logger.info(
        "Services initialized successfully",
        {
          operation: "initializeServices",
          service: "initialization",
        },
        {
          services: [
            "EmailService",
            "SmtpService",
            "CalendarService",
            "MemoryCache",
          ],
          imapPool: {
            min: this.config.pools.imap.minConnections,
            max: this.config.pools.imap.maxConnections,
          },
          smtpPool: {
            min: this.config.pools.smtp.minConnections,
            max: this.config.pools.smtp.maxConnections,
          },
        },
      );
    } catch (error) {
      this.logger.critical(
        "Failed to initialize services",
        {
          operation: "initializeServices",
          service: "initialization",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      process.exit(1);
    }
  }

  /**
   * Narrows the SDK's per-request `extra` to what tools need: the abort
   * signal, and a progress reporter only when the client sent a
   * progressToken, since without one there is nothing to address it to.
   */
  private toolContext(
    request: CallToolRequest,
    extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
  ): ToolContext {
    return {
      signal: extra.signal,
      reportProgress: createProgressReporter(
        request.params._meta?.progressToken,
        params =>
          extra.sendNotification({
            method: "notifications/progress",
            params,
          }),
      ),
    };
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, () => {
      // Tool definitions are synchronous
      const emailTools = createEmailTools(this.emailService, this.smtpService);
      const calendarTools = createCalendarTools(this.calendarService);
      const sieveTools = getSieveTools();

      return {
        tools: [...emailTools, ...calendarTools, ...sieveTools],
      };
    });

    const { server } = this;
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args } = request.params;
      const timer = this.logger.startTimer(`tool:${name}`);
      const context = this.toolContext(request, extra);

      this.logger.debug(
        `Executing tool: ${name}`,
        {
          operation: "callTool",
          service: "toolHandler",
        },
        // Shape only: argument values are mail content and recipients.
        { tool: name, args: summarizeArgs(args) },
      );

      const toolArgs = args ?? {};

      try {
        let result: CallToolResult;

        if (isEmailTool(name)) {
          result = await handleEmailTool(
            name,
            toolArgs,
            this.emailService,
            this.smtpService,
            context,
          );
        } else if (isCalendarTool(name)) {
          result = await handleCalendarTool(
            name,
            toolArgs,
            this.calendarService,
          );
        } else if (isSieveTool(name)) {
          result = await handleSieveTool(
            { params: { name, arguments: toolArgs } } as CallToolRequest,
            this.config,
            context,
          );
        } else {
          throw new ValidationError(`Unknown tool: ${name}`, "tool_name", name);
        }

        // Record successful execution
        const metrics = timer.end(true);
        this.logger.info(
          `Tool executed successfully: ${name}`,
          {
            operation: "callTool",
            service: "toolHandler",
            duration: metrics.duration,
          },
          { tool: name, success: true },
        );

        return result;
      } catch (error) {
        // Record failed execution
        const errorType =
          error instanceof Error ? error.constructor.name : "UnknownError";
        const metrics = timer.end(false, errorType);

        // Convert to structured error
        const mcpError =
          error instanceof Error
            ? ErrorUtils.toMCPError(error, {
                operation: `call_tool:${name}`,
                service: "MailboxMcpServer",
                details: { tool: name, args: summarizeArgs(toolArgs) },
              })
            : new ValidationError(String(error), "unknown", error);

        this.logger.error(
          `Tool execution failed: ${name}`,
          {
            operation: "callTool",
            service: "toolHandler",
            duration: metrics.duration,
          },
          {
            tool: name,
            error: mcpError.toJSON(),
            userMessage: mcpError.getUserMessage(),
            isRetryable: mcpError.isRetryable,
          },
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
    });
  }

  /**
   * Prompts are user-picked workflows; the folder resource is reference data
   * the host can browse. Neither has side effects: every mail access still
   * goes through a tool call the user can see and approve.
   */
  private setupPromptAndResourceHandlers(): void {
    this.server.setRequestHandler(ListPromptsRequestSchema, () => ({
      prompts: createEmailPrompts(),
    }));

    this.server.setRequestHandler(GetPromptRequestSchema, request => {
      const { name, arguments: args } = request.params;
      // Guarded the same way tools are, so an unknown name fails at dispatch
      // rather than inside a handler that assumes it owns the namespace.
      if (!isEmailPrompt(name)) {
        throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
      }
      return handleEmailPrompt(name, args);
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, () => ({
      resources: listEmailResources(),
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, request =>
      readEmailResource(request.params.uri, this.emailService),
    );
  }

  async start(): Promise<void> {
    const startTimer = this.logger.startTimer("server_startup");

    try {
      const transport = new StdioServerTransport();
      await this.server.connect(transport);

      const metrics = startTimer.end(true);
      this.logger.info(
        "Mailbox MCP Server started successfully",
        {
          operation: "server_startup",
          service: "MailboxMcpServer",
          duration: metrics.duration,
        },
        {
          version: "0.1.0",
          capabilities: ["tools", "logging", "prompts", "resources"],
          transport: "stdio",
        },
      );
    } catch (error) {
      const metrics = startTimer.end(
        false,
        error instanceof Error ? error.constructor.name : "UnknownError",
      );
      const mcpError = ErrorUtils.toMCPError(error as Error, {
        operation: "server_startup",
        service: "MailboxMcpServer",
      });

      this.logger.critical(
        "Failed to start server",
        {
          operation: "server_startup",
          service: "MailboxMcpServer",
          duration: metrics.duration,
        },
        {
          error: mcpError.toJSON(),
          userMessage: mcpError.getUserMessage(),
        },
      );
      process.exit(1);
    }
  }

  private async cleanup(): Promise<void> {
    const cleanupTimer = this.logger.startTimer("server_cleanup");

    try {
      this.logger.info("Starting server cleanup", {
        operation: "cleanup",
        service: "MailboxMcpServer",
      });

      // Log pool metrics before cleanup (sync calls, no Promise.all needed)
      const emailMetrics = this.emailService.getPoolMetrics();
      const smtpMetrics = this.smtpService.getPoolMetrics();
      const performanceMetrics = logger.getPerformanceMetrics();

      this.logger.info(
        "Final connection pool metrics",
        {
          operation: "cleanup",
          service: "metrics",
        },
        {
          imapPool: {
            total: emailMetrics.totalConnections,
            active: emailMetrics.activeConnections,
            idle: emailMetrics.idleConnections,
            acquired: emailMetrics.totalAcquired,
            released: emailMetrics.totalReleased,
            errors: emailMetrics.totalErrors,
          },
          smtpPool: {
            total: smtpMetrics.totalConnections,
            active: smtpMetrics.activeConnections,
            idle: smtpMetrics.idleConnections,
            acquired: smtpMetrics.totalAcquired,
            released: smtpMetrics.totalReleased,
            errors: smtpMetrics.totalErrors,
          },
          performance: {
            totalOperations: performanceMetrics.total,
            successful: performanceMetrics.successful,
            failed: performanceMetrics.failed,
            averageDuration: performanceMetrics.averageDuration,
          },
        },
      );

      // Disconnect services in parallel for faster cleanup
      await Promise.all([
        this.emailService.disconnect(),
        this.smtpService.close(),
        this.calendarService.disconnect(),
      ]);
      this.cache.destroy();

      const metrics = cleanupTimer.end(true);
      this.logger.info("Server cleanup completed successfully", {
        operation: "cleanup",
        service: "MailboxMcpServer",
        duration: metrics.duration,
      });
    } catch (error) {
      const metrics = cleanupTimer.end(
        false,
        error instanceof Error ? error.constructor.name : "UnknownError",
      );
      this.logger.error(
        "Error during cleanup",
        {
          operation: "cleanup",
          service: "MailboxMcpServer",
          duration: metrics.duration,
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}

async function main(): Promise<void> {
  const server = await MailboxMcpServer.create();
  await server.start();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    const mcpError = ErrorUtils.toMCPError(error as Error, {
      operation: "main",
      service: "MailboxMcpServer",
    });

    console.error("Fatal error:", {
      error: mcpError.toJSON(),
      userMessage: mcpError.getUserMessage(),
    });
    process.exit(1);
  });
}
