/**
 * Calendar sync service — mirrors email-sync.ts pattern.
 * Keeps SQLite in sync with Google Calendar using syncToken for incremental updates.
 */
import {
  findAllCalendarAccounts,
  getCalendarList,
  syncCalendarEvents,
  invalidateCalendarAccountCache,
} from "../../extensions/mail-ext-calendar/src/google-calendar-client";
import {
  saveCalendarEvents,
  deleteCalendarEvent,
  getCalendarSyncState,
  saveCalendarSyncState,
  getCalendarSyncStates,
  clearSingleCalendarData,
  getAccounts,
  type CalendarEventRow,
} from "../db";

const SYNC_INTERVAL = 60_000; // 60 seconds

type EventsUpdatedCallback = () => void;

class CalendarSyncService {
  private intervalId: NodeJS.Timeout | null = null;
  private syncing = false;
  private onEventsUpdatedCallbacks: EventsUpdatedCallback[] = [];

  /**
   * Start background sync for all calendar-scoped accounts.
   * Safe to call multiple times — only starts one interval.
   */
  async startSync(): Promise<void> {
    if (this.intervalId) return;

    console.log("[CalendarSync] Starting calendar sync");
    // Do initial sync immediately
    await this.syncAll();

    // Set up periodic sync
    this.intervalId = setInterval(() => {
      this.syncAll().catch((err) => {
        console.error("[CalendarSync] Periodic sync failed:", err);
      });
    }, SYNC_INTERVAL);
  }

  stopSync(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /** Trigger an immediate sync (e.g. after a new account is added). */
  syncNow(): void {
    // Clear the account-discovery cache so new accounts are found immediately
    invalidateCalendarAccountCache();
    this.syncAll().catch((err) => {
      console.error("[CalendarSync] syncNow failed:", err);
    });
  }

  onEventsUpdated(callback: EventsUpdatedCallback): void {
    this.onEventsUpdatedCallbacks.push(callback);
  }

  private notifyEventsUpdated(): void {
    for (const cb of this.onEventsUpdatedCallbacks) {
      try {
        cb();
      } catch (err) {
        console.error("[CalendarSync] Callback error:", err);
      }
    }
  }

  private async syncAll(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      const accountIds = await findAllCalendarAccounts();
      if (accountIds.length === 0) {
        return;
      }

      let anyChanges = false;
      for (const accountId of accountIds) {
        const changed = await this.syncAccount(accountId);
        if (changed) anyChanges = true;
      }

      if (anyChanges) {
        this.notifyEventsUpdated();
      }
    } catch (err) {
      console.error("[CalendarSync] syncAll failed:", err);
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Sync all calendars for a single account.
   * Returns true if any events were added/removed/updated.
   */
  private async syncAccount(accountId: string): Promise<boolean> {
    let anyChanges = false;

    try {
      // Get the list of calendars for this account
      const calendars = await getCalendarList(accountId);
      if (calendars.length === 0) return false;

      for (const cal of calendars) {
        const changed = await this.syncCalendar(accountId, cal.id, cal.name, cal.color);
        if (changed) anyChanges = true;
      }
    } catch (err) {
      console.error(`[CalendarSync] Failed to sync account ${accountId}:`, err);
    }

    return anyChanges;
  }

  /**
   * Sync a single calendar. Uses syncToken if available; full sync otherwise.
   * Handles 410 GONE by clearing and doing a full re-sync.
   */
  private async syncCalendar(
    accountId: string,
    calendarId: string,
    calendarName: string,
    calendarColor: string
  ): Promise<boolean> {
    const syncState = getCalendarSyncState(accountId, calendarId);
    const syncToken = syncState?.syncToken || null;

    const isIncremental = syncToken !== null;
    const logPrefix = `[CalendarSync] ${calendarName} (${accountId})`;

    try {
      const result = await syncCalendarEvents(
        accountId, calendarId, calendarName, calendarColor, syncToken
      );

      // Handle 410 GONE — clear only this calendar and do full sync
      if (result.fullSyncRequired) {
        console.log(`${logPrefix}: clearing data for full re-sync`);
        clearSingleCalendarData(accountId, calendarId);
        return this.syncCalendar(accountId, calendarId, calendarName, calendarColor);
      }

      let changed = false;

      // Process deleted events
      if (result.deletedIds.length > 0) {
        for (const id of result.deletedIds) {
          deleteCalendarEvent(id, accountId);
        }
        changed = true;
        console.log(`${logPrefix}: deleted ${result.deletedIds.length} events`);
      }

      // Process new/updated events
      if (result.events.length > 0) {
        const rows: CalendarEventRow[] = result.events.map((e) => ({
          id: e.id,
          accountId,
          calendarId,
          summary: e.summary,
          startTime: e.start,
          endTime: e.end,
          isAllDay: e.isAllDay,
          calendarName: e.calendarName,
          calendarColor: e.calendarColor,
          status: e.status,
          location: e.location,
          htmlLink: e.htmlLink,
        }));
        saveCalendarEvents(rows);
        changed = true;

        if (isIncremental) {
          console.log(`${logPrefix}: updated ${result.events.length} events (incremental)`);
        } else {
          console.log(`${logPrefix}: synced ${result.events.length} events (full sync)`);
        }
      }

      // Always save sync state so calendar metadata (name, color, visibility) is persisted.
      // nextSyncToken may be null when Google returns a bounded full sync (with timeMin/timeMax).
      // For new calendars (no existing sync state), set default visibility:
      // only the primary calendar (calendarId === account email) is visible.
      let defaultVisible: boolean | undefined;
      if (!syncState) {
        const accounts = getAccounts();
        const account = accounts.find((a) => a.id === accountId);
        defaultVisible = account ? calendarId === account.email : true;
      }
      saveCalendarSyncState(
        accountId, calendarId, result.nextSyncToken, calendarName, calendarColor, defaultVisible
      );

      return changed;
    } catch (err) {
      console.error(`${logPrefix}: sync failed:`, err);
      return false;
    }
  }
}

export const calendarSyncService = new CalendarSyncService();
