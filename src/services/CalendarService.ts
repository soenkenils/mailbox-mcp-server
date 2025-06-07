import dayjs from "dayjs";
import * as ICAL from "ical.js";
import fetch from "node-fetch";
import type { LocalCache } from "../types/cache.types.js";
import type {
  CalDavConnection,
  CalendarEvent,
  CalendarSearchOptions,
  FreeBusyInfo,
} from "../types/calendar.types.js";

export class CalendarService {
  private connection: CalDavConnection;
  private cache: LocalCache;

  constructor(connection: CalDavConnection, cache: LocalCache) {
    this.connection = connection;
    this.cache = cache;
  }

  async getCalendarEvents(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const cacheKey = `calendar_events:${JSON.stringify(options)}`;
    const cached = this.cache.get<CalendarEvent[]>(cacheKey);

    if (cached) {
      return cached;
    }

    const events = await this.fetchCalendarEvents(options);
    this.cache.set(cacheKey, events, 900000); // 15 minutes TTL

    return events;
  }

  async searchCalendar(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const cacheKey = `calendar_search:${JSON.stringify(options)}`;
    const cached = this.cache.get<CalendarEvent[]>(cacheKey);

    if (cached) {
      return cached;
    }

    const events = await this.fetchCalendarEvents(options);
    const filteredEvents = this.filterEventsByQuery(events, options.query);

    this.cache.set(cacheKey, filteredEvents, 900000); // 15 minutes TTL

    return filteredEvents;
  }

  async getFreeBusy(
    start: Date,
    end: Date,
    calendar?: string,
  ): Promise<FreeBusyInfo> {
    const cacheKey = `freebusy:${start.toISOString()}:${end.toISOString()}:${calendar || "all"}`;
    const cached = this.cache.get<FreeBusyInfo>(cacheKey);

    if (cached) {
      return cached;
    }

    const events = await this.fetchCalendarEvents({
      start,
      end,
      calendar,
    });

    const freeBusy = this.calculateFreeBusy(events, start, end);
    this.cache.set(cacheKey, freeBusy, 300000); // 5 minutes TTL

    return freeBusy;
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
      console.error("Error fetching calendar events:", error);
      return [];
    }
  }

  private async discoverCalendars(): Promise<string[]> {
    try {
      const propfindXml = `<?xml version="1.0" encoding="utf-8" ?>
        <D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
          <D:prop>
            <D:displayname />
            <D:resourcetype />
            <C:calendar-description />
          </D:prop>
        </D:propfind>`;

      const response = await fetch(
        `${this.connection.baseUrl}calendars/${this.connection.username}/`,
        {
          method: "PROPFIND",
          headers: {
            "Content-Type": "application/xml",
            Depth: "1",
            Authorization: `Basic ${Buffer.from(`${this.connection.username}:${this.connection.password}`).toString("base64")}`,
          },
          body: propfindXml,
        },
      );

      if (!response.ok) {
        throw new Error(`CalDAV discovery failed: ${response.status}`);
      }

      // Basic calendar discovery - in a real implementation, you'd parse the XML response
      return ["personal"]; // Default calendar name
    } catch (error) {
      console.error("Calendar discovery failed:", error);
      return ["personal"];
    }
  }

  private async fetchEventsFromCalendar(
    calendar: string,
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const reportXml = this.buildCalendarQuery(options);

    const response = await fetch(
      `${this.connection.baseUrl}calendars/${this.connection.username}/${calendar}/`,
      {
        method: "REPORT",
        headers: {
          "Content-Type": "application/xml",
          Depth: "1",
          Authorization: `Basic ${Buffer.from(`${this.connection.username}:${this.connection.password}`).toString("base64")}`,
        },
        body: reportXml,
      },
    );

    if (!response.ok) {
      throw new Error(`CalDAV REPORT failed: ${response.status}`);
    }

    const responseText = await response.text();
    return this.parseCalendarResponse(responseText, calendar);
  }

  private buildCalendarQuery(options: CalendarSearchOptions): string {
    const start = options.start
      ? dayjs(options.start).format("YYYYMMDD[T]HHmmss[Z]")
      : "";
    const end = options.end
      ? dayjs(options.end).format("YYYYMMDD[T]HHmmss[Z]")
      : "";

    let timeRange = "";
    if (start || end) {
      timeRange = `<C:time-range start="${start}" end="${end}"/>`;
    }

    return `<?xml version="1.0" encoding="utf-8" ?>
      <C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
        <D:prop>
          <D:getetag />
          <C:calendar-data />
        </D:prop>
        <C:filter>
          <C:comp-filter name="VCALENDAR">
            <C:comp-filter name="VEVENT">
              ${timeRange}
            </C:comp-filter>
          </C:comp-filter>
        </C:filter>
      </C:calendar-query>`;
  }

  private parseCalendarResponse(
    responseText: string,
    calendar: string,
  ): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      // Extract iCalendar data from the XML response
      const calendarDataRegex =
        /<C:calendar-data[^>]*>([\s\S]*?)<\/C:calendar-data>/g;
      let match;

      while ((match = calendarDataRegex.exec(responseText)) !== null) {
        const icalData = match[1].trim();
        if (icalData) {
          const parsedEvents = this.parseICalData(icalData, calendar);
          events.push(...parsedEvents);
        }
      }
    } catch (error) {
      console.error("Error parsing calendar response:", error);
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
        const event = new ICAL.Event(vevent);

        const calendarEvent: CalendarEvent = {
          id: event.uid || `${Date.now()}-${Math.random()}`,
          uid: event.uid || "",
          summary: event.summary || "",
          description: event.description || undefined,
          location: event.location || undefined,
          start: event.startDate.toJSDate(),
          end: event.endDate.toJSDate(),
          allDay: event.startDate.isDate,
          recurring: event.isRecurring(),
          recurrenceRule: event.isRecurring()
            ? vevent.getFirstPropertyValue("rrule")?.toString()
            : undefined,
          attendees: this.parseAttendees(vevent),
          organizer: this.parseOrganizer(vevent),
          calendar,
          categories: this.parseCategories(vevent),
          created: new Date(),
          modified: new Date(),
        };

        events.push(calendarEvent);

        // Handle recurring events
        if (event.isRecurring()) {
          const expand = new ICAL.RecurExpansion({
            component: vevent,
            dtstart: event.startDate,
          });

          const endTime = dayjs().add(1, "year").toDate();
          let next;

          while ((next = expand.next()) && next.toJSDate() < endTime) {
            const recurringEvent = { ...calendarEvent };
            recurringEvent.id = `${event.uid}-${next.toString()}`;
            recurringEvent.start = next.toJSDate();

            const duration = dayjs(calendarEvent.end).diff(
              dayjs(calendarEvent.start),
            );
            recurringEvent.end = dayjs(next.toJSDate())
              .add(duration, "milliseconds")
              .toDate();

            events.push(recurringEvent);
          }
        }
      }
    } catch (error) {
      console.error("Error parsing iCal data:", error);
    }

    return events;
  }

  private parseAttendees(vevent: ICAL.Component): CalendarEvent["attendees"] {
    const attendees: CalendarEvent["attendees"] = [];
    const attendeeProps = vevent.getAllProperties("attendee");

    for (const prop of attendeeProps) {
      const email = prop.getFirstValue().replace("mailto:", "");
      const name = prop.getParameter("cn");
      const partstat = prop.getParameter("partstat") || "needs-action";

      attendees.push({
        email,
        name,
        status: partstat.toLowerCase() as any,
      });
    }

    return attendees.length > 0 ? attendees : undefined;
  }

  private parseOrganizer(vevent: ICAL.Component): CalendarEvent["organizer"] {
    const organizerProp = vevent.getFirstProperty("organizer");
    if (!organizerProp) return undefined;

    const email = organizerProp.getFirstValue().replace("mailto:", "");
    const name = organizerProp.getParameter("cn");

    return { email, name };
  }

  private parseCategories(vevent: ICAL.Component): string[] {
    const categoriesProp = vevent.getFirstProperty("categories");
    if (!categoriesProp) return [];

    const categories = categoriesProp.getFirstValue();
    return Array.isArray(categories) ? categories : [categories];
  }

  private filterEventsByQuery(
    events: CalendarEvent[],
    query?: string,
  ): CalendarEvent[] {
    if (!query) return events;

    const searchTerm = query.toLowerCase();

    return events.filter(
      (event) =>
        event.summary.toLowerCase().includes(searchTerm) ||
        (event.description &&
          event.description.toLowerCase().includes(searchTerm)) ||
        (event.location && event.location.toLowerCase().includes(searchTerm)),
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
}
