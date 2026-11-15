import ICAL from "ical.js";
import type { createDAVClient } from "tsdav";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type {
  CalDavConnection,
  CreateCalendarEventOptions,
} from "../src/types/calendar.types.js";
import { ErrorCode } from "../src/types/errors.js";

// These tests run the real ical.js: the point is what ends up in the stored
// iCalendar text, which a mocked parser could not show.

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>;

class TestableCalendarService extends CalendarService {
  constructor(
    connection: CalDavConnection,
    cache: LocalCache,
    private readonly davClient: DAVClient,
  ) {
    super(connection, cache);
  }

  protected async getClient(): Promise<DAVClient> {
    return this.davClient;
  }
}

const WORK_URL = "https://dav.mailbox.org/caldav/work/";
const PRIVATE_URL = "https://dav.mailbox.org/caldav/private/";
const TASKS_URL = "https://dav.mailbox.org/caldav/tasks/";

const calendars = [
  { displayName: "work", url: WORK_URL, components: ["VEVENT", "VTODO"] },
  { displayName: "private", url: PRIVATE_URL, components: ["VEVENT"] },
];

describe("CalendarService event changes", () => {
  const fetchCalendars = vi.fn();
  const createCalendarObject = vi.fn();

  let cacheKeys: string[];
  let cache: LocalCache;

  const makeService = (connection: Partial<CalDavConnection> = {}) =>
    new TestableCalendarService(
      {
        baseUrl: "https://dav.mailbox.org/caldav",
        username: "me@mailbox.org",
        password: "secret",
        ...connection,
      },
      cache,
      { fetchCalendars, createCalendarObject } as unknown as DAVClient,
    );

  /** Unfolds iCalendar line folding so assertions can match whole lines. */
  const linesOf = (data: string): string[] =>
    data.replace(/\r\n[ \t]/g, "").split(/\r\n/);

  const createdData = (): string =>
    (createCalendarObject.mock.calls[0][0] as { iCalString: string })
      .iCalString;

  const createdEvent = (): ICAL.Component => {
    const vevent = new ICAL.Component(
      ICAL.parse(createdData()),
    ).getFirstSubcomponent("vevent");
    if (!vevent) {
      throw new Error("no VEVENT written");
    }
    return vevent;
  };

  const newEvent: CreateCalendarEventOptions = {
    summary: "New",
    start: new Date("2025-06-20T10:00:00Z"),
    end: new Date("2025-06-20T11:00:00Z"),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});

    cacheKeys = [];
    cache = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      has: vi.fn(),
      size: vi.fn(),
      cleanup: vi.fn(),
      getStale: vi.fn(),
      getStats: vi.fn(),
      keys: vi.fn(() => cacheKeys.values()),
    };

    fetchCalendars.mockResolvedValue(calendars);
    createCalendarObject.mockResolvedValue(new Response(null, { status: 201 }));
  });

  describe("createCalendarEvent", () => {
    it("should drop cached event reads so the new event shows up", async () => {
      cacheKeys = [
        "calendar_events:a",
        "calendar_search:b",
        "freebusy:c",
        "email_search:d",
      ];

      await makeService().createCalendarEvent(newEvent);

      expect(cache.delete).toHaveBeenCalledTimes(3);
      expect(cache.delete).toHaveBeenCalledWith("calendar_events:a");
      expect(cache.delete).toHaveBeenCalledWith("calendar_search:b");
      expect(cache.delete).toHaveBeenCalledWith("freebusy:c");
    });

    it("should store the event under its UID and return it", async () => {
      const result = await makeService().createCalendarEvent(newEvent);

      const call = createCalendarObject.mock.calls[0][0] as {
        filename: string;
      };
      expect(result.uid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(call.filename).toBe(`${result.uid}.ics`);
      expect(createdEvent().getFirstPropertyValue("uid")).toBe(result.uid);
      expect(result).toMatchObject({
        summary: "New",
        allDay: false,
        calendar: "work",
      });
    });

    it("should give every event its own UID", async () => {
      const first = await makeService().createCalendarEvent(newEvent);
      const second = await makeService().createCalendarEvent(newEvent);

      expect(first.uid).not.toBe(second.uid);
    });

    it("should write a well-formed VCALENDAR with a UTC DTSTAMP", async () => {
      await makeService().createCalendarEvent(newEvent);

      const data = createdData();
      const lines = linesOf(data);
      expect(lines[0]).toBe("BEGIN:VCALENDAR");
      expect(lines).toContain("VERSION:2.0");
      expect(lines).toContain("PRODID:-//mailbox-mcp-server//EN");
      expect(lines.find(line => line.startsWith("DTSTAMP:"))).toMatch(
        /^DTSTAMP:\d{8}T\d{6}Z$/,
      );
      // Every content line ends with CRLF, the last one included.
      expect(data.endsWith("END:VCALENDAR\r\n")).toBe(true);
      expect(data.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
    });

    it("should write timed events in UTC whatever offset they came with", async () => {
      await makeService().createCalendarEvent({
        ...newEvent,
        start: new Date("2025-06-20T10:00:00+02:00"),
        end: new Date("2025-06-20T11:30:00+02:00"),
      });

      const lines = linesOf(createdData());
      expect(lines).toContain("DTSTART:20250620T080000Z");
      expect(lines).toContain("DTEND:20250620T093000Z");
      expect(createdData()).not.toContain("TZID");
    });

    it("should escape TEXT values as RFC 5545 requires", async () => {
      const summary = "Plan; budget, review \\ wrap-up";
      const description = "Line 1\nLine 2\r\nLine 3\rLine 4; a, b \\ c";
      const location = "Room 1, Building A; Floor 2";

      await makeService().createCalendarEvent({
        ...newEvent,
        summary,
        description,
        location,
      });

      const lines = linesOf(createdData());
      expect(lines).toContain("SUMMARY:Plan\\; budget\\, review \\\\ wrap-up");
      expect(lines).toContain(
        "DESCRIPTION:Line 1\\nLine 2\\nLine 3\\nLine 4\\; a\\, b \\\\ c",
      );
      expect(lines).toContain("LOCATION:Room 1\\, Building A\\; Floor 2");

      // And a parser reads back what was meant.
      const vevent = createdEvent();
      expect(vevent.getFirstPropertyValue("summary")).toBe(summary);
      expect(vevent.getFirstPropertyValue("description")).toBe(
        "Line 1\nLine 2\nLine 3\nLine 4; a, b \\ c",
      );
      expect(vevent.getFirstPropertyValue("location")).toBe(location);
    });

    it("should fold lines longer than 75 octets without splitting a character", async () => {
      const description = `${"Grüße aus Berlin – ".repeat(12)}🎉 Ende`;

      await makeService().createCalendarEvent({ ...newEvent, description });

      const physical = createdData().split("\r\n");
      for (const line of physical) {
        expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      }
      expect(
        physical.filter(line => line.startsWith(" ")).length,
      ).toBeGreaterThanOrEqual(3);
      // No replacement characters: every split fell between characters.
      expect(createdData()).not.toContain("�");
      expect(createdEvent().getFirstPropertyValue("description")).toBe(
        description,
      );
    });

    it("should quote attendee names so separators in them survive", async () => {
      const name = 'Doe, John: "JD"; Team';

      await makeService().createCalendarEvent({
        ...newEvent,
        attendees: [{ email: "doe@example.com", name }],
      });

      const attendees = createdEvent().getAllProperties("attendee");
      expect(attendees).toHaveLength(1);
      expect(attendees[0].getFirstValue()).toBe("mailto:doe@example.com");
      expect(attendees[0].getParameter("cn")).toBe(name);
    });

    it("should name the account as organizer when there are attendees", async () => {
      await makeService().createCalendarEvent({
        ...newEvent,
        attendees: [{ email: "doe@example.com" }],
      });

      expect(createdEvent().getFirstPropertyValue("organizer")).toBe(
        "mailto:me@mailbox.org",
      );
    });

    it("should not add an organizer to an event without attendees", async () => {
      await makeService().createCalendarEvent(newEvent);

      expect(createdEvent().hasProperty("organizer")).toBe(false);
      expect(createdEvent().hasProperty("attendee")).toBe(false);
    });

    describe("all-day events", () => {
      it("should write an all-day date as the caller wrote it, not its UTC date", async () => {
        const result = await makeService().createCalendarEvent({
          summary: "Holiday",
          allDay: true,
          start: new Date("2025-06-20T22:00:00Z"),
          end: new Date("2025-06-21T22:00:00Z"),
          startDate: "2025-06-21",
          endDate: "2025-06-22",
        });

        const lines = linesOf(createdData());
        expect(lines).toContain("DTSTART;VALUE=DATE:20250621");
        expect(lines).toContain("DTEND;VALUE=DATE:20250622");
        expect(result).toMatchObject({
          allDay: true,
          startDate: "2025-06-21",
          endDate: "2025-06-22",
        });

        const event = new ICAL.Event(createdEvent());
        expect(event.startDate.isDate).toBe(true);
        expect(event.endDate.isDate).toBe(true);
      });

      it("should fall back to the UTC date when no written date is given", async () => {
        await makeService().createCalendarEvent({
          summary: "Holiday",
          allDay: true,
          start: new Date("2025-07-04T00:00:00Z"),
          end: new Date("2025-07-06T00:00:00Z"),
        });

        const lines = linesOf(createdData());
        expect(lines).toContain("DTSTART;VALUE=DATE:20250704");
        expect(lines).toContain("DTEND;VALUE=DATE:20250706");
      });

      it("should make a same-day all-day event last one day, since DTEND is exclusive", async () => {
        const result = await makeService().createCalendarEvent({
          summary: "Holiday",
          allDay: true,
          start: new Date("2025-12-31T00:00:00Z"),
          end: new Date("2025-12-31T00:00:00Z"),
          startDate: "2025-12-31",
          endDate: "2025-12-31",
        });

        const lines = linesOf(createdData());
        expect(lines).toContain("DTSTART;VALUE=DATE:20251231");
        expect(lines).toContain("DTEND;VALUE=DATE:20260101");
        expect(result.endDate).toBe("2026-01-01");
      });
    });

    describe("server responses", () => {
      it("should report a write the server rejected instead of success", async () => {
        cacheKeys = ["calendar_events:a"];
        createCalendarObject.mockResolvedValue(
          new Response(null, { status: 403 }),
        );

        await expect(
          makeService().createCalendarEvent(newEvent),
        ).rejects.toMatchObject({
          code: ErrorCode.EVENT_WRITE_REJECTED,
          message: expect.stringContaining("HTTP 403"),
        });
        expect(cache.delete).not.toHaveBeenCalled();
      });

      it("should not mistake a taken name for a concurrent edit", async () => {
        createCalendarObject.mockResolvedValue(
          new Response(null, { status: 412 }),
        );

        await expect(
          makeService().createCalendarEvent(newEvent),
        ).rejects.toMatchObject({ code: ErrorCode.EVENT_WRITE_REJECTED });
      });

      it("should propagate network failures", async () => {
        createCalendarObject.mockRejectedValue(new Error("ECONNRESET"));

        await expect(
          makeService().createCalendarEvent(newEvent),
        ).rejects.toThrow("ECONNRESET");
      });
    });

    describe("calendar choice", () => {
      const writtenTo = (): string =>
        (
          createCalendarObject.mock.calls[0][0] as {
            calendar: { url: string };
          }
        ).calendar.url;

      it("should write to the first calendar when nothing restricts the choice", async () => {
        await makeService().createCalendarEvent(newEvent);

        expect(writtenTo()).toBe(WORK_URL);
      });

      it("should skip calendars that cannot hold events", async () => {
        fetchCalendars.mockResolvedValue([
          { displayName: "tasks", url: TASKS_URL, components: ["VTODO"] },
          ...calendars,
        ]);

        await makeService().createCalendarEvent(newEvent);

        expect(writtenTo()).toBe(WORK_URL);
      });

      it("should refuse to write when no calendar can hold events", async () => {
        fetchCalendars.mockResolvedValue([
          { displayName: "tasks", url: TASKS_URL, components: ["VTODO"] },
        ]);

        await expect(
          makeService().createCalendarEvent(newEvent),
        ).rejects.toThrow(/No calendar that can hold events/);
        expect(createCalendarObject).not.toHaveBeenCalled();
      });

      it("should write to the calendar named in the request", async () => {
        const result = await makeService().createCalendarEvent({
          ...newEvent,
          calendar: "private",
        });

        expect(writtenTo()).toBe(PRIVATE_URL);
        expect(result.calendar).toBe("private");
      });

      it("should refuse an unknown calendar name", async () => {
        await expect(
          makeService().createCalendarEvent({
            ...newEvent,
            calendar: "holidays",
          }),
        ).rejects.toThrow('Calendar "holidays" not found');

        expect(createCalendarObject).not.toHaveBeenCalled();
      });

      it("should refuse a name that matches several calendars", async () => {
        await expect(
          makeService().createCalendarEvent({
            ...newEvent,
            calendar: "caldav",
          }),
        ).rejects.toThrow(/matches several calendars/);

        expect(createCalendarObject).not.toHaveBeenCalled();
      });

      it("should prefer an exact display name over URL matches", async () => {
        fetchCalendars.mockResolvedValue([
          { displayName: "Work archive", url: `${WORK_URL}archive/` },
          ...calendars,
        ]);

        await makeService().createCalendarEvent({
          ...newEvent,
          calendar: "work",
        });

        expect(writtenTo()).toBe(WORK_URL);
      });

      describe("MAILBOX_CALENDARS", () => {
        it("should default to the first calendar MAILBOX_CALENDARS allows", async () => {
          const result = await makeService({
            calendars: ["private"],
          }).createCalendarEvent(newEvent);

          expect(writtenTo()).toBe(PRIVATE_URL);
          expect(result.calendar).toBe("private");
        });

        it("should default in the order MAILBOX_CALENDARS lists, not the server's", async () => {
          await makeService({
            calendars: ["private", "work"],
          }).createCalendarEvent(newEvent);

          expect(writtenTo()).toBe(PRIVATE_URL);
        });

        it("should tolerate spaces around configured names", async () => {
          await makeService({
            calendars: [" work", " private"],
          }).createCalendarEvent({ ...newEvent, calendar: "private" });

          expect(writtenTo()).toBe(PRIVATE_URL);
        });

        it("should accept a named calendar that MAILBOX_CALENDARS allows", async () => {
          await makeService({
            calendars: ["work", "private"],
          }).createCalendarEvent({ ...newEvent, calendar: "private" });

          expect(writtenTo()).toBe(PRIVATE_URL);
        });

        it("should refuse a named calendar outside MAILBOX_CALENDARS", async () => {
          await expect(
            makeService({ calendars: ["work"] }).createCalendarEvent({
              ...newEvent,
              calendar: "private",
            }),
          ).rejects.toThrow(/Calendar "private" not found.*MAILBOX_CALENDARS/);

          expect(createCalendarObject).not.toHaveBeenCalled();
        });

        it("should refuse a URL fragment that reaches an excluded calendar", async () => {
          await expect(
            makeService({ calendars: ["work"] }).createCalendarEvent({
              ...newEvent,
              calendar: "/caldav/private/",
            }),
          ).rejects.toThrow(/not found/);

          expect(createCalendarObject).not.toHaveBeenCalled();
        });

        it("should not write when MAILBOX_CALENDARS matches no calendar", async () => {
          await expect(
            makeService({ calendars: ["holidays"] }).createCalendarEvent(
              newEvent,
            ),
          ).rejects.toThrow(/MAILBOX_CALENDARS/);

          expect(createCalendarObject).not.toHaveBeenCalled();
        });
      });

      it("should not count a wrong calendar name as a server failure", async () => {
        const service = makeService();
        for (let i = 0; i < 5; i++) {
          await expect(
            service.createCalendarEvent({ ...newEvent, calendar: "nope" }),
          ).rejects.toThrow();
        }

        await expect(
          service.createCalendarEvent(newEvent),
        ).resolves.toMatchObject({ calendar: "work" });
      });
    });
  });
});
