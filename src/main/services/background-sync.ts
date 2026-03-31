import { BrowserWindow } from "electron";
import { type GmailClient } from "./gmail-client";
import { getAllEmailIds, saveEmail } from "../db";
import { createLogger } from "./logger";

const log = createLogger("background-sync");

export type BackgroundSyncProgress = {
  accountId: string;
  status: "idle" | "running" | "completed" | "error";
  synced: number;
  total: number;
  error?: string;
};

type AccountSyncState = {
  isRunning: boolean;
  syncedCount: number;
  totalCount: number;
  lastError?: string;
};

class BackgroundSyncService {
  private accountStates: Map<string, AccountSyncState> = new Map();

  /**
   * Start background sync of all mail for an account.
   * This syncs emails outside INBOX (sent, archived, etc.) to enable local search.
   */
  async startAllMailSync(accountId: string, client: GmailClient): Promise<void> {
    const existingState = this.accountStates.get(accountId);
    if (existingState?.isRunning) {
      log.info(`[BackgroundSync] Already running for ${accountId}`);
      return;
    }

    const state: AccountSyncState = {
      isRunning: true,
      syncedCount: 0,
      totalCount: 0,
    };
    this.accountStates.set(accountId, state);

    log.info(`[BackgroundSync] Starting all-mail sync for ${accountId}`);
    this.emitProgress(accountId, "running", 0, 0);

    try {
      // Get all mail IDs (excluding trash/spam)
      // Use searchAllEmails with pagination for large mailboxes
      log.info("[BackgroundSync] Fetching all mail IDs...");
      const allMailResults = await client.searchAllEmails(
        "in:anywhere -in:trash -in:spam",
        10000, // max emails to sync
      );
      log.info(`[BackgroundSync] Found ${allMailResults.length} total emails in account`);

      // Filter out already-synced emails
      const existingIds = new Set(getAllEmailIds(accountId));
      const toSync = allMailResults.filter((m) => !existingIds.has(m.id));
      log.info(
        `[BackgroundSync] ${toSync.length} emails need syncing (${existingIds.size} already synced)`,
      );

      state.totalCount = toSync.length;
      this.emitProgress(accountId, "running", 0, toSync.length);

      if (toSync.length === 0) {
        log.info("[BackgroundSync] All emails already synced");
        state.isRunning = false;
        this.emitProgress(accountId, "completed", 0, 0);
        return;
      }

      // Sync in batches
      const BATCH_SIZE = 50;
      const BATCH_DELAY_MS = 500;

      for (let i = 0; i < toSync.length; i += BATCH_SIZE) {
        if (!state.isRunning) {
          log.info("[BackgroundSync] Sync stopped by user");
          break;
        }

        const batch = toSync.slice(i, i + BATCH_SIZE);
        await this.syncBatch(accountId, client, batch);
        state.syncedCount += batch.length;

        this.emitProgress(accountId, "running", state.syncedCount, state.totalCount);

        // Log progress
        if (state.syncedCount % 100 === 0 || state.syncedCount === state.totalCount) {
          log.info(`[BackgroundSync] Progress: ${state.syncedCount}/${state.totalCount}`);
        }

        // Small delay between batches to avoid rate limits
        if (i + BATCH_SIZE < toSync.length) {
          await this.sleep(BATCH_DELAY_MS);
        }
      }

      log.info(`[BackgroundSync] Completed for ${accountId}: synced ${state.syncedCount} emails`);
      state.isRunning = false;
      this.emitProgress(accountId, "completed", state.syncedCount, state.totalCount);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      log.error({ err: errorMsg }, `[BackgroundSync] Error for ${accountId}`);
      state.isRunning = false;
      state.lastError = errorMsg;
      this.emitProgress(accountId, "error", state.syncedCount, state.totalCount, errorMsg);
    }
  }

  /**
   * Sync a batch of emails by their IDs
   */
  private async syncBatch(
    accountId: string,
    client: GmailClient,
    batch: Array<{ id: string; threadId: string }>,
  ): Promise<void> {
    for (const { id } of batch) {
      try {
        const email = await client.readEmail(id);
        if (email) {
          saveEmail(email, accountId);
        }
      } catch (err) {
        // Log but don't fail the entire batch
        log.error({ err: err }, `[BackgroundSync] Failed to fetch email ${id}`);
      }
    }
  }

  /**
   * Stop background sync for an account
   */
  stopSync(accountId: string): void {
    const state = this.accountStates.get(accountId);
    if (state) {
      state.isRunning = false;
      log.info(`[BackgroundSync] Stopping sync for ${accountId}`);
    }
  }

  /**
   * Get sync progress for an account
   */
  getProgress(accountId: string): BackgroundSyncProgress {
    const state = this.accountStates.get(accountId);
    if (!state) {
      return { accountId, status: "idle", synced: 0, total: 0 };
    }
    return {
      accountId,
      status: state.isRunning ? "running" : state.lastError ? "error" : "completed",
      synced: state.syncedCount,
      total: state.totalCount,
      error: state.lastError,
    };
  }

  /**
   * Check if sync is running for an account
   */
  isRunning(accountId: string): boolean {
    return this.accountStates.get(accountId)?.isRunning ?? false;
  }

  /**
   * Emit progress event to the renderer
   */
  private emitProgress(
    accountId: string,
    status: BackgroundSyncProgress["status"],
    synced: number,
    total: number,
    error?: string,
  ): void {
    const window = this.getMainWindow();
    if (window) {
      const progress: BackgroundSyncProgress = { accountId, status, synced, total, error };
      window.webContents.send("background-sync:progress", progress);
    }
  }

  private getMainWindow(): BrowserWindow | null {
    const windows = BrowserWindow.getAllWindows();
    return windows.length > 0 ? windows[0] : null;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// Export singleton
export const backgroundSyncService = new BackgroundSyncService();
