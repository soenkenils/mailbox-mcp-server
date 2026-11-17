import { randomUUID } from "node:crypto";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import ICAL from "ical.js";
import {
  createDAVClient,
  type DAVCalendar,
  type DAVObject,
  getBasicAuthHeaders,
} from "tsdav";
import type { LocalCache } from "../types/cache.types.js";
import type {
  Attendee,
  CalDavConnection,
  CalendarEvent,
  CalendarSearchOptions,
  CreateCalendarEventOptions,
  CreateCalendarEventResult,
  DeleteCalendarEventOptions,
  DeleteCalendarEventResult,
  FreeBusyInfo,
  UpdateCalendarEventOptions,
  UpdateCalendarEventResult,
} from "../types/calendar.types.js";
import { CalendarError, ErrorCode, ValidationError } from "../types/errors.js";
import { createCacheFetcher } from "../utils/cacheFallback.js";
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
 * reach today. This cap is the deterministic bound (~0.3 s warm).
 */
const MAX_RECURRENCE_SCAN = 50_000;
/**
 * Wall-clock safety net for expanding one recurring event. Kept above the
 * normal cost of a full scan: a tighter budget made results depend on machine
 * load (a cold or busy process dropped long-running series entirely).
 */
const RECURRENCE_TIME_BUDGET_MS = 1_000;
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

/**
 * Id of one instance of a series: UID plus RECURRENCE-ID. All-day instances
 * use the date itself, so the id does not depend on the server's time zone.
 */
const recurrenceIdText = (recurrenceId: ICAL.Time): string =>
  recurrenceId.isDate
    ? recurrenceId.toString()
    : recurrenceId.toJSDate().toISOString();

/**
 * An occurrence id as the read tools report it: "UID:2025-06-20" or
 * "UID:2025-06-20T08:00:00.000Z".
 */
const OCCURRENCE_ID =
  /^(.+):(\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?)$/;

interface LocatedEvent {
  object: DAVObject;
  calendarName: string;
  calendarUrl: string;
}

const calendarLabel = (calendar: DAVCalendar): string =>
  (calendar.displayName as string) || calendar.url;

export class CalendarService {
  private connection: CalDavConnection;
  private cache: LocalCache;
  private client: Awaited<ReturnType<typeof createDAVClient>> | null = null;
  private circuitBreaker: CircuitBreaker;
  private logger = createLogger("CalendarService");
  private cachedFetch: ReturnType<typeof createCacheFetcher>;

  constructor(
    connection: CalDavConnection,
    cache: LocalCache,
    circuitBreakerConfig?: CircuitBreakerConfig,
  ) {
    this.connection = connection;
    this.cache = cache;
    this.cachedFetch = createCacheFetcher(
      this.cache,
      this.logger,
      "CalendarService",
    );

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

  // A failed read is never replaced by a made-up default: an empty event list
  // or an all-free range would read as a real answer rather than an outage.
  async getCalendarEvents(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    return this.cachedFetch(
      `calendar_events:${JSON.stringify(options)}`,
      () => this.fetchCalendarEvents(options),
      "getCalendarEvents",
      900000, // 15 minutes
    );
  }

  async searchCalendar(
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    return this.cachedFetch(
      `calendar_search:${JSON.stringify(options)}`,
      async () =>
        this.filterEventsByQuery(
          await this.fetchCalendarEvents(options),
          options.query,
        ),
      "searchCalendar",
      900000, // 15 minutes
    );
  }

  async getFreeBusy(
    start: Date,
    end: Date,
    calendar?: string,
  ): Promise<FreeBusyInfo> {
    return this.cachedFetch(
      `freebusy:${start.toISOString()}:${end.toISOString()}:${calendar || "all"}`,
      async () =>
        this.calculateFreeBusy(
          await this.fetchCalendarEvents({ start, end, calendar }),
          start,
          end,
        ),
      "getFreeBusy",
      300000, // 5 minutes
    );
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
    const target = this.chooseCreateTarget(calendars, options.calendar);
    const calendarName = calendarLabel(target);

    await this.writeChecked("create", calendarName, uid, () =>
      client.createCalendarObject({
        calendar: target,
        filename: `${uid}.ics`,
        iCalString,
      }),
    );
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
   * Changes the fields passed on the stored event and writes it back with
   * If-Match, so a concurrent change fails with EVENT_MODIFIED instead of
   * being overwritten. Recurring events change as a whole series.
   */
  async updateCalendarEvent(
    options: UpdateCalendarEventOptions,
  ): Promise<UpdateCalendarEventResult> {
    const located = await this.locateSeries(options.uid, options.calendar);

    // The edit happens on the stored iCalendar rather than a rebuilt one, so
    // alarms, recurrence rules, time zones and other properties this server
    // does not model survive the round trip.
    const root = new ICAL.Component(ICAL.parse(String(located.object.data)));
    const withUid = this.eventsWithUid(root, options.uid);
    const vevent = this.editableEvent(withUid, options.uid);
    const role = await this.schedulingRole(withUid);
    const sendInvitations = options.sendInvitations ?? false;

    if (role.kind === "attendee") {
      throw new ValidationError(
        `You were invited to this event by ${role.organizer}; only the organizer can change it. To remove it from your calendar, use delete_calendar_event`,
        "uid",
        options.uid,
      );
    }
    if (role.kind === "organizer" && !sendInvitations) {
      throw new ValidationError(
        `This is a meeting you organize with ${role.attendees} attendee(s): saving any change makes the server email them an update. Pass sendInvitations: true only if the user wants them notified`,
        "sendInvitations",
        false,
      );
    }
    if (role.kind === "unknown" && !sendInvitations) {
      throw new ValidationError(
        `Can't tell whether you organize this meeting (organizer ${role.organizer}). Saving a change may email updates to ${role.attendees} attendee(s); pass sendInvitations: true only if that is acceptable`,
        "sendInvitations",
        false,
      );
    }

    this.applyEventUpdate(vevent, options);
    const notified =
      role.kind === "organizer" ||
      role.kind === "unknown" ||
      (sendInvitations && !!options.attendees?.length);

    // Read from the component that was edited: parsing the whole document
    // again would return whichever VEVENT with this UID comes first, which
    // may be an override rather than the series.
    const updated = this.parseVEvent(vevent, located.calendarName);
    if (!updated) {
      throw new CalendarError(
        "The edited event could not be read back, so it was not saved",
        ErrorCode.OPERATION_FAILED,
        located.calendarName,
        options.uid,
      );
    }

    const data = this.serializeICal(root);
    await this.writeChecked("update", located.calendarName, options.uid, () =>
      this.getClient().then(client =>
        client.updateCalendarObject({
          calendarObject: { ...located.object, data },
        }),
      ),
    );
    this.invalidateEventCaches();

    this.logger.info("Calendar event updated", {
      operation: "updateCalendarEvent",
      service: "CalendarService",
    });

    return { event: updated, notified };
  }

  /**
   * Deletes the stored object (a recurring event with all its occurrences)
   * with If-Match. Unless participants may be notified, a meeting the account
   * organizes is refused, and the server is asked not to send a decline for
   * an invitation (RFC 6638 Schedule-Reply: F).
   */
  async deleteCalendarEvent(
    options: DeleteCalendarEventOptions,
  ): Promise<DeleteCalendarEventResult> {
    const located = await this.locateSeries(options.uid, options.calendar);
    const withUid = this.eventsWithUid(
      new ICAL.Component(ICAL.parse(String(located.object.data))),
      options.uid,
    );
    const role = await this.schedulingRole(withUid);
    const notify = options.notifyParticipants ?? false;

    if (role.kind === "organizer" && !notify) {
      throw new ValidationError(
        `This is a meeting you organize with ${role.attendees} attendee(s): deleting it makes the server email them a cancellation. Pass notifyParticipants: true only if the user wants them told`,
        "notifyParticipants",
        false,
      );
    }
    if (role.kind === "unknown" && !notify) {
      throw new ValidationError(
        `Can't tell whether you organize this meeting (organizer ${role.organizer}). Deleting may email cancellations to ${role.attendees} attendee(s); pass notifyParticipants: true only if that is acceptable`,
        "notifyParticipants",
        false,
      );
    }

    const master = this.findSeriesMaster(withUid) ?? withUid[0];
    const event = master
      ? this.parseVEvent(master, located.calendarName)
      : null;

    // A headers argument replaces tsdav's default ones, so the credentials
    // are passed along with it.
    const headers: Record<string, string> = notify
      ? {}
      : {
          ...getBasicAuthHeaders({
            username: this.connection.username,
            password: this.connection.password,
          }),
          "Schedule-Reply": "F",
        };
    await this.writeChecked("delete", located.calendarName, options.uid, () =>
      this.getClient().then(client =>
        client.deleteCalendarObject({
          calendarObject: located.object,
          ...(notify ? {} : { headers }),
        }),
      ),
    );
    this.invalidateEventCaches();

    this.logger.info("Calendar event deleted", {
      operation: "deleteCalendarEvent",
      service: "CalendarService",
    });

    return {
      uid: options.uid,
      summary: event?.summary ?? "",
      calendar: located.calendarName,
      recurring: event?.recurring ?? false,
      notified: notify && role.kind !== "none",
    };
  }

  /**
   * update and delete act on whole series. A UID that is not stored but has
   * the shape of an occurrence id from the read tools is refused with the
   * series UID to use instead, so a model cannot believe it changed one
   * occurrence when it changed them all. A stored UID of that shape (such as
   * "holiday:2025-12-25") is used as it is.
   */
  private async locateSeries(
    uid: string,
    calendarFilter?: string,
  ): Promise<LocatedEvent> {
    try {
      return await this.locateEvent(uid, calendarFilter);
    } catch (error) {
      const occurrence = OCCURRENCE_ID.exec(uid);
      if (
        occurrence &&
        error instanceof CalendarError &&
        error.code === ErrorCode.EVENT_NOT_FOUND
      ) {
        throw new ValidationError(
          `"${uid}" is the id of one occurrence (${occurrence[2]}) of the recurring series "${occurrence[1]}". Changing or deleting a single occurrence is not supported; this tool acts on the whole series and takes its UID: pass uid "${occurrence[1]}" only if the whole series is meant`,
          "uid",
          uid,
        );
      }
      throw error;
    }
  }

  /**
   * Finds the stored object for a UID among the calendars a write may touch.
   * Throws when nothing matches, and when several calendars hold the UID and
   * the caller did not say which one, so a change never lands on a guess.
   */
  private async locateEvent(
    uid: string,
    calendarFilter?: string,
  ): Promise<LocatedEvent> {
    // Choosing calendars happens outside the breaker: a name the caller got
    // wrong must not count towards opening the circuit.
    const all = await this.listCalendars();
    const calendars = this.selectCalendars(all, calendarFilter);
    if (calendars.length === 0) {
      throw this.noCalendarError(all, calendarFilter);
    }

    const matches = await this.circuitBreaker.execute(async () => {
      const client = await this.getClient();
      const found: LocatedEvent[] = [];
      const failed: DAVCalendar[] = [];
      for (const calendar of calendars) {
        try {
          const object = await this.queryObjectByUid(client, calendar, uid);
          if (object) {
            found.push({
              object,
              calendarName: calendarLabel(calendar),
              calendarUrl: calendar.url,
            });
          }
        } catch (error) {
          failed.push(calendar);
          this.logger.warning(
            "UID query failed, scanning the calendar instead",
            { operation: "locateEvent", service: "CalendarService" },
            { error: error instanceof Error ? error.message : String(error) },
          );
        }
      }

      // Servers differ in how they treat prop-filters: with no hit at all,
      // the miss is confirmed against every full calendar; otherwise only
      // calendars whose query failed are downloaded, so the UID cannot hide
      // in one of them.
      const scan = found.length === 0 ? calendars : failed;
      for (const calendar of scan) {
        const all = await client.fetchCalendarObjects({ calendar });
        const object = all.find(candidate => this.holdsEvent(candidate, uid));
        if (object) {
          found.push({
            object,
            calendarName: calendarLabel(calendar),
            calendarUrl: calendar.url,
          });
        }
      }
      return found;
    });

    if (matches.length === 0) {
      const scope = this.allowedCalendars()
        ? " in the calendars MAILBOX_CALENDARS allows"
        : "";
      throw new CalendarError(
        `No event with UID "${uid}" found${scope}${
          calendarFilter ? ` (calendar "${calendarFilter}")` : ""
        }`,
        ErrorCode.EVENT_NOT_FOUND,
        calendarFilter,
        uid,
      );
    }

    if (matches.length > 1) {
      throw new ValidationError(
        `UID "${uid}" exists in several calendars (${matches
          .map(match => match.calendarName)
          .join(", ")}); pass "calendar" to pick one`,
        "calendar",
        calendarFilter,
      );
    }

    const [located] = matches;
    // The write carries the account's credentials: it must not go to a host
    // other than the calendar's, whatever URL the server listed.
    let sameOrigin = false;
    try {
      sameOrigin =
        new URL(located.object.url, located.calendarUrl).origin ===
        new URL(located.calendarUrl).origin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      throw new CalendarError(
        `The server listed event "${uid}" on a different host than its calendar, so it is not changed (that would send your credentials there)`,
        ErrorCode.EVENT_WRITE_REJECTED,
        located.calendarName,
        uid,
      );
    }
    // tsdav turns a missing getetag into the string "undefined": sent as
    // If-Match it always fails (412), and a truly absent one would make the
    // write unconditional and overwrite concurrent changes.
    const etag = located.object.etag;
    if (!etag || etag === "undefined") {
      throw new CalendarError(
        `The server returned no ETag for event "${uid}", so it cannot be changed safely (a concurrent change could be overwritten); change it in a calendar client`,
        ErrorCode.EVENT_WRITE_REJECTED,
        located.calendarName,
        uid,
      );
    }

    return located;
  }

  /** The object holding the UID, by a CalDAV UID query (REPORT). */
  private async queryObjectByUid(
    client: DAVClient,
    calendar: DAVCalendar,
    uid: string,
  ): Promise<DAVObject | undefined> {
    const filtered = await client.fetchCalendarObjects({
      calendar,
      filters: {
        "comp-filter": {
          _attributes: { name: "VCALENDAR" },
          "comp-filter": {
            _attributes: { name: "VEVENT" },
            "prop-filter": {
              _attributes: { name: "UID" },
              "text-match": {
                _attributes: { collation: "i;octet" },
                _text: uid,
              },
            },
          },
        },
      },
    });
    return filtered.find(object => this.holdsEvent(object, uid));
  }

  private holdsEvent(object: DAVObject, uid: string): boolean {
    if (!object.data) {
      return false;
    }
    try {
      const root = new ICAL.Component(ICAL.parse(String(object.data)));
      return this.eventsWithUid(root, uid).length > 0;
    } catch {
      return false;
    }
  }

  private eventsWithUid(root: ICAL.Component, uid: string): ICAL.Component[] {
    return root
      .getAllSubcomponents("vevent")
      .filter(vevent => vevent.getFirstPropertyValue("uid") === uid);
  }

  /** The VEVENT that is not an override of a single occurrence. */
  private findSeriesMaster(
    vevents: ICAL.Component[],
  ): ICAL.Component | undefined {
    return vevents.find(vevent => !vevent.hasProperty("recurrence-id"));
  }

  /**
   * The VEVENT an update edits: the series master. Overrides of single
   * occurrences carry RECURRENCE-ID and stay untouched. A lone override (an
   * invitation to one occurrence) is edited as it is; several without a
   * series master leave no safe choice.
   */
  private editableEvent(
    withUid: ICAL.Component[],
    uid: string,
  ): ICAL.Component {
    const vevent =
      this.findSeriesMaster(withUid) ??
      (withUid.length === 1 ? withUid[0] : undefined);
    if (vevent) {
      return vevent;
    }
    if (withUid.length > 1) {
      throw new ValidationError(
        "The stored event has several single-occurrence overrides but no series to edit; change it in a calendar client",
        "uid",
        uid,
      );
    }
    throw new CalendarError(
      `No event with UID "${uid}" found`,
      ErrorCode.EVENT_NOT_FOUND,
      undefined,
      uid,
    );
  }

  /**
   * Whether the stored event is a scheduling object (RFC 6638): it has an
   * ORGANIZER and attendees the server would notify, i.e. without
   * SCHEDULE-AGENT=CLIENT. The account organizes it when the ORGANIZER is
   * its username or one of the calendar user addresses the server reports.
   * It was invited only on positive evidence: one of those addresses is an
   * ATTENDEE. Anything else is unknown, since an alias the server did not
   * report would make the account the organizer, and a DELETE then mails
   * cancellations whatever Schedule-Reply says.
   */
  private async schedulingRole(
    vevents: ICAL.Component[],
  ): Promise<
    | { kind: "none" }
    | { kind: "organizer"; attendees: number }
    | { kind: "attendee"; organizer: string }
    | { kind: "unknown"; organizer: string; attendees: number }
  > {
    const address = (value: unknown): string =>
      String(value)
        .replace(/^mailto:/i, "")
        .trim()
        .toLowerCase();
    let organizer: string | undefined;
    const scheduled = new Set<string>();
    const listed = new Set<string>();

    for (const vevent of vevents) {
      const own = vevent.getFirstPropertyValue("organizer");
      if (!own) {
        continue;
      }
      const ownAddress = address(own);
      for (const attendee of vevent.getAllProperties("attendee")) {
        const agent = String(
          attendee.getParameter("schedule-agent") ?? "SERVER",
        ).toUpperCase();
        const attendeeAddress = address(attendee.getFirstValue());
        listed.add(attendeeAddress);
        if (agent !== "CLIENT" && attendeeAddress !== ownAddress) {
          organizer ??= ownAddress;
          scheduled.add(attendeeAddress);
        }
      }
    }

    if (!organizer) {
      return { kind: "none" };
    }
    const mine = await this.ownAddresses();
    if (mine.has(organizer)) {
      return { kind: "organizer", attendees: scheduled.size };
    }
    if ([...listed].some(attendee => mine.has(attendee))) {
      return { kind: "attendee", organizer };
    }
    return { kind: "unknown", organizer, attendees: scheduled.size };
  }

  /** The account's own calendar user addresses, lower-cased, best effort. */
  private async ownAddresses(): Promise<Set<string>> {
    const mine = new Set([this.connection.username.trim().toLowerCase()]);
    try {
      const client = await this.getClient();
      // The client fills in its own account; the typings still demand one.
      const fetchAddresses =
        client.fetchCalendarUserAddresses as unknown as () => Promise<string[]>;
      const addresses = await fetchAddresses();
      for (const value of addresses) {
        mine.add(
          value
            .replace(/^mailto:/i, "")
            .trim()
            .toLowerCase(),
        );
      }
    } catch (error) {
      this.logger.warning(
        "Could not read the account's calendar user addresses",
        { operation: "ownAddresses", service: "CalendarService" },
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
    return mine;
  }

  /** Applies only the fields the caller passed to the VEVENT. */
  private applyEventUpdate(
    vevent: ICAL.Component,
    options: UpdateCalendarEventOptions,
  ): void {
    const event = new ICAL.Event(vevent);
    const wasAllDay = event.startDate?.isDate ?? false;
    const allDay = options.allDay ?? wasAllDay;
    const changesTime =
      options.allDay !== undefined ||
      options.start !== undefined ||
      options.end !== undefined ||
      options.startDate !== undefined ||
      options.endDate !== undefined;

    if (changesTime) {
      this.applyTimeChange(vevent, event, options, allDay, wasAllDay);
    }

    if (options.summary !== undefined) {
      vevent.updatePropertyWithValue("summary", options.summary);
    }
    this.setOptionalText(vevent, "description", options.description);
    this.setOptionalText(vevent, "location", options.location);

    if (options.attendees) {
      this.replaceAttendees(vevent, options);
    }

    const sequence = Number(vevent.getFirstPropertyValue("sequence"));
    vevent.updatePropertyWithValue(
      "sequence",
      (Number.isFinite(sequence) ? sequence : 0) + 1,
    );
    const now = ICAL.Time.fromJSDate(new Date(), true);
    vevent.updatePropertyWithValue("last-modified", now);
    vevent.updatePropertyWithValue("dtstamp", now);
  }

  /**
   * Writes new times the way createCalendarEvent does: timed events in UTC,
   * all-day events as dates with an exclusive DTEND. When only the start is
   * passed, the event keeps its length. Values equal to the stored ones are
   * no change, so passing them leaves the stored times (and a recurring
   * series) untouched.
   */
  private applyTimeChange(
    vevent: ICAL.Component,
    event: ICAL.Event,
    options: UpdateCalendarEventOptions,
    allDay: boolean,
    wasAllDay: boolean,
  ): void {
    const switching = allDay !== wasAllDay;
    if (switching && !(options.start || options.startDate)) {
      throw new ValidationError(
        "start is required when changing allDay",
        "allDay",
        options.allDay,
      );
    }

    let next: { start: ICAL.Time; end: ICAL.Time };
    let unchanged: boolean;
    if (allDay) {
      if (options.start || options.end) {
        throw new ValidationError(
          "All-day events take dates (YYYY-MM-DD) for start and end, not date-times",
          "start",
        );
      }
      const day = (date: string) => dayjs.utc(date);
      const storedStart = wasAllDay ? event.startDate.toString() : undefined;
      const storedEnd = wasAllDay ? event.endDate.toString() : undefined;
      const startDate = options.startDate ?? (storedStart as string);
      const endDate =
        options.endDate ??
        (switching || !storedStart || !storedEnd
          ? day(startDate).add(1, "day").format("YYYY-MM-DD")
          : day(storedEnd)
              .add(day(startDate).diff(day(storedStart), "day"), "day")
              .format("YYYY-MM-DD"));
      if (endDate <= startDate) {
        throw new ValidationError(
          options.startDate
            ? "The last day must not be before the first day"
            : `The last day must not be before the first day: the event's current first day is ${startDate}; pass start as well`,
          "end",
        );
      }
      unchanged = startDate === storedStart && endDate === storedEnd;
      next = {
        start: ICAL.Time.fromDateString(startDate),
        end: ICAL.Time.fromDateString(endDate),
      };
    } else {
      if (options.startDate || options.endDate) {
        throw new ValidationError(
          "Timed events need a date-time for start and end, e.g. 2025-06-20T14:00+02:00; set allDay to true for an all-day event",
          "start",
        );
      }
      if (switching && !options.end) {
        throw new ValidationError(
          "end is required when turning an all-day event into a timed one",
          "end",
        );
      }
      const storedStart = event.startDate.toJSDate();
      const storedEnd = event.endDate.toJSDate();
      const start = options.start ?? storedStart;
      const end =
        options.end ??
        new Date(
          storedEnd.getTime() + (start.getTime() - storedStart.getTime()),
        );
      if (start >= end) {
        throw new ValidationError(
          options.start
            ? "Start date must be before end date"
            : `Start date must be before end date: the event's current start is ${start.toISOString()}; pass start as well`,
          "start",
          start.toISOString(),
        );
      }
      unchanged =
        !switching &&
        start.getTime() === storedStart.getTime() &&
        end.getTime() === storedEnd.getTime();
      next = {
        start: ICAL.Time.fromJSDate(start, true),
        end: ICAL.Time.fromJSDate(end, true),
      };
    }

    if (unchanged) {
      return;
    }
    if (event.isRecurring()) {
      // Times are written in UTC: a series kept in local time would move by
      // an hour across daylight-saving changes, and its overrides and
      // EXDATEs would no longer match the new slots.
      throw new ValidationError(
        "Moving a recurring series is not supported; change its times in a calendar client. Title, description, location and attendees can be changed",
        "start",
      );
    }
    this.setEventTime(vevent, "dtstart", next.start);
    this.setEventTime(vevent, "dtend", next.end);
  }

  private setEventTime(
    vevent: ICAL.Component,
    name: "dtstart" | "dtend",
    value: ICAL.Time,
  ): void {
    // Dropped first so a TZID parameter of the old value cannot outlive it,
    // and DURATION with it, which would contradict the new DTEND.
    vevent.removeProperty(name);
    vevent.removeProperty("duration");
    vevent.addPropertyWithValue(name, value);
  }

  private setOptionalText(
    vevent: ICAL.Component,
    name: string,
    value: string | undefined,
  ): void {
    if (value === undefined) {
      return;
    }
    if (value === "") {
      vevent.removeProperty(name);
    } else {
      vevent.updatePropertyWithValue(name, value);
    }
  }

  /**
   * Replaces the attendee list. Attendees who stay keep their reply status.
   * Without sendInvitations every attendee is only recorded
   * (SCHEDULE-AGENT=CLIENT), as on create; with it the server schedules them
   * and the account is the ORGANIZER.
   */
  private replaceAttendees(
    vevent: ICAL.Component,
    options: UpdateCalendarEventOptions,
  ): void {
    const attendees = options.attendees ?? [];
    const organizer = this.invitationOrganizer(options);
    const emailOf = (property: ICAL.Property): string =>
      String(property.getFirstValue())
        .replace(/^mailto:/i, "")
        .toLowerCase();

    const existing = new Map(
      vevent
        .getAllProperties("attendee")
        .map(property => [emailOf(property), property] as const),
    );
    vevent.removeAllProperties("attendee");

    for (const { email, name } of attendees) {
      const property =
        existing.get(email.toLowerCase()) ??
        (() => {
          const created = new ICAL.Property("attendee");
          created.setValue(`mailto:${email}`);
          return created;
        })();
      if (name) {
        property.setParameter("cn", name);
      }
      if (organizer) {
        property.removeParameter("schedule-agent");
      } else {
        property.setParameter("schedule-agent", "CLIENT");
      }
      vevent.addProperty(property);
    }

    if (organizer && !vevent.hasProperty("organizer")) {
      vevent.addPropertyWithValue("organizer", `mailto:${organizer}`);
    }
  }

  /** ical.js output, refolded so no line exceeds 75 octets. */
  private serializeICal(root: ICAL.Component): string {
    return `${root
      .toString()
      .replace(/\r\n[ \t]/g, "")
      .split("\r\n")
      .map(line => this.foldICalLine(line))
      .join("\r\n")}\r\n`;
  }

  /**
   * The ORGANIZER address when the caller asked the server to invite the
   * attendees, or undefined when attendees are only recorded.
   */
  private invitationOrganizer(
    options: Pick<CreateCalendarEventOptions, "sendInvitations" | "attendees">,
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
    calendars: DAVCalendar[],
    calendarFilter?: string,
  ): DAVCalendar {
    const candidates = this.selectCalendars(calendars, calendarFilter);
    if (candidates.length === 0) {
      throw this.noCalendarError(calendars, calendarFilter);
    }

    if (calendarFilter && candidates.length > 1) {
      throw new ValidationError(
        `Calendar "${calendarFilter}" matches several calendars; use the calendar's URL or last URL segment. ${this.availableCalendars(
          candidates,
        )}`,
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
    // Every entry must name exactly one calendar: one that names none would
    // silently leave a calendar out, and free/busy would show it as free.
    const ranked = allowed
      ? allowed.flatMap(name => {
          const matches = writable.filter(calendar =>
            this.calendarMatches(calendar, name),
          );
          if (matches.length !== 1) {
            throw new ValidationError(
              `MAILBOX_CALENDARS entry "${name}" ${
                matches.length === 0
                  ? "matches no calendar"
                  : `matches several calendars; use a unique name or the calendar's URL`
              }. ${this.availableCalendars(writable)}`,
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

  /** "Available calendars: Display Name (last URL segment), ...". */
  private availableCalendars(calendars: DAVCalendar[]): string {
    const listed = calendars
      .filter(calendar => this.holdsEvents(calendar))
      .map(calendar => {
        const url = calendar.url.replace(/\/+$/, "");
        const segment = this.decodeSegment(url.slice(url.lastIndexOf("/") + 1));
        return `${(calendar.displayName as string) || segment} (${segment})`;
      });
    return listed.length
      ? `Available calendars: ${listed.join(", ")}`
      : "The server reports no calendar that can hold events";
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

  /**
   * Sends a write and checks the answer. A server error (5xx) or network
   * failure counts towards opening the circuit; a refusal (4xx) is about
   * this request and is reported without counting.
   */
  private async writeChecked(
    action: "create" | "update" | "delete",
    calendar: string,
    uid: string,
    send: () => Promise<Response>,
  ): Promise<void> {
    const response = await this.circuitBreaker.execute(async () => {
      const response = await send();
      if (response.status >= 500) {
        this.assertWritten(response, action, calendar, uid);
      }
      return response;
    });
    this.assertWritten(response, action, calendar, uid);
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
    // Reads choose calendars exactly like writes do, so MAILBOX_CALENDARS and
    // the calendar argument mean the same thing everywhere.
    const all = await this.listCalendars();
    const calendars = this.selectCalendars(all, options.calendar);
    if (calendars.length === 0) {
      throw this.noCalendarError(all, options.calendar);
    }

    // Every calendar in scope is read or the call fails. Some calendars'
    // events without the others would show the missing ones' appointments
    // as free time, so a failure is never narrowed to a partial list.
    const allEvents: CalendarEvent[] = [];
    const failures: string[] = [];
    for (const calendar of calendars) {
      try {
        allEvents.push(
          ...(await this.fetchEventsFromCalendar(calendar, options)),
        );
      } catch (error) {
        failures.push(
          `Could not read calendar "${calendarLabel(calendar)}": ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (failures.length > 0) {
      const hint =
        failures.length < calendars.length
          ? '. Nothing was returned, since the readable calendars alone would show the unread ones as free; pass "calendar" to read one that works'
          : "";
      throw new CalendarError(
        `${failures.join("; ")}${hint}`,
        ErrorCode.CALENDAR_READ_FAILED,
        options.calendar,
      );
    }

    return this.sortAndLimitEvents(allEvents, options);
  }

  /** The server's calendars; a failure is reported, never guessed around. */
  private async listCalendars(): Promise<DAVCalendar[]> {
    try {
      return await this.circuitBreaker.execute(async () => {
        const client = await this.getClient();
        return client.fetchCalendars();
      });
    } catch (error) {
      throw new CalendarError(
        `Could not list your calendars: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ErrorCode.CALENDAR_READ_FAILED,
      );
    }
  }

  /**
   * Why no calendar is in scope: an unknown name, or no calendar that can
   * hold events. Lists the calendars that could have been meant.
   */
  private noCalendarError(
    calendars: DAVCalendar[],
    calendarFilter?: string,
  ): ValidationError {
    if (!calendarFilter) {
      return new ValidationError(
        "No calendar that can hold events was found",
        "calendar",
      );
    }
    const scope = this.allowedCalendars()
      ? " among the calendars MAILBOX_CALENDARS allows"
      : "";
    return new ValidationError(
      `Calendar "${calendarFilter}" not found${scope}. ${this.availableCalendars(
        this.selectCalendars(calendars),
      )}`,
      "calendar",
      calendarFilter,
    );
  }

  private async fetchEventsFromCalendar(
    calendar: DAVCalendar,
    options: CalendarSearchOptions,
  ): Promise<CalendarEvent[]> {
    const calendarObjects = await this.circuitBreaker.execute(async () => {
      const client = await this.getClient();
      return client.fetchCalendarObjects({
        calendar,
        timeRange:
          options.start && options.end
            ? {
                start: options.start.toISOString(),
                end: options.end.toISOString(),
              }
            : undefined,
      });
    });

    return this.parseCalendarObjects(calendarObjects, calendarLabel(calendar), {
      start: options.start,
      end: options.end,
    });
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
      event.recurrenceId = recurrenceIdText(recurrenceId);
      event.id = `${event.uid}:${event.recurrenceId}`;
      event.recurring = true;
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

    const add = (item: ICAL.Event, start: Date, end: Date, rid: ICAL.Time) => {
      const recurrenceId = recurrenceIdText(rid);
      const id = `${item.uid}:${recurrenceId}`;
      if (seen.has(id)) {
        return;
      }
      // An override with STATUS:CANCELLED deletes its instance (RFC 5545
      // 3.8.1.11); it must not show up as an event nor block free/busy.
      if (
        item.isRecurrenceException() &&
        String(item.component.getFirstPropertyValue("status")).toUpperCase() ===
          "CANCELLED"
      ) {
        seen.add(id);
        return;
      }
      const base = this.parseVEvent(item.component, calendar);
      if (base) {
        seen.add(id);
        occurrences.push({
          ...base,
          id,
          recurrenceId,
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
          details.recurrenceId,
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
      if (recurrenceId.toJSDate() < range.end) {
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
        add(item, occurrence.start, occurrence.end, recurrenceId);
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
