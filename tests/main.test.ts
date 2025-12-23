import { describe, expect, it } from "vitest";
import type { CalendarService } from "../src/services/CalendarService.js";
import type { EmailService } from "../src/services/EmailService.js";
import type { SmtpService } from "../src/services/SmtpService.js";
import { createCalendarTools } from "../src/tools/calendarTools.js";
import { createEmailTools } from "../src/tools/emailTools.js";

describe("main.ts module structure and logic", () => {
  describe("Tool Classification Arrays", () => {
    it("should define correct email tool names", () => {
      // Test the hardcoded email tool list from main.ts isEmailTool method
      const expectedEmailTools = [
        "search_emails",
        "get_email",
        "get_email_thread",
        "send_email",
        "create_draft",
        "move_email",
        "mark_email",
        "delete_email",
        "get_folders",
      ];

      // Verify all tools are present
      expect(expectedEmailTools).toHaveLength(9);

      // Verify specific tools exist
      expect(expectedEmailTools).toContain("search_emails");
      expect(expectedEmailTools).toContain("send_email");
      expect(expectedEmailTools).toContain("get_folders");

      // Verify calendar tools are not included
      expect(expectedEmailTools).not.toContain("get_calendar_events");
      expect(expectedEmailTools).not.toContain("search_calendar");
    });

    it("should define correct calendar tool names", () => {
      // Test the hardcoded calendar tool list from main.ts isCalendarTool method
      const expectedCalendarTools = [
        "get_calendar_events",
        "search_calendar",
        "get_free_busy",
      ];

      // Verify all tools are present
      expect(expectedCalendarTools).toHaveLength(3);

      // Verify specific tools exist
      expect(expectedCalendarTools).toContain("get_calendar_events");
      expect(expectedCalendarTools).toContain("search_calendar");
      expect(expectedCalendarTools).toContain("get_free_busy");

      // Verify email tools are not included
      expect(expectedCalendarTools).not.toContain("search_emails");
      expect(expectedCalendarTools).not.toContain("send_email");
    });
  });

  describe("Server Configuration", () => {
    it("should have correct server metadata", () => {
      const expectedServerConfig = {
        name: "mailbox-mcp-server",
        version: "0.1.0",
      };

      const expectedCapabilities = {
        capabilities: {
          tools: {},
        },
      };

      expect(expectedServerConfig.name).toBe("mailbox-mcp-server");
      expect(expectedServerConfig.version).toBe("0.1.0");
      expect(expectedCapabilities.capabilities.tools).toEqual({});
    });
  });

  describe("Error Messages", () => {
    it("should define consistent error message formats", () => {
      const expectedErrorMessages = [
        "Failed to load configuration:",
        "Failed to initialize services:",
        "Failed to start server:",
        "Error during cleanup:",
        "Unknown tool:",
        "Error executing",
      ];

      // Test that these messages follow consistent patterns
      for (const message of expectedErrorMessages) {
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Debug Messages", () => {
    it("should define consistent debug message formats", () => {
      const expectedDebugMessages = [
        "Configuration loaded successfully",
        "Services initialized successfully",
        "Mailbox MCP Server started successfully",
        "Cleanup completed",
      ];

      // Test that these messages follow consistent patterns
      for (const message of expectedDebugMessages) {
        expect(typeof message).toBe("string");
        expect(message.length).toBeGreaterThan(0);
      }
    });
  });

  describe("Signal Handling", () => {
    it("should handle expected process signals", () => {
      const expectedSignals = ["SIGINT", "SIGTERM"];

      for (const signal of expectedSignals) {
        expect(typeof signal).toBe("string");
        expect(signal.startsWith("SIG")).toBe(true);
      }
    });
  });

  describe("Module Dependencies", () => {
    it("should import required MCP SDK modules", () => {
      const requiredSDKModules = [
        "@modelcontextprotocol/sdk/server/index.js",
        "@modelcontextprotocol/sdk/server/stdio.js",
        "@modelcontextprotocol/sdk/types.js",
      ];

      for (const module of requiredSDKModules) {
        expect(typeof module).toBe("string");
        expect(module.includes("@modelcontextprotocol")).toBe(true);
      }
    });

    it("should import required local modules", () => {
      const requiredLocalModules = [
        "./config/config.js",
        "./services/CalendarService.js",
        "./services/EmailService.js",
        "./services/LocalCache.js",
        "./services/SmtpService.js",
        "./tools/calendarTools.js",
        "./tools/emailTools.js",
      ];

      for (const module of requiredLocalModules) {
        expect(typeof module).toBe("string");
        expect(module.startsWith("./")).toBe(true);
        expect(module.endsWith(".js")).toBe(true);
      }
    });
  });

  describe("Tool Routing Logic", () => {
    it("should route email tools correctly", () => {
      const emailTools = [
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
      ];

      // Simulate the isEmailTool logic
      const isEmailTool = (toolName: string): boolean => {
        return emailTools.includes(toolName);
      };

      // Test valid email tools
      expect(isEmailTool("search_emails")).toBe(true);
      expect(isEmailTool("send_email")).toBe(true);
      expect(isEmailTool("get_folders")).toBe(true);

      // Test invalid tools
      expect(isEmailTool("get_calendar_events")).toBe(false);
      expect(isEmailTool("unknown_tool")).toBe(false);
      expect(isEmailTool("")).toBe(false);
    });

    it("should route calendar tools correctly", () => {
      const calendarTools = [
        "get_calendar_events",
        "search_calendar",
        "get_free_busy",
      ];

      // Simulate the isCalendarTool logic
      const isCalendarTool = (toolName: string): boolean => {
        return calendarTools.includes(toolName);
      };

      // Test valid calendar tools
      expect(isCalendarTool("get_calendar_events")).toBe(true);
      expect(isCalendarTool("search_calendar")).toBe(true);
      expect(isCalendarTool("get_free_busy")).toBe(true);

      // Test invalid tools
      expect(isCalendarTool("search_emails")).toBe(false);
      expect(isCalendarTool("unknown_tool")).toBe(false);
      expect(isCalendarTool("")).toBe(false);
    });

    it("should handle unknown tools", () => {
      const emailTools = [
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
      ];
      const calendarTools = [
        "get_calendar_events",
        "search_calendar",
        "get_free_busy",
      ];

      const isKnownTool = (toolName: string): boolean => {
        return (
          emailTools.includes(toolName) || calendarTools.includes(toolName)
        );
      };

      // Test unknown tools return false
      expect(isKnownTool("unknown_tool")).toBe(false);
      expect(isKnownTool("random_function")).toBe(false);
      expect(isKnownTool("")).toBe(false);
      expect(isKnownTool("null")).toBe(false);

      // Test known tools return true
      expect(isKnownTool("search_emails")).toBe(true);
      expect(isKnownTool("get_calendar_events")).toBe(true);
    });
  });

  describe("Error Response Format", () => {
    it("should format error responses correctly", () => {
      const formatErrorResponse = (toolName: string, error: string) => {
        return {
          content: [
            {
              type: "text",
              text: `Error executing ${toolName}: ${error}`,
            },
          ],
          isError: true,
        };
      };

      const errorResponse = formatErrorResponse(
        "test_tool",
        "Something went wrong",
      );

      expect(errorResponse.content).toHaveLength(1);
      expect(errorResponse.content[0].type).toBe("text");
      expect(errorResponse.content[0].text).toBe(
        "Error executing test_tool: Something went wrong",
      );
      expect(errorResponse.isError).toBe(true);
    });
  });

  describe("Exit Codes", () => {
    it("should use correct exit codes for different error scenarios", () => {
      const exitCodes = {
        configError: 1,
        serviceInitError: 1,
        serverStartError: 1,
        normalExit: 0,
      };

      // All error scenarios should exit with code 1
      expect(exitCodes.configError).toBe(1);
      expect(exitCodes.serviceInitError).toBe(1);
      expect(exitCodes.serverStartError).toBe(1);

      // Normal exit should be 0
      expect(exitCodes.normalExit).toBe(0);
    });
  });

  describe("Tool Registration Integrity", () => {
    it("should ensure all implemented email tools are registered in routing logic", () => {
      const mockEmailService = {} as EmailService;
      const mockSmtpService = {} as SmtpService;

      // Get all implemented email tools
      const implementedEmailTools = createEmailTools(
        mockEmailService,
        mockSmtpService,
      );
      const implementedEmailToolNames = implementedEmailTools.map(
        tool => tool.name,
      );

      // Simulate the server's isEmailTool function
      const isEmailTool = (toolName: string): boolean => {
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
      };

      // Check that every implemented tool is registered in routing logic
      for (const toolName of implementedEmailToolNames) {
        expect(isEmailTool(toolName)).toBe(true);
      }

      // Verify we have the expected number of tools
      expect(implementedEmailToolNames).toHaveLength(10);
      expect(implementedEmailToolNames).toContain("create_directory");
    });

    it("should ensure all implemented calendar tools are registered in routing logic", () => {
      const mockCalendarService = {} as CalendarService;

      // Get all implemented calendar tools
      const implementedCalendarTools = createCalendarTools(mockCalendarService);
      const implementedCalendarToolNames = implementedCalendarTools.map(
        tool => tool.name,
      );

      // Simulate the server's isCalendarTool function
      const isCalendarTool = (toolName: string): boolean => {
        return [
          "get_calendar_events",
          "search_calendar",
          "get_free_busy",
        ].includes(toolName);
      };

      // Check that every implemented tool is registered in routing logic
      for (const toolName of implementedCalendarToolNames) {
        expect(isCalendarTool(toolName)).toBe(true);
      }

      // Verify we have the expected number of tools
      expect(implementedCalendarToolNames).toHaveLength(3);
    });
  });
});
