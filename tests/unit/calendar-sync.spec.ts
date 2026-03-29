/**
 * Unit tests for calendar sync orchestration logic.
 * Re-implements the CalendarSyncService patterns inline to avoid DB/extension imports.
 */
import { test, expect } from "@playwright/test";

// ============================================================
// Re-implementation of CalendarSyncService orchestration logic
// ============================================================

type EventsUpdatedCallback = () => void;

class CalendarSyncService {
  intervalId: ReturnType<typeof setInterval> | null = null;
  syncing = false;
  private onEventsUpdatedCallbacks: EventsUpdatedCallback[] = [];

  /** Count how many times syncAll was actually executed (not skipped). */
  syncAllCount = 0;

  /**
   * Start background sync. Safe to call multiple times — only starts one interval.
   */
  async startSync(intervalMs: number = 100): Promise<void> {
    if (this.intervalId) return;

    await this.syncAll();

    this.intervalId = setInterval(() => {
      this.syncAll().catch((err) => {
        console.error("[CalendarSync] Periodic sync failed:", err);
      });
    }, intervalMs);
  }

  stopSync(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  onEventsUpdated(callback: EventsUpdatedCallback): void {
    this.onEventsUpdatedCallbacks.push(callback);
  }

  notifyEventsUpdated(): void {
    for (const cb of this.onEventsUpdatedCallbacks) {
      try {
        cb();
      } catch (err) {
        console.error("[CalendarSync] Callback error:", err);
      }
    }
  }

  async syncAll(): Promise<void> {
    if (this.syncing) return;
    this.syncing = true;

    try {
      this.syncAllCount++;
      // In real code this does actual sync work; here we just track the call.
    } finally {
      this.syncing = false;
    }
  }
}

// ============================================================
// Tests
// ============================================================

test.describe("CalendarSyncService", () => {
  let service: CalendarSyncService;

  test.beforeEach(() => {
    service = new CalendarSyncService();
  });

  test.afterEach(() => {
    service.stopSync();
  });

  test.describe("startSync idempotency", () => {
    test("calling startSync twice does not create two intervals", async () => {
      await service.startSync(50);
      const firstIntervalId = service.intervalId;
      expect(firstIntervalId).not.toBeNull();

      await service.startSync(50);
      expect(service.intervalId).toBe(firstIntervalId);
    });

    test("startSync runs an initial sync immediately", async () => {
      expect(service.syncAllCount).toBe(0);
      await service.startSync(10000);
      expect(service.syncAllCount).toBe(1);
    });
  });

  test.describe("stopSync", () => {
    test("clears the interval", async () => {
      await service.startSync(50);
      expect(service.intervalId).not.toBeNull();

      service.stopSync();
      expect(service.intervalId).toBeNull();
    });

    test("stopSync is safe to call when not started", () => {
      expect(service.intervalId).toBeNull();
      service.stopSync(); // should not throw
      expect(service.intervalId).toBeNull();
    });

    test("after stopSync, startSync can restart", async () => {
      await service.startSync(50);
      service.stopSync();
      expect(service.intervalId).toBeNull();

      await service.startSync(50);
      expect(service.intervalId).not.toBeNull();
    });
  });

  test.describe("syncing flag prevents concurrent syncs", () => {
    test("syncAll is skipped if already syncing", async () => {
      // Manually set syncing = true to simulate in-progress sync
      service.syncing = true;

      await service.syncAll();

      // syncAllCount stays 0 because the guard returned early
      expect(service.syncAllCount).toBe(0);
    });

    test("syncing flag is reset after syncAll completes", async () => {
      await service.syncAll();
      expect(service.syncing).toBe(false);
    });

    test("syncing flag is reset even if sync logic throws", async () => {
      // Override syncAll to throw after setting the flag
      const throwingService = new (class extends CalendarSyncService {
        async syncAll(): Promise<void> {
          if (this.syncing) return;
          this.syncing = true;
          try {
            throw new Error("sync failure");
          } finally {
            this.syncing = false;
          }
        }
      })();

      await throwingService.syncAll().catch(() => {});
      expect(throwingService.syncing).toBe(false);
    });
  });

  test.describe("notifyEventsUpdated", () => {
    test("calls all registered callbacks", () => {
      const calls: string[] = [];
      service.onEventsUpdated(() => calls.push("cb1"));
      service.onEventsUpdated(() => calls.push("cb2"));
      service.onEventsUpdated(() => calls.push("cb3"));

      service.notifyEventsUpdated();

      expect(calls).toEqual(["cb1", "cb2", "cb3"]);
    });

    test("callback errors do not break other callbacks", () => {
      const calls: string[] = [];
      service.onEventsUpdated(() => calls.push("before"));
      service.onEventsUpdated(() => {
        throw new Error("callback exploded");
      });
      service.onEventsUpdated(() => calls.push("after"));

      // Should not throw
      service.notifyEventsUpdated();

      expect(calls).toEqual(["before", "after"]);
    });

    test("no callbacks registered — does not throw", () => {
      // Should be a no-op
      service.notifyEventsUpdated();
    });

    test("callbacks are called in registration order", () => {
      const order: number[] = [];
      for (let i = 0; i < 5; i++) {
        const idx = i;
        service.onEventsUpdated(() => order.push(idx));
      }

      service.notifyEventsUpdated();

      expect(order).toEqual([0, 1, 2, 3, 4]);
    });

    test("notifyEventsUpdated can be called multiple times", () => {
      let count = 0;
      service.onEventsUpdated(() => count++);

      service.notifyEventsUpdated();
      service.notifyEventsUpdated();
      service.notifyEventsUpdated();

      expect(count).toBe(3);
    });
  });
});
