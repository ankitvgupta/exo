/**
 * Unit tests for optimistic-reads.ts — tracks email IDs that were
 * optimistically marked as read to prevent sync from reverting them.
 */
import { test, expect } from "@playwright/test";
import type { DashboardEmail } from "../../src/shared/types";
import {
  applyOptimisticReads,
  addOptimisticReads,
  confirmOptimisticReads,
} from "../../src/renderer/optimistic-reads";

/** Helper to build a minimal DashboardEmail with the given labels. */
function makeEmail(
  id: string,
  labelIds: string[] = ["INBOX", "UNREAD"]
): DashboardEmail {
  return {
    id,
    threadId: `thread-${id}`,
    subject: `Subject ${id}`,
    from: "test@example.com",
    to: "me@example.com",
    date: new Date().toISOString(),
    body: "body",
    labelIds,
  };
}

// The optimistic set is module-level state, so tests must clean up after
// themselves. We confirm all IDs we add to avoid leaking between tests.
test.afterEach(() => {
  // Brute-force cleanup: confirm a large range of IDs we might have added
  confirmOptimisticReads(["1", "2", "3", "4", "5", "a", "b", "c"]);
});

test.describe("optimistic-reads", () => {
  test.describe.configure({ mode: "serial" });
  test("applyOptimisticReads with no tracked IDs returns unchanged array", () => {
    const emails = [makeEmail("1"), makeEmail("2")];
    const result = applyOptimisticReads(emails);
    // Should return the same reference when nothing to apply
    expect(result).toBe(emails);
  });

  test("addOptimisticReads + applyOptimisticReads strips UNREAD label", () => {
    addOptimisticReads(["1"]);
    const emails = [makeEmail("1"), makeEmail("2")];
    const result = applyOptimisticReads(emails);

    // Email 1 should have UNREAD stripped
    expect(result[0].labelIds).toEqual(["INBOX"]);
    // Email 2 should be unchanged
    expect(result[1].labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  test("confirmOptimisticReads removes IDs from tracking", () => {
    addOptimisticReads(["1"]);
    confirmOptimisticReads(["1"]);

    const emails = [makeEmail("1")];
    const result = applyOptimisticReads(emails);
    // After confirmation, UNREAD should remain
    expect(result).toBe(emails);
    expect(result[0].labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  test("multiple IDs tracked simultaneously", () => {
    addOptimisticReads(["a", "b", "c"]);
    const emails = [makeEmail("a"), makeEmail("b"), makeEmail("c")];
    const result = applyOptimisticReads(emails);

    for (const email of result) {
      expect(email.labelIds).toEqual(["INBOX"]);
    }
  });

  test("confirm partial set of IDs", () => {
    addOptimisticReads(["1", "2", "3"]);
    confirmOptimisticReads(["1", "3"]);

    const emails = [makeEmail("1"), makeEmail("2"), makeEmail("3")];
    const result = applyOptimisticReads(emails);

    // Only email 2 should have UNREAD stripped (still tracked)
    expect(result[0].labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(result[1].labelIds).toEqual(["INBOX"]);
    expect(result[2].labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  test("email without UNREAD label is not modified even if tracked", () => {
    addOptimisticReads(["1"]);
    const emails = [makeEmail("1", ["INBOX", "IMPORTANT"])];
    const result = applyOptimisticReads(emails);

    // No UNREAD to strip, so the email object should be unchanged
    expect(result[0].labelIds).toEqual(["INBOX", "IMPORTANT"]);
  });

  test("email with no labelIds is not modified even if tracked", () => {
    addOptimisticReads(["1"]);
    const email: DashboardEmail = {
      id: "1",
      threadId: "thread-1",
      subject: "Test",
      from: "test@example.com",
      to: "me@example.com",
      date: new Date().toISOString(),
      body: "body",
    };
    const result = applyOptimisticReads([email]);
    expect(result[0]).toBe(email);
  });
});
