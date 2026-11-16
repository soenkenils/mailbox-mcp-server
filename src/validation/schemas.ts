import * as v from "valibot";

// =============================================================================
// SANITIZATION UTILITIES
// =============================================================================

export const sanitizeString = (str: string): string => {
  // Remove control characters (0-31, 127-159) without using regex ranges
  return str
    .trim()
    .split("")
    .filter(char => {
      const code = char.charCodeAt(0);
      return (
        !(code >= 0 && code <= 31) &&
        code !== 127 &&
        !(code >= 128 && code <= 159)
      );
    })
    .join("");
};

/**
 * For free text such as event descriptions, where line breaks and tabs are
 * content. Line endings are normalised to LF; the iCalendar layer produces
 * the escapes its format requires. Every other control character is removed.
 */
export const sanitizeMultilineString = (str: string): string =>
  str
    .trim()
    .replace(/\r\n?/g, "\n")
    .split("")
    .filter(char => {
      const code = char.charCodeAt(0);
      return (
        code === 10 ||
        code === 9 ||
        !(
          (code >= 0 && code <= 31) ||
          code === 127 ||
          (code >= 128 && code <= 159)
        )
      );
    })
    .join("");

/**
 * For single-line event fields (summary, location, names), where a line
 * break would otherwise glue two words together: every run of control
 * characters, line breaks included, becomes one space.
 */
export const sanitizeLine = (str: string): string => {
  let result = "";
  let inControlRun = false;
  for (const char of str) {
    const code = char.charCodeAt(0);
    const isControl =
      (code >= 0 && code <= 31) || code === 127 || (code >= 128 && code <= 159);
    if (isControl) {
      if (!inControlRun) {
        result += " ";
      }
      inControlRun = true;
    } else {
      result += char;
      inControlRun = false;
    }
  }
  return result.trim();
};

export const sanitizeHtml = (html: string): string => {
  // Basic HTML sanitization - remove dangerous tags and attributes
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "")
    .replace(/on\w+="[^"]*"/gi, "") // Remove event handlers
    .replace(/href="javascript:[^"]*"/gi, 'href=""') // Remove javascript: URLs
    .replace(/javascript:/gi, "");
};

// =============================================================================
// BASE VALIDATION SCHEMAS
// =============================================================================

// Email address validation with proper RFC 5322 compliance
const emailSchema = v.pipe(
  v.string("Email must be a string"),
  v.trim(),
  v.email("Invalid email format"),
  v.maxLength(254, "Email address too long"),
  v.transform(sanitizeString),
  v.transform(email => email.toLowerCase()),
);

// Folder name validation.
// "/" is the IMAP hierarchy delimiter on mailbox.org (e.g. "INBOX/Archiv"),
// so it must be allowed. Path-traversal-like forms are still rejected:
// "." / ".." segments, empty segments, leading or trailing delimiters.
const folderNameSchema = v.pipe(
  v.string("Folder name must be a string"),
  // Sanitize first so the checks below see the final value
  v.transform(sanitizeString),
  v.minLength(1, "Folder name cannot be empty"),
  v.maxLength(255, "Folder name too long"),
  v.check(str => !/[\\<>:"|?*]/.test(str), "Invalid folder name characters"),
  v.check(
    str =>
      !str.startsWith("/") &&
      !str.endsWith("/") &&
      str
        .split("/")
        .every(segment => segment !== "" && !/^\.{1,2}$/.test(segment)),
    "Invalid folder path",
  ),
);

// Subject line validation
const subjectSchema = v.pipe(
  v.string("Subject must be a string"),
  v.maxLength(998, "Subject line too long"), // RFC 5322 limit
  v.transform(sanitizeString),
);

// Text content validation
const textContentSchema = v.pipe(
  v.string("Text content must be a string"),
  v.maxLength(1000000, "Text content too long"), // 1MB limit
  v.transform(sanitizeString),
);

// HTML content validation
const htmlContentSchema = v.pipe(
  v.string("HTML content must be a string"),
  v.maxLength(1000000, "HTML content too long"), // 1MB limit
  v.transform(sanitizeHtml),
);

// Date validation - flexible ISO 8601 format support
const dateSchema = v.pipe(
  v.string("Date must be a string"),
  v.trim(),
  v.check(value => {
    // Support multiple ISO 8601 formats:
    // - YYYY-MM-DD
    // - YYYY-MM-DDTHH:mm
    // - YYYY-MM-DDTHH:mm:ss
    // - YYYY-MM-DDTHH:mm:ss.sss
    // - With timezone: Z or ±HH:mm
    const isoDateRegex =
      /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{3})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
    return isoDateRegex.test(value);
  }, "Invalid date format - must be ISO 8601 (YYYY-MM-DD, YYYY-MM-DDTHH:mm, YYYY-MM-DDTHH:mm:ss, etc.)"),
  v.check(value => {
    // Validate that the date is actually parseable and valid
    const date = new Date(value);
    return !Number.isNaN(date.getTime());
  }, "Invalid date - unable to parse"),
);

// Pagination schemas
const limitSchema = v.pipe(
  v.number("Limit must be a number"),
  v.integer("Limit must be an integer"),
  v.minValue(1, "Limit must be at least 1"),
  v.maxValue(1000, "Limit cannot exceed 1000"),
);

const offsetSchema = v.pipe(
  v.number("Offset must be a number"),
  v.integer("Offset must be an integer"),
  v.minValue(0, "Offset cannot be negative"),
);

// UID validation
const uidSchema = v.pipe(
  v.number("UID must be a number"),
  v.integer("UID must be an integer"),
  v.minValue(1, "UID must be positive"),
);

// Email recipient schema
const recipientSchema = v.object({
  name: v.optional(
    v.pipe(
      v.string("Name must be a string"),
      v.maxLength(255, "Name too long"),
      v.transform(sanitizeString),
    ),
  ),
  address: emailSchema,
});

// Email flag validation
const emailFlagSchema = v.union([
  v.pipe(
    v.string("Flag must be a string"),
    v.regex(/^\\[A-Za-z]+$/, "Invalid email flag format"),
  ),
  v.picklist([
    "\\Seen",
    "\\Answered",
    "\\Flagged",
    "\\Deleted",
    "\\Draft",
    "\\Recent",
  ]),
]);

// Calendar query validation
const calendarQuerySchema = v.pipe(
  v.string("Search query must be a string"),
  v.trim(),
  v.minLength(1, "Search query cannot be empty"),
  v.maxLength(500, "Search query too long"),
  v.transform(sanitizeString),
);

// Calendar name validation
const calendarNameSchema = v.pipe(
  v.string("Calendar name must be a string"),
  v.trim(),
  v.minLength(1, "Calendar name cannot be empty"),
  v.maxLength(255, "Calendar name too long"),
  v.transform(sanitizeString),
);

// Event fields for create_calendar_event
const eventAttendeeSchema = v.strictObject({
  email: emailSchema,
  name: v.optional(
    v.pipe(
      v.string("Name must be a string"),
      v.maxLength(255, "Name too long"),
      v.transform(sanitizeLine),
    ),
  ),
});

const eventSummarySchema = v.pipe(
  v.string("Summary must be a string"),
  v.transform(sanitizeLine),
  v.minLength(1, "Summary cannot be empty"),
  v.maxLength(500, "Summary too long"),
);

const eventDescriptionSchema = v.pipe(
  v.string("Description must be a string"),
  v.maxLength(10000, "Description too long"),
  v.transform(sanitizeMultilineString),
);

const eventLocationSchema = v.pipe(
  v.string("Location must be a string"),
  v.maxLength(500, "Location too long"),
  v.transform(sanitizeLine),
);

const ISO_PARTS =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{3})?)?(Z|[+-](\d{2}):(\d{2}))?)?$/;

/**
 * Whether every component names something that exists: new Date() rolls
 * "2025-02-30" over into March instead of rejecting it.
 */
const isRealDateTime = (value: string): boolean => {
  const parts = ISO_PARTS.exec(value);
  if (!parts) {
    return false;
  }
  const [, year, month, day, hour, minute, second, , offsetH, offsetM] =
    parts.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const realDay =
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
  const realTime =
    parts[4] === undefined ||
    (hour < 24 && minute < 60 && (parts[6] === undefined || second < 60));
  const realOffset = parts[8] === undefined || (offsetH < 24 && offsetM < 60);
  return realDay && realTime && realOffset;
};

/**
 * A date-time without an offset is read in the server's local time zone,
 * where a time skipped by a daylight-saving change does not exist. new
 * Date() would silently move it by an hour.
 */
const existsAsLocalTime = (value: string): boolean => {
  const parts = ISO_PARTS.exec(value);
  if (!parts || parts[4] === undefined || parts[7] !== undefined) {
    return true;
  }
  const [, year, month, day, hour, minute] = parts.map(Number);
  const local = new Date(value);
  return (
    local.getFullYear() === year &&
    local.getMonth() === month - 1 &&
    local.getDate() === day &&
    local.getHours() === hour &&
    local.getMinutes() === minute
  );
};

const localTimeZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone;

const eventDateSchema = v.pipe(
  dateSchema,
  v.check(
    isRealDateTime,
    issue => `"${issue.input}" is not a real date or time`,
  ),
  v.check(
    existsAsLocalTime,
    issue =>
      `Local time "${issue.input}" does not exist in the server's time zone (${localTimeZone()}), e.g. it falls in a daylight-saving gap; pass an explicit offset such as +01:00 or Z`,
  ),
);

const hasTime = (value: string): boolean => value.includes("T");

const eventAttendeesSchema = v.pipe(
  v.array(eventAttendeeSchema, "Attendees must be an array"),
  v.maxLength(50, "Too many attendees"),
  v.check(
    attendees =>
      new Set(attendees.map(attendee => attendee.email)).size ===
      attendees.length,
    "Each attendee may only be listed once",
  ),
);

// =============================================================================
// EMAIL TOOL SCHEMAS
// =============================================================================

export const searchEmailsSchema = v.object({
  query: v.optional(
    v.pipe(
      v.string("Search query must be a string"),
      v.maxLength(500, "Search query too long"),
      v.transform(sanitizeString),
    ),
  ),
  folder: v.optional(folderNameSchema, "INBOX"),
  since: v.optional(dateSchema),
  before: v.optional(dateSchema),
  limit: v.optional(limitSchema, 50),
  offset: v.optional(offsetSchema, 0),
  seen: v.optional(v.boolean("seen must be a boolean")),
  answered: v.optional(v.boolean("answered must be a boolean")),
  flagged: v.optional(v.boolean("flagged must be a boolean")),
  draft: v.optional(v.boolean("draft must be a boolean")),
  deleted: v.optional(v.boolean("deleted must be a boolean")),
});

export const getEmailSchema = v.object({
  uid: uidSchema,
  folder: v.optional(folderNameSchema, "INBOX"),
});

export const getEmailThreadSchema = v.object({
  messageId: v.pipe(
    v.string("Message ID must be a string"),
    v.trim(),
    v.minLength(1, "Message ID cannot be empty"),
    v.maxLength(255, "Message ID too long"),
    v.transform(sanitizeString),
  ),
  folder: v.optional(folderNameSchema, "INBOX"),
});

export const sendEmailSchema = v.pipe(
  v.object({
    to: v.pipe(
      v.array(recipientSchema, "Recipients must be an array"),
      v.minLength(1, "At least one recipient is required"),
      v.maxLength(100, "Too many recipients"),
    ),
    cc: v.optional(
      v.pipe(
        v.array(recipientSchema, "CC recipients must be an array"),
        v.maxLength(100, "Too many CC recipients"),
      ),
    ),
    bcc: v.optional(
      v.pipe(
        v.array(recipientSchema, "BCC recipients must be an array"),
        v.maxLength(100, "Too many BCC recipients"),
      ),
    ),
    subject: subjectSchema,
    text: v.optional(textContentSchema),
    html: v.optional(htmlContentSchema),
  }),
  v.check(
    data => !!(data.text || data.html),
    "Either text or HTML content is required",
  ),
);

export const createDraftSchema = v.object({
  to: v.pipe(
    v.array(recipientSchema, "Recipients must be an array"),
    v.minLength(1, "At least one recipient is required"),
    v.maxLength(100, "Too many recipients"),
  ),
  cc: v.optional(
    v.pipe(
      v.array(recipientSchema, "CC recipients must be an array"),
      v.maxLength(100, "Too many CC recipients"),
    ),
  ),
  bcc: v.optional(
    v.pipe(
      v.array(recipientSchema, "BCC recipients must be an array"),
      v.maxLength(100, "Too many BCC recipients"),
    ),
  ),
  subject: subjectSchema,
  text: v.optional(textContentSchema),
  html: v.optional(htmlContentSchema),
  folder: v.optional(folderNameSchema, "Drafts"),
});

export const moveEmailSchema = v.object({
  uid: uidSchema,
  fromFolder: folderNameSchema,
  toFolder: folderNameSchema,
});

export const markEmailSchema = v.object({
  uid: uidSchema,
  folder: v.optional(folderNameSchema, "INBOX"),
  flags: v.pipe(
    v.array(emailFlagSchema, "Flags must be an array"),
    v.minLength(1, "At least one flag is required"),
    v.maxLength(10, "Too many flags"),
  ),
  action: v.picklist(["add", "remove"], "Action must be 'add' or 'remove'"),
});

export const deleteEmailSchema = v.object({
  uid: uidSchema,
  folder: v.optional(folderNameSchema, "INBOX"),
  permanent: v.optional(v.boolean("Permanent must be a boolean"), false),
});

export const createDirectorySchema = v.object({
  name: folderNameSchema,
  parentPath: v.optional(
    v.pipe(
      v.string("Parent path must be a string"),
      v.maxLength(500, "Parent path too long"),
      v.transform(sanitizeString),
    ),
    "",
  ),
});

// =============================================================================
// CALENDAR TOOL SCHEMAS
// =============================================================================

export const getCalendarEventsSchema = v.pipe(
  v.object({
    start: v.optional(dateSchema),
    end: v.optional(dateSchema),
    calendar: v.optional(calendarNameSchema),
    limit: v.optional(
      v.pipe(
        v.number("Limit must be a number"),
        v.integer("Limit must be an integer"),
        v.minValue(1, "Limit must be at least 1"),
        v.maxValue(500, "Limit cannot exceed 500"),
      ),
      100,
    ),
    offset: v.optional(offsetSchema, 0),
  }),
  v.check(data => {
    if (data.start && data.end) {
      return new Date(data.start) < new Date(data.end);
    }
    return true;
  }, "Start date must be before end date"),
);

export const searchCalendarSchema = v.pipe(
  v.object({
    query: calendarQuerySchema,
    start: v.optional(dateSchema),
    end: v.optional(dateSchema),
    calendar: v.optional(calendarNameSchema),
    limit: v.optional(
      v.pipe(
        v.number("Limit must be a number"),
        v.integer("Limit must be an integer"),
        v.minValue(1, "Limit must be at least 1"),
        v.maxValue(200, "Limit cannot exceed 200"),
      ),
      50,
    ),
    offset: v.optional(offsetSchema, 0),
  }),
  v.check(data => {
    if (data.start && data.end) {
      return new Date(data.start) < new Date(data.end);
    }
    return true;
  }, "Start date must be before end date"),
);

export const createCalendarEventSchema = v.pipe(
  v.object({
    summary: eventSummarySchema,
    start: eventDateSchema,
    // Timed events need it; for all-day events it is the last day
    // (inclusive) and defaults to the start date.
    end: v.optional(eventDateSchema),
    description: v.optional(eventDescriptionSchema),
    location: v.optional(eventLocationSchema),
    allDay: v.optional(v.boolean("allDay must be a boolean"), false),
    attendees: v.optional(eventAttendeesSchema),
    sendInvitations: v.optional(
      v.boolean("sendInvitations must be a boolean"),
      false,
    ),
    calendar: v.optional(calendarNameSchema),
  }),
  v.check(
    data => data.allDay || data.end !== undefined,
    "end is required for timed events",
  ),
  v.check(
    data =>
      data.allDay ||
      data.end === undefined ||
      (hasTime(data.start) && hasTime(data.end)),
    "Timed events need a date-time for start and end, e.g. 2025-06-20T14:00+02:00; set allDay to true for an all-day event",
  ),
  v.check(
    data =>
      data.allDay ||
      data.end === undefined ||
      !hasTime(data.start) ||
      !hasTime(data.end) ||
      new Date(data.start) < new Date(data.end),
    "Start date must be before end date",
  ),
  v.check(
    data =>
      !data.allDay ||
      data.end === undefined ||
      data.start.slice(0, 10) <= data.end.slice(0, 10),
    "The last day must not be before the first day",
  ),
);

const eventUidSchema = v.pipe(
  v.string("UID must be a string"),
  v.trim(),
  v.minLength(1, "UID cannot be empty"),
  v.maxLength(255, "UID too long"),
  v.transform(sanitizeString),
);

export const updateCalendarEventSchema = v.pipe(
  v.strictObject({
    uid: eventUidSchema,
    calendar: v.optional(calendarNameSchema),
    summary: v.optional(eventSummarySchema),
    // A date (YYYY-MM-DD) for all-day events, a date-time for timed ones.
    start: v.optional(eventDateSchema),
    end: v.optional(eventDateSchema),
    // Unlike on creation, an empty string is meaningful here: it clears the field.
    description: v.optional(eventDescriptionSchema),
    location: v.optional(eventLocationSchema),
    // No default: an update must tell "not passed" from "false".
    allDay: v.optional(v.boolean("allDay must be a boolean")),
    attendees: v.optional(eventAttendeesSchema),
    sendInvitations: v.optional(
      v.boolean("sendInvitations must be a boolean"),
      false,
    ),
  }),
  v.check(
    data =>
      [
        data.summary,
        data.start,
        data.end,
        data.description,
        data.location,
        data.allDay,
        data.attendees,
      ].some(field => field !== undefined),
    "Pass at least one field to change",
  ),
  v.check(
    data =>
      !data.start ||
      !data.end ||
      hasTime(data.start) !== hasTime(data.end) ||
      (hasTime(data.start)
        ? new Date(data.start) < new Date(data.end)
        : data.start <= data.end),
    "Start date must be before end date",
  ),
);

export const deleteCalendarEventSchema = v.strictObject({
  uid: eventUidSchema,
  calendar: v.optional(calendarNameSchema),
  notifyParticipants: v.optional(
    v.boolean("notifyParticipants must be a boolean"),
    false,
  ),
});

export const getFreeBusySchema = v.pipe(
  v.object({
    start: dateSchema,
    end: dateSchema,
    calendar: v.optional(calendarNameSchema),
  }),
  v.check(
    data => new Date(data.start) < new Date(data.end),
    "Start date must be before end date",
  ),
);

// =============================================================================
// SCHEMA TYPE EXPORTS
// =============================================================================

export type SearchEmailsInput = v.InferOutput<typeof searchEmailsSchema>;
export type GetEmailInput = v.InferOutput<typeof getEmailSchema>;
export type GetEmailThreadInput = v.InferOutput<typeof getEmailThreadSchema>;
export type SendEmailInput = v.InferOutput<typeof sendEmailSchema>;
export type CreateDraftInput = v.InferOutput<typeof createDraftSchema>;
export type MoveEmailInput = v.InferOutput<typeof moveEmailSchema>;
export type MarkEmailInput = v.InferOutput<typeof markEmailSchema>;
export type DeleteEmailInput = v.InferOutput<typeof deleteEmailSchema>;
export type CreateDirectoryInput = v.InferOutput<typeof createDirectorySchema>;

export type GetCalendarEventsInput = v.InferOutput<
  typeof getCalendarEventsSchema
>;
export type SearchCalendarInput = v.InferOutput<typeof searchCalendarSchema>;
export type CreateCalendarEventInput = v.InferOutput<
  typeof createCalendarEventSchema
>;
export type GetFreeBusyInput = v.InferOutput<typeof getFreeBusySchema>;
export type UpdateCalendarEventInput = v.InferOutput<
  typeof updateCalendarEventSchema
>;
export type DeleteCalendarEventInput = v.InferOutput<
  typeof deleteCalendarEventSchema
>;

// =============================================================================
// VALIDATION UTILITIES
// =============================================================================

export function validateInput<T>(
  schema: v.GenericSchema<T>,
  input: unknown,
): T {
  try {
    return v.parse(schema, input);
  } catch (error) {
    if (error instanceof v.ValiError) {
      // Use a simpler approach to extract error messages
      const messages = error.issues.map(issue => issue.message);
      throw new Error(`Validation failed: ${messages.join("; ")}`);
    }
    throw error;
  }
}

export function safeValidateInput<T>(
  schema: v.GenericSchema<T>,
  input: unknown,
): { success: true; data: T } | { success: false; error: string } {
  try {
    const data = validateInput(schema, input);
    return { success: true, data };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
