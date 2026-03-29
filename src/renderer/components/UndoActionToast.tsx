import { useEffect, useRef, useCallback } from "react";
import { useAppStore, type UndoActionItem } from "../store";

// Map of item ID -> cancel function for keyboard shortcut access
const cancelHandlers = new Map<string, () => void>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const api = () => (window as any).api;

/**
 * Commit an undo action to the API (execute the actual server-side operation).
 * Standalone so it can be called both from the normal timer path and when
 * a newer action supersedes this one (unmount cleanup).
 */
async function commitAction(item: UndoActionItem, removeFromQueue: () => void): Promise<void> {
  const accountId = item.accountId;
  const { addEmails } = useAppStore.getState();

  switch (item.type) {
    case "archive":
    case "trash": {
      try {
        // For archive, only call the API on INBOX-labeled emails (archiving SENT/other emails is a no-op).
        // Treat null/undefined labelIds as INBOX (matches server-side getInboxEmails query).
        // For trash, all emails should be trashed.
        const emailsToExecute = item.type === "archive"
          ? item.emails.filter(e => !e.labelIds || e.labelIds.includes("INBOX"))
          : item.emails;

        // Use batch API — single Gmail batchModify call instead of N individual calls.
        const emailIds = emailsToExecute.map(e => e.id);
        const result = item.type === "archive"
          ? await api().emails.batchArchive(emailIds, accountId) as { success: boolean; error?: string; failedIds?: string[] }
          : await api().emails.batchTrash(emailIds, accountId) as { success: boolean; error?: string; failedIds?: string[] };

        // If batch call fails, remove from undo queue FIRST so addEmails suppression
        // doesn't silently drop the emails we're trying to restore.
        // For batchTrash partial failures, only restore the emails that actually failed
        // (the IPC handler returns failedIds for precise restoration).
        let failedEmails: typeof emailsToExecute;
        if (result.success) {
          failedEmails = [];
        } else if (result.failedIds) {
          const failedIdSet = new Set(result.failedIds);
          failedEmails = emailsToExecute.filter(e => failedIdSet.has(e.id));
        } else {
          failedEmails = emailsToExecute;
        }
        if (failedEmails.length > 0) {
          console.error(`[Archive] Batch ${item.type} failed, restoring ${failedEmails.length} emails:`, result.error);
          removeFromQueue();
          addEmails(failedEmails);
        }

        // Only dismiss archive-ready threads whose emails all succeeded
        if (item.archiveReadyThreadIds && item.archiveReadyThreadIds.length > 0) {
          const failedEmailIds = new Set(failedEmails.map(e => e.id));
          const store = useAppStore.getState();
          for (const threadId of item.archiveReadyThreadIds) {
            const threadFailed = item.emails
              .filter(e => e.threadId === threadId)
              .some(e => failedEmailIds.has(e.id));
            if (!threadFailed) {
              store.removeArchiveReadyThread(threadId);
              api().archiveReady.dismiss(threadId, accountId).catch((err: unknown) =>
                console.error("Failed to dismiss archive-ready thread:", err)
              );
            }
          }
        }
      } catch (err: unknown) {
        console.error(`[Archive] Batch ${item.type} rejected, restoring ${item.emails.length} emails:`, err);
        removeFromQueue();
        addEmails(item.emails);
      }
      break;
    }

    case "mark-unread": {
      const results = await Promise.allSettled(item.emails.map(e =>
        api().emails.setRead(e.id, accountId, false)
      ));
      // Revert labels only for emails whose API call failed
      if (item.previousLabels) {
        const store = useAppStore.getState();
        for (let i = 0; i < item.emails.length; i++) {
          const failed = results[i].status === "rejected" ||
            (results[i].status === "fulfilled" && !(results[i] as PromiseFulfilledResult<{ success: boolean }>).value?.success);
          if (failed) {
            const prev = item.previousLabels[item.emails[i].id];
            if (prev) {
              store.updateEmail(item.emails[i].id, { labelIds: prev });
            }
          }
        }
      }
      break;
    }

    case "star":
    case "unstar": {
      const starred = item.type === "star";
      const results = await Promise.allSettled(item.emails.map(e =>
        api().emails.setStarred(e.id, accountId, starred)
      ));
      // Revert labels only for emails whose API call failed
      if (item.previousLabels) {
        const store = useAppStore.getState();
        for (let i = 0; i < item.emails.length; i++) {
          const failed = results[i].status === "rejected" ||
            (results[i].status === "fulfilled" && !(results[i] as PromiseFulfilledResult<{ success: boolean }>).value?.success);
          if (failed) {
            const prev = item.previousLabels[item.emails[i].id];
            if (prev) {
              store.updateEmail(item.emails[i].id, { labelIds: prev });
            }
          }
        }
      }
      break;
    }

    case "snooze": {
      // Snooze API was already called immediately; nothing to do on execute.
      // The timer is set server-side.
      break;
    }
  }

  cancelHandlers.delete(item.id);
}

function UndoActionToastItem({ item }: { item: UndoActionItem }) {
  const removeUndoAction = useAppStore((s) => s.removeUndoAction);
  const addEmails = useAppStore((s) => s.addEmails);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executedRef = useRef(false);
  // Keep a stable ref to item for the unmount cleanup closure
  const itemRef = useRef(item);
  itemRef.current = item;

  const doExecute = useCallback(async () => {
    if (executedRef.current) return;
    executedRef.current = true;
    let removed = false;
    await commitAction(item, () => { removeUndoAction(item.id); removed = true; });
    if (!removed) removeUndoAction(item.id);
  }, [item, removeUndoAction]);

  const handleUndo = useCallback(() => {
    if (executedRef.current) return;
    executedRef.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
    cancelHandlers.delete(item.id);

    switch (item.type) {
      case "archive":
      case "trash": {
        // Remove from undo queue FIRST so addEmails suppression doesn't filter these out
        removeUndoAction(item.id);
        addEmails(item.emails);
        return; // already removed from queue
      }

      case "mark-unread": {
        // Revert labels to previous state (remove UNREAD)
        if (item.previousLabels) {
          const store = useAppStore.getState();
          for (const email of item.emails) {
            const prev = item.previousLabels[email.id];
            if (prev) {
              store.updateEmail(email.id, { labelIds: prev });
            }
          }
        }
        break;
      }

      case "star":
      case "unstar": {
        // Undo star/unstar: revert labels to previous state
        if (item.previousLabels) {
          const store = useAppStore.getState();
          for (const email of item.emails) {
            const prev = item.previousLabels[email.id];
            if (prev) {
              store.updateEmail(email.id, { labelIds: prev });
            }
          }
        }
        break;
      }

      case "snooze": {
        // Undo snooze: call unsnooze API and remove from snoozed state
        if (item.snoozedThreadIds) {
          const store = useAppStore.getState();
          for (const threadId of item.snoozedThreadIds) {
            store.removeSnoozedThread(threadId);
            api().snooze.unsnooze(threadId, item.accountId).catch((err: unknown) => {
              console.error("Failed to unsnooze:", err);
            });
          }
        }
        break;
      }
    }

    removeUndoAction(item.id);
  }, [item, addEmails, removeUndoAction]);

  useEffect(() => {
    cancelHandlers.set(item.id, handleUndo);
    return () => { cancelHandlers.delete(item.id); };
  }, [item.id, handleUndo]);

  useEffect(() => {
    const endTime = item.scheduledAt + item.delayMs;
    const remaining = Math.max(0, endTime - Date.now());

    timerRef.current = setTimeout(() => {
      doExecute();
    }, remaining);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [item, doExecute]);

  // When this item is superseded by a newer action (component unmounts because
  // addUndoAction replaced the queue), immediately commit it to the API.
  // Normal flows (timer execute, user undo) set executedRef=true before
  // removing from queue, so this only fires for the superseded case.
  // We check if the item is still in the queue to distinguish real unmount
  // from React StrictMode's simulated unmount/remount cycle.
  useEffect(() => {
    return () => {
      if (!executedRef.current) {
        const queue = useAppStore.getState().undoActionQueue;
        const stillInQueue = queue.some(i => i.id === itemRef.current.id);
        if (!stillInQueue) {
          executedRef.current = true;
          const capturedItem = itemRef.current;
          void commitAction(capturedItem, () => {
            useAppStore.getState().removeUndoAction(capturedItem.id);
          });
        }
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noun = item.threadCount === 1 ? "Thread" : `${item.threadCount} threads`;
  const verbMap: Record<UndoActionItem["type"], string> = {
    archive: "archived",
    trash: "deleted",
    "mark-unread": "marked unread",
    star: "starred",
    unstar: "unstarred",
    snooze: "snoozed",
  };
  const verb = verbMap[item.type];
  const label = `${noun} ${verb}.`;

  return (
    <div className="bg-gray-900 dark:bg-gray-700 text-white rounded-lg shadow-lg flex items-center justify-between px-4 py-3 min-w-[280px]">
      <span className="text-sm">{label}</span>
      {!executedRef.current && (
        <button
          onClick={handleUndo}
          className="ml-4 text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors flex-shrink-0"
          title={navigator.platform.includes("Mac") ? "Cmd+Z" : "Ctrl+Z"}
        >
          Undo
        </button>
      )}
    </div>
  );
}

export function UndoActionToast() {
  const undoActionQueue = useAppStore((s) => s.undoActionQueue);

  // Cmd+Z / Ctrl+Z undoes the most recent pending action
  // Only when there are no pending undo-send items (those take priority)
  useEffect(() => {
    if (undoActionQueue.length === 0) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "z" && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        const currentSendQueue = useAppStore.getState().undoSendQueue;
        if (currentSendQueue.length > 0) return;

        const queue = useAppStore.getState().undoActionQueue;
        if (queue.length === 0) return;

        const lastItem = queue[queue.length - 1];
        const cancel = cancelHandlers.get(lastItem.id);
        if (cancel) {
          e.preventDefault();
          cancel();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undoActionQueue.length]);

  if (undoActionQueue.length === 0) return null;

  return (
    <>
      {undoActionQueue.map((item) => (
        <UndoActionToastItem key={item.id} item={item} />
      ))}
    </>
  );
}
