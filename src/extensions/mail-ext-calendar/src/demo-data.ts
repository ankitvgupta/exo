/**
 * Demo/mock calendar data for testing without Google Calendar API access.
 */
import { extractDatesFromEmail, type ExtractedDate } from "./date-extractor";
import type { CalendarEvent } from "./google-calendar-client";

interface CalendarEnrichmentData {
  dates: ExtractedDate[];
  events: Record<string, CalendarEvent[]>;
  hasCalendarAccess: boolean;
}

// Sample events to sprinkle across dates
const SAMPLE_EVENTS = [
  { summary: "Team Standup", durationMin: 30, startHour: 10 },
  { summary: "Lunch", durationMin: 60, startHour: 12 },
  { summary: "Design Review", durationMin: 60, startHour: 14 },
  { summary: "1:1 with Manager", durationMin: 30, startHour: 15 },
  { summary: "Sprint Planning", durationMin: 90, startHour: 9 },
  { summary: "Coffee Chat", durationMin: 30, startHour: 11 },
  { summary: "Eng All-Hands", durationMin: 60, startHour: 16 },
  { summary: "Product Sync", durationMin: 45, startHour: 13 },
];

function generateEventsForDate(dateStr: string): CalendarEvent[] {
  // Use date string as seed for deterministic but varied events
  const seed = dateStr.split("-").reduce((a, b) => a + parseInt(b, 10), 0);
  const numEvents = 2 + (seed % 4); // 2-5 events per day
  const events: CalendarEvent[] = [];

  for (let i = 0; i < numEvents && i < SAMPLE_EVENTS.length; i++) {
    const template = SAMPLE_EVENTS[(seed + i) % SAMPLE_EVENTS.length];
    const startHour = template.startHour + (i % 2); // Slight variation
    const start = new Date(`${dateStr}T${String(startHour).padStart(2, "0")}:00:00`);
    const end = new Date(start.getTime() + template.durationMin * 60 * 1000);

    events.push({
      id: `demo-${dateStr}-${i}`,
      summary: template.summary,
      start: start.toISOString(),
      end: end.toISOString(),
      isAllDay: false,
      calendarName: "Work",
      calendarColor: "#4285f4",
      status: "confirmed",
    });
  }

  // Sort by start time
  events.sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  return events;
}

/**
 * Generate demo calendar data by extracting dates from the email body
 * and generating fake events for those dates.
 */
export function generateDemoCalendarData(
  emailBody: string,
  emailDate: string,
): CalendarEnrichmentData | null {
  const dates = extractDatesFromEmail(emailBody, emailDate);

  // If no dates found in body, generate a date based on email date
  // so the panel always has something to show in demo mode
  if (dates.length === 0) {
    const refDate = new Date(emailDate);
    const tomorrow = new Date(refDate);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().split("T")[0];

    dates.push({
      date: tomorrowStr,
      label: "tomorrow",
      confidence: 0.5,
    });
  }

  const events: Record<string, CalendarEvent[]> = {};
  for (const d of dates) {
    events[d.date] = generateEventsForDate(d.date);
  }

  return {
    dates,
    events,
    hasCalendarAccess: true,
  };
}
