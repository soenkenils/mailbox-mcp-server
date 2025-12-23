import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequest,
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, type ServerConfig } from "./config/config.js";
import { CalendarService } from "./services/CalendarService.js";
import {
  type DynamicPoolConfig,
  dynamicPoolManager,
} from "./services/DynamicPoolManager.js";
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
        },
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

      // Register pools with dynamic pool manager for adaptive scaling
      // Type assertion needed due to interface compatibility between ConnectionPoolConfig and DynamicPoolConfig
      dynamicPoolManager.registerPool(
        "imap",
        this.config.pools.imap as unknown as DynamicPoolConfig,
      );
      dynamicPoolManager.registerPool(
        "smtp",
        this.config.pools.smtp as unknown as DynamicPoolConfig,
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
          this.logger.debug(
            `Removing invalid UUID parameter: ${key}=${value}`,
            {
              operation: "sanitizeArgs",
              service: "validation",
            },
          );
          delete sanitized[key];
        }
      }
    }

    return sanitized;
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

    this.server.setRequestHandler(CallToolRequestSchema, async request => {
      const { name, arguments: args } = request.params;
      const timer = this.logger.startTimer(`tool:${name}`);

      this.logger.debug(
        `Executing tool: ${name}`,
        {
          operation: "callTool",
          service: "toolHandler",
        },
        { tool: name, args },
      );

      // Filter out invalid UUID parameters that Claude Desktop might pass
      const cleanArgs = this.sanitizeArgs(args as Record<string, unknown>);

      try {
        let result: CallToolResult;

        if (isEmailTool(name)) {
          result = await handleEmailTool(
            name,
            cleanArgs,
            this.emailService,
            this.smtpService,
          );
        } else if (isCalendarTool(name)) {
          result = await handleCalendarTool(
            name,
            cleanArgs,
            this.calendarService,
          );
        } else if (isSieveTool(name)) {
          result = await handleSieveTool(
            { params: { name, arguments: cleanArgs } } as CallToolRequest,
            this.config,
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
                details: { tool: name, args: cleanArgs },
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
          capabilities: ["tools", "logging"],
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
