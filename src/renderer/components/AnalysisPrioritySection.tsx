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
    case "high":
      return "text-red-600 dark:text-red-400";
    case "medium":
      return "text-yellow-600 dark:text-yellow-400";
    case "low":
      return "text-[var(--exo-accent)]";
    default:
      return "exo-text-muted";
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
    const option = PRIORITY_OPTIONS.find((o) => o.value === selectedValue);
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
      <div className="px-6 py-4 border-t exo-border-subtle exo-surface-soft">
        <div className="flex items-center gap-3 text-sm">
          <span
            className={`font-medium ${analysis.needsReply ? "text-[var(--exo-accent)]" : "exo-text-muted"}`}
          >
            {analysis.needsReply ? "Needs Reply" : "No Reply Needed"}
          </span>
          {analysis.priority && (
            <>
              <span className="text-[var(--exo-text-secondary)]">·</span>
              <span className={`capitalize ${priorityColor(analysis.priority)}`}>
                {analysis.priority} priority
              </span>
            </>
          )}
          <span className="text-[var(--exo-text-secondary)]">·</span>
          <span className="exo-text-muted flex-1">{analysis.reason}</span>
          <button
            onClick={() => setIsEditing(true)}
            className="text-xs text-[var(--exo-text-muted)] hover:text-[var(--exo-accent)] transition-colors"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 py-4 border-t exo-border-subtle exo-surface-soft">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="exo-text-muted text-xs font-medium">Priority:</span>
          <div className="flex gap-1">
            {PRIORITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSelectedValue(opt.value)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  selectedValue === opt.value
                    ? opt.value === "skip"
                      ? "bg-[var(--exo-border-subtle)] exo-text-secondary"
                      : opt.value === "high"
                        ? "bg-red-100 dark:bg-red-900/40 text-red-700 dark:text-red-300"
                        : opt.value === "medium"
                          ? "bg-yellow-100 dark:bg-yellow-900/40 text-yellow-700 dark:text-yellow-300"
                          : "bg-[var(--exo-accent-soft)] text-[var(--exo-accent)]"
                    : "bg-[var(--exo-bg-surface-soft)] exo-text-muted hover:bg-[var(--exo-bg-surface-hover)]"
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
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") {
                  setIsEditing(false);
                  setSelectedValue(current);
                  setReason("");
                }
              }}
              placeholder="Reason (optional) — helps improve future classification"
              className="w-full px-3 py-1.5 text-xs rounded border exo-border-subtle bg-[var(--exo-bg-elevated)] exo-text-secondary placeholder-[var(--exo-text-muted)] focus:outline-none focus:ring-1 focus:ring-blue-400"
              autoFocus
            />
            <div className="flex items-center gap-2 justify-end">
              <button
                onClick={() => {
                  setIsEditing(false);
                  setSelectedValue(current);
                  setReason("");
                }}
                className="px-3 py-1 text-xs text-[var(--exo-text-muted)] hover:text-[var(--exo-text-primary)]"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-3 py-1 text-xs font-medium rounded bg-[var(--exo-accent)] text-white hover:bg-[var(--exo-accent)] disabled:opacity-50"
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
              className="px-3 py-1 text-xs text-[var(--exo-text-muted)] hover:text-[var(--exo-text-primary)]"
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
