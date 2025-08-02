/**
 * Enhanced logging system for MCP servers
 * Provides both stderr logging and MCP notifications with RFC 5424 log levels
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

/**
 * RFC 5424 log levels as specified in MCP specification
 */
export enum LogLevel {
  DEBUG = "debug",
  INFO = "info",
  NOTICE = "notice",
  WARNING = "warning",
  ERROR = "error",
  CRITICAL = "critical",
  ALERT = "alert",
  EMERGENCY = "emergency",
}

/**
 * Numeric values for log levels (for comparison)
 */
const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
  [LogLevel.DEBUG]: 0,
  [LogLevel.INFO]: 1,
  [LogLevel.NOTICE]: 2,
  [LogLevel.WARNING]: 3,
  [LogLevel.ERROR]: 4,
  [LogLevel.CRITICAL]: 5,
  [LogLevel.ALERT]: 6,
  [LogLevel.EMERGENCY]: 7,
};

/**
 * Context information for log entries
 */
export interface LogContext {
  operation?: string;
  service?: string;
  requestId?: string;
  userId?: string;
  duration?: number;
  metadata?: Record<string, unknown>;
  timestamp?: Date;
}

/**
 * Performance metrics data
 */
export interface PerformanceMetrics {
  operation: string;
  duration: number;
  startTime: Date;
  endTime: Date;
  success: boolean;
  errorType?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Structured log entry
 */
export interface LogEntry {
  level: LogLevel;
  message: string;
  logger?: string;
  context: LogContext;
  timestamp: Date;
  data?: Record<string, unknown>;
}

/**
 * Logger configuration
 */
export interface LoggerConfig {
  minLevel: LogLevel;
  enableStderr: boolean;
  enableMcpNotifications: boolean;
  includeTimestamp: boolean;
  includeContext: boolean;
  maxContextDepth: number;
}

/**
 * Default logger configuration
 */
const DEFAULT_CONFIG: LoggerConfig = {
  minLevel: LogLevel.INFO,
  enableStderr: true,
  enableMcpNotifications: true,
  includeTimestamp: true,
  includeContext: true,
  maxContextDepth: 3,
};

/**
 * Enhanced logger for MCP servers
 */
export class Logger {
  private config: LoggerConfig;
  private mcpServer?: Server;
  private performanceMetrics: PerformanceMetrics[] = [];
  private readonly maxMetricsHistory = 1000;

  constructor(config: Partial<LoggerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the MCP server instance for notifications
   */
  setMcpServer(server: Server): void {
    this.mcpServer = server;
  }

  /**
   * Set minimum log level
   */
  setMinLevel(level: LogLevel): void {
    this.config.minLevel = level;
  }

  /**
   * Check if a log level should be processed
   */
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_VALUES[level] >= LOG_LEVEL_VALUES[this.config.minLevel];
  }

  /**
   * Format log entry for stderr output
   */
  private formatStderrLog(entry: LogEntry): string {
    const parts: string[] = [];

    if (this.config.includeTimestamp) {
      parts.push(`[${entry.timestamp.toISOString()}]`);
    }

    parts.push(`[${entry.level.toUpperCase()}]`);

    if (entry.logger) {
      parts.push(`[${entry.logger}]`);
    }

    parts.push(entry.message);

    if (this.config.includeContext && entry.context) {
      const contextParts: string[] = [];

      if (entry.context.operation) {
        contextParts.push(`op=${entry.context.operation}`);
      }

      if (entry.context.service) {
        contextParts.push(`svc=${entry.context.service}`);
      }

      if (entry.context.duration !== undefined) {
        contextParts.push(`dur=${entry.context.duration}ms`);
      }

      if (entry.context.requestId) {
        contextParts.push(`req=${entry.context.requestId}`);
      }

      if (contextParts.length > 0) {
        parts.push(`{${contextParts.join(", ")}}`);
      }
    }

    if (entry.data) {
      const serializedData = this.serializeData(entry.data);
      if (serializedData) {
        parts.push(`data=${serializedData}`);
      }
    }

    return parts.join(" ");
  }

  /**
   * Serialize data for logging with depth control
   */
  private serializeData(data: unknown, depth = 0): string {
    if (depth >= this.config.maxContextDepth) {
      return "[max depth reached]";
    }

    try {
      if (data === null || data === undefined) {
        return String(data);
      }

      if (
        typeof data === "string" ||
        typeof data === "number" ||
        typeof data === "boolean"
      ) {
        return String(data);
      }

      if (data instanceof Error) {
        return `Error: ${data.message}`;
      }

      if (data instanceof Date) {
        return data.toISOString();
      }

      if (Array.isArray(data)) {
        if (data.length === 0) return "[]";
        if (data.length > 5) return `[Array(${data.length})]`;
        return `[${data.map((item) => this.serializeData(item, depth + 1)).join(", ")}]`;
      }

      if (typeof data === "object") {
        const keys = Object.keys(data);
        if (keys.length === 0) return "{}";
        if (keys.length > 10) return `{Object(${keys.length} keys)}`;

        const pairs = keys.slice(0, 5).map((key) => {
          const value = (data as Record<string, unknown>)[key];
          return `${key}: ${this.serializeData(value, depth + 1)}`;
        });

        return `{${pairs.join(", ")}}`;
      }

      return String(data);
    } catch (error) {
      return "[serialization error]";
    }
  }

  /**
   * Send log entry to stderr
   */
  private writeToStderr(entry: LogEntry): void {
    if (!this.config.enableStderr) return;

    const formatted = this.formatStderrLog(entry);
    console.error(formatted);
  }

  /**
   * Send MCP logging notification
   */
  private async sendMcpNotification(entry: LogEntry): Promise<void> {
    if (!this.config.enableMcpNotifications || !this.mcpServer) return;

    try {
      // Prepare notification data
      const notificationData: Record<string, unknown> = {
        message: entry.message,
        timestamp: entry.timestamp.toISOString(),
        ...entry.context,
      };

      if (entry.data) {
        notificationData.data = entry.data;
      }

      // Send MCP notification
      await this.mcpServer.sendLoggingMessage({
        level: entry.level,
        logger: entry.logger,
        data: notificationData,
      });
    } catch (error) {
      // Fall back to stderr if MCP notification fails
      console.error(
        `[LOGGER] Failed to send MCP notification: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Core logging method
   */
  private async log(
    level: LogLevel,
    message: string,
    context: LogContext = {},
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.shouldLog(level)) return;

    const entry: LogEntry = {
      level,
      message,
      logger,
      context: {
        ...context,
        timestamp: context.timestamp || new Date(),
      },
      timestamp: new Date(),
      data,
    };

    // Write to stderr (synchronous)
    this.writeToStderr(entry);

    // Send MCP notification (asynchronous, don't await to avoid blocking)
    this.sendMcpNotification(entry).catch(() => {
      // Error already logged in sendMcpNotification
    });
  }

  /**
   * Log at debug level
   */
  async debug(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.DEBUG, message, context, logger, data);
  }

  /**
   * Log at info level
   */
  async info(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.INFO, message, context, logger, data);
  }

  /**
   * Log at notice level
   */
  async notice(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.NOTICE, message, context, logger, data);
  }

  /**
   * Log at warning level
   */
  async warning(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.WARNING, message, context, logger, data);
  }

  /**
   * Log at error level
   */
  async error(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.ERROR, message, context, logger, data);
  }

  /**
   * Log at critical level
   */
  async critical(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.CRITICAL, message, context, logger, data);
  }

  /**
   * Log at alert level
   */
  async alert(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.ALERT, message, context, logger, data);
  }

  /**
   * Log at emergency level
   */
  async emergency(
    message: string,
    context?: LogContext,
    logger?: string,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.log(LogLevel.EMERGENCY, message, context, logger, data);
  }

  /**
   * Record performance metrics
   */
  recordPerformance(metrics: PerformanceMetrics): void {
    this.performanceMetrics.push(metrics);

    // Keep only recent metrics
    if (this.performanceMetrics.length > this.maxMetricsHistory) {
      this.performanceMetrics = this.performanceMetrics.slice(
        -this.maxMetricsHistory,
      );
    }

    // Log performance metric
    const level = metrics.success ? LogLevel.INFO : LogLevel.WARNING;
    const message = `Performance: ${metrics.operation} ${metrics.success ? "completed" : "failed"} in ${metrics.duration}ms`;

    this.log(
      level,
      message,
      {
        operation: metrics.operation,
        duration: metrics.duration,
        metadata: {
          startTime: metrics.startTime.toISOString(),
          endTime: metrics.endTime.toISOString(),
          success: metrics.success,
          errorType: metrics.errorType,
          ...metrics.metadata,
        },
      },
      "performance",
    ).catch(() => {
      // Ignore logging errors for performance metrics
    });
  }

  /**
   * Get performance metrics summary
   */
  getPerformanceMetrics(): {
    total: number;
    successful: number;
    failed: number;
    averageDuration: number;
    recentMetrics: PerformanceMetrics[];
  } {
    const successful = this.performanceMetrics.filter((m) => m.success).length;
    const failed = this.performanceMetrics.length - successful;
    const averageDuration =
      this.performanceMetrics.length > 0
        ? this.performanceMetrics.reduce((sum, m) => sum + m.duration, 0) /
          this.performanceMetrics.length
        : 0;

    return {
      total: this.performanceMetrics.length,
      successful,
      failed,
      averageDuration: Math.round(averageDuration * 100) / 100,
      recentMetrics: this.performanceMetrics.slice(-10), // Last 10 metrics
    };
  }

  /**
   * Create a child logger with a specific logger name
   */
  child(loggerName: string): ChildLogger {
    return new ChildLogger(this, loggerName);
  }

  /**
   * Create a performance timer
   */
  startTimer(
    operation: string,
    metadata?: Record<string, unknown>,
  ): PerformanceTimer {
    return new PerformanceTimer(this, operation, metadata);
  }
}

/**
 * Child logger with a predefined logger name
 */
export class ChildLogger {
  constructor(
    private parent: Logger,
    private loggerName: string,
  ) {}

  async debug(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.debug(message, context, this.loggerName, data);
  }

  async info(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.info(message, context, this.loggerName, data);
  }

  async notice(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.notice(message, context, this.loggerName, data);
  }

  async warning(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.warning(message, context, this.loggerName, data);
  }

  async error(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.error(message, context, this.loggerName, data);
  }

  async critical(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.critical(message, context, this.loggerName, data);
  }

  async alert(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.alert(message, context, this.loggerName, data);
  }

  async emergency(
    message: string,
    context?: LogContext,
    data?: Record<string, unknown>,
  ): Promise<void> {
    return this.parent.emergency(message, context, this.loggerName, data);
  }

  startTimer(
    operation: string,
    metadata?: Record<string, unknown>,
  ): PerformanceTimer {
    return this.parent.startTimer(operation, metadata);
  }
}

/**
 * Performance timer utility
 */
export class PerformanceTimer {
  private startTime: Date;

  constructor(
    private logger: Logger,
    private operation: string,
    private metadata?: Record<string, unknown>,
  ) {
    this.startTime = new Date();
  }

  /**
   * End the timer and record performance metrics
   */
  end(success = true, errorType?: string): PerformanceMetrics {
    const endTime = new Date();
    const duration = endTime.getTime() - this.startTime.getTime();

    const metrics: PerformanceMetrics = {
      operation: this.operation,
      duration,
      startTime: this.startTime,
      endTime,
      success,
      errorType,
      metadata: this.metadata,
    };

    this.logger.recordPerformance(metrics);
    return metrics;
  }
}

/**
 * Global logger instance
 */
export const logger = new Logger();

/**
 * Convenience function to create a child logger
 */
export function createLogger(loggerName: string): ChildLogger {
  return logger.child(loggerName);
}
