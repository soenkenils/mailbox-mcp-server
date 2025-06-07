// CalDAV types for mailbox-mcp-server
export interface CalDAVConfig {
  serverUrl: string;
  username: string;
  password: string;
  authTimeout?: number;
  connTimeout?: number;
  tls: boolean;
  tlsOptions?: Record<string, unknown>;
}

export interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  location?: string;
  start: Date;
  end: Date;
  allDay: boolean;
  recurrence?: string;
  attendees?: EventAttendee[];
  organizer?: EventAttendee;
  created: Date;
  lastModified: Date;
  status: EventStatus;
  url?: string;
  etag?: string;
  calendarName: string;
  sequence: number;
  color?: string;
  categories?: string[];
  reminders?: EventReminder[];
  availability?: EventAvailability;
}

export enum EventStatus {
  CONFIRMED = "CONFIRMED",
  TENTATIVE = "TENTATIVE",
  CANCELLED = "CANCELLED",
}

export enum EventAvailability {
  FREE = "FREE",
  BUSY = "BUSY",
  TENTATIVE = "TENTATIVE",
  OOF = "OOF", // Out of office
}

export interface EventAttendee {
  name?: string;
  email: string;
  role?: AttendeeRole;
  status?: AttendeeStatus;
  type?: AttendeeType;
}

export enum AttendeeRole {
  REQUIRED = "REQ-PARTICIPANT",
  OPTIONAL = "OPT-PARTICIPANT",
  CHAIR = "CHAIR",
  NON_PARTICIPANT = "NON-PARTICIPANT",
}

export enum AttendeeStatus {
  NEEDS_ACTION = "NEEDS-ACTION",
  ACCEPTED = "ACCEPTED",
  DECLINED = "DECLINED",
  TENTATIVE = "TENTATIVE",
  DELEGATED = "DELEGATED",
}

export enum AttendeeType {
  INDIVIDUAL = "INDIVIDUAL",
  GROUP = "GROUP",
  RESOURCE = "RESOURCE",
  ROOM = "ROOM",
}

export interface EventReminder {
  type: ReminderType;
  minutes: number;
}

export enum ReminderType {
  DISPLAY = "DISPLAY",
  EMAIL = "EMAIL",
}

export interface Calendar {
  url: string;
  name: string;
  description?: string;
  color?: string;
  ctag?: string;
  syncToken?: string;
  isDefault?: boolean;
  isReadOnly?: boolean;
}

export interface CalendarSearchOptions {
  query?: string;
  calendarUrls?: string[];
  start?: Date;
  end?: Date;
  limit?: number;
  offset?: number;
  categories?: string[];
}

export interface CreateEventOptions {
  calendarUrl: string;
  event: Partial<CalendarEvent>;
}

export interface UpdateEventOptions {
  calendarUrl: string;
  eventUrl: string;
  event: Partial<CalendarEvent>;
  etag?: string;
}

export interface DeleteEventOptions {
  calendarUrl: string;
  eventUrl: string;
  etag?: string;
}

export interface FreeBusyOptions {
  calendarUrls?: string[];
  start: Date;
  end: Date;
}

export interface FreeBusyPeriod {
  start: Date;
  end: Date;
  type: FreeBusyType;
}

export enum FreeBusyType {
  FREE = "FREE",
  BUSY = "BUSY",
  TENTATIVE = "TENTATIVE",
  OOF = "OOF",
}
