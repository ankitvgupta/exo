import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING,
  validateCalendarInviteDraft,
} from "../../../../shared/calendar-invite";
import type {
  CalendarInviteCalendarOption,
  CalendarInviteDraft,
  DashboardEmail,
} from "../../../../shared/types";
import type { ExtensionEnrichmentResult } from "../../../../shared/extension-types";
import { useAppStore } from "../../../../renderer/store";
import {
  addDays,
  addMinutes,
  combineDateAndTime,
  shouldStartInviteExtraction,
  todayString,
  toDateInput,
  toTimeInput,
  updateInviteEndTime,
  updateInviteStartDate,
} from "../../../../shared/calendar-invite-editor";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  isAllDay: boolean;
  calendarName: string;
  calendarColor: string;
  status: "confirmed" | "tentative" | "cancelled";
  location?: string;
  htmlLink?: string;
}

interface CalendarPanelProps {
  email: DashboardEmail;
  threadEmails: DashboardEmail[];
  enrichment: ExtensionEnrichmentResult | null;
  isLoading: boolean;
}

interface GetEventsResponse {
  success: boolean;
  events: CalendarEvent[];
  hasCalendarAccess: boolean;
  hasSynced?: boolean;
  error?: string;
}

interface CalendarApi {
  getEvents: (d: string) => Promise<GetEventsResponse>;
  getInviteOptions: () => Promise<InviteOptionsResponse>;
  extractInvite: (emailId: string) => Promise<ExtractInviteResponse>;
  createInvite: (accountId: string, draft: CalendarInviteDraft) => Promise<CreateInviteResponse>;
  onEventsUpdated: (callback: () => void) => () => void;
}

interface InviteOptionsResponse {
  success: boolean;
  calendars?: CalendarInviteCalendarOption[];
  hasWriteAccess?: boolean;
  requiresReauth?: boolean;
  error?: string;
}

interface ExtractInviteResponse {
  success: boolean;
  draft?: CalendarInviteDraft;
  calendars?: CalendarInviteCalendarOption[];
  hasWriteAccess?: boolean;
  requiresReauth?: boolean;
  hasCalendarAccess?: boolean;
  error?: string;
}

interface CreateInviteResponse {
  success: boolean;
  event?: CalendarEvent;
  error?: string;
  validationErrors?: string[];
  requiresReauth?: boolean;
}

type InviteStatus = "idle" | "extracting" | "ready" | "creating";
type ReauthResponse = { success: boolean; error?: string };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOUR_HEIGHT = 60; // px per hour
const DAY_START_HOUR = 9; // 9am
const DAY_END_HOUR = 24; // midnight
const GUTTER_WIDTH = 40; // px for hour labels
const VISIBLE_START_HOUR = 9; // scroll to 9am on mount
const MIN_EVENT_HEIGHT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatHeaderDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(isoStr: string): string {
  const d = new Date(isoStr);
  return d.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatHourLabel(hour: number): string {
  if (hour === 0 || hour === 24) return "12 AM";
  if (hour === 12) return "12 PM";
  if (hour < 12) return `${hour} AM`;
  return `${hour - 12} PM`;
}

/** Returns fractional hours from midnight for a given ISO datetime. */
function toFractionalHour(isoStr: string): number {
  const d = new Date(isoStr);
  return d.getHours() + d.getMinutes() / 60;
}

function blankInviteDraft(timezone: string): CalendarInviteDraft {
  return {
    title: "",
    start: "",
    end: "",
    timezone,
    guests: [],
    conference: { type: "googleMeet" },
    location: "",
    description: "",
    calendarId: "",
    confidence: 0,
    warnings: [],
  };
}

function guestsToInput(guests: string[]): string {
  return guests.join(", ");
}

function inputToGuests(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[,\n]/)
        .map((guest) => guest.trim())
        .filter(Boolean),
    ),
  );
}

function calendarKey(option: CalendarInviteCalendarOption): string {
  return `${option.accountId}::${option.calendarId}`;
}

function preferredCalendarOption(
  calendars: CalendarInviteCalendarOption[],
  accountId: string,
  calendarId: string,
): CalendarInviteCalendarOption | undefined {
  const preferredKey = accountId && calendarId ? `${accountId}::${calendarId}` : "";
  const accountCalendars = accountId
    ? calendars.filter((calendar) => calendar.accountId === accountId)
    : [];
  return (
    calendars.find((calendar) => preferredKey && calendarKey(calendar) === preferredKey) ??
    accountCalendars.find((calendar) => calendar.writable && calendar.primary) ??
    accountCalendars.find((calendar) => calendar.writable) ??
    accountCalendars[0] ??
    calendars.find((calendar) => calendar.writable && calendar.primary) ??
    calendars.find((calendar) => calendar.writable) ??
    calendars[0]
  );
}

function toReauthResponse(value: unknown): ReauthResponse {
  if (!value || typeof value !== "object") {
    return { success: false, error: "Unexpected re-authentication response" };
  }

  const response = value as Record<string, unknown>;
  return {
    success: response.success === true,
    error: typeof response.error === "string" ? response.error : undefined,
  };
}

function isConferenceType(value: string): value is CalendarInviteDraft["conference"]["type"] {
  return value === "googleMeet" || value === "link" || value === "phone" || value === "none";
}

// ---------------------------------------------------------------------------
// Overlap layout — assign columns to overlapping events
// ---------------------------------------------------------------------------

interface LayoutInfo {
  column: number;
  totalColumns: number;
}

function computeColumns(events: CalendarEvent[]): Map<string, LayoutInfo> {
  const sorted = [...events].sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime(),
  );

  // Group overlapping events
  const groups: CalendarEvent[][] = [];
  let currentGroup: CalendarEvent[] = [];
  let groupEnd = -Infinity;

  for (const evt of sorted) {
    const start = new Date(evt.start).getTime();
    const end = new Date(evt.end).getTime();
    if (start < groupEnd) {
      // Overlaps with current group
      currentGroup.push(evt);
      groupEnd = Math.max(groupEnd, end);
    } else {
      if (currentGroup.length > 0) groups.push(currentGroup);
      currentGroup = [evt];
      groupEnd = end;
    }
  }
  if (currentGroup.length > 0) groups.push(currentGroup);

  const layout = new Map<string, LayoutInfo>();

  for (const group of groups) {
    // Assign columns greedily
    const columnEnds: number[] = [];
    for (const evt of group) {
      const start = new Date(evt.start).getTime();
      let placed = false;
      for (let col = 0; col < columnEnds.length; col++) {
        if (start >= columnEnds[col]) {
          columnEnds[col] = new Date(evt.end).getTime();
          layout.set(evt.id, { column: col, totalColumns: 0 });
          placed = true;
          break;
        }
      }
      if (!placed) {
        layout.set(evt.id, { column: columnEnds.length, totalColumns: 0 });
        columnEnds.push(new Date(evt.end).getTime());
      }
    }
    // Set totalColumns for the group
    const total = columnEnds.length;
    for (const evt of group) {
      const info = layout.get(evt.id)!;
      info.totalColumns = total;
    }
  }

  return layout;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function EventBlock({ event, layoutInfo }: { event: CalendarEvent; layoutInfo: LayoutInfo }) {
  const rawStartHour = toFractionalHour(event.start);
  const startHour = Math.max(rawStartHour, DAY_START_HOUR);
  const endHour = toFractionalHour(event.end);
  const top = (startHour - DAY_START_HOUR) * HOUR_HEIGHT;
  const height = Math.max(MIN_EVENT_HEIGHT, (endHour - startHour) * HOUR_HEIGHT);
  const isShort = height < 36;

  const { column, totalColumns } = layoutInfo;
  const widthPercent = 100 / totalColumns;
  const leftPercent = column * widthPercent;

  const bgColor = event.calendarColor || "#4285f4";
  const isTentative = event.status === "tentative";

  // Event area starts after the gutter. We express left/width as fractions
  // of (100% - GUTTER_WIDTH) so overlapping events split the available space.
  const fractionLeft = leftPercent / 100;
  const fractionWidth = widthPercent / 100;

  return (
    <div
      data-testid={
        event.id === "calendar-invite-proposed" ? "calendar-invite-proposed-event" : undefined
      }
      className="absolute rounded px-1.5 py-0.5 overflow-hidden cursor-default group"
      style={{
        top: `${top}px`,
        height: `${height}px`,
        left: `calc(${GUTTER_WIDTH}px + (100% - ${GUTTER_WIDTH}px) * ${fractionLeft})`,
        width: `calc((100% - ${GUTTER_WIDTH}px) * ${fractionWidth} - 2px)`,
        borderLeft: `3px ${isTentative ? "dashed" : "solid"} ${bgColor}`,
        backgroundColor: `${bgColor}1a`, // 10% opacity hex
      }}
    >
      <div
        className={`font-medium text-gray-900 dark:text-gray-100 truncate ${
          isShort ? "text-[10px] leading-tight" : "text-xs"
        }`}
      >
        {event.summary}
      </div>
      {!isShort && (
        <div className="text-[10px] text-gray-500 dark:text-gray-400 truncate">
          {formatTime(event.start)} – {formatTime(event.end)}
        </div>
      )}
      {!isShort && event.location && (
        <div className="text-[10px] text-gray-400 dark:text-gray-500 truncate">
          {event.location}
        </div>
      )}
    </div>
  );
}

function AllDayStrip({ events }: { events: CalendarEvent[] }) {
  if (events.length === 0) return null;

  return (
    <div className="px-2 py-1.5 border-b border-gray-200 dark:border-gray-700 space-y-1">
      {events.map((evt) => (
        <div
          key={evt.id}
          className="px-2 py-1 rounded text-xs font-medium truncate"
          style={{
            backgroundColor: `${evt.calendarColor || "#4285f4"}20`,
            borderLeft: `3px solid ${evt.calendarColor || "#4285f4"}`,
            color: "inherit",
          }}
        >
          <span className="text-gray-800 dark:text-gray-200">{evt.summary}</span>
        </div>
      ))}
    </div>
  );
}

function CurrentTimeLine({
  scrollRef: _scrollRef,
}: {
  scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(interval);
  }, []);

  const hours = now.getHours() + now.getMinutes() / 60;
  const top = (hours - DAY_START_HOUR) * HOUR_HEIGHT;

  return (
    <div className="absolute left-0 right-0 z-10 pointer-events-none" style={{ top: `${top}px` }}>
      <div className="flex items-center">
        <div
          className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0"
          style={{ marginLeft: `${GUTTER_WIDTH - 5}px` }}
        />
        <div className="flex-1 h-[2px] bg-red-500" />
      </div>
    </div>
  );
}

function TimeGrid({ events, isToday }: { events: CalendarEvent[]; isToday: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hasScrolled = useRef(false);

  const timedEvents = events.filter((e) => !e.isAllDay);
  const columns = useMemo(() => computeColumns(timedEvents), [timedEvents]);
  const hours = Array.from({ length: DAY_END_HOUR - DAY_START_HOUR }, (_, i) => i + DAY_START_HOUR);

  // Scroll to current time (today) or VISIBLE_START_HOUR (other days)
  useEffect(() => {
    if (!scrollRef.current) return;
    // Always scroll when events change (day navigation)
    const targetHour = VISIBLE_START_HOUR;
    scrollRef.current.scrollTop = (targetHour - DAY_START_HOUR) * HOUR_HEIGHT;
    hasScrolled.current = true;
  }, [isToday, events]);

  const totalHeight = (DAY_END_HOUR - DAY_START_HOUR) * HOUR_HEIGHT;

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden relative">
      <div className="relative" style={{ height: `${totalHeight}px` }}>
        {/* Hour lines */}
        {hours.map((h) => {
          const y = (h - DAY_START_HOUR) * HOUR_HEIGHT;
          return (
            <div key={h} className="absolute left-0 right-0" style={{ top: `${y}px` }}>
              <div className="flex items-start">
                <span
                  className="text-[10px] text-gray-400 dark:text-gray-500 text-right pr-2 flex-shrink-0 -mt-[6px]"
                  style={{ width: `${GUTTER_WIDTH}px` }}
                >
                  {formatHourLabel(h)}
                </span>
                <div className="flex-1 border-t border-gray-100 dark:border-gray-700/50" />
              </div>
            </div>
          );
        })}

        {/* Events */}
        {timedEvents.map((evt) => {
          const layoutInfo = columns.get(evt.id);
          if (!layoutInfo) return null;
          return <EventBlock key={evt.id} event={evt} layoutInfo={layoutInfo} />;
        })}

        {/* Current time indicator */}
        {isToday && <CurrentTimeLine scrollRef={scrollRef} />}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="p-4 space-y-3">
      <div className="h-6 bg-gray-100 dark:bg-gray-700 rounded animate-pulse w-2/3" />
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-12 bg-gray-100 dark:bg-gray-700 rounded animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function NoCalendarAccess() {
  return (
    <div className="p-4 text-center">
      <div className="w-10 h-10 mx-auto mb-3 rounded-full bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center">
        <svg
          className="w-5 h-5 text-amber-600 dark:text-amber-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
          />
        </svg>
      </div>
      <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
        Calendar access needed
      </p>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        Grant calendar permissions in Settings to see your events here.
      </p>
    </div>
  );
}

type InviteIconName = "title" | "guests" | "time" | "video" | "location" | "notes" | "calendar";

const inviteControlBaseClass =
  "w-full h-9 rounded-md border border-gray-200 bg-white text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/15 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder:text-gray-500";

const inviteControlClass = `${inviteControlBaseClass} px-3 text-xs leading-5`;
const inviteCompactControlClass = `${inviteControlBaseClass} px-2 text-xs leading-5`;
const inviteSelectClass = `${inviteControlBaseClass} px-3 pr-8 text-xs leading-5`;
const inviteActionFocusClass =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-1 focus-visible:ring-offset-white dark:focus-visible:ring-offset-gray-800";

function StrokeIcon({
  children,
  className = "h-[18px] w-[18px]",
}: {
  children: React.ReactNode;
  className?: string;
}): React.ReactElement {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function InviteIcon({ name }: { name: InviteIconName }): React.ReactElement {
  if (name === "title") {
    return (
      <span className="font-serif text-xl leading-none text-gray-500 dark:text-gray-400">T</span>
    );
  }
  if (name === "guests") {
    return <span className="text-xl leading-none text-gray-500 dark:text-gray-400">@</span>;
  }
  if (name === "time") {
    return (
      <StrokeIcon>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </StrokeIcon>
    );
  }
  if (name === "video") {
    return (
      <StrokeIcon>
        <path d="M15 10l5-3v10l-5-3z" />
        <rect x="3" y="7" width="12" height="10" rx="2" />
      </StrokeIcon>
    );
  }
  if (name === "location") {
    return (
      <StrokeIcon>
        <path d="M12 21s7-5.2 7-11a7 7 0 10-14 0c0 5.8 7 11 7 11z" />
        <circle cx="12" cy="10" r="2.5" />
      </StrokeIcon>
    );
  }
  if (name === "notes") {
    return (
      <StrokeIcon>
        <path d="M6 3h9l3 3v15H6z" />
        <path d="M14 3v4h4" />
        <path d="M9 12h6" />
        <path d="M9 16h6" />
      </StrokeIcon>
    );
  }
  return (
    <StrokeIcon>
      <path d="M8 3v4" />
      <path d="M16 3v4" />
      <rect x="4" y="5" width="16" height="16" rx="2" />
      <path d="M4 10h16" />
    </StrokeIcon>
  );
}

function ChevronDownIcon({ className = "h-4 w-4" }: { className?: string }): React.ReactElement {
  return (
    <StrokeIcon className={className}>
      <path d="M6 9l6 6 6-6" />
    </StrokeIcon>
  );
}

function LockIcon(): React.ReactElement {
  return (
    <StrokeIcon className="h-4 w-4">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </StrokeIcon>
  );
}

function InviteField({
  icon,
  children,
}: {
  icon: InviteIconName;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex items-start gap-2">
      <div className="flex h-9 w-8 flex-shrink-0 items-center justify-center text-gray-500 dark:text-gray-400">
        <InviteIcon name={icon} />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function InviteEditor({
  status,
  draft,
  calendars,
  selectedAccountId,
  validationErrors,
  error,
  requiresReauth,
  reauthing,
  onDraftChange,
  onCalendarChange,
  onReauth,
}: {
  status: InviteStatus;
  draft: CalendarInviteDraft;
  calendars: CalendarInviteCalendarOption[];
  selectedAccountId: string;
  validationErrors: string[];
  error: string | null;
  requiresReauth: boolean;
  reauthing: boolean;
  onDraftChange: React.Dispatch<React.SetStateAction<CalendarInviteDraft>>;
  onCalendarChange: (key: string) => void;
  onReauth: () => Promise<void>;
}): React.ReactElement {
  const startDate = toDateInput(draft.start);
  const startTime = toTimeInput(draft.start);
  const endTime = toTimeInput(draft.end);
  const selectedKey =
    selectedAccountId && draft.calendarId ? `${selectedAccountId}::${draft.calendarId}` : "";
  const messagesId = "calendar-invite-warnings";
  const hasMessages = draft.warnings.length > 0 || validationErrors.length > 0;
  const describedBy = hasMessages ? messagesId : undefined;
  const hasValidationError = (needle: string) =>
    validationErrors.some((error) => error.toLowerCase().includes(needle));

  const updateStartDate = (date: string) => {
    onDraftChange((prev) => updateInviteStartDate(prev, date));
  };

  const updateStartTime = (time: string) => {
    onDraftChange((prev) => {
      const date = toDateInput(prev.start) || todayString();
      const nextStart = combineDateAndTime(date, time);
      return {
        ...prev,
        start: nextStart,
        end: prev.end ? prev.end : addMinutes(nextStart, 30),
      };
    });
  };

  const updateEndTime = (time: string) => {
    onDraftChange((prev) => updateInviteEndTime(prev, time));
  };

  return (
    <div
      data-testid="calendar-invite-editor"
      className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800"
    >
      <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2.5 dark:border-gray-700">
        <div>
          <p className="text-sm font-semibold text-gray-950 dark:text-gray-100">New invite</p>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">
            Create and review before sending
          </p>
        </div>
        {status === "extracting" && (
          <span className="text-xs font-medium text-blue-600 dark:text-blue-400">
            Extracting...
          </span>
        )}
        {status !== "extracting" && (
          <span className="text-gray-500 dark:text-gray-400">
            <ChevronDownIcon />
          </span>
        )}
      </div>

      {status === "extracting" ? (
        <div className="space-y-3 px-3 py-3" data-testid="calendar-invite-loading">
          {[1, 2, 3, 4, 5].map((item) => (
            <div key={item} className="flex items-start gap-2">
              <div className="h-9 w-8 flex-shrink-0 animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/80" />
              <div className="h-9 flex-1 animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/80" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-3 px-3 py-3">
          {error && (
            <div
              data-testid="calendar-invite-error"
              className="rounded-md border border-red-200 bg-red-50 px-2.5 py-2 text-xs text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300"
            >
              {error}
            </div>
          )}
          {requiresReauth && (
            <div className="rounded-md border border-amber-300 bg-amber-50/70 px-2.5 py-2 text-amber-800 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-200">
              <div className="flex items-center gap-2">
                <LockIcon />
                <span className="min-w-0 flex-1 text-xs font-medium">
                  Google Calendar write permission needed
                </span>
              </div>
              <button
                type="button"
                data-testid="calendar-invite-reauth"
                disabled={reauthing || !selectedAccountId}
                className={`mt-2 w-full rounded-md border border-amber-300 bg-white/80 px-2.5 py-1.5 text-xs font-semibold text-blue-600 hover:bg-white hover:text-blue-700 disabled:cursor-not-allowed disabled:border-amber-200 disabled:text-gray-400 dark:border-amber-800/80 dark:bg-gray-900/40 dark:text-blue-300 dark:hover:bg-gray-900/70 dark:hover:text-blue-200 dark:disabled:text-gray-500 ${inviteActionFocusClass}`}
                onClick={() => {
                  onReauth().catch(console.error);
                }}
              >
                {reauthing ? "Waiting for browser..." : "Re-authenticate"}
              </button>
            </div>
          )}

          <InviteField icon="title">
            <input
              aria-label="Invite title"
              data-testid="calendar-invite-title"
              aria-invalid={hasValidationError("title")}
              aria-describedby={describedBy}
              value={draft.title}
              onChange={(event) =>
                onDraftChange((prev) => ({ ...prev, title: event.target.value }))
              }
              placeholder="Title"
              className={inviteControlClass}
            />
          </InviteField>

          <InviteField icon="guests">
            <input
              aria-label="Invite guests"
              data-testid="calendar-invite-guests"
              aria-invalid={hasValidationError("guest")}
              aria-describedby={describedBy}
              value={guestsToInput(draft.guests)}
              onChange={(event) =>
                onDraftChange((prev) => ({ ...prev, guests: inputToGuests(event.target.value) }))
              }
              placeholder="Add guests"
              className={inviteControlClass}
            />
          </InviteField>

          <InviteField icon="time">
            <div className="space-y-2">
              <input
                aria-label="Invite date"
                data-testid="calendar-invite-date"
                type="date"
                aria-invalid={hasValidationError("start") || hasValidationError("valid start")}
                aria-describedby={describedBy}
                value={startDate}
                onChange={(event) => updateStartDate(event.target.value)}
                className={inviteCompactControlClass}
              />
              <div className="flex items-center gap-2">
                <input
                  aria-label="Invite start time"
                  data-testid="calendar-invite-start"
                  type="time"
                  aria-invalid={hasValidationError("start") || hasValidationError("valid start")}
                  aria-describedby={describedBy}
                  value={startTime}
                  onChange={(event) => updateStartTime(event.target.value)}
                  className={`${inviteCompactControlClass} min-w-0 flex-1`}
                />
                <span className="flex-shrink-0 text-sm text-gray-400 dark:text-gray-500">-</span>
                <input
                  aria-label="Invite end time"
                  data-testid="calendar-invite-end"
                  type="time"
                  aria-invalid={hasValidationError("end") || hasValidationError("valid end")}
                  aria-describedby={describedBy}
                  value={endTime}
                  onChange={(event) => updateEndTime(event.target.value)}
                  className={`${inviteCompactControlClass} min-w-0 flex-1`}
                />
              </div>
            </div>
          </InviteField>

          <InviteField icon="video">
            <div className="space-y-2">
              <select
                aria-label="Invite conference"
                value={draft.conference.type}
                onChange={(event) =>
                  onDraftChange((prev) => {
                    const type = isConferenceType(event.target.value) ? event.target.value : "none";
                    return {
                      ...prev,
                      conference: {
                        type,
                        value: prev.conference.value,
                      },
                    };
                  })
                }
                className={inviteSelectClass}
              >
                <option value="googleMeet">Google Meet</option>
                <option value="link">Link</option>
                <option value="phone">Phone</option>
                <option value="none">None</option>
              </select>
              <input
                aria-label="Invite conference value"
                value={draft.conference.value ?? ""}
                onChange={(event) =>
                  onDraftChange((prev) => ({
                    ...prev,
                    conference: { ...prev.conference, value: event.target.value },
                  }))
                }
                placeholder="Meeting link or phone"
                disabled={
                  draft.conference.type === "googleMeet" || draft.conference.type === "none"
                }
                className={`${inviteControlClass} disabled:bg-gray-50 disabled:text-gray-400 dark:disabled:bg-gray-800/70 dark:disabled:text-gray-500`}
              />
            </div>
          </InviteField>

          <InviteField icon="location">
            <input
              aria-label="Invite location"
              value={draft.location}
              onChange={(event) =>
                onDraftChange((prev) => ({ ...prev, location: event.target.value }))
              }
              placeholder="Location"
              className={inviteControlClass}
            />
          </InviteField>

          <InviteField icon="notes">
            <textarea
              aria-label="Invite description"
              value={draft.description}
              onChange={(event) =>
                onDraftChange((prev) => ({ ...prev, description: event.target.value }))
              }
              placeholder="Agenda or notes"
              rows={3}
              className={`${inviteControlBaseClass} h-20 resize-none px-3 py-2 text-xs leading-5`}
            />
          </InviteField>

          <InviteField icon="calendar">
            <select
              aria-label="Invite calendar"
              data-testid="calendar-invite-calendar"
              aria-invalid={hasValidationError("calendar")}
              aria-describedby={describedBy}
              value={selectedKey}
              onChange={(event) => onCalendarChange(event.target.value)}
              className={inviteSelectClass}
            >
              <option value="">Choose calendar</option>
              {calendars.map((calendar) => (
                <option
                  key={calendarKey(calendar)}
                  value={calendarKey(calendar)}
                  disabled={!calendar.writable}
                >
                  {calendar.calendarName} - {calendar.accountEmail}
                  {calendar.writable ? "" : " (read-only)"}
                </option>
              ))}
            </select>
          </InviteField>

          {hasMessages && (
            <div
              id={messagesId}
              role="alert"
              aria-live="polite"
              className="space-y-1 rounded-md bg-amber-50 px-2.5 py-2 dark:bg-amber-950/30"
              style={{ marginLeft: 40 }}
              data-testid="calendar-invite-warnings"
            >
              {[...draft.warnings, ...validationErrors].map((warning) => (
                <div key={warning} className="text-xs text-amber-700 dark:text-amber-300">
                  {warning}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

function getCalendarApi(): CalendarApi {
  return (window as unknown as { api: { calendar: CalendarApi } }).api.calendar;
}

export function CalendarPanel({
  email,
  enrichment,
  isLoading: enrichmentLoading,
}: CalendarPanelProps): React.ReactElement {
  const hasCalendarAccess =
    (enrichment?.data as Record<string, unknown> | undefined)?.hasCalendarAccess === true;
  const calendarInviteRequest = useAppStore((state) => state.calendarInviteRequest);
  const clearCalendarInviteRequest = useAppStore((state) => state.clearCalendarInviteRequest);
  const startedInviteNonceRef = useRef<number | null>(null);

  const [selectedDate, setSelectedDate] = useState(todayString);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteStatus, setInviteStatus] = useState<InviteStatus>("idle");
  const [inviteDraft, setInviteDraft] = useState<CalendarInviteDraft>(() =>
    blankInviteDraft(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
  );
  const [inviteCalendars, setInviteCalendars] = useState<CalendarInviteCalendarOption[]>([]);
  const [selectedInviteAccountId, setSelectedInviteAccountId] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [requiresReauth, setRequiresReauth] = useState(false);
  const [inviteReauthing, setInviteReauthing] = useState(false);

  const isToday = selectedDate === todayString();

  const fetchEvents = useCallback(async (date: string) => {
    setLoading(true);
    try {
      const result = await getCalendarApi().getEvents(date);
      setEvents(result.success ? result.events : []);
      // Track if initial sync hasn't completed yet
      setSyncing(result.success && result.hasCalendarAccess && !result.hasSynced);
    } catch (err) {
      console.error("[CalendarPanel] fetch failed:", err);
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Fetch on mount + date change
  useEffect(() => {
    if (hasCalendarAccess || inviteOpen) {
      fetchEvents(selectedDate);
      return;
    }
    setLoading(false);
  }, [selectedDate, hasCalendarAccess, inviteOpen, fetchEvents]);

  // Subscribe to background sync updates — refetch current date when events change
  useEffect(() => {
    const api = getCalendarApi();
    const unsubscribe = api.onEventsUpdated(() => {
      fetchEvents(selectedDate);
    });
    return unsubscribe;
  }, [selectedDate, fetchEvents]);

  const goPrev = useCallback(() => setSelectedDate((d) => addDays(d, -1)), []);
  const goNext = useCallback(() => setSelectedDate((d) => addDays(d, 1)), []);
  const goToday = useCallback(() => setSelectedDate(todayString()), []);

  const selectCalendar = useCallback(
    (key: string) => {
      const option = inviteCalendars.find((calendar) => calendarKey(calendar) === key);
      setSelectedInviteAccountId(option?.accountId ?? "");
      setInviteDraft((prev) => ({
        ...prev,
        calendarId: option?.calendarId ?? "",
        timezone: option?.timezone ?? prev.timezone,
      }));
    },
    [inviteCalendars],
  );

  const cancelInvite = useCallback(() => {
    setInviteOpen(false);
    setInviteStatus("idle");
    setInviteError(null);
    setValidationErrors([]);
    setInviteReauthing(false);
    clearCalendarInviteRequest();
  }, [clearCalendarInviteRequest]);

  const startInvite = useCallback(async (emailId: string) => {
    const api = getCalendarApi();
    setInviteOpen(true);
    setInviteStatus("extracting");
    setInviteError(null);
    setValidationErrors([]);
    setInviteReauthing(false);

    try {
      const extractResult = await api.extractInvite(emailId);
      const calendars = extractResult.calendars ?? [];
      setInviteCalendars(calendars);
      setRequiresReauth(Boolean(extractResult.requiresReauth));
      if (!extractResult.success && extractResult.error) {
        setInviteError(extractResult.error);
      }
      const fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const draft = extractResult.success
        ? (extractResult.draft ?? blankInviteDraft(fallbackTimezone))
        : {
            ...blankInviteDraft(fallbackTimezone),
            warnings: [CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING],
          };

      const selected = preferredCalendarOption(calendars, email.accountId ?? "", draft.calendarId);

      setSelectedInviteAccountId(selected?.accountId ?? "");
      setInviteDraft({
        ...draft,
        calendarId: selected?.calendarId ?? draft.calendarId,
        timezone: selected?.timezone ?? (draft.timezone || fallbackTimezone),
      });
      if (draft.start) {
        const date = toDateInput(draft.start);
        if (date) setSelectedDate(date);
      }
      if (!extractResult.success && extractResult.error) {
        setInviteError(extractResult.error);
      }
    } catch (err) {
      console.error("[CalendarPanel] invite extraction failed:", err);
      const fallbackTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      setInviteDraft({
        ...blankInviteDraft(fallbackTimezone),
        warnings: [CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING],
      });
      setInviteError(err instanceof Error ? err.message : "Failed to extract invite");
    } finally {
      setInviteStatus("ready");
    }
  }, [email.accountId]);

  const reauthenticateInviteCalendar = useCallback(async () => {
    if (!selectedInviteAccountId) {
      setInviteError("Choose a calendar account to re-authenticate.");
      return;
    }

    setInviteReauthing(true);
    setInviteError(null);

    try {
      const reauthResult = toReauthResponse(await window.api.auth.reauth(selectedInviteAccountId));
      if (!reauthResult.success) {
        setInviteError(reauthResult.error ?? "Google Calendar re-authentication failed.");
        return;
      }

      const optionsResult = await getCalendarApi().getInviteOptions();
      const calendars = optionsResult.success ? (optionsResult.calendars ?? []) : [];
      setInviteCalendars(calendars);
      setRequiresReauth(Boolean(optionsResult.requiresReauth));

      if (!optionsResult.success) {
        setInviteError(optionsResult.error ?? "Failed to reload Google Calendar permissions.");
        return;
      }

      const selected = preferredCalendarOption(
        calendars,
        selectedInviteAccountId,
        inviteDraft.calendarId,
      );
      setSelectedInviteAccountId(selected?.accountId ?? selectedInviteAccountId);
      setInviteDraft((prev) => ({
        ...prev,
        calendarId: selected?.calendarId ?? prev.calendarId,
        timezone: selected?.timezone ?? prev.timezone,
      }));

      await fetchEvents(selectedDate);
    } catch (err) {
      setInviteError(
        err instanceof Error ? err.message : "Google Calendar re-authentication failed.",
      );
    } finally {
      setInviteReauthing(false);
    }
  }, [fetchEvents, inviteDraft.calendarId, selectedDate, selectedInviteAccountId]);

  useEffect(() => {
    if (!calendarInviteRequest) {
      startedInviteNonceRef.current = null;
      return;
    }
    if (
      !shouldStartInviteExtraction(
        calendarInviteRequest,
        email.threadId,
        startedInviteNonceRef.current,
      )
    ) {
      return;
    }
    startedInviteNonceRef.current = calendarInviteRequest.nonce;
    startInvite(calendarInviteRequest.emailId).catch(console.error);
  }, [calendarInviteRequest, email.threadId, startInvite]);

  useEffect(() => {
    if (!inviteDraft.start) return;
    const date = toDateInput(inviteDraft.start);
    if (date && date !== selectedDate) {
      setSelectedDate(date);
    }
  }, [inviteDraft.start, selectedDate]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (!inviteOpen || event.key !== "Escape") return;
      event.preventDefault();
      cancelInvite();
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [cancelInvite, inviteOpen]);

  const createInvite = useCallback(async () => {
    const errors = validateCalendarInviteDraft(inviteDraft);
    setValidationErrors(errors);
    if (errors.length > 0 || !selectedInviteAccountId) return;

    setInviteStatus("creating");
    setInviteError(null);
    try {
      const result = await getCalendarApi().createInvite(selectedInviteAccountId, inviteDraft);
      if (!result.success) {
        setInviteStatus("ready");
        setInviteError(result.error ?? "Failed to create invite");
        setValidationErrors(result.validationErrors ?? []);
        setRequiresReauth(Boolean(result.requiresReauth));
        return;
      }

      setInviteOpen(false);
      setInviteStatus("idle");
      setValidationErrors([]);
      clearCalendarInviteRequest();
    } catch (err) {
      setInviteStatus("ready");
      setInviteError(err instanceof Error ? err.message : "Failed to create invite");
    }
  }, [clearCalendarInviteRequest, inviteDraft, selectedInviteAccountId]);

  const proposedTitle = inviteDraft.title;
  const proposedStart = inviteDraft.start;
  const proposedEnd = inviteDraft.end;
  const proposedLocation = inviteDraft.location;

  const proposedEvent = useMemo<CalendarEvent | null>(() => {
    if (!inviteOpen || !proposedStart || !proposedEnd) return null;
    const start = new Date(proposedStart).getTime();
    const end = new Date(proposedEnd).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
    return {
      id: "calendar-invite-proposed",
      summary: proposedTitle || "(No title)",
      start: proposedStart,
      end: proposedEnd,
      isAllDay: false,
      calendarName: "Invite draft",
      calendarColor: "#f59e0b",
      status: "tentative",
      location: proposedLocation || undefined,
    };
  }, [inviteOpen, proposedEnd, proposedLocation, proposedStart, proposedTitle]);

  const visibleEvents = useMemo(
    () => (proposedEvent ? [...events, proposedEvent] : events),
    [events, proposedEvent],
  );

  // Wait for enrichment to tell us about access
  if (enrichmentLoading && !inviteOpen) {
    return <LoadingState />;
  }

  if (!hasCalendarAccess && !inviteOpen) {
    return <NoCalendarAccess />;
  }

  const allDayEvents = visibleEvents.filter((e) => e.isAllDay);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <button
          onClick={goToday}
          className={`text-sm font-medium transition-colors ${
            isToday
              ? "text-gray-900 dark:text-gray-100"
              : "text-blue-600 dark:text-blue-400 hover:text-blue-700 dark:hover:text-blue-300 cursor-pointer"
          }`}
          title={isToday ? "Today" : "Jump to today"}
        >
          {formatHeaderDate(selectedDate)}
        </button>
        <div className="flex gap-1">
          <button
            onClick={goPrev}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
            aria-label="Previous day"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            onClick={goNext}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
            aria-label="Next day"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </div>
      </div>

      {inviteOpen && (
        <InviteEditor
          status={inviteStatus}
          draft={inviteDraft}
          calendars={inviteCalendars}
          selectedAccountId={selectedInviteAccountId}
          validationErrors={validationErrors}
          error={inviteError}
          requiresReauth={requiresReauth}
          reauthing={inviteReauthing}
          onDraftChange={setInviteDraft}
          onCalendarChange={selectCalendar}
          onReauth={reauthenticateInviteCalendar}
        />
      )}

      {/* All-day events */}
      <AllDayStrip events={allDayEvents} />

      {/* Time grid */}
      {loading ? (
        <LoadingState />
      ) : syncing ? (
        <div className="flex-1 flex items-center justify-center text-sm text-gray-500 dark:text-gray-400">
          Syncing calendars…
        </div>
      ) : (
        <TimeGrid events={visibleEvents} isToday={isToday} />
      )}

      {inviteOpen && (
        <div className="flex flex-shrink-0 gap-2 border-t border-gray-200 bg-gray-50 p-2.5 dark:border-gray-700 dark:bg-gray-800/90">
          <button
            type="button"
            onClick={cancelInvite}
            className="flex-1 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
          <button
            type="button"
            data-testid="calendar-invite-create"
            onClick={() => {
              createInvite().catch(console.error);
            }}
            disabled={
              inviteStatus === "extracting" || inviteStatus === "creating" || requiresReauth
            }
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:bg-gray-300 disabled:text-gray-500 dark:disabled:bg-gray-700"
            style={{ flex: "1.4 1 0" }}
          >
            {inviteStatus === "creating" ? "Creating..." : "Create and send"}
          </button>
        </div>
      )}
    </div>
  );
}
