import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CalendarService } from "../src/services/CalendarService.js";
import { handleCalendarTool } from "../src/tools/calendarTools.js";
import {
  createCalendarEventSchema,
  validateInput,
} from "../src/validation/schemas.js";
import { textOf } from "./helpers/toolResult.js";

// Date-times without an offset are read in the server's local time zone,
// so these tests pin it. Node re-reads process.env.TZ when it changes.
describe("create_calendar_event in a fixed time zone (Europe/Berlin)", () => {
  const originalTz = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = "Europe/Berlin";
  });

  afterAll(() => {
    if (originalTz === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = originalTz;
    }
  });

  it("should really run in Europe/Berlin", () => {
    expect(new Date(2025, 0, 15).getTimezoneOffset()).toBe(-60);
    expect(new Date(2025, 6, 15).getTimezoneOffset()).toBe(-120);
  });

  it("should read a date-time without offset as local time", () => {
    const result = validateInput(createCalendarEventSchema, {
      summary: "Call",
      start: "2025-06-20T14:00",
      end: "2025-06-20T15:00",
    });
    expect(new Date(result.start).toISOString()).toBe(
      "2025-06-20T12:00:00.000Z",
    );
  });

  it("should reject a local time skipped by the daylight-saving change", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        summary: "Call",
        start: "2025-03-30T02:30",
        end: "2025-03-30T04:00",
      }),
    ).toThrow(
      /2025-03-30T02:30" does not exist in the server's time zone \(Europe\/Berlin\).*explicit offset/,
    );
  });

  it("should accept the same wall time with an explicit offset", () => {
    expect(() =>
      validateInput(createCalendarEventSchema, {
        summary: "Call",
        start: "2025-03-30T02:30+01:00",
        end: "2025-03-30T04:00+02:00",
      }),
    ).not.toThrow();
  });

  it("should print times with their UTC offset", async () => {
    const service = {
      createCalendarEvent: vi.fn().mockResolvedValue({
        uid: "u1",
        summary: "Call",
        start: new Date("2025-06-20T12:00:00Z"),
        end: new Date("2025-01-20T13:00:00Z"),
        allDay: false,
        calendar: "work",
      }),
    } as unknown as CalendarService;

    const result = await handleCalendarTool(
      "create_calendar_event",
      {
        summary: "Call",
        start: "2025-06-20T12:00:00Z",
        end: "2025-06-20T13:00:00Z",
      },
      service,
    );

    const text = textOf(result);
    expect(text).toContain("Start: 2025-06-20 14:00 +02:00");
    expect(text).toContain("End: 2025-01-20 14:00 +01:00");
  });
});
