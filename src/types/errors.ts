/**
 * Custom error types for the Mailbox MCP Server
 * Provides structured error handling with context and categorization
 */

export enum ErrorCode {
  // Connection errors
  CONNECTION_FAILED = "CONNECTION_FAILED",
  CONNECTION_TIMEOUT = "CONNECTION_TIMEOUT",
  CONNECTION_REFUSED = "CONNECTION_REFUSED",
  CONNECTION_LOST = "CONNECTION_LOST",

  // Authentication errors
  AUTH_FAILED = "AUTH_FAILED",
  AUTH_INVALID_CREDENTIALS = "AUTH_INVALID_CREDENTIALS",
  AUTH_TOKEN_EXPIRED = "AUTH_TOKEN_EXPIRED",
  AUTH_INSUFFICIENT_PERMISSIONS = "AUTH_INSUFFICIENT_PERMISSIONS",

  // Validation errors
  VALIDATION_FAILED = "VALIDATION_FAILED",

  // Email specific errors
  EMAIL_NOT_FOUND = "EMAIL_NOT_FOUND",
  FOLDER_NOT_FOUND = "FOLDER_NOT_FOUND",
  ATTACHMENT_TOO_LARGE = "ATTACHMENT_TOO_LARGE",
  INVALID_EMAIL_ADDRESS = "INVALID_EMAIL_ADDRESS",

  // Calendar specific errors
  CALENDAR_NOT_FOUND = "CALENDAR_NOT_FOUND",
  EVENT_NOT_FOUND = "EVENT_NOT_FOUND",
  INVALID_DATE_RANGE = "INVALID_DATE_RANGE",
  CALENDAR_CONFLICT = "CALENDAR_CONFLICT",

  // Internal errors
  INTERNAL_ERROR = "INTERNAL_ERROR",
  OPERATION_FAILED = "OPERATION_FAILED",
}

export interface ErrorContext {
  operation?: string;
  service?: string;
  timestamp?: Date;
  requestId?: string;
  userId?: string;
  details?: Record<string, unknown>;
}

/**
 * Base error class for all MCP server errors
 */
export abstract class MCPError extends Error {
  public readonly code: ErrorCode;
  public readonly context: ErrorContext;
  public readonly isRetryable: boolean;
  public readonly timestamp: Date;

  constructor(
    message: string,
    code: ErrorCode,
    context: ErrorContext = {},
    isRetryable = false,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = {
      ...context,
      timestamp: context.timestamp || new Date(),
    };
    this.isRetryable = isRetryable;
    this.timestamp = new Date();

    // Maintains proper stack trace for where our error was thrown
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Get a serializable representation of the error
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      isRetryable: this.isRetryable,
      timestamp: this.timestamp,
      stack: this.stack,
    };
  }

  /**
   * Get a user-friendly error message
   */
  getUserMessage(): string {
    return this.message;
  }
}

/**
 * Connection-related errors
 */
export class ConnectionError extends MCPError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.CONNECTION_FAILED,
    context: ErrorContext = {},
  ) {
    super(message, code, context, true); // Connection errors are usually retryable
  }

  getUserMessage(): string {
    switch (this.code) {
      case ErrorCode.CONNECTION_TIMEOUT:
        return "Connection timed out. Please check your network connection and try again.";
      case ErrorCode.CONNECTION_REFUSED:
        return "Connection was refused. The server may be unavailable.";
      case ErrorCode.CONNECTION_LOST:
        return "Connection was lost. Attempting to reconnect...";
      default:
        return "Unable to connect to the server. Please try again later.";
    }
  }
}

/**
 * Authentication-related errors
 */
export class AuthenticationError extends MCPError {
  constructor(
    message: string,
    code: ErrorCode = ErrorCode.AUTH_FAILED,
    context: ErrorContext = {},
  ) {
    super(message, code, context, false); // Auth errors are usually not retryable
  }

  getUserMessage(): string {
    switch (this.code) {
      case ErrorCode.AUTH_INVALID_CREDENTIALS:
        return "Invalid email or password. Please check your credentials.";
      case ErrorCode.AUTH_TOKEN_EXPIRED:
        return "Your session has expired. Please re-authenticate.";
      case ErrorCode.AUTH_INSUFFICIENT_PERMISSIONS:
        return "You don't have permission to perform this action.";
      default:
        return "Authentication failed. Please check your credentials.";
    }
  }
}

/**
 * Input validation errors
 */
export class ValidationError extends MCPError {
  public readonly field?: string;
  public readonly value?: unknown;

  constructor(
    message: string,
    field?: string,
    value?: unknown,
    context: ErrorContext = {},
  ) {
    super(message, ErrorCode.VALIDATION_FAILED, context, false);
    this.field = field;
    this.value = value;
  }

  getUserMessage(): string {
    if (this.field) {
      return `Invalid value for field '${this.field}': ${this.message}`;
    }
    return `Validation failed: ${this.message}`;
  }
}

/**
 * Email-specific errors
 */
export class EmailError extends MCPError {
  public readonly emailId?: string;
  public readonly folder?: string;

  constructor(
    message: string,
    code: ErrorCode,
    emailId?: string,
    folder?: string,
    context: ErrorContext = {},
  ) {
    super(message, code, context, false);
    this.emailId = emailId;
    this.folder = folder;
  }

  getUserMessage(): string {
    switch (this.code) {
      case ErrorCode.EMAIL_NOT_FOUND:
        return "The requested email could not be found.";
      case ErrorCode.FOLDER_NOT_FOUND:
        return "The specified folder does not exist.";
      case ErrorCode.ATTACHMENT_TOO_LARGE:
        return "The attachment is too large to process.";
      case ErrorCode.INVALID_EMAIL_ADDRESS:
        return "The email address format is invalid.";
      default:
        return "An email operation failed. Please try again.";
    }
  }
}

/**
 * Calendar-specific errors
 */
export class CalendarError extends MCPError {
  public readonly calendarId?: string;
  public readonly eventId?: string;

  constructor(
    message: string,
    code: ErrorCode,
    calendarId?: string,
    eventId?: string,
    context: ErrorContext = {},
  ) {
    super(message, code, context, false);
    this.calendarId = calendarId;
    this.eventId = eventId;
  }

  getUserMessage(): string {
    switch (this.code) {
      case ErrorCode.CALENDAR_NOT_FOUND:
        return "The specified calendar could not be found.";
      case ErrorCode.EVENT_NOT_FOUND:
        return "The requested calendar event could not be found.";
      case ErrorCode.INVALID_DATE_RANGE:
        return "The specified date range is invalid.";
      case ErrorCode.CALENDAR_CONFLICT:
        return "There is a scheduling conflict with this calendar event.";
      default:
        return "A calendar operation failed. Please try again.";
    }
  }
}

/**
 * Convert any error to MCPError
 */
export function toMCPError(error: Error, context: ErrorContext = {}): MCPError {
  if (error instanceof MCPError) {
    return error;
  }

  // Categorize common error patterns
  if (error.message.includes("auth") || error.message.includes("login")) {
    return new AuthenticationError(
      error.message,
      ErrorCode.AUTH_FAILED,
      context,
    );
  }

  if (
    error.message.includes("connection") ||
    error.message.includes("network") ||
    error.message.includes("ECONNRESET") ||
    error.message.includes("ENOTFOUND") ||
    error.message.includes("ECONNREFUSED") ||
    error.message.includes("Connection not available")
  ) {
    return new ConnectionError(
      error.message,
      ErrorCode.CONNECTION_FAILED,
      context,
    );
  }

  if (
    error.message.includes("timeout") ||
    error.message.includes("ETIMEDOUT")
  ) {
    return new ConnectionError(
      error.message,
      ErrorCode.CONNECTION_TIMEOUT,
      context,
    );
  }

  // Default to internal error
  return new (class extends MCPError {
    constructor() {
      super(error.message, ErrorCode.INTERNAL_ERROR, context, false);
      this.stack = error.stack;
    }
  })();
}

/**
 * @deprecated Import toMCPError directly. Kept until src/main.ts and
 * SmtpService, which open PRs are changing, stop using it.
 */
export const ErrorUtils = {
  toMCPError,
};
