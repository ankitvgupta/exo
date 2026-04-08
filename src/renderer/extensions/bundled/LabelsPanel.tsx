import React, { useState, useCallback, useRef, useEffect, useMemo } from "react";
import type { DashboardEmail, LabelInfo } from "../../../shared/types";
import type { ExtensionEnrichmentResult } from "../../../shared/extension-types";

interface LabelsEnrichmentData {
  labels: LabelInfo[];
  allLabelIds: string[];
}

interface LabelsPanelProps {
  email: DashboardEmail;
  threadEmails: DashboardEmail[];
  enrichment: ExtensionEnrichmentResult | null;
  isLoading: boolean;
}

// Type for the labels API on window.api
type LabelsAPI = {
  list: (accountId: string) => Promise<{ success: boolean; data?: LabelInfo[] }>;
  modifyMessage: (
    accountId: string,
    emailId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ) => Promise<{ success: boolean; data?: { labelIds: string[] }; error?: string }>;
  modifyThread: (
    accountId: string,
    threadId: string,
    addLabelIds: string[],
    removeLabelIds: string[],
  ) => Promise<{ success: boolean; error?: string }>;
};

declare global {
  interface Window {
    api: {
      labels: LabelsAPI;
      [key: string]: unknown;
    };
  }
}

// System labels the UI already shows via other means — filter from picker and display
const HIDDEN_SYSTEM = new Set([
  "INBOX",
  "UNREAD",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "IMPORTANT",
  "STARRED",
  "CATEGORY_PERSONAL",
  "CATEGORY_SOCIAL",
  "CATEGORY_UPDATES",
  "CATEGORY_FORUMS",
  "CATEGORY_PROMOTIONS",
]);

export function LabelsPanel({
  email,
  enrichment,
  isLoading,
}: LabelsPanelProps): React.ReactElement {
  const data = enrichment?.data as LabelsEnrichmentData | undefined;
  const [currentLabels, setCurrentLabels] = useState<LabelInfo[]>([]);
  const [allLabels, setAllLabels] = useState<LabelInfo[]>([]);
  const [showPicker, setShowPicker] = useState(false);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Sync enrichment data into local state
  useEffect(() => {
    if (data?.labels) {
      setCurrentLabels(data.labels);
    }
  }, [data]);

  // Fetch all labels for the picker
  useEffect(() => {
    const accountId = email.accountId || "default";
    window.api.labels
      .list(accountId)
      .then((result: { success: boolean; data?: LabelInfo[] }) => {
        if (result.success && result.data) {
          setAllLabels(result.data);
        }
      })
      .catch(() => {
        // Labels list failed — picker will show empty, which is safe
      });
  }, [email.accountId]);

  // Focus input when picker opens
  useEffect(() => {
    if (showPicker && inputRef.current) {
      inputRef.current.focus();
    }
  }, [showPicker]);

  // Close picker on outside click
  useEffect(() => {
    if (!showPicker) return;
    const handleClick = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [showPicker]);

  const removeLabel = useCallback(
    async (labelId: string) => {
      const accountId = email.accountId || "default";
      const threadId = email.threadId;
      setBusy(true);
      try {
        // Gmail labels are thread-level — remove from entire thread
        const result = await window.api.labels.modifyThread(accountId, threadId, [], [labelId]);
        if (result.success) {
          setCurrentLabels((prev) => prev.filter((l) => l.id !== labelId));
        }
      } finally {
        setBusy(false);
      }
    },
    [email.threadId, email.accountId],
  );

  const addLabel = useCallback(
    async (label: LabelInfo) => {
      const accountId = email.accountId || "default";
      const threadId = email.threadId;
      setBusy(true);
      try {
        // Gmail labels are thread-level — add to entire thread
        const result = await window.api.labels.modifyThread(accountId, threadId, [label.id], []);
        if (result.success) {
          setCurrentLabels((prev) => {
            if (prev.some((l) => l.id === label.id)) return prev;
            return [...prev, label].sort((a, b) => a.name.localeCompare(b.name));
          });
        }
        setShowPicker(false);
        setSearch("");
      } finally {
        setBusy(false);
      }
    },
    [email.threadId, email.accountId],
  );

  // Reset highlight when search changes
  useEffect(() => {
    setHighlightIndex(0);
  }, [search]);

  const availableLabels = useMemo(() => {
    const currentIds = new Set(currentLabels.map((l) => l.id));
    return allLabels
      .filter((l) => !HIDDEN_SYSTEM.has(l.id) && !currentIds.has(l.id))
      .filter((l) => !search || l.name.toLowerCase().includes(search.toLowerCase()))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [allLabels, currentLabels, search]);

  return (
    <div className="p-4">
      {isLoading && (
        <div className="flex items-center space-x-2 text-gray-500 dark:text-gray-400 py-4">
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
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
          <span className="text-sm">Loading labels...</span>
        </div>
      )}

      {!isLoading && (
        <>
          {/* Current labels as removable chips */}
          <div className="flex flex-wrap gap-1.5 mb-2">
            {currentLabels.map((label) => (
              <span
                key={label.id}
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium group ${
                  label.color ? "" : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300"
                }`}
                style={
                  label.color
                    ? { backgroundColor: label.color.backgroundColor, color: label.color.textColor }
                    : undefined
                }
              >
                {label.name}
                <button
                  onClick={() => removeLabel(label.id)}
                  disabled={busy}
                  className="opacity-50 hover:opacity-100 transition-opacity ml-0.5"
                  title={`Remove ${label.name}`}
                >
                  <svg
                    className="w-3 h-3"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}

            {currentLabels.length === 0 && (
              <span className="text-xs text-gray-400 dark:text-gray-500">No labels</span>
            )}
          </div>

          {/* Add label button / picker */}
          <div className="relative" ref={pickerRef}>
            {!showPicker ? (
              <button
                onClick={() => setShowPicker(true)}
                className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
              >
                + Add label
              </button>
            ) : (
              <div className="border border-gray-200 dark:border-gray-600 rounded-lg overflow-hidden bg-white dark:bg-gray-800 shadow-lg">
                <input
                  ref={inputRef}
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search labels..."
                  className="w-full px-3 py-2 text-sm bg-transparent border-b border-gray-200 dark:border-gray-600 outline-none text-gray-900 dark:text-gray-100 placeholder-gray-400"
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setShowPicker(false);
                      setSearch("");
                    } else if (e.key === "ArrowDown") {
                      e.preventDefault();
                      setHighlightIndex((i) =>
                        Math.min(i + 1, Math.min(availableLabels.length - 1, 49)),
                      );
                    } else if (e.key === "ArrowUp") {
                      e.preventDefault();
                      setHighlightIndex((i) => Math.max(i - 1, 0));
                    } else if (e.key === "Enter" && availableLabels.length > 0) {
                      addLabel(
                        availableLabels[Math.min(highlightIndex, availableLabels.length - 1)],
                      );
                    }
                  }}
                />
                <div className="max-h-48 overflow-y-auto">
                  {availableLabels.length === 0 && (
                    <div className="px-3 py-2 text-xs text-gray-400">No matching labels</div>
                  )}
                  {availableLabels.slice(0, 50).map((label, index) => (
                    <button
                      key={label.id}
                      ref={(el) => {
                        if (index === highlightIndex && el) {
                          el.scrollIntoView({ block: "nearest" });
                        }
                      }}
                      onClick={() => addLabel(label)}
                      disabled={busy}
                      className={`w-full text-left px-3 py-1.5 text-sm text-gray-800 dark:text-gray-200 flex items-center gap-2 ${
                        index === highlightIndex
                          ? "bg-blue-100 dark:bg-blue-900/40"
                          : "hover:bg-gray-100 dark:hover:bg-gray-700"
                      }`}
                    >
                      {label.color && (
                        <span
                          className="w-2 h-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: label.color.backgroundColor }}
                        />
                      )}
                      {label.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
