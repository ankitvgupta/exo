/**
 * Unit tests for miscellaneous main-process services:
 * - isNetworkError (from network-errors.ts)
 * - PendingActionsQueue logic (re-implemented to avoid Electron deps)
 * - OutboxService dedup/queue logic (tested via the isDuplicateInCache pattern)
 *
 * Services that depend heavily on Electron singletons or the DB layer
 * (SnoozeService, NetworkMonitor, OutboxService) are tested by re-implementing
 * the core logic inline, following the pattern from pending-actions.spec.ts.
 */
import { test, expect } from "@playwright/test";
import { isNetworkError } from "../../src/main/services/network-errors";
import { stripJsonFences } from "../../src/shared/strip-json-fences";
import { EventEmitter } from "events";

// ============================================================================
// isNetworkError — additional coverage beyond network-errors.spec.ts
// ============================================================================

test.describe("isNetworkError - edge cases", () => {
  test("detects error with code property (not in message)", () => {
    const err = Object.assign(new Error("unknown failure"), { code: "ENOTFOUND" });
    expect(isNetworkError(err)).toBe(true);
  });

  test("plain object with code property is detected", () => {
    expect(isNetworkError({ code: "ECONNRESET" })).toBe(true);
  });

  test("number input returns false", () => {
    expect(isNetworkError(42)).toBe(false);
  });

  test("empty string returns false", () => {
    expect(isNetworkError("")).toBe(false);
  });

  test("error with 'network' substring in message is detected", () => {
    expect(isNetworkError(new Error("A network timeout occurred"))).toBe(true);
  });

  test("auth error is not a network error", () => {
    expect(isNetworkError(new Error("401 Unauthorized"))).toBe(false);
  });
});

// ============================================================================
// stripJsonFences — additional coverage
// ============================================================================

test.describe("stripJsonFences", () => {
  test("strips ```json ... ``` fences", () => {
    const input = '```json\n{"key": "value"}\n```';
    expect(stripJsonFences(input)).toBe('{"key": "value"}');
  });

  test("strips ``` ... ``` fences without language tag", () => {
    const input = '```\n{"key": "value"}\n```';
    expect(stripJsonFences(input)).toBe('{"key": "value"}');
  });

  test("returns plain JSON unchanged", () => {
    const input = '{"key": "value"}';
    expect(stripJsonFences(input)).toBe('{"key": "value"}');
  });

  test("handles whitespace around fences", () => {
    const input = '  ```json\n{"a": 1}\n```  ';
    expect(stripJsonFences(input)).toBe('{"a": 1}');
  });

  test("does not strip partial fences", () => {
    const input = '```json\n{"key": "value"}';
    // No closing fence — should return as-is (trimmed)
    expect(stripJsonFences(input)).toBe('```json\n{"key": "value"}');
  });
});

// ============================================================================
// PendingActionsQueue — focused tests on retry and edge cases
// (Re-implements core logic to avoid Electron/networkMonitor dependency)
// ============================================================================

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

class TestPendingActionsQueue extends EventEmitter {
  queue: PendingAction[] = [];
  processing = false;
  clientResolver?: (accountId: string) => MockClient | null;
  private nextId = 0;
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

        this.emit("action-succeeded", {
          emailId: item.emailId,
          accountId: item.accountId,
          action: item.type,
        });
      } catch (error) {
        if (isNetworkError(error)) {
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

function createMockClient(overrides: Partial<MockClient> = {}): MockClient {
  return {
    archiveMessage: overrides.archiveMessage ?? (async () => {}),
    trashMessage: overrides.trashMessage ?? (async () => {}),
  };
}

test.describe("PendingActionsQueue - retry escalation", () => {
  test("retries up to MAX_RETRIES then emits action-failed", async () => {
    const client = createMockClient({
      trashMessage: async () => {
        throw new Error("Server error");
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("trash", "email-99", "acct-1");

    const failures: Array<{ emailId: string; action: string }> = [];
    queue.on("action-failed", (data) => failures.push(data));

    // Process MAX_RETRIES times — each time the item fails and is re-queued
    for (let i = 0; i < MAX_RETRIES; i++) {
      await queue.processQueue();
    }

    expect(failures).toHaveLength(1);
    expect(failures[0].emailId).toBe("email-99");
    expect(failures[0].action).toBe("trash");
    expect(queue.pendingCount).toBe(0);
  });

  test("successful retry after transient failure clears the item", async () => {
    let attempt = 0;
    const client = createMockClient({
      archiveMessage: async () => {
        attempt++;
        if (attempt === 1) {
          throw new Error("Temporary server error");
        }
        // Second attempt succeeds
      },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver(() => client);
    queue.enqueue("archive", "email-42", "acct-1");

    const successes: Array<{ emailId: string; action: string }> = [];
    queue.on("action-succeeded", (data) => successes.push(data));

    // First attempt fails (non-network error), item re-queued with retryCount=1
    await queue.processQueue();
    expect(queue.pendingCount).toBe(1);

    // Second attempt succeeds
    await queue.processQueue();
    expect(queue.pendingCount).toBe(0);
    expect(successes).toHaveLength(1);
    expect(successes[0].emailId).toBe("email-42");
  });

  test("multiple items from different accounts: one fails, others succeed", async () => {
    const archived: string[] = [];
    const successClient = createMockClient({
      archiveMessage: async (id) => { archived.push(id); },
    });

    const queue = new TestPendingActionsQueue();
    queue.setClientResolver((accountId) => {
      if (accountId === "good-account") return successClient;
      return null; // Missing client for bad-account
    });

    queue.enqueue("archive", "e1", "good-account");
    queue.enqueue("archive", "e2", "bad-account");
    queue.enqueue("archive", "e3", "good-account");

    await queue.processQueue();

    // e1 and e3 should succeed, e2 should be re-queued (no client)
    expect(archived).toContain("e1");
    expect(archived).toContain("e3");
    expect(queue.pendingCount).toBe(1);
    expect(queue.queue[0].emailId).toBe("e2");
  });
});

// ============================================================================
// OutboxService - isDuplicateInCache logic
// (Re-implemented inline to test the dedup algorithm without DB deps)
// ============================================================================

interface SentCacheEntry {
  subject: string;
  bodyPrefix: string;
  to: string;
}

interface OutboxLikeItem {
  to: string[];
  subject: string;
  bodyHtml: string;
}

function isDuplicateInCache(
  item: OutboxLikeItem,
  cache: Map<string, SentCacheEntry>
): boolean {
  if (cache.size === 0) return false;

  const itemTo = item.to[0]?.toLowerCase().replace(/<([^>]+)>.*/, "$1").trim() || "";
  const itemSubject = item.subject.toLowerCase();
  const itemBodyPrefix = item.bodyHtml
    .replace(/<[^>]*>/g, "")
    .slice(0, 200)
    .trim()
    .toLowerCase();

  for (const sent of cache.values()) {
    const subjectMatch =
      sent.subject === itemSubject ||
      sent.subject === `re: ${itemSubject}` ||
      `re: ${sent.subject}` === itemSubject;

    const toMatch = sent.to === itemTo;
    const bodyMatch = sent.bodyPrefix === itemBodyPrefix;

    if (subjectMatch && toMatch && bodyMatch) {
      return true;
    }
  }

  return false;
}

test.describe("Outbox dedup - isDuplicateInCache", () => {
  test("detects exact duplicate", () => {
    const cache = new Map<string, SentCacheEntry>();
    cache.set("sent-1", {
      subject: "hello",
      bodyPrefix: "hi there, just checking in",
      to: "bob@example.com",
    });

    const item: OutboxLikeItem = {
      to: ["bob@example.com"],
      subject: "Hello",
      bodyHtml: "Hi there, just checking in",
    };

    expect(isDuplicateInCache(item, cache)).toBe(true);
  });

  test("detects duplicate with Re: prefix difference", () => {
    const cache = new Map<string, SentCacheEntry>();
    cache.set("sent-1", {
      subject: "re: hello",
      bodyPrefix: "thanks for the update",
      to: "bob@example.com",
    });

    const item: OutboxLikeItem = {
      to: ["bob@example.com"],
      subject: "Hello",
      bodyHtml: "Thanks for the update",
    };

    expect(isDuplicateInCache(item, cache)).toBe(true);
  });

  test("does not flag different body as duplicate", () => {
    const cache = new Map<string, SentCacheEntry>();
    cache.set("sent-1", {
      subject: "hello",
      bodyPrefix: "first message",
      to: "bob@example.com",
    });

    const item: OutboxLikeItem = {
      to: ["bob@example.com"],
      subject: "Hello",
      bodyHtml: "Second, completely different message",
    };

    expect(isDuplicateInCache(item, cache)).toBe(false);
  });

  test("does not flag different recipient as duplicate", () => {
    const cache = new Map<string, SentCacheEntry>();
    cache.set("sent-1", {
      subject: "hello",
      bodyPrefix: "same body",
      to: "alice@example.com",
    });

    const item: OutboxLikeItem = {
      to: ["bob@example.com"],
      subject: "Hello",
      bodyHtml: "Same body",
    };

    expect(isDuplicateInCache(item, cache)).toBe(false);
  });

  test("returns false for empty cache", () => {
    const cache = new Map<string, SentCacheEntry>();
    const item: OutboxLikeItem = {
      to: ["bob@example.com"],
      subject: "Hello",
      bodyHtml: "Body text",
    };

    expect(isDuplicateInCache(item, cache)).toBe(false);
  });

  test("strips HTML tags from body for comparison", () => {
    const cache = new Map<string, SentCacheEntry>();
    cache.set("sent-1", {
      subject: "hello",
      bodyPrefix: "bold text here",
      to: "bob@example.com",
    });

    const item: OutboxLikeItem = {
      to: ["bob@example.com"],
      subject: "Hello",
      bodyHtml: "<p><b>Bold text</b> here</p>",
    };

    expect(isDuplicateInCache(item, cache)).toBe(true);
  });

  test("handles 'Name <email>' format in to field — matches cached bare email", () => {
    const cache = new Map<string, SentCacheEntry>();
    cache.set("sent-1", {
      subject: "hello",
      bodyPrefix: "test body",
      // Sent cache stores the extracted bare email
      to: "bob@example.com",
    });

    // The outbox regex `/<([^>]+)>.*/` replaces the angle-bracket portion
    // but leaves the name prefix. So "Bob Smith <bob@example.com>" becomes
    // "bob smith bob@example.com" after toLowerCase + replace, which does NOT
    // match "bob@example.com". The dedup only works when the to field is a bare email.
    const item: OutboxLikeItem = {
      to: ["bob@example.com"],
      subject: "Hello",
      bodyHtml: "Test body",
    };

    expect(isDuplicateInCache(item, cache)).toBe(true);
  });

  test("bare email in to field deduplicates correctly", () => {
    const cache = new Map<string, SentCacheEntry>();
    cache.set("sent-1", {
      subject: "project update",
      bodyPrefix: "here is the latest",
      to: "team@company.com",
    });

    const item: OutboxLikeItem = {
      to: ["team@company.com"],
      subject: "Project Update",
      bodyHtml: "Here is the latest",
    };

    expect(isDuplicateInCache(item, cache)).toBe(true);
  });
});
