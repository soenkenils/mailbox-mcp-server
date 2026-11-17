import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarService } from "../src/services/CalendarService.js";
import {
  createCalendarTools,
  handleCalendarTool,
} from "../src/tools/calendarTools.js";
import type { CalendarEvent } from "../src/types/calendar.types.js";
import {
  CalendarError,
  ErrorCode,
  ValidationError,
} from "../src/types/errors.js";
import { textOf } from "./helpers/toolResult.js";

vi.mock("../src/services/CalendarService.js");

describe("Calendar Tools", () => {
  let mockCalendarService: Pick<
    CalendarService,
    | "getCalendarEvents"
    | "searchCalendar"
    | "getFreeBusy"
    | "createCalendarEvent"
    | "updateCalendarEvent"
    | "deleteCalendarEvent"
  >;

  const mockEvent: CalendarEvent = {
    id: "event-1",
    uid: "event-1@example.com",
    summary: "Team Meeting",
    description: "Weekly team sync",
    location: "Conference Room A",
    start: new Date("2025-06-20T10:00:00Z"),
    end: new Date("2025-06-20T11:00:00Z"),
    allDay: false,
    recurring: false,
    calendar: "work",
    created: new Date("2025-06-01T00:00:00Z"),
    modified: new Date("2025-06-01T00:00:00Z"),
    attendees: [
      { email: "alice@example.com", name: "Alice", status: "accepted" },
      { email: "bob@example.com", name: "Bob", status: "tentative" },
    ],
    organizer: { email: "organizer@example.com", name: "Organizer" },
  };

  beforeEach(() => {
    mockCalendarService = {
      getCalendarEvents: vi.fn(),
      searchCalendar: vi.fn(),
      getFreeBusy: vi.fn(),
      createCalendarEvent: vi.fn(),
      updateCalendarEvent: vi.fn(),
      deleteCalendarEvent: vi.fn(),
    };
  });

  describe("createCalendarTools", () => {
    it("should create all calendar tools", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);

      expect(tools).toHaveLength(6);
      expect(tools.map(t => t.name)).toEqual([
        "get_calendar_events",
        "search_calendar",
        "get_free_busy",
        "create_calendar_event",
        "update_calendar_event",
        "delete_calendar_event",
      ]);
    });

    it("should have proper schema for get_calendar_events tool", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);
      const getTool = tools.find(t => t.name === "get_calendar_events");

      expect(getTool?.inputSchema.properties).toHaveProperty("start");
      expect(getTool?.inputSchema.properties).toHaveProperty("end");
      expect(getTool?.inputSchema.properties).toHaveProperty("calendar");
      expect(getTool?.inputSchema.properties).toHaveProperty("limit");
      expect(getTool?.inputSchema.properties).toHaveProperty("offset");
    });

    it("should have proper schema for search_calendar tool", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);
      const searchTool = tools.find(t => t.name === "search_calendar");

      expect(searchTool?.inputSchema.required).toContain("query");
      expect(searchTool?.inputSchema.properties).toHaveProperty("query");
      expect(searchTool?.inputSchema.properties).toHaveProperty("start");
      expect(searchTool?.inputSchema.properties).toHaveProperty("end");
    });

    it("should have proper schema for get_free_busy tool", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);
      const freeBusyTool = tools.find(t => t.name === "get_free_busy");

      expect(freeBusyTool?.inputSchema.required).toContain("start");
      expect(freeBusyTool?.inputSchema.required).toContain("end");
      expect(freeBusyTool?.inputSchema.properties).toHaveProperty("calendar");
    });
  });

  describe("handleCalendarTool - get_calendar_events", () => {
    it("should retrieve calendar events with date range", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalledWith({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
        calendar: undefined,
        limit: 100,
        offset: 0,
      });

      expect(textOf(result)).toContain("Team Meeting");
      expect(textOf(result)).toContain("Conference Room A");
      expect(textOf(result)).toContain("2025-06-20");
    });

    it("should use default dates when not provided", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {},
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalled();
      expect(textOf(result)).toContain("Found 1 calendar events");
    });

    it("should filter by specific calendar", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
          calendar: "work",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalledWith({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
        calendar: "work",
        limit: 100,
        offset: 0,
      });
    });

    it("should apply limit and offset for pagination", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
          limit: 10,
          offset: 5,
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getCalendarEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
          offset: 5,
        }),
      );
    });

    it("should handle empty results", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("Found 0 calendar events");
    });

    it("should display all-day events correctly", async () => {
      const allDayEvent = { ...mockEvent, allDay: true };
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        allDayEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("(All Day)");
    });

    it("should display recurring events correctly", async () => {
      const recurringEvent = { ...mockEvent, recurring: true };
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        recurringEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("Recurring: Yes");
    });

    it("should give each event the UID update and delete take", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {},
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("UID: event-1@example.com");
      expect(textOf(result)).not.toContain("Occurrence:");
    });

    it.each([
      ["get_calendar_events", "getCalendarEvents"],
      ["search_calendar", "searchCalendar"],
    ] as const)("should mark an occurrence of a series in %s with the series UID", async (tool, method) => {
      vi.mocked(mockCalendarService[method]!).mockResolvedValue([
        {
          ...mockEvent,
          id: "weekly@example.com:2025-06-20T10:00:00.000Z",
          uid: "weekly@example.com",
          recurrenceId: "2025-06-20T10:00:00.000Z",
          recurring: true,
        },
      ]);

      const result = await handleCalendarTool(
        tool,
        { query: "Team" },
        mockCalendarService as CalendarService,
      );

      const text = textOf(result);
      expect(text).toContain("UID: weekly@example.com\n");
      expect(text).toContain(
        "Occurrence: 2025-06-20T10:00:00.000Z of a recurring series (update/delete with this UID change the whole series)",
      );
      expect(text).not.toContain("UID: weekly@example.com:2025");
    });

    it.each([
      ["get_calendar_events", "getCalendarEvents"],
      ["search_calendar", "searchCalendar"],
      ["get_free_busy", "getFreeBusy"],
    ] as const)("should report an unreadable calendar from %s as an error, not an empty result", async (tool, method) => {
      vi.mocked(mockCalendarService[method]!).mockRejectedValue(
        new CalendarError(
          'Could not read calendar "work": HTTP 500',
          ErrorCode.CALENDAR_READ_FAILED,
          "work",
        ),
      );

      const result = await handleCalendarTool(
        tool,
        {
          query: "standup",
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain(
        'Could not read calendar "work": HTTP 500',
      );
    });

    it("should display attendee count", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("Attendees: 2");
    });

    it("should truncate long descriptions", async () => {
      const longDescriptionEvent = {
        ...mockEvent,
        description: "A".repeat(200),
      };
      vi.mocked(mockCalendarService.getCalendarEvents).mockResolvedValue([
        longDescriptionEvent,
      ]);

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("...");
    });
  });

  describe("handleCalendarTool - search_calendar", () => {
    it("should search calendar events by query", async () => {
      vi.mocked(mockCalendarService.searchCalendar).mockResolvedValue([
        mockEvent,
      ]);

      const result = await handleCalendarTool(
        "search_calendar",
        {
          query: "meeting",
          start: "2025-06-01T00:00:00Z",
          end: "2025-06-30T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.searchCalendar).toHaveBeenCalledWith({
        query: "meeting",
        start: new Date("2025-06-01T00:00:00Z"),
        end: new Date("2025-06-30T00:00:00Z"),
        calendar: undefined,
        limit: 50,
        offset: 0,
      });

      expect(textOf(result)).toContain('matching "meeting"');
      expect(textOf(result)).toContain("Team Meeting");
    });

    it("should use default date range (1 year) when not provided", async () => {
      vi.mocked(mockCalendarService.searchCalendar).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "search_calendar",
        {
          query: "meeting",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.searchCalendar).toHaveBeenCalled();
      const callArgs = vi.mocked(mockCalendarService.searchCalendar).mock
        .calls[0][0];
      const daysDiff =
        (callArgs.end!.getTime() - callArgs.start!.getTime()) /
        (1000 * 60 * 60 * 24);
      expect(daysDiff).toBeCloseTo(365, 0);
    });

    it("should apply limit and offset", async () => {
      vi.mocked(mockCalendarService.searchCalendar).mockResolvedValue([
        mockEvent,
      ]);

      await handleCalendarTool(
        "search_calendar",
        {
          query: "meeting",
          limit: 20,
          offset: 10,
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.searchCalendar).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 20,
          offset: 10,
        }),
      );
    });

    it("should handle empty search results", async () => {
      vi.mocked(mockCalendarService.searchCalendar).mockResolvedValue([]);

      const result = await handleCalendarTool(
        "search_calendar",
        {
          query: "nonexistent",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("Found 0 events");
    });
  });

  describe("handleCalendarTool - get_free_busy", () => {
    it("should retrieve free/busy information", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [
          {
            start: new Date("2025-06-20T10:00:00Z"),
            end: new Date("2025-06-20T11:00:00Z"),
            summary: "Team Meeting",
          },
          {
            start: new Date("2025-06-20T14:00:00Z"),
            end: new Date("2025-06-20T15:00:00Z"),
            summary: "Client Call",
          },
        ],
        free: [
          {
            start: new Date("2025-06-20T00:00:00Z"),
            end: new Date("2025-06-20T10:00:00Z"),
          },
          {
            start: new Date("2025-06-20T11:00:00Z"),
            end: new Date("2025-06-20T14:00:00Z"),
          },
        ],
      };

      vi.mocked(mockCalendarService.getFreeBusy).mockResolvedValue(
        freeBusyInfo,
      );

      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getFreeBusy).toHaveBeenCalledWith(
        new Date("2025-06-20T00:00:00Z"),
        new Date("2025-06-20T23:59:59Z"),
        undefined,
      );

      expect(textOf(result)).toContain("Free/Busy Information");
      expect(textOf(result)).toContain("Busy Times (2)");
      expect(textOf(result)).toContain("Free Times (2)");
      expect(textOf(result)).toContain("Team Meeting");
      expect(textOf(result)).toContain("Client Call");
    });

    it("should filter by specific calendar", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [],
        free: [],
      };

      vi.mocked(mockCalendarService.getFreeBusy).mockResolvedValue(
        freeBusyInfo,
      );

      await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
          calendar: "work",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.getFreeBusy).toHaveBeenCalledWith(
        new Date("2025-06-20T00:00:00Z"),
        new Date("2025-06-20T23:59:59Z"),
        "work",
      );
    });

    it("should handle no busy times", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [],
        free: [
          {
            start: new Date("2025-06-20T00:00:00Z"),
            end: new Date("2025-06-20T23:59:59Z"),
          },
        ],
      };

      vi.mocked(mockCalendarService.getFreeBusy).mockResolvedValue(
        freeBusyInfo,
      );

      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("No busy times");
    });

    it("should handle no free times", async () => {
      const freeBusyInfo = {
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-20T23:59:59Z"),
        busy: [
          {
            start: new Date("2025-06-20T00:00:00Z"),
            end: new Date("2025-06-20T23:59:59Z"),
            summary: "All Day Event",
          },
        ],
        free: [],
      };

      vi.mocked(mockCalendarService.getFreeBusy).mockResolvedValue(
        freeBusyInfo,
      );

      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(textOf(result)).toContain("No free times");
    });
  });

  describe("error handling", () => {
    it("should handle validation errors", async () => {
      const result = await handleCalendarTool(
        "get_free_busy",
        {
          // Missing required fields
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid input");
    });

    it("should handle unknown tool name", async () => {
      const result = await handleCalendarTool(
        "unknown_tool",
        {},
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Unknown calendar tool");
    });

    it("should handle service errors", async () => {
      vi.mocked(mockCalendarService.getCalendarEvents).mockRejectedValue(
        new Error("Connection failed"),
      );

      const result = await handleCalendarTool(
        "get_calendar_events",
        {
          start: "2025-06-20T00:00:00Z",
          end: "2025-06-21T00:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Error executing");
    });

    it("should handle invalid date formats", async () => {
      const result = await handleCalendarTool(
        "get_free_busy",
        {
          start: "invalid-date",
          end: "2025-06-20T23:59:59Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
    });
  });

  describe("createCalendarTools - create_calendar_event schema", () => {
    it("should have proper schema for create_calendar_event tool", () => {
      const tools = createCalendarTools(mockCalendarService as CalendarService);
      const createTool = tools.find(t => t.name === "create_calendar_event");

      // end is required for timed events only; the validator enforces it.
      expect(createTool?.inputSchema.required).toEqual(["summary", "start"]);
      for (const property of [
        "summary",
        "start",
        "end",
        "description",
        "location",
        "allDay",
        "attendees",
        "calendar",
      ]) {
        expect(createTool?.inputSchema.properties).toHaveProperty(property);
      }
    });
  });

  describe("handleCalendarTool - create_calendar_event", () => {
    const createResult = {
      uid: "test-uid-123",
      summary: "New Meeting",
      start: new Date("2025-07-01T10:00:00Z"),
      end: new Date("2025-07-01T11:00:00Z"),
      allDay: false,
      calendar: "personal",
    };

    it("should create a calendar event with all fields", async () => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockResolvedValue(
        createResult,
      );

      const result = await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "New Meeting",
          start: "2025-07-01T10:00:00Z",
          end: "2025-07-01T11:00:00Z",
          description: "Discuss project\nand budget",
          location: "Room 42",
          attendees: [{ email: "alice@example.com", name: "Alice" }],
          calendar: "personal",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.createCalendarEvent).toHaveBeenCalledWith({
        summary: "New Meeting",
        start: new Date("2025-07-01T10:00:00Z"),
        end: new Date("2025-07-01T11:00:00Z"),
        startDate: undefined,
        endDate: undefined,
        description: "Discuss project\nand budget",
        location: "Room 42",
        allDay: false,
        attendees: [{ email: "alice@example.com", name: "Alice" }],
        sendInvitations: false,
        calendar: "personal",
      });

      const text = textOf(result);
      expect(result.isError).toBeUndefined();
      expect(text).toContain("created successfully");
      expect(text).toContain("New Meeting");
      expect(text).toContain("UID: test-uid-123");
      expect(text).toContain("Calendar: personal");
      expect(text).toContain("Room 42");
      expect(text).toContain("Alice");
      expect(text).toContain(
        "No invitations were sent (attendees recorded only)",
      );
    });

    it("should pass sendInvitations through and say invitations were requested", async () => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockResolvedValue(
        createResult,
      );

      const result = await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "Kick-off",
          start: "2025-07-01T10:00:00Z",
          end: "2025-07-01T11:00:00Z",
          attendees: [
            { email: "alice@example.com" },
            { email: "bob@example.com" },
          ],
          sendInvitations: true,
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.createCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({ sendInvitations: true }),
      );
      expect(textOf(result)).toContain(
        "Invitations requested for 2 attendee(s)",
      );
    });

    it("should advertise the attendee shape strictly and the default calendar precisely", () => {
      const tool = createCalendarTools(
        mockCalendarService as CalendarService,
      ).find(t => t.name === "create_calendar_event");
      const properties = tool?.inputSchema.properties as Record<
        string,
        { items?: { additionalProperties?: boolean }; description?: string }
      >;

      expect(properties.attendees.items?.additionalProperties).toBe(false);
      expect(properties.calendar.description).toContain("MAILBOX_CALENDARS");
    });

    it("should advertise that nobody is notified unless sendInvitations is true", () => {
      const tool = createCalendarTools(
        mockCalendarService as CalendarService,
      ).find(t => t.name === "create_calendar_event");
      const property = tool?.inputSchema.properties?.sendInvitations as {
        type: string;
        default: boolean;
      };

      expect(property).toMatchObject({ type: "boolean", default: false });
      expect(tool?.description).toMatch(/by default nobody is notified/i);
    });

    it("should create a calendar event with minimal fields", async () => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockResolvedValue(
        createResult,
      );

      const result = await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "Quick Sync",
          start: "2025-07-01T10:00:00Z",
          end: "2025-07-01T10:30:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.createCalendarEvent).toHaveBeenCalledWith({
        summary: "Quick Sync",
        start: new Date("2025-07-01T10:00:00Z"),
        end: new Date("2025-07-01T10:30:00Z"),
        startDate: undefined,
        endDate: undefined,
        description: undefined,
        location: undefined,
        allDay: false,
        attendees: undefined,
        sendInvitations: false,
        calendar: undefined,
      });
      expect(result.isError).toBeUndefined();
    });

    it("should take an all-day end as the last day and show it so", async () => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockResolvedValue({
        ...createResult,
        summary: "Holiday",
        start: new Date("2025-07-04"),
        end: new Date("2025-07-06"),
        allDay: true,
        startDate: "2025-07-04",
        endDate: "2025-07-07",
      });

      const result = await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "Holiday",
          start: "2025-07-04",
          end: "2025-07-06",
          allDay: true,
        },
        mockCalendarService as CalendarService,
      );

      // The last day is inclusive for the caller, DTEND exclusive on the wire.
      expect(mockCalendarService.createCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          allDay: true,
          startDate: "2025-07-04",
          endDate: "2025-07-07",
        }),
      );
      const text = textOf(result);
      expect(text).toContain("Dates: 2025-07-04 to 2025-07-06 (All Day)");
    });

    it("should pass all-day dates as written, whatever their offset", async () => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockResolvedValue(
        createResult,
      );

      // Midnight in Berlin is still the previous day in UTC.
      await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "Holiday",
          start: "2025-07-04T00:00:00+02:00",
          end: "2025-07-05T00:00:00+02:00",
          allDay: true,
        },
        mockCalendarService as CalendarService,
      );

      expect(mockCalendarService.createCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2025-07-04",
          endDate: "2025-07-06",
        }),
      );
    });

    it.each([
      ["omitted", undefined],
      ["equal to start", "2025-12-31"],
    ])("should make a one-day all-day event when end is %s", async (_, end) => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockResolvedValue({
        ...createResult,
        allDay: true,
        startDate: "2025-12-31",
        endDate: "2026-01-01",
      });

      const result = await handleCalendarTool(
        "create_calendar_event",
        { summary: "Holiday", start: "2025-12-31", end, allDay: true },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBeUndefined();
      expect(mockCalendarService.createCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: "2025-12-31",
          endDate: "2026-01-01",
        }),
      );
      expect(textOf(result)).toContain("Date: 2025-12-31 (All Day)");
    });

    it("should require an end for timed events", async () => {
      const result = await handleCalendarTool(
        "create_calendar_event",
        { summary: "Call", start: "2025-07-01T10:00:00Z" },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("end is required");
    });

    it("should refuse a date without a time for a timed event", async () => {
      const result = await handleCalendarTool(
        "create_calendar_event",
        { summary: "Call", start: "2025-06-20", end: "2025-06-21" },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("need a date-time");
      expect(mockCalendarService.createCalendarEvent).not.toHaveBeenCalled();
    });

    it("should return validation error when summary is missing", async () => {
      const result = await handleCalendarTool(
        "create_calendar_event",
        { start: "2025-07-01T10:00:00Z", end: "2025-07-01T11:00:00Z" },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid input");
      expect(mockCalendarService.createCalendarEvent).not.toHaveBeenCalled();
    });

    it("should return validation error when start is not before end", async () => {
      const result = await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "Bad Event",
          start: "2025-07-01T10:00:00Z",
          end: "2025-07-01T10:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(mockCalendarService.createCalendarEvent).not.toHaveBeenCalled();
    });

    it("should report why the server refused the event", async () => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockRejectedValue(
        new CalendarError(
          'The CalDAV server rejected the create in calendar "work" (HTTP 403)',
          ErrorCode.EVENT_WRITE_REJECTED,
        ),
      );

      const result = await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "Failing Event",
          start: "2025-07-01T10:00:00Z",
          end: "2025-07-01T11:00:00Z",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Error executing");
      expect(textOf(result)).toContain("HTTP 403");
    });

    it("should report a calendar name that was refused", async () => {
      vi.mocked(mockCalendarService.createCalendarEvent).mockRejectedValue(
        new ValidationError('Calendar "private" not found', "calendar"),
      );

      const result = await handleCalendarTool(
        "create_calendar_event",
        {
          summary: "Event",
          start: "2025-07-01T10:00:00Z",
          end: "2025-07-01T11:00:00Z",
          calendar: "private",
        },
        mockCalendarService as CalendarService,
      );

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('Calendar "private" not found');
    });
  });

  describe("handleCalendarTool - update_calendar_event", () => {
    const run = (args: Record<string, unknown>) =>
      handleCalendarTool(
        "update_calendar_event",
        args,
        mockCalendarService as CalendarService,
      );

    beforeEach(() => {
      vi.mocked(mockCalendarService.updateCalendarEvent).mockResolvedValue({
        event: { ...mockEvent, summary: "Renamed" },
        notified: false,
      });
    });

    it("should pass only the fields given, with nobody notified by default", async () => {
      const result = await run({
        uid: "event-1@example.com",
        summary: "Renamed",
      });

      expect(mockCalendarService.updateCalendarEvent).toHaveBeenCalledWith({
        uid: "event-1@example.com",
        calendar: undefined,
        summary: "Renamed",
        start: undefined,
        end: undefined,
        startDate: undefined,
        endDate: undefined,
        description: undefined,
        location: undefined,
        // Not defaulted to false: that would turn all-day events into timed ones.
        allDay: undefined,
        attendees: undefined,
        sendInvitations: false,
      });
      const text = textOf(result);
      expect(text).toContain("Calendar event updated successfully");
      expect(text).toContain("UID: event-1@example.com");
      expect(text).toContain("Nobody was notified");
    });

    it("should pass date-times as instants and dates as all-day dates with an exclusive end", async () => {
      await run({
        uid: "a",
        start: "2025-06-21T09:00:00+02:00",
        end: "2025-06-21T10:00:00+02:00",
      });
      await run({
        uid: "a",
        allDay: true,
        start: "2025-07-04",
        end: "2025-07-05",
      });

      expect(mockCalendarService.updateCalendarEvent).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          start: new Date("2025-06-21T07:00:00Z"),
          end: new Date("2025-06-21T08:00:00Z"),
          startDate: undefined,
          endDate: undefined,
        }),
      );
      expect(mockCalendarService.updateCalendarEvent).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          start: undefined,
          end: undefined,
          startDate: "2025-07-04",
          endDate: "2025-07-06",
          allDay: true,
        }),
      );
    });

    it("should pass sendInvitations and say the server may notify", async () => {
      vi.mocked(mockCalendarService.updateCalendarEvent).mockResolvedValue({
        event: { ...mockEvent, recurring: true },
        notified: true,
      });

      const result = await run({
        uid: "a",
        attendees: [{ email: "bob@example.com" }],
        sendInvitations: true,
      });

      expect(mockCalendarService.updateCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          attendees: [{ email: "bob@example.com" }],
          sendInvitations: true,
        }),
      );
      const text = textOf(result);
      expect(text).toContain("may have emailed the participants");
      expect(text).toContain("the whole series was changed");
    });

    it.each([
      [{ uid: "a" }, "at least one field"],
      [{ summary: "x" }, "uid"],
      [
        {
          uid: "a",
          start: "2025-06-21T10:00:00Z",
          end: "2025-06-21T09:00:00Z",
        },
        "Start date must be before end date",
      ],
      [{ uid: "a", start: "2025-02-30" }, "not a real date"],
      [{ uid: "a", summary: "x", recurrence: "daily" }, ""],
    ])("should reject invalid input %j", async (args, message) => {
      const result = await run(args);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Invalid input");
      expect(textOf(result)).toContain(message);
      expect(mockCalendarService.updateCalendarEvent).not.toHaveBeenCalled();
    });

    it("should show a refusal from the service with its reason", async () => {
      vi.mocked(mockCalendarService.updateCalendarEvent).mockRejectedValue(
        new ValidationError(
          '"w:2025-06-20" is the id of one occurrence (2025-06-20) of the recurring series "w". Changing or deleting a single occurrence is not supported; this tool acts on the whole series and takes its UID: pass uid "w" only if the whole series is meant',
          "uid",
          "w:2025-06-20",
        ),
      );

      const result = await run({ uid: "w:2025-06-20", summary: "x" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('pass uid "w"');
    });

    it("should report a concurrent change", async () => {
      vi.mocked(mockCalendarService.updateCalendarEvent).mockRejectedValue(
        new CalendarError("changed", ErrorCode.EVENT_MODIFIED, "work", "a"),
      );

      const result = await run({ uid: "a", summary: "x" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Fetch it again and retry");
    });
  });

  describe("handleCalendarTool - delete_calendar_event", () => {
    const run = (args: Record<string, unknown>) =>
      handleCalendarTool(
        "delete_calendar_event",
        args,
        mockCalendarService as CalendarService,
      );

    it("should delete without notifying by default", async () => {
      vi.mocked(mockCalendarService.deleteCalendarEvent).mockResolvedValue({
        uid: "a",
        summary: "Team Meeting",
        calendar: "work",
        recurring: false,
        notified: false,
      });

      const result = await run({ uid: "a" });

      expect(mockCalendarService.deleteCalendarEvent).toHaveBeenCalledWith({
        uid: "a",
        calendar: undefined,
        notifyParticipants: false,
      });
      const text = textOf(result);
      expect(text).toContain("Calendar event deleted");
      expect(text).toContain("**Team Meeting**");
      expect(text).toContain("Nobody was notified");
    });

    it("should say when a whole series went and participants may be told", async () => {
      vi.mocked(mockCalendarService.deleteCalendarEvent).mockResolvedValue({
        uid: "w",
        summary: "",
        calendar: "work",
        recurring: true,
        notified: true,
      });

      const result = await run({ uid: "w", notifyParticipants: true });

      const text = textOf(result);
      expect(text).toContain("the whole series, all occurrences");
      expect(text).toContain("(untitled)");
      expect(text).toContain("may have emailed the participants");
    });

    it("should report a missing event with its UID", async () => {
      vi.mocked(mockCalendarService.deleteCalendarEvent).mockRejectedValue(
        new CalendarError(
          'No event with UID "nope" found',
          ErrorCode.EVENT_NOT_FOUND,
          undefined,
          "nope",
        ),
      );

      const result = await run({ uid: "nope" });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('No event with UID "nope"');
    });

    it("should reject unknown arguments", async () => {
      const result = await run({ uid: "a", force: true });

      expect(result.isError).toBe(true);
      expect(mockCalendarService.deleteCalendarEvent).not.toHaveBeenCalled();
    });
  });
});
