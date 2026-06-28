import { stripJsonFences } from "./strip-json-fences";
import { normalizeToCalendarWallClock } from "./calendar-timezone";
import {
  CalendarInviteDraftSchema,
  type CalendarEventInsertParams,
  type CalendarInviteCalendarOption,
  type CalendarInviteDraft,
} from "./types";

type InviteDefaults = {
  calendarId: string;
  timezone: string;
  // The timezone the user is physically in. A bare wall-clock time from the
  // email (no stated zone) is interpreted here before being expressed in the
  // calendar's `timezone`. Defaults to `timezone` when unknown.
  userTimezone?: string;
};

export const CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING =
  "AI extraction failed. Fill in the invite manually.";
const INVITE_GUEST_EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

function isNonActionableInviteWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  if (lower.includes("year") && lower.includes("inferred") && lower.includes("email date")) {
    return true;
  }

  if (lower.includes("no explicit year") || lower.includes("year mentioned")) {
    return lower.includes("inferred") || lower.includes("assumed");
  }

  if (
    lower.includes("no end time") ||
    lower.includes("end time not specified") ||
    lower.includes("end time was not specified")
  ) {
    return true;
  }

  if (lower.includes("assumed") && lower.includes("30") && lower.includes("duration")) {
    return true;
  }

  if (lower.includes("multi-day event") && lower.includes("no explicit end time")) {
    return true;
  }

  if (lower.includes("used") && lower.includes("approximate") && lower.includes("end")) {
    return true;
  }

  if (lower.includes("may not need to attend") || lower.includes("consider removing")) {
    return true;
  }

  return false;
}

function actionableInviteWarnings(values: string[]): string[] {
  return dedupeStrings(values).filter((warning) => !isNonActionableInviteWarning(warning));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

function stringArrayValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => stringValue(item)).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,;\n]/).map((item) => item.trim());
  }
  return [];
}

function confidenceValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function conferenceValue(value: unknown): unknown {
  if (typeof value === "string") {
    return { type: value };
  }
  if (!isRecord(value)) {
    return { type: "googleMeet" };
  }
  return {
    type: stringValue(value.type, "googleMeet"),
    value: stringValue(value.value) || undefined,
  };
}

function normalizeInviteRaw(raw: unknown, defaults: InviteDefaults): unknown {
  if (!isRecord(raw)) return raw;
  const source = isRecord(raw.draft) ? raw.draft : raw;

  return {
    title: stringValue(source.title),
    start: stringValue(source.start ?? source.startTime ?? source.startDateTime),
    end: stringValue(source.end ?? source.endTime ?? source.endDateTime),
    timezone: stringValue(source.timezone, defaults.timezone),
    guests: stringArrayValue(source.guests ?? source.attendees),
    conference: conferenceValue(source.conference),
    location: stringValue(source.location),
    description: stringValue(source.description ?? source.notes ?? source.agenda),
    calendarId: stringValue(source.calendarId, defaults.calendarId),
    confidence: confidenceValue(source.confidence),
    warnings: stringArrayValue(source.warnings),
  };
}

function withCompletenessWarnings(draft: CalendarInviteDraft): CalendarInviteDraft {
  const warnings = [...draft.warnings];
  const add = (warning: string) => {
    if (!warnings.includes(warning)) warnings.push(warning);
  };

  if (!draft.title.trim()) add("Missing title.");
  if (!draft.start.trim()) add("Missing start time.");
  if (!draft.end.trim()) add("Missing end time.");
  if (draft.guests.length === 0) add("No guests inferred.");

  return { ...draft, warnings };
}

function emptyInviteDraft(defaults: InviteDefaults, warnings: string[]): CalendarInviteDraft {
  return withCompletenessWarnings({
    title: "",
    start: "",
    end: "",
    timezone: defaults.timezone,
    guests: [],
    conference: { type: "googleMeet" },
    location: "",
    description: "",
    calendarId: defaults.calendarId,
    confidence: 0,
    warnings,
  });
}

function parseJsonObject(value: unknown): unknown {
  if (isRecord(value)) return value;
  if (typeof value !== "string") throw new Error("Expected JSON text or object");

  const stripped = stripJsonFences(value).trim();
  try {
    return JSON.parse(stripped);
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("No JSON object found");
    return JSON.parse(stripped.slice(start, end + 1));
  }
}

export function parseCalendarInviteDraft(
  text: unknown,
  defaults: InviteDefaults,
): CalendarInviteDraft {
  let raw: unknown;
  try {
    raw = parseJsonObject(text);
  } catch {
    return emptyInviteDraft(defaults, [CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING]);
  }

  const parsed = CalendarInviteDraftSchema.safeParse(normalizeInviteRaw(raw, defaults));
  if (!parsed.success) {
    return emptyInviteDraft(defaults, [CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING]);
  }

  const draft = parsed.data;
  const calendarTimezone = draft.timezone.trim() || defaults.timezone;
  const userTimezone = defaults.userTimezone || calendarTimezone;
  return withCompletenessWarnings({
    ...draft,
    title: draft.title.trim(),
    start: normalizeToCalendarWallClock(draft.start, calendarTimezone, userTimezone),
    end: normalizeToCalendarWallClock(draft.end, calendarTimezone, userTimezone),
    timezone: calendarTimezone,
    guests: dedupeStrings(draft.guests),
    conference: {
      type: draft.conference.type,
      value: draft.conference.value?.trim() || undefined,
    },
    location: draft.location.trim(),
    description: draft.description.trim(),
    calendarId: draft.calendarId.trim() || defaults.calendarId,
    warnings: actionableInviteWarnings(draft.warnings),
  });
}

export function chooseCalendarTimezone(
  calendars: CalendarInviteCalendarOption[],
  preferredCalendarId: string | undefined,
  fallbackTimezone: string,
): string {
  const selected = calendars.find(
    (calendar) => calendar.calendarId === preferredCalendarId && calendar.timezone,
  );
  if (selected?.timezone) return selected.timezone;

  const primary = calendars.find((calendar) => calendar.primary && calendar.timezone);
  if (primary?.timezone) return primary.timezone;

  const firstWithTimezone = calendars.find((calendar) => calendar.timezone);
  return firstWithTimezone?.timezone ?? fallbackTimezone;
}

export function validateCalendarInviteDraft(draft: CalendarInviteDraft): string[] {
  const errors: string[] = [];
  if (!draft.title.trim()) errors.push("Add a title.");
  if (!draft.start.trim()) errors.push("Choose a start time.");
  if (!draft.end.trim()) errors.push("Choose an end time.");
  if (draft.start.trim() && draft.end.trim()) {
    const startTime = new Date(draft.start).getTime();
    const endTime = new Date(draft.end).getTime();
    if (!Number.isFinite(startTime)) errors.push("Choose a valid start time.");
    if (!Number.isFinite(endTime)) errors.push("Choose a valid end time.");
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && endTime <= startTime) {
      errors.push("End time must be after start time.");
    }
  }
  if (draft.guests.length === 0) errors.push("Add at least one guest.");
  const invalidGuests = dedupeStrings(draft.guests).filter(
    (guest) => !INVITE_GUEST_EMAIL_RE.test(guest),
  );
  if (invalidGuests.length > 0) {
    errors.push(`Fix invalid guest email address${invalidGuests.length === 1 ? "" : "es"}: ${invalidGuests.join(", ")}.`);
  }
  if (!draft.calendarId.trim()) errors.push("Choose a calendar.");
  return errors;
}

function descriptionWithConference(draft: CalendarInviteDraft): string | undefined {
  const description = draft.description.trim();
  const conferenceValue = draft.conference.value?.trim();
  if (
    !conferenceValue ||
    draft.conference.type === "googleMeet" ||
    draft.conference.type === "none"
  ) {
    return description || undefined;
  }

  if (description.includes(conferenceValue)) return description;

  const label = draft.conference.type === "phone" ? "Phone" : "Meeting link";
  return [description, `${label}: ${conferenceValue}`].filter(Boolean).join("\n\n");
}

/**
 * Derive a stable Google `conferenceData.createRequest.requestId` from the
 * draft's identifying fields. Google treats this id as an idempotency key, so a
 * deterministic value means retrying a failed create reuses the same Meet
 * conference instead of minting a duplicate. Callers may still override it.
 */
function deriveConferenceRequestId(draft: CalendarInviteDraft): string {
  const key = [
    draft.calendarId,
    draft.title.trim(),
    draft.start,
    draft.end,
    dedupeStrings(draft.guests).join(","),
  ].join("|");
  // Small, dependency-free FNV-1a hash — collision resistance is irrelevant
  // here; we only need the same draft to map to the same id across retries.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `exo-${(hash >>> 0).toString(36)}`;
}

export function buildCalendarEventInsertParams(
  draft: CalendarInviteDraft,
  requestId = deriveConferenceRequestId(draft),
): CalendarEventInsertParams {
  const requestBody: CalendarEventInsertParams["requestBody"] = {
    summary: draft.title.trim(),
    start: {
      dateTime: draft.start,
      timeZone: draft.timezone,
    },
    end: {
      dateTime: draft.end,
      timeZone: draft.timezone,
    },
  };

  const description = descriptionWithConference(draft);
  if (description) requestBody.description = description;
  if (draft.location.trim()) requestBody.location = draft.location.trim();

  const attendees = dedupeStrings(draft.guests).map((email) => ({ email }));
  if (attendees.length > 0) requestBody.attendees = attendees;

  if (draft.conference.type === "googleMeet") {
    requestBody.conferenceData = {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    };
    return {
      calendarId: draft.calendarId,
      sendUpdates: "all",
      conferenceDataVersion: 1,
      requestBody,
    };
  }

  return {
    calendarId: draft.calendarId,
    sendUpdates: "all",
    requestBody,
  };
}
