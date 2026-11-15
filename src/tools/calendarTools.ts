import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import type { CalendarService } from "../services/CalendarService.js";
import {
  CalendarError,
  ErrorCode,
  type ErrorContext,
  toMCPError,
  ValidationError,
} from "../types/errors.js";
import {
  createCalendarEventSchema,
  getCalendarEventsSchema,
  getFreeBusySchema,
  searchCalendarSchema,
  validateInput,
} from "../validation/schemas.js";

dayjs.extend(utc);

/** Calendar tool names - exported for tool routing */
export const CALENDAR_TOOLS = [
  "get_calendar_events",
  "search_calendar",
  "get_free_busy",
  "create_calendar_event",
] as const;

export type CalendarToolName = (typeof CALENDAR_TOOLS)[number];

export function isCalendarTool(name: string): name is CalendarToolName {
  return CALENDAR_TOOLS.includes(name as CalendarToolName);
}

export function createCalendarTools(calendarService: CalendarService): Tool[] {
  return [
    {
      name: "get_calendar_events",
      description:
        "Get calendar events from mailbox.org calendar within a date range",
      inputSchema: {
        type: "object",
        properties: {
          start: {
            type: "string",
            format: "date-time",
            description:
              "Start date for event search (ISO 8601 format, default: today)",
          },
          end: {
            type: "string",
            format: "date-time",
            description:
              "End date for event search (ISO 8601 format, default: 30 days from start)",
          },
          calendar: {
            type: "string",
            description:
              "Specific calendar name to search (optional, searches all if not specified)",
          },
          limit: {
            type: "number",
            description: "Maximum number of events to return (default: 100)",
            default: 100,
            minimum: 1,
            maximum: 500,
          },
          offset: {
            type: "number",
            description: "Number of events to skip for pagination (default: 0)",
            default: 0,
            minimum: 0,
          },
        },
        additionalProperties: false,
      },
    },
    {
      name: "search_calendar",
      description:
        "Search calendar events by text query in title, description, or location",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query to match against event title, description, and location",
          },
          start: {
            type: "string",
            format: "date-time",
            description:
              "Start date for search range (ISO 8601 format, default: today)",
          },
          end: {
            type: "string",
            format: "date-time",
            description:
              "End date for search range (ISO 8601 format, default: 1 year from start)",
          },
          calendar: {
            type: "string",
            description: "Specific calendar name to search (optional)",
          },
          limit: {
            type: "number",
            description: "Maximum number of events to return (default: 50)",
            default: 50,
            minimum: 1,
            maximum: 200,
          },
          offset: {
            type: "number",
            description: "Number of events to skip for pagination (default: 0)",
            default: 0,
            minimum: 0,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "get_free_busy",
      description: "Get free/busy information for scheduling appointments",
      inputSchema: {
        type: "object",
        properties: {
          start: {
            type: "string",
            format: "date-time",
            description: "Start date for free/busy query (ISO 8601 format)",
          },
          end: {
            type: "string",
            format: "date-time",
            description: "End date for free/busy query (ISO 8601 format)",
          },
          calendar: {
            type: "string",
            description:
              "Specific calendar name to check (optional, checks all if not specified)",
          },
        },
        required: ["start", "end"],
        additionalProperties: false,
      },
    },
    {
      name: "create_calendar_event",
      description:
        "Create an event in a mailbox.org calendar and return its UID. Calling twice creates two events. Attendees: by default nobody is notified; attendees are only recorded on the event. Set sendInvitations to true only when the user explicitly asked to invite people: the server may then email an invitation to every attendee.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "Event title/summary (required)",
          },
          start: {
            type: "string",
            description:
              "Event start (required). Timed events: an ISO 8601 date-time; pass an explicit offset or Z (e.g. 2025-06-20T14:00+02:00). A date-time without an offset is read in the time zone of the machine running this server. All-day events: the first day, YYYY-MM-DD.",
          },
          end: {
            type: "string",
            description:
              "Event end. Timed events (required): an ISO 8601 date-time, after start, with an offset or Z as for start. All-day events (optional): the LAST day of the event, inclusive, YYYY-MM-DD; omit it or pass the start date for a one-day event.",
          },
          description: {
            type: "string",
            description: "Event description (optional, may span several lines)",
          },
          location: {
            type: "string",
            description: "Event location (optional)",
          },
          allDay: {
            type: "boolean",
            description: "Whether this is an all-day event (default: false)",
            default: false,
          },
          attendees: {
            type: "array",
            items: {
              type: "object",
              properties: {
                email: {
                  type: "string",
                  description: "Attendee email address",
                },
                name: {
                  type: "string",
                  description: "Attendee display name (optional)",
                },
              },
              required: ["email"],
            },
            description:
              "List of event attendees (optional). Recorded only; nobody is notified unless sendInvitations is true",
          },
          sendInvitations: {
            type: "boolean",
            description:
              "Ask the server to email invitations to all attendees, with your account as organizer (default: false). Only set this when the user explicitly asked to invite people",
            default: false,
          },
          calendar: {
            type: "string",
            description:
              "Target calendar name (optional, defaults to the first available calendar)",
          },
        },
        required: ["summary", "start"],
        additionalProperties: false,
      },
    },
  ];
}

/** The YYYY-MM-DD part of an ISO 8601 string, as the caller wrote it. */
const writtenDate = (value: string): string => value.slice(0, 10);

const dayAfter = (date: string): string =>
  dayjs.utc(date).add(1, "day").format("YYYY-MM-DD");

/** An all-day span from its first date and exclusive end, as last day. */
const allDayRange = (startDate?: string, endDate?: string): string => {
  const lastDay = endDate
    ? dayjs.utc(endDate).subtract(1, "day").format("YYYY-MM-DD")
    : startDate;
  return lastDay === startDate
    ? `Date: ${startDate} (All Day)`
    : `Dates: ${startDate} to ${lastDay} (All Day)`;
};

export async function handleCalendarTool(
  name: string,
  args: Record<string, unknown>,
  calendarService: CalendarService,
): Promise<CallToolResult> {
  try {
    switch (name) {
      case "get_calendar_events": {
        const validatedArgs = validateInput(getCalendarEventsSchema, args);
        const start = validatedArgs.start
          ? new Date(validatedArgs.start)
          : dayjs().startOf("day").toDate();
        const end = validatedArgs.end
          ? new Date(validatedArgs.end)
          : dayjs(start).add(30, "days").toDate();

        const options = {
          start,
          end,
          calendar: validatedArgs.calendar,
          limit: validatedArgs.limit,
          offset: validatedArgs.offset,
        };

        const events = await calendarService.getCalendarEvents(options);

        return {
          content: [
            {
              type: "text",
              text: `Found ${events.length} calendar events:\n\n${events
                .map(
                  event =>
                    `**${event.summary}**
Start: ${dayjs(event.start).format("YYYY-MM-DD HH:mm")} ${event.allDay ? "(All Day)" : ""}
End: ${dayjs(event.end).format("YYYY-MM-DD HH:mm")}
${event.location ? `Location: ${event.location}\n` : ""}${
  event.description
    ? `Description: ${event.description.substring(0, 100)}${event.description.length > 100 ? "..." : ""}\n`
    : ""
}Calendar: ${event.calendar}
${
  event.attendees?.length ? `Attendees: ${event.attendees.length}\n` : ""
}${event.recurring ? "Recurring: Yes\n" : ""}`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "search_calendar": {
        const validatedArgs = validateInput(searchCalendarSchema, args);
        const start = validatedArgs.start
          ? new Date(validatedArgs.start)
          : dayjs().startOf("day").toDate();
        const end = validatedArgs.end
          ? new Date(validatedArgs.end)
          : dayjs(start).add(1, "year").toDate();

        const options = {
          query: validatedArgs.query,
          start,
          end,
          calendar: validatedArgs.calendar,
          limit: validatedArgs.limit,
          offset: validatedArgs.offset,
        };

        const events = await calendarService.searchCalendar(options);

        return {
          content: [
            {
              type: "text",
              text: `Found ${events.length} events matching "${validatedArgs.query}":\n\n${events
                .map(
                  event =>
                    `**${event.summary}**
Start: ${dayjs(event.start).format("YYYY-MM-DD HH:mm")} ${event.allDay ? "(All Day)" : ""}
End: ${dayjs(event.end).format("YYYY-MM-DD HH:mm")}
${event.location ? `Location: ${event.location}\n` : ""}${
  event.description
    ? `Description: ${event.description.substring(0, 150)}${event.description.length > 150 ? "..." : ""}\n`
    : ""
}Calendar: ${event.calendar}
`,
                )
                .join("\n---\n")}`,
            },
          ],
        };
      }

      case "get_free_busy": {
        const validatedArgs = validateInput(getFreeBusySchema, args);
        const start = new Date(validatedArgs.start);
        const end = new Date(validatedArgs.end);

        const freeBusy = await calendarService.getFreeBusy(
          start,
          end,
          validatedArgs.calendar,
        );

        const busySlots = freeBusy.busy.map(
          slot =>
            `${dayjs(slot.start).format("YYYY-MM-DD HH:mm")} - ${dayjs(slot.end).format("HH:mm")}${slot.summary ? ` (${slot.summary})` : ""}`,
        );

        const freeSlots = freeBusy.free.map(
          slot =>
            `${dayjs(slot.start).format("YYYY-MM-DD HH:mm")} - ${dayjs(slot.end).format("HH:mm")}`,
        );

        return {
          content: [
            {
              type: "text",
              text: `**Free/Busy Information**
Period: ${dayjs(start).format("YYYY-MM-DD HH:mm")} - ${dayjs(end).format("YYYY-MM-DD HH:mm")}

**Busy Times (${freeBusy.busy.length}):**
${busySlots.length > 0 ? busySlots.join("\n") : "No busy times"}

**Free Times (${freeBusy.free.length}):**
${freeSlots.length > 0 ? freeSlots.join("\n") : "No free times"}`,
            },
          ],
        };
      }

      case "create_calendar_event": {
        const validatedArgs = validateInput(createCalendarEventSchema, args);

        const end = validatedArgs.end ?? validatedArgs.start;
        const allDay = validatedArgs.allDay;

        const result = await calendarService.createCalendarEvent({
          summary: validatedArgs.summary,
          start: new Date(validatedArgs.start),
          end: new Date(end),
          // All-day: the caller names the last day; DTEND is the day after.
          startDate: allDay ? writtenDate(validatedArgs.start) : undefined,
          endDate: allDay ? dayAfter(writtenDate(end)) : undefined,
          description: validatedArgs.description,
          location: validatedArgs.location,
          allDay: validatedArgs.allDay,
          attendees: validatedArgs.attendees,
          sendInvitations: validatedArgs.sendInvitations,
          calendar: validatedArgs.calendar,
        });

        const parts = [
          "Calendar event created successfully:\n",
          `**${result.summary}**`,
          ...(result.allDay
            ? [allDayRange(result.startDate, result.endDate)]
            : [
                `Start: ${dayjs(result.start).format("YYYY-MM-DD HH:mm Z")}`,
                `End: ${dayjs(result.end).format("YYYY-MM-DD HH:mm Z")}`,
              ]),
          `Calendar: ${result.calendar}`,
          `UID: ${result.uid}`,
        ];

        if (validatedArgs.location) {
          parts.push(`Location: ${validatedArgs.location}`);
        }

        if (validatedArgs.attendees?.length) {
          parts.push(
            `Attendees: ${validatedArgs.attendees.map(a => a.name || a.email).join(", ")}`,
          );
          parts.push(
            validatedArgs.sendInvitations
              ? `Invitations requested for ${validatedArgs.attendees.length} attendee(s); the server may email them`
              : "No invitations were sent (attendees recorded only)",
          );
        }

        return { content: [{ type: "text", text: parts.join("\n") }] };
      }

      default:
        throw new ValidationError(
          `Unknown calendar tool: ${name}`,
          "tool_name",
          name,
        );
    }
  } catch (error) {
    const context: ErrorContext = {
      operation: name,
      service: "calendarTools",
      details: { args },
    };

    // Handle validation errors specifically
    if (
      error instanceof Error &&
      error.message.startsWith("Validation failed:")
    ) {
      const validationError = new ValidationError(
        error.message.replace("Validation failed: ", ""),
        "input_validation",
        args,
        context,
      );

      return {
        content: [
          {
            type: "text",
            text: `❌ Invalid input for ${name}: ${validationError.getUserMessage()}`,
          },
        ],
        isError: true,
      };
    }

    // Convert to structured error if not already
    const mcpError =
      error instanceof Error
        ? toMCPError(error, context)
        : new CalendarError(
            String(error),
            ErrorCode.OPERATION_FAILED,
            undefined,
            undefined,
            context,
          );

    return {
      content: [
        {
          type: "text",
          text: `Error executing ${name}: ${mcpError.getUserMessage()}${mcpError.isRetryable ? " (This operation can be retried)" : ""}`,
        },
      ],
      isError: true,
    };
  }
}
