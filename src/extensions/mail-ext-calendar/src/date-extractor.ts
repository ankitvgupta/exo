/**
 * Date extraction from email body text.
 * Uses regex patterns to find explicit and relative date references,
 * resolving them against the email's sent date.
 */

export interface ExtractedDate {
  date: string; // ISO date string YYYY-MM-DD
  label: string; // Human-readable label: "Feb 3", "next Tuesday"
  confidence: number; // 0-1
}

const MONTHS: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const DAYS_OF_WEEK: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function toISODate(d: Date): string {
  return d.toISOString().split("T")[0];
}

function formatLabel(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/**
 * Strip HTML tags from email body to get plain text
 */
function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extract dates from email body text using regex patterns.
 * @param body - The email body (may contain HTML)
 * @param emailDate - The email's sent date (ISO string), used to resolve relative references
 */
export function extractDatesFromEmail(body: string, emailDate: string): ExtractedDate[] {
  const text = stripHtml(body);
  const refDate = new Date(emailDate);
  const found: Map<string, ExtractedDate> = new Map();

  function addDate(date: Date, label: string, confidence: number) {
    const iso = toISODate(date);
    // Keep highest confidence for duplicate dates
    if (!found.has(iso) || (found.get(iso)!.confidence < confidence)) {
      found.set(iso, { date: iso, label: label || formatLabel(date), confidence });
    }
  }

  // Pattern 1: "Month Day, Year" or "Month Day Year" — e.g., "February 3, 2025", "Feb 3 2025"
  const monthDayYear = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(\d{4})\b/gi;
  for (const m of text.matchAll(monthDayYear)) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (month !== undefined && day >= 1 && day <= 31) {
      addDate(new Date(year, month, day), `${m[1]} ${m[2]}, ${m[3]}`, 0.95);
    }
  }

  // Pattern 2: "Month Day" without year — e.g., "February 3rd", "Feb 3"
  const monthDay = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*,?\s*\d{4})/gi;
  for (const m of text.matchAll(monthDay)) {
    const month = MONTHS[m[1].toLowerCase()];
    const day = parseInt(m[2], 10);
    if (month !== undefined && day >= 1 && day <= 31) {
      // Assume same year as email, or next year if the date is in the past
      let year = refDate.getFullYear();
      const candidate = new Date(year, month, day);
      if (candidate.getTime() < refDate.getTime() - 30 * 24 * 60 * 60 * 1000) {
        year += 1;
      }
      addDate(new Date(year, month, day), `${m[1]} ${m[2]}`, 0.85);
    }
  }

  // Pattern 3: "MM/DD/YYYY" or "MM-DD-YYYY"
  const slashDate = /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})\b/g;
  for (const m of text.matchAll(slashDate)) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31 && year >= 2020 && year <= 2030) {
      addDate(new Date(year, month, day), formatLabel(new Date(year, month, day)), 0.9);
    }
  }

  // Pattern 4: "MM/DD" without year
  const slashDateShort = /\b(\d{1,2})[\/](\d{1,2})\b(?![\/\-]\d)/g;
  for (const m of text.matchAll(slashDateShort)) {
    const month = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      let year = refDate.getFullYear();
      const candidate = new Date(year, month, day);
      if (candidate.getTime() < refDate.getTime() - 30 * 24 * 60 * 60 * 1000) {
        year += 1;
      }
      addDate(new Date(year, month, day), formatLabel(new Date(year, month, day)), 0.7);
    }
  }

  // Pattern 5: Relative dates — "tomorrow", "today"
  const todayMatch = /\btoday\b/i;
  if (todayMatch.test(text)) {
    addDate(refDate, "today", 0.9);
  }

  const tomorrowMatch = /\btomorrow\b/i;
  if (tomorrowMatch.test(text)) {
    const d = new Date(refDate);
    d.setDate(d.getDate() + 1);
    addDate(d, "tomorrow", 0.9);
  }

  // Pattern 6: "next Monday", "this Friday", etc.
  const dayRef = /\b(next|this|coming)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|wed|thu|fri|sat)\b/gi;
  for (const m of text.matchAll(dayRef)) {
    const modifier = m[1].toLowerCase();
    const targetDay = DAYS_OF_WEEK[m[2].toLowerCase()];
    if (targetDay !== undefined) {
      const d = new Date(refDate);
      const currentDay = d.getDay();
      let daysAhead = targetDay - currentDay;
      if (modifier === "next") {
        // "next" always means the coming week
        daysAhead = daysAhead <= 0 ? daysAhead + 7 : daysAhead;
        if (daysAhead <= 0) daysAhead += 7;
      } else {
        // "this" means current week
        if (daysAhead <= 0) daysAhead += 7;
      }
      d.setDate(d.getDate() + daysAhead);
      addDate(d, `${m[1]} ${m[2]}`, 0.8);
    }
  }

  // Pattern 7: Standalone day names — "on Monday", "by Wednesday"
  const standaloneDay = /\b(?:on|by|before|after|until)\s+(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi;
  for (const m of text.matchAll(standaloneDay)) {
    const targetDay = DAYS_OF_WEEK[m[1].toLowerCase()];
    if (targetDay !== undefined) {
      const d = new Date(refDate);
      const currentDay = d.getDay();
      let daysAhead = targetDay - currentDay;
      if (daysAhead <= 0) daysAhead += 7;
      d.setDate(d.getDate() + daysAhead);
      addDate(d, m[1], 0.6);
    }
  }

  // Sort by date, then by confidence
  return [...found.values()]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 10); // Cap at 10 dates
}
