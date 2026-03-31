import { useAppStore } from "../store";

export function OfflineBanner() {
  const { isOnline, outboxStats } = useAppStore();

  // Don't show if online
  if (isOnline) {
    return null;
  }

  return (
    <div className="titlebar-drag bg-amber-50 dark:bg-amber-900/30 border-b border-amber-200 dark:border-amber-800 pl-20 pr-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <svg
          className="w-5 h-5 text-amber-600 dark:text-amber-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"
          />
        </svg>
        <span className="text-amber-800 dark:text-amber-300 text-sm font-medium">
          You're offline
        </span>
        <span className="text-amber-700 dark:text-amber-400 text-sm">
          Messages will send when you reconnect.
        </span>
      </div>
      {outboxStats.pending > 0 && (
        <span className="text-amber-700 dark:text-amber-400 text-sm">
          {outboxStats.pending} message{outboxStats.pending !== 1 ? "s" : ""} queued
        </span>
      )}
    </div>
  );
}
