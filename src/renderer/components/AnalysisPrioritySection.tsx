import { useState, useEffect } from "react";
import type { DashboardEmail } from "../../shared/types";

// Priority options for the override dropdown
const PRIORITY_OPTIONS = [
  { value: "skip", label: "Skip", needsReply: false, priority: null },
  { value: "low", label: "Low", needsReply: true, priority: "low" },
  { value: "medium", label: "Medium", needsReply: true, priority: "medium" },
  { value: "high", label: "High", needsReply: true, priority: "high" },
] as const;

function currentPriorityValue(analysis: { needsReply: boolean; priority?: string }): string {
  if (!analysis.needsReply) return "skip";
  return analysis.priority ?? "medium";
}

function priorityColor(value: string): string {
  switch (value) {
    case "high": return "text-red-600 dark:text-red-400";
    case "medium": return "text-yellow-600 dark:text-yellow-400";
    case "low": return "text-blue-600 dark:text-blue-400";
    default: return "text-gray-500 dark:text-gray-400";
  }
}

/** Interactive analysis section with priority override and optional memory reason. */
export function AnalysisPrioritySection({
  email,
  onAnalysisUpdated,
}: {
  email: DashboardEmail;
  onAnalysisUpdated: (newNeedsReply: boolean, newPriority: string | null) => void;
}) {
  const analysis = email.analysis!;
  const current = currentPriorityValue(analysis);

  const [isEditing, setIsEditing] = useState(false);
  const [selectedValue, setSelectedValue] = useState(current);
  const [reason, setReason] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // Reset state when email changes
  useEffect(() => {
    setIsEditing(false);
    setSelectedValue(currentPriorityValue(analysis));
    setReason("");
  }, [email.id]);

  const handleSave = async () => {
    const option = PRIORITY_OPTIONS.find(o => o.value === selectedValue);
    if (!option || selectedValue === current) {
      setIsEditing(false);
      return;
    }

    setIsSaving(true);
    try {
      await window.api.analysis.overridePriority(
        email.id,
        option.needsReply,
        option.priority,
        reason.trim() || undefined,
      );
      onAnalysisUpdated(option.needsReply, option.priority);
      setIsEditing(false);
      setReason("");
    } catch (err) {
      console.error("Failed to override priority:", err);
    } finally {
      setIsSaving(false);
    }
  };

  if (!isEditing) {
    return (
      <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700/50 bg-gray-50 dark:bg-gray-800/50">
        <div className="flex items-center gap-3 text-sm">
          <span className={`font-medium ${analysis.needsReply ? "text-blue-600 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"}`}>
            {analysis.needsReply ? "Needs Reply" : "No Reply Needed"}
          </span>
          {analysis.priority && (
            <>
              <span className="text-gray-300 dark:text-gray-600">·</span>
              <span className={`capitalize ${priorityColor(analysis.priority)}`}>{analysis.priority} priority</span>
            </>
          )}
          <span className="text-gray-300 dark:text-gray-600">·</span>
          <span className="text-gray-400 dark:text-gray-500 flex-1">{analysis.reason}</span>
          <button
            onClick={() => setIsEditing(true)}
            className="text-xs text-gray-400 hover:text-blue-500 dark:hover:text-blue-400 transition-colors"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700/50 bg-gray-50 dark:bg-gray-800/50">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-gray-500 dark:text-gray-400 text-xs font-medium">Priority:</span>
          <div className="flex gap-1">
            {PRIORITY_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setSelectedValue(opt.value)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  selectedValue === opt.value
                    ? opt.value === "skip"
                      ? "bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200"
                      : opt.value === "high"
                        ? "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"
                        : opt.value === "medium"
                          ? "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300"
                          : "bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
        {selectedValue !== current && (
          <>
            <input
              type="text"
              value={reason}
              onChange={e => setReason(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") handleSave(); if (e.key === "Escape") { setIsEditing(false); setSelectedValue(current); setReason(""); } }}
              placeholder="Reason (optional) — helps improve future classification"
              className="w-full px-3 py-1.5 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-blue-400"
              autoFocus
            />
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => { setIsEditing(false); setSelectedValue(current); setReason(""); }}
                className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-3 py-1 text-xs font-medium rounded bg-blue-500 text-white hover:bg-blue-600 disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
          </>
        )}
        {selectedValue === current && (
          <div className="flex justify-end">
            <button
              onClick={() => setIsEditing(false)}
              className="px-3 py-1 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
