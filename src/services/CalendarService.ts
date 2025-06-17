import dayjs from "dayjs";
import ICAL from "ical.js";
import { type DAVCalendar, type DAVObject, createDAVClient } from "tsdav";
import type { LocalCache } from "../types/cache.types.js";
import type {
  Attendee,
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
      console.error("Error parsing iCal data:", error);
    }

    return events;
  }

  private parseVEvent(vevent: any, calendar: string): CalendarEvent | null {
    try {
      const event = new ICAL.Event(vevent);

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
      console.error("Error parsing VEVENT:", error);
      return null;
    }
  }

  private extractBasicEventInfo(
    event: any,
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

  private hasValidDates(event: any): boolean {
    return !!(event.startDate && event.endDate);
  }

  private extractTimeInfo(
    event: any,
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
    event: any,
  ): Pick<CalendarEvent, "attendees" | "organizer"> {
    const attendees = this.parseAttendees(event.attendees);
    const organizer = this.parseOrganizer(event.organizer);

    return {
      attendees: attendees.length > 0 ? attendees : undefined,
      organizer,
    };
  }

  private parseAttendees(
    attendees: any[],
  ): Attendee[] {
    // Früher Return mit leerem Array wenn attendees falsy ist
    if (!attendees || !Array.isArray(attendees)) {
      return [];
    }

    return attendees.map((attendee: any) => {
      const email = this.extractEmail(attendee);
      return {
        email: email.replace("mailto:", ""),
        name: this.extractName(attendee, email),
        status: this.extractStatus(attendee),
      };
    });
  }

  private parseOrganizer(
    organizer: any,
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

  private extractEmail(participant: any): string {
    return participant.getFirstValue
      ? participant.getFirstValue()
      : String(participant);
  }

  private extractName(participant: any, email: string): string {
    return participant.getParameter
      ? participant.getParameter("cn")
      : email.replace("mailto:", "").split("@")[0];
  }

  private extractStatus(attendee: any): "needs-action" | "accepted" | "declined" | "tentative" {
    const status = attendee.getParameter
      ? attendee.getParameter("partstat") || "needs-action"
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
    event: any,
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

  private parseCategories(categories: any): string[] {
    return categories && typeof categories === "string"
      ? categories.split(",").map((cat: string) => cat.trim())
      : [];
  }

  private parseICalDate(value: any): Date | null {
    if (!value) return null;
    if (value.toJSDate && typeof value.toJSDate === "function") {
      return value.toJSDate();
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
