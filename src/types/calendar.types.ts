// Shared types for calendar functionality
export interface Attendee {
  email: string;
  name?: string;
  status: "needs-action" | "accepted" | "declined" | "tentative";
}

export interface CalendarEvent {
  id: string;
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurring: boolean;
  recurrenceRule?: string;
  attendees?: Attendee[];
  organizer?: {
    email: string;
    name?: string;
  };
  calendar: string;
  url?: string;
  categories?: string[];
  created: Date;
  modified: Date;
}

export interface CalendarSearchOptions {
  query?: string;
  start?: Date;
  end?: Date;
  calendar?: string;
  limit?: number;
  offset?: number;
}

export interface FreeBusyInfo {
  start: Date;
  end: Date;
  busy: Array<{
    start: Date;
    end: Date;
    summary?: string;
  }>;
  free: Array<{
    start: Date;
    end: Date;
  }>;
}

export interface CalDavConnection {
  baseUrl: string;
  username: string;
  password: string;
  calendars?: string[];
}

export interface CreateCalendarEventOptions {
  summary: string;
  start: Date;
  end: Date;
  /**
   * The calendar date as the caller wrote it (YYYY-MM-DD). An all-day event
   * uses it instead of the UTC date of the instant, which is the previous
   * day for a midnight in any zone east of UTC.
   */
  startDate?: string;
  endDate?: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  attendees?: Array<{ email: string; name?: string }>;
  calendar?: string;
}

export interface CreateCalendarEventResult {
  uid: string;
  summary: string;
  start: Date;
  end: Date;
  allDay: boolean;
  /** For all-day events: the DTSTART date written (YYYY-MM-DD). */
  startDate?: string;
  /** For all-day events: the exclusive DTEND date written (YYYY-MM-DD). */
  endDate?: string;
  calendar: string;
}
