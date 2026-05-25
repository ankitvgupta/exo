import React, { useEffect, useRef, useCallback, useMemo, useDeferredValue, memo } from "react";
import type { InboxDensity, SnoozedEmail, DashboardEmail, LocalDraft } from "../../shared/types";
import { useAppStore, useSplitFilteredThreads, type EmailThread } from "../store";
import { EmailRow } from "./EmailRow";
import { DraftRow } from "./DraftRow";
import { BatchActionBar } from "./BatchActionBar";
import { SplitTabs } from "./SplitTabs";
import {
  batchArchive,
  batchTrash,
  batchMarkUnread,
  batchToggleStar,
} from "../hooks/useBatchActions";
import { draftBodyToHtml } from "../../shared/draft-utils";
import { draftMatchesSplit } from "../utils/split-conditions";
import { useVirtualizer } from "@tanstack/react-virtual";

/** Check if bodyHtml already contains rich formatting tags (from TipTap or draftBodyToHtml).
 *  If so, use it directly instead of re-converting from bodyText. */
function hasRichFormatting(html: string): boolean {
  return /<(p|div|br|strong|em|ol|ul|li)\b/i.test(html);
}

const densityOrder: InboxDensity[] = ["default", "compact"];
const densityLabels: Record<InboxDensity, string> = {
  default: "Default",
  compact: "Compact",
};

// Memoize so parent (App) re-renders don't cascade into the (heavy)
// EmailList subtree. EmailList takes no props; its memo always short-
// circuits when called from a re-rendering parent. It still re-renders
// on its own subscriptions (selectors below), but those are scoped to
// fields that actually change in response to user actions.
export const EmailList = memo(EmailListImpl);
function EmailListImpl() {
  // Per-field selectors instead of `useAppStore()` (no-selector). With no
  // selector the hook returns the entire state object, whose reference
  // changes on every `set()`; this caused EmailList to re-render on every
  // unrelated store update (sync status flips, prefetch progress, etc.).
  // Under bursts (the IPC event flood that follows switching to an account
  // with a large inbox + active background sync) that produced 1000+
  // EmailList re-renders in succession, blocking the renderer for ~9s.
  // Actions are stable function references — read once via getState().
  const isLoading = useAppStore((s) => s.isLoading);
  const prefetchProgress = useAppStore((s) => s.prefetchProgress);
  const syncProgress = useAppStore((s) => s.syncProgress);
  const inboxDensity = useAppStore((s) => s.inboxDensity);
  const snoozedThreads = useAppStore((s) => s.snoozedThreads);
  // Defer currentAccountId in EmailList so the deferred threads array (below)
  // and the local id stay consistent during the 1-frame deferred window. The
  // store-side id updates synchronously — anything that needs the live id
  // (incoming IPC event filters, see callbacks below) reads it via
  // `useAppStore.getState()` at call time. Without this deferral the urgent
  // re-render fires all account-scoped useEffects + IPC responses while the
  // 700+ item virtualizer is mid-commit, which is what produced the original
  // ~9s blocking window.
  const _liveAccountId = useAppStore((s) => s.currentAccountId);
  const currentAccountId = useDeferredValue(_liveAccountId);
  const selectedThreadIds = useAppStore((s) => s.selectedThreadIds);
  const currentSplitId = useAppStore((s) => s.currentSplitId);
  const selectedDraftId = useAppStore((s) => s.selectedDraftId);
  const allLocalDrafts = useAppStore((s) => s.localDrafts);
  const unsnoozedReturnTimes = useAppStore((s) => s.unsnoozedReturnTimes);
  const selectedThreadId = useAppStore((s) => s.selectedThreadId);
  const splits = useAppStore((s) => s.splits);
  const {
    setSelectedEmailId,
    setSelectedThreadId,
    setViewMode,
    setInboxDensity,
    setSnoozedThreads,
    toggleThreadSelected,
    setThreadsSelected,
    clearSelectedThreads,
    selectAllThreads,
    setCurrentSplitId,
    setArchiveReadyThreads,
    removeEmails,
    addUndoAction,
    setSelectedDraftId,
    removeRecentlyUnsnoozedThread,
    markThreadAsRead,
    openCompose,
  } = useAppStore.getState();
  const _sft = useSplitFilteredThreads();
  // useDeferredValue marks `threads` as non-urgent so the (heavy) render
  // of 700+ items doesn't block the click handler. React renders the
  // chrome (header / split tabs) with the new account immediately, and
  // updates the thread list in a separate concurrent pass.
  const threads = useDeferredValue(_sft.threads);

  const isArchiveReadyView = currentSplitId === "__archive-ready__";
  const isDraftsView = currentSplitId === "__drafts__";
  const isSnoozedView = currentSplitId === "__snoozed__";
  const _isPriorityView = currentSplitId === "__priority__";
  const isSentView = currentSplitId === "__sent__";

  // Filter local drafts for the current account
  const localDrafts = useMemo(
    () => allLocalDrafts.filter((d) => !currentAccountId || d.accountId === currentAccountId),
    [allLocalDrafts, currentAccountId],
  );

  // Threads with AI-generated drafts (for the Drafts tab).
  // Filter to drafts with body content — excludes placeholder shells still being generated.
  const threadsWithDrafts = useMemo(
    () => (isDraftsView ? threads.filter((t) => t.draft && t.draft.body) : []),
    [threads, isDraftsView],
  );

  const handleDraftClick = useCallback(
    (draft: LocalDraft) => {
      const restoredDraft = {
        bodyHtml: hasRichFormatting(draft.bodyHtml)
          ? draft.bodyHtml
          : draftBodyToHtml(draft.bodyText || draft.bodyHtml),
        bodyText: draft.bodyText ?? "",
        to: draft.to,
        cc: draft.cc,
        bcc: draft.bcc,
        subject: draft.subject,
        localDraftId: draft.id,
      };

      // Forward drafts belong inline in their thread
      if (draft.isForward && draft.inReplyTo) {
        setSelectedDraftId(null);
        setSelectedEmailId(draft.inReplyTo);
        setSelectedThreadId(draft.threadId ?? null);
        openCompose("forward", draft.inReplyTo, restoredDraft);
      } else {
        setSelectedDraftId(draft.id);
        setSelectedEmailId(null);
        setSelectedThreadId(null);
        openCompose("new", undefined, restoredDraft);
      }
      setViewMode("full");
    },
    [openCompose, setSelectedEmailId, setSelectedThreadId, setSelectedDraftId, setViewMode],
  );

  // Load snoozed emails on mount / account switch.
  // Also processes any snoozes that expired while the app was closed.
  useEffect(() => {
    if (!currentAccountId) return;
    window.api.snooze
      .list(currentAccountId)
      .then((response: { success: boolean; data?: SnoozedEmail[]; expired?: SnoozedEmail[] }) => {
        if (response.success && response.data) {
          setSnoozedThreads(response.data);
        }
        // Process snoozes that expired while the app was closed —
        // adds them to recentlyUnsnoozedThreadIds so they sort correctly
        if (response.expired && response.expired.length > 0) {
          const store = useAppStore.getState();
          for (const email of response.expired) {
            store.handleThreadUnsnoozed(email.threadId, email.snoozeUntil);
          }
        }
      });
    // setSnoozedThreads is read once via useAppStore.getState() above — it's
    // a stable function ref, so listing it as a dep would only mislead a
    // future reader into thinking the effect can re-run because of it.
  }, [currentAccountId]);

  // Listen for snooze events from main process, filtered by current account.
  // Read the live account id from the store inside each callback (not a ref
  // mirroring the deferred local var) so events for the new account aren't
  // dropped during the 1-frame useDeferredValue lag right after a switch.
  useEffect(() => {
    window.api.snooze.onUnsnoozed((data: { emails: SnoozedEmail[] }) => {
      const liveId = useAppStore.getState().currentAccountId;
      for (const email of data.emails) {
        if (email.accountId === liveId) {
          useAppStore.getState().handleThreadUnsnoozed(email.threadId, email.snoozeUntil);
        }
      }
    });
    window.api.snooze.onSnoozed((data: { snoozedEmail: SnoozedEmail }) => {
      const liveId = useAppStore.getState().currentAccountId;
      if (data.snoozedEmail.accountId === liveId) {
        useAppStore.getState().addSnoozedThread(data.snoozedEmail);
      }
    });
    window.api.snooze.onManuallyUnsnoozed(
      (data: { threadId: string; accountId: string; snoozeUntil: number }) => {
        const liveId = useAppStore.getState().currentAccountId;
        if (data.accountId === liveId) {
          useAppStore.getState().handleThreadUnsnoozed(data.threadId, data.snoozeUntil);
        }
      },
    );
    return () => {
      window.api.snooze.removeAllListeners();
    };
  }, []);

  // Load archive-ready threads on mount / account switch
  useEffect(() => {
    if (!currentAccountId) return;
    window.api.archiveReady
      .getThreads(currentAccountId)
      .then((result: { success: boolean; data?: Array<{ threadId: string; reason: string }> }) => {
        if (result.success && result.data) {
          const items = result.data.map((t: { threadId: string; reason: string }) => ({
            threadId: t.threadId,
            reason: t.reason,
          }));
          setArchiveReadyThreads(items);
        }
      });
    // setArchiveReadyThreads is a stable getState() ref — see comment on
    // the snooze effect above.
  }, [currentAccountId]);

  // Listen for new archive-ready results from background prefetch.
  // Read live account id from the store in the callback (same reasoning as
  // the snooze listeners above — avoids dropping events for the new account
  // during the useDeferredValue lag right after an account switch).
  useEffect(() => {
    window.api.archiveReady.onResult(
      (data: { threadId: string; accountId: string; isReady: boolean; reason: string }) => {
        const liveId = useAppStore.getState().currentAccountId;
        if (data.accountId !== liveId) return;
        if (data.isReady) {
          // Add single thread to the set
          useAppStore.setState((state) => {
            const newIds = new Set(state.archiveReadyThreadIds);
            newIds.add(data.threadId);
            const newReasons = new Map(state.archiveReadyReasons);
            newReasons.set(data.threadId, data.reason);
            return { archiveReadyThreadIds: newIds, archiveReadyReasons: newReasons };
          });
        } else {
          // Remove thread from archive-ready (new activity invalidated it)
          useAppStore.setState((state) => {
            if (!state.archiveReadyThreadIds.has(data.threadId)) return state;
            const newIds = new Set(state.archiveReadyThreadIds);
            newIds.delete(data.threadId);
            const newReasons = new Map(state.archiveReadyReasons);
            newReasons.delete(data.threadId);
            return { archiveReadyThreadIds: newIds, archiveReadyReasons: newReasons };
          });
        }
      },
    );

    return () => {
      window.api.archiveReady.removeAllListeners();
    };
  }, []);

  // Expire recently-replied grace periods.
  // When a thread is added to recentlyRepliedThreadIds, schedule its removal
  // after 3 minutes so the thread naturally moves to its correct category.
  const recentlyRepliedThreadIds = useAppStore((s) => s.recentlyRepliedThreadIds);
  const removeRecentlyRepliedThread = useAppStore((s) => s.removeRecentlyRepliedThread);
  useEffect(() => {
    if (recentlyRepliedThreadIds.size === 0) return;

    const timers: ReturnType<typeof setTimeout>[] = [];
    const now = Date.now();
    const GRACE_MS = 3 * 60 * 1000;

    for (const [threadId, repliedAt] of recentlyRepliedThreadIds) {
      const remaining = Math.max(0, GRACE_MS - (now - repliedAt));
      timers.push(setTimeout(() => removeRecentlyRepliedThread(threadId), remaining));
    }

    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [recentlyRepliedThreadIds]);

  const handleArchiveAll = useCallback(() => {
    if (!currentAccountId || threads.length === 0) return;

    const archiveReadyThreadIds = threads.map((t) => t.threadId);
    const allEmailIds: string[] = [];
    const allEmails: DashboardEmail[] = [];
    const { emails: currentEmails } = useAppStore.getState();
    for (const thread of threads) {
      const threadEmails = currentEmails.filter((e) => e.threadId === thread.threadId);
      for (const email of threadEmails) {
        allEmailIds.push(email.id);
        allEmails.push(email);
      }
    }

    removeEmails(allEmailIds);
    setCurrentSplitId("__priority__");

    addUndoAction({
      id: `archive-all-${Date.now()}`,
      type: "archive",
      threadCount: threads.length,
      accountId: currentAccountId,
      emails: allEmails,
      scheduledAt: Date.now(),
      delayMs: 5000,
      archiveReadyThreadIds,
    });
  }, [currentAccountId, threads, removeEmails, setCurrentSplitId, addUndoAction]);

  const currentProgress = currentAccountId ? syncProgress[currentAccountId] : null;
  const isInitialSyncing = currentProgress && currentProgress.fetched < currentProgress.total;

  const isPrefetching = prefetchProgress.status === "running";
  const isAnalyzingTask = isPrefetching && prefetchProgress.currentTask?.type === "analysis";
  const agentDrafts = prefetchProgress.agentDrafts;
  const hasActiveAgentDrafts = agentDrafts && (agentDrafts.running > 0 || agentDrafts.queued > 0);

  // Ref for the list container to enable scrolling
  const listRef = useRef<HTMLDivElement>(null);

  const isMultiSelectActive = selectedThreadIds.size > 0;

  // Keep visible threads in a ref so getThreadRange always reads the latest list
  // without appearing in the useCallback deps. This prevents handleThreadClick
  // from getting a new reference when threads change, which matters because
  // the EmailRow memo comparator intentionally skips onClick.
  // In drafts view, only AI-draft threads are visible — use that subset for range selection.
  const visibleThreads = isDraftsView ? threadsWithDrafts : threads;
  const threadsRef = useRef(visibleThreads);
  useEffect(() => {
    threadsRef.current = visibleThreads;
  });

  // Shift+click range selection helper — stable ref avoids stale closure
  const getThreadRange = useCallback((fromId: string, toId: string): string[] => {
    const ts = threadsRef.current;
    const fromIndex = ts.findIndex((t) => t.threadId === fromId);
    const toIndex = ts.findIndex((t) => t.threadId === toId);
    if (fromIndex === -1 || toIndex === -1) return [toId];
    const start = Math.min(fromIndex, toIndex);
    const end = Math.max(fromIndex, toIndex);
    return ts.slice(start, end + 1).map((t) => t.threadId);
  }, []);

  const handleThreadClick = useCallback(
    (thread: EmailThread, e: React.MouseEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      const isShift = e.shiftKey;

      if (isMeta) {
        toggleThreadSelected(thread.threadId);
        return;
      }

      if (isShift) {
        const {
          lastSelectedThreadId: anchor_,
          selectedThreadId: currentThreadId,
          selectedThreadIds: currentSelected,
        } = useAppStore.getState();
        const anchor = anchor_ || currentThreadId;
        if (anchor) {
          const range = getThreadRange(anchor, thread.threadId);
          const merged = new Set([...currentSelected, ...range]);
          setThreadsSelected(Array.from(merged));
          useAppStore.getState().setLastSelectedThreadId(thread.threadId);
        } else {
          toggleThreadSelected(thread.threadId);
        }
        return;
      }

      if (useAppStore.getState().selectedThreadIds.size > 0) {
        clearSelectedThreads();
      }
      setSelectedDraftId(null);
      setSelectedThreadId(thread.threadId);
      setSelectedEmailId(thread.latestEmail.id);
      markThreadAsRead(thread.threadId);
      setViewMode("full");
      removeRecentlyUnsnoozedThread(thread.threadId);
    },
    [
      toggleThreadSelected,
      getThreadRange,
      setThreadsSelected,
      clearSelectedThreads,
      setSelectedThreadId,
      setSelectedEmailId,
      setViewMode,
      removeRecentlyUnsnoozedThread,
      markThreadAsRead,
    ],
  );

  const handleCheckboxToggle = useCallback(
    (threadId: string) => {
      toggleThreadSelected(threadId);
    },
    [toggleThreadSelected],
  );

  // Row height depends on density
  const rowHeight = inboxDensity === "compact" ? 32 : 40;

  // Build a flat items array for the virtualizer: drafts at top + thread items
  type ListItem = { type: "draft"; draft: LocalDraft } | { type: "thread"; thread: EmailThread };

  // Resolve the current custom split (if any) for draft filtering
  const currentSplit = useMemo(
    () => (currentSplitId ? splits.find((s) => s.id === currentSplitId) : undefined),
    [currentSplitId, splits],
  );

  const items = useMemo((): ListItem[] => {
    if (isDraftsView) return []; // Drafts view is non-virtualized
    const result: ListItem[] = [];
    // Drafts at top (except in archive-ready and sent views)
    if (localDrafts.length > 0 && !isArchiveReadyView && !isSentView) {
      let draftsToShow: LocalDraft[];
      if (isSnoozedView) {
        draftsToShow = localDrafts.filter((d) => d.threadId && snoozedThreads.has(d.threadId));
      } else if (currentSplit) {
        // Custom split: only show drafts whose recipients/subject match the split
        draftsToShow = localDrafts.filter((d) => draftMatchesSplit(d, currentSplit));
      } else if (currentSplitId === "__other__") {
        // "Other" is a catch-all for low-priority — don't surface drafts here
        draftsToShow = [];
      } else {
        // "All", "Priority" — show all drafts
        draftsToShow = localDrafts;
      }
      for (const draft of draftsToShow) {
        result.push({ type: "draft", draft });
      }
    }
    for (const thread of threads) {
      result.push({ type: "thread", thread });
    }
    return result;
  }, [
    threads,
    localDrafts,
    isDraftsView,
    isArchiveReadyView,
    isSentView,
    isSnoozedView,
    snoozedThreads,
    currentSplit,
  ]);

  // Calculate initial scroll offset so the virtualizer renders the correct
  // rows on the very first frame (avoids a flash + re-render on mount).
  const initialSelectedIdx = useMemo(() => {
    if (!selectedThreadId) return -1;
    return items.findIndex(
      (item) => item.type === "thread" && item.thread.threadId === selectedThreadId,
    );
  }, []); // intentionally empty — only compute once on mount for initialOffset.
  // On first render items may be empty (sync still loading), so initialOffset
  // becomes undefined and the list starts at top. The effect-based scroll
  // below handles all subsequent selection changes.

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowHeight,
    overscan: 20,
    initialOffset:
      initialSelectedIdx > 0 ? Math.max(0, initialSelectedIdx * rowHeight - 300) : undefined,
  });

  // Scroll selected thread into view when selection changes (not on mount —
  // initialOffset handles that). items and virtualizer are read from the closure
  // and are always fresh for the render where selectedThreadId changed.
  useEffect(() => {
    if (!selectedThreadId) return;
    const idx = items.findIndex(
      (item) => item.type === "thread" && item.thread.threadId === selectedThreadId,
    );
    if (idx === -1) return;
    // align: "auto" is a no-op when the item is already visible, and scrolls
    // minimally when it's not. This avoids the overscan-inclusive range bug
    // where virtualizer.range includes rendered-but-not-visible overscan rows.
    virtualizer.scrollToIndex(idx, { align: "auto" });
  }, [selectedThreadId]);

  // Drafts view is non-virtualized, so the virtualizer scroll-to above is a no-op.
  // Use native scrollIntoView for j/k navigation of AI-draft threads.
  useEffect(() => {
    if (!isDraftsView || !selectedThreadId) return;
    const el = listRef.current?.querySelector(`[data-thread-id="${selectedThreadId}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedThreadId, isDraftsView]);

  const cycleDensity = () => {
    const currentIndex = densityOrder.indexOf(inboxDensity);
    const nextIndex = (currentIndex + 1) % densityOrder.length;
    const next = densityOrder[nextIndex];
    setInboxDensity(next);
    window.api.settings.set({ inboxDensity: next });
  };

  // --- Batch action handlers ---
  const handleBatchSnooze = useCallback(() => {
    if (selectedThreadIds.size === 0) return;
    const firstThreadId = Array.from(selectedThreadIds)[0];
    const firstThread = threads.find((t) => t.threadId === firstThreadId);
    if (firstThread) {
      setSelectedThreadId(firstThread.threadId);
      setSelectedEmailId(firstThread.latestEmail.id);
      useAppStore.getState().setShowSnoozeMenu(true);
    }
  }, [selectedThreadIds, threads, setSelectedThreadId, setSelectedEmailId]);

  const handleSelectAll = useCallback(() => {
    const visibleThreads = isDraftsView ? threadsWithDrafts : threads;
    selectAllThreads(visibleThreads.map((t) => t.threadId));
  }, [threads, threadsWithDrafts, isDraftsView, selectAllThreads]);

  // Email list takes available width (flex-1)
  return (
    <div className="flex-1 bg-white dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700 flex flex-col overflow-hidden">
      {/* Header - top-level mailbox tabs + actions */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-gray-200 dark:border-gray-700">
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              if (isSentView) setCurrentSplitId("__priority__");
            }}
            className={`px-2 py-1 text-sm font-medium rounded transition-colors focus:outline-none ${
              !isSentView
                ? "text-gray-900 dark:text-gray-100"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            Inbox
          </button>
          <button
            onClick={() => setCurrentSplitId("__sent__")}
            className={`px-2 py-1 text-sm font-medium rounded transition-colors inline-flex items-center gap-1 focus:outline-none ${
              isSentView
                ? "text-gray-900 dark:text-gray-100"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            }`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
              />
            </svg>
            Sent
          </button>
        </div>
        <div className="flex items-center gap-2">
          {isArchiveReadyView && threads.length > 0 && (
            <button
              onClick={handleArchiveAll}
              className="px-2.5 py-1 text-xs font-medium text-white bg-green-600 dark:bg-green-500 hover:bg-green-700 dark:hover:bg-green-600 rounded transition-colors flex items-center gap-1"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
              Archive All
            </button>
          )}
          {isAnalyzingTask && (
            <span className="flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400">
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Analyzing
            </span>
          )}
          {hasActiveAgentDrafts && (
            <span
              className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400"
              title={`${agentDrafts.running} drafting, ${agentDrafts.queued} queued`}
            >
              <svg className="w-3 h-3 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                />
              </svg>
              Drafting {agentDrafts.running}/{agentDrafts.running + agentDrafts.queued}
            </span>
          )}
          {/* Density toggle */}
          <button
            onClick={cycleDensity}
            title={`Density: ${densityLabels[inboxDensity]}`}
            aria-label={`Density: ${densityLabels[inboxDensity]}`}
            className="p-1 rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            <svg
              className="w-4 h-4"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              {inboxDensity === "compact" ? (
                <>
                  <line x1="2" y1="4" x2="14" y2="4" />
                  <line x1="2" y1="6.5" x2="14" y2="6.5" />
                  <line x1="2" y1="9" x2="14" y2="9" />
                  <line x1="2" y1="11.5" x2="14" y2="11.5" />
                </>
              ) : (
                <>
                  <line x1="2" y1="4" x2="14" y2="4" />
                  <line x1="2" y1="8" x2="14" y2="8" />
                  <line x1="2" y1="12" x2="14" y2="12" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      {/* Split tabs - hidden in Sent view since sub-tabs are inbox-specific */}
      {!isSentView && <SplitTabs />}

      {/* Initial sync progress bar */}
      {isInitialSyncing && (
        <div className="px-4 py-1.5 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-750">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-gray-500 dark:text-gray-400">
              Loading inbox: {currentProgress.fetched.toLocaleString()} /{" "}
              {currentProgress.total.toLocaleString()}
            </span>
          </div>
          <div className="w-full h-1 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 dark:bg-blue-400 rounded-full transition-all duration-300"
              style={{
                width: `${Math.round((currentProgress.fetched / currentProgress.total) * 100)}%`,
              }}
            />
          </div>
        </div>
      )}

      {/* Batch action bar - shown when threads are multi-selected */}
      <BatchActionBar
        selectedCount={selectedThreadIds.size}
        totalCount={isDraftsView ? threadsWithDrafts.length : threads.length}
        onArchive={batchArchive}
        onTrash={batchTrash}
        onMarkUnread={batchMarkUnread}
        onToggleStar={batchToggleStar}
        onSnooze={handleBatchSnooze}
        onSelectAll={handleSelectAll}
        onClearSelection={clearSelectedThreads}
      />

      {/* Thread list - flat, chronological */}
      <div ref={listRef} className="flex-1 overflow-y-auto">
        {/* Drafts view: local drafts (compose sessions) + threads with AI-generated drafts */}
        {isDraftsView ? (
          <>
            {localDrafts.length === 0 && threadsWithDrafts.length === 0 && !isLoading && (
              <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-500">
                <svg
                  className="w-12 h-12 mb-3"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
                <p className="text-sm">No drafts</p>
              </div>
            )}
            {localDrafts.map((draft) => (
              <DraftRow
                key={draft.id}
                draft={draft}
                isSelected={selectedDraftId === draft.id}
                density={inboxDensity}
                onClick={() => handleDraftClick(draft)}
              />
            ))}
            {threadsWithDrafts.map((thread) => (
              <div key={thread.threadId} data-thread-id={thread.threadId}>
                <EmailRow
                  thread={thread}
                  isSelected={selectedThreadId === thread.threadId}
                  isChecked={selectedThreadIds.has(thread.threadId)}
                  isMultiSelectActive={selectedThreadIds.size > 0}
                  density={inboxDensity}
                  onClick={(e) => handleThreadClick(thread, e)}
                  onCheckboxChange={() => toggleThreadSelected(thread.threadId)}
                />
              </div>
            ))}
          </>
        ) : items.length > 0 ? (
          <div
            style={{
              height: virtualizer.getTotalSize(),
              width: "100%",
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const item = items[virtualRow.index];
              if (item.type === "draft") {
                return (
                  <div
                    key={`draft-${item.draft.id}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <DraftRow
                      draft={item.draft}
                      isSelected={selectedDraftId === item.draft.id}
                      density={inboxDensity}
                      onClick={() => handleDraftClick(item.draft)}
                    />
                  </div>
                );
              }
              const thread = item.thread;
              const isSelected = thread.threadId === selectedThreadId;
              const isChecked = selectedThreadIds.has(thread.threadId);
              return (
                <div
                  key={thread.threadId}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <EmailRow
                    thread={thread}
                    isSelected={isSelected}
                    isChecked={isChecked}
                    isMultiSelectActive={isMultiSelectActive}
                    density={inboxDensity}
                    onClick={(e) => handleThreadClick(thread, e)}
                    onCheckboxChange={() => handleCheckboxToggle(thread.threadId)}
                    snoozeInfo={isSnoozedView ? snoozedThreads.get(thread.threadId) : undefined}
                    returnTime={unsnoozedReturnTimes.get(thread.threadId)}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          /* Empty state (only in inbox views) */
          !isLoading && (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400 dark:text-gray-500">
              <svg className="w-12 h-12 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                {isSnoozedView ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                ) : isSentView ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={1.5}
                    d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"
                  />
                )}
              </svg>
              <p className="text-sm">
                {isSnoozedView ? "No snoozed emails" : isSentView ? "No sent emails" : "Inbox zero"}
              </p>
            </div>
          )
        )}
      </div>
    </div>
  );
}
