import { ipcMain, BrowserWindow } from "electron";
import { prefetchService, type PrefetchProgress } from "../services/prefetch-service";
import { getEmail } from "../db";
import type { IpcResponse, DashboardEmail } from "../../shared/types";

// Get the main window for sending IPC events
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

// Notify renderer when an email is analyzed
export function notifyEmailAnalyzed(emailId: string): void {
  const window = getMainWindow();
  if (!window) return;

  const email = getEmail(emailId);
  if (email) {
    window.webContents.send("prefetch:email-analyzed", email);
  }
}

// Notify renderer when a thread's archive-readiness is determined
export function notifyArchiveReady(threadId: string, accountId: string, isReady: boolean, reason: string): void {
  const window = getMainWindow();
  if (!window) return;

  window.webContents.send("archive-ready:result", { threadId, accountId, isReady, reason });
}

export function registerPrefetchIpc(): void {
  // Set up progress listener to emit events to renderer
  prefetchService.onProgress((progress) => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("prefetch:progress", progress);
    }
  });

  // Get current progress
  ipcMain.handle("prefetch:status", async (): Promise<IpcResponse<PrefetchProgress>> => {
    try {
      const progress = prefetchService.getProgress();
      return { success: true, data: progress };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Start processing all pending emails
  ipcMain.handle("prefetch:process-all", async (): Promise<IpcResponse<void>> => {
    try {
      // Start processing in background (non-blocking)
      prefetchService.processAllPending().catch((error) => {
        console.error("[Prefetch] Error in processAllPending:", error);
      });
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Queue specific emails for processing
  ipcMain.handle(
    "prefetch:queue-emails",
    async (_, { emailIds }: { emailIds: string[] }): Promise<IpcResponse<void>> => {
      try {
        await prefetchService.queueEmails(emailIds);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  // Clear prefetch state
  ipcMain.handle("prefetch:clear", async (): Promise<IpcResponse<void>> => {
    try {
      prefetchService.clear();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });
}
