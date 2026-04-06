import { useState, useEffect, useCallback, useMemo } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import {
  Search,
  Plus,
  Reply,
  Archive,
  Trash2,
  Star,
  Mail,
  Settings,
  Keyboard,
  Sun,
  Moon,
  Monitor,
  User,
  Clock,
  Eye,
  ArrowUp,
  Layout,
  RefreshCw,
  Forward,
  type LucideIcon,
} from "lucide-react";
import React from "react";
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator,
  CommandShortcut,
} from "./ui/command";
import { useAppStore, useThreadedEmails } from "../store";
import { splitAddressList, extractFirstName } from "../utils/address-parsing";
import type { DashboardEmail, IpcResponse } from "../../shared/types";

// --- Action types ---

type CommandAction = {
  id: string;
  label: string;
  category: string;
  shortcut?: string;
  icon?: LucideIcon;
  execute: () => void;
  available?: () => boolean;
};

// --- Component ---

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");

  const {
    accounts,
    currentAccountId,
    selectedEmailId,
    selectedThreadId,
    viewMode,
    themePreference,
    inboxDensity,
    openSearch,
    openCompose,
    setShowSettings,
    setViewMode,
    setThemePreference,
    setInboxDensity,
    setCurrentAccountId,
    setSelectedEmailId,
    setSelectedThreadId,
    setShowSnoozeMenu,
    emails,
  } = useAppStore();

  const { threads } = useThreadedEmails();

  // Build action list dynamically based on current state
  const actions: CommandAction[] = useMemo(() => {
    const hasSelectedEmail = !!selectedEmailId;
    const hasSelectedThread = !!selectedThreadId;

    const allActions: CommandAction[] = [
      // --- Search & Navigation ---
      {
        id: "search",
        label: "Search emails",
        category: "Navigation",
        shortcut: "/",
        icon: Search,
        execute: () => openSearch(),
      },
      {
        id: "go-to-inbox",
        label: "Go to inbox",
        category: "Navigation",
        shortcut: "g i",
        icon: Mail,
        execute: () => {
          setViewMode("split");
          useAppStore.getState().clearActiveSearch();
        },
      },
      {
        id: "go-to-top",
        label: "Go to top of list",
        category: "Navigation",
        shortcut: "g g",
        icon: ArrowUp,
        execute: () => {
          if (threads.length > 0) {
            setSelectedThreadId(threads[0].threadId);
            setSelectedEmailId(threads[0].latestEmail.id);
          }
        },
      },

      // --- Compose ---
      {
        id: "compose-new",
        label: "Compose new email",
        category: "Compose",
        shortcut: "c",
        icon: Plus,
        execute: () => {
          setViewMode("full");
          openCompose("new");
        },
      },
      {
        id: "reply-all",
        label: "Reply all",
        category: "Compose",
        shortcut: "r",
        icon: Reply,
        available: () => hasSelectedEmail,
        execute: () => {
          if (selectedEmailId) {
            openCompose("reply-all", selectedEmailId);
          }
        },
      },
      {
        id: "reply",
        label: "Reply (single)",
        category: "Compose",
        shortcut: "R",
        icon: Reply,
        available: () => hasSelectedEmail,
        execute: () => {
          if (selectedEmailId) {
            openCompose("reply", selectedEmailId);
          }
        },
      },
      {
        id: "forward",
        label: "Forward email",
        category: "Compose",
        shortcut: "f",
        icon: Forward,
        available: () => hasSelectedEmail,
        execute: () => {
          if (selectedEmailId) {
            openCompose("forward", selectedEmailId);
          }
        },
      },

      // --- Email Actions ---
      {
        id: "archive",
        label: "Archive email",
        category: "Email Actions",
        shortcut: "e",
        icon: Archive,
        available: () => hasSelectedEmail,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedThreadId && state.currentAccountId) {
            const threadEmails = state.emails.filter((e) => e.threadId === state.selectedThreadId);
            state.removeEmailsAndAdvance(
              threadEmails.map((e) => e.id),
              null,
              null,
            );
            state.addUndoAction({
              id: `archive-${state.selectedThreadId}-${Date.now()}`,
              type: "archive",
              threadCount: 1,
              accountId: state.currentAccountId,
              emails: [...threadEmails],
              scheduledAt: Date.now(),
              delayMs: 5000,
            });
          }
        },
      },
      {
        id: "trash",
        label: "Delete email",
        category: "Email Actions",
        shortcut: "#",
        icon: Trash2,
        available: () => hasSelectedEmail,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedThreadId && state.currentAccountId) {
            const threadEmails = state.emails.filter((e) => e.threadId === state.selectedThreadId);
            state.removeEmailsAndAdvance(
              threadEmails.map((e) => e.id),
              null,
              null,
            );
            state.addUndoAction({
              id: `trash-${state.selectedThreadId}-${Date.now()}`,
              type: "trash",
              threadCount: 1,
              accountId: state.currentAccountId,
              emails: [...threadEmails],
              scheduledAt: Date.now(),
              delayMs: 5000,
            });
          }
        },
      },
      {
        id: "discard-draft",
        label: "Discard draft",
        category: "Email Actions",
        shortcut: "#",
        icon: Trash2,
        available: () => !!useAppStore.getState().selectedDraftId,
        execute: () => {
          const state = useAppStore.getState();
          const draftId = state.selectedDraftId;
          if (draftId) {
            state.removeLocalDraft(draftId);
            window.api.compose.deleteLocalDraft(draftId);
            state.setSelectedDraftId(null);
          }
        },
      },
      {
        id: "mark-unread",
        label: "Mark as unread",
        category: "Email Actions",
        shortcut: "u",
        icon: Eye,
        available: () => hasSelectedThread,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedThreadId && state.currentAccountId) {
            const threadEmails = state.emails.filter((e) => e.threadId === state.selectedThreadId);
            const latest = threadEmails.reduce(
              (a, b) => (new Date(a.date).getTime() >= new Date(b.date).getTime() ? a : b),
              threadEmails[0],
            );
            if (latest) {
              const labels = latest.labelIds || ["INBOX"];
              if (!labels.includes("UNREAD")) {
                const previousLabels: Record<string, string[]> = { [latest.id]: [...labels] };
                state.updateEmail(latest.id, { labelIds: [...labels, "UNREAD"] });
                state.addUndoAction({
                  id: `mark-unread-${state.selectedThreadId}-${Date.now()}`,
                  type: "mark-unread",
                  threadCount: 1,
                  accountId: state.currentAccountId,
                  emails: [latest],
                  scheduledAt: Date.now(),
                  delayMs: 5000,
                  previousLabels,
                });
              }
            }
          }
        },
      },
      {
        id: "snooze",
        label: "Snooze email",
        category: "Email Actions",
        shortcut: "h",
        icon: Clock,
        available: () => hasSelectedEmail,
        execute: () => {
          setShowSnoozeMenu(true);
        },
      },
      {
        id: "star",
        label: "Star / Unstar email",
        category: "Email Actions",
        icon: Star,
        available: () => hasSelectedEmail,
        execute: () => {
          const state = useAppStore.getState();
          if (state.selectedEmailId && state.currentAccountId) {
            const email = state.emails.find((e) => e.id === state.selectedEmailId);
            if (email) {
              const currentLabels = email.labelIds || [];
              const isStarred = currentLabels.includes("STARRED");
              const previousLabels: Record<string, string[]> = {
                [email.id]: [...currentLabels],
              };
              const newLabels = isStarred
                ? currentLabels.filter((l) => l !== "STARRED")
                : [...currentLabels, "STARRED"];
              state.updateEmail(email.id, { labelIds: newLabels });
              state.addUndoAction({
                id: `${isStarred ? "unstar" : "star"}-${email.threadId}-${Date.now()}`,
                type: isStarred ? "unstar" : "star",
                threadCount: 1,
                accountId: state.currentAccountId,
                emails: [email],
                scheduledAt: Date.now(),
                delayMs: 5000,
                previousLabels,
              });
            }
          }
        },
      },

      // --- View ---
      {
        id: "toggle-view",
        label: viewMode === "split" ? "Switch to full view" : "Switch to split view",
        category: "View",
        icon: Layout,
        execute: () => {
          setViewMode(viewMode === "split" ? "full" : "split");
        },
      },
      {
        id: "refresh-inbox",
        label: "Refresh inbox",
        category: "View",
        icon: RefreshCw,
        execute: () => {
          const state = useAppStore.getState();
          if (state.currentAccountId) {
            window.api.sync.now(state.currentAccountId);
          }
        },
      },

      // --- Settings ---
      {
        id: "open-settings",
        label: "Open settings",
        category: "Settings",
        shortcut: "\u2318,",
        icon: Settings,
        execute: () => setShowSettings(true),
      },
      {
        id: "show-shortcuts",
        label: "Show keyboard shortcuts",
        category: "Settings",
        shortcut: "?",
        icon: Keyboard,
        execute: () => {
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
        },
      },

      // --- Theme ---
      {
        id: "theme-light",
        label: "Switch to light theme",
        category: "Appearance",
        icon: Sun,
        available: () => themePreference !== "light",
        execute: () => {
          setThemePreference("light");
          window.api.theme.set("light");
        },
      },
      {
        id: "theme-dark",
        label: "Switch to dark theme",
        category: "Appearance",
        icon: Moon,
        available: () => themePreference !== "dark",
        execute: () => {
          setThemePreference("dark");
          window.api.theme.set("dark");
        },
      },
      {
        id: "theme-system",
        label: "Use system theme",
        category: "Appearance",
        icon: Monitor,
        available: () => themePreference !== "system",
        execute: () => {
          setThemePreference("system");
          window.api.theme.set("system");
        },
      },

      // --- Density ---
      {
        id: "density-default",
        label: "Default density",
        category: "Appearance",
        available: () => inboxDensity !== "default",
        execute: () => {
          setInboxDensity("default");
          window.api.settings.set({ inboxDensity: "default" });
        },
      },
      {
        id: "density-compact",
        label: "Compact density",
        category: "Appearance",
        available: () => inboxDensity !== "compact",
        execute: () => {
          setInboxDensity("compact");
          window.api.settings.set({ inboxDensity: "compact" });
        },
      },

      // --- Instant Intro ---
      {
        id: "instant-intro",
        label: "Instant Intro (move introducer to Bcc)",
        category: "Compose",
        icon: Forward,
        available: () => hasSelectedEmail,
        execute: () => {
          if (!selectedEmailId) return;
          const state = useAppStore.getState();
          const email = state.emails.find((e) => e.id === selectedEmailId);
          if (!email) return;

          const currentAccount = state.accounts.find((a) => a.id === state.currentAccountId);
          const userEmail = currentAccount?.email?.toLowerCase() ?? "";

          const escapeHtml = (s: string): string =>
            s
              .replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;");

          const parseEmail = (addr: string): string => {
            const match = addr.match(/<([^>]+)>/);
            return match ? match[1] : addr.trim();
          };

          const parseName = (addr: string): string => {
            const match = addr.match(/^([^<]+?)\s*</);
            return match ? match[1].trim().replace(/"/g, "") : "";
          };

          const introducerEmail = parseEmail(email.from);
          const introducerName = parseName(email.from) || introducerEmail.split("@")[0];
          const introducerFirst = extractFirstName(introducerName);

          const allRecipients = [
            ...splitAddressList(email.to ?? ""),
            ...splitAddressList(email.cc ?? ""),
          ];
          const introducedEmails = allRecipients.map(parseEmail).filter((e) => {
            const lower = e.toLowerCase();
            return lower !== userEmail && lower !== introducerEmail.toLowerCase();
          });
          const seen = new Set<string>();
          const uniqueIntroduced = introducedEmails.filter((e) => {
            const lower = e.toLowerCase();
            if (seen.has(lower)) return false;
            seen.add(lower);
            return true;
          });

          const introducedNames = uniqueIntroduced.map((addr) => {
            const original = allRecipients.find(
              (r) => parseEmail(r).toLowerCase() === addr.toLowerCase(),
            );
            const name = original ? parseName(original) : "";
            return name || addr.split("@")[0];
          });
          const introducedFirstNames = introducedNames.map(extractFirstName);
          const greeting =
            introducedFirstNames.length > 2
              ? `Hi ${introducedFirstNames.slice(0, -1).join(", ")} and ${introducedFirstNames[introducedFirstNames.length - 1]}`
              : introducedFirstNames.length === 2
                ? `Hi ${introducedFirstNames.join(" and ")}`
                : introducedFirstNames.length === 1
                  ? `Hi ${introducedFirstNames[0]}`
                  : "Hi";

          const bodyText = `${greeting},\n\nThanks for the intro, ${introducerFirst}! (Moving you to Bcc.)\n\n`;
          const bodyHtml = `<div>${escapeHtml(greeting)},<br><br>Thanks for the intro, ${escapeHtml(introducerFirst)}! (Moving you to Bcc.)<br><br></div>`;

          setViewMode("full");
          openCompose("reply-all", selectedEmailId, {
            bodyHtml,
            bodyText,
            to: uniqueIntroduced,
            cc: [],
            bcc: [introducerEmail],
          });
        },
      },

      // --- Agents ---
      {
        id: "open-agents-sidebar",
        label: "Open Agents Sidebar",
        category: "Agents",
        icon: Settings,
        execute: () => useAppStore.getState().toggleAgentsSidebar(),
      },
      {
        id: "run-with-agents",
        label: "Run with Selected Agents",
        category: "Agents",
        shortcut: "\u2318J",
        execute: () => useAppStore.getState().setAgentPaletteOpen(true),
      },

      // --- Account switching ---
      ...accounts.map((account) => ({
        id: `switch-account-${account.id}`,
        label: `Switch to ${account.email}`,
        category: "Accounts",
        icon: User,
        available: () => account.id !== currentAccountId,
        execute: () => {
          setCurrentAccountId(account.id);
          window.api.sync.getEmails(account.id).then((result: IpcResponse<DashboardEmail[]>) => {
            if (result.success && result.data) {
              const otherEmails = useAppStore
                .getState()
                .emails.filter((e) => e.accountId !== account.id);
              useAppStore.getState().setEmails([...otherEmails, ...result.data]);
            }
          });
          window.api.sync.now(account.id).catch(console.error);
        },
      })),
    ];

    return allActions.filter((a) => a.available === undefined || a.available());
  }, [
    accounts,
    currentAccountId,
    selectedEmailId,
    selectedThreadId,
    viewMode,
    themePreference,
    inboxDensity,
    emails,
    threads,
    openSearch,
    openCompose,
    setShowSettings,
    setViewMode,
    setThemePreference,
    setInboxDensity,
    setCurrentAccountId,
    setSelectedEmailId,
    setSelectedThreadId,
    setShowSnoozeMenu,
  ]);

  // Group actions by category in a fixed order
  const groupedActions = useMemo(() => {
    const groups: { category: string; actions: CommandAction[] }[] = [];
    const categoryOrder = [
      "Navigation",
      "Compose",
      "Email Actions",
      "View",
      "Agents",
      "Settings",
      "Appearance",
      "Accounts",
    ];

    for (const cat of categoryOrder) {
      const catActions = actions.filter((a) => a.category === cat);
      if (catActions.length > 0) {
        groups.push({ category: cat, actions: catActions });
      }
    }
    return groups;
  }, [actions]);

  // Reset query when palette opens
  useEffect(() => {
    if (isOpen) setQuery("");
  }, [isOpen]);

  const executeAction = useCallback(
    (action: CommandAction) => {
      onClose();
      requestAnimationFrame(() => action.execute());
    },
    [onClose],
  );

  return (
    <MotionConfig transition={{ type: "spring", stiffness: 450, damping: 25, mass: 0.1 }}>
      <div className="relative z-50">
        {/* Expanded palette */}
        <AnimatePresence>
          {isOpen ? (
            <motion.div
              layoutId="cmd-wrapper"
              className="fixed inset-0 z-50 flex items-start justify-center pt-20"
            >
              {/* Backdrop */}
              <AnimatePresence>
                {isOpen && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="absolute inset-0 bg-black/40 dark:bg-black/60"
                    onClick={onClose}
                  />
                )}
              </AnimatePresence>

              {/* Panel */}
              <div className="relative w-full max-w-xl rounded-xl">
                <Command
                  value={query}
                  onValueChange={setQuery}
                  className="rounded-xl shadow-2xl dark:shadow-black/40"
                  filter={(value, search) => {
                    const lower = value.toLowerCase();
                    const q = search.toLowerCase();
                    if (lower.includes(q)) return 1;
                    return q.split(/\s+/).every((w) => lower.includes(w)) ? 1 : 0;
                  }}
                >
                  {/* Border overlay */}
                  <motion.div
                    style={{ borderRadius: 12 }}
                    className="absolute -inset-px origin-top-left border border-gray-200 dark:border-gray-700 pointer-events-none"
                  />

                  {/* Search input row */}
                  <label className="relative flex w-full items-center border-b border-gray-200 dark:border-gray-700">
                    <span className="flex w-12 h-12 items-center justify-center">
                      <motion.span layoutId="cmd-icon">
                        <Search className="w-4 h-4 text-gray-500 dark:text-gray-400" />
                      </motion.span>
                    </span>

                    <motion.span
                      layoutId="cmd-center"
                      className="flex h-full flex-1 items-center text-left [&_[data-slot=command-input-wrapper]]:border-none [&_[data-slot=command-input-wrapper]]:px-0 [&_[data-slot=command-input-wrapper]_svg]:hidden"
                    >
                      <CommandInput autoFocus placeholder="Find..." />
                    </motion.span>

                    <motion.span
                      layoutId="cmd-kbd"
                      className="flex w-12 h-12 items-center justify-center pr-1"
                    >
                      <kbd className="flex items-center justify-center rounded-sm border border-gray-300 dark:border-gray-600 px-1 py-0.5 text-xs text-gray-500 dark:text-gray-400 tracking-tighter">
                        Esc
                      </kbd>
                    </motion.span>
                  </label>

                  {/* Command list */}
                  <motion.div
                    initial={{ opacity: 0, y: -50 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -50 }}
                    className="relative overflow-x-hidden overflow-y-hidden"
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        onClose();
                      }
                    }}
                  >
                    <CommandList>
                      <CommandEmpty>No results found.</CommandEmpty>
                      {groupedActions.map(({ category, actions: catActions }, groupIndex) => (
                        <React.Fragment key={category}>
                          {groupIndex > 0 && <CommandSeparator />}
                          <CommandGroup heading={category}>
                            {catActions.map((action) => (
                              <CommandItem
                                key={action.id}
                                value={`${action.label} ${action.category}`}
                                onSelect={() => executeAction(action)}
                              >
                                {action.icon ? (
                                  <action.icon className="w-4 h-4 text-gray-400 dark:text-gray-500 flex-shrink-0" />
                                ) : (
                                  <div className="w-4 h-4" />
                                )}
                                <span className="flex-1">{action.label}</span>
                                {action.shortcut && (
                                  <CommandShortcut>{action.shortcut}</CommandShortcut>
                                )}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </React.Fragment>
                      ))}
                    </CommandList>
                  </motion.div>
                </Command>
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}

/**
 * Compact search bar trigger that sits in the titlebar.
 * Morphs into the full command palette via shared layoutIds.
 */
export function CommandBarTrigger({ onClick }: { onClick: () => void }) {
  return (
    <MotionConfig transition={{ type: "spring", stiffness: 450, damping: 25, mass: 0.1 }}>
      <motion.button
        layoutId="cmd-wrapper"
        onClick={onClick}
        className="titlebar-no-drag group relative flex h-8 w-48 items-center"
      >
        <motion.div
          className="absolute inset-0 origin-top-left border border-gray-300 dark:border-gray-600 group-hover:border-gray-400 dark:group-hover:border-gray-500 transition-colors"
          style={{ borderRadius: 6 }}
        />
        <div className="flex flex-1 items-center">
          {/* Search icon */}
          <span className="flex w-8 h-8 items-center justify-center">
            <motion.span layoutId="cmd-icon">
              <Search className="w-4 h-4 text-gray-500 dark:text-gray-400 opacity-50" />
            </motion.span>
          </span>

          {/* Placeholder text */}
          <span className="relative flex flex-1 items-center opacity-40">
            <motion.span
              layoutId="cmd-center"
              className="absolute grid h-8 w-full flex-1 cursor-text items-center text-left text-sm text-gray-600 dark:text-gray-300"
            >
              Find...
            </motion.span>
          </span>

          {/* Keyboard shortcut badge */}
          <motion.span
            layoutId="cmd-kbd"
            transition={{ duration: 0.1 }}
            className="flex w-8 h-8 items-center justify-center"
          >
            <kbd className="flex items-center justify-center rounded-sm border border-gray-300 dark:border-gray-600 w-5 h-5 text-xs text-gray-500 dark:text-gray-400">
              /
            </kbd>
          </motion.span>
        </div>
      </motion.button>
    </MotionConfig>
  );
}

export default CommandPalette;
