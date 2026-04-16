import { useAppStore } from "../store";
import type { DashboardEmail } from "../../shared/types";
import { trackEvent } from "../services/posthog";

/**
 * Shared batch action functions that read current state from the store.
 * Safe to call from event handlers, useCallback bodies, or keyboard shortcuts.
 */

function groupSelectedThreadsByAccount(
  threadIds: Iterable<string>,
  emails: DashboardEmail[],
): Map<string, { threadIds: string[]; emails: DashboardEmail[] }> {
  const grouped = new Map<string, { threadIds: string[]; emails: DashboardEmail[] }>();

  for (const threadId of threadIds) {
    const threadEmails = emails.filter((email) => email.threadId === threadId);
    if (threadEmails.length === 0) continue;

    const accountId = threadEmails[0].accountId;
    const existing = grouped.get(accountId) ?? { threadIds: [], emails: [] };
    existing.threadIds.push(threadId);
    existing.emails.push(...threadEmails);
    grouped.set(accountId, existing);
  }

  return grouped;
}

export function batchArchive() {
  const { selectedThreadIds, emails, removeEmails, clearSelectedThreads, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  const threadIds = Array.from(selectedThreadIds);
  const groupedByAccount = groupSelectedThreadsByAccount(threadIds, emails);
  const allEmailIds = Array.from(groupedByAccount.values()).flatMap((group) =>
    group.emails.map((email) => email.id),
  );

  // Optimistic UI: remove all emails from selected threads
  removeEmails(allEmailIds);
  clearSelectedThreads();

  for (const [accountId, group] of groupedByAccount) {
    addUndoAction({
      id: `archive-batch-${accountId}-${Date.now()}`,
      type: "archive",
      threadCount: group.threadIds.length,
      accountId,
      emails: [...group.emails],
      scheduledAt: Date.now(),
      delayMs: 5000,
    });
  }
  // Tracks intent — user may still undo within 5 s
  trackEvent("email_archived", { thread_count: threadIds.length, source: "batch" });
}

export function batchTrash() {
  const { selectedThreadIds, emails, removeEmails, clearSelectedThreads, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  const threadIds = Array.from(selectedThreadIds);
  const groupedByAccount = groupSelectedThreadsByAccount(threadIds, emails);
  const allEmailIds = Array.from(groupedByAccount.values()).flatMap((group) =>
    group.emails.map((email) => email.id),
  );

  removeEmails(allEmailIds);
  clearSelectedThreads();

  for (const [accountId, group] of groupedByAccount) {
    addUndoAction({
      id: `trash-batch-${accountId}-${Date.now()}`,
      type: "trash",
      threadCount: group.threadIds.length,
      accountId,
      emails: [...group.emails],
      scheduledAt: Date.now(),
      delayMs: 5000,
    });
  }
  // Tracks intent — user may still undo within 5 s
  trackEvent("email_trashed", { thread_count: threadIds.length, source: "batch" });
}

export function batchToggleStar() {
  const { selectedThreadIds, emails, clearSelectedThreads, updateEmail, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  // Group emails by thread for the selected threads
  const selectedThreadEmails = Array.from(
    groupSelectedThreadsByAccount(selectedThreadIds, emails),
  ).flatMap(([accountId, group]) =>
    group.threadIds.map((threadId) => ({
      threadId,
      accountId,
      emails: group.emails.filter((email) => email.threadId === threadId),
    })),
  );

  // If any thread is unstarred, star all; otherwise unstar all
  const anyUnstarred = selectedThreadEmails.some(
    (t) => !t.emails.some((e) => e.labelIds?.includes("STARRED")),
  );

  const changedEmails: DashboardEmail[] = [];
  const previousLabels: Record<string, string[]> = {};

  for (const thread of selectedThreadEmails) {
    if (anyUnstarred) {
      for (const email of thread.emails) {
        const currentLabels = email.labelIds || ["INBOX"];
        if (!currentLabels.includes("STARRED")) {
          previousLabels[email.id] = [...currentLabels];
          updateEmail(email.id, { labelIds: [...currentLabels, "STARRED"] });
          changedEmails.push(email);
        }
      }
    } else {
      const starredEmails = thread.emails.filter((e) => e.labelIds?.includes("STARRED"));
      for (const email of starredEmails) {
        const currentLabels = email.labelIds || [];
        previousLabels[email.id] = [...currentLabels];
        const newLabels = currentLabels.filter((l: string) => l !== "STARRED");
        updateEmail(email.id, { labelIds: newLabels });
        changedEmails.push(email);
      }
    }
  }

  clearSelectedThreads();

  if (changedEmails.length > 0) {
    const actionType = anyUnstarred ? "star" : "unstar";
    const changedByAccount = new Map<string, DashboardEmail[]>();
    for (const email of changedEmails) {
      const existing = changedByAccount.get(email.accountId) ?? [];
      existing.push(email);
      changedByAccount.set(email.accountId, existing);
    }

    for (const [accountId, accountEmails] of changedByAccount) {
      const accountPreviousLabels = Object.fromEntries(
        accountEmails
          .map((email) => {
            const labels = previousLabels[email.id];
            return labels ? ([email.id, labels] as const) : null;
          })
          .filter((entry): entry is readonly [string, string[]] => entry !== null),
      );
      addUndoAction({
        id: `${actionType}-batch-${accountId}-${Date.now()}`,
        type: actionType,
        threadCount: new Set(accountEmails.map((email) => email.threadId)).size,
        accountId,
        emails: accountEmails,
        scheduledAt: Date.now(),
        delayMs: 5000,
        previousLabels: accountPreviousLabels,
      });
    }
    const changedThreadCount = new Set(changedEmails.map((e) => e.threadId)).size;
    trackEvent(anyUnstarred ? "email_starred" : "email_unstarred", {
      thread_count: changedThreadCount,
    });
  }
}

export function batchMarkUnread() {
  const { selectedThreadIds, emails, clearSelectedThreads, updateEmail, addUndoAction } =
    useAppStore.getState();
  if (selectedThreadIds.size === 0) return;

  const changedEmails: DashboardEmail[] = [];
  const previousLabels: Record<string, string[]> = {};

  for (const threadId of selectedThreadIds) {
    const threadEmails = emails.filter((e) => e.threadId === threadId);
    if (threadEmails.length === 0) continue;
    const latestEmail = threadEmails.reduce((a, b) =>
      new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b,
    );
    const currentLabels = latestEmail.labelIds || ["INBOX"];
    // Only mark emails that aren't already unread
    if (!currentLabels.includes("UNREAD")) {
      previousLabels[latestEmail.id] = [...currentLabels];
      updateEmail(latestEmail.id, { labelIds: [...currentLabels, "UNREAD"] });
      changedEmails.push(latestEmail);
    }
  }

  clearSelectedThreads();

  if (changedEmails.length > 0) {
    const changedByAccount = new Map<string, DashboardEmail[]>();
    for (const email of changedEmails) {
      const existing = changedByAccount.get(email.accountId) ?? [];
      existing.push(email);
      changedByAccount.set(email.accountId, existing);
    }

    for (const [accountId, accountEmails] of changedByAccount) {
      const accountPreviousLabels = Object.fromEntries(
        accountEmails
          .map((email) => {
            const labels = previousLabels[email.id];
            return labels ? ([email.id, labels] as const) : null;
          })
          .filter((entry): entry is readonly [string, string[]] => entry !== null),
      );
      addUndoAction({
        id: `mark-unread-batch-${accountId}-${Date.now()}`,
        type: "mark-unread",
        threadCount: accountEmails.length,
        accountId,
        emails: accountEmails,
        scheduledAt: Date.now(),
        delayMs: 5000,
        previousLabels: accountPreviousLabels,
      });
    }
    trackEvent("email_marked_unread", {
      thread_count: new Set(changedEmails.map((e) => e.threadId)).size,
    });
  }
}
