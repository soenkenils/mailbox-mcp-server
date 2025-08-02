import { describe, expect, it } from "vitest";
import {
  AuthenticationError,
  CacheError,
  CalendarError,
  ConfigurationError,
  ConnectionError,
  EmailError,
  ErrorCode,
  ErrorUtils,
  type MCPError,
  MailboxError,
  RateLimitError,
  ValidationError,
} from "../src/types/errors.js";

describe("Custom Error Types", () => {
  describe("ConnectionError", () => {
    it("should create connection error with proper properties", () => {
      const error = new ConnectionError(
        "Connection failed",
        ErrorCode.CONNECTION_FAILED,
      );

      expect(error.name).toBe("ConnectionError");
      expect(error.message).toBe("Connection failed");
      expect(error.code).toBe(ErrorCode.CONNECTION_FAILED);
      expect(error.isRetryable).toBe(true);
      expect(error.getUserMessage()).toBe(
        "Unable to connect to the server. Please try again later.",
      );
    });

    it("should provide specific user messages for different connection codes", () => {
      const timeoutError = new ConnectionError(
        "Timeout",
        ErrorCode.CONNECTION_TIMEOUT,
      );
      expect(timeoutError.getUserMessage()).toBe(
        "Connection timed out. Please check your network connection and try again.",
      );

      const refusedError = new ConnectionError(
        "Refused",
        ErrorCode.CONNECTION_REFUSED,
      );
      expect(refusedError.getUserMessage()).toBe(
        "Connection was refused. The server may be unavailable.",
      );
    });
  });

  describe("AuthenticationError", () => {
    it("should create authentication error with proper properties", () => {
      const error = new AuthenticationError(
        "Invalid credentials",
        ErrorCode.AUTH_INVALID_CREDENTIALS,
      );

      expect(error.name).toBe("AuthenticationError");
      expect(error.message).toBe("Invalid credentials");
      expect(error.code).toBe(ErrorCode.AUTH_INVALID_CREDENTIALS);
      expect(error.isRetryable).toBe(false);
      expect(error.getUserMessage()).toBe(
        "Invalid email or password. Please check your credentials.",
      );
    });
  });

  describe("ValidationError", () => {
    it("should create validation error with field information", () => {
      const error = new ValidationError(
        "Invalid email format",
        "email",
        "invalid-email",
      );

      expect(error.name).toBe("ValidationError");
      expect(error.field).toBe("email");
      expect(error.value).toBe("invalid-email");
      expect(error.isRetryable).toBe(false);
      expect(error.getUserMessage()).toBe(
        "Invalid value for field 'email': Invalid email format",
      );
    });
  });

  describe("EmailError", () => {
    it("should create email error with email-specific properties", () => {
      const error = new EmailError(
        "Email not found",
        ErrorCode.EMAIL_NOT_FOUND,
        "123",
        "INBOX",
      );

      expect(error.name).toBe("EmailError");
      expect(error.emailId).toBe("123");
      expect(error.folder).toBe("INBOX");
      expect(error.getUserMessage()).toBe(
        "The requested email could not be found.",
      );
    });
  });

  describe("CalendarError", () => {
    it("should create calendar error with calendar-specific properties", () => {
      const error = new CalendarError(
        "Event not found",
        ErrorCode.EVENT_NOT_FOUND,
        "cal1",
        "event1",
      );

      expect(error.name).toBe("CalendarError");
      expect(error.calendarId).toBe("cal1");
      expect(error.eventId).toBe("event1");
      expect(error.getUserMessage()).toBe(
        "The requested calendar event could not be found.",
      );
    });
  });

  describe("RateLimitError", () => {
    it("should create rate limit error with retry information", () => {
      const error = new RateLimitError("Rate limit exceeded", 60);

      expect(error.name).toBe("RateLimitError");
      expect(error.retryAfter).toBe(60);
      expect(error.isRetryable).toBe(true);
      expect(error.getUserMessage()).toBe(
        "Rate limit exceeded. Please try again in 60 seconds.",
      );
    });
  });

  describe("ErrorUtils", () => {
    it("should correctly identify retryable errors", () => {
      const connectionError = new ConnectionError("Connection failed");
      const authError = new AuthenticationError("Invalid credentials");

      expect(ErrorUtils.isRetryable(connectionError)).toBe(true);
      expect(ErrorUtils.isRetryable(authError)).toBe(false);

      // Test with regular Error
      const networkError = new Error("ECONNRESET");
      expect(ErrorUtils.isRetryable(networkError)).toBe(true);
    });

    it("should convert regular errors to MCPErrors", () => {
      const originalError = new Error("ECONNRESET");
      const mcpError = ErrorUtils.toMCPError(originalError);

      expect(mcpError).toBeInstanceOf(ConnectionError);
      expect(mcpError.code).toBe(ErrorCode.CONNECTION_FAILED);
      expect(mcpError.isRetryable).toBe(true);
    });

    it("should categorize authentication errors correctly", () => {
      const authError = new Error("auth failed");
      const mcpError = ErrorUtils.toMCPError(authError);

      expect(mcpError).toBeInstanceOf(AuthenticationError);
      expect(mcpError.code).toBe(ErrorCode.AUTH_FAILED);
    });

    it("should categorize timeout errors correctly", () => {
      const timeoutError = new Error("Request timeout");
      const mcpError = ErrorUtils.toMCPError(timeoutError);

      expect(mcpError).toBeInstanceOf(ConnectionError);
      expect(mcpError.code).toBe(ErrorCode.CONNECTION_TIMEOUT);
    });

    it("should return MCPError unchanged", () => {
      const originalError = new ValidationError("Test error");
      const result = ErrorUtils.toMCPError(originalError);

      expect(result).toBe(originalError);
    });

    it("should get user-friendly messages", () => {
      const connectionError = new ConnectionError("Network error");
      const regularError = new Error("Some error");

      expect(ErrorUtils.getUserMessage(connectionError)).toBe(
        "Unable to connect to the server. Please try again later.",
      );
      expect(ErrorUtils.getUserMessage(regularError)).toBe(
        "An unexpected error occurred. Please try again.",
      );
    });

    it("should extract error codes correctly", () => {
      const mcpError = new EmailError("Test", ErrorCode.EMAIL_NOT_FOUND);
      const regularError = new Error("Test");

      expect(ErrorUtils.getErrorCode(mcpError)).toBe(ErrorCode.EMAIL_NOT_FOUND);
      expect(ErrorUtils.getErrorCode(regularError)).toBe(
        ErrorCode.INTERNAL_ERROR,
      );
    });
  });

  describe("Error Serialization", () => {
    it("should serialize errors to JSON correctly", () => {
      const error = new ConnectionError(
        "Test error",
        ErrorCode.CONNECTION_FAILED,
        {
          operation: "test",
          service: "TestService",
        },
      );

      const json = error.toJSON();

      expect(json.name).toBe("ConnectionError");
      expect(json.message).toBe("Test error");
      expect(json.code).toBe(ErrorCode.CONNECTION_FAILED);
      expect(json.isRetryable).toBe(true);
      expect(json.context.operation).toBe("test");
      expect(json.context.service).toBe("TestService");
      expect(json.timestamp).toBeDefined();
    });
  });
});
