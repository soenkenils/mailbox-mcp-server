import dayjs from "dayjs";
import { type DAVCalendar, type DAVObject, createDAVClient } from "tsdav";
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
  private client: any;

  constructor(connection: CalDavConnection, cache: LocalCache) {
    this.connection = connection;
    this.cache = cache;
  }

  private async getClient() {
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
      const client = await this.getClient();
      const calendars = await client.fetchCalendars();

      return calendars.map((cal: DAVCalendar) => cal.displayName || cal.url);
    } catch (error) {
      console.error("Calendar discovery failed:", error);
      return ["personal"];
    }
  }

  private async fetchEventsFromCalendar(
    calendar: string,
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    try {
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

      return this.parseCalendarObjects(calendarObjects, calendar);
    } catch (error) {
      console.error(`Error fetching events from calendar ${calendar}:`, error);
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
      console.error("Error parsing calendar objects:", error);
    }

    return events;
  }

  private parseICalData(icalData: string, calendar: string): CalendarEvent[] {
    const events: CalendarEvent[] = [];

    try {
      // Basic iCalendar parsing - extract VEVENT sections
      const vevents = this.extractVEvents(icalData);

      for (const veventData of vevents) {
        const event = this.parseVEvent(veventData, calendar);
        if (event) {
          events.push(event);
        }
      }
    } catch (error) {
      console.error("Error parsing iCal data:", error);
    }

    return events;
  }

  private extractVEvents(icalData: string): string[] {
    const vevents: string[] = [];
    const lines = icalData.split(/\r?\n/);
    let currentVEvent = "";
    let inVEvent = false;

    for (const line of lines) {
      if (line.startsWith("BEGIN:VEVENT")) {
        inVEvent = true;
        currentVEvent = line + "\n";
      } else if (line.startsWith("END:VEVENT")) {
        currentVEvent += line;
        vevents.push(currentVEvent);
        currentVEvent = "";
        inVEvent = false;
      } else if (inVEvent) {
        currentVEvent += line + "\n";
      }
    }

    return vevents;
  }

  private parseVEvent(
    veventData: string,
    calendar: string,
  ): CalendarEvent | null {
    try {
      const props = this.parseVEventProperties(veventData);

      const uid = props.get("UID") || `${Date.now()}-${Math.random()}`;
      const summary = props.get("SUMMARY") || "";
      const description = props.get("DESCRIPTION");
      const location = props.get("LOCATION");
      const dtstart = props.get("DTSTART");
      const dtend = props.get("DTEND") || props.get("DTSTART");
      const rrule = props.get("RRULE");

      if (!dtstart) return null;

      const start = this.parseDateTime(dtstart);
      const end = this.parseDateTime(dtend || dtstart);

      if (!start || !end) return null;

      const allDay = dtstart.length === 8; // YYYYMMDD format

      return {
        id: uid,
        uid,
        summary,
        description,
        location,
        start,
        end,
        allDay,
        recurring: !!rrule,
        recurrenceRule: rrule,
        attendees: this.parseAttendeesFromProps(props),
        organizer: this.parseOrganizerFromProps(props),
        calendar,
        categories: this.parseCategoriesFromProps(props),
        created: new Date(),
        modified: new Date(),
      };
    } catch (error) {
      console.error("Error parsing VEVENT:", error);
      return null;
    }
  }

  private parseVEventProperties(veventData: string): Map<string, string> {
    const props = new Map<string, string>();
    const lines = veventData.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Handle line folding
      while (
        i + 1 < lines.length &&
        (lines[i + 1].startsWith(" ") || lines[i + 1].startsWith("\t"))
      ) {
        line += lines[i + 1].substring(1);
        i++;
      }

      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).split(";")[0]; // Remove parameters
        const value = line.substring(colonIndex + 1);
        props.set(key, value);
      }
    }

    return props;
  }

  private parseDateTime(dateStr: string): Date | null {
    try {
      // Handle different date formats
      if (dateStr.length === 8) {
        // YYYYMMDD format
        return dayjs(dateStr, "YYYYMMDD").toDate();
      } else if (dateStr.includes("T")) {
        // YYYYMMDDTHHMMSS format
        const cleanDate = dateStr.replace(/[TZ]/g, "");
        return dayjs(cleanDate, "YYYYMMDDHHmmss").toDate();
      }
      return null;
    } catch {
      return null;
    }
  }

  private parseAttendeesFromProps(
    props: Map<string, string>,
  ): CalendarEvent["attendees"] {
    const attendees: CalendarEvent["attendees"] = [];

    // This is a simplified implementation - in a real scenario you'd need to handle multiple attendees
    // and parse the full property parameters
    for (const [key, value] of props) {
      if (key.startsWith("ATTENDEE")) {
        const email = value.replace("mailto:", "");
        attendees.push({
          email,
          name: email.split("@")[0],
          status: "needs-action",
        });
      }
    }

    return attendees.length > 0 ? attendees : undefined;
  }

  private parseOrganizerFromProps(
    props: Map<string, string>,
  ): CalendarEvent["organizer"] {
    const organizer = props.get("ORGANIZER");
    if (!organizer) return undefined;

    const email = organizer.replace("mailto:", "");
    return { email, name: email.split("@")[0] };
  }

  private parseCategoriesFromProps(props: Map<string, string>): string[] {
    const categories = props.get("CATEGORIES");
    if (!categories) return [];

    return categories.split(",").map((cat) => cat.trim());
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
