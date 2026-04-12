import { ipcMain, BrowserWindow } from "electron";
import { snoozeService } from "../services/snooze-service";
import { getDueSnoozedEmails, unsnoozeEmail, getEmailsByThread, saveAnalysis } from "../db";
import type { IpcResponse, SnoozedEmail } from "../../shared/types";
import { createLogger } from "../services/logger";
import { prefetchService } from "../services/prefetch-service";
import { classifySenderByHeuristics } from "../services/sender-classifier";

const log = createLogger("snooze-ipc");

/**
 * When threads come out of snooze, ensure they have sender_type classification
 * so they route to the correct tab (People vs Automated). Runs heuristics
 * synchronously (instant, zero API cost). For ambiguous cases, the email
 * defaults to People until the next analysis cycle picks it up.
 */
function reclassifyUnsnoozedThreads(snoozedEmails: SnoozedEmail[]): void {
  for (const snoozed of snoozedEmails) {
    const threadEmails = getEmailsByThread(snoozed.threadId, snoozed.accountId);
    for (const email of threadEmails) {
      // Skip emails that already have senderType classified
      if (email.analysis && !email.analysis.senderType) {
        const heuristicType = classifySenderByHeuristics({ from: email.from });
        if (heuristicType === "automated") {
          saveAnalysis(
            email.id,
            email.analysis.needsReply,
            email.analysis.reason,
            email.analysis.priority,
            "automated",
            "other",
          );
          log.info(
            `[Snooze] Heuristic reclassified ${email.id} as automated (from: ${email.from})`,
          );
        } else {
          // Ambiguous or person — set to "person" so it routes to People tab
          saveAnalysis(
            email.id,
            email.analysis.needsReply,
            email.analysis.reason,
            email.analysis.priority,
            "person",
          );
        }
      }
    }
  }
}

export function registerSnoozeIpc(): void {
  // Set up the unsnooze callback to broadcast to renderer
  snoozeService.setOnUnsnooze((unsnoozedEmails) => {
    // Ensure unsnoozed threads have sender classification for People/Automated routing
    reclassifyUnsnoozedThreads(unsnoozedEmails);

    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("snooze:unsnoozed", { emails: unsnoozedEmails });
    }
    // Auto-draft replies for threads returning from snooze
    prefetchService.queueDraftForUnsnoozedEmails(unsnoozedEmails);
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
      },
    ): Promise<IpcResponse<SnoozedEmail>> => {
      try {
        const result = snoozeService.snooze(emailId, threadId, accountId, snoozeUntil);

        // Broadcast snooze event to all windows
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("snooze:snoozed", { snoozedEmail: result });
        }

        return { success: true, data: result };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to snooze");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to snooze email",
        };
      }
    },
  );

  // Manually unsnooze a thread
  ipcMain.handle(
    "snooze:unsnooze",
    async (
      _event,
      { threadId, accountId }: { threadId: string; accountId: string },
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

        // Ensure sender classification for People/Automated routing, then auto-draft
        if (snoozeInfo) {
          reclassifyUnsnoozedThreads([snoozeInfo]);
          prefetchService.queueDraftForUnsnoozedEmails([snoozeInfo]);
        }

        return { success: true, data: undefined };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to unsnooze");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to unsnooze email",
        };
      }
    },
  );

  // List snoozed emails for an account.
  // Also processes any expired snoozes for this account (handles snoozes
  // that expired while the app was closed) and returns them separately.
  ipcMain.handle(
    "snooze:list",
    async (
      _event,
      { accountId }: { accountId: string },
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
          log.info(
            `[Snooze IPC] Processed ${expired.length} expired snooze(s) for account ${accountId}`,
          );
          // Ensure sender classification for People/Automated routing
          reclassifyUnsnoozedThreads(expired);
          // Auto-draft replies for threads that expired while app was closed
          prefetchService.queueDraftForUnsnoozedEmails(expired);
        }

        const snoozed = snoozeService.getSnoozedEmails(accountId);
        return { success: true, data: snoozed, expired };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to list snoozed");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list snoozed emails",
        };
      }
    },
  );

  // Get snooze info for a specific thread
  ipcMain.handle(
    "snooze:get",
    async (
      _event,
      { threadId, accountId }: { threadId: string; accountId: string },
    ): Promise<IpcResponse<SnoozedEmail | null>> => {
      try {
        const snoozed = snoozeService.getSnoozedByThread(threadId, accountId);
        return { success: true, data: snoozed };
      } catch (error) {
        log.error({ err: error }, "[Snooze IPC] Failed to get snooze");
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get snooze info",
        };
      }
    },
  );
}
