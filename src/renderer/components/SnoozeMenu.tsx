import { useState, useRef, useEffect } from "react";
import type { IpcResponse, SnoozedEmail } from "../../shared/types";
import { trackEvent } from "../services/posthog";

declare global {
  interface Window {
    api: {
      snooze: {
        snooze: (
          emailId: string,
          threadId: string,
          accountId: string,
          snoozeUntil: number,
        ) => Promise<IpcResponse<SnoozedEmail>>;
        unsnooze: (threadId: string, accountId: string) => Promise<IpcResponse<void>>;
        list: (accountId: string) => Promise<IpcResponse<SnoozedEmail[]>>;
        get: (threadId: string, accountId: string) => Promise<IpcResponse<SnoozedEmail | null>>;
        onUnsnoozed: (callback: (data: { emails: SnoozedEmail[] }) => void) => void;
        onSnoozed: (callback: (data: { snoozedEmail: SnoozedEmail }) => void) => void;
        onManuallyUnsnoozed: (
          callback: (data: { threadId: string; accountId: string }) => void,
        ) => void;
        removeAllListeners: () => void;
      };
    };
  }
}

interface SnoozeOption {
  label: string;
  getTime: () => number;
  sublabel?: string;
}

// ============================================
// Natural language snooze parser
// ============================================

const MONTH_NAMES: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const DAY_NAMES: Record<string, number> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

/**
 * Parse a flexible natural-language snooze string into a timestamp.
 * Returns null if the string can't be parsed.
 *
 * Supported formats:
 * - Relative durations: "1 min", "30m", "2 hours", "1h", "3 days", "1d", "2 weeks", "1w"
 * - Named times: "tomorrow", "tonight", "next week", "next monday", "this weekend"
 * - Day names: "monday", "tuesday", "next friday"
 * - Month + day: "jan 15", "february 3", "dec 25"
 * - Time: "3pm", "3:30pm", "15:00" (combined with date or standalone for today/tomorrow)
 */
export function parseSnoozeText(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;

  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  // --- Relative durations ---
  // "30s", "1 min", "5 minutes", "5m", "2 hours", "2h", "3 days", "3d", "1 week", "1w"
  const relMatch = text.match(
    /^(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)$/,
  );
  if (relMatch) {
    const num = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    let ms = 0;
    if (unit.startsWith("s")) ms = num * 1000;
    else if (unit === "m" || unit.startsWith("min")) ms = num * 60 * 1000;
    else if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour"))
      ms = num * 3600 * 1000;
    else if (unit === "d" || unit.startsWith("day")) ms = num * 86400 * 1000;
    else if (unit === "w" || unit.startsWith("wk") || unit.startsWith("week"))
      ms = num * 7 * 86400 * 1000;

    if (ms > 0) {
      const target = now.getTime() + ms;
      return target > now.getTime() ? target : null;
    }
  }

  // Also handle "in X ..." format: "in 2 hours", "in 30 min"
  const inRelMatch = text.match(
    /^in\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)$/,
  );
  if (inRelMatch) {
    return parseSnoozeText(`${inRelMatch[1]}${inRelMatch[2]}`);
  }

  // --- Named keywords ---
  if (text === "tonight") {
    const target = new Date(today);
    target.setHours(20, 0, 0, 0);
    return target.getTime() > now.getTime() ? target.getTime() : null;
  }

  if (text === "tomorrow" || text === "tmrw" || text === "tmr") {
    const target = new Date(today);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  }

  // "tomorrow 3pm", "tomorrow at 3pm", "tmrw 14:00"
  const tmrwTimeMatch = text.match(/^(?:tomorrow|tmrw|tmr)\s+(?:at\s+)?(.+)$/);
  if (tmrwTimeMatch) {
    const timeTs = parseTimeString(tmrwTimeMatch[1]);
    if (timeTs !== null) {
      const target = new Date(today);
      target.setDate(target.getDate() + 1);
      target.setHours(timeTs.hours, timeTs.minutes, 0, 0);
      return target.getTime();
    }
  }

  if (text === "this weekend") {
    const target = new Date(today);
    const dayOfWeek = target.getDay();
    const daysUntilSat = dayOfWeek === 6 ? 7 : 6 - dayOfWeek;
    target.setDate(target.getDate() + daysUntilSat);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  }

  if (text === "next week") {
    const target = new Date(today);
    const dayOfWeek = target.getDay();
    const daysUntilMon = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    target.setDate(target.getDate() + daysUntilMon);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  }

  // --- "next <day>" or bare day name ---
  // "next monday", "next fri", "monday", "friday"
  const nextDayMatch = text.match(/^(?:next\s+)?(\w+)$/);
  if (nextDayMatch) {
    const dayName = nextDayMatch[1];
    const targetDay = DAY_NAMES[dayName];
    if (targetDay !== undefined) {
      const isNext = text.startsWith("next");
      const target = new Date(today);
      const currentDay = target.getDay();
      let diff = targetDay - currentDay;
      if (diff <= 0 || isNext) diff += 7;
      if (isNext && diff <= 7) diff += 0; // "next monday" when it's sunday should go to tomorrow
      target.setDate(target.getDate() + diff);
      target.setHours(9, 0, 0, 0);
      return target.getTime();
    }
  }

  // --- "next <day> at <time>" ---
  const nextDayTimeMatch = text.match(/^(?:next\s+)?(\w+)\s+(?:at\s+)?(\d.*)$/);
  if (nextDayTimeMatch) {
    const dayName = nextDayTimeMatch[1];
    const targetDay = DAY_NAMES[dayName];
    if (targetDay !== undefined) {
      const timeTs = parseTimeString(nextDayTimeMatch[2]);
      if (timeTs) {
        const isNext = text.startsWith("next");
        const target = new Date(today);
        const currentDay = target.getDay();
        let diff = targetDay - currentDay;
        if (diff <= 0 || isNext) diff += 7;
        target.setDate(target.getDate() + diff);
        target.setHours(timeTs.hours, timeTs.minutes, 0, 0);
        return target.getTime();
      }
    }
  }

  // --- Month + day: "jan 15", "february 3", "dec 25 at 2pm" ---
  const monthDayMatch = text.match(/^(\w+)\s+(\d{1,2})(?:\s+(?:at\s+)?(.+))?$/);
  if (monthDayMatch) {
    const monthName = monthDayMatch[1];
    const month = MONTH_NAMES[monthName];
    if (month !== undefined) {
      const day = parseInt(monthDayMatch[2], 10);
      let hours = 9,
        minutes = 0;
      if (monthDayMatch[3]) {
        const timeTs = parseTimeString(monthDayMatch[3]);
        if (timeTs) {
          hours = timeTs.hours;
          minutes = timeTs.minutes;
        }
      }
      const year = now.getFullYear();
      const target = new Date(year, month, day, hours, minutes, 0, 0);
      // If the date is in the past, use next year
      if (target.getTime() <= now.getTime()) {
        target.setFullYear(year + 1);
      }
      return target.getTime();
    }
  }

  // --- Bare time: "3pm", "3:30pm", "15:00", "9:00 am" ---
  // Snooze to that time today if still in the future, otherwise tomorrow
  const timeTs = parseTimeString(text);
  if (timeTs) {
    const target = new Date(today);
    target.setHours(timeTs.hours, timeTs.minutes, 0, 0);
    if (target.getTime() <= now.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    return target.getTime();
  }

  return null;
}

/**
 * Parse a time string like "3pm", "3:30pm", "15:00", "9:00 am", "3:30 PM"
 */
function parseTimeString(text: string): { hours: number; minutes: number } | null {
  const s = text.trim().toLowerCase();

  // "3pm", "3am", "11pm"
  const simpleMatch = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (simpleMatch) {
    let hours = parseInt(simpleMatch[1], 10);
    const isPm = simpleMatch[2] === "pm";
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    if (hours >= 0 && hours <= 23) return { hours, minutes: 0 };
  }

  // "3:30pm", "3:30 pm", "11:45am"
  const colonAmPm = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (colonAmPm) {
    let hours = parseInt(colonAmPm[1], 10);
    const minutes = parseInt(colonAmPm[2], 10);
    const isPm = colonAmPm[3] === "pm";
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) return { hours, minutes };
  }

  // "15:00", "9:30" (24-hour)
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const hours = parseInt(h24[1], 10);
    const minutes = parseInt(h24[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) return { hours, minutes };
  }

  return null;
}

// ============================================
// Preset options
// ============================================

function getSnoozeOptions(): SnoozeOption[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const laterToday = (): number => {
    const hour = now.getHours();
    if (hour < 14) {
      const target = new Date(today);
      target.setHours(17, 0, 0, 0);
      return target.getTime();
    }
    if (hour < 17) {
      return now.getTime() + 3 * 60 * 60 * 1000;
    }
    const target = new Date(today);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  };

  const tomorrow = (): number => {
    const target = new Date(today);
    target.setDate(target.getDate() + 1);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  };

  const thisWeekend = (): number => {
    const target = new Date(today);
    const dayOfWeek = target.getDay();
    const daysUntilSat = dayOfWeek === 6 ? 7 : 6 - dayOfWeek;
    target.setDate(target.getDate() + daysUntilSat);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  };

  const nextWeek = (): number => {
    const target = new Date(today);
    const dayOfWeek = target.getDay();
    const daysUntilMon = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
    target.setDate(target.getDate() + daysUntilMon);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  };

  const inOneWeek = (): number => {
    const target = new Date(today);
    target.setDate(target.getDate() + 7);
    target.setHours(9, 0, 0, 0);
    return target.getTime();
  };

  const formatDate = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  };

  const formatTime = (ts: number): string => {
    const d = new Date(ts);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  };

  const laterTodayTs = laterToday();
  const tomorrowTs = tomorrow();
  const thisWeekendTs = thisWeekend();
  const nextWeekTs = nextWeek();
  const inOneWeekTs = inOneWeek();

  const options: SnoozeOption[] = [
    {
      label: "Later Today",
      getTime: () => laterTodayTs,
      sublabel: formatTime(laterTodayTs),
    },
    {
      label: "Tomorrow",
      getTime: () => tomorrowTs,
      sublabel: `${formatDate(tomorrowTs)}, 9:00 AM`,
    },
  ];

  const dayOfWeek = now.getDay();
  if (dayOfWeek >= 1 && dayOfWeek <= 5) {
    options.push({
      label: "This Weekend",
      getTime: () => thisWeekendTs,
      sublabel: `${formatDate(thisWeekendTs)}, 9:00 AM`,
    });
  }

  options.push(
    {
      label: "Next Week",
      getTime: () => nextWeekTs,
      sublabel: `${formatDate(nextWeekTs)}, 9:00 AM`,
    },
    {
      label: "In 1 Week",
      getTime: () => inOneWeekTs,
      sublabel: `${formatDate(inOneWeekTs)}, 9:00 AM`,
    },
  );

  return options;
}

// ============================================
// Component
// ============================================

interface SnoozeMenuProps {
  emailId: string;
  threadId: string;
  accountId: string;
  onSnooze: (snoozedEmail: SnoozedEmail) => void;
  onClose: () => void;
}

export function SnoozeMenu({ emailId, threadId, accountId, onSnooze, onClose }: SnoozeMenuProps) {
  const [textInput, setTextInput] = useState("");
  const [parsedTime, setParsedTime] = useState<number | null>(null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [customDate, setCustomDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [customTime, setCustomTime] = useState("09:00");
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = getSnoozeOptions();

  // Focus the text input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Close on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  // Parse text input in real time
  useEffect(() => {
    if (textInput.trim()) {
      setParsedTime(parseSnoozeText(textInput));
    } else {
      setParsedTime(null);
    }
  }, [textInput]);

  // Set default custom date to tomorrow
  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setCustomDate(tomorrow.toISOString().split("T")[0]);
  }, []);

  const handleSnooze = async (snoozeUntil: number) => {
    setError(null);
    const response = (await window.api.snooze.snooze(
      emailId,
      threadId,
      accountId,
      snoozeUntil,
    )) as { success: boolean; data?: SnoozedEmail; error?: string };
    if (response.success && response.data) {
      trackEvent("email_snoozed");
      onSnooze(response.data);
      onClose();
    } else {
      setError(response.error || "Failed to snooze");
    }
  };

  const handleTextSubmit = () => {
    if (parsedTime && parsedTime > Date.now()) {
      handleSnooze(parsedTime);
    }
  };

  const handleCustomDateSnooze = () => {
    if (!customDate) return;
    const [year, month, day] = customDate.split("-").map(Number);
    const [hours, minutes] = customTime.split(":").map(Number);
    const target = new Date(year, month - 1, day, hours, minutes, 0, 0);
    if (target.getTime() <= Date.now()) return;
    handleSnooze(target.getTime());
  };

  return (
    <div
      ref={menuRef}
      className="w-72 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 z-50 overflow-hidden"
    >
      {/* Text input for flexible snooze */}
      <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700">
        <input
          ref={inputRef}
          type="text"
          value={textInput}
          onChange={(e) => setTextInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleTextSubmit();
            }
          }}
          placeholder='e.g. "2 hours", "tomorrow 3pm", "friday"'
          className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded focus:outline-none focus:ring-1 focus:ring-blue-500 placeholder:text-gray-400"
        />
        {textInput.trim() && (
          <div className="mt-1.5 flex items-center justify-between">
            {parsedTime ? (
              <>
                <span className="text-xs text-gray-500 dark:text-gray-400">
                  {formatSnoozeTime(parsedTime)}
                </span>
                <button
                  onClick={handleTextSubmit}
                  className="text-xs font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
                >
                  Snooze
                </button>
              </>
            ) : (
              <span className="text-xs text-red-500 dark:text-red-400">Couldn't parse that</span>
            )}
          </div>
        )}
      </div>

      {/* Error message */}
      {error && (
        <div className="px-3 py-1.5 bg-red-50 dark:bg-red-900/20 border-b border-red-100 dark:border-red-800">
          <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
        </div>
      )}

      {/* Preset options */}
      <div className="py-1">
        {options.map((option) => (
          <button
            key={option.label}
            onClick={() => handleSnooze(option.getTime())}
            className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center justify-between"
          >
            <span className="text-sm text-gray-900 dark:text-gray-100">{option.label}</span>
            {option.sublabel && <span className="text-xs text-gray-400">{option.sublabel}</span>}
          </button>
        ))}
      </div>

      {/* Date picker fallback */}
      <div className="border-t border-gray-100 dark:border-gray-700">
        {!showDatePicker ? (
          <button
            onClick={() => setShowDatePicker(true)}
            className="w-full px-3 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors flex items-center gap-2"
          >
            <svg
              className="w-4 h-4 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
            <span className="text-sm text-gray-900 dark:text-gray-100">Pick date & time</span>
          </button>
        ) : (
          <div className="px-3 py-2 space-y-2">
            <input
              type="date"
              value={customDate}
              onChange={(e) => setCustomDate(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              type="time"
              value={customTime}
              onChange={(e) => setCustomTime(e.target.value)}
              className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handleCustomDateSnooze}
              disabled={!customDate}
              className="w-full px-3 py-1.5 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 rounded hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
            >
              Snooze
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Format snooze time for display (e.g., "Tomorrow, 9:00 AM" or "Mon, Jan 5, 9:00 AM")
 */
export function formatSnoozeTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfterTomorrow = new Date(today);
  dayAfterTomorrow.setDate(dayAfterTomorrow.getDate() + 2);

  const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if (date >= today && date < tomorrow) {
    return `Today, ${timeStr}`;
  }
  if (date >= tomorrow && date < dayAfterTomorrow) {
    return `Tomorrow, ${timeStr}`;
  }

  const dateStr = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
  return `${dateStr}, ${timeStr}`;
}
