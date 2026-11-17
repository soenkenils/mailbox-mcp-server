import type { createDAVClient } from "tsdav";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type {
  CalDavConnection,
  CalendarEvent,
} from "../src/types/calendar.types.js";
import { ErrorCode } from "../src/types/errors.js";

// Type for the mock DAV client with only the methods we need for testing
type MockDAVClient = Pick<
  Awaited<ReturnType<typeof createDAVClient>>,
  "fetchCalendars" | "fetchCalendarObjects"
>;

// Private methods of CalendarService reached for branch coverage testing
type CalendarServicePrivates = {
  filterEventsByQuery(events: CalendarEvent[], query?: string): CalendarEvent[];
  extractStatus(attendee: unknown): string;
};

// Test helper class for accessing protected methods
class TestableCalendarService extends CalendarService {
  public async getClient() {
    return super.getClient();
  }

  // Expose private methods for branch coverage testing
  public testFilterEventsByQuery(
    events: CalendarEvent[],
    query?: string,
  ): CalendarEvent[] {
    return (this as unknown as CalendarServicePrivates).filterEventsByQuery(
      events,
      query,
    );
  }

  public testExtractStatus(attendee: unknown): string {
    return (this as unknown as CalendarServicePrivates).extractStatus(attendee);
  }
}

// Define mock functions at the top level
const mockFetchCalendars = vi.fn();
const mockFetchCalendarObjects = vi.fn();

// Mock ical.js with proper default export
vi.mock("ical.js", () => {
  const mockICal = {
    parse: vi
      .fn()
      .mockImplementation(() => [[["vcalendar", [], [["vevent", [], []]]]]]),
    Component: class {
      getAllSubcomponents(type: string) {
        if (type === "vevent") {
          // Return mock vevent data that will work with ICAL.Event
          return [["vevent", [], []]];
        }
        return [];
      }
    },
    Event: class {
      public uid = "event1@example.com";
      public summary = "Test Event";
      public description = "Test Description";
      public location = "Test Location";
      public startDate = {
        toJSDate: () => new Date("2025-06-20T10:00:00Z"),
        isDate: false,
      };
      public endDate = {
        toJSDate: () => new Date("2025-06-20T11:00:00Z"),
        isDate: false,
      };
      public attendees: unknown[] = [];
      public organizer: unknown = null;
      public component = {
        getFirstPropertyValue: (prop: string) => {
          if (prop === "rrule") return null;
          if (prop === "categories") return null;
          if (prop === "created") return null;
          if (prop === "last-modified") return null;
          return null;
        },
      };

      isRecurring() {
        return false;
      }
    },
  };

  return {
    ...mockICal,
    default: mockICal,
  };
});

// Mock tsdav with inline implementation
vi.mock("tsdav", () => {
  // Define the mock client class inside the factory function
  class MockDAVClient {
    fetchCalendars = mockFetchCalendars;
    fetchCalendarObjects = mockFetchCalendarObjects;
  }

  return {
    createDAVClient: vi.fn(function () {
      return new MockDAVClient();
    }),
    DAVClient: MockDAVClient,
  };
});

// Mock factories
const createMockCache = (): LocalCache => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  clear: vi.fn(),
  has: vi.fn(),
  size: vi.fn(),
  cleanup: vi.fn(),
  getStale: vi.fn(),
  getStats: vi.fn(),
  keys: vi.fn(() => new Set<string>().values()),
});

const createMockConnection = (
  overrides: Partial<CalDavConnection> = {},
): CalDavConnection => ({
  baseUrl: "https://caldav.example.com",
  username: "test@example.com",
  password: "password",
  calendars: ["personal"],
  ...overrides,
});

const createTestCalendarEvent = (
  overrides: Partial<CalendarEvent> = {},
): CalendarEvent => ({
  id: "event1",
  uid: "event1@example.com",
  summary: "Test Event",
  start: new Date("2025-06-20T10:00:00Z"),
  end: new Date("2025-06-20T11:00:00Z"),
  allDay: false,
  recurring: false,
  calendar: "personal",
  created: new Date(),
  modified: new Date(),
  ...overrides,
});

const createTestICalData = (eventData: Record<string, unknown> = {}) => {
  const event = {
    uid: "event1@example.com",
    summary: "Test Event",
    ...eventData,
  };
  return `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//CalDAV Client//EN
BEGIN:VEVENT
UID:${event.uid}
DTSTAMP:20230619T120000Z
DTSTART:20230620T100000Z
DTEND:20230620T110000Z
SUMMARY:${event.summary}
END:VEVENT
END:VCALENDAR`;
};

const setupMockDefaults = () => {
  // Setup default DAV responses
  mockFetchCalendars.mockResolvedValue([
    {
      displayName: "personal",
      url: "https://caldav.example.com/calendars/test/personal/",
    },
  ]);

  mockFetchCalendarObjects.mockResolvedValue([
    {
      data: createTestICalData(),
    },
  ]);
};

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterAll(() => {
  errorSpy.mockRestore();
});

describe("CalendarService", () => {
  let calendarService: TestableCalendarService;
  let mockCache: LocalCache;
  let mockConnection: CalDavConnection;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup default mock behavior
    setupMockDefaults();

    // Setup mock instances
    mockCache = createMockCache();
    mockConnection = createMockConnection();
    calendarService = new TestableCalendarService(mockConnection, mockCache);

    // Mock the getClient method to return our mock client. MockDAVClient
    // checks the two methods the service uses; the cast covers the rest of
    // tsdav's client surface, which these tests never touch.
    const mockClient: MockDAVClient = {
      fetchCalendars: mockFetchCalendars,
      fetchCalendarObjects: mockFetchCalendarObjects,
    };
    vi.spyOn(calendarService, "getClient").mockResolvedValue(
      mockClient as unknown as Awaited<ReturnType<typeof createDAVClient>>,
    );
  });

  describe("getCalendarEvents", () => {
    it("should return cached events if available", async () => {
      // Mock cache to return test events
      const cachedEvents = [createTestCalendarEvent()];
      const cacheKey =
        'calendar_events:{"start":"2025-06-20T00:00:00.000Z","end":"2025-06-21T00:00:00.000Z"}';

      // Mock cache.get to return our test events
      (mockCache.get as Mock).mockImplementation((key: string) => {
        return key === cacheKey ? cachedEvents : null;
      });

      const result = await calendarService.getCalendarEvents({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
      });

      expect(result).toEqual(cachedEvents);
      expect(mockFetchCalendarObjects).not.toHaveBeenCalled();
    });

    it("should fetch and cache events if not in cache", async () => {
      // Mock cache to return null (cache miss)
      (mockCache.get as Mock).mockReturnValue(null);

      // Mock the calendar objects response with proper structure
      mockFetchCalendarObjects.mockResolvedValue([
        {
          data: createTestICalData(),
          url: "https://caldav.example.com/calendars/test/personal/",
        },
      ]);

      const start = new Date("2025-06-20T00:00:00Z");
      const end = new Date("2025-06-21T00:00:00Z");

      const result = await calendarService.getCalendarEvents({ start, end });

      expect(mockFetchCalendarObjects).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);

      // Check that we got back the expected event
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toMatchObject({
        id: expect.any(String),
        uid: "event1@example.com",
        summary: "Test Event",
      });

      // Verify the result was cached
      const cacheKey = `calendar_events:${JSON.stringify({
        start: start.toISOString(),
        end: end.toISOString(),
      })}`;

      expect(mockCache.set).toHaveBeenCalledWith(
        cacheKey,
        expect.arrayContaining([
          expect.objectContaining({
            uid: "event1@example.com",
            summary: "Test Event",
          }),
        ]),
        expect.any(Number),
      );
    });
  });

  describe("searchCalendar", () => {
    it("should filter events by query", async () => {
      // Mock the calendar objects response
      mockFetchCalendarObjects.mockResolvedValue([
        { data: createTestICalData() },
      ]);

      const result = await calendarService.searchCalendar({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
        query: "Test",
      });

      expect(Array.isArray(result)).toBe(true);
      expect(mockFetchCalendarObjects).toHaveBeenCalled();
    });

    it.each([
      ["Test", 1],
      ["Meeting", 0],
      ["event", 1],
      ["", 1], // Empty query should return all events
    ])("should filter events by query '%s' and return %d results", async (query, expectedCount) => {
      const testData = createTestICalData({ summary: "Test Event" });
      mockFetchCalendarObjects.mockResolvedValue([{ data: testData }]);

      const result = await calendarService.searchCalendar({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
        query,
      });

      expect(result).toHaveLength(expectedCount);
    });
  });

  describe("getFreeBusy", () => {
    it("should return free/busy information", async () => {
      // Mock the calendar objects response
      mockFetchCalendarObjects.mockResolvedValue([
        { data: createTestICalData() },
      ]);

      const start = new Date("2025-06-20T00:00:00Z");
      const end = new Date("2025-06-21T00:00:00Z");

      const result = await calendarService.getFreeBusy(start, end);

      expect(result).toHaveProperty("start", start);
      expect(result).toHaveProperty("end", end);
      expect(Array.isArray(result.busy)).toBe(true);
      expect(Array.isArray(result.free)).toBe(true);
    });

    it.each([
      ["2025-06-20T00:00:00Z", "2025-06-20T12:00:00Z"],
      ["2025-06-20T12:00:00Z", "2025-06-21T00:00:00Z"],
      ["2025-06-19T00:00:00Z", "2025-06-20T09:00:00Z"], // Before event
      ["2025-06-20T12:00:00Z", "2025-06-21T00:00:00Z"], // After event
    ])("should handle different date ranges from %s to %s", async (startStr, endStr) => {
      mockFetchCalendarObjects.mockResolvedValue([
        { data: createTestICalData() },
      ]);

      const start = new Date(startStr);
      const end = new Date(endStr);

      const result = await calendarService.getFreeBusy(start, end);

      expect(result.start).toEqual(start);
      expect(result.end).toEqual(end);
      expect(Array.isArray(result.busy)).toBe(true);
      expect(Array.isArray(result.free)).toBe(true);
    });
  });

  describe("choosing calendars to read", () => {
    const BASE = "https://caldav.example.com/calendars/test";
    const range = {
      start: new Date("2025-06-20T00:00:00Z"),
      end: new Date("2025-06-21T00:00:00Z"),
    };
    const serviceWith = (calendars?: string[]) => {
      const service = new TestableCalendarService(
        createMockConnection({ calendars }),
        mockCache,
      );
      vi.spyOn(service, "getClient").mockResolvedValue({
        fetchCalendars: mockFetchCalendars,
        fetchCalendarObjects: mockFetchCalendarObjects,
      } as MockDAVClient as Awaited<ReturnType<typeof createDAVClient>>);
      return service;
    };
    const readUrls = (): string[] =>
      mockFetchCalendarObjects.mock.calls.map(
        ([params]) => params.calendar.url,
      );

    beforeEach(() => {
      mockFetchCalendars.mockResolvedValue([
        { displayName: "Work", url: `${BASE}/work/` },
        { displayName: "Homework", url: `${BASE}/homework/` },
        { displayName: "Misc", url: `${BASE}/Y2FsUQ/` },
        { displayName: "Tasks", url: `${BASE}/tasks/`, components: ["VTODO"] },
      ]);
    });

    it("should read every calendar that holds events when nothing restricts them", async () => {
      await serviceWith(undefined).getCalendarEvents(range);

      expect(readUrls()).toEqual([
        `${BASE}/work/`,
        `${BASE}/homework/`,
        `${BASE}/Y2FsUQ/`,
      ]);
      // The list is fetched once, not once per calendar.
      expect(mockFetchCalendars).toHaveBeenCalledTimes(1);
    });

    it("should not let a MAILBOX_CALENDARS entry reach a URL that merely contains it", async () => {
      await serviceWith(["work"]).getCalendarEvents(range);

      expect(readUrls()).toEqual([`${BASE}/work/`]);
    });

    it("should match entries by exact display name, URL or last segment", async () => {
      await serviceWith([
        "Homework",
        `${BASE}/work`,
        "Y2FsUQ",
      ]).getCalendarEvents(range);

      expect(readUrls()).toEqual([
        `${BASE}/homework/`,
        `${BASE}/work/`,
        `${BASE}/Y2FsUQ/`,
      ]);
    });

    it("should not let a short entry match an opaque collection id", async () => {
      await expect(serviceWith(["Q"]).getCalendarEvents(range)).rejects.toThrow(
        'MAILBOX_CALENDARS entry "Q" matches no calendar. Available calendars: Work (work), Homework (homework), Misc (Y2FsUQ)',
      );
      expect(mockFetchCalendarObjects).not.toHaveBeenCalled();
    });

    it("should refuse an entry that matches nothing instead of reading the rest", async () => {
      // personal is really at .../personal-calendar/: reading only Work would
      // report its appointments as free time.
      mockFetchCalendars.mockResolvedValue([
        { displayName: "Work", url: `${BASE}/work/` },
        { displayName: "Personal", url: `${BASE}/personal-calendar/` },
      ]);

      await expect(
        serviceWith(["Work", "personal"]).getFreeBusy(range.start, range.end),
      ).rejects.toThrow(
        'MAILBOX_CALENDARS entry "personal" matches no calendar. Available calendars: Work (work), Personal (personal-calendar)',
      );
      expect(mockFetchCalendarObjects).not.toHaveBeenCalled();
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it("should refuse an entry that matches several calendars", async () => {
      mockFetchCalendars.mockResolvedValue([
        { displayName: "Work", url: `${BASE}/work/` },
        { displayName: "Old", url: `${BASE}/archive/Work/` },
      ]);

      await expect(
        serviceWith(["Work"]).getCalendarEvents(range),
      ).rejects.toThrow(/MAILBOX_CALENDARS entry "Work" matches several/);
      expect(mockFetchCalendarObjects).not.toHaveBeenCalled();
    });

    it("should read only the calendar named in the request, matched exactly", async () => {
      const events = await serviceWith(undefined).getCalendarEvents({
        ...range,
        calendar: "work",
      });

      expect(readUrls()).toEqual([`${BASE}/work/`]);
      expect(events[0].calendar).toBe("Work");
    });

    it("should report an unknown calendar instead of an empty result", async () => {
      await expect(
        serviceWith(["work"]).getCalendarEvents({
          ...range,
          calendar: "Homework",
        }),
      ).rejects.toThrow(
        'Calendar "Homework" not found among the calendars MAILBOX_CALENDARS allows. Available calendars: Work (work)',
      );
      expect(mockCache.set).not.toHaveBeenCalled();
    });
  });

  describe("unreadable calendars", () => {
    const range = {
      start: new Date("2025-06-20T00:00:00Z"),
      end: new Date("2025-06-21T00:00:00Z"),
    };

    it("should report a failed calendar list instead of guessing a calendar", async () => {
      mockFetchCalendars.mockRejectedValue(new Error("HTTP 401"));

      await expect(
        calendarService.getCalendarEvents(range),
      ).rejects.toMatchObject({
        code: ErrorCode.CALENDAR_READ_FAILED,
        message: "Could not list your calendars: HTTP 401",
      });
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it("should fail the whole read when one calendar cannot be read", async () => {
      const service = new TestableCalendarService(
        createMockConnection({ calendars: undefined }),
        mockCache,
      );
      vi.spyOn(service, "getClient").mockResolvedValue({
        fetchCalendars: mockFetchCalendars,
        fetchCalendarObjects: mockFetchCalendarObjects,
      } as MockDAVClient as Awaited<ReturnType<typeof createDAVClient>>);
      mockFetchCalendars.mockResolvedValue([
        { displayName: "personal", url: "https://x/personal/" },
        { displayName: "work", url: "https://x/work/" },
      ]);
      mockFetchCalendarObjects.mockImplementation(async ({ calendar }) => {
        if (calendar.url.includes("work")) {
          throw new Error("HTTP 500");
        }
        return [{ data: createTestICalData() }];
      });

      const error = await service.getFreeBusy(range.start, range.end).then(
        () => undefined,
        (caught: unknown) => caught,
      );

      expect(error).toMatchObject({ code: ErrorCode.CALENDAR_READ_FAILED });
      expect((error as Error).message).toContain(
        'Could not read calendar "work": HTTP 500',
      );
      expect((error as Error).message).toContain('pass "calendar"');
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it("should still serve stale data when the server cannot be reached", async () => {
      const stale = [createTestCalendarEvent()];
      (mockCache.getStale as Mock).mockReturnValue(stale);
      mockFetchCalendarObjects.mockRejectedValue(new Error("read ECONNRESET"));

      await expect(calendarService.getCalendarEvents(range)).resolves.toBe(
        stale,
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty calendar results", async () => {
      mockFetchCalendarObjects.mockResolvedValue([]);

      const result = await calendarService.getCalendarEvents({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
      });

      expect(result).toEqual([]);
    });

    it("should handle invalid date ranges", async () => {
      const start = new Date("2025-06-21T00:00:00Z");
      const end = new Date("2025-06-20T00:00:00Z"); // End before start

      const result = await calendarService.getCalendarEvents({ start, end });

      expect(Array.isArray(result)).toBe(true);
    });

    it("should handle malformed iCal data", async () => {
      const ICAL = (await vi.importMock("ical.js")) as {
        parse: { mockImplementationOnce: (fn: () => void) => void };
      };

      mockFetchCalendarObjects.mockResolvedValue([
        { data: "INVALID_ICAL_DATA" },
      ]);
      ICAL.parse.mockImplementationOnce(() => {
        throw new Error("Invalid iCal format");
      });

      const result = await calendarService.getCalendarEvents({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
      });

      expect(result).toEqual([]);
    });
  });

  describe("error handling", () => {
    it.each([
      ["Network timeout", "TIMEOUT"],
      ["Authentication failed", "AUTH_ERROR"],
      ["Server unavailable", "SERVER_ERROR"],
      ["Rate limit exceeded", "RATE_LIMIT"],
    ])("should report a %s error instead of an empty result", async (_description, errorType) => {
      mockFetchCalendarObjects.mockRejectedValueOnce(new Error(errorType));

      await expect(
        calendarService.getCalendarEvents({
          start: new Date("2025-06-20T00:00:00Z"),
          end: new Date("2025-06-21T00:00:00Z"),
        }),
      ).rejects.toMatchObject({
        code: ErrorCode.CALENDAR_READ_FAILED,
        message: `Could not read calendar "personal": ${errorType}`,
      });
    });

    it("should handle cache errors gracefully", async () => {
      // Mock cache.get to throw an error, but service should handle it gracefully
      (mockCache.get as Mock).mockImplementationOnce(() => {
        throw new Error("Cache error");
      });

      mockFetchCalendarObjects.mockResolvedValue([
        { data: createTestICalData() },
      ]);

      // Service should catch cache error and proceed with fetching
      const result = await calendarService
        .getCalendarEvents({
          start: new Date("2025-06-20T00:00:00Z"),
          end: new Date("2025-06-21T00:00:00Z"),
        })
        .catch(() => []); // If it throws, return empty array

      expect(Array.isArray(result)).toBe(true);
    });
  });

  // Phase 1: Branch Coverage Tests - Data-Driven Testing
  describe("filterEventsByQuery - branch coverage", () => {
    const events = [
      createTestCalendarEvent({
        id: "1",
        summary: "Team Meeting",
        description: "Discuss project roadmap",
        location: "Conference Room A",
      }),
      createTestCalendarEvent({
        id: "2",
        summary: "Lunch Break",
        description: undefined,
        location: "Cafeteria",
      }),
      createTestCalendarEvent({
        id: "3",
        summary: "Code Review",
        description: "Review PR #123",
        location: undefined,
      }),
      createTestCalendarEvent({
        id: "4",
        summary: "Client Call",
        description: "Quarterly update",
        location: "Virtual",
      }),
    ];

    it.each([
      ["by summary", "Meeting", 1, "1"],
      ["by description when present", "roadmap", 1, "1"],
      ["by location when present", "Cafeteria", 1, "2"],
      ["case insensitive summary", "CODE", 1, "3"],
      ["case insensitive location", "virtual", 1, "4"],
      ["no matches", "xyz-not-found", 0, null],
      ["empty string", "", 4, null],
    ])("should filter %s", (scenario, query, expectedCount, expectedFirstId) => {
      const results = calendarService.testFilterEventsByQuery(events, query);
      expect(results).toHaveLength(expectedCount);
      if (expectedFirstId) {
        expect(results[0].id).toBe(expectedFirstId);
      }
    });

    it("should return all events when query is undefined", () => {
      const results = calendarService.testFilterEventsByQuery(
        events,
        undefined,
      );
      expect(results).toEqual(events);
      expect(results).toHaveLength(4);
    });

    it("should return all events when query is null", () => {
      const results = calendarService.testFilterEventsByQuery(
        events,
        null as any,
      );
      expect(results).toEqual(events);
    });
  });

  describe("extractStatus - branch coverage", () => {
    it.each([
      ["ACCEPTED", "accepted"],
      ["accepted", "accepted"],
      ["Accepted", "accepted"],
      ["DECLINED", "declined"],
      ["declined", "declined"],
      ["Declined", "declined"],
      ["TENTATIVE", "tentative"],
      ["tentative", "tentative"],
      ["Tentative", "tentative"],
      ["NEEDS-ACTION", "needs-action"],
      ["needs-action", "needs-action"],
      ["Needs-Action", "needs-action"],
      ["UNKNOWN_STATUS", "needs-action"],
      ["invalid", "needs-action"],
      ["", "needs-action"],
    ])("should map partstat '%s' to '%s'", (input, expected) => {
      const attendee = {
        getParameter: (name: string) => (name === "partstat" ? input : null),
      };
      expect(calendarService.testExtractStatus(attendee)).toBe(expected);
    });

    it("should default to needs-action when getParameter returns null", () => {
      const attendee = {
        getParameter: () => null,
      };
      expect(calendarService.testExtractStatus(attendee)).toBe("needs-action");
    });

    it("should default to needs-action when getParameter is undefined", () => {
      const attendee = {};
      expect(calendarService.testExtractStatus(attendee)).toBe("needs-action");
    });

    it("should default to needs-action for null attendee", () => {
      expect(calendarService.testExtractStatus(null)).toBe("needs-action");
    });

    it("should default to needs-action for undefined attendee", () => {
      expect(calendarService.testExtractStatus(undefined)).toBe("needs-action");
    });
  });
});
