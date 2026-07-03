import { test, expect } from "@playwright/test";
import { isoDateMatchesCalendarDate } from "../../src/shared/calendar-date";
import {
  combineDateAndTime,
  isStaleInviteRequest,
  shouldStartInviteExtraction,
  toDateInput,
  toTimeInput,
  updateInviteEndTime,
  updateInviteStartDate,
  updateInviteStartTime,
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

  test("updating the start date preserves a multi-day duration", () => {
    const draft = draftWithDates(
      combineDateAndTime("2026-06-02", "14:00"),
      combineDateAndTime("2026-06-04", "17:00"),
    );

    const updated = updateInviteStartDate(draft, "2026-06-05");

    expect(toDateInput(updated.start)).toBe("2026-06-05");
    expect(toDateInput(updated.end)).toBe("2026-06-07");
    expect(toTimeInput(updated.end)).toBe("17:00");
  });

  test("starts invite extraction once for a matching thread request nonce", () => {
    const request = { threadId: "thread-a", nonce: 42 };

    expect(shouldStartInviteExtraction(request, "thread-a", null)).toBe(true);
    expect(shouldStartInviteExtraction(request, "thread-a", 42)).toBe(false);
    expect(shouldStartInviteExtraction(request, "thread-b", null)).toBe(false);
  });

  test("flags an invite request as stale only when a different thread is selected", () => {
    const request = { threadId: "thread-a", nonce: 1 };

    // Navigated to a different thread → stale, must be cleared to release the lock.
    expect(isStaleInviteRequest(request, "thread-b")).toBe(true);
    // Still on the triggering thread → not stale (legitimate same-thread start).
    expect(isStaleInviteRequest(request, "thread-a")).toBe(false);
    // No selection yet → don't clear (avoid racing the startup path).
    expect(isStaleInviteRequest(request, undefined)).toBe(false);
    // No request → nothing to clear.
    expect(isStaleInviteRequest(null, "thread-b")).toBe(false);
  });

  test("changing the start date never blanks the end when the existing end is malformed", () => {
    // A malformed end (no parseable time) must not silently erase the end time;
    // it should fall back to a 30-minute duration off the new start.
    const draft = draftWithDates(combineDateAndTime("2026-06-02", "14:00"), "not-a-date");

    const updated = updateInviteStartDate(draft, "2026-06-05");

    expect(updated.end).not.toBe("");
    expect(toDateInput(updated.end)).toBe("2026-06-05");
    expect(toTimeInput(updated.end)).toBe("14:30");
  });

  test("setting an end time before the start rolls the end to the next day", () => {
    // start 23:30, user picks end 00:30 → the meeting crosses midnight.
    const draft = draftWithDates(combineDateAndTime("2026-06-02", "23:30"), "");

    const updated = updateInviteEndTime(draft, "00:30");

    expect(toDateInput(updated.end)).toBe("2026-06-03");
    expect(toTimeInput(updated.end)).toBe("00:30");
    expect(updated.end > updated.start).toBe(true);
  });

  test("changing the start time shifts the end, preserving the meeting duration", () => {
    // A one-hour meeting moved from 10:00 to 11:00 should become 11:00–12:00,
    // not leave the end at 11:00 (before the new start) and blank the preview.
    const draft = draftWithDates(
      combineDateAndTime("2026-06-02", "10:00"),
      combineDateAndTime("2026-06-02", "11:00"),
    );

    const updated = updateInviteStartTime(draft, "11:00");

    expect(updated.start).toBe(combineDateAndTime("2026-06-02", "11:00"));
    expect(updated.end).toBe(combineDateAndTime("2026-06-02", "12:00"));
    expect(updated.end > updated.start).toBe(true);
  });

  test("changing the start time defaults to a 30-minute duration when the end is malformed", () => {
    const draft = draftWithDates(combineDateAndTime("2026-06-02", "10:00"), "not-a-date");

    const updated = updateInviteStartTime(draft, "14:00");

    expect(toDateInput(updated.start)).toBe("2026-06-02");
    expect(toTimeInput(updated.start)).toBe("14:00");
    expect(toTimeInput(updated.end)).toBe("14:30");
  });
});
