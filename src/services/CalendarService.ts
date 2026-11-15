import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import ICAL from "ical.js";
import { createDAVClient, type DAVCalendar, type DAVObject } from "tsdav";
import type { LocalCache } from "../types/cache.types.js";
import type {
  Attendee,
  CalDavConnection,
  CalendarEvent,
  CalendarSearchOptions,
  CreateCalendarEventOptions,
  CreateCalendarEventResult,
  FreeBusyInfo,
} from "../types/calendar.types.js";
import { CalendarError, ErrorCode, ValidationError } from "../types/errors.js";
import { withCacheFallback } from "../utils/cacheFallback.js";
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerMetrics,
} from "./CircuitBreaker.js";
import { createLogger } from "./Logger.js";

/** Optional time window used to expand recurring events. */
interface EventRange {
  start?: Date;
  end?: Date;
}

/**
 * Upper bound on recurrence instances examined per event and call. The scan
 * starts at DTSTART, so a daily series since 1990 needs ~13,000 steps to
 * reach today; the time budget below is the tighter bound in practice.
 */
const MAX_RECURRENCE_SCAN = 50_000;
/** Wall-clock budget for expanding one recurring event. */
const RECURRENCE_TIME_BUDGET_MS = 250;
/** Days per month, February counted with 29 (leap years). */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
/** Upper bound on occurrences returned per recurring event and call. */
const MAX_OCCURRENCES_PER_EVENT = 1_000;

dayjs.extend(utc);

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>;

/** Cache key prefixes of every result derived from the event list. */
const EVENT_CACHE_PREFIXES = [
  "calendar_events:",
  "calendar_search:",
  "freebusy:",
] as const;

/** RFC 5545 section 3.1: content lines SHOULD NOT exceed 75 octets. */
const MAX_LINE_OCTETS = 75;

const calendarLabel = (calendar: DAVCalendar): string =>
  (calendar.displayName as string) || calendar.url;

export class CalendarService {
  private connection: CalDavConnection;
  private cache: LocalCache;
  private client: Awaited<ReturnType<typeof createDAVClient>> | null = null;
  private circuitBreaker: CircuitBreaker;
  private logger = createLogger("CalendarService");

  constructor(
    connection: CalDavConnection,
    cache: LocalCache,
    circuitBreakerConfig?: CircuitBreakerConfig,
  ) {
    this.connection = connection;
    this.cache = cache;

    // Initialize circuit breaker with defaults or provided config
    const cbConfig = circuitBreakerConfig || {
      failureThreshold: 3,
      recoveryTimeout: 5000, // 5 seconds
      monitoringInterval: 2000, // 2 seconds
    };
    this.circuitBreaker = new CircuitBreaker(cbConfig);
  }

  protected async getClient(): Promise<DAVClient> {
    if (!this.client) {
      this.client = await createDAVClient({
        serverUrl: this.connection.baseUrl,
        credentials: {
          username: this.connection.username,
          password: this.connection.password,
        },
        authMethod: "Basic",
        defaultAccountType: "caldav",
      });
    }
    return this.client;
  }

  async getCalendarEvents(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const cacheKey = `calendar_events:${JSON.stringify(options)}`;

    return withCacheFallback({
      cacheKey,
      cache: this.cache,
      fetch: async () => {
        const events = await this.fetchCalendarEvents(options);
        return events;
      },
      defaultValue: [],
      logger: this.logger,
      operation: "getCalendarEvents",
      service: "CalendarService",
      ttl: 900000, // 15 minutes TTL
      logContext: { options },
    });
  }

  async searchCalendar(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const cacheKey = `calendar_search:${JSON.stringify(options)}`;

    return withCacheFallback({
      cacheKey,
      cache: this.cache,
      fetch: async () => {
        const events = await this.fetchCalendarEvents(options);
        const filteredEvents = this.filterEventsByQuery(events, options.query);
        return filteredEvents;
      },
      defaultValue: [],
      logger: this.logger,
      operation: "searchCalendar",
      service: "CalendarService",
      ttl: 900000, // 15 minutes TTL
      logContext: { query: options.query },
    });
  }

  async getFreeBusy(
    start: Date,
    end: Date,
    calendar?: string,
  ): Promise<FreeBusyInfo> {
    const cacheKey = `freebusy:${start.toISOString()}:${end.toISOString()}:${calendar || "all"}`;

    return withCacheFallback({
      cacheKey,
      cache: this.cache,
      fetch: async () => {
        const events = await this.fetchCalendarEvents({
          start,
          end,
          calendar,
        });

        const freeBusy = this.calculateFreeBusy(events, start, end);
        return freeBusy;
      },
      defaultValue: {
        start,
        end,
        busy: [],
        free: [{ start, end }],
      },
      logger: this.logger,
      operation: "getFreeBusy",
      service: "CalendarService",
      ttl: 300000, // 5 minutes TTL
      logContext: {
        start: start.toISOString(),
        end: end.toISOString(),
        calendar,
      },
    });
  }

  async createCalendarEvent(
    options: CreateCalendarEventOptions,
  ): Promise<CreateCalendarEventResult> {
    const uid = randomUUID();
    const allDay = options.allDay ?? false;
    const dates = allDay ? this.allDayDates(options) : undefined;
    const organizer = this.invitationOrganizer(options);
    const iCalString = this.buildICalString(uid, options, dates, organizer);

    // Only the network calls sit inside the breaker: a calendar name the
    // caller got wrong must not count towards opening the circuit.
    const { client, calendars } = await this.circuitBreaker.execute(
      async () => {
        const client = await this.getClient();
        return { client, calendars: await client.fetchCalendars() };
      },
    );
    const target = this.chooseCreateTarget(
      this.selectCalendars(calendars, options.calendar),
      options.calendar,
    );
    const calendarName = calendarLabel(target);

    const response = await this.circuitBreaker.execute(async () => {
      const response = await client.createCalendarObject({
        calendar: target,
        filename: `${uid}.ics`,
        iCalString,
      });
      // A server error counts towards opening the circuit; a refusal (4xx)
      // is about this request and is reported below without counting.
      if (response.status >= 500) {
        this.assertWritten(response, "create", calendarName, uid);
      }
      return response;
    });
    this.assertWritten(response, "create", calendarName, uid);
    this.invalidateEventCaches();

    this.logger.info("Calendar event created", {
      operation: "createCalendarEvent",
      service: "CalendarService",
    });

    return {
      uid,
      summary: options.summary,
      start: options.start,
      end: options.end,
      allDay,
      ...dates,
      calendar: calendarName,
    };
  }

  /**
   * The ORGANIZER address when the caller asked the server to invite the
   * attendees, or undefined when attendees are only recorded.
   */
  private invitationOrganizer(
    options: CreateCalendarEventOptions,
  ): string | undefined {
    if (!options.sendInvitations || !options.attendees?.length) {
      return undefined;
    }

    const address = this.connection.username.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) {
      throw new ValidationError(
        "Invitations need the account's mail address as organizer, but the configured username is not a mail address",
        "sendInvitations",
        true,
      );
    }
    if (
      options.attendees.some(
        attendee => attendee.email.toLowerCase() === address.toLowerCase(),
      )
    ) {
      throw new ValidationError(
        `${address} is the organizer of the invitation; do not list it as an attendee`,
        "attendees",
        address,
      );
    }
    return address;
  }

  /**
   * The calendar a new event goes to: the one the caller named, or the first
   * candidate (the first MAILBOX_CALENDARS entry, when that is set). A name
   * that matches several calendars is refused rather than guessed. Refusals
   * are ValidationErrors so the user sees the reason, not a generic message.
   */
  private chooseCreateTarget(
    candidates: DAVCalendar[],
    calendarFilter?: string,
  ): DAVCalendar {
    if (candidates.length === 0) {
      const scope = this.allowedCalendars()
        ? " among the calendars MAILBOX_CALENDARS allows"
        : "";
      throw calendarFilter
        ? new ValidationError(
            `Calendar "${calendarFilter}" not found${scope}`,
            "calendar",
            calendarFilter,
          )
        : new ValidationError(
            scope
              ? "No calendar available to create the event in; check MAILBOX_CALENDARS"
              : "No calendar that can hold events was found",
            "calendar",
          );
    }

    if (calendarFilter && candidates.length > 1) {
      throw new ValidationError(
        `Calendar "${calendarFilter}" matches several calendars (${candidates
          .map(calendarLabel)
          .join(", ")}); use the exact name`,
        "calendar",
        calendarFilter,
      );
    }

    return candidates[0];
  }

  /**
   * Calendars a write may touch: those that can hold events, match the
   * optional filter and, when MAILBOX_CALENDARS restricts the server, are
   * listed there, in the order it lists them. Every write chooses from this.
   * An entry that names several calendars is refused rather than widened.
   */
  private selectCalendars(
    calendars: DAVCalendar[],
    calendarFilter?: string,
  ): DAVCalendar[] {
    const writable = calendars.filter(calendar => this.holdsEvents(calendar));
    const allowed = this.allowedCalendars();
    const ranked = allowed
      ? allowed.flatMap(name => {
          const matches = writable.filter(calendar =>
            this.calendarMatches(calendar, name),
          );
          if (matches.length > 1) {
            throw new ValidationError(
              `MAILBOX_CALENDARS entry "${name}" matches several calendars (${matches
                .map(calendarLabel)
                .join(", ")}); use a unique name or the calendar's URL`,
              "calendar",
              name,
            );
          }
          return matches;
        })
      : writable;

    return [...new Set(ranked)].filter(
      calendar =>
        !calendarFilter || this.calendarMatches(calendar, calendarFilter),
    );
  }

  /** The MAILBOX_CALENDARS names, or undefined when it restricts nothing. */
  private allowedCalendars(): string[] | undefined {
    const names = this.connection.calendars
      ?.map(name => name.trim())
      .filter(name => name.length > 0);
    return names?.length ? names : undefined;
  }

  /**
   * Whether a name denotes this calendar: its exact display name, its exact
   * URL, or the exact last segment of its path. Never a substring, so "work"
   * cannot reach ".../homework/".
   */
  private calendarMatches(calendar: DAVCalendar, name: string): boolean {
    const wanted = name.trim();
    if (!wanted) {
      return false;
    }
    if (calendar.displayName === wanted) {
      return true;
    }
    const url = calendar.url.replace(/\/+$/, "");
    if (url === wanted.replace(/\/+$/, "")) {
      return true;
    }
    const segment = url.slice(url.lastIndexOf("/") + 1);
    return segment === wanted || this.decodeSegment(segment) === wanted;
  }

  private decodeSegment(segment: string): string {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  }

  /** A collection that only takes tasks or journals cannot store a VEVENT. */
  private holdsEvents(calendar: DAVCalendar): boolean {
    return (
      !calendar.components?.length || calendar.components.includes("VEVENT")
    );
  }

  private assertWritten(
    response: Response,
    action: "create" | "update" | "delete",
    calendar: string,
    uid: string,
  ): void {
    if (response.ok) {
      return;
    }

    // A create is sent with If-None-Match: *, so 412 there means the name is
    // taken; on update and delete it means the event changed meanwhile.
    if (response.status === 412 && action !== "create") {
      throw new CalendarError(
        `The event changed on the server during the ${action}`,
        ErrorCode.EVENT_MODIFIED,
        calendar,
        uid,
      );
    }

    throw new CalendarError(
      `The CalDAV server rejected the ${action} in calendar "${calendar}" (HTTP ${response.status})`,
      ErrorCode.EVENT_WRITE_REJECTED,
      calendar,
      uid,
    );
  }

  /** Reads are cached for minutes, so a write must not leave them stale. */
  private invalidateEventCaches(): void {
    for (const key of [...this.cache.keys()]) {
      if (EVENT_CACHE_PREFIXES.some(prefix => key.startsWith(prefix))) {
        this.cache.delete(key);
      }
    }
  }

  /** The YYYY-MM-DD an all-day event falls on. */
  private calendarDate(value: Date, writtenDate?: string): string {
    return writtenDate ?? dayjs(value).utc().format("YYYY-MM-DD");
  }

  /**
   * DTSTART and the exclusive DTEND of an all-day event. An end on or before
   * the start date makes it a one-day event, since DTEND must come after
   * DTSTART.
   */
  private allDayDates(options: CreateCalendarEventOptions): {
    startDate: string;
    endDate: string;
  } {
    const startDate = this.calendarDate(options.start, options.startDate);
    const endDate = this.calendarDate(options.end, options.endDate);
    return {
      startDate,
      endDate:
        endDate > startDate
          ? endDate
          : dayjs.utc(startDate).add(1, "day").format("YYYY-MM-DD"),
    };
  }

  /**
   * Timed events are written in UTC (DTSTART:...Z); all-day events as
   * VALUE=DATE with an exclusive DTEND. No TZID or floating times.
   */
  private buildICalString(
    uid: string,
    options: CreateCalendarEventOptions,
    allDayDates?: { startDate: string; endDate: string },
    organizer?: string,
  ): string {
    const utcStamp = (value: Date) =>
      dayjs(value).utc().format("YYYYMMDDTHHmmss[Z]");
    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//mailbox-mcp-server//EN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${utcStamp(new Date())}`,
    ];

    if (allDayDates) {
      const basic = (date: string) => date.replaceAll("-", "");
      lines.push(`DTSTART;VALUE=DATE:${basic(allDayDates.startDate)}`);
      lines.push(`DTEND;VALUE=DATE:${basic(allDayDates.endDate)}`);
    } else {
      lines.push(`DTSTART:${utcStamp(options.start)}`);
      lines.push(`DTEND:${utcStamp(options.end)}`);
    }

    lines.push(`SUMMARY:${this.escapeICalText(options.summary)}`);

    if (options.description) {
      lines.push(`DESCRIPTION:${this.escapeICalText(options.description)}`);
    }

    if (options.location) {
      lines.push(`LOCATION:${this.escapeICalText(options.location)}`);
    }

    if (options.attendees?.length) {
      // With an ORGANIZER that is the calendar owner, a stored event is a
      // scheduling object and the server invites its attendees (RFC 6638).
      // Without one, and with server scheduling declined per attendee, the
      // attendees are only recorded.
      if (organizer) {
        lines.push(`ORGANIZER:mailto:${organizer}`);
      }
      const agent = organizer ? "" : ";SCHEDULE-AGENT=CLIENT";
      for (const attendee of options.attendees) {
        const cn = attendee.name
          ? `;CN=${this.quoteICalParameter(attendee.name)}`
          : "";
        lines.push(`ATTENDEE${agent}${cn}:mailto:${attendee.email}`);
      }
    }

    lines.push("END:VEVENT", "END:VCALENDAR");
    return `${lines.map(line => this.foldICalLine(line)).join("\r\n")}\r\n`;
  }

  /**
   * Quotes a parameter value so ",", ";" and ":" in it cannot end it early.
   * A quoted value cannot hold a double quote, so those (and "^") use the
   * RFC 6868 caret escapes, which ical.js and other clients decode.
   */
  private quoteICalParameter(value: string): string {
    const escaped = value
      .replace(/\^/g, "^^")
      .replace(/"/g, "^'")
      .replace(/\r\n?|\n/g, "^n");
    return `"${escaped}"`;
  }

  /**
   * RFC 5545 3.3.11 TEXT: backslash, semicolon and comma are escaped, and a
   * line break becomes "\n". There is no escape for a bare CR, so every line
   * ending counts as one break.
   */
  private escapeICalText(text: string): string {
    return text
      .replace(/\\/g, "\\\\")
      .replace(/;/g, "\\;")
      .replace(/,/g, "\\,")
      .replace(/\r\n?|\n/g, "\\n");
  }

  /**
   * RFC 5545 3.1: lines longer than 75 octets are folded with CRLF and a
   * space. Splits fall between characters, never inside a UTF-8 sequence.
   */
  private foldICalLine(line: string): string {
    const encoder = new TextEncoder();
    const parts: string[] = [];
    let current = "";
    let currentOctets = 0;
    // The first line holds 75 octets; continuations lose one to the space.
    let limit = MAX_LINE_OCTETS;

    for (const char of line) {
      const octets = encoder.encode(char).length;
      if (currentOctets + octets > limit) {
        parts.push(current);
        current = "";
        currentOctets = 0;
        limit = MAX_LINE_OCTETS - 1;
      }
      current += char;
      currentOctets += octets;
    }
    parts.push(current);

    return parts.join("\r\n ");
  }

  private async fetchCalendarEvents(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    try {
      const calendars =
        this.connection.calendars || (await this.discoverCalendars());
      const allEvents: CalendarEvent[] = [];

      for (const calendar of calendars) {
        if (options.calendar && calendar !== options.calendar) {
          continue;
        }

        const calendarEvents = await this.fetchEventsFromCalendar(
          calendar,
          options,
        );
        allEvents.push(...calendarEvents);
      }

      return this.sortAndLimitEvents(allEvents, options);
    } catch (error) {
      this.logger.error(
        "Error fetching calendar events",
        {
          operation: "getEvents",
          service: "CalendarService",
        },
        {
          options,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return [];
    }
  }

  protected async discoverCalendars(): Promise<string[]> {
    try {
      const calendars = await this.circuitBreaker.execute(async () => {
        const client = await this.getClient();
        return await client.fetchCalendars();
      });

      return calendars.map(
        (cal: DAVCalendar) => (cal.displayName as string) || cal.url,
      );
    } catch (error) {
      this.logger.error(
        "Calendar discovery failed",
        {
          operation: "getCalendarList",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return ["personal"];
    }
  }

  private async fetchEventsFromCalendar(
    calendar: string,
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    try {
      const { calendars, calendarObjects } = await this.circuitBreaker.execute(
        async () => {
          const client = await this.getClient();
          const calendars = await client.fetchCalendars();

          const targetCalendar = calendars.find(
            (cal: DAVCalendar) =>
              cal.displayName === calendar || cal.url.includes(calendar),
          );

          if (!targetCalendar) {
            throw new Error(`Calendar ${calendar} not found`);
          }

          const calendarObjects = await client.fetchCalendarObjects({
            calendar: targetCalendar,
            timeRange:
              options.start && options.end
                ? {
                    start: options.start.toISOString(),
                    end: options.end.toISOString(),
                  }
                : undefined,
          });

          return { calendars, calendarObjects };
        },
      );

      return await this.parseCalendarObjects(calendarObjects, calendar, {
        start: options.start,
        end: options.end,
      });
    } catch (error) {
      this.logger.error(
        `Error fetching events from calendar ${calendar}`,
        {
          operation: "fetchCalendarEvents",
          service: "CalendarService",
        },
        {
          calendar,
          options,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      return [];
    }
  }

  private parseCalendarObjects(
    calendarObjects: DAVObject[],
    calendar: string,
    range: EventRange = {},
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      for (const obj of calendarObjects) {
        if (obj.data) {
          const parsedEvents = this.parseICalData(obj.data, calendar, range);
          events.push(...parsedEvents);
        }
      }
    } catch (error) {
      this.logger.error(
        "Error parsing calendar objects",
        {
          operation: "parseCalendarObjects",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    return events;
  }

  private parseICalData(
    icalData: string,
    calendar: string,
    range: EventRange = {},
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      const jcalData = ICAL.parse(icalData);
      const comp = new ICAL.Component(jcalData);
      const vevents = comp.getAllSubcomponents("vevent");
      const expand = !!(range.start && range.end);

      // RFC 5545: a recurring event is a master VEVENT (RRULE/RDATE) plus
      // overridden instances that carry a RECURRENCE-ID and the same UID.
      const isOverride = (vevent: ICAL.Component): boolean =>
        typeof vevent.hasProperty === "function" &&
        vevent.hasProperty("recurrence-id");
      const uidOf = (vevent: ICAL.Component): unknown =>
        typeof vevent.getFirstPropertyValue === "function"
          ? vevent.getFirstPropertyValue("uid")
          : undefined;
      const masters = vevents.filter(vevent => !isOverride(vevent));
      const overrides = vevents.filter(isOverride);
      const masterUids = new Set(masters.map(uidOf));

      for (const vevent of masters) {
        if (expand) {
          const own = overrides.filter(o => uidOf(o) === uidOf(vevent));
          try {
            const master = new ICAL.Event(vevent, { exceptions: own });
            if (master.isRecurring() && this.canExpand(master)) {
              events.push(
                ...this.expandOccurrences(master, own, calendar, range),
              );
              continue;
            }
          } catch (error) {
            // A rule ical.js cannot expand must not hide the event: fall back
            // to the single (first) instance, as before expansion existed.
            this.logger.warning(
              "Recurring event could not be expanded",
              { operation: "parseICalData", service: "CalendarService" },
              { error: error instanceof Error ? error.message : String(error) },
            );
          }
        }
        const event = this.parseVEvent(vevent, calendar);
        if (event) {
          events.push(event);
        }
      }
      // An override whose master is not in this object stands on its own.
      for (const vevent of overrides) {
        if (!masterUids.has(uidOf(vevent))) {
          const event = this.parseOverride(vevent, calendar);
          if (event) {
            events.push(event);
          }
        }
      }

      if (expand) {
        return events.filter(event => this.overlaps(event, range));
      }
    } catch (error) {
      this.logger.error(
        "Error parsing iCal data",
        {
          operation: "parseICalData",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    return events;
  }

  /** RFC 4791 9.9: zero-length events at the range start count as inside. */
  private overlaps(event: CalendarEvent, range: EventRange): boolean {
    const zeroLength = event.end.getTime() === event.start.getTime();
    return (
      (!range.end || event.start < range.end) &&
      (!range.start ||
        event.end > range.start ||
        (zeroLength && event.start >= range.start))
    );
  }

  /** An overridden instance, with an id unique per RECURRENCE-ID. */
  private parseOverride(
    vevent: ICAL.Component,
    calendar: string,
  ): CalendarEvent | null {
    const event = this.parseVEvent(vevent, calendar);
    const recurrenceId = vevent.getFirstPropertyValue("recurrence-id");
    if (event && recurrenceId instanceof ICAL.Time) {
      event.id = `${event.uid}:${recurrenceId.toJSDate().toISOString()}`;
    }
    return event;
  }

  /**
   * Whether ical.js can expand the rule without spinning. Its iterator only
   * guards MONTHLY/YEARLY against unsatisfiable rules; for sub-daily
   * frequencies, or DAILY/WEEKLY rules restricted to impossible days
   * (e.g. BYMONTH=2;BYMONTHDAY=30), next() can loop forever and block the
   * event loop. Such events fall back to their single first instance.
   */
  private canExpand(master: ICAL.Event): boolean {
    for (const property of master.component.getAllProperties("rrule")) {
      const recur = property.getFirstValue() as ICAL.Recur;
      if (["SECONDLY", "MINUTELY", "HOURLY"].includes(recur.freq)) {
        return false;
      }
      const parts = recur.parts as Record<
        string,
        Array<number | string> | undefined
      >;
      if (recur.freq === "DAILY" || recur.freq === "WEEKLY") {
        if (parts.BYWEEKNO || parts.BYYEARDAY || parts.BYSETPOS) {
          return false;
        }
        // RFC 5545 forbids ordinals (1MO, -1FR) here; ical.js can spin on them.
        if (parts.BYDAY?.some(day => /^[+-]?\d/.test(String(day)))) {
          return false;
        }
      }
      // For every frequency: BYMONTHDAY must name a day that exists in one of
      // the allowed months, otherwise next() searches for years per call.
      const days = parts.BYMONTHDAY?.map(Number);
      if (days?.length) {
        const months = parts.BYMONTH?.length
          ? parts.BYMONTH.map(Number)
          : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        const satisfiable = months.some(month =>
          days.some(
            day =>
              day !== 0 && Math.abs(day) <= (DAYS_IN_MONTH[month - 1] ?? 0),
          ),
        );
        if (!satisfiable) {
          return false;
        }
      }
    }
    return true;
  }

  /**
   * The occurrences of a recurring event that overlap the range. Without this
   * a recurring event shows up once, at its first occurrence (a birthday in
   * 1933, a weekly meeting at the week it was created). Overridden instances
   * (RECURRENCE-ID) replace their occurrence; EXDATEs are skipped by ical.js.
   * Bounded so a dense rule (e.g. every minute for years) cannot stall a call.
   */
  private expandOccurrences(
    master: ICAL.Event,
    overrides: ICAL.Component[],
    calendar: string,
    range: EventRange,
  ): CalendarEvent[] {
    const occurrences: CalendarEvent[] = [];
    if (!range.start || !range.end) {
      return occurrences;
    }
    const rule = master.component.getFirstPropertyValue("rrule")?.toString();
    const deadline = Date.now() + RECURRENCE_TIME_BUDGET_MS;
    const iterator = master.iterator();
    const seen = new Set<string>();
    let scanned = 0;
    let next = iterator.next();
    // Without overrides every slot lasts the master's duration, so slots that
    // end before the range can be skipped without computing their details.
    const durationMs = master.duration.toSeconds() * 1000;
    const rangeStartMs = range.start.getTime();

    const add = (item: ICAL.Event, start: Date, end: Date, rid: Date) => {
      const id = `${item.uid}:${rid.toISOString()}`;
      if (seen.has(id)) {
        return;
      }
      const base = this.parseVEvent(item.component, calendar);
      if (base) {
        seen.add(id);
        occurrences.push({
          ...base,
          id,
          start,
          end,
          recurring: true,
          recurrenceRule: base.recurrenceRule ?? rule,
        });
      }
    };

    // Iterate by RECURRENCE-ID (the original slot), not by the possibly moved
    // start of an override: an instance moved out of the range must not end
    // the scan early. Overlap with the range decides inclusion.
    while (next && next.toJSDate() < range.end) {
      if (
        ++scanned > MAX_RECURRENCE_SCAN ||
        Date.now() > deadline ||
        occurrences.length >= MAX_OCCURRENCES_PER_EVENT
      ) {
        this.logger.warning(
          "Recurrence expansion stopped at its limit",
          { operation: "expandOccurrences", service: "CalendarService" },
          { uid: master.uid, scanned, occurrences: occurrences.length },
        );
        break;
      }
      if (
        overrides.length === 0 &&
        next.toJSDate().getTime() + durationMs < rangeStartMs
      ) {
        next = iterator.next();
        continue;
      }
      const details = master.getOccurrenceDetails(next);
      const occurrence = {
        start: details.startDate.toJSDate(),
        end: details.endDate.toJSDate(),
      } as CalendarEvent;
      if (this.overlaps(occurrence, range)) {
        add(
          details.item,
          occurrence.start,
          occurrence.end,
          details.recurrenceId.toJSDate(),
        );
      }
      next = iterator.next();
    }

    // Instances whose original slot lies after the range but were moved into
    // it are never reached by the scan above.
    for (const vevent of overrides) {
      const recurrenceId = vevent.getFirstPropertyValue("recurrence-id");
      if (!(recurrenceId instanceof ICAL.Time)) {
        continue;
      }
      const rid = recurrenceId.toJSDate();
      if (rid < range.end) {
        continue;
      }
      const item = new ICAL.Event(vevent);
      if (!item.startDate || !item.endDate) {
        continue;
      }
      const occurrence = {
        start: item.startDate.toJSDate(),
        end: item.endDate.toJSDate(),
      } as CalendarEvent;
      if (this.overlaps(occurrence, range)) {
        add(item, occurrence.start, occurrence.end, rid);
      }
    }

    return occurrences;
  }

  private parseVEvent(vevent: unknown, calendar: string): CalendarEvent | null {
    try {
      const event = new ICAL.Event(vevent as ICAL.Component);

      const basicInfo = this.extractBasicEventInfo(event);
      if (!this.hasValidDates(event)) {
        return null;
      }

      const timeInfo = this.extractTimeInfo(event);
      const participantInfo = this.extractParticipants(event);
      const metadataInfo = this.extractMetadata(event, calendar);

      return {
        ...basicInfo,
        ...timeInfo,
        ...participantInfo,
        ...metadataInfo,
      };
    } catch (error) {
      this.logger.error(
        "Error parsing VEVENT",
        {
          operation: "parseVEvent",
          service: "CalendarService",
        },
        { error: error instanceof Error ? error.message : String(error) },
      );
      return null;
    }
  }

  private extractBasicEventInfo(
    event: ICAL.Event,
  ): Pick<
    CalendarEvent,
    "id" | "uid" | "summary" | "description" | "location"
  > {
    const uid = event.uid || `${Date.now()}-${Math.random()}`;
    return {
      id: uid,
      uid,
      summary: event.summary || "",
      description: event.description,
      location: event.location,
    };
  }

  private hasValidDates(event: ICAL.Event): boolean {
    return !!(event.startDate && event.endDate);
  }

  private extractTimeInfo(
    event: ICAL.Event,
  ): Pick<
    CalendarEvent,
    "start" | "end" | "allDay" | "recurring" | "recurrenceRule"
  > {
    return {
      start: event.startDate.toJSDate(),
      end: event.endDate.toJSDate(),
      allDay: event.startDate.isDate,
      recurring: event.isRecurring(),
      recurrenceRule: event.component
        .getFirstPropertyValue("rrule")
        ?.toString(),
    };
  }

  private extractParticipants(
    event: ICAL.Event,
  ): Pick<CalendarEvent, "attendees" | "organizer"> {
    const attendees = this.parseAttendees(event.attendees);
    const organizer = this.parseOrganizer(event.organizer);

    return {
      attendees: attendees.length > 0 ? attendees : undefined,
      organizer,
    };
  }

  private parseAttendees(attendees: unknown[] | null | undefined): Attendee[] {
    // Früher Return mit leerem Array wenn attendees falsy ist
    if (!attendees || !Array.isArray(attendees)) {
      return [];
    }

    return attendees.map((attendee: unknown) => {
      const email = this.extractEmail(attendee);
      return {
        email: email.replace("mailto:", ""),
        name: this.extractName(attendee, email),
        status: this.extractStatus(attendee),
      };
    });
  }

  private parseOrganizer(
    organizer: unknown,
  ): { email: string; name: string } | undefined {
    if (!organizer) {
      return undefined;
    }

    const email = this.extractEmail(organizer).replace("mailto:", "");
    return {
      email,
      name: this.extractName(organizer, email),
    };
  }

  private extractEmail(participant: unknown): string {
    const typedParticipant = participant as { getFirstValue?: () => string };
    return typedParticipant.getFirstValue
      ? typedParticipant.getFirstValue()
      : String(participant);
  }

  private extractName(participant: unknown, email: string): string {
    const typedParticipant = participant as {
      getParameter?: (name: string) => string;
    };
    return typedParticipant.getParameter
      ? typedParticipant.getParameter("cn")
      : email.replace("mailto:", "").split("@")[0];
  }

  private extractStatus(
    attendee: unknown,
  ): "needs-action" | "accepted" | "declined" | "tentative" {
    // Handle null/undefined or non-object attendees
    if (!attendee || typeof attendee !== "object") {
      return "needs-action";
    }

    const typedAttendee = attendee as {
      getParameter?: (name: string) => string;
    };
    const status = typedAttendee.getParameter
      ? typedAttendee.getParameter("partstat") || "needs-action"
      : "needs-action";

    // Map iCal status values to our expected types
    switch (status.toLowerCase()) {
      case "accepted":
        return "accepted";
      case "declined":
        return "declined";
      case "tentative":
        return "tentative";
      default:
        return "needs-action";
    }
  }

  private extractMetadata(
    event: ICAL.Event,
    calendar: string,
  ): Pick<CalendarEvent, "calendar" | "categories" | "created" | "modified"> {
    const categories = this.parseCategories(
      event.component.getFirstPropertyValue("categories"),
    );

    return {
      calendar,
      categories,
      created:
        this.parseICalDate(event.component.getFirstPropertyValue("created")) ||
        new Date(),
      modified:
        this.parseICalDate(
          event.component.getFirstPropertyValue("last-modified"),
        ) || new Date(),
    };
  }

  private parseCategories(categories: unknown): string[] {
    return categories && typeof categories === "string"
      ? categories.split(",").map((cat: string) => cat.trim())
      : [];
  }

  private parseICalDate(value: unknown): Date | null {
    if (!value) return null;
    const typedValue = value as { toJSDate?: () => Date };
    if (typedValue.toJSDate && typeof typedValue.toJSDate === "function") {
      return typedValue.toJSDate();
    }
    if (typeof value === "string") {
      return dayjs(value).toDate();
    }
    return null;
  }

  private filterEventsByQuery(
    events: CalendarEvent[],
    query?: string,
  ): CalendarEvent[] {
    if (!query) return events;

    const searchTerm = query.toLowerCase();

    return events.filter(
      event =>
        event.summary.toLowerCase().includes(searchTerm) ||
        event.description?.toLowerCase().includes(searchTerm) ||
        event.location?.toLowerCase().includes(searchTerm),
    );
  }

  private sortAndLimitEvents(
    events: CalendarEvent[],
    options: CalendarSearchOptions,
  ): CalendarEvent[] {
    const sorted = events.sort((a, b) => a.start.getTime() - b.start.getTime());

    if (options.offset || options.limit) {
      const start = options.offset || 0;
      const end = options.limit ? start + options.limit : undefined;
      return sorted.slice(start, end);
    }

    return sorted;
  }

  private calculateFreeBusy(
    events: CalendarEvent[],
    start: Date,
    end: Date,
  ): FreeBusyInfo {
    const busy: Array<{ start: Date; end: Date; summary?: string }> = [];

    for (const event of events) {
      if (event.start < end && event.end > start) {
        busy.push({
          start: new Date(Math.max(event.start.getTime(), start.getTime())),
          end: new Date(Math.min(event.end.getTime(), end.getTime())),
          summary: event.summary,
        });
      }
    }

    // Calculate free time slots
    const free: Array<{ start: Date; end: Date }> = [];
    busy.sort((a, b) => a.start.getTime() - b.start.getTime());

    let currentTime = start;
    for (const busySlot of busy) {
      if (currentTime < busySlot.start) {
        free.push({
          start: new Date(currentTime),
          end: new Date(busySlot.start),
        });
      }
      currentTime = new Date(
        Math.max(currentTime.getTime(), busySlot.end.getTime()),
      );
    }

    if (currentTime < end) {
      free.push({
        start: new Date(currentTime),
        end: new Date(end),
      });
    }

    return { start, end, busy, free };
  }

  // Get circuit breaker metrics
  getCircuitBreakerMetrics(): CircuitBreakerMetrics {
    return this.circuitBreaker.getMetrics();
  }

  // Reset circuit breaker (for administrative purposes)
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }

  // Clean up resources
  async disconnect(): Promise<void> {
    this.client = null;
    this.circuitBreaker.reset();
  }
}
