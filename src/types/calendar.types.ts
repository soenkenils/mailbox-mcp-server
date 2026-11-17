// Shared types for calendar functionality
export interface Attendee {
  email: string;
  name?: string;
  status: "needs-action" | "accepted" | "declined" | "tentative";
}

export interface CalendarEvent {
  /** Unique per occurrence: the UID, or "UID:RECURRENCE-ID" for one instance. */
  id: string;
  /** The UID of the event or, for an occurrence, of its whole series. */
  uid: string;
  /**
   * Set when this is one occurrence of a recurring series: its original
   * start (YYYY-MM-DD for all-day series, otherwise an ISO 8601 UTC instant).
   */
  recurrenceId?: string;
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
  /**
   * When false (the default) attendees are only recorded: no ORGANIZER is
   * written and every ATTENDEE carries SCHEDULE-AGENT=CLIENT, so the server
   * sends no invitations (RFC 6638). When true the account becomes the
   * ORGANIZER and the server may email invitations to every attendee.
   */
  sendInvitations?: boolean;
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

export interface UpdateCalendarEventOptions {
  /** The series UID; an occurrence id ("UID:RECURRENCE-ID") is refused. */
  uid: string;
  /** Narrows the lookup when the same UID exists in several calendars. */
  calendar?: string;
  summary?: string;
  start?: Date;
  end?: Date;
  /**
   * All-day events: the DTSTART date and the exclusive DTEND date
   * (YYYY-MM-DD) as the caller wrote them, not the UTC date of the instant.
   */
  startDate?: string;
  endDate?: string;
  /** An empty string removes the description. */
  description?: string;
  /** An empty string removes the location. */
  location?: string;
  allDay?: boolean;
  /** Replaces the attendee list; an empty array removes all attendees. */
  attendees?: Array<{ email: string; name?: string }>;
  /**
   * When false (the default) the update must not make the server email
   * anyone: new attendees are only recorded (SCHEDULE-AGENT=CLIENT), and an
   * event that is already a meeting you organize is not changed at all.
   * When true the server may email invitations, updates and cancellations.
   */
  sendInvitations?: boolean;
}

export interface UpdateCalendarEventResult {
  event: CalendarEvent;
  /** Whether the server was allowed to notify participants. */
  notified: boolean;
}

export interface DeleteCalendarEventOptions {
  /** The series UID; an occurrence id ("UID:RECURRENCE-ID") is refused. */
  uid: string;
  calendar?: string;
  /**
   * When false (the default) the delete must not make the server email
   * anyone: a meeting you organize is not deleted, and for an invitation you
   * received the server is asked not to send a decline (Schedule-Reply: F).
   */
  notifyParticipants?: boolean;
}

export interface DeleteCalendarEventResult {
  uid: string;
  summary: string;
  calendar: string;
  recurring: boolean;
  /** Whether the server was allowed to notify participants. */
  notified: boolean;
}
