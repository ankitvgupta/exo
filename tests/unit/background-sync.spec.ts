/**
 * Unit tests for BackgroundSyncService (src/main/services/background-sync.ts)
 *
 * The BackgroundSyncService cannot be imported directly because it transitively
 * imports electron (BrowserWindow) and the DB layer. We re-implement the pure
 * testable logic inline:
 *
 * - getProgress: state machine for sync progress reporting
 * - isRunning: running state tracking
 * - stopSync: cancellation flag
 * - Batch logic: batch size calculation and filtering of already-synced IDs
 *
 * The orchestration of GmailClient calls, DB saves, and BrowserWindow IPC
 * would require integration tests with proper mocks.
 */
import { test, expect } from "@playwright/test";

// ---------------------------------------------------------------------------
// Re-implement BackgroundSyncService pure logic for isolated testing
// ---------------------------------------------------------------------------

type BackgroundSyncProgress = {
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

/**
 * Minimal re-implementation of BackgroundSyncService with only pure logic.
 * Excludes electron/DB/GmailClient dependencies.
 */
class TestableBackgroundSync {
  private accountStates: Map<string, AccountSyncState> = new Map();

  /** Set state directly for testing */
  setState(accountId: string, state: AccountSyncState): void {
    this.accountStates.set(accountId, state);
  }

  getProgress(accountId: string): BackgroundSyncProgress {
    const state = this.accountStates.get(accountId);
    if (!state) {
      return { accountId, status: "idle", synced: 0, total: 0 };
    }
    return {
      accountId,
      status: state.isRunning
        ? "running"
        : state.lastError
          ? "error"
          : "completed",
      synced: state.syncedCount,
      total: state.totalCount,
      error: state.lastError,
    };
  }

  isRunning(accountId: string): boolean {
    return this.accountStates.get(accountId)?.isRunning ?? false;
  }

  stopSync(accountId: string): void {
    const state = this.accountStates.get(accountId);
    if (state) {
      state.isRunning = false;
    }
  }
}

/**
 * Re-implementation of the batch filtering logic from startAllMailSync.
 * Given all mail IDs and existing IDs, returns which need syncing.
 */
function filterToSync(
  allMailResults: Array<{ id: string; threadId: string }>,
  existingIds: Set<string>
): Array<{ id: string; threadId: string }> {
  return allMailResults.filter((m) => !existingIds.has(m.id));
}

/**
 * Re-implementation of the batching logic.
 */
function computeBatches<T>(items: T[], batchSize: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) {
    batches.push(items.slice(i, i + batchSize));
  }
  return batches;
}

// ---------------------------------------------------------------------------
// Tests: getProgress state machine
// ---------------------------------------------------------------------------

test.describe("BackgroundSyncService.getProgress", () => {
  test("returns idle status when no state exists for account", () => {
    const service = new TestableBackgroundSync();
    const progress = service.getProgress("account-1");

    expect(progress).toEqual({
      accountId: "account-1",
      status: "idle",
      synced: 0,
      total: 0,
    });
  });

  test("returns running status when sync is in progress", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: true,
      syncedCount: 50,
      totalCount: 200,
    });

    const progress = service.getProgress("account-1");

    expect(progress.status).toBe("running");
    expect(progress.synced).toBe(50);
    expect(progress.total).toBe(200);
  });

  test("returns completed status when sync finished without error", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: false,
      syncedCount: 200,
      totalCount: 200,
    });

    const progress = service.getProgress("account-1");

    expect(progress.status).toBe("completed");
    expect(progress.synced).toBe(200);
    expect(progress.total).toBe(200);
  });

  test("returns error status when sync finished with error", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: false,
      syncedCount: 50,
      totalCount: 200,
      lastError: "Rate limit exceeded",
    });

    const progress = service.getProgress("account-1");

    expect(progress.status).toBe("error");
    expect(progress.error).toBe("Rate limit exceeded");
    expect(progress.synced).toBe(50);
  });

  test("running state takes priority over error (error from previous run)", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: true,
      syncedCount: 0,
      totalCount: 100,
      lastError: "Previous error",
    });

    const progress = service.getProgress("account-1");

    // isRunning=true should report "running", even if lastError is set
    expect(progress.status).toBe("running");
  });
});

// ---------------------------------------------------------------------------
// Tests: isRunning
// ---------------------------------------------------------------------------

test.describe("BackgroundSyncService.isRunning", () => {
  test("returns false when no state exists", () => {
    const service = new TestableBackgroundSync();
    expect(service.isRunning("account-1")).toBe(false);
  });

  test("returns true when sync is running", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: true,
      syncedCount: 0,
      totalCount: 100,
    });
    expect(service.isRunning("account-1")).toBe(true);
  });

  test("returns false after sync completes", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: false,
      syncedCount: 100,
      totalCount: 100,
    });
    expect(service.isRunning("account-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: stopSync
// ---------------------------------------------------------------------------

test.describe("BackgroundSyncService.stopSync", () => {
  test("sets isRunning to false for an active sync", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: true,
      syncedCount: 50,
      totalCount: 200,
    });

    service.stopSync("account-1");

    expect(service.isRunning("account-1")).toBe(false);
  });

  test("is a no-op for unknown accounts", () => {
    const service = new TestableBackgroundSync();
    // Should not throw
    service.stopSync("nonexistent-account");
    expect(service.isRunning("nonexistent-account")).toBe(false);
  });

  test("preserves sync counts after stopping", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: true,
      syncedCount: 75,
      totalCount: 200,
    });

    service.stopSync("account-1");

    const progress = service.getProgress("account-1");
    expect(progress.synced).toBe(75);
    expect(progress.total).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Tests: filterToSync (batch filtering logic)
// ---------------------------------------------------------------------------

test.describe("filterToSync", () => {
  test("returns all items when nothing is already synced", () => {
    const allMail = [
      { id: "1", threadId: "t1" },
      { id: "2", threadId: "t2" },
    ];
    const result = filterToSync(allMail, new Set());
    expect(result).toHaveLength(2);
  });

  test("filters out already-synced IDs", () => {
    const allMail = [
      { id: "1", threadId: "t1" },
      { id: "2", threadId: "t2" },
      { id: "3", threadId: "t3" },
    ];
    const existing = new Set(["1", "3"]);
    const result = filterToSync(allMail, existing);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  test("returns empty when all IDs are already synced", () => {
    const allMail = [
      { id: "1", threadId: "t1" },
      { id: "2", threadId: "t2" },
    ];
    const existing = new Set(["1", "2"]);
    const result = filterToSync(allMail, existing);
    expect(result).toHaveLength(0);
  });

  test("handles empty input", () => {
    const result = filterToSync([], new Set(["1", "2"]));
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: computeBatches (batch size calculation)
// ---------------------------------------------------------------------------

test.describe("computeBatches", () => {
  test("splits items into correct batch sizes", () => {
    const items = Array.from({ length: 120 }, (_, i) => i);
    const batches = computeBatches(items, 50);

    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(50);
    expect(batches[2]).toHaveLength(20);
  });

  test("returns single batch when items fit", () => {
    const items = [1, 2, 3];
    const batches = computeBatches(items, 50);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([1, 2, 3]);
  });

  test("returns empty array for empty input", () => {
    const batches = computeBatches([], 50);
    expect(batches).toHaveLength(0);
  });

  test("handles exact batch size boundary", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const batches = computeBatches(items, 50);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(50);
    expect(batches[1]).toHaveLength(50);
  });
});

// ---------------------------------------------------------------------------
// Tests: Multiple accounts independence
// ---------------------------------------------------------------------------

test.describe("Multiple accounts", () => {
  test("tracks state independently per account", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: true,
      syncedCount: 10,
      totalCount: 100,
    });
    service.setState("account-2", {
      isRunning: false,
      syncedCount: 50,
      totalCount: 50,
    });

    expect(service.isRunning("account-1")).toBe(true);
    expect(service.isRunning("account-2")).toBe(false);

    const p1 = service.getProgress("account-1");
    const p2 = service.getProgress("account-2");
    expect(p1.status).toBe("running");
    expect(p2.status).toBe("completed");
  });

  test("stopping one account does not affect another", () => {
    const service = new TestableBackgroundSync();
    service.setState("account-1", {
      isRunning: true,
      syncedCount: 10,
      totalCount: 100,
    });
    service.setState("account-2", {
      isRunning: true,
      syncedCount: 20,
      totalCount: 200,
    });

    service.stopSync("account-1");

    expect(service.isRunning("account-1")).toBe(false);
    expect(service.isRunning("account-2")).toBe(true);
  });
});
