// Timezone handling for calendar invites.
//
// The invariant downstream of extraction is: an invite draft's `start`/`end`
// are *floating wall-clock* strings ("YYYY-MM-DDTHH:mm:ss", no offset, no "Z")
// that are interpreted in the draft's own `timezone`. Google Calendar's
// { dateTime, timeZone } pair consumes exactly this representation, so once a
// draft is in this form there are no further conversions before sending.
//
// Conversions happen only at two boundaries:
//   1. Extraction: the LLM may return an instant carrying an explicit offset
//      ("...+01:00") when the email stated a timezone, or a floating wall-clock
//      ("...T14:00:00") when it did not. `normalizeToCalendarWallClock` collapses
//      both into floating wall-clock in the calendar zone.
//   2. Preview: the time grid positions events by absolute instant, so
//      `wallClockToInstant` turns a floating draft time back into a real instant.

const OFFSET_RE = /(?:Z|[+-]\d{2}:?\d{2})$/;
const FLOATING_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** True when an ISO-ish string carries an explicit UTC offset (or trailing Z). */
export function hasExplicitOffset(value: string): boolean {
  return OFFSET_RE.test(value.trim());
}

/** Format a real instant as floating wall-clock ("YYYY-MM-DDTHH:mm:ss") in `timeZone`. */
export function instantToWallClock(date: Date, timeZone: string): string {
  if (!Number.isFinite(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  const year = get("year");
  const month = get("month");
  const day = get("day");
  // Intl emits "24" for midnight in some engines; normalize to "00".
  const hour = get("hour") === "24" ? "00" : get("hour");
  const minute = get("minute");
  const second = get("second") || "00";

  if (!year || !month || !day || !hour || !minute) return "";
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/**
 * Compute the offset (in minutes, east-positive) that `timeZone` was at for the
 * given instant. Used to invert a wall-clock back into a UTC instant.
 */
function timeZoneOffsetMinutes(date: Date, timeZone: string): number {
  // Render the instant as a wall clock in the target zone, read it back as if
  // it were UTC, and the difference is the zone's offset at that instant.
  const wall = instantToWallClock(date, timeZone);
  const match = FLOATING_RE.exec(wall);
  if (!match) return 0;
  const [, y, mo, d, h, mi, s] = match;
  const asUtc = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s || "0"),
  );
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/**
 * Interpret a floating wall-clock string ("YYYY-MM-DDTHH:mm[:ss]") as a real
 * instant in `timeZone`. Returns null if the input is not a bare wall clock.
 *
 * DST is handled by computing the zone offset *at the candidate instant* and
 * correcting once — sufficient for the 30–60 minute jumps real zones use.
 */
export function wallClockToInstant(wallClock: string, timeZone: string): Date | null {
  const match = FLOATING_RE.exec(wallClock.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;

  // First guess: treat the wall clock as if it were UTC.
  const guess = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s || "0"),
  );
  // The zone was `offset` minutes ahead of UTC at this instant, so the true
  // instant is `offset` minutes earlier than the naive-UTC guess.
  const offset = timeZoneOffsetMinutes(new Date(guess), timeZone);
  return new Date(guess - offset * 60_000);
}

/**
 * Collapse an extracted start/end value into floating wall-clock in the
 * calendar timezone.
 *
 * - Empty input stays empty.
 * - A value with an explicit offset is a true instant; convert it into the
 *   calendar zone's wall clock (handles "2 PM London" → "9 AM New York").
 * - A bare wall clock has no zone of its own; the email said nothing, so it is
 *   interpreted in `userTimeZone` (the time the user is in) and then converted
 *   into the calendar zone. When the two zones match this is a no-op.
 */
export function normalizeToCalendarWallClock(
  value: string,
  calendarTimeZone: string,
  userTimeZone: string,
): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  if (hasExplicitOffset(trimmed)) {
    const instant = new Date(trimmed);
    if (!Number.isFinite(instant.getTime())) return "";
    return instantToWallClock(instant, calendarTimeZone);
  }

  // Bare wall clock: interpret in the user's physical zone, then re-express in
  // the calendar zone. If the calendar zone == user zone this round-trips to
  // the same wall clock.
  const instant = wallClockToInstant(trimmed, userTimeZone);
  if (!instant) return "";
  return instantToWallClock(instant, calendarTimeZone);
}
