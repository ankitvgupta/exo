import { ipcMain, BrowserWindow } from "electron";
import {
  findAllCalendarAccounts,
  getCalendarList,
  insertCalendarEvent,
} from "../../extensions/mail-ext-calendar/src/google-calendar-client";
import {
  getCalendarEventsForDate,
  getAllCalendarSyncStates,
  setCalendarVisibility,
  getAccounts,
  getEmail,
  getEmailsByThread,
  saveCalendarEvents,
  type CalendarEventRow,
} from "../db";
import { calendarSyncService } from "../services/calendar-sync";
import {
  buildCalendarEventInsertParams,
  buildDemoCalendarInviteDraft,
  extractCalendarInviteDraft,
  validateCalendarInviteDraft,
} from "../services/calendar-invite";
import { createLogger } from "../services/logger";
import {
  CalendarInviteDraftSchema,
  type CalendarInviteCalendarOption,
  type CalendarInviteDraft,
} from "../../shared/types";
import { isoDateMatchesCalendarDate } from "../../shared/calendar-date";

const log = createLogger("calendar-ipc");
const useDemoCalendar = process.env.EXO_DEMO_MODE === "true" || process.env.EXO_TEST_MODE === "true";

type CalendarEventResponse = ReturnType<typeof rowsToEvents>[number];

const demoCreatedEvents: CalendarEventResponse[] = [];

/** Map DB rows to the shape the renderer expects. */
function rowsToEvents(rows: CalendarEventRow[]) {
  return rows.map((r) => ({
    id: r.id,
    summary: r.summary,
    start: r.startTime,
    end: r.endTime,
    isAllDay: r.isAllDay,
    calendarName: r.calendarName,
    calendarColor: r.calendarColor,
    status: r.status,
    location: r.location,
    htmlLink: r.htmlLink,
  }));
}

function broadcastCalendarUpdated(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("calendar:events-updated");
  }
}

function demoIso(date: string, hour: number, minute = 0): string {
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return new Date(`${date}T${hh}:${mm}:00`).toISOString();
}

function demoEventsForDate(date: string): CalendarEventResponse[] {
  const sample: CalendarEventResponse[] = [
    {
      id: `demo-cal-${date}-focus`,
      summary: "Focus block",
      start: demoIso(date, 10),
      end: demoIso(date, 11),
      isAllDay: false,
      calendarName: "Demo Calendar",
      calendarColor: "#2563eb",
      status: "confirmed",
      location: undefined,
      htmlLink: undefined,
    },
    {
      id: `demo-cal-${date}-sync`,
      summary: "Product sync",
      start: demoIso(date, 15),
      end: demoIso(date, 16),
      isAllDay: false,
      calendarName: "Demo Calendar",
      calendarColor: "#2563eb",
      status: "confirmed",
      location: undefined,
      htmlLink: undefined,
    },
  ];
  return [
    ...sample,
    ...demoCreatedEvents.filter((event) => isoDateMatchesCalendarDate(event.start, date)),
  ].sort((a, b) => a.start.localeCompare(b.start));
}

function demoCalendarOptions(): CalendarInviteCalendarOption[] {
  return [
    {
      accountId: "demo",
      accountEmail: "demo@example.com",
      calendarId: "primary",
      calendarName: "Demo Calendar",
      calendarColor: "#2563eb",
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
      writable: true,
      primary: true,
    },
  ];
}

async function getInviteCalendarOptions(): Promise<CalendarInviteCalendarOption[]> {
  if (useDemoCalendar) return demoCalendarOptions();

  const accountIds = await findAllCalendarAccounts();
  const accounts = getAccounts();
  const accountEmails = new Map(accounts.map((account) => [account.id, account.email]));

  const optionGroups = await Promise.all(
    accountIds.map(async (accountId) => {
      const calendars = await getCalendarList(accountId);
      return calendars.map((calendar) => ({
        accountId,
        accountEmail: accountEmails.get(accountId) ?? accountId,
        calendarId: calendar.id,
        calendarName: calendar.name,
        calendarColor: calendar.color,
        timezone: calendar.timezone,
        writable: calendar.writable,
        primary: calendar.primary,
      }));
    }),
  );

  return optionGroups.flat();
}

function createdEventToRow(
  accountId: string,
  calendarId: string,
  calendarName: string,
  calendarColor: string,
  event: CalendarEventResponse,
): CalendarEventRow {
  return {
    id: event.id,
    accountId,
    calendarId,
    summary: event.summary,
    startTime: event.start,
    endTime: event.end,
    isAllDay: event.isAllDay,
    calendarName,
    calendarColor,
    status: event.status,
    location: event.location,
    htmlLink: event.htmlLink,
  };
}

function draftToDemoEvent(draft: CalendarInviteDraft): CalendarEventResponse {
  return {
    id: `demo-invite-${Date.now()}`,
    summary: draft.title,
    start: draft.start,
    end: draft.end,
    isAllDay: false,
    calendarName: "Demo Calendar",
    calendarColor: "#f59e0b",
    status: "confirmed",
    location: draft.location || undefined,
    htmlLink: undefined,
  };
}

export function registerCalendarIpc(): void {
  // Read events from local DB — instant response
  ipcMain.handle("calendar:get-events", async (_event, { date }: { date: string }) => {
    try {
      if (useDemoCalendar) {
        return {
          success: true,
          events: demoEventsForDate(date),
          hasCalendarAccess: true,
          hasSynced: true,
        };
      }

      const accountIds = await findAllCalendarAccounts();
      if (accountIds.length === 0) {
        return { success: true, events: [], hasCalendarAccess: false };
      }

      const syncStates = getAllCalendarSyncStates();
      const hasSynced = syncStates.length > 0;
      const rows = getCalendarEventsForDate(date);
      // Filter to only events from accounts that currently have calendar scope
      const accountSet = new Set(accountIds);
      const filtered = rows.filter((r) => accountSet.has(r.accountId));
      return { success: true, events: rowsToEvents(filtered), hasCalendarAccess: true, hasSynced };
    } catch (error) {
      log.error({ err: error }, "[Calendar IPC] Failed to fetch events");
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
        events: [],
        hasCalendarAccess: false,
      };
    }
  });

  // Get all calendars with visibility info (for settings UI)
  ipcMain.handle("calendar:get-calendars", async () => {
    try {
      if (useDemoCalendar) {
        const calendars = demoCalendarOptions();
        return {
          success: true,
          calendars: calendars.map((calendar) => ({
            accountId: calendar.accountId,
            calendarId: calendar.calendarId,
            calendarName: calendar.calendarName,
            calendarColor: calendar.calendarColor,
            visible: true,
          })),
          accountEmails: { demo: "demo@example.com" },
        };
      }

      const syncStates = getAllCalendarSyncStates();
      const accounts = getAccounts();
      const accountMap: Record<string, string> = {};
      for (const a of accounts) {
        accountMap[a.id] = a.email;
      }
      return {
        success: true,
        calendars: syncStates.map((s) => ({
          accountId: s.accountId,
          calendarId: s.calendarId,
          calendarName: s.calendarName,
          calendarColor: s.calendarColor,
          visible: s.visible,
        })),
        accountEmails: accountMap,
      };
    } catch (error) {
      log.error({ err: error }, "[Calendar IPC] Failed to get calendars");
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });

  // Toggle calendar visibility
  ipcMain.handle(
    "calendar:set-visibility",
    async (
      _event,
      {
        accountId,
        calendarId,
        visible,
      }: { accountId: string; calendarId: string; visible: boolean },
    ) => {
      try {
        if (useDemoCalendar) {
          broadcastCalendarUpdated();
          return { success: true };
        }

        setCalendarVisibility(accountId, calendarId, visible);
        // Notify renderer so sidebar updates immediately
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("calendar:events-updated");
        }
        return { success: true };
      } catch (error) {
        log.error({ err: error }, "[Calendar IPC] Failed to set visibility");
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  ipcMain.handle("calendar:check-access", async () => {
    try {
      if (useDemoCalendar) {
        return { hasAccess: true };
      }

      const accountIds = await findAllCalendarAccounts();
      return { hasAccess: accountIds.length > 0 };
    } catch {
      return { hasAccess: false };
    }
  });

  ipcMain.handle("calendar:get-invite-options", async () => {
    try {
      const calendars = await getInviteCalendarOptions();
      const hasWriteAccess = calendars.some((calendar) => calendar.writable);
      return {
        success: true,
        calendars,
        hasCalendarAccess: calendars.length > 0,
        hasWriteAccess,
        requiresReauth: calendars.length > 0 && !hasWriteAccess,
      };
    } catch (error) {
      log.error({ err: error }, "[Calendar IPC] Failed to get invite options");
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });

  ipcMain.handle("calendar:extract-invite", async (_event, { emailId }: { emailId: string }) => {
    try {
      const email = getEmail(emailId);
      if (!email) {
        return { success: false, error: "Email not found" };
      }

      const threadEmails = getEmailsByThread(email.threadId, email.accountId);
      const calendars = await getInviteCalendarOptions();
      const hasWriteAccess = calendars.some((calendar) => calendar.writable);
      const draft = useDemoCalendar
        ? buildDemoCalendarInviteDraft(threadEmails, calendars)
        : await extractCalendarInviteDraft(threadEmails, calendars, undefined, {
            emailId: email.id,
            accountId: email.accountId,
          });

      return {
        success: true,
        draft,
        calendars,
        hasCalendarAccess: calendars.length > 0,
        hasWriteAccess,
        requiresReauth: calendars.length > 0 && !hasWriteAccess,
      };
    } catch (error) {
      log.error({ err: error }, "[Calendar IPC] Failed to extract invite");
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });

  ipcMain.handle(
    "calendar:create-invite",
    async (_event, { accountId, draft }: { accountId: string; draft: unknown }) => {
      try {
        const parsed = CalendarInviteDraftSchema.safeParse(draft);
        if (!parsed.success) {
          return { success: false, error: "Invalid invite draft" };
        }

        const validationErrors = validateCalendarInviteDraft(parsed.data);
        if (validationErrors.length > 0) {
          return { success: false, error: validationErrors[0], validationErrors };
        }

        const params = buildCalendarEventInsertParams(parsed.data);
        if (useDemoCalendar) {
          const event = draftToDemoEvent(parsed.data);
          demoCreatedEvents.push(event);
          broadcastCalendarUpdated();
          return { success: true, event };
        }

        const calendars = await getInviteCalendarOptions();
        const selectedCalendar = calendars.find(
          (calendar) =>
            calendar.accountId === accountId && calendar.calendarId === parsed.data.calendarId,
        );
        if (!selectedCalendar?.writable) {
          return {
            success: false,
            error: "Calendar write permission required. Re-authenticate Google Calendar.",
            requiresReauth: true,
          };
        }

        const event = await insertCalendarEvent(accountId, params, {
          name: selectedCalendar.calendarName,
          color: selectedCalendar.calendarColor,
        });
        const responseEvent: CalendarEventResponse = {
          id: event.id,
          summary: event.summary,
          start: event.start,
          end: event.end,
          isAllDay: event.isAllDay,
          calendarName: event.calendarName,
          calendarColor: event.calendarColor,
          status: event.status,
          location: event.location,
          htmlLink: event.htmlLink,
        };

        saveCalendarEvents([
          createdEventToRow(
            accountId,
            parsed.data.calendarId,
            selectedCalendar.calendarName,
            selectedCalendar.calendarColor,
            responseEvent,
          ),
        ]);
        calendarSyncService.syncNow();
        broadcastCalendarUpdated();
        return { success: true, event: responseEvent };
      } catch (error) {
        log.error({ err: error }, "[Calendar IPC] Failed to create invite");
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    },
  );

  // Push updates to renderer when background sync finds changes
  calendarSyncService.onEventsUpdated(() => {
    broadcastCalendarUpdated();
  });

  if (!useDemoCalendar) {
    // Start background calendar sync
    calendarSyncService.startSync().catch((err) => {
      log.error({ err: err }, "[Calendar IPC] Failed to start calendar sync");
    });
  } else {
    log.info("[Calendar IPC] Demo/test mode - skipping background calendar sync");
  }
}
