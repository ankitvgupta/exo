interface BatchActionBarProps {
  selectedCount: number;
  onArchive: () => void;
  onTrash: () => void;
  onMarkUnread: () => void;
  onToggleStar: () => void;
  onSnooze: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  totalCount: number;
}

export function BatchActionBar({
  selectedCount,
  onArchive,
  onTrash,
  onMarkUnread,
  onToggleStar,
  onSnooze,
  onSelectAll,
  onClearSelection,
  totalCount,
}: BatchActionBarProps) {
  if (selectedCount === 0) return null;

  const allSelected = selectedCount === totalCount && totalCount > 0;

  return (
    <div
      data-testid="batch-action-bar"
      className="h-10 px-4 flex items-center gap-2 border-b border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/30"
    >
      {/* Selection info */}
      <span className="text-sm font-medium text-blue-700 dark:text-blue-300 mr-1">
        {selectedCount} selected
      </span>

      {/* Select all / Clear */}
      {!allSelected && (
        <button
          onClick={onSelectAll}
          className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          data-testid="batch-select-all"
        >
          Select all {totalCount}
        </button>
      )}
      <button
        onClick={onClearSelection}
        className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
        data-testid="batch-clear-selection"
      >
        Clear
      </button>

      {/* Divider */}
      <div className="w-px h-5 bg-blue-200 dark:bg-blue-700 mx-1" />

      {/* Action buttons */}
      <button
        onClick={onArchive}
        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-blue-100 dark:hover:bg-blue-800/50 rounded transition-colors"
        title="Archive selected (e)"
        data-testid="batch-archive"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 8h14M5 8a2 2 0 01-2-2V4a2 2 0 012-2h14a2 2 0 012 2v2a2 2 0 01-2 2M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
        </svg>
      </button>
      <button
        onClick={onTrash}
        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-blue-100 dark:hover:bg-blue-800/50 rounded transition-colors"
        title="Delete selected (#)"
        data-testid="batch-trash"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      </button>
      <button
        onClick={onMarkUnread}
        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-blue-100 dark:hover:bg-blue-800/50 rounded transition-colors"
        title="Mark unread (u)"
        data-testid="batch-mark-unread"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
        </svg>
      </button>
      <button
        onClick={onToggleStar}
        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-blue-100 dark:hover:bg-blue-800/50 rounded transition-colors"
        title="Star selected (s)"
        data-testid="batch-star"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11.48 3.499a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.885a.563.563 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.563.563 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z" />
        </svg>
      </button>
      <button
        onClick={onSnooze}
        className="p-1.5 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-blue-100 dark:hover:bg-blue-800/50 rounded transition-colors"
        title="Snooze selected (h)"
        data-testid="batch-snooze"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      </button>
    </div>
  );
}
