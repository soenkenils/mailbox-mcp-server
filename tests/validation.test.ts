import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  createCalendarEventSchema,
  createDirectorySchema,
  createDraftSchema,
  deleteEmailSchema,
  getCalendarEventsSchema,
  getEmailSchema,
  getFreeBusySchema,
  markEmailSchema,
  moveEmailSchema,
  safeValidateInput,
  sanitizeHtml,
  sanitizeMultilineString,
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

    it("should cap the page size at the advertised maximum", () => {
      expect(validateInput(searchEmailsSchema, { limit: 200 }).limit).toBe(200);
      expect(() => {
        validateInput(searchEmailsSchema, { limit: 201 });
      }).toThrow("Limit cannot exceed 200");
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

    it("should validate boolean flag filters", () => {
      const result = validateInput(searchEmailsSchema, {
        seen: false,
        answered: true,
        flagged: true,
        draft: false,
        deleted: false,
      });
      expect(result.seen).toBe(false);
      expect(result.answered).toBe(true);
      expect(result.flagged).toBe(true);
      expect(result.draft).toBe(false);
      expect(result.deleted).toBe(false);
    });

    it("should leave flag filters undefined when not provided", () => {
      const result = validateInput(searchEmailsSchema, {});
      expect(result.seen).toBeUndefined();
      expect(result.answered).toBeUndefined();
      expect(result.flagged).toBeUndefined();
      expect(result.draft).toBeUndefined();
      expect(result.deleted).toBeUndefined();
    });

    it("should reject non-boolean flag values", () => {
      expect(() => {
        validateInput(searchEmailsSchema, { seen: "true" });
      }).toThrow("Validation failed");
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

    it("should keep line breaks and tabs in the text body", () => {
      const result = validateInput(sendEmailSchema, {
        ...validEmail,
        text: "Hallo,\r\n\r\nzweiter Absatz.\n\tEingerückt\rGrüße",
      });
      expect(result.text).toBe(
        "Hallo,\n\nzweiter Absatz.\n\tEingerückt\nGrüße",
      );
    });

    it("should keep line breaks in a draft body", () => {
      const result = validateInput(createDraftSchema, {
        ...validEmail,
        text: "Zeile 1\nZeile 2",
      });
      expect(result.text).toBe("Zeile 1\nZeile 2");
    });

    it("should still strip line breaks from the subject and names", () => {
      const result = validateInput(sendEmailSchema, {
        ...validEmail,
        to: [{ name: "Eve\r\nBcc: x@evil.com", address: "test@example.com" }],
        subject: "Hi\r\nBcc: victim@example.com",
      });
      expect(result.subject).toBe("HiBcc: victim@example.com");
      expect(result.to[0].name).toBe("EveBcc: x@evil.com");
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

    it.each([
      "\\Recent",
      "\\recent",
      "\\RECENT",
    ])("should reject %s, which only the server may set", flag => {
      expect(() =>
        validateInput(markEmailSchema, {
          uid: 1,
          flags: [flag],
          action: "add",
        }),
      ).toThrow(/RFC 3501/);
    });

    it("should still accept a server keyword outside the advertised enum", () => {
      const result = validateInput(markEmailSchema, {
        uid: 1,
        flags: ["\\Junk"],
        action: "add",
      });

      expect(result.flags).toEqual(["\\Junk"]);
    });

    it("should reject a flag without the backslash prefix", () => {
      expect(() =>
        validateInput(markEmailSchema, {
          uid: 1,
          flags: ["Seen"],
          action: "add",
        }),
      ).toThrow("Invalid email flag format");
    });
  });
});

describe("Calendar validation schemas", () => {
  describe("createDirectorySchema", () => {
    const parse = (input: unknown) =>
      safeValidateInput(createDirectorySchema, input);

    it("accepts a name without a parent, or with an empty one", () => {
      expect(parse({ name: "Projects" }).success).toBe(true);
      expect(parse({ name: "Projects", parentPath: "" }).success).toBe(true);
    });

    it("accepts a nested parent path", () => {
      const result = parse({ name: "x", parentPath: "INBOX/2025" });
      expect(result.success).toBe(true);
    });

    it("keeps accepting '/' in the name for nested creation", () => {
      expect(parse({ name: "Archive/2025" }).success).toBe(true);
    });

    it.each([
      ["a trailing delimiter", "INBOX/"],
      ["a leading delimiter", "/INBOX"],
      ["an empty segment", "INBOX//x"],
      ["a '..' segment", "../.."],
      ["a '.' segment", "INBOX/."],
      ["forbidden characters", "INBOX*"],
    ])("rejects a parent path with %s", (_label, parentPath) => {
      expect(parse({ name: "x", parentPath }).success).toBe(false);
    });
  });

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

describe("Folder path validation", () => {
  it("should accept IMAP subfolder paths with '/' delimiter", () => {
    const result = validateInput(getEmailSchema, {
      uid: 1,
      folder: "INBOX/Recruiter-Spam",
    });
    expect(result.folder).toBe("INBOX/Recruiter-Spam");
  });

  it.each([
    "/INBOX",
    "INBOX/",
    "INBOX//Sub",
    "INBOX/../Spam",
    "./INBOX",
  ])("should reject malformed folder path %s", folder => {
    expect(() => validateInput(getEmailSchema, { uid: 1, folder })).toThrow(
      "Validation failed",
    );
  });
});

describe("Folder path sanitizing order", () => {
  it("rejects a path that only becomes malformed after stripping control characters", () => {
    expect(() =>
      validateInput(getEmailSchema, { uid: 1, folder: "INBOX/\u0001" }),
    ).toThrow("Validation failed");
  });
});

describe("createCalendarEventSchema", () => {
  const valid = {
    summary: "Meeting",
    start: "2026-11-10T10:00:00Z",
    end: "2026-11-10T11:00:00Z",
  };

  it("should accept a minimal event and default allDay to false", () => {
    const result = validateInput(createCalendarEventSchema, valid);
    expect(result.allDay).toBe(false);
  });

  it("should keep line breaks in an event description", () => {
    const result = validateInput(createCalendarEventSchema, {
      ...valid,
      description: "Agenda:\r\n- Punkt 1\n- Punkt 2\tdone\u0007",
    });
    expect(result.description).toBe("Agenda:\n- Punkt 1\n- Punkt 2\tdone");
  });

  it("should turn line breaks in single-line fields into a space", () => {
    const result = validateInput(createCalendarEventSchema, {
      ...valid,
      summary: "Meeting\r\nX-INJECTED:1",
      location: "Room\n1",
      attendees: [{ email: "a@example.com", name: "Al\nice" }],
    });
    expect(result.summary).toBe("Meeting X-INJECTED:1");
    expect(result.location).toBe("Room 1");
    expect(result.attendees?.[0].name).toBe("Al ice");
  });

  it("should reject the same attendee twice, whatever the case", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        ...valid,
        attendees: [{ email: "a@example.com" }, { email: "A@Example.com" }],
      }),
    ).toThrow("Each attendee may only be listed once");
  });

  it("should reject unknown attendee fields", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        ...valid,
        attendees: [{ email: "a@example.com", role: "CHAIR" }],
      }),
    ).toThrow();
  });

  it("should cap the number of attendees", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        ...valid,
        attendees: Array.from({ length: 51 }, (_, i) => ({
          email: `a${i}@example.com`,
        })),
      }),
    ).toThrow("Too many attendees");
  });

  it("should reject an empty summary", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, { ...valid, summary: "  " }),
    ).toThrow("Summary cannot be empty");
  });

  it("should reject an invalid attendee email", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        ...valid,
        attendees: [{ email: "not-an-email" }],
      }),
    ).toThrow("Invalid email format");
  });

  it("should reject a timed event that does not end after it starts", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, { ...valid, end: valid.start }),
    ).toThrow("Start date must be before end date");
  });

  it("should accept an all-day event that ends on its start date", () => {
    const result = validateInput(createCalendarEventSchema, {
      summary: "Holiday",
      start: "2026-12-24",
      end: "2026-12-24",
      allDay: true,
    });
    expect(result.allDay).toBe(true);
  });

  it("should reject an all-day event whose last day is before its first", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        summary: "Holiday",
        start: "2026-12-24",
        end: "2026-12-23",
        allDay: true,
      }),
    ).toThrow("The last day must not be before the first day");
  });

  it("should accept an all-day event without an end", () => {
    const result = validateInput(createCalendarEventSchema, {
      summary: "Holiday",
      start: "2026-12-24",
      allDay: true,
    });
    expect(result.end).toBeUndefined();
  });

  it.each([
    "2025-02-30",
    "2025-02-29",
    "2025-13-01",
    "2025-04-31T10:00:00Z",
    "2025-06-20T24:00:00Z",
    "2025-06-20T10:60:00Z",
    "2025-06-20T10:00:60Z",
    "2025-06-20T10:00:00+25:00",
  ])("should reject the impossible date or time %s", value => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        summary: "Event",
        start: value,
        end: value.length === 10 ? value : "2025-12-31T23:00:00Z",
        allDay: value.length === 10,
      }),
    ).toThrow(/is not a real date/);
  });

  it("should accept a leap day", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        summary: "Leap",
        start: "2028-02-29",
        allDay: true,
      }),
    ).not.toThrow();
  });

  it("should ask for a date-time when a timed event gets a bare date", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        summary: "Call",
        start: "2025-06-20",
        end: "2025-06-20T11:00:00Z",
      }),
    ).toThrow(/Timed events need a date-time/);
  });

  it("should require an end for a timed event", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        summary: "Call",
        start: "2025-06-20T10:00:00Z",
      }),
    ).toThrow(/end is required/);
  });
});

describe("sanitizeMultilineString", () => {
  it("should normalise line endings and drop other control characters", () => {
    expect(sanitizeMultilineString(" a\r\nb\rc\u0000\td ")).toBe("a\nb\nc\td");
  });
});
