import type { CalendarInviteDraft } from "./types";

export type CalendarInviteRequestMatch = {
  threadId: string;
  nonce: number;
};

export function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function todayString(): string {
  return toDateString(new Date());
}

export function addDays(dateStr: string, n: number): string {
  // Noon avoids date rollover around DST boundaries.
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return toDateString(d);
}

// Draft start/end are floating wall-clock strings ("YYYY-MM-DDTHH:mm:ss")
// interpreted in the draft's own timezone — see calendar-timezone.ts. These
// helpers therefore operate purely on the string's calendar/clock fields and
// never round-trip through a UTC instant (which would re-inject the browser's
// local zone and shift the time).
const WALL_CLOCK_RE = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/;

export function toDateInput(wallClock: string): string {
  const match = WALL_CLOCK_RE.exec(wallClock);
  return match ? match[1] : "";
}

export function toTimeInput(wallClock: string): string {
  const match = WALL_CLOCK_RE.exec(wallClock);
  return match ? `${match[2]}:${match[3]}` : "";
}

export function combineDateAndTime(dateStr: string, timeStr: string): string {
  if (!dateStr || !timeStr) return "";
  return `${dateStr}T${timeStr}:00`;
}

// Anchor a wall-clock string's date/time fields as if they were UTC. Staying in
// UTC keeps the math independent of the browser's local zone; only the
// date/time fields are used, never the absolute instant. Returns null for a
// malformed wall clock.
function wallClockToUtcMs(wallClock: string): number | null {
  const date = toDateInput(wallClock);
  const time = toTimeInput(wallClock);
  if (!date || !time) return null;
  const [h, m] = time.split(":").map(Number);
  return Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    h,
    m,
  );
}

export function addMinutes(wallClock: string, minutes: number): string {
  const base = wallClockToUtcMs(wallClock);
  if (base === null) return "";
  const shifted = new Date(base + minutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:00`
  );
}

// Duration of a draft in minutes when both ends are valid wall clocks and the
// end is strictly after the start; null otherwise.
function draftDurationMinutes(draft: CalendarInviteDraft): number | null {
  const startMs = wallClockToUtcMs(draft.start);
  const endMs = wallClockToUtcMs(draft.end);
  if (startMs === null || endMs === null || endMs <= startMs) return null;
  return Math.round((endMs - startMs) / 60_000);
}

export function updateInviteStartTime(
  draft: CalendarInviteDraft,
  time: string,
): CalendarInviteDraft {
  const startDate = toDateInput(draft.start) || todayString();
  const nextStart = combineDateAndTime(startDate, time);

  // Moving the start time shifts the whole meeting: preserve the existing
  // duration so the end follows the start (matching Google Calendar's editor).
  // Without this, editing only the start could leave the end at/before it,
  // which blanks the preview block and blocks creation. Fall back to 30 minutes
  // when there is no valid existing duration.
  const duration = draftDurationMinutes(draft);
  const nextEnd = addMinutes(nextStart, duration ?? 30);

  return {
    ...draft,
    start: nextStart,
    end: nextEnd,
  };
}

export function updateInviteEndTime(draft: CalendarInviteDraft, time: string): CalendarInviteDraft {
  const startDate = toDateInput(draft.start) || todayString();
  const endDate = toDateInput(draft.end) || startDate;
  let nextEnd = combineDateAndTime(endDate, time);

  // If the chosen end time lands at/before the start (e.g. start 23:30, end
  // 00:30), the user means the next day — roll the end date forward one day.
  // Wall-clock strings compare lexicographically, so this is a safe ordering check.
  if (draft.start && nextEnd && nextEnd <= draft.start) {
    nextEnd = combineDateAndTime(addDays(startDate, 1), time);
  }

  return {
    ...draft,
    end: nextEnd,
  };
}

export function updateInviteStartDate(
  draft: CalendarInviteDraft,
  date: string,
): CalendarInviteDraft {
  const nextStart = combineDateAndTime(date, toTimeInput(draft.start) || "14:00");
  const prevStartDate = toDateInput(draft.start);
  const prevEndDate = toDateInput(draft.end);
  let nextEndDate = date;

  if (prevStartDate && prevEndDate && prevEndDate !== prevStartDate) {
    const deltaMs =
      new Date(`${prevEndDate}T12:00:00`).getTime() -
      new Date(`${prevStartDate}T12:00:00`).getTime();
    const deltaDays = Math.round(deltaMs / 86_400_000);
    nextEndDate = addDays(date, deltaDays);
  }

  // Guard against a malformed existing end (toTimeInput → "") silently blanking
  // the end time when the start date changes. Fall back to a 30-minute default.
  const endTime = toTimeInput(draft.end);
  const nextEnd =
    draft.end && endTime ? combineDateAndTime(nextEndDate, endTime) : addMinutes(nextStart, 30);

  return {
    ...draft,
    start: nextStart,
    end: nextEnd,
  };
}

export function shouldStartInviteExtraction(
  request: CalendarInviteRequestMatch | null,
  currentThreadId: string,
  startedNonce: number | null,
): boolean {
  return Boolean(request && request.threadId === currentThreadId && request.nonce !== startedNonce);
}

/**
 * True when an invite request is stale relative to the thread the user is now
 * viewing: it targets a different thread than `selectedThreadId`. Such a request
 * must be cleared, or it keeps the sidebar in invite-lock (tab bar hidden, `b`
 * suppressed) with no editor rendered and no reachable exit. `selectedThreadId`
 * is undefined when nothing is selected; we only clear on a confirmed mismatch
 * to avoid racing the legitimate same-thread start.
 */
export function isStaleInviteRequest(
  request: CalendarInviteRequestMatch | null,
  selectedThreadId: string | undefined,
): boolean {
  return Boolean(request && selectedThreadId && request.threadId !== selectedThreadId);
}
