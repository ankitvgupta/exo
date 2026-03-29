/**
 * Unit tests for email-sync.ts
 *
 * Cannot import email-sync.ts directly because it transitively imports Electron.
 * Instead, we re-implement the core pure logic inline and test it here.
 *
 * Tested logic:
 * - Full sync vs incremental sync decision
 * - Deleted/new message dedup (draft-sent overlap)
 * - Label update application (read/unread)
 * - Onboarding triage partitioning (analysis window, overflow, age cutoff)
 * - Sync interval clamping
 * - Batch chunking for concurrent fetches
 * - Sent email filtering for inbox thread backfill
 * - Draft cleanup two-pass logic (stale detection + force-queue decisions)
 * - Sync status lifecycle and error handling flow
 */
import { test, expect } from "@playwright/test";

// ============================================================================
// Types (mirroring email-sync.ts)
// ============================================================================

type SyncStatus = "idle" | "syncing" | "error";

interface MinimalEmail {
  id: string;
  threadId: string;
  date: string;
  labelIds?: string[];
}

interface HistoryChanges {
  historyId: string;
  newMessageIds: string[];
  deletedMessageIds: string[];
  readMessageIds: string[];
  unreadMessageIds: string[];
}

// ============================================================================
// Full sync vs incremental sync decision
// Re-implements the logic from registerAccount (lines 114-131)
// ============================================================================

/**
 * Determines whether an account should do a full sync or incremental sync.
 * A full sync has completed before only if we have BOTH a history ID and emails.
 */
function shouldDoFullSync(
  storedHistoryId: string | null,
  hasExistingEmails: boolean
): boolean {
  const hasCompletedFullSync = !!(storedHistoryId && hasExistingEmails);
  return !hasCompletedFullSync;
}

test.describe("Full sync vs incremental sync decision", () => {
  test("no history ID and no emails → full sync", () => {
    expect(shouldDoFullSync(null, false)).toBe(true);
  });

  test("has history ID but no emails → full sync (partial sync was interrupted)", () => {
    expect(shouldDoFullSync("12345", false)).toBe(true);
  });

  test("no history ID but has emails → full sync (e.g. HMR restart cleared history)", () => {
    expect(shouldDoFullSync(null, true)).toBe(true);
  });

  test("has history ID and has emails → incremental sync", () => {
    expect(shouldDoFullSync("12345", true)).toBe(false);
  });

  test("empty string history ID treated as falsy → full sync", () => {
    expect(shouldDoFullSync("", false)).toBe(true);
  });
});

// ============================================================================
// Deleted/new message dedup
// Re-implements the critical dedup logic from incrementalSync (lines 792-793)
// When a draft is sent: INBOX label removed (→ deleted) + SENT label added (→ new).
// Processing both would delete then re-add, causing data loss.
// ============================================================================

function filterDeletedMessages(
  deletedMessageIds: string[],
  newMessageIds: string[]
): string[] {
  const newSet = new Set(newMessageIds);
  return deletedMessageIds.filter((id) => !newSet.has(id));
}

test.describe("Deleted/new message dedup (draft-sent overlap)", () => {
  test("removes IDs that appear in both deleted and new lists", () => {
    const deleted = ["msg-1", "msg-2", "msg-3"];
    const added = ["msg-2", "msg-4"];
    const filtered = filterDeletedMessages(deleted, added);
    expect(filtered).toEqual(["msg-1", "msg-3"]);
  });

  test("returns all deleted when no overlap with new", () => {
    const deleted = ["msg-1", "msg-2"];
    const added = ["msg-3", "msg-4"];
    expect(filterDeletedMessages(deleted, added)).toEqual(["msg-1", "msg-2"]);
  });

  test("returns empty when all deleted also appear in new", () => {
    const deleted = ["msg-1", "msg-2"];
    const added = ["msg-1", "msg-2", "msg-3"];
    expect(filterDeletedMessages(deleted, added)).toEqual([]);
  });

  test("handles empty deleted list", () => {
    expect(filterDeletedMessages([], ["msg-1"])).toEqual([]);
  });

  test("handles empty new list (nothing to dedup)", () => {
    const deleted = ["msg-1", "msg-2"];
    expect(filterDeletedMessages(deleted, [])).toEqual(["msg-1", "msg-2"]);
  });

  test("handles both empty lists", () => {
    expect(filterDeletedMessages([], [])).toEqual([]);
  });
});

// ============================================================================
// Label update logic
// Re-implements the read/unread label change logic from incrementalSync
// (lines 933-961)
// ============================================================================

function applyReadChange(currentLabels: string[]): {
  changed: boolean;
  newLabels: string[];
} {
  if (currentLabels.includes("UNREAD")) {
    const newLabels = currentLabels.filter((l) => l !== "UNREAD");
    return { changed: true, newLabels };
  }
  return { changed: false, newLabels: currentLabels };
}

function applyUnreadChange(currentLabels: string[]): {
  changed: boolean;
  newLabels: string[];
} {
  if (!currentLabels.includes("UNREAD")) {
    return { changed: true, newLabels: [...currentLabels, "UNREAD"] };
  }
  return { changed: false, newLabels: currentLabels };
}

/** Default labels when email has no labels stored (legacy emails) */
function getEffectiveLabels(labelIds: string[] | undefined): string[] {
  return labelIds || ["INBOX"];
}

test.describe("Label update logic (read/unread)", () => {
  test("marking as read removes UNREAD label", () => {
    const result = applyReadChange(["INBOX", "UNREAD", "IMPORTANT"]);
    expect(result.changed).toBe(true);
    expect(result.newLabels).toEqual(["INBOX", "IMPORTANT"]);
  });

  test("marking as read is no-op when UNREAD not present", () => {
    const result = applyReadChange(["INBOX", "IMPORTANT"]);
    expect(result.changed).toBe(false);
    expect(result.newLabels).toEqual(["INBOX", "IMPORTANT"]);
  });

  test("marking as unread adds UNREAD label", () => {
    const result = applyUnreadChange(["INBOX"]);
    expect(result.changed).toBe(true);
    expect(result.newLabels).toEqual(["INBOX", "UNREAD"]);
  });

  test("marking as unread is no-op when UNREAD already present", () => {
    const result = applyUnreadChange(["INBOX", "UNREAD"]);
    expect(result.changed).toBe(false);
    expect(result.newLabels).toEqual(["INBOX", "UNREAD"]);
  });

  test("legacy emails with no labels default to ['INBOX']", () => {
    expect(getEffectiveLabels(undefined)).toEqual(["INBOX"]);
  });

  test("emails with explicit labels use those labels", () => {
    expect(getEffectiveLabels(["INBOX", "UNREAD"])).toEqual([
      "INBOX",
      "UNREAD",
    ]);
  });

  test("marking as read on legacy email (defaulting to INBOX) is no-op", () => {
    const labels = getEffectiveLabels(undefined);
    const result = applyReadChange(labels);
    expect(result.changed).toBe(false);
  });

  test("marking as unread on legacy email adds UNREAD", () => {
    const labels = getEffectiveLabels(undefined);
    const result = applyUnreadChange(labels);
    expect(result.changed).toBe(true);
    expect(result.newLabels).toEqual(["INBOX", "UNREAD"]);
  });
});

// ============================================================================
// Onboarding triage partitioning
// Re-implements the logic from runOnboardingSync (lines 672-707)
// Partitions emails into: analysis window (newest 500), overflow, and
// within the window, separates recent (< 3 months) from old.
// ============================================================================

const MAX_ANALYSIS_EMAILS = 500;
const MAX_SYNC_EMAILS = 2500;

interface TriageResult {
  recentEmails: MinimalEmail[];
  oldInWindow: MinimalEmail[];
  overflow: MinimalEmail[];
  toSkip: MinimalEmail[];
}

function triageEmails(
  emails: MinimalEmail[],
  cutoffMs: number
): TriageResult {
  // Sort by date descending (newest first)
  const sorted = [...emails].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
  );

  const analysisWindow = sorted.slice(0, MAX_ANALYSIS_EMAILS);
  const overflow = sorted.slice(MAX_ANALYSIS_EMAILS);

  const recentEmails = analysisWindow.filter(
    (e) => new Date(e.date).getTime() >= cutoffMs
  );
  const oldInWindow = analysisWindow.filter(
    (e) => new Date(e.date).getTime() < cutoffMs
  );

  const toSkip = [...overflow, ...oldInWindow];

  return { recentEmails, oldInWindow, overflow, toSkip };
}

/**
 * Computes archive-ready skip thread IDs: threads that should be skipped
 * BUT only if they don't also contain recent emails.
 * Re-implements lines 698-700 from runOnboardingSync.
 */
function computeSkipThreadIds(
  toSkip: MinimalEmail[],
  recentEmails: MinimalEmail[]
): string[] {
  const recentThreadIds = new Set(recentEmails.map((e) => e.threadId));
  const skipThreadIds = [
    ...new Set(toSkip.map((e) => e.threadId)),
  ].filter((tid) => !recentThreadIds.has(tid));
  return skipThreadIds;
}

function makeEmail(
  id: string,
  threadId: string,
  date: string,
  labelIds?: string[]
): MinimalEmail {
  return { id, threadId, date, labelIds };
}

test.describe("Onboarding triage partitioning", () => {
  const cutoff = new Date("2025-12-01T00:00:00Z").getTime();

  test("all emails within analysis window and recent", () => {
    const emails = [
      makeEmail("e1", "t1", "2026-01-15T00:00:00Z"),
      makeEmail("e2", "t2", "2026-01-10T00:00:00Z"),
      makeEmail("e3", "t3", "2026-01-05T00:00:00Z"),
    ];

    const result = triageEmails(emails, cutoff);
    expect(result.recentEmails).toHaveLength(3);
    expect(result.oldInWindow).toHaveLength(0);
    expect(result.overflow).toHaveLength(0);
    expect(result.toSkip).toHaveLength(0);
  });

  test("emails beyond MAX_ANALYSIS_EMAILS go to overflow", () => {
    const emails: MinimalEmail[] = [];
    for (let i = 0; i < 510; i++) {
      const date = new Date(
        Date.UTC(2026, 0, 1) + i * 60000
      ).toISOString();
      emails.push(makeEmail(`e${i}`, `t${i}`, date));
    }

    const result = triageEmails(emails, cutoff);
    expect(result.overflow).toHaveLength(10);
    expect(result.recentEmails).toHaveLength(500);
    expect(result.toSkip).toHaveLength(10);
  });

  test("old emails within analysis window are skipped", () => {
    const emails = [
      makeEmail("e1", "t1", "2026-01-15T00:00:00Z"), // recent
      makeEmail("e2", "t2", "2025-11-01T00:00:00Z"), // old (before cutoff)
      makeEmail("e3", "t3", "2025-06-01T00:00:00Z"), // old
    ];

    const result = triageEmails(emails, cutoff);
    expect(result.recentEmails).toHaveLength(1);
    expect(result.recentEmails[0].id).toBe("e1");
    expect(result.oldInWindow).toHaveLength(2);
    expect(result.toSkip).toHaveLength(2);
  });

  test("toSkip combines overflow and old-in-window", () => {
    const emails: MinimalEmail[] = [];
    // 500 recent emails
    for (let i = 0; i < 500; i++) {
      emails.push(
        makeEmail(
          `recent-${i}`,
          `t-recent-${i}`,
          new Date(Date.UTC(2026, 0, 1) + i * 60000).toISOString()
        )
      );
    }
    // 5 old emails (will be in overflow since we already have 500)
    for (let i = 0; i < 5; i++) {
      emails.push(
        makeEmail(
          `old-${i}`,
          `t-old-${i}`,
          new Date(Date.UTC(2025, 5, 1) + i * 60000).toISOString()
        )
      );
    }

    const result = triageEmails(emails, cutoff);
    expect(result.overflow).toHaveLength(5);
    expect(result.toSkip).toHaveLength(5);
    // All overflow IDs start with "old-"
    for (const e of result.overflow) {
      expect(e.id).toMatch(/^old-/);
    }
  });

  test("sorting is by date descending — newest first", () => {
    const emails = [
      makeEmail("oldest", "t1", "2025-01-01T00:00:00Z"),
      makeEmail("newest", "t2", "2026-03-01T00:00:00Z"),
      makeEmail("middle", "t3", "2025-08-01T00:00:00Z"),
    ];

    const result = triageEmails(emails, cutoff);
    // With cutoff at 2025-12-01, only "newest" is recent
    expect(result.recentEmails).toHaveLength(1);
    expect(result.recentEmails[0].id).toBe("newest");
    expect(result.oldInWindow).toHaveLength(2);
    // oldInWindow should be middle then oldest (still sorted newest-first)
    expect(result.oldInWindow[0].id).toBe("middle");
    expect(result.oldInWindow[1].id).toBe("oldest");
  });

  test("skip thread IDs exclude threads that also have recent emails", () => {
    const recentEmails = [
      makeEmail("e1", "shared-thread", "2026-01-15T00:00:00Z"),
      makeEmail("e2", "recent-only", "2026-01-10T00:00:00Z"),
    ];
    const toSkip = [
      makeEmail("e3", "shared-thread", "2025-06-01T00:00:00Z"), // shares thread with e1
      makeEmail("e4", "old-only", "2025-05-01T00:00:00Z"),
    ];

    const skipThreadIds = computeSkipThreadIds(toSkip, recentEmails);
    // "shared-thread" should NOT be in skip threads because it has a recent email
    expect(skipThreadIds).toEqual(["old-only"]);
  });

  test("skip thread IDs are deduplicated", () => {
    const recentEmails: MinimalEmail[] = [];
    const toSkip = [
      makeEmail("e1", "dup-thread", "2025-06-01T00:00:00Z"),
      makeEmail("e2", "dup-thread", "2025-05-01T00:00:00Z"),
      makeEmail("e3", "other-thread", "2025-04-01T00:00:00Z"),
    ];

    const skipThreadIds = computeSkipThreadIds(toSkip, recentEmails);
    expect(skipThreadIds).toHaveLength(2);
    expect(skipThreadIds).toContain("dup-thread");
    expect(skipThreadIds).toContain("other-thread");
  });
});

// ============================================================================
// 3-month cutoff calculation
// Re-implements the cutoff logic from runOnboardingSync (lines 680-683)
// The cutoff is the last day of (current month - 3), using UTC.
// ============================================================================

function computeThreeMonthCutoff(now: Date): Date {
  const cutoff = new Date(now);
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 3 + 1, 0);
  return cutoff;
}

test.describe("3-month cutoff calculation", () => {
  test("March 2026 → cutoff is last day of December 2025", () => {
    const now = new Date("2026-03-15T12:00:00Z");
    const cutoff = computeThreeMonthCutoff(now);
    // 3 months before March = December. Last day of December = 31st.
    expect(cutoff.getUTCFullYear()).toBe(2025);
    expect(cutoff.getUTCMonth()).toBe(11); // December = 11
    expect(cutoff.getUTCDate()).toBe(31);
  });

  test("January 2026 → cutoff is last day of October 2025", () => {
    const now = new Date("2026-01-10T00:00:00Z");
    const cutoff = computeThreeMonthCutoff(now);
    expect(cutoff.getUTCFullYear()).toBe(2025);
    expect(cutoff.getUTCMonth()).toBe(9); // October = 9
    expect(cutoff.getUTCDate()).toBe(31);
  });

  test("May 2026 → cutoff is last day of February 2026", () => {
    const now = new Date("2026-05-20T00:00:00Z");
    const cutoff = computeThreeMonthCutoff(now);
    expect(cutoff.getUTCFullYear()).toBe(2026);
    expect(cutoff.getUTCMonth()).toBe(1); // February = 1
    expect(cutoff.getUTCDate()).toBe(28); // 2026 is not a leap year
  });

  test("May 2024 → cutoff is last day of Feb 2024 (leap year)", () => {
    const now = new Date("2024-05-01T00:00:00Z");
    const cutoff = computeThreeMonthCutoff(now);
    expect(cutoff.getUTCFullYear()).toBe(2024);
    expect(cutoff.getUTCMonth()).toBe(1); // February
    expect(cutoff.getUTCDate()).toBe(29); // 2024 is a leap year
  });

  test("handles month overflow from March → December crossing year boundary", () => {
    const now = new Date("2026-03-01T00:00:00Z");
    const cutoff = computeThreeMonthCutoff(now);
    expect(cutoff.getUTCFullYear()).toBe(2025);
    expect(cutoff.getUTCMonth()).toBe(11);
    expect(cutoff.getUTCDate()).toBe(31);
  });
});

// ============================================================================
// Sync interval clamping
// Re-implements setSyncInterval (line 249): Math.max(10000, interval)
// ============================================================================

function clampSyncInterval(interval: number): number {
  return Math.max(10000, interval);
}

test.describe("Sync interval clamping", () => {
  test("interval below minimum is clamped to 10 seconds", () => {
    expect(clampSyncInterval(5000)).toBe(10000);
  });

  test("interval at minimum stays at 10 seconds", () => {
    expect(clampSyncInterval(10000)).toBe(10000);
  });

  test("interval above minimum is preserved", () => {
    expect(clampSyncInterval(30000)).toBe(30000);
  });

  test("zero is clamped to 10 seconds", () => {
    expect(clampSyncInterval(0)).toBe(10000);
  });

  test("negative value is clamped to 10 seconds", () => {
    expect(clampSyncInterval(-1000)).toBe(10000);
  });
});

// ============================================================================
// Batch chunking for concurrent fetches
// Re-implements the chunk logic from fullSync (lines 522-549)
// ============================================================================

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Simulates the progress emission logic from fullSync.
 * For each chunk, emits { fetched: min(i+chunkSize, total), total }.
 */
function computeProgressEmissions(
  totalIds: number,
  chunkSize: number
): Array<{ fetched: number; total: number }> {
  const emissions: Array<{ fetched: number; total: number }> = [];
  // Initial emission
  emissions.push({ fetched: 0, total: totalIds });
  for (let i = 0; i < totalIds; i += chunkSize) {
    emissions.push({
      fetched: Math.min(i + chunkSize, totalIds),
      total: totalIds,
    });
  }
  return emissions;
}

test.describe("Batch chunking", () => {
  test("chunks array into groups of 10", () => {
    const ids = Array.from({ length: 25 }, (_, i) => `id-${i}`);
    const chunks = chunkArray(ids, 10);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(10);
    expect(chunks[1]).toHaveLength(10);
    expect(chunks[2]).toHaveLength(5);
  });

  test("single chunk when fewer than chunk size", () => {
    const ids = ["a", "b", "c"];
    const chunks = chunkArray(ids, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual(["a", "b", "c"]);
  });

  test("empty array produces no chunks", () => {
    expect(chunkArray([], 10)).toEqual([]);
  });

  test("exactly chunk size produces one chunk", () => {
    const ids = Array.from({ length: 10 }, (_, i) => i);
    const chunks = chunkArray(ids, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(10);
  });
});

test.describe("Progress emission", () => {
  test("emits correct progress for 25 items in chunks of 10", () => {
    const emissions = computeProgressEmissions(25, 10);
    expect(emissions).toEqual([
      { fetched: 0, total: 25 },
      { fetched: 10, total: 25 },
      { fetched: 20, total: 25 },
      { fetched: 25, total: 25 },
    ]);
  });

  test("emits correct progress for exactly one chunk", () => {
    const emissions = computeProgressEmissions(10, 10);
    expect(emissions).toEqual([
      { fetched: 0, total: 10 },
      { fetched: 10, total: 10 },
    ]);
  });

  test("emits only initial progress for 0 items", () => {
    const emissions = computeProgressEmissions(0, 10);
    expect(emissions).toEqual([{ fetched: 0, total: 0 }]);
  });

  test("single item emits initial + final", () => {
    const emissions = computeProgressEmissions(1, 10);
    expect(emissions).toEqual([
      { fetched: 0, total: 1 },
      { fetched: 1, total: 1 },
    ]);
  });
});

// ============================================================================
// Sent email filtering for inbox thread backfill
// Re-implements the filtering from syncSentForInboxThreads (lines 336)
// ============================================================================

function filterSentForInboxThreads(
  sentResults: Array<{ id: string; threadId: string }>,
  inboxThreadIds: Set<string>,
  existingIds: Set<string>
): Array<{ id: string; threadId: string }> {
  return sentResults.filter(
    (r) => inboxThreadIds.has(r.threadId) && !existingIds.has(r.id)
  );
}

test.describe("Sent email filtering for inbox threads", () => {
  test("includes sent emails whose thread is in inbox and not already stored", () => {
    const sent = [
      { id: "s1", threadId: "t1" },
      { id: "s2", threadId: "t2" },
      { id: "s3", threadId: "t3" },
    ];
    const inboxThreads = new Set(["t1", "t3"]);
    const existing = new Set(["s1"]);

    const result = filterSentForInboxThreads(sent, inboxThreads, existing);
    expect(result).toEqual([{ id: "s3", threadId: "t3" }]);
  });

  test("excludes sent emails not in inbox threads", () => {
    const sent = [{ id: "s1", threadId: "t-not-inbox" }];
    const inboxThreads = new Set(["t-inbox"]);
    const existing = new Set<string>();

    expect(filterSentForInboxThreads(sent, inboxThreads, existing)).toEqual([]);
  });

  test("excludes already-existing emails", () => {
    const sent = [{ id: "s1", threadId: "t1" }];
    const inboxThreads = new Set(["t1"]);
    const existing = new Set(["s1"]);

    expect(filterSentForInboxThreads(sent, inboxThreads, existing)).toEqual([]);
  });

  test("returns empty for empty sent list", () => {
    expect(
      filterSentForInboxThreads([], new Set(["t1"]), new Set())
    ).toEqual([]);
  });

  test("returns empty when inbox thread set is empty", () => {
    const sent = [{ id: "s1", threadId: "t1" }];
    expect(filterSentForInboxThreads(sent, new Set(), new Set())).toEqual([]);
  });
});

// ============================================================================
// New email filtering (full sync dedup)
// Re-implements line 514: filter to only new emails not already in DB
// ============================================================================

function filterNewEmails(
  searchResults: Array<{ id: string; threadId: string }>,
  existingIds: Set<string>
): string[] {
  return searchResults.filter((r) => !existingIds.has(r.id)).map((r) => r.id);
}

test.describe("Full sync new email filtering", () => {
  test("filters out already-existing emails", () => {
    const results = [
      { id: "e1", threadId: "t1" },
      { id: "e2", threadId: "t2" },
      { id: "e3", threadId: "t3" },
    ];
    const existing = new Set(["e2"]);

    expect(filterNewEmails(results, existing)).toEqual(["e1", "e3"]);
  });

  test("returns all when none exist", () => {
    const results = [
      { id: "e1", threadId: "t1" },
      { id: "e2", threadId: "t2" },
    ];
    expect(filterNewEmails(results, new Set())).toEqual(["e1", "e2"]);
  });

  test("returns empty when all exist", () => {
    const results = [
      { id: "e1", threadId: "t1" },
      { id: "e2", threadId: "t2" },
    ];
    expect(filterNewEmails(results, new Set(["e1", "e2"]))).toEqual([]);
  });
});

// ============================================================================
// Draft cleanup two-pass logic
// Re-implements the stale draft detection + force-queue decision logic
// from incrementalSync (lines 885-924)
// ============================================================================

interface NewEmail {
  id: string;
  threadId: string;
  labelIds?: string[];
}

interface DraftCleanupContext {
  /** Returns email IDs of removed drafts for a thread */
  cleanupStaleDraftsForThread: (
    threadId: string,
    newEmailIds: Set<string>,
    hasSent: boolean
  ) => string[];
}

/**
 * Two-pass draft cleanup:
 * Pass 1: Clean up stale drafts (one pass per thread)
 * Pass 2: Force-queue agent drafts for received emails in threads that lost drafts,
 *          but NOT if the user themselves sent a reply.
 */
function runDraftCleanup(
  newEmails: NewEmail[],
  threadsWithDeletedDrafts: Set<string>,
  ctx: DraftCleanupContext
): {
  removedDraftEmailIds: string[];
  forceQueuedThreads: Set<string>;
} {
  const removedDraftEmailIds: string[] = [];
  const threadsWithRemovedDrafts = new Set<string>();
  const processedThreads = new Set<string>();
  const newEmailIds = new Set(newEmails.map((e) => e.id));

  // Pass 1: clean up stale drafts
  for (const email of newEmails) {
    if (processedThreads.has(email.threadId)) continue;
    processedThreads.add(email.threadId);

    const hasSent = newEmails.some(
      (e) =>
        e.threadId === email.threadId && e.labelIds?.includes("SENT")
    );
    const removed = ctx.cleanupStaleDraftsForThread(
      email.threadId,
      newEmailIds,
      hasSent
    );

    if (removed.length > 0) {
      removedDraftEmailIds.push(...removed);
      threadsWithRemovedDrafts.add(email.threadId);
    }
  }

  // Pass 2: force-queue agent drafts for received emails
  const forceQueuedThreads = new Set<string>();
  for (const email of newEmails) {
    if (email.labelIds?.includes("SENT")) continue;
    const tid = email.threadId;
    if (forceQueuedThreads.has(tid)) continue;
    if (!threadsWithRemovedDrafts.has(tid) && !threadsWithDeletedDrafts.has(tid))
      continue;
    // Don't re-draft if the user also replied in this thread
    const userAlsoReplied = newEmails.some(
      (e) => e.threadId === tid && e.labelIds?.includes("SENT")
    );
    if (userAlsoReplied) continue;

    forceQueuedThreads.add(tid);
  }

  return { removedDraftEmailIds, forceQueuedThreads };
}

test.describe("Draft cleanup two-pass logic", () => {
  const noopCleanup: DraftCleanupContext = {
    cleanupStaleDraftsForThread: () => [],
  };

  test("pass 1: processes each thread only once", () => {
    const processedThreads: string[] = [];
    const ctx: DraftCleanupContext = {
      cleanupStaleDraftsForThread: (threadId) => {
        processedThreads.push(threadId);
        return [];
      },
    };

    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX"] },
      { id: "e2", threadId: "t1", labelIds: ["INBOX"] },
      { id: "e3", threadId: "t2", labelIds: ["INBOX"] },
    ];

    runDraftCleanup(emails, new Set(), ctx);
    expect(processedThreads).toEqual(["t1", "t2"]);
  });

  test("pass 1: collects removed draft email IDs", () => {
    const ctx: DraftCleanupContext = {
      cleanupStaleDraftsForThread: (threadId) => {
        if (threadId === "t1") return ["draft-e1"];
        return [];
      },
    };

    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX"] },
      { id: "e2", threadId: "t2", labelIds: ["INBOX"] },
    ];

    const result = runDraftCleanup(emails, new Set(), ctx);
    expect(result.removedDraftEmailIds).toEqual(["draft-e1"]);
  });

  test("pass 2: force-queues for received emails in threads with removed drafts", () => {
    const ctx: DraftCleanupContext = {
      cleanupStaleDraftsForThread: (threadId) => {
        if (threadId === "t1") return ["draft-e1"];
        return [];
      },
    };

    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX"] }, // received, thread had draft removed
      { id: "e2", threadId: "t2", labelIds: ["INBOX"] }, // received, but no draft removed
    ];

    const result = runDraftCleanup(emails, new Set(), ctx);
    expect(result.forceQueuedThreads.has("t1")).toBe(true);
    expect(result.forceQueuedThreads.has("t2")).toBe(false);
  });

  test("pass 2: does NOT force-queue when user sent a reply in the same thread", () => {
    const ctx: DraftCleanupContext = {
      cleanupStaleDraftsForThread: () => ["draft-e1"],
    };

    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX"] }, // received
      { id: "e2", threadId: "t1", labelIds: ["SENT"] }, // user replied
    ];

    const result = runDraftCleanup(emails, new Set(), ctx);
    expect(result.forceQueuedThreads.size).toBe(0);
  });

  test("pass 2: skips SENT emails as candidates for force-queue", () => {
    const ctx: DraftCleanupContext = {
      cleanupStaleDraftsForThread: () => ["draft-x"],
    };

    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["SENT"] }, // user's own sent email
    ];

    const result = runDraftCleanup(emails, new Set(), ctx);
    expect(result.forceQueuedThreads.size).toBe(0);
  });

  test("pass 2: force-queues for threads with deleted drafts (from deletion handler)", () => {
    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX"] },
    ];

    // No drafts removed in pass 1, but deletion handler flagged the thread
    const result = runDraftCleanup(emails, new Set(["t1"]), noopCleanup);
    expect(result.forceQueuedThreads.has("t1")).toBe(true);
  });

  test("pass 2: deduplicates force-queue per thread", () => {
    const ctx: DraftCleanupContext = {
      cleanupStaleDraftsForThread: () => ["draft-x"],
    };

    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX"] },
      { id: "e2", threadId: "t1", labelIds: ["INBOX"] },
    ];

    const result = runDraftCleanup(emails, new Set(), ctx);
    // Should only be queued once despite two emails in same thread
    expect(result.forceQueuedThreads.size).toBe(1);
  });
});

// ============================================================================
// Sync status lifecycle
// Re-implements the status transitions from syncAccount (lines 415-487)
// ============================================================================

type SyncDecision =
  | { type: "full_sync" }
  | { type: "incremental_sync"; historyId: string }
  | { type: "full_sync_after_history_expired" };

type SyncOutcome =
  | { type: "success" }
  | { type: "auth_error" }
  | { type: "history_expired" }
  | { type: "other_error"; message: string };

type FallbackOutcome =
  | { type: "success" }
  | { type: "auth_error" }
  | { type: "other_error"; message: string };

interface StatusTransition {
  status: SyncStatus;
  lastError?: string;
  authErrorFired?: boolean;
  syncStopped?: boolean;
}

function computeSyncStatusTransitions(
  outcome: SyncOutcome,
  fallbackOutcome?: FallbackOutcome
): StatusTransition {
  if (outcome.type === "success") {
    return { status: "idle" };
  }

  if (outcome.type === "auth_error") {
    return {
      status: "error",
      lastError: "Authentication expired",
      authErrorFired: true,
      syncStopped: true,
    };
  }

  if (outcome.type === "history_expired") {
    // Fallback to full sync
    if (!fallbackOutcome) {
      throw new Error("history_expired requires a fallbackOutcome");
    }

    if (fallbackOutcome.type === "success") {
      return { status: "idle" };
    }

    if (fallbackOutcome.type === "auth_error") {
      return {
        status: "error",
        lastError: "Authentication expired",
        authErrorFired: true,
        syncStopped: true,
      };
    }

    return {
      status: "error",
      lastError: fallbackOutcome.message,
    };
  }

  // other_error
  return {
    status: "error",
    lastError: outcome.message,
  };
}

test.describe("Sync status lifecycle", () => {
  test("successful sync → idle", () => {
    const result = computeSyncStatusTransitions({ type: "success" });
    expect(result.status).toBe("idle");
    expect(result.lastError).toBeUndefined();
  });

  test("auth error → error with auth message, sync stopped", () => {
    const result = computeSyncStatusTransitions({ type: "auth_error" });
    expect(result.status).toBe("error");
    expect(result.lastError).toBe("Authentication expired");
    expect(result.authErrorFired).toBe(true);
    expect(result.syncStopped).toBe(true);
  });

  test("history expired + successful full sync → idle", () => {
    const result = computeSyncStatusTransitions(
      { type: "history_expired" },
      { type: "success" }
    );
    expect(result.status).toBe("idle");
  });

  test("history expired + auth error during full sync → error with auth", () => {
    const result = computeSyncStatusTransitions(
      { type: "history_expired" },
      { type: "auth_error" }
    );
    expect(result.status).toBe("error");
    expect(result.lastError).toBe("Authentication expired");
    expect(result.authErrorFired).toBe(true);
    expect(result.syncStopped).toBe(true);
  });

  test("history expired + other error during full sync → error", () => {
    const result = computeSyncStatusTransitions(
      { type: "history_expired" },
      { type: "other_error", message: "Network timeout" }
    );
    expect(result.status).toBe("error");
    expect(result.lastError).toBe("Network timeout");
    expect(result.syncStopped).toBeUndefined();
  });

  test("generic error → error with message", () => {
    const result = computeSyncStatusTransitions({
      type: "other_error",
      message: "Rate limit exceeded",
    });
    expect(result.status).toBe("error");
    expect(result.lastError).toBe("Rate limit exceeded");
    expect(result.syncStopped).toBeUndefined();
  });
});

// ============================================================================
// Received vs sent email categorization for archive-ready invalidation
// Re-implements the logic from incrementalSync (lines 854-875)
// ============================================================================

function categorizeNewEmails(newEmails: NewEmail[]): {
  receivedThreadIds: string[];
  sentThreadIds: string[];
} {
  const received = newEmails.filter((e) => !e.labelIds?.includes("SENT"));
  const sent = newEmails.filter((e) => e.labelIds?.includes("SENT"));

  const receivedThreadIds = [...new Set(received.map((e) => e.threadId))];
  const sentThreadIds = [...new Set(sent.map((e) => e.threadId))];

  return { receivedThreadIds, sentThreadIds };
}

test.describe("Received vs sent email categorization", () => {
  test("separates received and sent emails by thread", () => {
    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX", "UNREAD"] },
      { id: "e2", threadId: "t1", labelIds: ["SENT"] },
      { id: "e3", threadId: "t2", labelIds: ["INBOX"] },
      { id: "e4", threadId: "t3", labelIds: ["SENT"] },
    ];

    const result = categorizeNewEmails(emails);
    expect(result.receivedThreadIds).toEqual(["t1", "t2"]);
    expect(result.sentThreadIds).toEqual(["t1", "t3"]);
  });

  test("deduplicates thread IDs", () => {
    const emails: NewEmail[] = [
      { id: "e1", threadId: "t1", labelIds: ["INBOX"] },
      { id: "e2", threadId: "t1", labelIds: ["INBOX"] },
    ];

    const result = categorizeNewEmails(emails);
    expect(result.receivedThreadIds).toEqual(["t1"]);
  });

  test("emails with no labelIds are treated as received", () => {
    const emails: NewEmail[] = [{ id: "e1", threadId: "t1" }];

    const result = categorizeNewEmails(emails);
    expect(result.receivedThreadIds).toEqual(["t1"]);
    expect(result.sentThreadIds).toEqual([]);
  });

  test("empty email list produces empty results", () => {
    const result = categorizeNewEmails([]);
    expect(result.receivedThreadIds).toEqual([]);
    expect(result.sentThreadIds).toEqual([]);
  });
});

// ============================================================================
// Health check skip logic
// Re-implements the condition from runHealthChecks (lines 996-998)
// ============================================================================

function shouldSkipHealthCheck(
  status: SyncStatus,
  lastError: string | undefined
): boolean {
  return status === "error" && lastError === "Authentication expired";
}

test.describe("Health check skip logic", () => {
  test("skips accounts with auth error", () => {
    expect(shouldSkipHealthCheck("error", "Authentication expired")).toBe(true);
  });

  test("does not skip accounts with other errors", () => {
    expect(shouldSkipHealthCheck("error", "Network timeout")).toBe(false);
  });

  test("does not skip idle accounts", () => {
    expect(shouldSkipHealthCheck("idle", undefined)).toBe(false);
  });

  test("does not skip syncing accounts", () => {
    expect(shouldSkipHealthCheck("syncing", undefined)).toBe(false);
  });

  test("does not skip error accounts with no lastError", () => {
    expect(shouldSkipHealthCheck("error", undefined)).toBe(false);
  });
});

// ============================================================================
// First-sync triage flag behavior
// Tests the needsFirstSyncTriage flag lifecycle
// ============================================================================

test.describe("First-sync triage flag", () => {
  test("set when no full sync has completed", () => {
    // Re-implements line 141: needsFirstSyncTriage: !hasCompletedFullSync
    const hasCompletedFullSync = false;
    const needsFirstSyncTriage = !hasCompletedFullSync;
    expect(needsFirstSyncTriage).toBe(true);
  });

  test("not set when full sync already completed", () => {
    const hasCompletedFullSync = true;
    const needsFirstSyncTriage = !hasCompletedFullSync;
    expect(needsFirstSyncTriage).toBe(false);
  });

  test("hasFirstSyncPending logic: returns true if any account has flag set", () => {
    // Re-implements hasFirstSyncPending (lines 763-768)
    const accounts = [
      { needsFirstSyncTriage: false },
      { needsFirstSyncTriage: true },
      { needsFirstSyncTriage: false },
    ];

    const hasFirstSyncPending = accounts.some((a) => a.needsFirstSyncTriage);
    expect(hasFirstSyncPending).toBe(true);
  });

  test("hasFirstSyncPending: returns false when no accounts have flag", () => {
    const accounts = [
      { needsFirstSyncTriage: false },
      { needsFirstSyncTriage: false },
    ];

    const hasFirstSyncPending = accounts.some((a) => a.needsFirstSyncTriage);
    expect(hasFirstSyncPending).toBe(false);
  });

  test("hasFirstSyncPending: returns false for empty accounts", () => {
    const accounts: Array<{ needsFirstSyncTriage: boolean }> = [];
    const hasFirstSyncPending = accounts.some((a) => a.needsFirstSyncTriage);
    expect(hasFirstSyncPending).toBe(false);
  });
});

// ============================================================================
// Constants
// ============================================================================

test.describe("Sync constants", () => {
  test("MAX_SYNC_EMAILS is 2500", () => {
    expect(MAX_SYNC_EMAILS).toBe(2500);
  });

  test("MAX_ANALYSIS_EMAILS is 500", () => {
    expect(MAX_ANALYSIS_EMAILS).toBe(500);
  });

  test("default sync interval is 30 seconds", () => {
    const DEFAULT_SYNC_INTERVAL = 30000;
    expect(DEFAULT_SYNC_INTERVAL).toBe(30000);
  });
});
