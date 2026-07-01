import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AttachmentMeta, DashboardEmail, IpcResponse } from "../../shared/types";
import { useAppStore } from "../store";
import { isPreviewable } from "../utils/attachments";
import {
  buildOpenables,
  itemMatches,
  MAX_RENDERED_OPENABLE_ITEMS,
  type OpenableAttachment,
  type OpenableItem,
  type OpenableLink,
} from "../utils/openables";
import { formatPlatformShortcut } from "../utils/platform";
import { AttachmentPreviewModal } from "./AttachmentList";

const ICONS = {
  command: "M13 10V3L4 14h7v7l9-11h-7z",
  link: "M13.19 8.688a4.5 4.5 0 016.364 6.364l-1.768 1.768a4.5 4.5 0 01-6.364 0M10.81 15.312a4.5 4.5 0 01-6.364-6.364L6.214 7.18a4.5 4.5 0 016.364 0",
  file: "M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5A3.375 3.375 0 0010.125 2.25H6.75A2.25 2.25 0 004.5 4.5v15A2.25 2.25 0 006.75 21.75h10.5a2.25 2.25 0 002.25-2.25v-5.25z",
};

function PaletteIcon({
  path,
  className = "w-5 h-5 text-gray-400 dark:text-gray-500 flex-shrink-0",
  strokeWidth = 1.5,
}: {
  path: string;
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      strokeWidth={strokeWidth}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={path} />
    </svg>
  );
}

function RowIcon({ item, isSelected }: { item: OpenableItem; isSelected: boolean }) {
  return (
    <PaletteIcon
      path={item.kind === "link" ? ICONS.link : ICONS.file}
      className={`w-5 h-5 flex-shrink-0 ${
        isSelected ? "text-blue-600 dark:text-blue-300" : "text-gray-400 dark:text-gray-500"
      }`}
    />
  );
}

export function OpenLinksAttachmentsPalette({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [loadedEmailState, setLoadedEmailState] = useState<{
    id: string;
    email: DashboardEmail;
  } | null>(null);
  const [loadingEmailId, setLoadingEmailId] = useState<string | null>(null);
  const [openingAttachmentId, setOpeningAttachmentId] = useState<string | null>(null);
  const [previewAttachment, setPreviewAttachment] = useState<{
    attachment: AttachmentMeta;
    data: string;
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const emails = useAppStore((s) => s.emails);
  const selectedEmailId = useAppStore((s) => s.selectedEmailId);
  const focusedThreadEmailId = useAppStore((s) => s.focusedThreadEmailId);
  const viewMode = useAppStore((s) => s.viewMode);
  const currentAccountId = useAppStore((s) => s.currentAccountId);

  const sourceEmailId =
    viewMode === "full" ? (focusedThreadEmailId ?? selectedEmailId) : selectedEmailId;
  const storeEmail = useMemo(
    () => emails.find((email) => email.id === sourceEmailId) ?? null,
    [emails, sourceEmailId],
  );
  const email = loadedEmailState?.id === sourceEmailId ? loadedEmailState.email : storeEmail;
  const accountId = email?.accountId ?? currentAccountId;
  const isLoadingEmail = loadingEmailId === sourceEmailId;
  const openShortcut = useMemo(() => formatPlatformShortcut("O"), []);

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setLoadedEmailState(null);
      setLoadingEmailId(null);
      setOpeningAttachmentId(null);
      setPreviewAttachment(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!previewAttachment) return;

    const handlePreviewEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      setPreviewAttachment(null);
    };

    window.addEventListener("keydown", handlePreviewEscape, true);
    return () => window.removeEventListener("keydown", handlePreviewEscape, true);
  }, [previewAttachment]);

  useEffect(() => {
    if (!isOpen || !sourceEmailId) {
      setLoadingEmailId(null);
      return;
    }

    if (storeEmail?.body) {
      setLoadedEmailState(null);
      setLoadingEmailId(null);
      return;
    }

    let cancelled = false;
    setLoadingEmailId(sourceEmailId);

    window.api.gmail
      .getEmail(sourceEmailId)
      .then((response: unknown) => {
        if (cancelled) return;

        const emailResponse = response as IpcResponse<DashboardEmail>;
        if (emailResponse.success && emailResponse.data.id === sourceEmailId) {
          setLoadedEmailState({ id: sourceEmailId, email: emailResponse.data });
        } else if (!emailResponse.success) {
          console.error("Failed to load email for openables:", emailResponse.error);
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Failed to load email for openables:", error);
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingEmailId((current) => (current === sourceEmailId ? null : current));
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, sourceEmailId, storeEmail?.body]);

  const openableItems = useMemo(() => buildOpenables(email), [email]);

  const filteredItems = useMemo(
    () => openableItems.filter((item) => itemMatches(item, query)),
    [openableItems, query],
  );

  const visibleItems = useMemo(
    () => filteredItems.slice(0, MAX_RENDERED_OPENABLE_ITEMS),
    [filteredItems],
  );

  const groupedItems = useMemo(() => {
    return {
      links: visibleItems.filter((item): item is OpenableLink => item.kind === "link"),
      attachments: visibleItems.filter(
        (item): item is OpenableAttachment => item.kind === "attachment",
      ),
    };
  }, [visibleItems]);

  const flatItems = useMemo(
    () => [...groupedItems.links, ...groupedItems.attachments],
    [groupedItems],
  );
  const hiddenMatchCount = Math.max(filteredItems.length - visibleItems.length, 0);

  useEffect(() => {
    setSelectedIndex(0);
  }, [query, sourceEmailId]);

  useEffect(() => {
    if (flatItems.length === 0 && selectedIndex !== 0) {
      setSelectedIndex(0);
      return;
    }
    if (selectedIndex >= flatItems.length) {
      setSelectedIndex(Math.max(flatItems.length - 1, 0));
    }
  }, [flatItems.length, selectedIndex]);

  useEffect(() => {
    if (!listRef.current) return;
    const selected = listRef.current.querySelector(`[data-index="${selectedIndex}"]`);
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const openAttachment = useCallback(
    async (attachment: OpenableAttachment["attachment"]) => {
      if (!email || !accountId || openingAttachmentId) return;

      setOpeningAttachmentId(attachment.id);
      try {
        if (isPreviewable(attachment.mimeType)) {
          const result = await window.api.attachments.preview(
            email.id,
            attachment.attachmentId,
            accountId,
          );
          if (result.success && result.data) {
            setPreviewAttachment({ attachment, data: result.data.data });
            return;
          }
        }

        await window.api.attachments.download(
          email.id,
          attachment.attachmentId,
          attachment.filename,
          accountId,
        );
      } catch (error) {
        console.error("Failed to open attachment:", error);
      } finally {
        setOpeningAttachmentId(null);
      }
    },
    [accountId, email, openingAttachmentId],
  );

  const executeItem = useCallback(
    (item: OpenableItem) => {
      if (item.kind === "link") {
        onClose();
        requestAnimationFrame(() => {
          window.open(item.url, "_blank", "noopener,noreferrer");
        });
        return;
      }

      void openAttachment(item.attachment);
    },
    [onClose, openAttachment],
  );

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && /^[1-9]$/.test(event.key)) {
        event.preventDefault();
        const index = Number(event.key) - 1;
        const item = flatItems[index];
        if (item) {
          executeItem(item);
        }
        return;
      }

      switch (event.key) {
        case "Escape":
          event.preventDefault();
          event.stopPropagation();
          if (previewAttachment) {
            setPreviewAttachment(null);
            return;
          }
          onClose();
          break;
        case "ArrowDown":
          event.preventDefault();
          if (flatItems.length === 0) return;
          setSelectedIndex((index) => Math.min(index + 1, flatItems.length - 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          if (flatItems.length === 0) return;
          setSelectedIndex((index) => Math.max(index - 1, 0));
          break;
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          if (flatItems.length === 0) return;
          if (flatItems[selectedIndex]) {
            executeItem(flatItems[selectedIndex]);
          }
          break;
      }
    },
    [executeItem, flatItems, onClose, previewAttachment, selectedIndex],
  );

  if (!isOpen) return null;

  let flatIndex = 0;
  const hasItems = flatItems.length > 0;

  const renderRows = (title: string, items: OpenableItem[]) => {
    if (items.length === 0) return null;

    return (
      <div key={title}>
        <div className="px-4 py-1.5 text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
          {title}
        </div>
        {items.map((item) => {
          const index = flatIndex++;
          const isSelected = index === selectedIndex;
          const isOpening =
            item.kind === "attachment" && openingAttachmentId === item.attachment.id;
          const isDisabled = item.kind === "attachment" && openingAttachmentId !== null;

          return (
            <button
              key={item.id}
              data-index={index}
              type="button"
              disabled={isDisabled}
              aria-busy={isOpening || undefined}
              title={item.kind === "link" ? item.url : item.metadata}
              onClick={() => executeItem(item)}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`w-full px-4 py-2 flex items-center gap-3 text-left text-sm transition-colors ${
                isSelected
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                  : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              } ${isDisabled ? "cursor-wait opacity-70" : ""}`}
            >
              <RowIcon item={item} isSelected={isSelected} />
              <span className="min-w-0 flex-1">
                <span className="block font-medium truncate">{item.label}</span>
                <span
                  className={`block text-xs truncate ${
                    isSelected
                      ? "text-blue-600 dark:text-blue-300"
                      : "text-gray-400 dark:text-gray-500"
                  }`}
                >
                  {item.metadata}
                </span>
              </span>
              {isOpening ? (
                <svg
                  className="w-4 h-4 animate-spin text-gray-400 dark:text-gray-500"
                  viewBox="0 0 24 24"
                  fill="none"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="2"
                    opacity="0.25"
                  />
                  <path
                    d="M4 12a8 8 0 018-8"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                  />
                </svg>
              ) : index < 9 ? (
                <kbd className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded font-mono text-gray-500 dark:text-gray-400">
                  {formatPlatformShortcut(index + 1)}
                </kbd>
              ) : null}
            </button>
          );
        })}
      </div>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-start justify-center pt-20">
        <div className="absolute inset-0 bg-black/40" onClick={onClose} />
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Open Links & Attachments"
          className="relative w-full max-w-xl bg-white dark:bg-gray-800 rounded-xl shadow-2xl dark:shadow-black/40 overflow-hidden border border-gray-200 dark:border-gray-700"
        >
          <div className="flex items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700">
            <PaletteIcon
              path={ICONS.command}
              className="w-5 h-5 text-gray-400 flex-shrink-0"
              strokeWidth={2}
            />
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Open Links & Attachments..."
              className="flex-1 text-base outline-none placeholder-gray-400 dark:text-gray-100 dark:placeholder-gray-500 bg-transparent"
            />
            <kbd className="px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
              {openShortcut}
            </kbd>
            <kbd className="px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
              esc
            </kbd>
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {!hasItems ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                {isLoadingEmail
                  ? "Loading links and attachments..."
                  : query
                    ? "No matching links or attachments"
                    : "No links or attachments"}
              </div>
            ) : (
              <>
                {renderRows("Links", groupedItems.links)}
                {renderRows("Attachments", groupedItems.attachments)}
                {hiddenMatchCount > 0 && (
                  <div className="px-4 py-2 text-xs text-gray-400 dark:text-gray-500">
                    {hiddenMatchCount} more {hiddenMatchCount === 1 ? "item" : "items"} match. Keep
                    typing to narrow.
                  </div>
                )}
              </>
            )}
          </div>

          <div className="flex items-center gap-4 px-4 py-2 text-xs text-gray-400 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
            <span>
              <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">&uarr;&darr;</kbd>{" "}
              navigate
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Enter</kbd> open
            </span>
            <span>
              <kbd className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-700 rounded">Esc</kbd> close
            </span>
          </div>
        </div>
      </div>

      {previewAttachment && (
        <AttachmentPreviewModal
          attachment={previewAttachment.attachment}
          data={previewAttachment.data}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </>
  );
}
