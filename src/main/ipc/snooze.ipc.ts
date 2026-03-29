import { ipcMain, BrowserWindow } from "electron";
import { snoozeService } from "../services/snooze-service";
import { getDueSnoozedEmails, unsnoozeEmail } from "../db";
import type { IpcResponse, SnoozedEmail } from "../../shared/types";

export function registerSnoozeIpc(): void {
  // Set up the unsnooze callback to broadcast to renderer
  snoozeService.setOnUnsnooze((unsnoozedEmails) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("snooze:unsnoozed", { emails: unsnoozedEmails });
    }
  });

  // Start the snooze timer service
  snoozeService.start();

  // Snooze a thread
  ipcMain.handle(
    "snooze:snooze",
    async (
      _event,
      {
        emailId,
        threadId,
        accountId,
        snoozeUntil,
      }: {
        emailId: string;
        threadId: string;
        accountId: string;
        snoozeUntil: number;
      }
    ): Promise<IpcResponse<SnoozedEmail>> => {
      try {
        const result = snoozeService.snooze(emailId, threadId, accountId, snoozeUntil);

        // Broadcast snooze event to all windows
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("snooze:snoozed", { snoozedEmail: result });
        }

        return { success: true, data: result };
      } catch (error) {
        console.error("[Snooze IPC] Failed to snooze:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to snooze email",
        };
      }
    }
  );

  // Manually unsnooze a thread
  ipcMain.handle(
    "snooze:unsnooze",
    async (
      _event,
      { threadId, accountId }: { threadId: string; accountId: string }
    ): Promise<IpcResponse<void>> => {
      try {
        // Get snooze info before removing so we can include snoozeUntil in the event
        const snoozeInfo = snoozeService.getSnoozedByThread(threadId, accountId);
        snoozeService.unsnooze(threadId, accountId);

        // Broadcast unsnooze event with snoozeUntil for correct sort positioning
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("snooze:manually-unsnoozed", {
            threadId,
            accountId,
            snoozeUntil: snoozeInfo?.snoozeUntil ?? Date.now(),
          });
        }

        return { success: true, data: undefined };
      } catch (error) {
        console.error("[Snooze IPC] Failed to unsnooze:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to unsnooze email",
        };
      }
    }
  );

  // List snoozed emails for an account.
  // Also processes any expired snoozes for this account (handles snoozes
  // that expired while the app was closed) and returns them separately.
  ipcMain.handle(
    "snooze:list",
    async (
      _event,
      { accountId }: { accountId: string }
    ): Promise<IpcResponse<SnoozedEmail[]> & { expired?: SnoozedEmail[] }> => {
      try {
        // Process expired snoozes for this account so the renderer can
        // position them correctly (other accounts are left for the 30s timer)
        const allDue = getDueSnoozedEmails();
        const expired: SnoozedEmail[] = [];
        for (const snoozed of allDue) {
          if (snoozed.accountId === accountId) {
            unsnoozeEmail(snoozed.id);
            expired.push(snoozed);
          }
        }
        if (expired.length > 0) {
          console.log(`[Snooze IPC] Processed ${expired.length} expired snooze(s) for account ${accountId}`);
        }

        const snoozed = snoozeService.getSnoozedEmails(accountId);
        return { success: true, data: snoozed, expired };
      } catch (error) {
        console.error("[Snooze IPC] Failed to list snoozed:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list snoozed emails",
        };
      }
    }
  );

  // Get snooze info for a specific thread
  ipcMain.handle(
    "snooze:get",
    async (
      _event,
      { threadId, accountId }: { threadId: string; accountId: string }
    ): Promise<IpcResponse<SnoozedEmail | null>> => {
      try {
        const snoozed = snoozeService.getSnoozedByThread(threadId, accountId);
        return { success: true, data: snoozed };
      } catch (error) {
        console.error("[Snooze IPC] Failed to get snooze:", error);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get snooze info",
        };
      }
    }
  );
}
