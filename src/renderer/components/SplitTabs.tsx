import { useMemo } from "react";
import { useAppStore, useThreadedEmails, type EmailThread } from "../store";
import type { InboxSplit } from "../../shared/types";
import { emailMatchesSplit } from "../utils/split-conditions";

function threadMatchesSplit(
  thread: EmailThread,
  split: InboxSplit,
  assignedSplitId?: string,
): boolean {
  if (assignedSplitId === split.id) return true;
  return emailMatchesSplit(thread.latestEmail, split);
}

interface TabProps {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}

function Tab({ active, onClick, count, children }: TabProps) {
  return (
    <button
      onClick={onClick}
      className={`
        px-3 py-2 text-sm font-medium whitespace-nowrap
        border-b-2 transition-colors focus:outline-none
        ${
          active
            ? "border-blue-500 dark:border-blue-400 text-blue-600 dark:text-blue-400"
            : "border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600"
        }
      `}
    >
      {children}
      {count !== undefined && (
        <span
          className={`ml-1.5 text-xs ${active ? "text-blue-500 dark:text-blue-400" : "text-gray-400"}`}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// Subcategory filter chip for the Automated tab
interface ChipProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function Chip({ active, onClick, children }: ChipProps) {
  return (
    <button
      onClick={onClick}
      className={`
        px-2.5 py-0.5 text-xs font-medium rounded-full transition-colors focus:outline-none
        ${
          active
            ? "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-300 dark:border-blue-700"
            : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-gray-600 hover:bg-gray-200 dark:hover:bg-gray-600"
        }
      `}
    >
      {children}
    </button>
  );
}

const AUTOMATED_CATEGORIES = [
  { id: null, label: "All" },
  { id: "orders", label: "Orders" },
  { id: "travel", label: "Travel" },
  { id: "receipts", label: "Receipts" },
  { id: "newsletters", label: "Newsletters" },
  { id: "notifications", label: "Notifications" },
  { id: "other", label: "Other" },
] as const;

export function SplitTabs() {
  const allSplits = useAppStore((state) => state.splits);
  const currentAccountId = useAppStore((state) => state.currentAccountId);
  const currentSplitId = useAppStore((state) => state.currentSplitId);
  const setCurrentSplitId = useAppStore((state) => state.setCurrentSplitId);
  const currentAutomatedCategory = useAppStore((state) => state.currentAutomatedCategory);
  const setCurrentAutomatedCategory = useAppStore((state) => state.setCurrentAutomatedCategory);
  const recentlyUnsnoozedThreadIds = useAppStore((state) => state.recentlyUnsnoozedThreadIds);
  const splitAssignments = useAppStore((state) => state.splitAssignments);
  const localDrafts = useAppStore((state) => state.localDrafts);
  const { peopleThreads, automatedThreads, snoozedCount, threads } = useThreadedEmails();

  // Filter splits for current account
  const splits = useMemo(
    () => allSplits.filter((s) => s.accountId === currentAccountId),
    [allSplits, currentAccountId],
  );

  // Shared predicate: threads NOT matching any exclusive split (unless recently unsnoozed)
  const isNonExclusive = useMemo(() => {
    const exclusiveSplits = splits.filter((s) => s.exclusive);
    return (t: EmailThread) =>
      recentlyUnsnoozedThreadIds.has(t.threadId) ||
      !exclusiveSplits.some((s) => threadMatchesSplit(t, s, splitAssignments.get(t.threadId)));
  }, [splits, recentlyUnsnoozedThreadIds, splitAssignments]);

  // Count both local drafts (compose sessions) and AI-generated drafts (on emails)
  const emailDraftsCount = useMemo(
    () => threads.filter((t) => t.draft && t.draft.body).length,
    [threads],
  );
  const localDraftsCount = useMemo(
    () => localDrafts.filter((d) => !currentAccountId || d.accountId === currentAccountId).length,
    [localDrafts, currentAccountId],
  );
  const draftsCount = emailDraftsCount + localDraftsCount;

  // Counts for People and Automated tabs
  const peopleCount = useMemo(
    () => peopleThreads.filter(isNonExclusive).length,
    [peopleThreads, isNonExclusive],
  );
  const automatedCount = useMemo(
    () => automatedThreads.filter(isNonExclusive).length,
    [automatedThreads, isNonExclusive],
  );

  // Sort splits by order (for custom split chips in Automated tab)
  const sortedSplits = useMemo(() => [...splits].sort((a, b) => a.order - b.order), [splits]);

  const isAutomatedView = currentSplitId === "__automated__";

  return (
    <div className="flex flex-col border-b border-gray-200 dark:border-gray-700">
      {/* Primary tabs row */}
      <div className="flex h-10 px-2 overflow-x-auto">
        {/* People tab */}
        <Tab
          active={currentSplitId === "__people__"}
          onClick={() => setCurrentSplitId("__people__")}
          count={peopleCount}
        >
          People
        </Tab>

        {/* Automated tab */}
        <Tab
          active={isAutomatedView}
          onClick={() => setCurrentSplitId("__automated__")}
          count={automatedCount}
        >
          Automated
        </Tab>

        {/* Conditional virtual tabs */}
        {draftsCount > 0 && (
          <Tab
            active={currentSplitId === "__drafts__"}
            onClick={() => setCurrentSplitId("__drafts__")}
            count={draftsCount}
          >
            <span className="inline-flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                />
              </svg>
              Drafts
            </span>
          </Tab>
        )}
        {snoozedCount > 0 && (
          <Tab
            active={currentSplitId === "__snoozed__"}
            onClick={() => setCurrentSplitId("__snoozed__")}
            count={snoozedCount}
          >
            <span className="inline-flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              Snoozed
            </span>
          </Tab>
        )}
      </div>

      {/* Subcategory filter chips for Automated tab */}
      {isAutomatedView && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 overflow-x-auto">
          {AUTOMATED_CATEGORIES.map((cat) => (
            <Chip
              key={cat.id ?? "all"}
              active={currentAutomatedCategory === cat.id}
              onClick={() => setCurrentAutomatedCategory(cat.id)}
            >
              {cat.label}
            </Chip>
          ))}
          {/* Custom splits as additional filter chips */}
          {sortedSplits.map((split) => (
            <Chip
              key={split.id}
              active={currentSplitId === split.id}
              onClick={() => setCurrentSplitId(split.id)}
            >
              {split.icon && <span className="mr-0.5">{split.icon}</span>}
              {split.name}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
