import { test, expect } from "@playwright/test";

/**
 * Unit tests for the snooze feature.
 *
 * Tests parseSnoozeText (natural language → timestamp) and formatSnoozeTime
 * (timestamp → display string). These are pure functions with no Electron dependency.
 */

// ---- Copied from SnoozeMenu.tsx (pure functions, no Electron dependency) ----

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

function parseTimeString(text: string): { hours: number; minutes: number } | null {
  const s = text.trim().toLowerCase();
  const simpleMatch = s.match(/^(\d{1,2})\s*(am|pm)$/);
  if (simpleMatch) {
    let hours = parseInt(simpleMatch[1], 10);
    const isPm = simpleMatch[2] === "pm";
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    if (hours >= 0 && hours <= 23) return { hours, minutes: 0 };
  }
  const colonAmPm = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (colonAmPm) {
    let hours = parseInt(colonAmPm[1], 10);
    const minutes = parseInt(colonAmPm[2], 10);
    const isPm = colonAmPm[3] === "pm";
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) return { hours, minutes };
  }
  const h24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (h24) {
    const hours = parseInt(h24[1], 10);
    const minutes = parseInt(h24[2], 10);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) return { hours, minutes };
  }
  return null;
}

function parseSnoozeText(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

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

  const inRelMatch = text.match(
    /^in\s+(\d+)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)$/,
  );
  if (inRelMatch) {
    return parseSnoozeText(`${inRelMatch[1]}${inRelMatch[2]}`);
  }

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
      target.setDate(target.getDate() + diff);
      target.setHours(9, 0, 0, 0);
      return target.getTime();
    }
  }

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
      let year = now.getFullYear();
      const target = new Date(year, month, day, hours, minutes, 0, 0);
      if (target.getTime() <= now.getTime()) {
        target.setFullYear(year + 1);
      }
      return target.getTime();
    }
  }

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

function formatSnoozeTime(timestamp: number): string {
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

// ---- Tests ----

test.describe("parseSnoozeText — relative durations", () => {
  test("parses minutes: '30m'", () => {
    const before = Date.now();
    const result = parseSnoozeText("30m");
    expect(result).not.toBeNull();
    const diff = result! - before;
    // Should be ~30 minutes (±2s tolerance)
    expect(diff).toBeGreaterThan(29 * 60 * 1000);
    expect(diff).toBeLessThan(31 * 60 * 1000);
  });

  test("parses minutes: '5 minutes'", () => {
    const before = Date.now();
    const result = parseSnoozeText("5 minutes");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(4 * 60 * 1000);
    expect(diff).toBeLessThan(6 * 60 * 1000);
  });

  test("parses minutes: '1 min'", () => {
    const before = Date.now();
    const result = parseSnoozeText("1 min");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(55 * 1000);
    expect(diff).toBeLessThan(65 * 1000);
  });

  test("parses hours: '2h'", () => {
    const before = Date.now();
    const result = parseSnoozeText("2h");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(119 * 60 * 1000);
    expect(diff).toBeLessThan(121 * 60 * 1000);
  });

  test("parses hours: '1 hour'", () => {
    const before = Date.now();
    const result = parseSnoozeText("1 hour");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(59 * 60 * 1000);
    expect(diff).toBeLessThan(61 * 60 * 1000);
  });

  test("parses days: '3d'", () => {
    const before = Date.now();
    const result = parseSnoozeText("3d");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(3 * 86400 * 1000 - 2000);
    expect(diff).toBeLessThan(3 * 86400 * 1000 + 2000);
  });

  test("parses days: '2 days'", () => {
    const before = Date.now();
    const result = parseSnoozeText("2 days");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(2 * 86400 * 1000 - 2000);
    expect(diff).toBeLessThan(2 * 86400 * 1000 + 2000);
  });

  test("parses weeks: '1w'", () => {
    const before = Date.now();
    const result = parseSnoozeText("1w");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(7 * 86400 * 1000 - 2000);
    expect(diff).toBeLessThan(7 * 86400 * 1000 + 2000);
  });

  test("parses weeks: '2 weeks'", () => {
    const before = Date.now();
    const result = parseSnoozeText("2 weeks");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(14 * 86400 * 1000 - 2000);
    expect(diff).toBeLessThan(14 * 86400 * 1000 + 2000);
  });

  test("parses seconds: '30s'", () => {
    const before = Date.now();
    const result = parseSnoozeText("30s");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(28 * 1000);
    expect(diff).toBeLessThan(32 * 1000);
  });

  test("parses 'in X ...' format: 'in 2 hours'", () => {
    const before = Date.now();
    const result = parseSnoozeText("in 2 hours");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(119 * 60 * 1000);
    expect(diff).toBeLessThan(121 * 60 * 1000);
  });

  test("parses 'in 30 min'", () => {
    const before = Date.now();
    const result = parseSnoozeText("in 30 min");
    expect(result).not.toBeNull();
    const diff = result! - before;
    expect(diff).toBeGreaterThan(29 * 60 * 1000);
    expect(diff).toBeLessThan(31 * 60 * 1000);
  });
});

test.describe("parseSnoozeText — named keywords", () => {
  test("'tomorrow' returns 9am next day", () => {
    const result = parseSnoozeText("tomorrow");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(d.getDate()).toBe(tomorrow.getDate());
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
  });

  test("'tmrw' works as alias for tomorrow", () => {
    const result = parseSnoozeText("tmrw");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(d.getDate()).toBe(tomorrow.getDate());
    expect(d.getHours()).toBe(9);
  });

  test("'tmr' works as alias for tomorrow", () => {
    const result = parseSnoozeText("tmr");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(d.getDate()).toBe(tomorrow.getDate());
  });

  test("'tomorrow 3pm' returns 3pm next day", () => {
    const result = parseSnoozeText("tomorrow 3pm");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(d.getDate()).toBe(tomorrow.getDate());
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(0);
  });

  test("'tomorrow at 2:30pm' returns 2:30pm next day", () => {
    const result = parseSnoozeText("tomorrow at 2:30pm");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(d.getDate()).toBe(tomorrow.getDate());
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  test("'this weekend' returns Saturday at 9am", () => {
    const result = parseSnoozeText("this weekend");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(6); // Saturday
    expect(d.getHours()).toBe(9);
  });

  test("'next week' returns next Monday at 9am", () => {
    const result = parseSnoozeText("next week");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(1); // Monday
    expect(d.getHours()).toBe(9);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });
});

test.describe("parseSnoozeText — day names", () => {
  test("'monday' returns next Monday at 9am", () => {
    const result = parseSnoozeText("monday");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(9);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  test("'friday' returns next Friday at 9am", () => {
    const result = parseSnoozeText("friday");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(5);
    expect(d.getHours()).toBe(9);
  });

  test("'next friday' returns next Friday at 9am", () => {
    const result = parseSnoozeText("next friday");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(5);
    expect(d.getHours()).toBe(9);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  test("'friday 3pm' returns next Friday at 3pm", () => {
    const result = parseSnoozeText("friday 3pm");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(5);
    expect(d.getHours()).toBe(15);
  });

  test("'next monday at 10:30am' returns next Monday at 10:30am", () => {
    const result = parseSnoozeText("next monday at 10:30am");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getDay()).toBe(1);
    expect(d.getHours()).toBe(10);
    expect(d.getMinutes()).toBe(30);
  });
});

test.describe("parseSnoozeText — month + day", () => {
  test("'jan 15' returns January 15 at 9am", () => {
    const result = parseSnoozeText("jan 15");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(9);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  test("'february 3' returns Feb 3 at 9am", () => {
    const result = parseSnoozeText("february 3");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(3);
    expect(d.getHours()).toBe(9);
  });

  test("'dec 25 at 2pm' returns Dec 25 at 2pm", () => {
    const result = parseSnoozeText("dec 25 at 2pm");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getMonth()).toBe(11);
    expect(d.getDate()).toBe(25);
    expect(d.getHours()).toBe(14);
  });

  test("past month date rolls to next year", () => {
    // Use a date that's definitely in the past
    const now = new Date();
    const pastMonth = now.getMonth() === 0 ? 11 : now.getMonth() - 1;
    const monthNames = [
      "jan",
      "feb",
      "mar",
      "apr",
      "may",
      "jun",
      "jul",
      "aug",
      "sep",
      "oct",
      "nov",
      "dec",
    ];
    const result = parseSnoozeText(`${monthNames[pastMonth]} 1`);
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });
});

test.describe("parseSnoozeText — bare time", () => {
  test("'3pm' returns today or tomorrow at 3pm", () => {
    const result = parseSnoozeText("3pm");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(0);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  test("'9:30am' returns today or tomorrow at 9:30am", () => {
    const result = parseSnoozeText("9:30am");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(30);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  test("'15:00' returns today or tomorrow at 3pm (24h format)", () => {
    const result = parseSnoozeText("15:00");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getHours()).toBe(15);
    expect(d.getMinutes()).toBe(0);
    expect(d.getTime()).toBeGreaterThan(Date.now());
  });

  test("'12am' midnight is handled correctly", () => {
    const result = parseSnoozeText("12am");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getHours()).toBe(0);
  });

  test("'12pm' noon is handled correctly", () => {
    const result = parseSnoozeText("12pm");
    expect(result).not.toBeNull();
    const d = new Date(result!);
    expect(d.getHours()).toBe(12);
  });
});

test.describe("parseSnoozeText — edge cases and invalid input", () => {
  test("empty string returns null", () => {
    expect(parseSnoozeText("")).toBeNull();
  });

  test("whitespace returns null", () => {
    expect(parseSnoozeText("   ")).toBeNull();
  });

  test("gibberish returns null", () => {
    expect(parseSnoozeText("asdfghjkl")).toBeNull();
  });

  test("'0m' still returns null (0ms offset is not future)", () => {
    // 0 minutes should produce ms=0, and the guard `if (ms > 0)` prevents it
    const result = parseSnoozeText("0m");
    expect(result).toBeNull();
  });

  test("all results are in the future", () => {
    const inputs = ["1m", "30m", "2h", "1d", "1w", "tomorrow", "next week"];
    for (const input of inputs) {
      const result = parseSnoozeText(input);
      expect(result).not.toBeNull();
      expect(result!).toBeGreaterThan(Date.now() - 1000); // allow 1s clock drift
    }
  });

  test("case insensitive", () => {
    const lower = parseSnoozeText("tomorrow");
    const upper = parseSnoozeText("TOMORROW");
    expect(lower).not.toBeNull();
    expect(upper).not.toBeNull();
    expect(lower).toBe(upper);
  });

  test("trims whitespace", () => {
    const trimmed = parseSnoozeText("  2h  ");
    const normal = parseSnoozeText("2h");
    // Allow 50ms tolerance for timestamp race between two Date.now() calls
    expect(Math.abs(trimmed! - normal!)).toBeLessThanOrEqual(50);
  });
});

test.describe("formatSnoozeTime", () => {
  test("formats today's time as 'Today, ...'", () => {
    const now = new Date();
    const laterToday = new Date(now);
    laterToday.setHours(23, 59, 0, 0); // end of today
    if (laterToday.getTime() > now.getTime()) {
      const result = formatSnoozeTime(laterToday.getTime());
      expect(result).toMatch(/^Today,/);
    }
  });

  test("formats tomorrow as 'Tomorrow, ...'", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const result = formatSnoozeTime(tomorrow.getTime());
    expect(result).toMatch(/^Tomorrow,/);
  });

  test("formats later dates with weekday and month", () => {
    const nextWeek = new Date();
    nextWeek.setDate(nextWeek.getDate() + 7);
    nextWeek.setHours(9, 0, 0, 0);
    const result = formatSnoozeTime(nextWeek.getTime());
    // Should NOT start with Today or Tomorrow
    expect(result).not.toMatch(/^Today/);
    expect(result).not.toMatch(/^Tomorrow/);
    // Should contain a comma (date, time)
    expect(result).toContain(",");
  });
});
