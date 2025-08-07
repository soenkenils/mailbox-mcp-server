import * as v from "valibot";

// =============================================================================
// SANITIZATION UTILITIES
// =============================================================================

export const sanitizeString = (str: string): string => {
  return str.trim().replace(/[\u0000-\u001F\u007F-\u009F]/g, ""); // Remove control characters
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
  v.transform((email) => email.toLowerCase()),
);

// Folder name validation - prevent path traversal
const folderNameSchema = v.pipe(
  v.string("Folder name must be a string"),
  v.trim(),
  v.minLength(1, "Folder name cannot be empty"),
  v.maxLength(255, "Folder name too long"),
  v.regex(/^[^\/\\<>:"|?*\u0000-\u001F]+$/, "Invalid folder name characters"),
  v.transform(sanitizeString),
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
  v.check((value) => {
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
  v.check((value) => {
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
    (data) => !!(data.text || data.html),
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
  v.check((data) => {
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
  v.check((data) => {
    if (data.start && data.end) {
      return new Date(data.start) < new Date(data.end);
    }
    return true;
  }, "Start date must be before end date"),
);

export const getFreeBusySchema = v.pipe(
  v.object({
    start: dateSchema,
    end: dateSchema,
    calendar: v.optional(calendarNameSchema),
  }),
  v.check(
    (data) => new Date(data.start) < new Date(data.end),
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
export type GetFreeBusyInput = v.InferOutput<typeof getFreeBusySchema>;

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
      const messages = error.issues.map((issue) => issue.message);
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
