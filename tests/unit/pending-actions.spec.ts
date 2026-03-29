import { test, expect } from "@playwright/test";
import { EventEmitter } from "events";

/**
 * Unit tests for PendingActionsQueue.
 *
 * The PendingActionsQueue queues archive/trash actions when offline and
 * processes them when connectivity returns. These tests verify the core
 * queue logic without Electron or IPC dependencies.
 *
 * Since PendingActionsQueue depends on NetworkMonitor (a singleton),
 * we re-implement the core logic inline to test it in isolation.
 */

// --------------------------------------------------------------------------
// Minimal reproduction of the PendingActionsQueue logic
// (avoids importing Electron-dependent modules)
// --------------------------------------------------------------------------

interface PendingAction {
  id: string;
  type: "archive" | "trash";
  emailId: string;
  accountId: string;
  retryCount: number;
  createdAt: number;
}

interface MockClient {
  archiveMessage(messageId: string): Promise<void>;
  trashMessage(messageId: string): Promise<void>;
}

const MAX_RETRIES = 3;

function isNetworkError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    msg.includes("ENOTFOUND") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ECONNRESET") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    (error as any)?.code === "ENOTFOUND" ||
    (error as any)?.code === "ETIMEDOUT" ||
    (error as any)?.code === "ECONNREFUSED" ||
    (error as any)?.code === "ECONNRESET"
  );
}

class TestPendingActionsQueue extends EventEmitter {
  queue: PendingAction[] = [];
  processing = false;
  clientResolver?: (accountId: string) => MockClient | null;
  private nextId = 0;

  /** Allow tests to control online status */
  isOnline = true;

  setClientResolver(resolver: (accountId: string) => MockClient | null): void {
    this.clientResolver = resolver;
  }

  enqueue(type: "archive" | "trash", emailId: string, accountId: string): string {
    const id = `pending-${++this.nextId}`;
    this.queue.push({ id, type, emailId, accountId, retryCount: 0, createdAt: Date.now() });
    return id;
  }

  async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    const items = [...this.queue];
    this.queue = [];

    for (const item of items) {
      if (!this.isOnline) {
        this.queue.unshift(...items.slice(items.indexOf(item)));
        break;
      }

      try {
        const client = this.clientResolver?.(item.accountId);
        if (!client) {
          item.retryCount++;
          if (item.retryCount >= MAX_RETRIES) {
            this.emit("action-failed", {
              emailId: item.emailId,
              accountId: item.accountId,
              action: item.type,
              error: "Account not connected",
            });
          } else {
            this.queue.push(item);
          }
          continue;
        }

        if (item.type === "archive") {
          await client.archiveMessage(item.emailId);
        } else {
          await client.trashMessage(item.emailId);
        }
      } catch (error) {
        const isNetwork = isNetworkError(error);

        if (isNetwork) {
          this.queue.unshift(item, ...items.slice(items.indexOf(item) + 1));
          this.isOnline = false;
          break;
        }

        item.retryCount++;
        if (item.retryCount >= MAX_RETRIES) {
          const msg = error instanceof Error ? error.message : String(error);
          this.emit("action-failed", {
            emailId: item.emailId,
            accountId: item.accountId,
            action: item.type,
            error: msg,
          });
        } else {
          this.queue.push(item);
        }
      }
    }

    this.processing = false;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function createMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    archiveMessage: overrides.archiveMessage ?? (async () => {}),
    trashMessage: overrides.trashMessage ?? (async () => {}),
  };
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

test.describe("PendingActionsQueue - Enqueue", () => {
  test("enqueue adds an action to the queue", () => {
    const queue = new TestPendingActionsQueue();
    const id = queue.enqueue("archive", "email-1", "account-1");

    expect(id).toBeTruthy();
    expect(queue.pendingCount).toBe(1);
    expect(queue.queue[0].emailId).toBe("email-1");
    expect(queue.queue[0].type).toBe("archive");
    expect(queue.queue[0].retryCount).toBe(0);
  });

  test("enqueue generates unique IDs", () => {
    const queue = new TestPendingActionsQueue();
    const id1 = queue.enqueue("archive", "e1", "a1");
    const id2 = queue.enqueue("trash", "e2", "a1");
    const id3 = queue.enqueue("archive", "e3", "a2");

    expect(new Set([id1, id2, id3]).size).toBe(3);
    expect(queue.pendingCount).toBe(3);
  });

  test("enqueue stores correct action types", () => {
    const queue = new TestPendingActionsQueue();
    queue.enqueue("archive", "e1", "a1");
    queue.enqueue("trash", "e2", "a1");

    expect(queue.queue[0].type).toBe("archive");
    expect(queue.queue[1].type).toBe("trash");
  });
});

test.describe("PendingActionsQueue - Process Queue (Success)", () => {
  test("processQueue calls archiveMessage for archive actions", async () => {
    const archived: string[] = [];
    const client = createMockClient({
      archiveMessage: async (id) => { archived.push(id); },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "email-1", "account-1");
    queue.enqueue("archive", "email-2", "account-1");

    await queue.processQueue();

    expect(archived).toEqual(["email-1", "email-2"]);
    expect(queue.pendingCount).toBe(0);
  });

  test("processQueue calls trashMessage for trash actions", async () => {
    const trashed: string[] = [];
    const client = createMockClient({
      trashMessage: async (id) => { trashed.push(id); },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("trash", "email-1", "account-1");

    await queue.processQueue();

    expect(trashed).toEqual(["email-1"]);
    expect(queue.pendingCount).toBe(0);
  });

  test("processQueue handles mixed action types", async () => {
    const archived: string[] = [];
    const trashed: string[] = [];
    const client = createMockClient({
      archiveMessage: async (id) => { archived.push(id); },
      trashMessage: async (id) => { trashed.push(id); },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "e1", "a1");
    queue.enqueue("trash", "e2", "a1");
    queue.enqueue("archive", "e3", "a1");

    await queue.processQueue();

    expect(archived).toEqual(["e1", "e3"]);
    expect(trashed).toEqual(["e2"]);
    expect(queue.pendingCount).toBe(0);
  });

  test("processQueue is a no-op when queue is empty", async () => {
    const queue = new TestPendingActionsQueue();
    // Should not throw
    await queue.processQueue();
    expect(queue.pendingCount).toBe(0);
  });
});

test.describe("PendingActionsQueue - Network Errors", () => {
  test("network error re-queues the failed item and remaining items", async () => {
    let callCount = 0;
    const client = createMockClient({
      archiveMessage: async () => {
        callCount++;
        if (callCount === 2) {
          throw new Error("ECONNRESET: connection reset");
        }
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "e1", "a1");
    queue.enqueue("archive", "e2", "a1"); // This will fail with network error
    queue.enqueue("archive", "e3", "a1"); // Should be re-queued too

    await queue.processQueue();

    // e1 succeeded, e2 + e3 should be re-queued
    expect(queue.pendingCount).toBe(2);
    expect(queue.queue[0].emailId).toBe("e2");
    expect(queue.queue[1].emailId).toBe("e3");
    // Should have gone offline
    expect(queue.isOnline).toBe(false);
  });

  test("network error does not increment retry count", async () => {
    const client = createMockClient({
      archiveMessage: async () => {
        throw new Error("ETIMEDOUT");
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "e1", "a1");

    await queue.processQueue();

    // Should be re-queued with retryCount still 0 (network errors don't count)
    expect(queue.pendingCount).toBe(1);
    expect(queue.queue[0].retryCount).toBe(0);
  });

  test("various network error patterns are detected", async () => {
    const networkErrors = [
      "ENOTFOUND: DNS resolution failed",
      "ETIMEDOUT: request timed out",
      "ECONNREFUSED: connection refused",
      "ECONNRESET: connection reset by peer",
      "socket hang up",
      "network error occurred",
    ];

    for (const errMsg of networkErrors) {
      const client = createMockClient({
        archiveMessage: async () => { throw new Error(errMsg); },
      });

      const queue = new TestPendingActionsQueue();
      queue.setClientResolver(() => client);
      queue.enqueue("archive", "e1", "a1");

      await queue.processQueue();

      expect(queue.pendingCount).toBe(1);
      // Reset for next iteration
    }
  });
});

test.describe("PendingActionsQueue - Non-Network Errors & Retries", () => {
  test("non-network error increments retry count and re-queues", async () => {
    const client = createMockClient({
      archiveMessage: async () => {
        throw new Error("Invalid credentials");
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "e1", "a1");

    // First attempt
    await queue.processQueue();
    expect(queue.pendingCount).toBe(1);
    expect(queue.queue[0].retryCount).toBe(1);

    // Second attempt
    await queue.processQueue();
    expect(queue.pendingCount).toBe(1);
    expect(queue.queue[0].retryCount).toBe(2);
  });

  test("permanent failure after MAX_RETRIES emits action-failed", async () => {
    const client = createMockClient({
      archiveMessage: async () => {
        throw new Error("Invalid credentials");
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "e1", "a1");

    const failures: any[] = [];
    queue.on("action-failed", (data) => failures.push(data));

    // Process MAX_RETRIES times
    for (let i = 0; i < MAX_RETRIES; i++) {
      await queue.processQueue();
    }

    // Should have emitted action-failed
    expect(failures).toHaveLength(1);
    expect(failures[0].emailId).toBe("e1");
    expect(failures[0].accountId).toBe("a1");
    expect(failures[0].action).toBe("archive");
    expect(failures[0].error).toBe("Invalid credentials");

    // Queue should be empty now (permanently failed item removed)
    expect(queue.pendingCount).toBe(0);
  });

  test("permanent failure for trash action reports correct action type", async () => {
    const client = createMockClient({
      trashMessage: async () => {
        throw new Error("Permission denied");
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("trash", "e1", "a1");

    const failures: any[] = [];
    queue.on("action-failed", (data) => failures.push(data));

    for (let i = 0; i < MAX_RETRIES; i++) {
      await queue.processQueue();
    }

    expect(failures).toHaveLength(1);
    expect(failures[0].action).toBe("trash");
  });
});

test.describe("PendingActionsQueue - Client Not Connected", () => {
  test("missing client re-queues and eventually fails permanently", async () => {
    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => null); // No client available
    queue.enqueue("archive", "e1", "a1");

    const failures: any[] = [];
    queue.on("action-failed", (data) => failures.push(data));

    for (let i = 0; i < MAX_RETRIES; i++) {
      await queue.processQueue();
    }

    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBe("Account not connected");
    expect(queue.pendingCount).toBe(0);
  });

  test("routes to correct account client", async () => {
    const archivedA: string[] = [];
    const archivedB: string[] = [];

    const clientA = createMockClient({
      archiveMessage: async (id) => { archivedA.push(id); },
    });
    const clientB = createMockClient({
      archiveMessage: async (id) => { archivedB.push(id); },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver((accountId) => {
      if (accountId === "a1") return clientA;
      if (accountId === "a2") return clientB;
      return null;
    });

    queue.enqueue("archive", "e1", "a1");
    queue.enqueue("archive", "e2", "a2");
    queue.enqueue("archive", "e3", "a1");

    await queue.processQueue();

    expect(archivedA).toEqual(["e1", "e3"]);
    expect(archivedB).toEqual(["e2"]);
  });
});

test.describe("PendingActionsQueue - Offline During Processing", () => {
  test("going offline mid-processing re-queues remaining items", async () => {
    let callCount = 0;
    const queue = new TestPendingActionsQueue();

    const client = createMockClient({
      archiveMessage: async () => {
        callCount++;
        if (callCount === 2) {
          // Simulate going offline between items
          queue.isOnline = false;
        }
      },
    });

    queue.setClientResolver(() => client);
    queue.enqueue("archive", "e1", "a1");
    queue.enqueue("archive", "e2", "a1");
    queue.enqueue("archive", "e3", "a1");
    queue.enqueue("archive", "e4", "a1");

    await queue.processQueue();

    // e1 processed, e2 processed (but set offline after), e3 and e4 re-queued
    expect(callCount).toBe(2);
    expect(queue.pendingCount).toBe(2);
    expect(queue.queue[0].emailId).toBe("e3");
    expect(queue.queue[1].emailId).toBe("e4");
  });

  test("processQueue is idempotent when already processing", async () => {
    const archived: string[] = [];
    const client = createMockClient({
      archiveMessage: async (id) => {
        archived.push(id);
        // Simulate slow operation
        await new Promise((r) => setTimeout(r, 50));
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "e1", "a1");
    queue.enqueue("archive", "e2", "a1");

    // Start two processQueue calls concurrently
    const p1 = queue.processQueue();
    const p2 = queue.processQueue(); // Should be a no-op (already processing)

    await Promise.all([p1, p2]);

    // Should only process once
    expect(archived).toEqual(["e1", "e2"]);
  });
});

test.describe("isNetworkError detection", () => {
  test("identifies ENOTFOUND as network error", () => {
    expect(isNetworkError(new Error("getaddrinfo ENOTFOUND gmail.googleapis.com"))).toBe(true);
  });

  test("identifies ETIMEDOUT as network error", () => {
    expect(isNetworkError(new Error("connect ETIMEDOUT 142.250.80.106:443"))).toBe(true);
  });

  test("identifies ECONNREFUSED as network error", () => {
    expect(isNetworkError(new Error("connect ECONNREFUSED 127.0.0.1:443"))).toBe(true);
  });

  test("identifies ECONNRESET as network error", () => {
    expect(isNetworkError(new Error("read ECONNRESET"))).toBe(true);
  });

  test("identifies socket hang up as network error", () => {
    expect(isNetworkError(new Error("socket hang up"))).toBe(true);
  });

  test("identifies error code properties as network error", () => {
    const err = new Error("Something failed") as any;
    err.code = "ECONNRESET";
    expect(isNetworkError(err)).toBe(true);
  });

  test("non-network errors are not identified as network errors", () => {
    expect(isNetworkError(new Error("Invalid credentials"))).toBe(false);
    expect(isNetworkError(new Error("Permission denied"))).toBe(false);
    expect(isNetworkError(new Error("Not found"))).toBe(false);
    expect(isNetworkError(new Error("Token expired"))).toBe(false);
  });
});
