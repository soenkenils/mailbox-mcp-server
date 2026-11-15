import ICAL from "ical.js";
import type { createDAVClient } from "tsdav";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CalendarService } from "../src/services/CalendarService.js";
import type { LocalCache } from "../src/types/cache.types.js";
import type { CalDavConnection } from "../src/types/calendar.types.js";

// Real ical.js: recurrence expansion is exactly what a mocked parser hides.

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

const WORK_URL = "https://dav.example.com/caldav/work/";

const vcalendar = (...vevents: string[]): string =>
  [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Test//EN",
    ...vevents,
    "END:VCALENDAR",
    "",
  ].join("\r\n");

const vevent = (lines: string[]): string =>
  ["BEGIN:VEVENT", "DTSTAMP:20250101T000000Z", ...lines, "END:VEVENT"].join(
    "\r\n",
  );

const WEEKLY = [
  "UID:weekly@example.com",
  "SUMMARY:Weekly meeting",
  "DTSTART:20250106T100000Z",
  "DTEND:20250106T110000Z",
  "RRULE:FREQ=WEEKLY",
];

const WEEK = {
  start: new Date("2026-11-09T00:00:00Z"),
  end: new Date("2026-11-16T00:00:00Z"),
};

describe("CalendarService recurring events", () => {
  const fetchCalendars = vi.fn();
  const fetchCalendarObjects = vi.fn();
  let cache: LocalCache;

  const service = () =>
    new TestableCalendarService(
      {
        baseUrl: "https://dav.example.com/caldav",
        username: "me@example.com",
        password: "secret",
        calendars: ["work"],
      },
      cache,
      { fetchCalendars, fetchCalendarObjects } as unknown as DAVClient,
    );

  const eventsFor = async (
    data: string,
    range: { start: Date; end: Date } = WEEK,
  ) => {
    fetchCalendarObjects.mockResolvedValue([
      { url: `${WORK_URL}x.ics`, etag: "1", data },
    ]);
    return service().getCalendarEvents({ ...range });
  };

  beforeEach(() => {
    vi.clearAllMocks();
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
      keys: vi.fn(() => [].values()),
    } as unknown as LocalCache;
    fetchCalendars.mockResolvedValue([
      { displayName: "work", url: WORK_URL, components: ["VEVENT"] },
    ]);
  });

  it("should return the occurrence inside the range, not the first one", async () => {
    const events = await eventsFor(vcalendar(vevent(WEEKLY)));

    expect(events).toHaveLength(1);
    expect(events[0].start.toISOString()).toBe("2026-11-09T10:00:00.000Z");
    expect(events[0].end.toISOString()).toBe("2026-11-09T11:00:00.000Z");
    expect(events[0].recurring).toBe(true);
    expect(events[0].uid).toBe("weekly@example.com");
    expect(events[0].id).toBe("weekly@example.com:2026-11-09T10:00:00.000Z");
  });

  it("should return every occurrence in a longer range", async () => {
    const events = await eventsFor(vcalendar(vevent(WEEKLY)), {
      start: new Date("2026-11-01T00:00:00Z"),
      end: new Date("2026-12-01T00:00:00Z"),
    });

    expect(events.map(e => e.start.toISOString().slice(0, 10))).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
    ]);
  });

  it("should move a yearly all-day event into the queried year", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent([
          "UID:birthday@example.com",
          "SUMMARY:Birthday",
          "DTSTART;VALUE=DATE:19330801",
          "DTEND;VALUE=DATE:19330802",
          "RRULE:FREQ=YEARLY",
        ]),
      ),
      {
        start: new Date("2026-07-30T00:00:00Z"),
        end: new Date("2026-08-04T00:00:00Z"),
      },
    );

    expect(events).toHaveLength(1);
    expect(events[0].allDay).toBe(true);
    expect(events[0].start.getFullYear()).toBe(2026);
    expect(events[0].start.getMonth()).toBe(7);
    expect(events[0].start.getDate()).toBe(1);
  });

  it("should skip an occurrence excluded by EXDATE", async () => {
    const events = await eventsFor(
      vcalendar(vevent([...WEEKLY, "EXDATE:20261109T100000Z"])),
    );

    expect(events).toHaveLength(0);
  });

  it("should use an overridden instance instead of its occurrence", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent(WEEKLY),
        vevent([
          "UID:weekly@example.com",
          "RECURRENCE-ID:20261109T100000Z",
          "SUMMARY:Weekly meeting (moved)",
          "DTSTART:20261109T140000Z",
          "DTEND:20261109T150000Z",
        ]),
      ),
    );

    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("Weekly meeting (moved)");
    expect(events[0].start.toISOString()).toBe("2026-11-09T14:00:00.000Z");
  });

  it("should respect COUNT", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent([
          "UID:daily@example.com",
          "SUMMARY:Three days",
          "DTSTART:20261108T090000Z",
          "DTEND:20261108T093000Z",
          "RRULE:FREQ=DAILY;COUNT=3",
        ]),
      ),
    );

    expect(events.map(e => e.start.toISOString().slice(0, 10))).toEqual([
      "2026-11-09",
      "2026-11-10",
    ]);
  });

  it("should drop a single event outside the range", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent([
          "UID:later@example.com",
          "SUMMARY:Next month",
          "DTSTART:20261212T083000Z",
          "DTEND:20261212T093000Z",
        ]),
        vevent([
          "UID:inside@example.com",
          "SUMMARY:This week",
          "DTSTART:20261110T083000Z",
          "DTEND:20261110T093000Z",
        ]),
      ),
    );

    expect(events.map(e => e.summary)).toEqual(["This week"]);
  });

  it("should keep an override whose master is not in the object", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent([
          "UID:orphan@example.com",
          "RECURRENCE-ID:20261110T100000Z",
          "SUMMARY:Lone instance",
          "DTSTART:20261110T100000Z",
          "DTEND:20261110T110000Z",
        ]),
      ),
    );

    expect(events.map(e => e.summary)).toEqual(["Lone instance"]);
  });

  it("should keep later occurrences when one instance moved out of the range", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent(WEEKLY),
        vevent([
          "UID:weekly@example.com",
          "RECURRENCE-ID:20261109T100000Z",
          "SUMMARY:Moved away",
          "DTSTART:20261220T100000Z",
          "DTEND:20261220T110000Z",
        ]),
      ),
      {
        start: new Date("2026-11-01T00:00:00Z"),
        end: new Date("2026-12-01T00:00:00Z"),
      },
    );

    expect(events.map(e => e.start.toISOString().slice(0, 10))).toEqual([
      "2026-11-02",
      "2026-11-16",
      "2026-11-23",
      "2026-11-30",
    ]);
  });

  it("should find an instance moved into the range from a later slot", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent(WEEKLY),
        vevent([
          "UID:weekly@example.com",
          "RECURRENCE-ID:20261214T100000Z",
          "SUMMARY:Moved in",
          "DTSTART:20261111T150000Z",
          "DTEND:20261111T160000Z",
        ]),
      ),
    );

    expect(events.map(e => e.summary)).toEqual(["Weekly meeting", "Moved in"]);
    expect(events[1].id).toBe("weekly@example.com:2026-12-14T10:00:00.000Z");
  });

  it("should include RDATE instances", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent([
          "UID:rdate@example.com",
          "SUMMARY:Extra dates",
          "DTSTART:20260101T090000Z",
          "DTEND:20260101T100000Z",
          "RDATE:20261112T090000Z",
        ]),
      ),
    );

    expect(events.map(e => e.start.toISOString())).toEqual([
      "2026-11-12T09:00:00.000Z",
    ]);
  });

  it("should follow a TZID across the switch to winter time", async () => {
    const events = await eventsFor(
      vcalendar(
        [
          "BEGIN:VTIMEZONE",
          "TZID:Europe/Berlin",
          "BEGIN:DAYLIGHT",
          "TZOFFSETFROM:+0100",
          "TZOFFSETTO:+0200",
          "TZNAME:CEST",
          "DTSTART:19700329T020000",
          "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
          "END:DAYLIGHT",
          "BEGIN:STANDARD",
          "TZOFFSETFROM:+0200",
          "TZOFFSETTO:+0100",
          "TZNAME:CET",
          "DTSTART:19701025T030000",
          "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
          "END:STANDARD",
          "END:VTIMEZONE",
        ].join("\r\n"),
        vevent([
          "UID:berlin@example.com",
          "SUMMARY:Morning",
          "DTSTART;TZID=Europe/Berlin:20261019T080000",
          "DTEND;TZID=Europe/Berlin:20261019T090000",
          "RRULE:FREQ=WEEKLY",
        ]),
      ),
      {
        start: new Date("2026-10-19T00:00:00Z"),
        end: new Date("2026-10-27T00:00:00Z"),
      },
    );

    expect(events.map(e => e.start.toISOString())).toEqual([
      "2026-10-19T06:00:00.000Z",
      "2026-10-26T07:00:00.000Z",
    ]);
  });

  it.each([
    "FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30",
    "FREQ=DAILY;BYMONTHDAY=-31;BYMONTH=4",
    "FREQ=HOURLY;BYMONTH=2;BYMONTHDAY=30",
    "FREQ=MINUTELY",
    "FREQ=DAILY;BYDAY=1MO",
    "FREQ=DAILY;BYDAY=-1MO",
    "FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYDAY=MO,TU,WE,TH,FR,SA,SU",
    "FREQ=YEARLY;BYMONTH=4;BYMONTHDAY=31;BYDAY=MO",
    "FREQ=SECONDLY",
  ])("should not expand %s and show the event once instead", async rule => {
    const started = Date.now();
    const events = await eventsFor(
      vcalendar(
        vevent([
          "UID:spin@example.com",
          "SUMMARY:Unexpandable",
          "DTSTART:20261110T080000Z",
          "DTEND:20261110T081500Z",
          `RRULE:${rule}`,
        ]),
      ),
    );

    expect(Date.now() - started).toBeLessThan(2000);
    expect(events.map(e => e.summary)).toEqual(["Unexpandable"]);
  });

  it("should fall back to the single instance when expansion throws", async () => {
    const spy = vi
      .spyOn(ICAL.Event.prototype, "iterator")
      .mockImplementation(() => {
        throw new Error("boom");
      });
    try {
      const events = await eventsFor(vcalendar(vevent(WEEKLY)), {
        start: new Date("2025-01-01T00:00:00Z"),
        end: new Date("2025-01-31T00:00:00Z"),
      });

      expect(events.map(e => e.start.toISOString())).toEqual([
        "2025-01-06T10:00:00.000Z",
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("should give lone overrides of one series distinct ids", async () => {
    const lone = (rid: string, start: string) =>
      vevent([
        "UID:lone@example.com",
        `RECURRENCE-ID:${rid}`,
        "SUMMARY:Lone",
        `DTSTART:${start}`,
        `DTEND:${start.replace("T10", "T11")}`,
      ]);
    const events = await eventsFor(
      vcalendar(
        lone("20261110T100000Z", "20261110T100000Z"),
        lone("20261112T100000Z", "20261112T100000Z"),
      ),
    );

    expect(new Set(events.map(e => e.id)).size).toBe(2);
  });

  it("should keep a zero-length event at the start of the range", async () => {
    const events = await eventsFor(
      vcalendar(
        vevent([
          "UID:zero@example.com",
          "SUMMARY:Marker",
          "DTSTART:20261109T000000Z",
          "DTEND:20261109T000000Z",
        ]),
      ),
    );

    expect(events.map(e => e.summary)).toEqual(["Marker"]);
  });
});
