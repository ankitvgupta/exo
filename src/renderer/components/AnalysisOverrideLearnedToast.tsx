import { useEffect } from "react";
import { useAppStore } from "../store";

/**
 * Toast notification shown when analysis priority override learning produces results.
 * Mirrors DraftEditLearnedToast but for the analysis override pipeline.
 */
export function AnalysisOverrideLearnedToast() {
  const data = useAppStore((s) => s.analysisOverrideLearned);
  const clear = useAppStore((s) => s.clearAnalysisOverrideLearned);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setHighlightMemoryIds = useAppStore((s) => s.setHighlightMemoryIds);

  // Listen for analysis-override:learned events from main process
  useEffect(() => {
    if (!window.api?.memory?.onAnalysisOverrideLearned) return;
    const cleanup = window.api.memory.onAnalysisOverrideLearned((payload: {
      promoted: Array<{ id: string; content: string; scope: string; scopeValue: string | null }>;
      draftMemoriesCreated: number;
    }) => {
      useAppStore.getState().setAnalysisOverrideLearned(payload);
    });
    return cleanup;
  }, []);

  // Auto-dismiss after 8 seconds
  useEffect(() => {
    if (!data) return;
    const timer = setTimeout(clear, 8000);
    return () => clearTimeout(timer);
  }, [data, clear]);

  if (!data) return null;

  const { promoted, draftMemoriesCreated } = data;
  const hasPromoted = promoted.length > 0;
  const hasDraftOnly = draftMemoriesCreated > 0 && !hasPromoted;

  // Subtle toast for draft-only (observations noted, not yet promoted)
  if (hasDraftOnly) {
    return (
      <div className="bg-gray-800 dark:bg-gray-700 text-gray-200 rounded-lg shadow-lg px-4 py-2.5 min-w-[280px] max-w-[400px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">
            {draftMemoriesCreated === 1
              ? "1 pattern noted from priority change"
              : `${draftMemoriesCreated} patterns noted from priority change`}
          </span>
          <button
            onClick={clear}
            className="text-gray-400 hover:text-white transition-colors flex-shrink-0"
            title="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  // Prominent toast for promoted memories (saved as classification rules)
  if (hasPromoted) {
    const navigateToMemories = () => {
      setHighlightMemoryIds(promoted.map(m => m.id));
      clear();
      setShowSettings(true, "memories");
    };

    return (
      <div className="bg-purple-900 dark:bg-purple-800 text-white rounded-lg shadow-lg px-4 py-3 min-w-[320px] max-w-[440px]">
        <div className="flex items-start justify-between gap-3">
          <button
            onClick={navigateToMemories}
            className="flex-1 min-w-0 text-left hover:opacity-90 transition-opacity cursor-pointer"
          >
            <p className="text-xs font-medium text-purple-300 mb-1">
              Saved classification rule
            </p>
            {promoted.slice(0, 2).map((m) => (
              <p key={m.id} className="text-sm truncate" title={m.content}>
                {m.content}
              </p>
            ))}
            {promoted.length > 2 && (
              <p className="text-xs text-purple-300 mt-0.5">
                +{promoted.length - 2} more
              </p>
            )}
            {draftMemoriesCreated > 0 && (
              <p className="text-xs text-purple-400 mt-1">
                +{draftMemoriesCreated} other pattern{draftMemoriesCreated > 1 ? "s" : ""} noted
              </p>
            )}
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              clear();
            }}
            className="text-purple-400 hover:text-white transition-colors flex-shrink-0 mt-0.5"
            title="Dismiss"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>
    );
  }

  return null;
}
