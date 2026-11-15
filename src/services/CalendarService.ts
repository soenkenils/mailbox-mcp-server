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
    const iCalString = this.buildICalString(uid, options, dates);

    // Only the network calls sit inside the breaker: a calendar name the
    // caller got wrong must not count towards opening the circuit.
    const { client, candidates } = await this.circuitBreaker.execute(
      async () => {
        const client = await this.getClient();
        return {
          client,
          candidates: await this.selectCalendars(client, options.calendar),
        };
      },
    );
    const target = this.chooseCreateTarget(candidates, options.calendar);
    const calendarName = calendarLabel(target);

    const response = await this.circuitBreaker.execute(() =>
      client.createCalendarObject({
        calendar: target,
        filename: `${uid}.ics`,
        iCalString,
      }),
    );
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
   * The calendar a new event goes to: the one the caller named, or the first
   * candidate. A name that matches several calendars is refused rather than
   * guessed, unless exactly one of them carries it as its display name.
   */
  private chooseCreateTarget(
    candidates: DAVCalendar[],
    calendarFilter?: string,
  ): DAVCalendar {
    if (candidates.length === 0) {
      throw calendarFilter
        ? new ValidationError(
            `Calendar "${calendarFilter}" not found`,
            "calendar",
            calendarFilter,
          )
        : new CalendarError(
            "No calendar available to create the event in",
            ErrorCode.CALENDAR_NOT_FOUND,
          );
    }

    if (calendarFilter && candidates.length > 1) {
      const exact = candidates.filter(
        calendar => calendar.displayName === calendarFilter.trim(),
      );
      if (exact.length === 1) {
        return exact[0];
      }
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
   * Calendars a write may touch: those that can hold events and match the
   * optional filter.
   */
  private async selectCalendars(
    client: DAVClient,
    calendarFilter?: string,
  ): Promise<DAVCalendar[]> {
    const calendars = await client.fetchCalendars();

    return calendars.filter(
      calendar =>
        this.holdsEvents(calendar) &&
        (!calendarFilter || this.calendarMatches(calendar, calendarFilter)),
    );
  }

  private calendarMatches(calendar: DAVCalendar, name: string): boolean {
    const wanted = name.trim();
    return calendar.displayName === wanted || calendar.url.includes(wanted);
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
      // RFC 5545 3.8.4.3: a group-scheduled event must name its organizer.
      if (this.connection.username.includes("@")) {
        lines.push(`ORGANIZER:mailto:${this.connection.username}`);
      }
      for (const attendee of options.attendees) {
        const cn = attendee.name
          ? `;CN=${this.quoteICalParameter(attendee.name)}`
          : "";
        lines.push(`ATTENDEE${cn}:mailto:${attendee.email}`);
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

      return await this.parseCalendarObjects(calendarObjects, calendar);
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
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      for (const obj of calendarObjects) {
        if (obj.data) {
          const parsedEvents = this.parseICalData(obj.data, calendar);
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

  private parseICalData(icalData: string, calendar: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      const jcalData = ICAL.parse(icalData);
      const comp = new ICAL.Component(jcalData);
      const vevents = comp.getAllSubcomponents("vevent");

      for (const vevent of vevents) {
        const event = this.parseVEvent(vevent, calendar);
        if (event) {
          events.push(event);
        }
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
