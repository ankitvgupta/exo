import { ipcMain, app, BrowserWindow } from "electron";
import { autoUpdateService, type UpdateStatus } from "../services/auto-updater";
import type { IpcResponse } from "../../shared/types";

export function registerUpdatesIpc(): void {
  // Get current update status
  ipcMain.handle("updates:get-status", async (): Promise<IpcResponse<UpdateStatus>> => {
    return { success: true, data: autoUpdateService.status };
  });

  // Trigger manual update check
  ipcMain.handle("updates:check", async (): Promise<IpcResponse<void>> => {
    try {
      await autoUpdateService.checkForUpdates();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Start downloading available update
  ipcMain.handle("updates:download", async (): Promise<IpcResponse<void>> => {
    try {
      await autoUpdateService.downloadUpdate();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Quit and install downloaded update
  ipcMain.handle("updates:install", async (): Promise<IpcResponse<void>> => {
    try {
      autoUpdateService.quitAndInstall();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Get current app version
  ipcMain.handle("updates:get-version", async (): Promise<IpcResponse<string>> => {
    return { success: true, data: app.getVersion() };
  });

  // Forward status changes to renderer
  autoUpdateService.on("status-changed", (status: UpdateStatus) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("updates:status-changed", status);
    }
  });
}
