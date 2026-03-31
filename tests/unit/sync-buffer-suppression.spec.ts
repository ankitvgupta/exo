/**
 * Tests that the sync buffer's flush logic correctly suppresses emails
 * that are pending in the undo action queue (archive/trash).
 *
 * Reproduces the bug: user batch-archives 30+ emails, sync runs before
 * the API calls complete, and the emails reappear because the sync buffer
 * didn't check the undo action queue.
 *
 * The flush function is module-private and uses browser APIs, so we
 * extract and test the pure filtering logic inline (same pattern as
 * store-selectors.spec.ts).
 */
import { test, expect } from "@playwright/test";
import type { DashboardEmail } from "../../src/shared/types";
import type { UndoActionItem } from "../../src/renderer/store";

// --- Helpers ---

function makeEmail(id: string, threadId: string): DashboardEmail {
  return {
    id,
    threadId,
    subject: `Subject ${id}`,
    from: `sender@example.com`,
    to: "user@example.com",
    date: new Date().toISOString(),
    body: `<div>Body ${id}</div>`,
    snippet: `Snippet ${id}`,
    labelIds: ["INBOX", "UNREAD"],
    accountId: "account-1",
  };
}

// --- Pure logic extracted from useSyncBuffer.ts flush() ---
// This mirrors the "additions" section of flush to test the filtering.

function filterSyncAdds(
  adds: DashboardEmail[],
  storeEmails: DashboardEmail[],
  pendingRemovals: Map<string, DashboardEmail[]>,
  undoActionQueue: UndoActionItem[],
): { brandNew: DashboardEmail[]; reEmitUpdates: Map<string, Partial<DashboardEmail>> } {
  const existingIds = new Set(storeEmails.map((e) => e.id));
  const pendingRemovalIds = new Set(
    Array.from(pendingRemovals.values()).flatMap((arr) => arr.map((e) => e.id)),
  );
  // The fix: also check undo action queue for archive/trash
  for (const action of undoActionQueue) {
    if (action.type === "archive" || action.type === "trash") {
      for (const e of action.emails) {
        pendingRemovalIds.add(e.id);
      }
    }
  }

  const brandNew: DashboardEmail[] = [];
  const reEmitUpdates = new Map<string, Partial<DashboardEmail>>();
  const seen = new Set<string>();

  for (const e of adds) {
    if (pendingRemovalIds.has(e.id) || seen.has(e.id)) continue;
    seen.add(e.id);

    if (existingIds.has(e.id)) {
      const changes: Partial<DashboardEmail> = {};
      if (e.analysis !== undefined) changes.analysis = e.analysis;
      if (e.draft !== undefined) changes.draft = e.draft;
      if (Object.keys(changes).length > 0) {
        reEmitUpdates.set(e.id, changes);
      }
    } else {
      brandNew.push(e);
      existingIds.add(e.id);
    }
  }

  return { brandNew, reEmitUpdates };
}

// --- Tests ---

test.describe("sync buffer suppression for undo action queue", () => {
  test("emails in undo archive queue are suppressed from sync adds", () => {
    // Simulate: user batch-archived 3 threads (6 emails)
    const archivedEmails = [
      makeEmail("e1", "t1"),
      makeEmail("e2", "t1"),
      makeEmail("e3", "t2"),
      makeEmail("e4", "t2"),
      makeEmail("e5", "t3"),
      makeEmail("e6", "t3"),
    ];

    const undoQueue: UndoActionItem[] = [
      {
        id: "archive-batch-123",
        type: "archive",
        emails: archivedEmails,
        threadCount: 3,
        accountId: "account-1",
        scheduledAt: Date.now(),
        delayMs: 5000,
      },
    ];

    // Store is empty (emails were removed optimistically)
    const storeEmails: DashboardEmail[] = [];
    const pendingRemovals = new Map<string, DashboardEmail[]>();

    // Sync tries to add these emails back
    const syncAdds = archivedEmails.map((e) => ({ ...e }));

    const { brandNew } = filterSyncAdds(syncAdds, storeEmails, pendingRemovals, undoQueue);

    // None should be re-added
    expect(brandNew).toHaveLength(0);
  });

  test("emails in undo trash queue are suppressed from sync adds", () => {
    const trashedEmails = [makeEmail("e1", "t1"), makeEmail("e2", "t2")];

    const undoQueue: UndoActionItem[] = [
      {
        id: "trash-batch-123",
        type: "trash",
        emails: trashedEmails,
        threadCount: 2,
        accountId: "account-1",
        scheduledAt: Date.now(),
        delayMs: 5000,
      },
    ];

    const { brandNew } = filterSyncAdds(
      trashedEmails.map((e) => ({ ...e })),
      [],
      new Map(),
      undoQueue,
    );

    expect(brandNew).toHaveLength(0);
  });

  test("non-archive/trash undo actions do NOT suppress sync adds", () => {
    const emails = [makeEmail("e1", "t1")];

    // mark-unread should not suppress
    const undoQueue: UndoActionItem[] = [
      {
        id: "mark-unread-batch-123",
        type: "mark-unread",
        emails,
        threadCount: 1,
        accountId: "account-1",
        scheduledAt: Date.now(),
        delayMs: 5000,
      },
    ];

    const { brandNew } = filterSyncAdds(
      emails.map((e) => ({ ...e })),
      [],
      new Map(),
      undoQueue,
    );

    // Should be added — mark-unread doesn't remove from store
    expect(brandNew).toHaveLength(1);
  });

  test("genuinely new emails are still added alongside suppressed ones", () => {
    const archivedEmails = [makeEmail("e1", "t1"), makeEmail("e2", "t1")];
    const newEmail = makeEmail("e-new", "t-new");

    const undoQueue: UndoActionItem[] = [
      {
        id: "archive-batch-123",
        type: "archive",
        emails: archivedEmails,
        threadCount: 1,
        accountId: "account-1",
        scheduledAt: Date.now(),
        delayMs: 5000,
      },
    ];

    // Sync adds both the archived emails AND a genuinely new one
    const syncAdds = [...archivedEmails.map((e) => ({ ...e })), { ...newEmail }];

    const { brandNew } = filterSyncAdds(syncAdds, [], new Map(), undoQueue);

    expect(brandNew).toHaveLength(1);
    expect(brandNew[0].id).toBe("e-new");
  });

  test("multiple undo actions in queue all contribute to suppression", () => {
    const batch1 = [makeEmail("e1", "t1"), makeEmail("e2", "t2")];
    const batch2 = [makeEmail("e3", "t3"), makeEmail("e4", "t4")];

    const undoQueue: UndoActionItem[] = [
      {
        id: "archive-batch-1",
        type: "archive",
        emails: batch1,
        threadCount: 2,
        accountId: "account-1",
        scheduledAt: Date.now(),
        delayMs: 5000,
      },
      {
        id: "trash-batch-2",
        type: "trash",
        emails: batch2,
        threadCount: 2,
        accountId: "account-1",
        scheduledAt: Date.now(),
        delayMs: 5000,
      },
    ];

    const allEmails = [...batch1, ...batch2];
    const { brandNew } = filterSyncAdds(
      allEmails.map((e) => ({ ...e })),
      [],
      new Map(),
      undoQueue,
    );

    expect(brandNew).toHaveLength(0);
  });

  test("pendingRemovals still suppresses (backwards compat)", () => {
    const email = makeEmail("e1", "t1");

    const pendingRemovals = new Map<string, DashboardEmail[]>();
    pendingRemovals.set("e1", [email]);

    const { brandNew } = filterSyncAdds(
      [{ ...email }],
      [],
      pendingRemovals,
      [], // empty undo queue
    );

    expect(brandNew).toHaveLength(0);
  });

  test("large batch (30+ emails) suppression works correctly", () => {
    // The actual bug scenario: 30+ emails archived at once
    const emailCount = 35;
    const emails = Array.from({ length: emailCount }, (_, i) =>
      makeEmail(`e${i}`, `t${Math.floor(i / 2)}`),
    );

    const undoQueue: UndoActionItem[] = [
      {
        id: "archive-batch-big",
        type: "archive",
        emails,
        threadCount: Math.ceil(emailCount / 2),
        accountId: "account-1",
        scheduledAt: Date.now(),
        delayMs: 5000,
      },
    ];

    const syncAdds = emails.map((e) => ({ ...e }));
    const { brandNew } = filterSyncAdds(syncAdds, [], new Map(), undoQueue);

    expect(brandNew).toHaveLength(0);
  });
});
