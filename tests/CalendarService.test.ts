import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LocalCache } from "../src/types/cache.types.js";
import type { CalDavConnection } from "../src/types/calendar.types.js";

// Define mock functions at the top level
const mockFetchCalendars = vi.fn();
const mockFetchCalendarObjects = vi.fn();

// Mock ical.js with proper default export
vi.mock("ical.js", () => {
  const mockICal = {
    parse: vi.fn().mockImplementation(() => [
      [
        ["vcalendar", [], [
          ["vevent", [], []]
        ]]
      ]
    ]),
    Component: class {
      constructor(jcalData: any) {}
      getAllSubcomponents(type: string) {
        if (type === "vevent") {
          return [{}];
        }
        return [];
      }
    },
    Event: class {
      public uid: string;
      public summary: string;
      public description: string;
      public location: string;
      public startDate: { toJSDate: () => Date; isDate: boolean };
      public endDate: { toJSDate: () => Date; isDate: boolean };
      public isRecurring: () => boolean;
      public attendees: any[];
      public organizer: any;
      public component: { getFirstPropertyValue: (prop: string) => any };
      constructor(vevent: any) {
        this.uid = "event1@example.com";
        this.summary = "Test Event";
        this.description = "Test Description";
        this.location = "Test Location";
        this.startDate = {
          toJSDate: () => new Date("2025-06-20T10:00:00Z"),
          isDate: false,
        };
        this.endDate = {
          toJSDate: () => new Date("2025-06-20T11:00:00Z"),
          isDate: false,
        };
        this.isRecurring = () => false;
        this.attendees = [];
        this.organizer = null;
        this.component = {
          getFirstPropertyValue: (prop: string) => {
            if (prop === "rrule") return null;
            if (prop === "categories") return null;
            if (prop === "created") return null;
            if (prop === "last-modified") return null;
            return null;
          },
        };
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
    createDAVClient: vi.fn().mockImplementation(() => new MockDAVClient()),
    DAVClient: MockDAVClient,
  };
});

// Import CalendarService after setting up mocks
import { CalendarService } from "../src/services/CalendarService.js";

// Simple mock cache implementation
const createMockCache = (): LocalCache => ({
  get: vi.fn(),
  set: vi.fn(),
  delete: vi.fn(),
  clear: vi.fn(),
  has: vi.fn(),
  size: vi.fn(),
  cleanup: vi.fn(),
});

describe("CalendarService", () => {
  let calendarService: CalendarService;
  let mockCache: LocalCache;
  let mockConnection: CalDavConnection;

  // Test data
  const testIcalData = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Example Corp.//CalDAV Client//EN
BEGIN:VEVENT
UID:event1@example.com
DTSTAMP:20230619T120000Z
DTSTART:20230620T100000Z
DTEND:20230620T110000Z
SUMMARY:Test Event
END:VEVENT
END:VCALENDAR`;

  const mockCalendarEvents = [
    {
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
    },
  ];

  beforeEach(async () => {
    // Reset all mocks
    vi.clearAllMocks();

    // Setup mock cache
    mockCache = createMockCache();

    // Setup mock connection
    mockConnection = {
      baseUrl: "https://caldav.example.com",
      username: "test@example.com",
      password: "password",
      calendars: ["personal"],
    };

    // Setup mock DAV client responses
    mockFetchCalendars.mockResolvedValue([
      {
        displayName: "personal",
        url: "https://caldav.example.com/calendars/test/personal/",
      },
    ]);
    
    mockFetchCalendarObjects.mockResolvedValue([
      {
        data: testIcalData,
      },
    ]);

    // Create service instance with proper mocks
    calendarService = new CalendarService(mockConnection, mockCache);
    
    // Mock the getClient method to return our mock client
    vi.spyOn(calendarService as any, 'getClient').mockResolvedValue({
      fetchCalendars: mockFetchCalendars,
      fetchCalendarObjects: mockFetchCalendarObjects,
    });
  });

  describe("getCalendarEvents", () => {
    it("should return cached events if available", async () => {
      // Mock cache to return test events
      const cachedEvents = [...mockCalendarEvents];
      const cacheKey = 'calendar_events:{"start":"2025-06-20T00:00:00.000Z","end":"2025-06-21T00:00:00.000Z"}';
      
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
      mockFetchCalendarObjects.mockResolvedValue([{ 
        data: testIcalData,
        url: 'https://caldav.example.com/calendars/test/personal/'
      }]);

      const start = new Date("2025-06-20T00:00:00Z");
      const end = new Date("2025-06-21T00:00:00Z");
      
      const result = await calendarService.getCalendarEvents({ start, end });

      expect(mockFetchCalendarObjects).toHaveBeenCalled();
      expect(Array.isArray(result)).toBe(true);
      
      // Check that we got back the expected event
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toMatchObject({
        id: expect.any(String),
        uid: 'event1@example.com',
        summary: 'Test Event'
      });
      
      // Verify the result was cached
      const cacheKey = `calendar_events:${JSON.stringify({ 
        start: start.toISOString(), 
        end: end.toISOString() 
      })}`;
      
      expect(mockCache.set).toHaveBeenCalledWith(
        cacheKey,
        expect.arrayContaining([
          expect.objectContaining({
            uid: 'event1@example.com',
            summary: 'Test Event'
          })
        ]),
        expect.any(Number)
      );
    });
  });

  describe("searchCalendar", () => {
    it("should filter events by query", async () => {
      // Mock the calendar objects response
      mockFetchCalendarObjects.mockResolvedValue([{ data: testIcalData }]);
      
      const result = await calendarService.searchCalendar({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
        query: "Test",
      });

      expect(Array.isArray(result)).toBe(true);
      expect(mockFetchCalendarObjects).toHaveBeenCalled();
    });
  });

  describe("getFreeBusy", () => {
    it("should return free/busy information", async () => {
      // Mock the calendar objects response
      mockFetchCalendarObjects.mockResolvedValue([{ data: testIcalData }]);
      
      const start = new Date("2025-06-20T00:00:00Z");
      const end = new Date("2025-06-21T00:00:00Z");
      
      const result = await calendarService.getFreeBusy(start, end);

      expect(result).toHaveProperty("start", start);
      expect(result).toHaveProperty("end", end);
      expect(Array.isArray(result.busy)).toBe(true);
      expect(Array.isArray(result.free)).toBe(true);
    });
  });

  describe("discoverCalendars", () => {
    it("should return list of calendar names", async () => {
      // Mock the fetchCalendars response
      mockFetchCalendars.mockResolvedValue([
        { displayName: "personal", url: "https://caldav.example.com/calendars/test/personal/" },
        { displayName: "work", url: "https://caldav.example.com/calendars/test/work/" },
      ]);
      
      const result = await (calendarService as any).discoverCalendars();
      
      expect(Array.isArray(result)).toBe(true);
      expect(mockFetchCalendars).toHaveBeenCalled();
      expect(result).toContain("personal");
      expect(result).toContain("work");
    });

    it("should return default calendar on error", async () => {
      // Mock fetchCalendars to throw an error
      mockFetchCalendars.mockRejectedValueOnce(new Error("Failed to fetch"));
      
      const result = await (calendarService as any).discoverCalendars();
      
      // Should return the default calendar on error
      expect(result).toEqual(["personal"]);
    });
  });

  describe("error handling", () => {
    it("should handle fetch errors gracefully", async () => {
      // Mock fetchCalendarObjects to throw an error
      mockFetchCalendarObjects.mockRejectedValueOnce(new Error("Network error"));
      
      const result = await calendarService.getCalendarEvents({
        start: new Date("2025-06-20T00:00:00Z"),
        end: new Date("2025-06-21T00:00:00Z"),
      });
      
      // Should return an empty array on error
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });
  });
});
