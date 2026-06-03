export type CalendarDateMatchOptions = {
  timeZone?: string;
};

export function dateStringInTimeZone(date: Date, timeZone: string): string {
  if (!Number.isFinite(date.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  let year = "";
  let month = "";
  let day = "";
  for (const part of parts) {
    if (part.type === "year") year = part.value;
    if (part.type === "month") month = part.value;
    if (part.type === "day") day = part.value;
  }

  if (!year || !month || !day) return "";
  return `${year}-${month}-${day}`;
}

export function isoDateMatchesCalendarDate(
  isoStr: string,
  calendarDate: string,
  options: CalendarDateMatchOptions = {},
): boolean {
  if (!isoStr || !calendarDate) return false;

  const date = new Date(isoStr);
  const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  return dateStringInTimeZone(date, timeZone) === calendarDate;
}
