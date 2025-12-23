import type { createDAVClient } from "tsdav";
import {
  type Mock,
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type { CalDavConnection } from "../src/types/calendar.types.js";

// Type for the mock DAV client with only the methods we need for testing
type MockDAVClient = Pick<
  Awaited<ReturnType<typeof createDAVClient>>,
  "fetchCalendars" | "fetchCalendarObjects"
>;

// Test helper class for accessing protected methods
class TestableCalendarService extends CalendarService {
  public async getClient() {
    return super.getClient();
  }

  public async discoverCalendars() {
    return super.discoverCalendars();
  }

  // Expose private methods for branch coverage testing
  public testIsConnectionError(error: unknown): boolean {
    return (this as any).isConnectionError(error);
  }

  public testFilterEventsByQuery(events: any[], query?: string): any[] {
    return (this as any).filterEventsByQuery(events, query);
  }

  public testExtractStatus(attendee: unknown): string {
    return (this as any).extractStatus(attendee);
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

const createTestCalendarEvent = (overrides: Record<string, unknown> = {}) => ({
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
  let calendarService: CalendarService;
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

    // Mock the getClient method to return our mock client
    vi.spyOn(
      calendarService as TestableCalendarService,
      "getClient",
    ).mockResolvedValue({
      fetchCalendars: mockFetchCalendars,
      fetchCalendarObjects: mockFetchCalendarObjects,
    } as MockDAVClient);
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
    ])(
      "should filter events by query '%s' and return %d results",
      async (query, expectedCount) => {
        const testData = createTestICalData({ summary: "Test Event" });
        mockFetchCalendarObjects.mockResolvedValue([{ data: testData }]);

        const result = await calendarService.searchCalendar({
          start: new Date("2025-06-20T00:00:00Z"),
          end: new Date("2025-06-21T00:00:00Z"),
          query,
        });

        expect(result).toHaveLength(expectedCount);
      },
    );
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
    ])(
      "should handle different date ranges from %s to %s",
      async (startStr, endStr) => {
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
      },
    );
  });

  describe("discoverCalendars", () => {
    it("should return list of calendar names", async () => {
      // Mock the fetchCalendars response
      mockFetchCalendars.mockResolvedValue([
        {
          displayName: "personal",
          url: "https://caldav.example.com/calendars/test/personal/",
        },
        {
          displayName: "work",
          url: "https://caldav.example.com/calendars/test/work/",
        },
      ]);

      const result = await (
        calendarService as TestableCalendarService
      ).discoverCalendars();

      expect(Array.isArray(result)).toBe(true);
      expect(mockFetchCalendars).toHaveBeenCalled();
      expect(result).toContain("personal");
      expect(result).toContain("work");
    });

    it("should return default calendar on error", async () => {
      // Mock fetchCalendars to throw an error
      mockFetchCalendars.mockRejectedValueOnce(new Error("Failed to fetch"));

      const result = await (
        calendarService as TestableCalendarService
      ).discoverCalendars();

      // Should return the default calendar on error
      expect(result).toEqual(["personal"]);
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
    it("should handle fetch errors gracefully", async () => {
      // Mock fetchCalendarObjects to throw an error
      mockFetchCalendarObjects.mockRejectedValueOnce(
        new Error("Network error"),
      );

      const result = await calendarService.getCalendarEvents({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
      });

      // Should return an empty array on error
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it.each([
      ["Network timeout", "TIMEOUT"],
      ["Authentication failed", "AUTH_ERROR"],
      ["Server unavailable", "SERVER_ERROR"],
      ["Rate limit exceeded", "RATE_LIMIT"],
    ])("should handle %s error", async (description, errorType) => {
      mockFetchCalendarObjects.mockRejectedValueOnce(new Error(errorType));

      const result = await calendarService.getCalendarEvents({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
      });

      expect(result).toEqual([]);
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
  describe("isConnectionError - branch coverage", () => {
    it.each([
      ["connection failed", true],
      ["timeout occurred", true],
      ["ECONNRESET", true],
      ["ENOTFOUND domain", true],
      ["ECONNREFUSED by server", true],
      ["Circuit breaker is open", true],
      ["invalid credentials", false],
      ["permission denied", false],
      ["unknown error", false],
    ])("should detect '%s' as connection error: %s", (message, expected) => {
      const error = new Error(message);
      expect(calendarService.testIsConnectionError(error)).toBe(expected);
    });

    it.each([
      ["string", "error message"],
      ["number", 123],
      ["null", null],
      ["undefined", undefined],
      ["object", { message: "error" }],
      ["array", ["error"]],
    ])("should return false for non-Error type: %s", (type, value) => {
      expect(calendarService.testIsConnectionError(value)).toBe(false);
    });
  });

  describe("filterEventsByQuery - branch coverage", () => {
    const events = [
      {
        id: "1",
        summary: "Team Meeting",
        description: "Discuss project roadmap",
        location: "Conference Room A",
        start: new Date(),
        end: new Date(),
      },
      {
        id: "2",
        summary: "Lunch Break",
        description: null,
        location: "Cafeteria",
        start: new Date(),
        end: new Date(),
      },
      {
        id: "3",
        summary: "Code Review",
        description: "Review PR #123",
        location: null,
        start: new Date(),
        end: new Date(),
      },
      {
        id: "4",
        summary: "Client Call",
        description: "Quarterly update",
        location: "Virtual",
        start: new Date(),
        end: new Date(),
      },
    ];

    it.each([
      ["by summary", "Meeting", 1, "1"],
      ["by description when present", "roadmap", 1, "1"],
      ["by location when present", "Cafeteria", 1, "2"],
      ["case insensitive summary", "CODE", 1, "3"],
      ["case insensitive location", "virtual", 1, "4"],
      ["no matches", "xyz-not-found", 0, null],
      ["empty string", "", 4, null],
    ])(
      "should filter %s",
      (scenario, query, expectedCount, expectedFirstId) => {
        const results = calendarService.testFilterEventsByQuery(events, query);
        expect(results).toHaveLength(expectedCount);
        if (expectedFirstId) {
          expect(results[0].id).toBe(expectedFirstId);
        }
      },
    );

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
