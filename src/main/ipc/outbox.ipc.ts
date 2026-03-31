import { ipcMain, BrowserWindow } from "electron";
import { outboxService } from "../services/outbox-service";
import { networkMonitor } from "../services/network-monitor";
import type { IpcResponse } from "../../shared/types";
import type { OutboxItem, OutboxStats } from "../db";

// Get the main window for sending IPC events
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

export function registerOutboxIpc(): void {
  // Set up outbox service event listeners
  outboxService.on("statsChanged", (...args: unknown[]) => {
    const stats = args[0] as OutboxStats;
    const window = getMainWindow();
    if (window) {
      window.webContents.send("outbox:stats-changed", stats);
    }
  });

  outboxService.on("sent", (...args: unknown[]) => {
    const data = args[0] as { id: string; gmailId?: string; threadId?: string };
    const window = getMainWindow();
    if (window) {
      window.webContents.send("outbox:sent", data);
    }
  });

  outboxService.on("failed", (...args: unknown[]) => {
    const data = args[0] as { id: string; error: string; permanent: boolean; retryCount?: number };
    const window = getMainWindow();
    if (window) {
      window.webContents.send("outbox:failed", data);
    }
  });

  outboxService.on("authRequired", (...args: unknown[]) => {
    const data = args[0] as { accountId: string; itemId: string };
    const window = getMainWindow();
    if (window) {
      window.webContents.send("outbox:auth-required", data);
    }
  });

  // Get outbox stats
  ipcMain.handle(
    "outbox:stats",
    async (_, { accountId }: { accountId?: string }): Promise<IpcResponse<OutboxStats>> => {
      try {
        const stats = outboxService.getStats(accountId);
        return { success: true, data: stats };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get outbox stats",
        };
      }
    },
  );

  // List outbox items
  ipcMain.handle(
    "outbox:list",
    async (_, { accountId }: { accountId?: string }): Promise<IpcResponse<OutboxItem[]>> => {
      try {
        const items = outboxService.getItems(accountId);
        return { success: true, data: items };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to list outbox items",
        };
      }
    },
  );

  // Get single outbox item
  ipcMain.handle(
    "outbox:get",
    async (_, { id }: { id: string }): Promise<IpcResponse<OutboxItem | null>> => {
      try {
        const item = outboxService.getItem(id);
        return { success: true, data: item };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get outbox item",
        };
      }
    },
  );

  // Retry a failed message
  ipcMain.handle(
    "outbox:retry",
    async (_, { id }: { id: string }): Promise<IpcResponse<boolean>> => {
      try {
        const success = await outboxService.retry(id);
        return { success: true, data: success };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to retry message",
        };
      }
    },
  );

  // Remove/cancel a queued message
  ipcMain.handle(
    "outbox:remove",
    async (_, { id }: { id: string }): Promise<IpcResponse<boolean>> => {
      try {
        const success = outboxService.remove(id);
        return { success: true, data: success };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to remove message",
        };
      }
    },
  );

  // Trigger queue processing manually
  ipcMain.handle("outbox:process", async (): Promise<IpcResponse<void>> => {
    try {
      await outboxService.processQueue();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to process outbox",
      };
    }
  });
}

// Also register network status IPC handlers here since they're related
export function registerNetworkIpc(): void {
  // Set up network monitor event listeners
  networkMonitor.on("online", () => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("network:online");
      // NOTE: outbox processing is triggered by sync.ipc.ts after account reconnection
    }
  });

  networkMonitor.on("offline", () => {
    const window = getMainWindow();
    if (window) {
      window.webContents.send("network:offline");
    }
  });

  // Get current network status
  ipcMain.handle("network:status", async (): Promise<IpcResponse<boolean>> => {
    return { success: true, data: networkMonitor.isOnline };
  });

  // Update network status from renderer (navigator.onLine)
  ipcMain.handle(
    "network:update",
    async (_, { online }: { online: boolean }): Promise<IpcResponse<void>> => {
      networkMonitor.updateFromRenderer(online);
      return { success: true, data: undefined };
    },
  );
}
