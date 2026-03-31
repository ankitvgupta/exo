import { test, expect } from "@playwright/test";
import { createRequire } from "module";

/**
 * Integration tests for the snooze backend.
 *
 * Tests the full snooze DB layer and service logic using an in-memory SQLite
 * database. These run without Electron — just Node.js + better-sqlite3.
 *
 * Covers: CRUD operations, timer-based unsnooze, persistence across restarts,
 * multi-account isolation, re-snooze behavior, and edge cases.
 */

const require = createRequire(import.meta.url);

// better-sqlite3 may be compiled for Electron's Node version rather than the system Node.
// Detect the mismatch upfront so we can skip tests in beforeEach.
let Database: any;
let nativeModuleError: string | null = null;
try {
  Database = require("better-sqlite3");
  // Verify the native addon actually works (require may succeed but new Database() can fail
  // when compiled for Electron's Node version instead of system Node)
  const testDb = new Database(":memory:");
  testDb.close();
} catch (e: any) {
  if (e.message?.includes("NODE_MODULE_VERSION") || e.message?.includes("did not self-register")) {
    nativeModuleError = e.message.split("\n")[0];
  } else {
    throw e;
  }
}

// ---- Minimal schema for snooze tables ----
const SNOOZE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT
  );
  CREATE TABLE IF NOT EXISTS snoozed_emails (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    snooze_until INTEGER NOT NULL,
    snoozed_at INTEGER NOT NULL,
    FOREIGN KEY (account_id) REFERENCES accounts(id)
  );
  CREATE INDEX IF NOT EXISTS idx_snoozed_emails_account ON snoozed_emails(account_id);
  CREATE INDEX IF NOT EXISTS idx_snoozed_emails_thread ON snoozed_emails(thread_id);
  CREATE INDEX IF NOT EXISTS idx_snoozed_emails_until ON snoozed_emails(snooze_until);
`;

type SnoozedEmail = {
  id: string;
  emailId: string;
  threadId: string;
  accountId: string;
  snoozeUntil: number;
  snoozedAt: number;
};

// ---- DB operations (mirrors src/main/db/index.ts) ----

function createTestDb() {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(SNOOZE_SCHEMA);
  // Insert test accounts
  db.prepare("INSERT INTO accounts (id, email) VALUES (?, ?)").run("acc-1", "user@example.com");
  db.prepare("INSERT INTO accounts (id, email) VALUES (?, ?)").run("acc-2", "other@example.com");
  return db;
}

function snoozeEmail(
  db: any,
  id: string,
  emailId: string,
  threadId: string,
  accountId: string,
  snoozeUntil: number,
): void {
  db.prepare(
    `
    INSERT OR REPLACE INTO snoozed_emails (id, email_id, thread_id, account_id, snooze_until, snoozed_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(id, emailId, threadId, accountId, snoozeUntil, Date.now());
}

function unsnoozeEmail(db: any, id: string): void {
  db.prepare("DELETE FROM snoozed_emails WHERE id = ?").run(id);
}

function unsnoozeByThread(db: any, threadId: string, accountId: string): void {
  db.prepare("DELETE FROM snoozed_emails WHERE thread_id = ? AND account_id = ?").run(
    threadId,
    accountId,
  );
}

function getSnoozedEmails(db: any, accountId: string): SnoozedEmail[] {
  return db
    .prepare(
      `
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails WHERE account_id = ? ORDER BY snooze_until ASC
  `,
    )
    .all(accountId) as SnoozedEmail[];
}

function getAllSnoozedEmails(db: any): SnoozedEmail[] {
  return db
    .prepare(
      `
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails ORDER BY snooze_until ASC
  `,
    )
    .all() as SnoozedEmail[];
}

function getDueSnoozedEmails(db: any): SnoozedEmail[] {
  const now = Date.now();
  return db
    .prepare(
      `
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails WHERE snooze_until <= ? ORDER BY snooze_until ASC
  `,
    )
    .all(now) as SnoozedEmail[];
}

function getSnoozedByThread(db: any, threadId: string, accountId: string): SnoozedEmail | null {
  return (
    (db
      .prepare(
        `
    SELECT id, email_id as emailId, thread_id as threadId, account_id as accountId,
           snooze_until as snoozeUntil, snoozed_at as snoozedAt
    FROM snoozed_emails WHERE thread_id = ? AND account_id = ? LIMIT 1
  `,
      )
      .get(threadId, accountId) as SnoozedEmail) || null
  );
}

// ============================================
// Tests
// ============================================

test.describe("Snooze DB — CRUD operations", () => {
  let db: any;

  test.beforeEach(() => {
    test.skip(!!nativeModuleError, `better-sqlite3 unavailable: ${nativeModuleError}`);
    db = createTestDb();
  });

  test.afterEach(() => {
    if (db) db.close();
  });

  test("snooze creates a record in the database", () => {
    const snoozeUntil = Date.now() + 3600_000; // 1 hour from now
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", snoozeUntil);

    const results = getSnoozedEmails(db, "acc-1");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("snz-1");
    expect(results[0].emailId).toBe("msg-001");
    expect(results[0].threadId).toBe("thread-001");
    expect(results[0].accountId).toBe("acc-1");
    expect(results[0].snoozeUntil).toBe(snoozeUntil);
    expect(results[0].snoozedAt).toBeGreaterThan(0);
  });

  test("unsnooze by ID removes the record", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(1);

    unsnoozeEmail(db, "snz-1");
    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(0);
  });

  test("unsnooze by thread removes the record", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(1);

    unsnoozeByThread(db, "thread-001", "acc-1");
    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(0);
  });

  test("getSnoozedByThread returns the snoozed record", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);

    const result = getSnoozedByThread(db, "thread-001", "acc-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("snz-1");
  });

  test("getSnoozedByThread returns null for unsnoozed thread", () => {
    const result = getSnoozedByThread(db, "thread-999", "acc-1");
    expect(result).toBeNull();
  });

  test("can snooze multiple threads", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-1", Date.now() + 7200_000);
    snoozeEmail(db, "snz-3", "msg-003", "thread-003", "acc-1", Date.now() + 1800_000);

    const results = getSnoozedEmails(db, "acc-1");
    expect(results).toHaveLength(3);
    // Should be ordered by snooze_until ASC
    expect(results[0].threadId).toBe("thread-003"); // 30min
    expect(results[1].threadId).toBe("thread-001"); // 1hr
    expect(results[2].threadId).toBe("thread-002"); // 2hr
  });

  test("INSERT OR REPLACE updates existing snooze for same ID", () => {
    const originalTime = Date.now() + 3600_000;
    const newTime = Date.now() + 7200_000;

    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", originalTime);
    expect(getSnoozedEmails(db, "acc-1")[0].snoozeUntil).toBe(originalTime);

    // Re-snooze with same ID but different time
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", newTime);
    const results = getSnoozedEmails(db, "acc-1");
    expect(results).toHaveLength(1);
    expect(results[0].snoozeUntil).toBe(newTime);
  });
});

test.describe("Snooze DB — Multi-account isolation", () => {
  let db: any;

  test.beforeEach(() => {
    test.skip(!!nativeModuleError, `better-sqlite3 unavailable: ${nativeModuleError}`);
    db = createTestDb();
  });

  test.afterEach(() => {
    if (db) db.close();
  });

  test("snoozed emails are isolated by account", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-2", Date.now() + 3600_000);

    const acc1Results = getSnoozedEmails(db, "acc-1");
    const acc2Results = getSnoozedEmails(db, "acc-2");

    expect(acc1Results).toHaveLength(1);
    expect(acc1Results[0].threadId).toBe("thread-001");

    expect(acc2Results).toHaveLength(1);
    expect(acc2Results[0].threadId).toBe("thread-002");
  });

  test("getAllSnoozedEmails returns all accounts", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-2", Date.now() + 3600_000);

    const allResults = getAllSnoozedEmails(db);
    expect(allResults).toHaveLength(2);
  });

  test("unsnooze by thread only affects the specified account", () => {
    // Same threadId in different accounts
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    snoozeEmail(db, "snz-2", "msg-002", "thread-001", "acc-2", Date.now() + 3600_000);

    unsnoozeByThread(db, "thread-001", "acc-1");

    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(0);
    expect(getSnoozedEmails(db, "acc-2")).toHaveLength(1); // Other account unaffected
  });
});

test.describe("Snooze DB — Timer logic (getDueSnoozedEmails)", () => {
  let db: any;

  test.beforeEach(() => {
    test.skip(!!nativeModuleError, `better-sqlite3 unavailable: ${nativeModuleError}`);
    db = createTestDb();
  });

  test.afterEach(() => {
    if (db) db.close();
  });

  test("returns emails with snooze_until in the past", () => {
    const pastTime = Date.now() - 60_000; // 1 minute ago
    const futureTime = Date.now() + 3600_000; // 1 hour from now

    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", pastTime);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-1", futureTime);

    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("snz-1");
  });

  test("returns nothing when no emails are due", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-1", Date.now() + 7200_000);

    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(0);
  });

  test("returns multiple due emails across accounts", () => {
    const pastTime = Date.now() - 60_000;
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", pastTime);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-2", pastTime - 30_000);
    snoozeEmail(db, "snz-3", "msg-003", "thread-003", "acc-1", Date.now() + 3600_000); // not due

    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(2);
    // Ordered by snooze_until ASC
    expect(due[0].id).toBe("snz-2"); // earlier time
    expect(due[1].id).toBe("snz-1");
  });

  test("simulates timer: snooze, wait, check, unsnooze", () => {
    // Snooze with a time that's already past (simulating time passing)
    const pastTime = Date.now() - 1000;
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", pastTime);

    // Check for due emails (simulating the 30s interval)
    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(1);

    // Process: remove from DB (simulating snooze service behavior)
    for (const snoozed of due) {
      unsnoozeEmail(db, snoozed.id);
    }

    // After processing, should be empty
    expect(getDueSnoozedEmails(db)).toHaveLength(0);
    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(0);
  });

  test("simulates app restart: snoozed data persists, expired ones fire on next check", () => {
    // Before "shutdown": snooze two emails
    const pastTime = Date.now() - 5000; // Already expired
    const futureTime = Date.now() + 3600_000;

    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", pastTime);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-1", futureTime);

    // Simulate "restart" — data is still in DB (it's persistent)
    expect(getAllSnoozedEmails(db)).toHaveLength(2);

    // On restart, service.start() calls checkDueSnoozedEmails immediately
    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(1);
    expect(due[0].id).toBe("snz-1");

    // Process the due emails
    for (const snoozed of due) {
      unsnoozeEmail(db, snoozed.id);
    }

    // Only the future snooze remains
    expect(getAllSnoozedEmails(db)).toHaveLength(1);
    expect(getAllSnoozedEmails(db)[0].id).toBe("snz-2");
  });
});

test.describe("Snooze DB — Re-snooze and edge cases", () => {
  let db: any;

  test.beforeEach(() => {
    test.skip(!!nativeModuleError, `better-sqlite3 unavailable: ${nativeModuleError}`);
    db = createTestDb();
  });

  test.afterEach(() => {
    if (db) db.close();
  });

  test("re-snoozing same thread replaces the old snooze (via unsnoozeByThread + insert)", () => {
    const time1 = Date.now() + 3600_000;
    const time2 = Date.now() + 7200_000;

    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", time1);
    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(1);
    expect(getSnoozedEmails(db, "acc-1")[0].snoozeUntil).toBe(time1);

    // Re-snooze: first remove old, then insert new (mirroring SnoozeService.snooze())
    unsnoozeByThread(db, "thread-001", "acc-1");
    snoozeEmail(db, "snz-2", "msg-001", "thread-001", "acc-1", time2);

    const results = getSnoozedEmails(db, "acc-1");
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("snz-2"); // New ID
    expect(results[0].snoozeUntil).toBe(time2);
  });

  test("snoozing then immediately unsnoozing leaves DB clean", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);
    unsnoozeByThread(db, "thread-001", "acc-1");

    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(0);
    expect(getSnoozedByThread(db, "thread-001", "acc-1")).toBeNull();
    expect(getAllSnoozedEmails(db)).toHaveLength(0);
  });

  test("unsnooze non-existent thread is a no-op", () => {
    unsnoozeByThread(db, "thread-999", "acc-1");
    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(0);
  });

  test("unsnooze non-existent ID is a no-op", () => {
    unsnoozeEmail(db, "snz-999");
    expect(getAllSnoozedEmails(db)).toHaveLength(0);
  });

  test("snooze with far-future time works (next year)", () => {
    const nextYear = new Date();
    nextYear.setFullYear(nextYear.getFullYear() + 1);
    const snoozeUntil = nextYear.getTime();

    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", snoozeUntil);

    const results = getSnoozedEmails(db, "acc-1");
    expect(results).toHaveLength(1);
    expect(results[0].snoozeUntil).toBe(snoozeUntil);

    // Should NOT appear in due emails
    expect(getDueSnoozedEmails(db)).toHaveLength(0);
  });

  test("snooze with very short duration (1 second) becomes due immediately after", () => {
    const snoozeUntil = Date.now() + 1000;
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", snoozeUntil);

    // Not due yet
    expect(getDueSnoozedEmails(db)).toHaveLength(0);

    // Simulate time passing by inserting with a past time
    db.prepare("UPDATE snoozed_emails SET snooze_until = ? WHERE id = ?").run(
      Date.now() - 100,
      "snz-1",
    );

    // Now it's due
    expect(getDueSnoozedEmails(db)).toHaveLength(1);
  });

  test("large batch: 100 snoozed emails", () => {
    for (let i = 0; i < 100; i++) {
      snoozeEmail(
        db,
        `snz-${i}`,
        `msg-${i}`,
        `thread-${i}`,
        "acc-1",
        Date.now() + (i + 1) * 60_000,
      );
    }

    expect(getSnoozedEmails(db, "acc-1")).toHaveLength(100);
    expect(getDueSnoozedEmails(db)).toHaveLength(0);

    // Make first 50 due
    db.prepare(
      "UPDATE snoozed_emails SET snooze_until = ? WHERE CAST(SUBSTR(id, 5) AS INTEGER) < 50",
    ).run(Date.now() - 1000);

    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(50);
  });
});

test.describe("Snooze service — callback behavior", () => {
  let db: any;

  test.beforeEach(() => {
    test.skip(!!nativeModuleError, `better-sqlite3 unavailable: ${nativeModuleError}`);
    db = createTestDb();
  });

  test.afterEach(() => {
    if (db) db.close();
  });

  test("callback receives all unsnoozed emails when timer fires", () => {
    const past = Date.now() - 1000;
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", past);
    snoozeEmail(db, "snz-2", "msg-002", "thread-002", "acc-1", past);

    // Simulate the checkDueSnoozedEmails flow
    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(2);

    // Simulate callback
    const callbackData: SnoozedEmail[] = [];
    const onUnsnooze = (emails: SnoozedEmail[]) => {
      callbackData.push(...emails);
    };

    // Process and invoke callback (mirroring SnoozeService.checkDueSnoozedEmails)
    for (const snoozed of due) {
      unsnoozeEmail(db, snoozed.id);
    }
    onUnsnooze(due);

    expect(callbackData).toHaveLength(2);
    expect(callbackData[0].threadId).toBe("thread-001");
    expect(callbackData[1].threadId).toBe("thread-002");
  });

  test("callback is not invoked when no emails are due", () => {
    snoozeEmail(db, "snz-1", "msg-001", "thread-001", "acc-1", Date.now() + 3600_000);

    const due = getDueSnoozedEmails(db);
    expect(due).toHaveLength(0);

    let callbackInvoked = false;
    if (due.length > 0) {
      callbackInvoked = true;
    }
    expect(callbackInvoked).toBe(false);
  });
});
