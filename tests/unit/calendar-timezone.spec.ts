import { test, expect } from "@playwright/test";
import {
  hasExplicitOffset,
  instantToWallClock,
  normalizeToCalendarWallClock,
  wallClockToInstant,
} from "../../src/shared/calendar-timezone";
import { parseCalendarInviteDraft } from "../../src/shared/calendar-invite";

test.describe("calendar timezone helpers", () => {
  test("detects explicit offsets and floating wall-clock", () => {
    expect(hasExplicitOffset("2026-06-02T14:00:00+01:00")).toBe(true);
    expect(hasExplicitOffset("2026-06-02T14:00:00Z")).toBe(true);
    expect(hasExplicitOffset("2026-06-02T14:00:00-0400")).toBe(true);
    expect(hasExplicitOffset("2026-06-02T14:00:00")).toBe(false);
  });

  test("renders an instant as wall-clock in a target zone", () => {
    const instant = new Date("2026-06-02T13:00:00Z");
    expect(instantToWallClock(instant, "America/New_York")).toBe("2026-06-02T09:00:00");
    expect(instantToWallClock(instant, "Europe/London")).toBe("2026-06-02T14:00:00");
  });

  test("wallClockToInstant round-trips with instantToWallClock", () => {
    const instant = wallClockToInstant("2026-06-02T09:00:00", "America/New_York");
    expect(instant).not.toBeNull();
    expect(instant && instant.toISOString()).toBe("2026-06-02T13:00:00.000Z");
    // And back again.
    expect(instant && instantToWallClock(instant, "America/New_York")).toBe(
      "2026-06-02T09:00:00",
    );
  });

  test("normalizes an explicit-offset time into the calendar wall-clock (2pm London → NY)", () => {
    // "2 PM London" with a New York calendar must become 9 AM New York.
    expect(
      normalizeToCalendarWallClock(
        "2026-06-02T14:00:00+01:00",
        "America/New_York",
        "America/Los_Angeles",
      ),
    ).toBe("2026-06-02T09:00:00");
  });

  test("interprets a bare wall-clock in the user zone, then expresses it in the calendar zone", () => {
    // Bare "2 PM", user physically in London, calendar in New York → 9 AM NY.
    expect(
      normalizeToCalendarWallClock("2026-06-02T14:00:00", "America/New_York", "Europe/London"),
    ).toBe("2026-06-02T09:00:00");
  });

  test("leaves a bare wall-clock unchanged when the user and calendar share a zone", () => {
    expect(
      normalizeToCalendarWallClock("2026-06-02T14:00:00", "America/New_York", "America/New_York"),
    ).toBe("2026-06-02T14:00:00");
  });

  test("handles a winter DST offset distinct from summer", () => {
    // January: London is UTC+0, New York is UTC-5. 2 PM London → 9 AM NY.
    expect(
      normalizeToCalendarWallClock(
        "2026-01-15T14:00:00+00:00",
        "America/New_York",
        "America/Los_Angeles",
      ),
    ).toBe("2026-01-15T09:00:00");
  });
});

test.describe("parseCalendarInviteDraft timezone normalization", () => {
  test("converts an explicit-offset London time into a New York calendar draft", () => {
    const draft = parseCalendarInviteDraft(
      JSON.stringify({
        title: "Partnership sync",
        start: "2026-06-02T14:00:00+01:00",
        end: "2026-06-02T15:00:00+01:00",
        timezone: "America/New_York",
        guests: ["kat@example.com"],
        conference: { type: "googleMeet" },
        location: "",
        description: "",
        calendarId: "primary",
        confidence: 0.8,
        warnings: [],
      }),
      { calendarId: "primary", timezone: "America/New_York", userTimezone: "America/Los_Angeles" },
    );

    expect(draft.timezone).toBe("America/New_York");
    expect(draft.start).toBe("2026-06-02T09:00:00");
    expect(draft.end).toBe("2026-06-02T10:00:00");
  });

  test("falls back to the user timezone for a bare time with no stated zone", () => {
    const draft = parseCalendarInviteDraft(
      JSON.stringify({
        title: "Intro call",
        start: "2026-06-02T14:00:00",
        end: "2026-06-02T14:30:00",
        timezone: "America/New_York",
        guests: ["kat@example.com"],
        conference: { type: "googleMeet" },
        location: "",
        description: "",
        calendarId: "primary",
        confidence: 0.8,
        warnings: [],
      }),
      { calendarId: "primary", timezone: "America/New_York", userTimezone: "Europe/London" },
    );

    // User meant 2 PM London; the NY calendar expresses that as 9 AM.
    expect(draft.timezone).toBe("America/New_York");
    expect(draft.start).toBe("2026-06-02T09:00:00");
    expect(draft.end).toBe("2026-06-02T09:30:00");
  });
});
