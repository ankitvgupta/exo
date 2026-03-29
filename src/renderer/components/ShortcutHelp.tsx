import { useEffect, useMemo } from "react";
import { getKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useAppStore } from "../store";

interface ShortcutHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

function ShortcutSection({
  title,
  shortcuts,
}: {
  title: string;
  shortcuts: { key: string; description: string }[];
}) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">{title}</h3>
      <div className="space-y-1">
        {shortcuts.map(({ key, description }) => (
          <div key={key} className="flex items-center justify-between text-sm">
            <span className="text-gray-600 dark:text-gray-400">{description}</span>
            <kbd className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-xs font-mono text-gray-700 dark:text-gray-300">
              {key}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ShortcutHelp({ isOpen, onClose }: ShortcutHelpProps) {
  const keyboardBindings = useAppStore((s) => s.keyboardBindings);
  const shortcuts = useMemo(() => getKeyboardShortcuts(keyboardBindings), [keyboardBindings]);

  // Handle Escape key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", handleKeyDown, { capture: true });
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-black/40 w-full max-w-lg p-6">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-lg font-semibold text-gray-800 dark:text-gray-200">Keyboard Shortcuts</h2>
          <span className="text-xs text-gray-400 dark:text-gray-500 ml-2">
            {keyboardBindings === "gmail" ? "Gmail" : "Superhuman"} bindings
          </span>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 ml-auto"
            title="Close (Esc)"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-2 gap-6">
          <ShortcutSection title="Navigation" shortcuts={shortcuts.navigation} />
          <ShortcutSection title="Actions" shortcuts={shortcuts.actions} />
          <ShortcutSection title="Compose" shortcuts={shortcuts.compose} />
          <ShortcutSection title="Search" shortcuts={shortcuts.search} />
          <ShortcutSection title="Other" shortcuts={shortcuts.other} />
        </div>

        <div className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
          <p className="text-xs text-gray-500 dark:text-gray-400 text-center">
            Press <kbd className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded text-xs font-mono">?</kbd> to toggle this help
          </p>
        </div>
      </div>
    </div>
  );
}
