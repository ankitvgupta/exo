import { memo } from "react";
import type { InboxDensity, SnoozedEmail } from "../../shared/types";
import type { EmailThread } from "../store";
import { formatSnoozeTime } from "./SnoozeMenu";

interface EmailRowProps {
  thread: EmailThread;
  isSelected: boolean;
  isChecked: boolean;
  isMultiSelectActive: boolean;
  density: InboxDensity;
  onClick: (e: React.MouseEvent) => void;
  onCheckboxChange: () => void;
  snoozeInfo?: SnoozedEmail;
  returnTime?: number; // Unsnooze return time — shown instead of last message time
}

// Density-specific style maps
const densityStyles = {
  default: {
    row: "h-10 px-4 gap-2 text-sm",
    senderWidth: "w-32",
    priorityBadge: "text-[10px] px-1.5 py-0.5",
    time: "w-10 text-xs",
    threadBadge: "text-[10px] w-5 h-5",
    unreadDot: "w-1.5 h-1.5",
  },
  compact: {
    row: "h-8 px-3 gap-1.5 text-xs",
    senderWidth: "w-28",
    priorityBadge: "text-[9px] px-1 py-px",
    time: "w-9 text-[10px]",
    threadBadge: "text-[9px] w-4 h-4",
    unreadDot: "w-1.5 h-1.5",
  },
} as const;

// Format relative date compactly
function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return "now";
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatSnoozeCountdown(snoozeUntil: number): string {
  const diffMs = snoozeUntil - Date.now();
  if (diffMs <= 0) return "now";
  const diffMins = Math.ceil(diffMs / 60000);
  const diffHours = Math.ceil(diffMs / 3600000);
  const diffDays = Math.ceil(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return new Date(snoozeUntil).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Extract sender name from email address
function extractSenderName(from: string): string {
  const match = from.match(/^([^<]+)/);
  return match ? match[1].trim() : from;
}

// Decode HTML entities (Gmail API returns snippets/subjects with entities like &#39;)
function decodeHtmlEntities(text: string): string {
  const textarea = document.createElement("textarea");
  textarea.innerHTML = text;
  return textarea.value;
}

// Get priority label info
function getPriorityLabel(thread: EmailThread): { text: string; className: string } | null {
  if (thread.draft?.status === "created") {
    return {
      text: "Done",
      className: "priority-done",
    };
  }
  if (!thread.analysis) {
    return null; // Unanalyzed - no label
  }
  // Note: the store's categorization uses effectiveUserReplied (with a grace period)
  // while we check userReplied directly. During the ~3 min grace window, the badge
  // may show "Skip" while the thread still sits in Priority. This is acceptable:
  // the user just replied so "Skip" is the correct eventual state.
  if (!thread.analysis.needsReply || thread.userReplied) {
    return {
      text: "Skip",
      className: "priority-skipped",
    };
  }
  const priority = thread.analysis.priority || "medium";
  const colors: Record<string, string> = {
    high: "priority-high",
    medium: "priority-medium",
    low: "priority-low",
  };
  return {
    text: priority.charAt(0).toUpperCase() + priority.slice(1),
    className: colors[priority] || colors.medium,
  };
}

// Memoized so that j/k navigation only re-renders the two rows whose
// isSelected changed, not every row in the list.  The custom comparator
// skips onClick/onCheckboxChange (always new arrow functions from the parent).
export const EmailRow = memo(
  function EmailRow({
    thread,
    isSelected,
    isChecked,
    isMultiSelectActive,
    density,
    onClick,
    onCheckboxChange,
    snoozeInfo,
    returnTime,
  }: EmailRowProps) {
    const senderName = extractSenderName(thread.displaySender);
    const time = returnTime
      ? formatRelativeDate(new Date(returnTime).toISOString())
      : formatRelativeDate(thread.latestReceivedEmail.date);
    const rawSnippet = thread.latestEmail.snippet || "";
    const snippet = decodeHtmlEntities(rawSnippet);
    const priorityLabel = getPriorityLabel(thread);
    // Fallback to "default" if stored density is unrecognized (e.g. removed "comfortable")
    const ds = densityStyles[density] ?? densityStyles.default;

    const isUnread = thread.isUnread;
    const isRecentlyUnsnoozed = returnTime !== undefined;
    // Unsnoozed emails appear bold like unread emails (without marking unread in Gmail)
    const isVisuallyUnread = isUnread || isRecentlyUnsnoozed;

    const showChecked = isChecked || isMultiSelectActive;

    return (
      <div
        data-thread-id={thread.threadId}
        data-selected={isSelected ? "true" : undefined}
        className={`
        w-full ${ds.row} flex items-center text-left exo-list-row group
        ${
          isSelected && !isChecked
            ? "exo-list-row-selected text-white"
            : isChecked
              ? "exo-list-row-checked exo-text-primary"
              : "exo-text-primary"
        }
      `}
      >
        {/* Checkbox / Unread indicator area */}
        <div className="w-5 flex-shrink-0 flex items-center justify-center">
          {showChecked ? (
            <input
              type="checkbox"
              checked={isChecked}
              onChange={(e) => {
                e.stopPropagation();
                onCheckboxChange();
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-3.5 h-3.5 rounded border-[var(--exo-border-strong)] text-[var(--exo-accent)] focus:ring-[var(--exo-focus-ring)] cursor-pointer"
              data-testid="thread-checkbox"
            />
          ) : (
            <div className="w-2 flex items-center justify-center">
              {isRecentlyUnsnoozed ? (
                <div
                  className={`${ds.unreadDot} rounded-full ${isSelected ? "bg-white" : "bg-fuchsia-500"}`}
                />
              ) : isUnread ? (
                <div
                  className={`${ds.unreadDot} rounded-full ${isSelected ? "bg-white" : "bg-[var(--exo-accent)]"}`}
                />
              ) : null}
            </div>
          )}
        </div>

        {/* Clickable area for opening the thread */}
        <button
          onClick={onClick}
          className="flex-1 flex items-center gap-2 min-w-0 h-full text-left"
        >
          {/* Sender name */}
          <div
            className={`${ds.senderWidth} truncate font-medium flex-shrink-0 ${
              isSelected && !isChecked
                ? "text-white"
                : isVisuallyUnread
                  ? "text-[var(--exo-text-primary)]"
                  : "text-[var(--exo-text-secondary)]"
            }`}
          >
            {senderName}
          </div>

          {/* Priority label */}
          {priorityLabel && (
            <span
              className={`
          ${ds.priorityBadge} rounded-sm flex-shrink-0 uppercase font-medium exo-micro-label
          ${isSelected && !isChecked ? "bg-white/20 text-white" : priorityLabel.className}
        `}
            >
              {priorityLabel.text}
            </span>
          )}

          {/* Subject + Snippet (combined to use available space) */}
          <div
            className={`flex-1 min-w-0 flex items-center ${density === "compact" ? "gap-1.5" : "gap-2"}`}
          >
            <span
              className={`font-medium truncate flex-shrink-0 max-w-[85%] ${
                isSelected && !isChecked
                  ? "text-white"
                  : isVisuallyUnread
                    ? "text-[var(--exo-text-primary)]"
                    : "text-[var(--exo-text-secondary)]"
              }`}
            >
              {decodeHtmlEntities(thread.subject)}
            </span>
            <span
              className={`flex-shrink ${isSelected && !isChecked ? "text-white/40" : "text-[var(--exo-border-strong)]"}`}
            >
              —
            </span>
            {thread.draft ? (
              <>
                <span
                  className={`flex-shrink-0 ${isSelected && !isChecked ? "text-green-200" : "text-[var(--exo-priority-low-text)]"}`}
                >
                  <svg
                    className="w-3 h-3 inline-block mr-0.5 -mt-px"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                    />
                  </svg>
                  Draft
                </span>
                <span
                  className={`truncate min-w-0 ${
                    isSelected && !isChecked ? "text-white/60" : "text-[var(--exo-text-muted)]"
                  }`}
                >
                  {(thread.draft.body ?? "")
                    .replace(/<[^>]*>/g, "")
                    .replace(/\n/g, " ")
                    .substring(0, 100)}
                </span>
              </>
            ) : (
              <span
                className={`truncate min-w-0 ${
                  isSelected && !isChecked ? "text-white/60" : "text-[var(--exo-text-muted)]"
                }`}
              >
                {snippet}
              </span>
            )}
          </div>

          {/* Snooze indicator */}
          {snoozeInfo && (
            <span
              className={`flex items-center gap-0.5 flex-shrink-0 ${
                isSelected && !isChecked ? "text-white/60" : "text-[#9a6308] dark:text-[#ffd65c]"
              }`}
              title={`Snoozed until ${formatSnoozeTime(snoozeInfo.snoozeUntil)}`}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
            </span>
          )}

          {/* Time */}
          <span
            className={`${ds.time} text-right flex-shrink-0 tabular-nums exo-micro-label ${
              isSelected && !isChecked
                ? "text-white/60"
                : snoozeInfo
                  ? "text-[#9a6308] dark:text-[#ffd65c]"
                  : "text-[var(--exo-text-muted)]"
            }`}
          >
            {snoozeInfo ? formatSnoozeCountdown(snoozeInfo.snoozeUntil) : time}
          </span>

          {/* Thread count badge */}
          {thread.hasMultipleEmails && (
            <span
            className={`
          ${ds.threadBadge} rounded-full flex items-center justify-center flex-shrink-0 exo-micro-label
          ${
            isSelected && !isChecked
              ? "bg-white/20 text-white"
              : "bg-[var(--exo-bg-surface-soft)] border border-[var(--exo-border-subtle)] text-[var(--exo-text-muted)]"
          }
        `}
            >
              {thread.emails.length}
            </span>
          )}
        </button>
      </div>
    );
  },
  (prev, next) =>
    prev.thread === next.thread &&
    prev.isSelected === next.isSelected &&
    prev.isChecked === next.isChecked &&
    prev.isMultiSelectActive === next.isMultiSelectActive &&
    prev.density === next.density &&
    prev.snoozeInfo === next.snoozeInfo &&
    prev.returnTime === next.returnTime,
  // onClick / onCheckboxChange intentionally omitted — they are stable in behavior
  // but are new arrow function references on each parent render.
);
