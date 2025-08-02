import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  createDraftSchema,
  deleteEmailSchema,
  getCalendarEventsSchema,
  getEmailSchema,
  getFreeBusySchema,
  markEmailSchema,
  moveEmailSchema,
  safeValidateInput,
  sanitizeHtml,
  sanitizeString,
  searchCalendarSchema,
  searchEmailsSchema,
  sendEmailSchema,
  validateInput,
} from "../src/validation/schemas.js";

describe("Sanitization utilities", () => {
  describe("sanitizeString", () => {
    it("should trim whitespace", () => {
      expect(sanitizeString("  hello world  ")).toBe("hello world");
    });

    it("should remove control characters", () => {
      expect(sanitizeString("hello\x00\x1F\x7F\x9Fworld")).toBe("helloworld");
    });

    it("should handle empty string", () => {
      expect(sanitizeString("")).toBe("");
    });
  });

  describe("sanitizeHtml", () => {
    it("should remove script tags", () => {
      expect(sanitizeHtml("<script>alert('xss')</script><p>content</p>")).toBe(
        "<p>content</p>",
      );
    });

    it("should remove iframe tags", () => {
      expect(
        sanitizeHtml("<iframe src='evil.com'></iframe><p>content</p>"),
      ).toBe("<p>content</p>");
    });

    it("should remove event handlers", () => {
      expect(sanitizeHtml('<div onclick="alert()">content</div>')).toBe(
        "<div >content</div>",
      );
    });

    it("should remove javascript: urls", () => {
      expect(sanitizeHtml('<a href="javascript:alert()">link</a>')).toBe(
        '<a href="">link</a>',
      );
    });
  });
});

describe("Email validation schemas", () => {
  describe("searchEmailsSchema", () => {
    it("should validate valid search params", () => {
      const validInput = {
        query: "test search",
        folder: "INBOX",
        limit: 25,
        offset: 0,
      };

      const result = validateInput(searchEmailsSchema, validInput);
      expect(result.query).toBe("test search");
      expect(result.folder).toBe("INBOX");
      expect(result.limit).toBe(25);
      expect(result.offset).toBe(0);
    });

    it("should use defaults for optional fields", () => {
      const result = validateInput(searchEmailsSchema, {});
      expect(result.folder).toBe("INBOX");
      expect(result.limit).toBe(50);
      expect(result.offset).toBe(0);
    });

    it("should reject invalid limit", () => {
      expect(() => {
        validateInput(searchEmailsSchema, { limit: -1 });
      }).toThrow("Validation failed");
    });

    it("should reject query that's too long", () => {
      expect(() => {
        validateInput(searchEmailsSchema, { query: "a".repeat(501) });
      }).toThrow("Validation failed");
    });

    it("should sanitize query string", () => {
      const result = validateInput(searchEmailsSchema, {
        query: "  test\x00query  ",
      });
      expect(result.query).toBe("testquery");
    });
  });

  describe("getEmailSchema", () => {
    it("should validate valid get email params", () => {
      const result = validateInput(getEmailSchema, { uid: 123 });
      expect(result.uid).toBe(123);
      expect(result.folder).toBe("INBOX");
    });

    it("should reject negative UID", () => {
      expect(() => {
        validateInput(getEmailSchema, { uid: -1 });
      }).toThrow("Validation failed");
    });

    it("should reject non-integer UID", () => {
      expect(() => {
        validateInput(getEmailSchema, { uid: 1.5 });
      }).toThrow("Validation failed");
    });
  });

  describe("sendEmailSchema", () => {
    const validEmail = {
      to: [{ address: "test@example.com" }],
      subject: "Test Subject",
      text: "Test content",
    };

    it("should validate valid email", () => {
      const result = validateInput(sendEmailSchema, validEmail);
      expect(result.to[0].address).toBe("test@example.com");
      expect(result.subject).toBe("Test Subject");
      expect(result.text).toBe("Test content");
    });

    it("should require at least one recipient", () => {
      expect(() => {
        validateInput(sendEmailSchema, { ...validEmail, to: [] });
      }).toThrow("Validation failed");
    });

    it("should require either text or html content", () => {
      expect(() => {
        validateInput(sendEmailSchema, {
          to: [{ address: "test@example.com" }],
          subject: "Test",
        });
      }).toThrow("Validation failed");
    });

    it("should validate email addresses", () => {
      expect(() => {
        validateInput(sendEmailSchema, {
          ...validEmail,
          to: [{ address: "invalid-email" }],
        });
      }).toThrow("Validation failed");
    });

    it("should sanitize and normalize email addresses", () => {
      const result = validateInput(sendEmailSchema, {
        ...validEmail,
        to: [{ address: "  TEST@EXAMPLE.COM  " }],
      });
      expect(result.to[0].address).toBe("test@example.com");
    });

    it("should limit recipients", () => {
      const tooManyRecipients = Array(101).fill({
        address: "test@example.com",
      });
      expect(() => {
        validateInput(sendEmailSchema, {
          ...validEmail,
          to: tooManyRecipients,
        });
      }).toThrow("Validation failed");
    });

    it("should sanitize HTML content", () => {
      const result = validateInput(sendEmailSchema, {
        ...validEmail,
        html: '<script>alert("xss")</script><p>Hello</p>',
      });
      expect(result.html).toBe("<p>Hello</p>");
    });
  });

  describe("markEmailSchema", () => {
    it("should validate valid mark email params", () => {
      const result = validateInput(markEmailSchema, {
        uid: 123,
        flags: ["\\Seen"],
        action: "add",
      });
      expect(result.uid).toBe(123);
      expect(result.flags).toEqual(["\\Seen"]);
      expect(result.action).toBe("add");
    });

    it("should reject invalid action", () => {
      expect(() => {
        validateInput(markEmailSchema, {
          uid: 123,
          flags: ["\\Seen"],
          action: "invalid",
        });
      }).toThrow("Validation failed");
    });

    it("should require at least one flag", () => {
      expect(() => {
        validateInput(markEmailSchema, {
          uid: 123,
          flags: [],
          action: "add",
        });
      }).toThrow("Validation failed");
    });
  });
});

describe("Calendar validation schemas", () => {
  describe("getCalendarEventsSchema", () => {
    it("should validate valid calendar events params", () => {
      const result = validateInput(getCalendarEventsSchema, {
        start: "2024-01-01T00:00",
        end: "2024-01-31T23:59",
        limit: 100,
      });
      expect(result.start).toBe("2024-01-01T00:00");
      expect(result.end).toBe("2024-01-31T23:59");
      expect(result.limit).toBe(100);
    });

    it("should use defaults for optional fields", () => {
      const result = validateInput(getCalendarEventsSchema, {});
      expect(result.limit).toBe(100);
      expect(result.offset).toBe(0);
    });

    it("should reject end date before start date", () => {
      expect(() => {
        validateInput(getCalendarEventsSchema, {
          start: "2024-01-31T00:00",
          end: "2024-01-01T00:00",
        });
      }).toThrow("Validation failed");
    });

    it("should reject invalid date format", () => {
      expect(() => {
        validateInput(getCalendarEventsSchema, {
          start: "invalid-date",
        });
      }).toThrow("Validation failed");
    });
  });

  describe("searchCalendarSchema", () => {
    it("should validate valid search params", () => {
      const result = validateInput(searchCalendarSchema, {
        query: "meeting",
        start: "2024-01-01T00:00",
        end: "2024-12-31T23:59",
      });
      expect(result.query).toBe("meeting");
      expect(result.start).toBe("2024-01-01T00:00");
    });

    it("should require query", () => {
      expect(() => {
        validateInput(searchCalendarSchema, {});
      }).toThrow("Validation failed");
    });

    it("should reject empty query", () => {
      expect(() => {
        validateInput(searchCalendarSchema, { query: "" });
      }).toThrow("Validation failed");
    });

    it("should sanitize query", () => {
      const result = validateInput(searchCalendarSchema, {
        query: "  meeting\x00search  ",
      });
      expect(result.query).toBe("meetingsearch");
    });
  });

  describe("getFreeBusySchema", () => {
    it("should validate valid free/busy params", () => {
      const result = validateInput(getFreeBusySchema, {
        start: "2024-01-01T00:00",
        end: "2024-01-01T23:59",
      });
      expect(result.start).toBe("2024-01-01T00:00");
      expect(result.end).toBe("2024-01-01T23:59");
    });

    it("should require start and end dates", () => {
      expect(() => {
        validateInput(getFreeBusySchema, { start: "2024-01-01T00:00:00.000Z" });
      }).toThrow("Validation failed");
    });

    it("should reject end date before start date", () => {
      expect(() => {
        validateInput(getFreeBusySchema, {
          start: "2024-01-02T00:00",
          end: "2024-01-01T00:00",
        });
      }).toThrow("Validation failed");
    });
  });
});

describe("Validation utilities", () => {
  describe("validateInput", () => {
    it("should return validated data for valid input", () => {
      const schema = v.object({ name: v.string() });
      const result = validateInput(schema, { name: "test" });
      expect(result.name).toBe("test");
    });

    it("should throw error for invalid input", () => {
      const schema = v.object({ name: v.string() });
      expect(() => {
        validateInput(schema, { name: 123 });
      }).toThrow("Validation failed");
    });
  });

  describe("safeValidateInput", () => {
    it("should return success for valid input", () => {
      const schema = v.object({ name: v.string() });
      const result = safeValidateInput(schema, { name: "test" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.name).toBe("test");
      }
    });

    it("should return error for invalid input", () => {
      const schema = v.object({ name: v.string() });
      const result = safeValidateInput(schema, { name: 123 });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Validation failed");
      }
    });
  });
});

describe("Security validations", () => {
  it("should reject folder names with path traversal", () => {
    expect(() => {
      validateInput(moveEmailSchema, {
        uid: 1,
        fromFolder: "../etc/passwd",
        toFolder: "INBOX",
      });
    }).toThrow("Validation failed");
  });

  it("should reject excessively long subject lines", () => {
    expect(() => {
      validateInput(sendEmailSchema, {
        to: [{ address: "test@example.com" }],
        subject: "a".repeat(999),
        text: "content",
      });
    }).toThrow("Validation failed");
  });

  it("should limit content size", () => {
    expect(() => {
      validateInput(sendEmailSchema, {
        to: [{ address: "test@example.com" }],
        subject: "Test",
        text: "a".repeat(1000001),
      });
    }).toThrow("Validation failed");
  });

  it("should sanitize recipient names", () => {
    const result = validateInput(sendEmailSchema, {
      to: [
        {
          name: "  Test\x00Name  ",
          address: "test@example.com",
        },
      ],
      subject: "Test",
      text: "content",
    });
    expect(result.to[0].name).toBe("TestName");
  });
});
