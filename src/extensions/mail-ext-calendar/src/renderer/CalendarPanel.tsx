import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { DashboardEmail } from "../../../../shared/types";
import type { ExtensionEnrichmentResult } from "../../../../shared/extension-types";

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
  onEventsUpdated: (callback: () => void) => () => void;
}

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

function toDateString(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayString(): string {
  return toDateString(new Date());
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00"); // noon avoids DST edge
  d.setDate(d.getDate() + n);
  return toDateString(d);
}

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

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

function getCalendarApi(): CalendarApi {
  return (window as unknown as { api: { calendar: CalendarApi } }).api.calendar;
}

export function CalendarPanel({
  enrichment,
  isLoading: enrichmentLoading,
}: CalendarPanelProps): React.ReactElement {
  const hasCalendarAccess =
    (enrichment?.data as Record<string, unknown> | undefined)?.hasCalendarAccess === true;

  const [selectedDate, setSelectedDate] = useState(todayString);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);

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
    if (hasCalendarAccess) {
      fetchEvents(selectedDate);
    }
  }, [selectedDate, hasCalendarAccess, fetchEvents]);

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

  // Wait for enrichment to tell us about access
  if (enrichmentLoading) {
    return <LoadingState />;
  }

  if (!hasCalendarAccess) {
    return <NoCalendarAccess />;
  }

  const allDayEvents = events.filter((e) => e.isAllDay);

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
        <TimeGrid events={events} isToday={isToday} />
      )}
    </div>
  );
}
