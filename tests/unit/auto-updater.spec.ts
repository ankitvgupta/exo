/**
 * Unit tests for the auto-updater state machine logic.
 * Re-implements the state machine inline to avoid electron/electron-updater imports.
 */
import { test, expect } from "@playwright/test";
import { EventEmitter } from "events";

// ============================================================
// Re-implementation of UpdateStatus type and AutoUpdateService state machine
// ============================================================

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; releaseNotes?: string }
  | { state: "downloading"; progress: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

type AutoUpdaterEvent = "status-changed";

class AutoUpdateService extends EventEmitter {
  private _status: UpdateStatus = { state: "idle" };

  /** Simulate the private setStatus method */
  setStatus(status: UpdateStatus): void {
    this._status = status;
    this.emit("status-changed", status);
  }

  get status(): UpdateStatus {
    return this._status;
  }

  /**
   * Re-implements setGitHubToken logic: sets or deletes GH_TOKEN env var.
   * (The setFeedURL call is omitted since it depends on electron-updater.)
   */
  setGitHubToken(token?: string): void {
    if (token) {
      process.env.GH_TOKEN = token;
    } else {
      delete process.env.GH_TOKEN;
    }
  }

  /**
   * Re-implements checkForUpdates skip logic:
   * If already checking, downloading, or downloaded, re-emit current status and return.
   */
  shouldSkipCheck(): boolean {
    const { state } = this._status;
    if (state === "checking" || state === "downloading" || state === "downloaded") {
      this.emit("status-changed", this._status);
      return true;
    }
    return false;
  }

  /**
   * Re-implements downloadUpdate guard:
   * If already downloading or downloaded, return true (skip).
   */
  shouldSkipDownload(): boolean {
    return (
      this._status.state === "downloading" ||
      this._status.state === "downloaded"
    );
  }

  on(event: AutoUpdaterEvent, listener: (status: UpdateStatus) => void): this {
    return super.on(event, listener);
  }

  off(event: AutoUpdaterEvent, listener: (status: UpdateStatus) => void): this {
    return super.off(event, listener);
  }
}

// ============================================================
// Tests
// ============================================================

test.describe("AutoUpdateService state machine", () => {
  test.describe.configure({ mode: "serial" });
  let service: AutoUpdateService;

  test.beforeEach(() => {
    service = new AutoUpdateService();
    // Clean up env var between tests
    delete process.env.GH_TOKEN;
  });

  test.afterEach(() => {
    delete process.env.GH_TOKEN;
  });

  test.describe("initial state", () => {
    test("starts in idle state", () => {
      expect(service.status).toEqual({ state: "idle" });
    });
  });

  test.describe("status transitions", () => {
    test("idle → checking", () => {
      const statuses: UpdateStatus[] = [];
      service.on("status-changed", (s) => statuses.push(s));

      service.setStatus({ state: "checking" });

      expect(service.status.state).toBe("checking");
      expect(statuses).toHaveLength(1);
      expect(statuses[0].state).toBe("checking");
    });

    test("checking → available", () => {
      service.setStatus({ state: "checking" });

      const statuses: UpdateStatus[] = [];
      service.on("status-changed", (s) => statuses.push(s));

      service.setStatus({
        state: "available",
        version: "2.0.0",
        releaseNotes: "New features",
      });

      expect(service.status.state).toBe("available");
      const available = service.status as { state: "available"; version: string; releaseNotes?: string };
      expect(available.version).toBe("2.0.0");
      expect(available.releaseNotes).toBe("New features");
    });

    test("available → downloading (with progress)", () => {
      service.setStatus({ state: "available", version: "2.0.0" });

      service.setStatus({ state: "downloading", progress: 0 });
      expect(service.status.state).toBe("downloading");
      expect((service.status as { state: "downloading"; progress: number }).progress).toBe(0);

      service.setStatus({ state: "downloading", progress: 50 });
      expect((service.status as { state: "downloading"; progress: number }).progress).toBe(50);

      service.setStatus({ state: "downloading", progress: 100 });
      expect((service.status as { state: "downloading"; progress: number }).progress).toBe(100);
    });

    test("downloading → downloaded", () => {
      service.setStatus({ state: "downloading", progress: 100 });

      service.setStatus({ state: "downloaded", version: "2.0.0" });

      expect(service.status.state).toBe("downloaded");
      expect((service.status as { state: "downloaded"; version: string }).version).toBe("2.0.0");
    });

    test("full happy path: idle → checking → available → downloading → downloaded", () => {
      const states: string[] = [];
      service.on("status-changed", (s) => states.push(s.state));

      service.setStatus({ state: "checking" });
      service.setStatus({ state: "available", version: "3.0.0" });
      service.setStatus({ state: "downloading", progress: 0 });
      service.setStatus({ state: "downloading", progress: 75 });
      service.setStatus({ state: "downloaded", version: "3.0.0" });

      expect(states).toEqual([
        "checking",
        "available",
        "downloading",
        "downloading",
        "downloaded",
      ]);
    });

    test("checking → idle (no update available)", () => {
      service.setStatus({ state: "checking" });
      service.setStatus({ state: "idle" });
      expect(service.status.state).toBe("idle");
    });
  });

  test.describe("error state", () => {
    test("any state → error", () => {
      service.setStatus({ state: "checking" });
      service.setStatus({ state: "error", message: "Network failed" });

      expect(service.status.state).toBe("error");
      expect((service.status as { state: "error"; message: string }).message).toBe("Network failed");
    });

    test("error → checking (retry)", () => {
      service.setStatus({ state: "error", message: "Previous failure" });
      service.setStatus({ state: "checking" });
      expect(service.status.state).toBe("checking");
    });

    test("error during download", () => {
      service.setStatus({ state: "downloading", progress: 45 });
      service.setStatus({ state: "error", message: "Download interrupted" });
      expect(service.status.state).toBe("error");
    });
  });

  test.describe("shouldSkipCheck", () => {
    test("does not skip when idle", () => {
      expect(service.shouldSkipCheck()).toBe(false);
    });

    test("does not skip when in error state", () => {
      service.setStatus({ state: "error", message: "oops" });
      expect(service.shouldSkipCheck()).toBe(false);
    });

    test("does not skip when available", () => {
      service.setStatus({ state: "available", version: "1.0.0" });
      expect(service.shouldSkipCheck()).toBe(false);
    });

    test("skips when checking and re-emits status", () => {
      service.setStatus({ state: "checking" });

      const statuses: UpdateStatus[] = [];
      service.on("status-changed", (s) => statuses.push(s));

      expect(service.shouldSkipCheck()).toBe(true);
      expect(statuses).toHaveLength(1);
      expect(statuses[0].state).toBe("checking");
    });

    test("skips when downloading", () => {
      service.setStatus({ state: "downloading", progress: 30 });
      expect(service.shouldSkipCheck()).toBe(true);
    });

    test("skips when downloaded", () => {
      service.setStatus({ state: "downloaded", version: "2.0.0" });
      expect(service.shouldSkipCheck()).toBe(true);
    });
  });

  test.describe("shouldSkipDownload", () => {
    test("does not skip when idle", () => {
      expect(service.shouldSkipDownload()).toBe(false);
    });

    test("does not skip when available", () => {
      service.setStatus({ state: "available", version: "1.0.0" });
      expect(service.shouldSkipDownload()).toBe(false);
    });

    test("skips when already downloading", () => {
      service.setStatus({ state: "downloading", progress: 50 });
      expect(service.shouldSkipDownload()).toBe(true);
    });

    test("skips when already downloaded", () => {
      service.setStatus({ state: "downloaded", version: "2.0.0" });
      expect(service.shouldSkipDownload()).toBe(true);
    });
  });

  test.describe("setGitHubToken", () => {
    test("sets GH_TOKEN env var when token is provided", () => {
      service.setGitHubToken("ghp_abc123");
      expect(process.env.GH_TOKEN).toBe("ghp_abc123");
    });

    test("deletes GH_TOKEN env var when token is undefined", () => {
      process.env.GH_TOKEN = "old-token";
      service.setGitHubToken(undefined);
      expect(process.env.GH_TOKEN).toBeUndefined();
    });

    test("deletes GH_TOKEN env var when called with no argument", () => {
      process.env.GH_TOKEN = "old-token";
      service.setGitHubToken();
      expect(process.env.GH_TOKEN).toBeUndefined();
    });

    test("overwrites existing GH_TOKEN", () => {
      process.env.GH_TOKEN = "old-token";
      service.setGitHubToken("new-token");
      expect(process.env.GH_TOKEN).toBe("new-token");
    });
  });

  test.describe("event emission", () => {
    test("each setStatus emits exactly one status-changed event", () => {
      let count = 0;
      service.on("status-changed", () => count++);

      service.setStatus({ state: "checking" });
      service.setStatus({ state: "available", version: "1.0.0" });
      service.setStatus({ state: "error", message: "fail" });

      expect(count).toBe(3);
    });

    test("listener receives the new status object", () => {
      let received: UpdateStatus | null = null;
      service.on("status-changed", (s) => {
        received = s;
      });

      service.setStatus({ state: "downloaded", version: "5.0.0" });

      expect(received).toEqual({ state: "downloaded", version: "5.0.0" });
    });
  });
});
