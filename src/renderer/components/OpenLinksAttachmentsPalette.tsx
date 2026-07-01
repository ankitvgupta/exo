import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { AttachmentMeta, DashboardEmail } from "../../shared/types";
import { useAppStore } from "../store";
import { AttachmentPreviewModal } from "./AttachmentList";

type OpenableLink = {
  kind: "link";
  id: string;
  label: string;
  metadata: string;
  url: string;
};

type OpenableAttachment = {
  kind: "attachment";
  id: string;
  label: string;
  metadata: string;
  attachment: AttachmentMeta;
};

type OpenableItem = OpenableLink | OpenableAttachment;

const MAX_RENDERED_OPENABLE_ITEMS = 100;

type EmailSuccessResponse = {
  success: true;
  data: DashboardEmail;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEmailResponse(value: unknown): value is EmailSuccessResponse {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return false;
  return typeof value.data.id === "string";
}

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const size = bytes / Math.pow(1024, i);
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function isPreviewable(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType === "application/pdf";
}

function displayUrl(url: URL): string {
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.hostname}${path}`;
}

function normalizeLabel(label: string, fallback: string): string {
  const cleaned = label.replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function trimUrlCandidate(candidate: string): string {
  return candidate.replace(/[),.;!?]+$/g, "");
}

function extractLinks(body: string): OpenableLink[] {
  if (!body.trim()) return [];

  const doc = new DOMParser().parseFromString(body, "text/html");
  const anchors = Array.from(doc.querySelectorAll("a[href]"));
  const seen = new Set<string>();
  const links: OpenableLink[] = [];

  const addLink = (rawHref: string, labelText: string) => {
    if (!rawHref) return;

    const href = trimUrlCandidate(rawHref);
    if (!href) return;

    const absoluteHref = href.startsWith("//") ? `https:${href}` : href;
    if (!/^https?:\/\//i.test(absoluteHref)) return;

    let url: URL;
    try {
      url = new URL(absoluteHref);
    } catch {
      return;
    }

    if (url.protocol !== "http:" && url.protocol !== "https:") return;
    if (seen.has(url.href)) return;
    seen.add(url.href);

    links.push({
      kind: "link",
      id: `link:${url.href}`,
      label: normalizeLabel(labelText, displayUrl(url)),
      metadata: displayUrl(url),
      url: url.href,
    });
  };

  for (const anchor of anchors) {
    const rawHref = anchor.getAttribute("href");
    if (!rawHref) continue;

    const title = anchor.getAttribute("title") ?? "";
    const ariaLabel = anchor.getAttribute("aria-label") ?? "";
    addLink(rawHref, anchor.textContent || title || ariaLabel);
  }

  const text = doc.body?.textContent ?? body;
  const urlMatches = text.matchAll(/https?:\/\/[^\s<>"']+/gi);
  for (const match of urlMatches) {
    addLink(match[0], match[0]);
  }

  return links;
}

function attachmentMetadata(attachment: AttachmentMeta): string {
  const parts = [formatFileSize(attachment.size)];
  if (attachment.mimeType) parts.push(attachment.mimeType);
  return parts.join(" - ");
}

function buildOpenables(email: DashboardEmail | null): OpenableItem[] {
  if (!email) return [];

  const links = extractLinks(email.body ?? "");
  const attachments: OpenableAttachment[] = (email.attachments ?? []).map((attachment) => ({
    kind: "attachment",
    id: `attachment:${attachment.id}`,
    label: attachment.filename,
    metadata: attachmentMetadata(attachment),
    attachment,
  }));

  return [...links, ...attachments];
}

function itemMatches(item: OpenableItem, query: string): boolean {
  if (!query.trim()) return true;
  const needle = query.trim().toLowerCase();
  return (
    item.label.toLowerCase().includes(needle) ||
    item.metadata.toLowerCase().includes(needle) ||
    (item.kind === "link" && item.url.toLowerCase().includes(needle))
  );
}

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
  const [loadedEmail, setLoadedEmail] = useState<DashboardEmail | null>(null);
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
  const email = loadedEmail ?? storeEmail;
  const accountId = email?.accountId ?? currentAccountId;

  useEffect(() => {
    if (isOpen) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      setLoadedEmail(null);
      setPreviewAttachment(null);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !sourceEmailId) return;
    if (storeEmail?.body) {
      setLoadedEmail(null);
      return;
    }

    let cancelled = false;
    window.api.gmail
      .getEmail(sourceEmailId)
      .then((response: unknown) => {
        if (!cancelled && isEmailResponse(response)) {
          setLoadedEmail(response.data);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to load email for openables:", error);
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
    async (attachment: AttachmentMeta) => {
      if (!email || !accountId || !attachment.attachmentId) return;

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
    },
    [accountId, email],
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
          onClose();
          break;
        case "ArrowDown":
          event.preventDefault();
          setSelectedIndex((index) => Math.min(index + 1, flatItems.length - 1));
          break;
        case "ArrowUp":
          event.preventDefault();
          setSelectedIndex((index) => Math.max(index - 1, 0));
          break;
        case "Enter":
          event.preventDefault();
          event.stopPropagation();
          if (flatItems[selectedIndex]) {
            executeItem(flatItems[selectedIndex]);
          }
          break;
      }
    },
    [executeItem, flatItems, onClose, selectedIndex],
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
          return (
            <button
              key={item.id}
              data-index={index}
              type="button"
              onClick={() => executeItem(item)}
              onMouseEnter={() => setSelectedIndex(index)}
              className={`w-full px-4 py-2 flex items-center gap-3 text-left text-sm transition-colors ${
                isSelected
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                  : "text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
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
              {index < 9 && (
                <kbd className="px-1.5 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded font-mono text-gray-500 dark:text-gray-400">
                  ⌘{index + 1}
                </kbd>
              )}
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
              ⌘O
            </kbd>
            <kbd className="px-2 py-0.5 text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 rounded">
              esc
            </kbd>
          </div>

          <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
            {!hasItems ? (
              <div className="px-4 py-8 text-center text-sm text-gray-500 dark:text-gray-400">
                {query ? "No matching links or attachments" : "No links or attachments"}
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
