/**
 * Unit tests for NetworkMonitor logic.
 * Re-implements the EventEmitter-based class inline to avoid electron imports.
 */
import { test, expect } from "@playwright/test";
import { EventEmitter } from "events";

// ============================================================
// Re-implementation of NetworkMonitor (no electron deps)
// ============================================================

type NetworkEvent = "online" | "offline";

class NetworkMonitor extends EventEmitter {
  private _isOnline: boolean = true;
  private initialized: boolean = false;

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
  }

  get isOnline(): boolean {
    return this._isOnline;
  }

  get isInitialized(): boolean {
    return this.initialized;
  }

  updateFromRenderer(online: boolean): void {
    if (this._isOnline !== online) {
      const wasOnline = this._isOnline;
      this._isOnline = online;

      if (!wasOnline && online) {
        this.emit("online");
      } else if (wasOnline && !online) {
        this.emit("offline");
      }
    }
  }

  setOffline(): void {
    if (this._isOnline) {
      this._isOnline = false;
      this.emit("offline");
    }
  }

  on(event: NetworkEvent, listener: () => void): this {
    return super.on(event, listener);
  }

  off(event: NetworkEvent, listener: () => void): this {
    return super.off(event, listener);
  }

  emit(event: NetworkEvent): boolean {
    return super.emit(event);
  }
}

// ============================================================
// Tests
// ============================================================

test.describe("NetworkMonitor", () => {
  let monitor: NetworkMonitor;

  test.beforeEach(() => {
    monitor = new NetworkMonitor();
  });

  test.describe("init", () => {
    test("marks as initialized on first call", () => {
      monitor.init();
      expect(monitor.isInitialized).toBe(true);
    });

    test("is idempotent — second call is a no-op", () => {
      monitor.init();
      monitor.init(); // should not throw or change state
      expect(monitor.isInitialized).toBe(true);
    });
  });

  test.describe("isOnline getter", () => {
    test("defaults to true", () => {
      expect(monitor.isOnline).toBe(true);
    });

    test("reflects state after updateFromRenderer(false)", () => {
      monitor.updateFromRenderer(false);
      expect(monitor.isOnline).toBe(false);
    });

    test("reflects state after setOffline", () => {
      monitor.setOffline();
      expect(monitor.isOnline).toBe(false);
    });
  });

  test.describe("updateFromRenderer", () => {
    test("emits 'offline' when going from online to offline", () => {
      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));
      monitor.on("online", () => events.push("online"));

      monitor.updateFromRenderer(false);

      expect(events).toEqual(["offline"]);
      expect(monitor.isOnline).toBe(false);
    });

    test("emits 'online' when going from offline to online", () => {
      // First go offline
      monitor.updateFromRenderer(false);

      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));
      monitor.on("online", () => events.push("online"));

      monitor.updateFromRenderer(true);

      expect(events).toEqual(["online"]);
      expect(monitor.isOnline).toBe(true);
    });

    test("does not emit when state is unchanged (already online)", () => {
      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));
      monitor.on("online", () => events.push("online"));

      monitor.updateFromRenderer(true); // already online

      expect(events).toEqual([]);
    });

    test("does not emit when state is unchanged (already offline)", () => {
      monitor.updateFromRenderer(false); // go offline

      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));
      monitor.on("online", () => events.push("online"));

      monitor.updateFromRenderer(false); // still offline

      expect(events).toEqual([]);
    });
  });

  test.describe("setOffline", () => {
    test("emits 'offline' when currently online", () => {
      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));

      monitor.setOffline();

      expect(events).toEqual(["offline"]);
      expect(monitor.isOnline).toBe(false);
    });

    test("does not emit when already offline", () => {
      monitor.setOffline(); // first call

      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));

      monitor.setOffline(); // second call — no event

      expect(events).toEqual([]);
      expect(monitor.isOnline).toBe(false);
    });
  });

  test.describe("event transitions", () => {
    test("full cycle: online → offline → online", () => {
      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));
      monitor.on("online", () => events.push("online"));

      monitor.updateFromRenderer(false);
      monitor.updateFromRenderer(true);

      expect(events).toEqual(["offline", "online"]);
    });

    test("setOffline then updateFromRenderer(true) emits both events", () => {
      const events: string[] = [];
      monitor.on("offline", () => events.push("offline"));
      monitor.on("online", () => events.push("online"));

      monitor.setOffline();
      monitor.updateFromRenderer(true);

      expect(events).toEqual(["offline", "online"]);
    });
  });
});
