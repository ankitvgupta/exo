type RuntimeFlagEnv = {
  EXO_DEMO_MODE?: string;
  EXO_TEST_MODE?: string;
  EXO_DEMO_CALENDAR_REAUTH_REQUIRED?: string;
};

let demoCalendarReauthenticated = false;

export function isDemoOrTestMode(env: RuntimeFlagEnv = process.env): boolean {
  return env.EXO_DEMO_MODE === "true" || env.EXO_TEST_MODE === "true";
}

export function shouldUseLiveGoogleCalendar(env: RuntimeFlagEnv = process.env): boolean {
  return !isDemoOrTestMode(env);
}

export function shouldSimulateCalendarWriteReauth(env: RuntimeFlagEnv = process.env): boolean {
  return (
    isDemoOrTestMode(env) &&
    env.EXO_DEMO_CALENDAR_REAUTH_REQUIRED === "true" &&
    !demoCalendarReauthenticated
  );
}

export function markDemoCalendarReauthenticated(): void {
  demoCalendarReauthenticated = true;
}

export function resetDemoCalendarReauthForTesting(): void {
  demoCalendarReauthenticated = false;
}
