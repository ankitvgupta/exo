import { useState } from "react";

interface AgentConfirmationDialogProps {
  toolCallId: string;
  toolName: string;
  description: string;
  input: unknown;
}

export function AgentConfirmationDialog({
  toolCallId,
  toolName,
  description,
  input,
}: AgentConfirmationDialogProps) {
  const [expanded, setExpanded] = useState(false);
  const [responded, setResponded] = useState(false);

  const inputStr = JSON.stringify(input, null, 2);
  const isHighRisk = toolName === "send_reply" || toolName === "send_email";

  const handleResponse = (approved: boolean) => {
    setResponded(true);
    window.api?.agent?.confirm?.(toolCallId, approved);
  };

  if (responded) {
    return (
      <div className="px-3 py-2 bg-gray-50 dark:bg-gray-900 rounded-lg text-sm text-gray-500 dark:text-gray-400">
        Response submitted for {toolName}
      </div>
    );
  }

  return (
    <div className="border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 rounded-lg overflow-hidden">
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2">
        <svg
          className="w-4 h-4 text-amber-500 flex-shrink-0"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-amber-800 dark:text-amber-300">{toolName}</div>
          <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">{description}</div>
        </div>
      </div>

      {/* Input preview */}
      {isHighRisk ? (
        // Full preview for high-risk actions
        <div className="px-3 pb-2">
          <pre className="text-xs text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-800 rounded p-2 overflow-x-auto max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700">
            {inputStr}
          </pre>
        </div>
      ) : (
        // Collapsible for normal actions
        <div className="px-3 pb-2">
          <button
            onClick={() => setExpanded(!expanded)}
            className="text-xs text-amber-600 dark:text-amber-400 hover:text-amber-800 dark:hover:text-amber-300"
          >
            {expanded ? "Hide input" : "Show input"}
          </button>
          {expanded && (
            <pre className="mt-1 text-xs text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-800 rounded p-2 overflow-x-auto max-h-32 overflow-y-auto border border-gray-200 dark:border-gray-700">
              {inputStr}
            </pre>
          )}
        </div>
      )}

      {/* Action buttons */}
      <div className="px-3 py-2 flex items-center gap-2 border-t border-amber-200 dark:border-amber-800">
        <button
          onClick={() => handleResponse(true)}
          className="px-3 py-1 text-xs font-medium bg-green-600 hover:bg-green-700 text-white rounded transition-colors"
        >
          Approve
        </button>
        <button
          onClick={() => handleResponse(false)}
          className="px-3 py-1 text-xs font-medium bg-red-600 hover:bg-red-700 text-white rounded transition-colors"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

export default AgentConfirmationDialog;
