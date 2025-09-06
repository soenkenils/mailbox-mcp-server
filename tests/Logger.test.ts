import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChildLogger,
  type LogContext,
  LogLevel,
  Logger,
  type LoggerConfig,
  PerformanceTimer,
} from "../src/services/Logger.js";

// Mock MCP server
const mockSendLoggingMessage = vi.fn();
const mockMcpServer = {
  sendLoggingMessage: mockSendLoggingMessage,
} as unknown as Server;

describe("Logger", () => {
  let logger: Logger;
  let mockConsoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    logger = new Logger();
  });

  afterEach(() => {
    mockConsoleError.mockRestore();
  });

  describe("MCP Compliance", () => {
    it("should write to stderr using console.error", () => {
      logger.info("Test message");
      expect(mockConsoleError).toHaveBeenCalled();
      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("[INFO]");
      expect(output).toContain("Test message");
    });

    it("should send MCP notifications when server is set", async () => {
      logger.setMcpServer(mockMcpServer);
      logger.info("Test notification", { operation: "test" }, { foo: "bar" });

      // Wait for async notification
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendLoggingMessage).toHaveBeenCalledWith({
        level: LogLevel.INFO,
        logger: undefined,
        data: expect.objectContaining({
          message: "Test notification",
          operation: "test",
          data: { foo: "bar" },
        }),
      });
    });

    it("should not send MCP notifications when server is not set", async () => {
      logger.info("Test without server");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendLoggingMessage).not.toHaveBeenCalled();
    });

    it("should handle MCP notification failures gracefully", async () => {
      mockSendLoggingMessage.mockRejectedValueOnce(new Error("MCP error"));
      logger.setMcpServer(mockMcpServer);

      logger.error("Test error message");

      // Wait for async notification to fail
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Should log the MCP failure to stderr
      const calls = mockConsoleError.mock.calls;
      expect(
        calls.some((call) =>
          call[0].includes("Failed to send MCP notification"),
        ),
      ).toBe(true);
    });
  });

  describe("Log Levels (RFC 5424)", () => {
    it("should support all RFC 5424 log levels", () => {
      const levels = [
        LogLevel.DEBUG,
        LogLevel.INFO,
        LogLevel.NOTICE,
        LogLevel.WARNING,
        LogLevel.ERROR,
        LogLevel.CRITICAL,
        LogLevel.ALERT,
        LogLevel.EMERGENCY,
      ];

      logger.setMinLevel(LogLevel.DEBUG);

      logger.debug("debug message");
      logger.info("info message");
      logger.notice("notice message");
      logger.warning("warning message");
      logger.error("error message");
      logger.critical("critical message");
      logger.alert("alert message");
      logger.emergency("emergency message");

      expect(mockConsoleError).toHaveBeenCalledTimes(8);

      const outputs = mockConsoleError.mock.calls.map((call) => call[0]);
      expect(outputs[0]).toContain("[DEBUG]");
      expect(outputs[1]).toContain("[INFO]");
      expect(outputs[2]).toContain("[NOTICE]");
      expect(outputs[3]).toContain("[WARNING]");
      expect(outputs[4]).toContain("[ERROR]");
      expect(outputs[5]).toContain("[CRITICAL]");
      expect(outputs[6]).toContain("[ALERT]");
      expect(outputs[7]).toContain("[EMERGENCY]");
    });

    it("should respect minimum log level", () => {
      logger.setMinLevel(LogLevel.WARNING);

      logger.debug("debug - should not log");
      logger.info("info - should not log");
      logger.notice("notice - should not log");
      logger.warning("warning - should log");
      logger.error("error - should log");

      expect(mockConsoleError).toHaveBeenCalledTimes(2);
      const outputs = mockConsoleError.mock.calls.map((call) => call[0]);
      expect(outputs[0]).toContain("warning - should log");
      expect(outputs[1]).toContain("error - should log");
    });
  });

  describe("Structured Logging", () => {
    it("should include context in log output", () => {
      const context: LogContext = {
        operation: "test_op",
        service: "test_service",
        requestId: "req-123",
        userId: "user-456",
        duration: 150,
      };

      logger.info("Test with context", context);

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("op=test_op");
      expect(output).toContain("svc=test_service");
      expect(output).toContain("dur=150ms");
      expect(output).toContain("req=req-123");
    });

    it("should include timestamp when configured", () => {
      const config: Partial<LoggerConfig> = {
        includeTimestamp: true,
      };
      logger = new Logger(config);

      logger.info("Test with timestamp");

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
    });

    it("should serialize data correctly", () => {
      logger.info(
        "Test with data",
        {},
        {
          string: "value",
          number: 42,
          boolean: true,
          null: null,
          undefined: undefined,
          date: new Date("2024-01-01"),
          array: [1, 2, 3],
          object: { key: "value" },
          error: new Error("test error"),
        },
      );

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("data=");
      expect(output).toContain("string: value");
      expect(output).toContain("number: 42");
      expect(output).toContain("boolean: true");
      expect(output).toContain("Error: test error");
    });

    it("should handle deep object serialization with max depth", () => {
      const deepObject = {
        level1: {
          level2: {
            level3: {
              level4: {
                level5: "too deep",
              },
            },
          },
        },
      };

      logger.info("Deep object", {}, { data: deepObject });

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("[max depth reached]");
    });

    it("should handle serialization errors gracefully", () => {
      // Create circular reference
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;

      // Override toJSON to throw
      circular.toJSON = () => {
        throw new Error("Serialization error");
      };

      expect(() =>
        logger.info("Circular ref", {}, { data: circular }),
      ).not.toThrow();
    });
  });

  describe("Child Logger", () => {
    it("should create child logger with logger name", () => {
      const child = logger.child("ChildService");
      child.info("Child message");

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("[ChildService]");
      expect(output).toContain("Child message");
    });

    it("should support all log levels in child logger", () => {
      const child = logger.child("TestChild");
      logger.setMinLevel(LogLevel.DEBUG);

      child.debug("debug");
      child.info("info");
      child.notice("notice");
      child.warning("warning");
      child.error("error");
      child.critical("critical");
      child.alert("alert");
      child.emergency("emergency");

      expect(mockConsoleError).toHaveBeenCalledTimes(8);
      const outputs = mockConsoleError.mock.calls.map((call) => call[0]);
      for (const output of outputs) {
        expect(output).toContain("[TestChild]");
      }
    });

    it("should inherit parent configuration", () => {
      logger.setMinLevel(LogLevel.ERROR);
      const child = logger.child("ChildLogger");

      child.info("should not log");
      child.error("should log");

      expect(mockConsoleError).toHaveBeenCalledTimes(1);
      expect(mockConsoleError.mock.calls[0][0]).toContain("should log");
    });
  });

  describe("Performance Monitoring", () => {
    it("should track performance metrics with timer", () => {
      const timer = logger.startTimer("test_operation");

      // Simulate operation
      const startTime = Date.now();
      while (Date.now() - startTime < 50); // Wait ~50ms

      const metrics = timer.end(true);

      expect(metrics.operation).toBe("test_operation");
      expect(metrics.success).toBe(true);
      expect(metrics.duration).toBeGreaterThanOrEqual(40); // Allow some variance
      expect(metrics.startTime).toBeInstanceOf(Date);
      expect(metrics.endTime).toBeInstanceOf(Date);
    });

    it("should record failed operations", () => {
      const timer = logger.startTimer("failing_op");
      const metrics = timer.end(false, "TestError");

      expect(metrics.success).toBe(false);
      expect(metrics.errorType).toBe("TestError");
    });

    it("should include metadata in performance metrics", () => {
      const timer = logger.startTimer("op_with_meta", {
        userId: "123",
        action: "test",
      });
      const metrics = timer.end(true);

      expect(metrics.metadata).toEqual({ userId: "123", action: "test" });
    });

    it("should log performance metrics", () => {
      const timer = logger.startTimer("logged_op");
      timer.end(true);

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("Performance: logged_op completed");
      expect(output).toContain("op=logged_op");
    });

    it("should get performance metrics summary", () => {
      // Record some metrics
      logger.startTimer("op1").end(true);
      logger.startTimer("op2").end(false, "Error");
      logger.startTimer("op3").end(true);

      const summary = logger.getPerformanceMetrics();

      expect(summary.total).toBe(3);
      expect(summary.successful).toBe(2);
      expect(summary.failed).toBe(1);
      expect(summary.averageDuration).toBeGreaterThanOrEqual(0);
      expect(summary.recentMetrics).toHaveLength(3);
    });

    it("should limit performance metrics history", () => {
      // Create more than max history (1000)
      for (let i = 0; i < 1010; i++) {
        logger.startTimer(`op${i}`).end(true);
      }

      const summary = logger.getPerformanceMetrics();
      expect(summary.total).toBe(1000); // Should cap at max history
    });
  });

  describe("Configuration", () => {
    it("should respect custom configuration", () => {
      const config: LoggerConfig = {
        minLevel: LogLevel.ERROR,
        enableStderr: false,
        enableMcpNotifications: false,
        includeTimestamp: false,
        includeContext: false,
        maxContextDepth: 1,
      };

      logger = new Logger(config);
      logger.info("should not output");

      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it("should allow disabling stderr output", () => {
      logger = new Logger({ enableStderr: false });
      logger.info("no stderr");

      expect(mockConsoleError).not.toHaveBeenCalled();
    });

    it("should allow disabling MCP notifications", async () => {
      logger = new Logger({ enableMcpNotifications: false });
      logger.setMcpServer(mockMcpServer);
      logger.info("no MCP");

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(mockSendLoggingMessage).not.toHaveBeenCalled();
    });
  });

  describe("Edge Cases", () => {
    it("should handle undefined and null values", () => {
      logger.info(
        "Test nullish",
        {},
        {
          undefined: undefined,
          null: null,
          empty: "",
          zero: 0,
          false: false,
        },
      );

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("undefined");
      expect(output).toContain("null");
      expect(output).toContain("0");
      expect(output).toContain("false");
    });

    it("should handle very large arrays", () => {
      const largeArray = new Array(100).fill("item");
      logger.info("Large array", {}, { array: largeArray });

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("[Array(100)]");
    });

    it("should handle objects with many keys", () => {
      const manyKeys: Record<string, number> = {};
      for (let i = 0; i < 20; i++) {
        manyKeys[`key${i}`] = i;
      }

      logger.info("Many keys", {}, { obj: manyKeys });

      const output = mockConsoleError.mock.calls[0][0];
      expect(output).toContain("{Object(20 keys)}");
    });

    it("should be thread-safe for synchronous logging", () => {
      // Test rapid successive logs
      for (let i = 0; i < 100; i++) {
        logger.info(`Message ${i}`);
      }

      expect(mockConsoleError).toHaveBeenCalledTimes(100);
    });
  });
});

describe("PerformanceTimer", () => {
  it("should be created through child logger", () => {
    const logger = new Logger();
    const child = logger.child("TestService");
    const timer = child.startTimer("operation");

    expect(timer).toBeInstanceOf(PerformanceTimer);

    const metrics = timer.end(true);
    expect(metrics.operation).toBe("operation");
  });
});
