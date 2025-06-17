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
