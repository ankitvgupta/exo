import { ipcMain, BrowserWindow } from "electron";
import { findAllCalendarAccounts } from "../../extensions/mail-ext-calendar/src/google-calendar-client";
import { getCalendarEventsForDate, getAllCalendarSyncStates, setCalendarVisibility, getAccounts, type CalendarEventRow } from "../db";
import { calendarSyncService } from "../services/calendar-sync";

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

export function registerCalendarIpc(): void {
  // Read events from local DB — instant response
  ipcMain.handle(
    "calendar:get-events",
    async (_event, { date }: { date: string }) => {
      try {
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
        console.error("[Calendar IPC] Failed to fetch events:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
          events: [],
          hasCalendarAccess: false,
        };
      }
    }
  );

  // Get all calendars with visibility info (for settings UI)
  ipcMain.handle("calendar:get-calendars", async () => {
    try {
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
      console.error("[Calendar IPC] Failed to get calendars:", error);
      return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
  });

  // Toggle calendar visibility
  ipcMain.handle(
    "calendar:set-visibility",
    async (_event, { accountId, calendarId, visible }: { accountId: string; calendarId: string; visible: boolean }) => {
      try {
        setCalendarVisibility(accountId, calendarId, visible);
        // Notify renderer so sidebar updates immediately
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("calendar:events-updated");
        }
        return { success: true };
      } catch (error) {
        console.error("[Calendar IPC] Failed to set visibility:", error);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  ipcMain.handle("calendar:check-access", async () => {
    try {
      const accountIds = await findAllCalendarAccounts();
      return { hasAccess: accountIds.length > 0 };
    } catch {
      return { hasAccess: false };
    }
  });

  // Push updates to renderer when background sync finds changes
  calendarSyncService.onEventsUpdated(() => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("calendar:events-updated");
    }
  });

  // Start background calendar sync
  calendarSyncService.startSync().catch((err) => {
    console.error("[Calendar IPC] Failed to start calendar sync:", err);
  });
}
