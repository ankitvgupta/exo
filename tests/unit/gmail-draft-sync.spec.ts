/**
 * Unit tests for gmail-draft-sync logic.
 *
 * Cannot import directly (depends on electron via db/index).
 * Re-implements the pure filtering/decision logic for testing.
 */
import { test, expect } from "@playwright/test";

// Re-implement the core logic from cleanupStaleDraftsForThread
type ThreadDraft = {
  emailId: string;
  status: string;
  gmailDraftId: string | null;
};

function filterStaleDrafts(
  threadDrafts: ThreadDraft[],
  excludeEmailIds: Set<string>,
): ThreadDraft[] {
  return threadDrafts.filter((d) => !excludeEmailIds.has(d.emailId) && d.status === "pending");
}

function shouldDeleteFromGmail(draft: ThreadDraft, userReplied: boolean): boolean {
  // Only delete from Gmail when someone ELSE replied (draft is truly stale).
  // When the USER replied, the draft was likely consumed by Gmail.
  return !!draft.gmailDraftId && !userReplied;
}

// Re-implement reply metadata extraction from syncDraftToGmail
function extractReplyTo(fromAddress: string): string {
  const fromMatch = fromAddress.match(/<([^>]+)>/);
  return fromMatch ? fromMatch[1] : fromAddress;
}

function buildReplySubject(subject: string): string {
  return subject.startsWith("Re:") ? subject : `Re: ${subject}`;
}

test.describe("cleanupStaleDraftsForThread logic", () => {
  test("filters out excluded email IDs", () => {
    const drafts: ThreadDraft[] = [
      { emailId: "e1", status: "pending", gmailDraftId: "gd1" },
      { emailId: "e2", status: "pending", gmailDraftId: "gd2" },
      { emailId: "e3", status: "pending", gmailDraftId: "gd3" },
    ];
    const excluded = new Set(["e2"]);
    const stale = filterStaleDrafts(drafts, excluded);
    expect(stale).toHaveLength(2);
    expect(stale.map((d) => d.emailId)).toEqual(["e1", "e3"]);
  });

  test("only includes drafts with status=pending", () => {
    const drafts: ThreadDraft[] = [
      { emailId: "e1", status: "pending", gmailDraftId: "gd1" },
      { emailId: "e2", status: "edited", gmailDraftId: "gd2" },
      { emailId: "e3", status: "created", gmailDraftId: "gd3" },
    ];
    const stale = filterStaleDrafts(drafts, new Set());
    expect(stale).toHaveLength(1);
    expect(stale[0].emailId).toBe("e1");
  });

  test("returns empty when all drafts are excluded", () => {
    const drafts: ThreadDraft[] = [{ emailId: "e1", status: "pending", gmailDraftId: "gd1" }];
    const stale = filterStaleDrafts(drafts, new Set(["e1"]));
    expect(stale).toHaveLength(0);
  });

  test("returns empty when no drafts are pending", () => {
    const drafts: ThreadDraft[] = [
      { emailId: "e1", status: "edited", gmailDraftId: "gd1" },
      { emailId: "e2", status: "created", gmailDraftId: "gd2" },
    ];
    const stale = filterStaleDrafts(drafts, new Set());
    expect(stale).toHaveLength(0);
  });

  test("returns empty for empty input", () => {
    expect(filterStaleDrafts([], new Set())).toHaveLength(0);
  });
});

test.describe("shouldDeleteFromGmail logic", () => {
  test("deletes from Gmail when third party replied and draft has gmail ID", () => {
    const draft: ThreadDraft = { emailId: "e1", status: "pending", gmailDraftId: "gd1" };
    expect(shouldDeleteFromGmail(draft, false)).toBe(true);
  });

  test("does NOT delete from Gmail when user replied (draft was consumed)", () => {
    const draft: ThreadDraft = { emailId: "e1", status: "pending", gmailDraftId: "gd1" };
    expect(shouldDeleteFromGmail(draft, true)).toBe(false);
  });

  test("does NOT delete from Gmail when draft has no gmail ID", () => {
    const draft: ThreadDraft = { emailId: "e1", status: "pending", gmailDraftId: null };
    expect(shouldDeleteFromGmail(draft, false)).toBe(false);
  });

  test("does NOT delete from Gmail when user replied and no gmail ID", () => {
    const draft: ThreadDraft = { emailId: "e1", status: "pending", gmailDraftId: null };
    expect(shouldDeleteFromGmail(draft, true)).toBe(false);
  });
});

test.describe("reply metadata extraction", () => {
  test("extracts email from angle brackets", () => {
    expect(extractReplyTo("Sarah Johnson <sarah@example.com>")).toBe("sarah@example.com");
  });

  test("returns bare email when no angle brackets", () => {
    expect(extractReplyTo("sarah@example.com")).toBe("sarah@example.com");
  });

  test("handles complex display names with angle brackets", () => {
    expect(extractReplyTo('"Johnson, Sarah" <sarah@example.com>')).toBe("sarah@example.com");
  });

  test("buildReplySubject prefixes Re: if missing", () => {
    expect(buildReplySubject("Hello World")).toBe("Re: Hello World");
  });

  test("buildReplySubject preserves existing Re:", () => {
    expect(buildReplySubject("Re: Hello World")).toBe("Re: Hello World");
  });

  test("buildReplySubject handles Re: at the start only", () => {
    expect(buildReplySubject("Regarding the meeting")).toBe("Re: Regarding the meeting");
  });
});

test.describe("demo/test mode guard", () => {
  test("useFakeData pattern matches expected env vars", () => {
    // Re-implement the guard logic
    function shouldUseFakeData(env: Record<string, string>): boolean {
      const isTestMode = env.EXO_TEST_MODE === "true";
      const isDemoMode = env.EXO_DEMO_MODE === "true";
      return isTestMode || isDemoMode;
    }

    expect(shouldUseFakeData({})).toBe(false);
    expect(shouldUseFakeData({ EXO_TEST_MODE: "true" })).toBe(true);
    expect(shouldUseFakeData({ EXO_DEMO_MODE: "true" })).toBe(true);
    expect(shouldUseFakeData({ EXO_TEST_MODE: "false" })).toBe(false);
    expect(shouldUseFakeData({ EXO_TEST_MODE: "true", EXO_DEMO_MODE: "true" })).toBe(true);
  });
});
