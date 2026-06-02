import { expect, test } from "@playwright/test";

import {
  isDemoOrTestMode,
  markDemoCalendarReauthenticated,
  resetDemoCalendarReauthForTesting,
  shouldSimulateCalendarWriteReauth,
  shouldUseLiveGoogleCalendar,
} from "../../src/main/runtime-flags";

test.describe("runtime flags", () => {
  test.beforeEach(() => {
    resetDemoCalendarReauthForTesting();
  });

  test("demo mode is treated as non-live", () => {
    expect(isDemoOrTestMode({ EXO_DEMO_MODE: "true" })).toBe(true);
    expect(shouldUseLiveGoogleCalendar({ EXO_DEMO_MODE: "true" })).toBe(false);
  });

  test("test mode is treated as non-live", () => {
    expect(isDemoOrTestMode({ EXO_TEST_MODE: "true" })).toBe(true);
    expect(shouldUseLiveGoogleCalendar({ EXO_TEST_MODE: "true" })).toBe(false);
  });

  test("normal mode may use live Google Calendar", () => {
    expect(isDemoOrTestMode({})).toBe(false);
    expect(shouldUseLiveGoogleCalendar({})).toBe(true);
  });

  test("demo calendar write reauth can be simulated without live Google Calendar", () => {
    const env = {
      EXO_DEMO_MODE: "true",
      EXO_DEMO_CALENDAR_REAUTH_REQUIRED: "true",
    };

    expect(shouldSimulateCalendarWriteReauth(env)).toBe(true);

    markDemoCalendarReauthenticated();

    expect(shouldSimulateCalendarWriteReauth(env)).toBe(false);
  });
});
