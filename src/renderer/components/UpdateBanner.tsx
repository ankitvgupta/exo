import { useState, useEffect, useCallback } from "react";

type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; progress: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; message: string };

export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // Fetch initial status
    window.api.updates.getStatus().then((result: { success: boolean; data?: UpdateStatus }) => {
      if (result.success && result.data) {
        setStatus(result.data);
      }
    });

    // Listen for status changes — use returned cleanup to remove only this listener
    const cleanup = window.api.updates.onStatusChanged((newStatus: UpdateStatus) => {
      setStatus(newStatus);
      // Un-dismiss when update is downloaded (important enough to re-show)
      if (newStatus.state === "downloaded") {
        setDismissed(false);
      }
    });

    return cleanup;
  }, []);

  const handleDownload = useCallback(() => {
    window.api.updates.download();
  }, []);

  const handleInstall = useCallback(() => {
    window.api.updates.install();
  }, []);

  // Hide for idle, checking, and error states
  if (status.state === "idle" || status.state === "checking" || status.state === "error") {
    return null;
  }

  if (dismissed) {
    return null;
  }

  if (status.state === "available") {
    return (
      <div className="titlebar-no-drag flex items-center gap-2 px-3 py-1.5 bg-indigo-600 dark:bg-indigo-500 rounded-lg text-sm shadow-sm">
        <svg className="w-4 h-4 text-white flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        <span className="text-white font-medium whitespace-nowrap">v{status.version} available</span>
        <button
          onClick={handleDownload}
          className="px-2.5 py-0.5 text-xs font-semibold text-indigo-600 dark:text-indigo-700 bg-white hover:bg-indigo-50 dark:hover:bg-indigo-100 rounded transition-colors"
        >
          Download
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="p-1 text-indigo-200 hover:text-white transition-colors"
          title="Dismiss"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  if (status.state === "downloading") {
    return (
      <div className="titlebar-no-drag flex items-center gap-2 px-3 py-1.5 bg-indigo-600 dark:bg-indigo-500 rounded-lg text-sm shadow-sm">
        <svg className="w-4 h-4 text-white animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
        <span className="text-white font-medium whitespace-nowrap">Downloading...</span>
        <div className="w-20">
          <div className="w-full bg-indigo-400/40 rounded-full h-1.5">
            <div
              className="bg-white h-1.5 rounded-full transition-all duration-300"
              style={{ width: `${status.progress}%` }}
            />
          </div>
        </div>
        <span className="text-indigo-100 text-xs tabular-nums">{status.progress}%</span>
      </div>
    );
  }

  if (status.state === "downloaded") {
    return (
      <div className="titlebar-no-drag flex items-center gap-2 px-3 py-1.5 bg-green-600 dark:bg-green-500 rounded-lg text-sm shadow-sm">
        <svg className="w-4 h-4 text-white flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
        <span className="text-white font-medium whitespace-nowrap">Restart to update</span>
        <button
          onClick={handleInstall}
          className="px-2.5 py-0.5 text-xs font-semibold text-green-600 dark:text-green-700 bg-white hover:bg-green-50 dark:hover:bg-green-100 rounded transition-colors"
        >
          Restart now
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="p-1 text-green-200 hover:text-white transition-colors"
          title="Dismiss"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    );
  }

  return null;
}
