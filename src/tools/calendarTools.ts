import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import dayjs from "dayjs";
import type { CalendarService } from "../services/CalendarService.js";
import {
  CalendarError,
  ErrorCode,
  type ErrorContext,
  toMCPError,
  ValidationError,
} from "../types/errors.js";
import {
  getCalendarEventsSchema,
  getFreeBusySchema,
  searchCalendarSchema,
  validateInput,
} from "../validation/schemas.js";

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
  ];
}

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
                  (event) =>
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
                  (event) =>
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
          (slot) =>
            `${dayjs(slot.start).format("YYYY-MM-DD HH:mm")} - ${dayjs(slot.end).format("HH:mm")}${slot.summary ? ` (${slot.summary})` : ""}`,
        );

        const freeSlots = freeBusy.free.map(
          (slot) =>
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
