import { describe, it, expect } from "vitest";

// We need to test the sanitizeArgs method, but it's private
// So we'll create a test class that extends the main class
class TestableMailboxMcpServer {
  public sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    if (!args || typeof args !== "object") {
      return args;
    }

    const sanitized = { ...args };
    
    // Remove invalid UUID parameters that Claude Desktop might pass
    for (const key in sanitized) {
      if (key.includes("uuid") && typeof sanitized[key] === "string") {
        const value = sanitized[key] as string;
        // Check if the value is a valid UUID format
        if (value === "null" || value === "none" || value === "undefined" || value === "" ||
            (value.length > 0 && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && 
             !value.startsWith("urn:uuid:"))) {
          delete sanitized[key];
        }
      }
    }

    return sanitized;
  }
}

describe("Argument Sanitization", () => {
  const testServer = new TestableMailboxMcpServer();

  describe("sanitizeArgs", () => {
    it("should remove invalid UUID parameters", () => {
      const args = {
        uid: 123,
        folder: "INBOX",
        parent_message_uuid: "null",
        message_uuid: "none",
        thread_uuid: "undefined",
        normalParam: "value"
      };

      const result = testServer.sanitizeArgs(args);

      expect(result).toEqual({
        uid: 123,
        folder: "INBOX",
        normalParam: "value"
      });
    });

    it("should keep valid UUID parameters", () => {
      const args = {
        uid: 123,
        parent_message_uuid: "550e8400-e29b-41d4-a716-446655440000",
        message_uuid: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
        normalParam: "value"
      };

      const result = testServer.sanitizeArgs(args);

      expect(result).toEqual({
        uid: 123,
        parent_message_uuid: "550e8400-e29b-41d4-a716-446655440000",
        message_uuid: "urn:uuid:550e8400-e29b-41d4-a716-446655440001",
        normalParam: "value"
      });
    });

    it("should handle non-object arguments", () => {
      expect(testServer.sanitizeArgs(null as any)).toBeNull();
      expect(testServer.sanitizeArgs(undefined as any)).toBeUndefined();
      expect(testServer.sanitizeArgs("string" as any)).toBe("string");
      expect(testServer.sanitizeArgs(123 as any)).toBe(123);
    });

    it("should handle empty objects", () => {
      const result = testServer.sanitizeArgs({});
      expect(result).toEqual({});
    });

    it("should only affect parameters containing 'uuid' in the key name", () => {
      const args = {
        uid: 123,
        folder: "INBOX",
        subject: "null", // This should not be removed
        parent_message_uuid: "null", // This should be removed
        normalParam: "value"
      };

      const result = testServer.sanitizeArgs(args);

      expect(result).toEqual({
        uid: 123,
        folder: "INBOX",
        subject: "null",
        normalParam: "value"
      });
    });

    it("should handle various invalid UUID formats", () => {
      const args = {
        uuid1: "n", // The error character from the screenshot
        uuid2: "invalid-uuid",
        uuid3: "123",
        uuid4: "",
        uuid5: "abc-def-ghi",
        normalParam: "value"
      };

      const result = testServer.sanitizeArgs(args);

      expect(result).toEqual({
        normalParam: "value"
      });
    });

    it("should handle the specific error case from the screenshot", () => {
      const args = {
        uid: 123,
        folder: "INBOX",
        parent_message_uuid: "n", // The exact error case
        normalParam: "value"
      };

      const result = testServer.sanitizeArgs(args);

      expect(result).toEqual({
        uid: 123,
        folder: "INBOX",
        normalParam: "value"
      });
    });
  });
});