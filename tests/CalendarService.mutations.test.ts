import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import ICAL from "ical.js";
import {
  type createDAVClient,
  createCalendarObject as tsdavCreateCalendarObject,
  deleteCalendarObject as tsdavDeleteCalendarObject,
  updateCalendarObject as tsdavUpdateCalendarObject,
} from "tsdav";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
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

const vcalendar = (...vevents: string[][]): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//test//EN",
    ...vevents.flat(),
    "END:VCALENDAR",
  ].join("\r\n");

const BERLIN = [
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Berlin",
  "BEGIN:STANDARD",
  "DTSTART:19701025T030000",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "BEGIN:DAYLIGHT",
  "DTSTART:19700329T020000",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "END:VTIMEZONE",
];

const meeting = (uid = "evt-1", extra: string[] = []): string[] => [
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "DTSTAMP:20250101T000000Z",
  "DTSTART:20250620T100000Z",
  "DTEND:20250620T110000Z",
  "SUMMARY:Team meeting",
  "DESCRIPTION:Weekly sync",
  "LOCATION:Room 1",
  "SEQUENCE:2",
  ...extra,
  "END:VEVENT",
];

const richSeries = vcalendar(BERLIN, [
  "BEGIN:VEVENT",
  "UID:evt-1",
  "DTSTAMP:20250101T000000Z",
  "DTSTART;TZID=Europe/Berlin:20250620T100000",
  "DURATION:PT1H",
  "SUMMARY:Standup\\, daily",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "SEQUENCE:2",
  "ATTENDEE;CN=Alice;PARTSTAT=ACCEPTED;SCHEDULE-AGENT=CLIENT:mailto:alice@example.com",
  "ATTENDEE;CN=Carol;SCHEDULE-AGENT=CLIENT:mailto:carol@example.com",
  "BEGIN:VALARM",
  "ACTION:DISPLAY",
  "TRIGGER:-PT15M",
  "DESCRIPTION:Reminder",
  "END:VALARM",
  "END:VEVENT",
]);

const stored = (data: string, name = "evt-1", base = WORK_URL) => ({
  url: `${base}${name}.ics`,
  etag: '"etag-1"',
  data,
});

const uidQueriedBy = (filters: unknown): string | undefined =>
  (
    filters as
      | {
          "comp-filter"?: {
            "comp-filter"?: {
              "prop-filter"?: { "text-match"?: { _text?: string } };
            };
          };
        }
      | undefined
  )?.["comp-filter"]?.["comp-filter"]?.["prop-filter"]?.["text-match"]?._text;

/** A local HTTP server that records requests and answers with a status. */
const recordingServer = async (status: number) => {
  const requests: Array<{
    method?: string;
    url?: string;
    headers: IncomingHttpHeaders;
    body: string;
  }> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body,
      });
      response.statusCode = status;
      response.end();
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    requests,
    base: `http://127.0.0.1:${port}/caldav/work/`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
};

describe("CalendarService event changes", () => {
  const fetchCalendars = vi.fn();
  const createCalendarObject = vi.fn();
  const fetchCalendarObjects = vi.fn();
  const updateCalendarObject = vi.fn();
  const deleteCalendarObject = vi.fn();
  const fetchCalendarUserAddresses = vi.fn();

  let cacheKeys: string[];
  let cache: LocalCache;
  let objectsByCalendar: Record<string, ReturnType<typeof stored>[]>;

  const makeService = (connection: Partial<CalDavConnection> = {}) =>
    new TestableCalendarService(
      {
        baseUrl: "https://dav.mailbox.org/caldav",
        username: "me@mailbox.org",
        password: "secret",
        ...connection,
      },
      cache,
      {
        fetchCalendars,
        createCalendarObject,
        fetchCalendarObjects,
        updateCalendarObject,
        deleteCalendarObject,
        fetchCalendarUserAddresses,
      } as unknown as DAVClient,
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

    objectsByCalendar = {
      [WORK_URL]: [stored(vcalendar(meeting()))],
      [PRIVATE_URL]: [],
    };
    // A server that honours the UID filter.
    fetchCalendarObjects.mockImplementation(
      async ({
        calendar,
        filters,
      }: {
        calendar: { url: string };
        filters?: unknown;
      }) => {
        const objects = objectsByCalendar[calendar.url] ?? [];
        const uid = uidQueriedBy(filters);
        return uid
          ? objects.filter(object => object.data.includes(`UID:${uid}`))
          : objects;
      },
    );
    updateCalendarObject.mockResolvedValue(new Response(null, { status: 204 }));
    deleteCalendarObject.mockResolvedValue(new Response(null, { status: 204 }));
    fetchCalendarUserAddresses.mockResolvedValue(["mailto:me@mailbox.org"]);
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

    describe("invitations", () => {
      const attendees = [
        { email: "doe@example.com", name: "John Doe" },
        { email: "roe@example.com" },
      ];

      it("should only record attendees by default, with server scheduling declined", async () => {
        await makeService().createCalendarEvent({ ...newEvent, attendees });

        const vevent = createdEvent();
        expect(vevent.hasProperty("organizer")).toBe(false);
        const written = vevent.getAllProperties("attendee");
        expect(written.map(a => a.getFirstValue())).toEqual([
          "mailto:doe@example.com",
          "mailto:roe@example.com",
        ]);
        for (const attendee of written) {
          expect(attendee.getParameter("schedule-agent")).toBe("CLIENT");
        }
        expect(written[0].getParameter("cn")).toBe("John Doe");
      });

      it("should name the account as organizer and leave scheduling to the server when asked", async () => {
        await makeService().createCalendarEvent({
          ...newEvent,
          attendees,
          sendInvitations: true,
        });

        const vevent = createdEvent();
        expect(vevent.getFirstPropertyValue("organizer")).toBe(
          "mailto:me@mailbox.org",
        );
        const written = vevent.getAllProperties("attendee");
        expect(written).toHaveLength(2);
        for (const attendee of written) {
          expect(attendee.getParameter("schedule-agent")).toBeUndefined();
        }
      });

      it("should refuse to send invitations without a usable account address", async () => {
        await expect(
          makeService({ username: "not-an-address" }).createCalendarEvent({
            ...newEvent,
            attendees,
            sendInvitations: true,
          }),
        ).rejects.toThrow(/mail address/);
        expect(createCalendarObject).not.toHaveBeenCalled();
      });

      it("should refuse the account's own address as an invited attendee", async () => {
        await expect(
          makeService().createCalendarEvent({
            ...newEvent,
            attendees: [{ email: "Me@Mailbox.org" }],
            sendInvitations: true,
          }),
        ).rejects.toThrow(/organizer/);
        expect(createCalendarObject).not.toHaveBeenCalled();
      });

      it("should write neither organizer nor attendees for an event without attendees", async () => {
        await makeService().createCalendarEvent({
          ...newEvent,
          sendInvitations: true,
        });

        expect(createdEvent().hasProperty("organizer")).toBe(false);
        expect(createdEvent().hasProperty("attendee")).toBe(false);
      });
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

      it("should send the PUT with If-None-Match: * so nothing is overwritten", async () => {
        const requests: Array<{
          method?: string;
          headers: IncomingHttpHeaders;
        }> = [];
        const server = createServer((request, response) => {
          requests.push({ method: request.method, headers: request.headers });
          request.resume();
          request.on("end", () => {
            response.statusCode = 201;
            response.end();
          });
        });
        await new Promise<void>(resolve =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const { port } = server.address() as AddressInfo;
        const url = `http://127.0.0.1:${port}/caldav/work/`;

        try {
          fetchCalendars.mockResolvedValue([
            { displayName: "work", url, components: ["VEVENT"] },
          ]);
          // The real tsdav request, so a header the service passed (or
          // excluded) would show up on the wire.
          createCalendarObject.mockImplementation(tsdavCreateCalendarObject);

          const result = await makeService().createCalendarEvent(newEvent);

          expect(requests).toHaveLength(1);
          expect(requests[0].method).toBe("PUT");
          expect(requests[0].headers["if-none-match"]).toBe("*");
          expect(requests[0].headers["content-type"]).toContain(
            "text/calendar",
          );
          expect(createCalendarObject.mock.calls[0][0]).toEqual({
            calendar: expect.objectContaining({ url }),
            filename: `${result.uid}.ics`,
            iCalString: expect.any(String),
          });
        } finally {
          await new Promise(resolve => server.close(resolve));
        }
      });

      it("should count server errors towards opening the circuit", async () => {
        const service = makeService();
        createCalendarObject.mockResolvedValue(
          new Response(null, { status: 503 }),
        );
        for (let i = 0; i < 3; i++) {
          await expect(
            service.createCalendarEvent(newEvent),
          ).rejects.toMatchObject({
            code: ErrorCode.EVENT_WRITE_REJECTED,
            message: expect.stringContaining("HTTP 503"),
          });
        }

        createCalendarObject.mockResolvedValue(
          new Response(null, { status: 201 }),
        );
        await expect(service.createCalendarEvent(newEvent)).rejects.toThrow(
          /Circuit breaker is OPEN/,
        );
        expect(createCalendarObject).toHaveBeenCalledTimes(3);
      });

      it("should not count refusals by the server towards opening the circuit", async () => {
        const service = makeService();
        createCalendarObject.mockResolvedValue(
          new Response(null, { status: 403 }),
        );
        for (let i = 0; i < 5; i++) {
          await expect(service.createCalendarEvent(newEvent)).rejects.toThrow(
            /HTTP 403/,
          );
        }

        createCalendarObject.mockResolvedValue(
          new Response(null, { status: 201 }),
        );
        await expect(
          service.createCalendarEvent(newEvent),
        ).resolves.toMatchObject({ calendar: "work" });
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
        ).rejects.toThrow(
          'Calendar "holidays" not found. Available calendars: work (work), private (private)',
        );

        expect(createCalendarObject).not.toHaveBeenCalled();
      });

      it("should find a calendar by its exact URL or last path segment", async () => {
        fetchCalendars.mockResolvedValue([
          ...calendars,
          {
            displayName: "Family",
            url: "https://dav.mailbox.org/caldav/fam-123/",
          },
        ]);

        await makeService().createCalendarEvent({
          ...newEvent,
          calendar: "fam-123",
        });
        await makeService().createCalendarEvent({
          ...newEvent,
          calendar: "https://dav.mailbox.org/caldav/private",
        });

        expect(createCalendarObject.mock.calls[0][0].calendar.displayName).toBe(
          "Family",
        );
        expect(createCalendarObject.mock.calls[1][0].calendar.url).toBe(
          PRIVATE_URL,
        );
      });

      it("should not match part of a name or URL", async () => {
        for (const partial of ["wor", "caldav", "/caldav/private/", "fam"]) {
          await expect(
            makeService().createCalendarEvent({
              ...newEvent,
              calendar: partial,
            }),
          ).rejects.toThrow(/not found/);
        }
        expect(createCalendarObject).not.toHaveBeenCalled();
      });

      it("should refuse a name that matches several calendars", async () => {
        fetchCalendars.mockResolvedValue([
          ...calendars,
          { displayName: "work", url: "https://dav.mailbox.org/caldav/w2/" },
        ]);

        await expect(
          makeService().createCalendarEvent({ ...newEvent, calendar: "work" }),
        ).rejects.toThrow(/matches several calendars/);

        expect(createCalendarObject).not.toHaveBeenCalled();
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

        it("should not let an entry allow calendars whose URL merely contains it", async () => {
          fetchCalendars.mockResolvedValue([
            {
              displayName: "Homework",
              url: "https://dav.mailbox.org/caldav/homework/",
            },
            ...calendars,
          ]);

          await expect(
            makeService({ calendars: ["work"] }).createCalendarEvent({
              ...newEvent,
              calendar: "Homework",
            }),
          ).rejects.toThrow(/not found/);
          const result = await makeService({
            calendars: ["work"],
          }).createCalendarEvent(newEvent);

          expect(result.calendar).toBe("work");
        });

        it("should not let a short entry match an opaque collection id", async () => {
          fetchCalendars.mockResolvedValue([
            {
              displayName: "Misc",
              url: "https://dav.mailbox.org/caldav/Y2FsUQ/",
            },
          ]);

          await expect(
            makeService({ calendars: ["Q"] }).createCalendarEvent(newEvent),
          ).rejects.toThrow(/MAILBOX_CALENDARS/);
          expect(createCalendarObject).not.toHaveBeenCalled();
        });

        it("should refuse an entry that matches several calendars", async () => {
          fetchCalendars.mockResolvedValue([
            ...calendars,
            {
              displayName: "Archive",
              url: "https://dav.mailbox.org/caldav/work/old/work/",
            },
          ]);

          await expect(
            makeService({ calendars: ["work"] }).createCalendarEvent(newEvent),
          ).rejects.toThrow(/MAILBOX_CALENDARS entry "work" matches several/);
          expect(createCalendarObject).not.toHaveBeenCalled();
        });

        it("should refuse an entry that matches nothing even when others match", async () => {
          await expect(
            makeService({
              calendars: ["work", "holidays"],
            }).createCalendarEvent(newEvent),
          ).rejects.toThrow(
            'MAILBOX_CALENDARS entry "holidays" matches no calendar. Available calendars: work (work), private (private)',
          );
          await expect(
            makeService({
              calendars: ["work", "holidays"],
            }).deleteCalendarEvent({ uid: "evt-1" }),
          ).rejects.toThrow(/entry "holidays" matches no calendar/);
          expect(createCalendarObject).not.toHaveBeenCalled();
          expect(deleteCalendarObject).not.toHaveBeenCalled();
        });

        it("should list the available calendars when an entry is ambiguous", async () => {
          fetchCalendars.mockResolvedValue([
            ...calendars,
            {
              displayName: "Archive",
              url: "https://dav.mailbox.org/caldav/work/old/work/",
            },
          ]);

          await expect(
            makeService({ calendars: ["work"] }).createCalendarEvent(newEvent),
          ).rejects.toThrow(
            "Available calendars: work (work), private (private), Archive (work)",
          );
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

  const writtenData = (): string =>
    (
      updateCalendarObject.mock.calls[0][0] as {
        calendarObject: { data: string };
      }
    ).calendarObject.data;

  const writtenEvent = (): ICAL.Component => {
    const root = new ICAL.Component(ICAL.parse(writtenData()));
    const vevent = root
      .getAllSubcomponents("vevent")
      .find(v => !v.hasProperty("recurrence-id"));
    if (!vevent) {
      throw new Error("no series VEVENT written");
    }
    return vevent;
  };

  describe("updateCalendarEvent", () => {
    it("should write the edited event back to the object it found, with its etag", async () => {
      const { event, notified } = await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Renamed",
      });

      expect(updateCalendarObject).toHaveBeenCalledTimes(1);
      expect(updateCalendarObject).toHaveBeenCalledWith({
        calendarObject: expect.objectContaining({
          url: `${WORK_URL}evt-1.ics`,
          // The etag rides along so tsdav sends If-Match.
          etag: '"etag-1"',
        }),
      });
      expect(writtenEvent().getFirstPropertyValue("summary")).toBe("Renamed");
      expect(event).toMatchObject({
        uid: "evt-1",
        summary: "Renamed",
        calendar: "work",
      });
      expect(notified).toBe(false);
    });

    it("should send the PUT with If-Match on the wire", async () => {
      const server = await recordingServer(204);
      try {
        objectsByCalendar[WORK_URL] = [
          stored(vcalendar(meeting()), "evt-1", server.base),
        ];
        updateCalendarObject.mockImplementation(tsdavUpdateCalendarObject);

        await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "Renamed",
        });

        expect(server.requests).toHaveLength(1);
        expect(server.requests[0].method).toBe("PUT");
        expect(server.requests[0].url).toBe("/caldav/work/evt-1.ics");
        expect(server.requests[0].headers["if-match"]).toBe('"etag-1"');
        expect(server.requests[0].headers["content-type"]).toContain(
          "text/calendar",
        );
        const vevent = new ICAL.Component(
          ICAL.parse(server.requests[0].body),
        ).getFirstSubcomponent("vevent");
        expect(vevent?.getFirstPropertyValue("summary")).toBe("Renamed");
      } finally {
        await server.close();
      }
    });

    it("should look the event up by UID on the server", async () => {
      await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Renamed",
      });

      const queried = fetchCalendarObjects.mock.calls.map(([params]) =>
        uidQueriedBy(params.filters),
      );
      expect(queried).toContain("evt-1");
    });

    it("should change only the fields it is given", async () => {
      await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Renamed",
      });

      const lines = linesOf(writtenData());
      expect(lines).toContain("DESCRIPTION:Weekly sync");
      expect(lines).toContain("LOCATION:Room 1");
      expect(lines).toContain("DTSTART:20250620T100000Z");
      expect(lines).toContain("DTEND:20250620T110000Z");
    });

    it("should bump SEQUENCE and the modification stamps", async () => {
      await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Renamed",
      });

      const lines = linesOf(writtenData());
      expect(lines).toContain("SEQUENCE:3");
      expect(lines.some(line => line.startsWith("LAST-MODIFIED:"))).toBe(true);
      expect(lines).not.toContain("DTSTAMP:20250101T000000Z");
    });

    it("should remove description and location when given an empty string", async () => {
      await makeService().updateCalendarEvent({
        uid: "evt-1",
        description: "",
        location: "",
      });

      expect(writtenEvent().hasProperty("description")).toBe(false);
      expect(writtenEvent().hasProperty("location")).toBe(false);
    });

    it("should escape and fold text so a parser reads back what was meant", async () => {
      const description = `Plan; review, retro \\ ${"Grüße – ".repeat(20)}\nNext line`;

      await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Plan; review, retro",
        description,
      });

      expect(linesOf(writtenData())).toContain(
        "SUMMARY:Plan\\; review\\, retro",
      );
      expect(writtenEvent().getFirstPropertyValue("description")).toBe(
        description,
      );
      for (const line of writtenData().split("\r\n")) {
        expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
      }
      expect(writtenData().endsWith("END:VCALENDAR\r\n")).toBe(true);
    });

    it("should keep alarms, recurrence and time zone when only the title changes", async () => {
      objectsByCalendar[WORK_URL] = [stored(richSeries)];

      const { event } = await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Renamed",
      });

      const lines = linesOf(writtenData());
      expect(lines).toContain("RRULE:FREQ=WEEKLY;COUNT=4");
      expect(lines).toContain("TRIGGER:-PT15M");
      expect(lines).toContain("DTSTART;TZID=Europe/Berlin:20250620T100000");
      expect(lines).toContain("DURATION:PT1H");
      expect(lines).toContain("TZID:Europe/Berlin");
      expect(event.recurring).toBe(true);
    });

    it("should write moved times in UTC and drop the old TZID and DURATION", async () => {
      objectsByCalendar[WORK_URL] = [
        stored(
          vcalendar(BERLIN, [
            "BEGIN:VEVENT",
            "UID:evt-1",
            "DTSTAMP:20250101T000000Z",
            "DTSTART;TZID=Europe/Berlin:20250620T100000",
            "DURATION:PT1H",
            "SUMMARY:Single",
            "END:VEVENT",
          ]),
        ),
      ];

      const { event } = await makeService().updateCalendarEvent({
        uid: "evt-1",
        start: new Date("2025-06-21T09:00:00Z"),
        end: new Date("2025-06-21T10:30:00Z"),
      });

      const lines = linesOf(writtenData());
      expect(lines).toContain("DTSTART:20250621T090000Z");
      expect(lines).toContain("DTEND:20250621T103000Z");
      expect(lines.some(line => line.startsWith("DTSTART;TZID"))).toBe(false);
      expect(lines.some(line => line.startsWith("DURATION"))).toBe(false);
      expect(event.start).toEqual(new Date("2025-06-21T09:00:00Z"));
      expect(event.end).toEqual(new Date("2025-06-21T10:30:00Z"));
    });

    it("should keep the stored end when only the start moves, and refuse an inverted range", async () => {
      await expect(
        makeService().updateCalendarEvent({
          uid: "evt-1",
          start: new Date("2025-06-20T12:00:00Z"),
        }),
      ).rejects.toThrow("Start date must be before end date");
      expect(updateCalendarObject).not.toHaveBeenCalled();

      await makeService().updateCalendarEvent({
        uid: "evt-1",
        start: new Date("2025-06-20T09:30:00Z"),
      });
      const lines = linesOf(writtenData());
      expect(lines).toContain("DTSTART:20250620T093000Z");
      expect(lines).toContain("DTEND:20250620T110000Z");
    });

    it("should turn a timed event into an all-day event from dates as written", async () => {
      const { event } = await makeService().updateCalendarEvent({
        uid: "evt-1",
        allDay: true,
        startDate: "2025-06-21",
        endDate: "2025-06-23",
      });

      const lines = linesOf(writtenData());
      expect(lines).toContain("DTSTART;VALUE=DATE:20250621");
      expect(lines).toContain("DTEND;VALUE=DATE:20250623");
      expect(event.allDay).toBe(true);
    });

    it("should make an all-day event without end last one day", async () => {
      await makeService().updateCalendarEvent({
        uid: "evt-1",
        allDay: true,
        startDate: "2025-12-31",
      });

      const lines = linesOf(writtenData());
      expect(lines).toContain("DTSTART;VALUE=DATE:20251231");
      expect(lines).toContain("DTEND;VALUE=DATE:20260101");
    });

    it.each([
      [
        "a date-time for an all-day event",
        { allDay: true, start: new Date("2025-06-21T00:00:00Z") },
        /All-day events take dates/,
      ],
      [
        "a date for a timed event",
        { startDate: "2025-06-21" },
        /Timed events need a date-time/,
      ],
      ["allDay without a start", { allDay: true }, /start is required/],
      [
        "a timed switch without an end",
        {},
        /end is required when turning an all-day event/,
      ],
    ])("should refuse %s", async (_label, change, message) => {
      if (Object.keys(change).length === 0) {
        objectsByCalendar[WORK_URL] = [
          stored(
            vcalendar([
              "BEGIN:VEVENT",
              "UID:evt-1",
              "DTSTAMP:20250101T000000Z",
              "DTSTART;VALUE=DATE:20250620",
              "DTEND;VALUE=DATE:20250621",
              "SUMMARY:Holiday",
              "END:VEVENT",
            ]),
          ),
        ];
        Object.assign(change, {
          allDay: false,
          start: new Date("2025-06-20T10:00:00Z"),
        });
      }

      await expect(
        makeService().updateCalendarEvent({ uid: "evt-1", ...change }),
      ).rejects.toThrow(message);
      expect(updateCalendarObject).not.toHaveBeenCalled();
    });

    it("should refuse to move a recurring series", async () => {
      objectsByCalendar[WORK_URL] = [stored(richSeries)];

      await expect(
        makeService().updateCalendarEvent({
          uid: "evt-1",
          start: new Date("2025-06-20T09:00:00Z"),
          end: new Date("2025-06-20T10:00:00Z"),
        }),
      ).rejects.toThrow(/Moving a recurring series is not supported/);
      expect(updateCalendarObject).not.toHaveBeenCalled();
    });

    it("should leave overrides of single occurrences untouched", async () => {
      objectsByCalendar[WORK_URL] = [
        stored(
          vcalendar(
            [
              "BEGIN:VEVENT",
              "UID:evt-1",
              "DTSTAMP:20250101T000000Z",
              "DTSTART:20250620T100000Z",
              "DTEND:20250620T110000Z",
              "SUMMARY:Series",
              "RRULE:FREQ=DAILY;COUNT=3",
              "END:VEVENT",
            ],
            [
              "BEGIN:VEVENT",
              "UID:evt-1",
              "DTSTAMP:20250101T000000Z",
              "RECURRENCE-ID:20250621T100000Z",
              "DTSTART:20250621T120000Z",
              "DTEND:20250621T130000Z",
              "SUMMARY:Moved occurrence",
              "END:VEVENT",
            ],
          ),
        ),
      ];

      await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Renamed series",
      });

      const lines = linesOf(writtenData());
      expect(lines).toContain("SUMMARY:Renamed series");
      expect(lines).toContain("SUMMARY:Moved occurrence");
    });

    describe("occurrence ids", () => {
      it.each([
        "weekly@example.com:2025-06-20T10:00:00.000Z",
        "birthday@example.com:2026-08-01",
      ])("should refuse the occurrence id %s and name the series UID", async id => {
        const series = id.slice(0, id.indexOf(":"));

        await expect(
          makeService().updateCalendarEvent({ uid: id, summary: "x" }),
        ).rejects.toThrow(`pass uid "${series}"`);
        await expect(
          makeService().deleteCalendarEvent({ uid: id }),
        ).rejects.toThrow(/acts on the whole series/);

        expect(fetchCalendars).not.toHaveBeenCalled();
        expect(updateCalendarObject).not.toHaveBeenCalled();
        expect(deleteCalendarObject).not.toHaveBeenCalled();
      });

      it("should accept a UID that merely contains a colon", async () => {
        objectsByCalendar[WORK_URL] = [
          stored(vcalendar(meeting("urn:uuid:1234"))),
        ];

        await expect(
          makeService().updateCalendarEvent({
            uid: "urn:uuid:1234",
            summary: "Renamed",
          }),
        ).resolves.toMatchObject({ event: { summary: "Renamed" } });
      });
    });

    describe("stored events without a series master", () => {
      const override = (recurrenceId: string, summary: string): string[] => [
        "BEGIN:VEVENT",
        "UID:evt-1",
        "DTSTAMP:20250101T000000Z",
        `RECURRENCE-ID:${recurrenceId}`,
        "DTSTART:20250621T120000Z",
        "DTEND:20250621T130000Z",
        `SUMMARY:${summary}`,
        "END:VEVENT",
      ];

      it("should edit a lone override, such as an invitation to one occurrence", async () => {
        objectsByCalendar[WORK_URL] = [
          stored(vcalendar(override("20250621T100000Z", "One occurrence"))),
        ];

        const { event } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "Renamed",
        });

        expect(event.summary).toBe("Renamed");
        expect(linesOf(writtenData())).toContain("SUMMARY:Renamed");
      });

      it("should refuse to guess between several overrides", async () => {
        objectsByCalendar[WORK_URL] = [
          stored(
            vcalendar(
              override("20250621T100000Z", "First"),
              override("20250622T100000Z", "Second"),
            ),
          ),
        ];

        await expect(
          makeService().updateCalendarEvent({
            uid: "evt-1",
            summary: "Renamed",
          }),
        ).rejects.toThrow(/no series to edit/);
        expect(updateCalendarObject).not.toHaveBeenCalled();
      });
    });

    describe("series with overrides stored before the master", () => {
      const overrideFirst = vcalendar(
        [
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20250101T000000Z",
          "RECURRENCE-ID:20250621T100000Z",
          "DTSTART:20250621T120000Z",
          "DTEND:20250621T130000Z",
          "SUMMARY:Moved occurrence",
          "END:VEVENT",
        ],
        [
          "BEGIN:VEVENT",
          "UID:evt-1",
          "DTSTAMP:20250101T000000Z",
          "DTSTART:20250620T100000Z",
          "DTEND:20250620T110000Z",
          "SUMMARY:Series",
          "RRULE:FREQ=DAILY;COUNT=3",
          "END:VEVENT",
        ],
      );

      it("should return the edited series rather than the first override", async () => {
        objectsByCalendar[WORK_URL] = [stored(overrideFirst)];

        const { event } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "Renamed series",
        });

        expect(event).toMatchObject({
          summary: "Renamed series",
          start: new Date("2025-06-20T10:00:00Z"),
          recurring: true,
        });
      });

      it("should name the series, not an override, when deleting", async () => {
        objectsByCalendar[WORK_URL] = [stored(overrideFirst)];

        const result = await makeService().deleteCalendarEvent({
          uid: "evt-1",
        });

        expect(result).toMatchObject({ summary: "Series", recurring: true });
      });
    });

    describe("attendees and notifications", () => {
      const attendeesOf = () =>
        writtenEvent()
          .getAllProperties("attendee")
          .map(a => ({
            email: a.getFirstValue(),
            cn: a.getParameter("cn"),
            partstat: a.getParameter("partstat"),
            agent: a.getParameter("schedule-agent"),
          }));

      it("should only record new attendees by default, keeping the reply status of those who stay", async () => {
        objectsByCalendar[WORK_URL] = [stored(richSeries)];

        const { notified } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          attendees: [
            { email: "Alice@Example.com" },
            { email: "bob@example.com", name: 'Doe, Bob: "B"' },
          ],
        });

        expect(attendeesOf()).toEqual([
          {
            email: "mailto:alice@example.com",
            cn: "Alice",
            partstat: "ACCEPTED",
            agent: "CLIENT",
          },
          {
            email: "mailto:bob@example.com",
            cn: 'Doe, Bob: "B"',
            partstat: undefined,
            agent: "CLIENT",
          },
        ]);
        expect(writtenEvent().hasProperty("organizer")).toBe(false);
        expect(notified).toBe(false);
      });

      it("should keep attendees unscheduled on an event the account organizes alone", async () => {
        objectsByCalendar[WORK_URL] = [
          stored(
            vcalendar(meeting("evt-1", ["ORGANIZER:mailto:me@mailbox.org"])),
          ),
        ];

        await makeService().updateCalendarEvent({
          uid: "evt-1",
          attendees: [{ email: "bob@example.com" }],
        });

        expect(attendeesOf()[0].agent).toBe("CLIENT");
      });

      it("should invite attendees with the account as organizer when asked", async () => {
        const { notified } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          attendees: [{ email: "bob@example.com" }],
          sendInvitations: true,
        });

        expect(writtenEvent().getFirstPropertyValue("organizer")).toBe(
          "mailto:me@mailbox.org",
        );
        expect(attendeesOf()[0].agent).toBeUndefined();
        expect(notified).toBe(true);
      });

      it("should remove every attendee when given an empty list", async () => {
        objectsByCalendar[WORK_URL] = [stored(richSeries)];

        await makeService().updateCalendarEvent({
          uid: "evt-1",
          attendees: [],
        });

        expect(writtenEvent().hasProperty("attendee")).toBe(false);
      });

      const organized = (organizer: string, ...extra: string[]) =>
        vcalendar(
          meeting("evt-1", [
            `ORGANIZER:mailto:${organizer}`,
            "ATTENDEE;PARTSTAT=ACCEPTED:mailto:alice@example.com",
            ...extra.map(address => `ATTENDEE:mailto:${address}`),
          ]),
        );

      it.each([
        ["the server reports only the username", ["mailto:me@mailbox.org"]],
        ["the address lookup fails", new Error("PROPFIND failed")],
      ])("should not take a meeting organized by an unknown address for an invitation when %s", async (_label, addresses) => {
        if (addresses instanceof Error) {
          fetchCalendarUserAddresses.mockRejectedValue(addresses);
        } else {
          fetchCalendarUserAddresses.mockResolvedValue(addresses);
        }
        objectsByCalendar[WORK_URL] = [stored(organized("alias@mailbox.org"))];

        await expect(
          makeService().updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toThrow(
          /Can't tell whether you organize this meeting \(organizer alias@mailbox.org\).*1 attendee.*sendInvitations: true/,
        );
        expect(updateCalendarObject).not.toHaveBeenCalled();

        const { notified } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "x",
          sendInvitations: true,
        });
        expect(notified).toBe(true);
      });

      it("should refuse to change a meeting the account organizes unless notifying is allowed", async () => {
        objectsByCalendar[WORK_URL] = [stored(organized("me@mailbox.org"))];

        await expect(
          makeService().updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toThrow(
          /meeting you organize with 1 attendee.*sendInvitations: true/,
        );
        expect(updateCalendarObject).not.toHaveBeenCalled();

        const { notified } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "Moved to room 2",
          sendInvitations: true,
        });
        expect(notified).toBe(true);
        expect(writtenEvent().getFirstPropertyValue("summary")).toBe(
          "Moved to room 2",
        );
      });

      it("should recognise the account by the calendar user addresses the server reports", async () => {
        fetchCalendarUserAddresses.mockResolvedValue([
          "mailto:alias@mailbox.org",
        ]);
        objectsByCalendar[WORK_URL] = [stored(organized("Alias@mailbox.org"))];

        await expect(
          makeService().updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toThrow(/meeting you organize/);
      });

      it("should refuse to change an event someone else organized, whatever the flags", async () => {
        objectsByCalendar[WORK_URL] = [
          stored(organized("boss@example.com", "Me@Mailbox.org")),
        ];

        for (const sendInvitations of [false, true]) {
          await expect(
            makeService().updateCalendarEvent({
              uid: "evt-1",
              summary: "x",
              sendInvitations,
            }),
          ).rejects.toThrow(/invited to this event by boss@example.com/);
        }
        expect(updateCalendarObject).not.toHaveBeenCalled();
      });
    });

    describe("finding the event", () => {
      it("should fail without writing when no event has the UID", async () => {
        await expect(
          makeService().updateCalendarEvent({ uid: "nope", summary: "x" }),
        ).rejects.toMatchObject({
          code: ErrorCode.EVENT_NOT_FOUND,
          message: 'No event with UID "nope" found',
        });
        expect(updateCalendarObject).not.toHaveBeenCalled();
      });

      it("should not download whole calendars when the UID query finds the event", async () => {
        await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "Renamed",
        });

        const unfiltered = fetchCalendarObjects.mock.calls.filter(
          ([params]) => params.filters === undefined,
        );
        expect(unfiltered).toHaveLength(0);
      });

      it("should scan only the calendars whose UID query failed when others found the event", async () => {
        fetchCalendarObjects.mockImplementation(
          async ({
            calendar,
            filters,
          }: {
            calendar: { url: string };
            filters?: unknown;
          }) => {
            if (filters && calendar.url === PRIVATE_URL) {
              throw new Error("Collection query failed: 501");
            }
            const objects = objectsByCalendar[calendar.url] ?? [];
            return filters
              ? objects.filter(object => object.data.includes("UID:evt-1"))
              : objects;
          },
        );

        await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "Renamed",
        });

        const unfiltered = fetchCalendarObjects.mock.calls
          .filter(([params]) => params.filters === undefined)
          .map(([params]) => params.calendar.url);
        expect(unfiltered).toEqual([PRIVATE_URL]);
      });

      it("should confirm a miss against the whole calendar before giving up", async () => {
        await expect(
          makeService().updateCalendarEvent({ uid: "nope", summary: "x" }),
        ).rejects.toThrow();

        const unfiltered = fetchCalendarObjects.mock.calls.filter(
          ([params]) => params.filters === undefined,
        );
        expect(unfiltered).toHaveLength(calendars.length);
      });

      it.each([
        ["ignores", async () => []],
        [
          "rejects",
          async () => {
            throw new Error("Collection query failed: 501");
          },
        ],
      ])("should find the event by scanning when the server %s the UID filter", async (_label, filtered) => {
        fetchCalendarObjects.mockImplementation(
          async ({
            calendar,
            filters,
          }: {
            calendar: { url: string };
            filters?: unknown;
          }) =>
            filters ? filtered() : (objectsByCalendar[calendar.url] ?? []),
        );

        const { event } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          summary: "Renamed",
        });

        expect(event.summary).toBe("Renamed");
      });

      it("should refuse to guess when the UID exists in several calendars", async () => {
        objectsByCalendar[PRIVATE_URL] = [
          stored(vcalendar(meeting()), "evt-1", PRIVATE_URL),
        ];

        await expect(
          makeService().updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toThrow(/several calendars \(work, private\)/);
        expect(updateCalendarObject).not.toHaveBeenCalled();
      });

      it("should use the calendar argument to pick between duplicates", async () => {
        objectsByCalendar[PRIVATE_URL] = [
          stored(vcalendar(meeting()), "evt-1", PRIVATE_URL),
        ];

        const { event } = await makeService().updateCalendarEvent({
          uid: "evt-1",
          calendar: "private",
          summary: "Renamed",
        });

        expect(event.calendar).toBe("private");
        expect(updateCalendarObject).toHaveBeenCalledWith({
          calendarObject: expect.objectContaining({
            url: `${PRIVATE_URL}evt-1.ics`,
          }),
        });
      });

      it("should report an unknown calendar as such", async () => {
        await expect(
          makeService().updateCalendarEvent({
            uid: "evt-1",
            calendar: "holidays",
            summary: "x",
          }),
        ).rejects.toThrow('Calendar "holidays" not found');
        expect(fetchCalendarObjects).not.toHaveBeenCalled();
      });

      it("should not reach a calendar whose URL merely contains the name", async () => {
        await expect(
          makeService().updateCalendarEvent({
            uid: "evt-1",
            calendar: "wor",
            summary: "x",
          }),
        ).rejects.toThrow('Calendar "wor" not found');
      });

      it("should stay within the calendars MAILBOX_CALENDARS allows", async () => {
        objectsByCalendar[PRIVATE_URL] = [
          stored(
            vcalendar(meeting("private-only")),
            "private-only",
            PRIVATE_URL,
          ),
        ];

        await expect(
          makeService({ calendars: ["work"] }).updateCalendarEvent({
            uid: "private-only",
            summary: "x",
          }),
        ).rejects.toMatchObject({
          code: ErrorCode.EVENT_NOT_FOUND,
          message: expect.stringContaining("MAILBOX_CALENDARS"),
        });
        await expect(
          makeService({ calendars: ["work"] }).updateCalendarEvent({
            uid: "private-only",
            calendar: "private",
            summary: "x",
          }),
        ).rejects.toThrow(/not found among the calendars MAILBOX_CALENDARS/);

        const searched = fetchCalendarObjects.mock.calls.map(
          ([params]) => params.calendar.url,
        );
        expect(searched).not.toContain(PRIVATE_URL);
        expect(updateCalendarObject).not.toHaveBeenCalled();
      });

      it("should not count a missing event towards opening the circuit breaker", async () => {
        const service = makeService();
        for (let attempt = 0; attempt < 5; attempt++) {
          await expect(
            service.updateCalendarEvent({ uid: "nope", summary: "x" }),
          ).rejects.toMatchObject({ code: ErrorCode.EVENT_NOT_FOUND });
        }

        await expect(
          service.updateCalendarEvent({ uid: "evt-1", summary: "Renamed" }),
        ).resolves.toMatchObject({ event: { summary: "Renamed" } });
      });
    });

    describe("without an ETag", () => {
      // tsdav builds the etag as `${getetag}`: a missing one arrives as the
      // string "undefined" (If-Match: undefined, always 412) or not at all
      // (no If-Match, an unconditional overwrite).
      it.each([
        ["missing", undefined],
        ['the string "undefined"', "undefined"],
        ["empty", ""],
      ])("should refuse to update or delete when the ETag is %s", async (_label, etag) => {
        objectsByCalendar[WORK_URL] = [
          { ...stored(vcalendar(meeting())), etag } as ReturnType<
            typeof stored
          >,
        ];

        await expect(
          makeService().updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toThrow(/returned no ETag/);
        await expect(
          makeService().deleteCalendarEvent({ uid: "evt-1" }),
        ).rejects.toThrow(/returned no ETag/);
        expect(updateCalendarObject).not.toHaveBeenCalled();
        expect(deleteCalendarObject).not.toHaveBeenCalled();
      });
    });

    describe("when the server refuses the write", () => {
      it("should report a changed etag as a modification conflict", async () => {
        updateCalendarObject.mockResolvedValue(
          new Response(null, { status: 412 }),
        );

        await expect(
          makeService().updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toMatchObject({ code: ErrorCode.EVENT_MODIFIED });
      });

      it("should surface the HTTP status of any other refusal and keep cached reads", async () => {
        cacheKeys = ["calendar_events:a"];
        updateCalendarObject.mockResolvedValue(
          new Response(null, { status: 403 }),
        );

        await expect(
          makeService().updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toMatchObject({
          code: ErrorCode.EVENT_WRITE_REJECTED,
          message: expect.stringContaining("HTTP 403"),
        });
        expect(cache.delete).not.toHaveBeenCalled();
      });

      it("should count server errors towards opening the circuit", async () => {
        const service = makeService();
        updateCalendarObject.mockResolvedValue(
          new Response(null, { status: 503 }),
        );
        for (let i = 0; i < 3; i++) {
          await expect(
            service.updateCalendarEvent({ uid: "evt-1", summary: "x" }),
          ).rejects.toThrow(/HTTP 503/);
        }

        await expect(
          service.updateCalendarEvent({ uid: "evt-1", summary: "x" }),
        ).rejects.toThrow(/Circuit breaker is OPEN/);
      });
    });

    it("should drop cached event reads but leave other cache entries", async () => {
      cacheKeys = [
        "calendar_events:a",
        "calendar_search:b",
        "freebusy:c",
        "email_search:d",
      ];

      await makeService().updateCalendarEvent({
        uid: "evt-1",
        summary: "Renamed",
      });

      const deleted = (cache.delete as Mock).mock.calls.map(([key]) => key);
      expect(deleted.sort()).toEqual([
        "calendar_events:a",
        "calendar_search:b",
        "freebusy:c",
      ]);
    });
  });

  describe("deleteCalendarEvent", () => {
    it("should delete the stored object with its etag and decline no reply", async () => {
      const result = await makeService().deleteCalendarEvent({ uid: "evt-1" });

      expect(deleteCalendarObject).toHaveBeenCalledWith({
        calendarObject: expect.objectContaining({
          url: `${WORK_URL}evt-1.ics`,
          etag: '"etag-1"',
        }),
        headers: expect.objectContaining({ "Schedule-Reply": "F" }),
      });
      expect(result).toEqual({
        uid: "evt-1",
        summary: "Team meeting",
        calendar: "work",
        recurring: false,
        notified: false,
      });
    });

    it("should send If-Match, Schedule-Reply: F and the credentials on the wire", async () => {
      const server = await recordingServer(204);
      try {
        objectsByCalendar[WORK_URL] = [
          stored(vcalendar(meeting()), "evt-1", server.base),
        ];
        // The real tsdav request, wrapped like the client returned by
        // createDAVClient wraps it (default auth headers, overridable).
        deleteCalendarObject.mockImplementation(params =>
          tsdavDeleteCalendarObject({
            headers: { authorization: "default" },
            ...params,
          }),
        );

        await makeService().deleteCalendarEvent({ uid: "evt-1" });

        expect(server.requests).toHaveLength(1);
        const [request] = server.requests;
        expect(request.method).toBe("DELETE");
        expect(request.url).toBe("/caldav/work/evt-1.ics");
        expect(request.headers["if-match"]).toBe('"etag-1"');
        expect(request.headers["schedule-reply"]).toBe("F");
        expect(request.headers.authorization).toBe(
          `Basic ${Buffer.from("me@mailbox.org:secret").toString("base64")}`,
        );
      } finally {
        await server.close();
      }
    });

    it("should delete a whole recurring series and say so", async () => {
      objectsByCalendar[WORK_URL] = [stored(richSeries)];

      const result = await makeService().deleteCalendarEvent({ uid: "evt-1" });

      expect(result).toMatchObject({
        summary: "Standup, daily",
        recurring: true,
      });
    });

    describe("meetings", () => {
      const organized = (organizer: string) =>
        vcalendar(
          meeting("evt-1", [
            `ORGANIZER:mailto:${organizer}`,
            "ATTENDEE:mailto:alice@example.com",
            "ATTENDEE:mailto:bob@example.com",
          ]),
        );
      // An invitation names the account among its attendees.
      const invitation = vcalendar(
        meeting("evt-1", [
          "ORGANIZER:mailto:boss@example.com",
          "ATTENDEE:mailto:alice@example.com",
          "ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@mailbox.org",
        ]),
      );

      it.each([
        ["the server reports only the username", ["mailto:me@mailbox.org"]],
        ["the address lookup fails", new Error("PROPFIND failed")],
      ])("should not delete a meeting organized by an unknown address without the opt-in when %s", async (_label, addresses) => {
        if (addresses instanceof Error) {
          fetchCalendarUserAddresses.mockRejectedValue(addresses);
        } else {
          fetchCalendarUserAddresses.mockResolvedValue(addresses);
        }
        objectsByCalendar[WORK_URL] = [stored(organized("alias@mailbox.org"))];

        await expect(
          makeService().deleteCalendarEvent({ uid: "evt-1" }),
        ).rejects.toThrow(
          "Can't tell whether you organize this meeting (organizer alias@mailbox.org). Deleting may email cancellations to 2 attendee(s); pass notifyParticipants: true only if that is acceptable",
        );
        expect(deleteCalendarObject).not.toHaveBeenCalled();

        const result = await makeService().deleteCalendarEvent({
          uid: "evt-1",
          notifyParticipants: true,
        });
        expect(result.notified).toBe(true);
      });

      it("should refuse to delete a meeting the account organizes unless notifying is allowed", async () => {
        objectsByCalendar[WORK_URL] = [stored(organized("me@mailbox.org"))];

        await expect(
          makeService().deleteCalendarEvent({ uid: "evt-1" }),
        ).rejects.toThrow(/organize with 2 attendee.*cancellation/);
        expect(deleteCalendarObject).not.toHaveBeenCalled();

        const result = await makeService().deleteCalendarEvent({
          uid: "evt-1",
          notifyParticipants: true,
        });
        expect(result.notified).toBe(true);
        // No header argument: tsdav's defaults (credentials) apply as is.
        expect(deleteCalendarObject).toHaveBeenLastCalledWith({
          calendarObject: expect.objectContaining({ etag: '"etag-1"' }),
        });
      });

      it("should remove an invitation without sending the organizer a decline", async () => {
        objectsByCalendar[WORK_URL] = [stored(invitation)];

        const result = await makeService().deleteCalendarEvent({
          uid: "evt-1",
        });

        expect(result.notified).toBe(false);
        expect(deleteCalendarObject.mock.calls[0][0].headers).toMatchObject({
          "Schedule-Reply": "F",
        });
      });

      it("should let the server send the decline when asked", async () => {
        objectsByCalendar[WORK_URL] = [stored(invitation)];

        const result = await makeService().deleteCalendarEvent({
          uid: "evt-1",
          notifyParticipants: true,
        });

        expect(result.notified).toBe(true);
        expect(deleteCalendarObject.mock.calls[0][0].headers).toBeUndefined();
      });

      it("should treat attendees that are only recorded as no meeting", async () => {
        objectsByCalendar[WORK_URL] = [
          stored(
            vcalendar(
              meeting("evt-1", [
                "ORGANIZER:mailto:me@mailbox.org",
                "ATTENDEE;SCHEDULE-AGENT=CLIENT:mailto:alice@example.com",
              ]),
            ),
          ),
        ];

        await expect(
          makeService().deleteCalendarEvent({ uid: "evt-1" }),
        ).resolves.toMatchObject({ notified: false });
      });
    });

    it("should fail without deleting when no event has the UID", async () => {
      await expect(
        makeService().deleteCalendarEvent({ uid: "nope" }),
      ).rejects.toMatchObject({ code: ErrorCode.EVENT_NOT_FOUND });
      expect(deleteCalendarObject).not.toHaveBeenCalled();
    });

    it("should refuse to guess when the UID exists in several calendars", async () => {
      objectsByCalendar[PRIVATE_URL] = [
        stored(vcalendar(meeting()), "evt-1", PRIVATE_URL),
      ];

      await expect(
        makeService().deleteCalendarEvent({ uid: "evt-1" }),
      ).rejects.toThrow(/several calendars/);
      expect(deleteCalendarObject).not.toHaveBeenCalled();
    });

    it("should stay within the calendars MAILBOX_CALENDARS allows", async () => {
      objectsByCalendar[PRIVATE_URL] = [
        stored(vcalendar(meeting("private-only")), "private-only", PRIVATE_URL),
      ];

      await expect(
        makeService({ calendars: ["work"] }).deleteCalendarEvent({
          uid: "private-only",
        }),
      ).rejects.toMatchObject({ code: ErrorCode.EVENT_NOT_FOUND });
      expect(deleteCalendarObject).not.toHaveBeenCalled();
    });

    it.each([
      [412, ErrorCode.EVENT_MODIFIED],
      [403, ErrorCode.EVENT_WRITE_REJECTED],
    ])("should report HTTP %i instead of claiming success", async (status, code) => {
      cacheKeys = ["calendar_events:a"];
      deleteCalendarObject.mockResolvedValue(new Response(null, { status }));

      await expect(
        makeService().deleteCalendarEvent({ uid: "evt-1" }),
      ).rejects.toMatchObject({ code });
      expect(cache.delete).not.toHaveBeenCalled();
    });

    it("should drop cached event reads", async () => {
      cacheKeys = ["calendar_events:a", "email_search:d"];

      await makeService().deleteCalendarEvent({ uid: "evt-1" });

      expect(cache.delete).toHaveBeenCalledTimes(1);
      expect(cache.delete).toHaveBeenCalledWith("calendar_events:a");
    });
  });
});
