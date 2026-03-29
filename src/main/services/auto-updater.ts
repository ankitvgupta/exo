import { EventEmitter } from "events";
import { app } from "electron";
import { autoUpdater, type UpdateInfo } from "electron-updater";
import { closeDatabase } from "../db";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "downloading"; progress: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

type AutoUpdaterEvent = "status-changed";

class AutoUpdateService extends EventEmitter {
  private _status: UpdateStatus = { state: "idle" };
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super();

    // Don't download automatically -- let user choose
    autoUpdater.autoDownload = false;
    // Install on quit once downloaded
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      this.setStatus({ state: "checking" });
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      this.setStatus({
        state: "available",
        version: info.version,
        releaseNotes: typeof info.releaseNotes === "string" ? info.releaseNotes : undefined,
      });
    });

    autoUpdater.on("update-not-available", () => {
      this.setStatus({ state: "idle" });
    });

    autoUpdater.on("download-progress", (progress) => {
      this.setStatus({ state: "downloading", progress: Math.round(progress.percent) });
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      this.setStatus({ state: "downloaded", version: info.version });
    });

    autoUpdater.on("error", (err: Error) => {
      console.error("[AutoUpdater] Error:", err.message);
      this.setStatus({ state: "error", message: err.message });
    });
  }

  private setStatus(status: UpdateStatus): void {
    this._status = status;
    this.emit("status-changed", status);
  }

  get status(): UpdateStatus {
    return this._status;
  }

  /**
   * Set the GitHub token for private repo access.
   * electron-updater caches the provider on first check — if the token changes
   * after that, we must call setFeedURL to force a new PrivateGitHubProvider.
   */
  setGitHubToken(token?: string): void {
    if (token) {
      process.env.GH_TOKEN = token;
    } else {
      delete process.env.GH_TOKEN;
    }
    this.refreshFeedURL();
  }

  /**
   * Enable or disable pre-release updates. When enabled, electron-updater
   * will also consider GitHub releases marked as "prerelease".
   */
  setAllowPrerelease(allow: boolean, { skipRefresh = false } = {}): void {
    autoUpdater.allowPrerelease = allow;
    if (!skipRefresh) {
      this.refreshFeedURL();
    }
  }

  /**
   * Force electron-updater to recreate its cached provider so that changes
   * to GH_TOKEN or allowPrerelease take effect immediately.
   */
  private refreshFeedURL(): void {
    if (app.isPackaged) {
      autoUpdater.setFeedURL({
        provider: "github",
        owner: "ankitvgupta",
        repo: "mail-client",
        private: true,
        token: process.env.GH_TOKEN || undefined,
      });
    }
  }

  /**
   * Start periodic update checks.
   * Delays first check by 30s to avoid competing with sync/prefetch on startup.
   */
  start(): void {
    if (!app.isPackaged) {
      console.log("[AutoUpdater] Skipping -- app is not packaged");
      return;
    }

    // Clear any existing timers to prevent duplicates
    this.stop();

    // Delay first check
    this.startupTimer = setTimeout(() => {
      this.checkForUpdates().catch((err) => {
        console.error("[AutoUpdater] Periodic check failed:", err.message);
      });

      // Check once per day
      this.checkInterval = setInterval(() => {
        this.checkForUpdates().catch((err) => {
          console.error("[AutoUpdater] Periodic check failed:", err.message);
        });
      }, 24 * 60 * 60 * 1000);
    }, 30_000);
  }

  stop(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }

  async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) {
      throw new Error("Updates are not available in development mode");
    }

    // Skip if already checking, downloading, or downloaded — re-emit
    // current status so any listeners waiting for a state change can react
    const { state } = this._status;
    if (state === "checking" || state === "downloading" || state === "downloaded") {
      this.emit("status-changed", this._status);
      return;
    }

    await autoUpdater.checkForUpdates();
  }

  async downloadUpdate(): Promise<void> {
    if (this._status.state === "downloading" || this._status.state === "downloaded") {
      return;
    }
    // Immediately show progress bar at 0% so the UI reacts before
    // electron-updater emits its first download-progress event.
    this.setStatus({ state: "downloading", progress: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      // The "error" event handler may have already set the status. Only set
      // it here if not, to avoid double status-changed emissions.
      if (this._status.state !== "error") {
        const message = err instanceof Error ? err.message : "Download failed";
        this.setStatus({ state: "error", message });
      }
      throw err;
    }
  }

  quitAndInstall(): void {
    // Flush WAL and close DB before quitting — quitAndInstall can
    // force-kill the process, bypassing the before-quit handler.
    closeDatabase();
    autoUpdater.quitAndInstall();
  }

  // Type-safe event methods
  on(event: AutoUpdaterEvent, listener: (status: UpdateStatus) => void): this {
    return super.on(event, listener);
  }

  off(event: AutoUpdaterEvent, listener: (status: UpdateStatus) => void): this {
    return super.off(event, listener);
  }
}

// Export singleton instance
export const autoUpdateService = new AutoUpdateService();
