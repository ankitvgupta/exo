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

export function toDateInput(isoStr: string): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (!Number.isFinite(d.getTime())) return "";
  return toDateString(d);
}

export function toTimeInput(isoStr: string): string {
  if (!isoStr) return "";
  const d = new Date(isoStr);
  if (!Number.isFinite(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function combineDateAndTime(dateStr: string, timeStr: string): string {
  if (!dateStr || !timeStr) return "";
  return new Date(`${dateStr}T${timeStr}:00`).toISOString();
}

export function addMinutes(isoStr: string, minutes: number): string {
  const d = new Date(isoStr);
  if (!Number.isFinite(d.getTime())) return "";
  return new Date(d.getTime() + minutes * 60_000).toISOString();
}

export function updateInviteEndTime(draft: CalendarInviteDraft, time: string): CalendarInviteDraft {
  const endDate = toDateInput(draft.end) || toDateInput(draft.start) || todayString();
  return {
    ...draft,
    end: combineDateAndTime(endDate, time),
  };
}

export function shouldStartInviteExtraction(
  request: CalendarInviteRequestMatch | null,
  currentThreadId: string,
  startedNonce: number | null,
): boolean {
  return Boolean(request && request.threadId === currentThreadId && request.nonce !== startedNonce);
}
