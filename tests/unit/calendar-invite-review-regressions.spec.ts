import { test, expect } from "@playwright/test";
import { isoDateMatchesCalendarDate } from "../../src/shared/calendar-date";
import {
  shouldStartInviteExtraction,
  toDateInput,
  toTimeInput,
  updateInviteEndTime,
} from "../../src/shared/calendar-invite-editor";
import type { CalendarInviteDraft } from "../../src/shared/types";

function draftWithDates(start: string, end: string): CalendarInviteDraft {
  return {
    title: "Conference",
    start,
    end,
    timezone: "America/New_York",
    guests: ["casey@example.com"],
    conference: { type: "googleMeet" },
    location: "",
    description: "",
    calendarId: "primary",
    confidence: 1,
    warnings: [],
  };
}

test.describe("calendar invite review regressions", () => {
  test("matches UTC ISO starts against the requested local calendar date", () => {
    expect(
      isoDateMatchesCalendarDate("2026-06-01T11:00:00.000Z", "2026-06-02", {
        timeZone: "Pacific/Kiritimati",
      }),
    ).toBe(true);
    expect(
      isoDateMatchesCalendarDate("2026-06-03T02:30:00.000Z", "2026-06-02", {
        timeZone: "America/Los_Angeles",
      }),
    ).toBe(true);
    expect(
      isoDateMatchesCalendarDate("2026-06-03T02:30:00.000Z", "2026-06-03", {
        timeZone: "America/Los_Angeles",
      }),
    ).toBe(false);
  });

  test("updating the end time preserves a multi-day end date", () => {
    const draft = draftWithDates("2026-06-02T14:00:00.000Z", "2026-06-04T17:00:00.000Z");

    const updated = updateInviteEndTime(draft, "18:30");

    expect(toDateInput(updated.end)).toBe(toDateInput(draft.end));
    expect(toTimeInput(updated.end)).toBe("18:30");
  });

  test("starts invite extraction once for a matching thread request nonce", () => {
    const request = { threadId: "thread-a", nonce: 42 };

    expect(shouldStartInviteExtraction(request, "thread-a", null)).toBe(true);
    expect(shouldStartInviteExtraction(request, "thread-a", 42)).toBe(false);
    expect(shouldStartInviteExtraction(request, "thread-b", null)).toBe(false);
  });
});
