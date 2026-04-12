import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import DOMPurify from "dompurify";
import {
  DEFAULT_ANALYSIS_PROMPT,
  DEFAULT_DRAFT_PROMPT,
  DEFAULT_ARCHIVE_READY_PROMPT,
  DEFAULT_STYLE_PROMPT,
  DEFAULT_AGENT_DRAFTER_PROMPT,
  DEFAULT_MODEL_CONFIG,
  MODEL_TIERS,
  MODEL_TIER_LABELS,
  type EAConfig,
  type Config,
  type InboxDensity,
  type Signature,
  type McpServerConfig,
  type ModelConfig,
  type ModelTier,
  type CliToolConfig,
  type AiProvider,
} from "../../shared/types";
import { useAppStore, type Account, type SettingsTab } from "../store";
import { reconfigurePostHog, trackEvent } from "../services/posthog";
import { SplitConfigEditor } from "./SplitConfigEditor";
import { SnippetsEditor } from "./SnippetsEditor";
import { MemoriesTab } from "./MemoriesTab";
import { ExtensionsTab } from "./ExtensionsTab";

interface SettingsPanelProps {
  onClose: () => void;
  initialTab?: SettingsTab;
}

export function SettingsPanel({ onClose, initialTab }: SettingsPanelProps) {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab ?? "general");

  // Account management state
  const {
    accounts,
    setAccounts,
    removeAccount: removeAccountFromStore,
    prefetchProgress,
    themePreference,
    setThemePreference,
    setResolvedTheme,
    inboxDensity,
    setInboxDensity,
    keyboardBindings,
    setKeyboardBindings,
    undoSendDelaySeconds,
    setUndoSendDelay,
    currentAccountId,
    highlightMemoryIds,
  } = useAppStore();
  const [isAddingAccount, setIsAddingAccount] = useState(false);
  const [addAccountPhase, setAddAccountPhase] = useState("Connecting...");
  const [accountError, setAccountError] = useState<string | null>(null);
  const [analysisPrompt, setAnalysisPrompt] = useState("");
  const [draftPrompt, setDraftPrompt] = useState("");
  const [archiveReadyPrompt, setArchiveReadyPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);
  const [stylePrompt, setStylePrompt] = useState("");
  const [agentDrafterPrompt, setAgentDrafterPrompt] = useState("");
  const [isRerunningAll, setIsRerunningAll] = useState(false);
  const [rerunResult, setRerunResult] = useState<string | null>(null);

  // Calendar visibility state
  const [calendars, setCalendars] = useState<
    Array<{
      accountId: string;
      calendarId: string;
      calendarName: string | null;
      calendarColor: string | null;
      visible: boolean;
    }>
  >([]);
  const [accountEmails, setAccountEmails] = useState<Record<string, string>>({});
  const [calendarLoading, setCalendarLoading] = useState(false);

  // General settings state
  const [enableSenderLookup, setEnableSenderLookup] = useState(true);
  const [modelConfig, setModelConfig] = useState<ModelConfig>(DEFAULT_MODEL_CONFIG);
  const [isSavingGeneral, setIsSavingGeneral] = useState(false);
  const [isExportingLogs, setIsExportingLogs] = useState(false);
  const [exportLogsError, setExportLogsError] = useState<string | null>(null);
  const [isDefaultMailApp, setIsDefaultMailApp] = useState(false);
  const [isDefaultMailAppLoading, setIsDefaultMailAppLoading] = useState(false);
  const [defaultMailAppError, setDefaultMailAppError] = useState("");

  // Updates state
  const [appVersion, setAppVersion] = useState("");
  const [updateStatus, setUpdateStatus] = useState<
    | { state: "idle" }
    | { state: "checking" }
    | { state: "available"; version: string }
    | { state: "downloading"; progress: number }
    | { state: "downloaded"; version: string }
    | { state: "error"; message: string }
    | null
  >(null);
  const [githubToken, setGithubToken] = useState("");
  const [allowPrereleaseUpdates, setAllowPrereleaseUpdates] = useState(false);

  // EA settings state
  const [eaEnabled, setEaEnabled] = useState(false);
  const [eaName, setEaName] = useState("");
  const [eaEmail, setEaEmail] = useState("");
  const [isSavingEA, setIsSavingEA] = useState(false);
  const [eaSaved, setEaSaved] = useState(false);
  const [eaError, setEaError] = useState<string | null>(null);

  // Agent authentication state
  const [aiProvider, setAiProvider] = useState<AiProvider>("codex");
  const [codexModel, setCodexModel] = useState("gpt-5.4");
  const [enableAnthropicFallback, setEnableAnthropicFallback] = useState(true);
  const [codexCliAvailable, setCodexCliAvailable] = useState(false);
  const [codexAuthStatus, setCodexAuthStatus] = useState<
    "checking" | "authenticated" | "not_authenticated"
  >("checking");
  const [codexStatusText, setCodexStatusText] = useState<string | undefined>();
  const [isTestingCodex, setIsTestingCodex] = useState(false);
  const [codexTestError, setCodexTestError] = useState<string | null>(null);
  const [isSavingAiConfig, setIsSavingAiConfig] = useState(false);
  const [aiConfigSaved, setAiConfigSaved] = useState(false);
  const [anthropicApiKey, setAnthropicApiKey] = useState("");
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [apiKeySaved, setApiKeySaved] = useState(false);
  const [claudeCliAvailable, setClaudeCliAvailable] = useState(false);
  const [claudeAuthStatus, setClaudeAuthStatus] = useState<
    "checking" | "authenticated" | "not_authenticated"
  >("checking");
  const [claudeAuthEmail, setClaudeAuthEmail] = useState<string | undefined>();
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);

  // Agent browser settings state
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [chromeDebugPort, setChromeDebugPort] = useState(9222);
  const [chromeProfilePath, setChromeProfilePath] = useState("");
  const [isSavingBrowser, setIsSavingBrowser] = useState(false);

  // PostHog analytics state — initialized once from config, not clobbered by react-query refetch
  const [posthogEnabled, setPosthogEnabled] = useState(false);
  const [isSavingAnalytics, setIsSavingAnalytics] = useState(false);
  const [analyticsSaveResult, setAnalyticsSaveResult] = useState<string | null>(null);
  const analyticsInitialized = useRef(false);

  // Custom MCP servers state
  const [mcpServers, setMcpServers] = useState<Record<string, McpServerConfig>>({});
  const [mcpJsonText, setMcpJsonText] = useState("");
  const [isMcpEditing, setIsMcpEditing] = useState(false);
  const [isSavingMcp, setIsSavingMcp] = useState(false);
  const [mcpFormError, setMcpFormError] = useState<string | null>(null);

  // CLI tools state — each item gets a stable _key for React reconciliation
  const cliToolKeyRef = useRef(0);
  const nextCliToolKey = () => ++cliToolKeyRef.current;
  const [cliTools, setCliTools] = useState<(CliToolConfig & { _key: number })[]>([]);
  const [isSavingCliTools, setIsSavingCliTools] = useState(false);
  const [cliToolsSaved, setCliToolsSaved] = useState(false);
  const [extraPathDirs, setExtraPathDirs] = useState<string[]>([]);
  const [isSavingPathDirs, setIsSavingPathDirs] = useState(false);
  const [pathDirsSaved, setPathDirsSaved] = useState(false);

  // Signature management state
  const [signatures, setSignatures] = useState<Signature[]>([]);
  const [editingSignature, setEditingSignature] = useState<Signature | null>(null);
  const [isSavingSignatures, setIsSavingSignatures] = useState(false);
  const [showExoBranding, setShowExoBranding] = useState(true);

  // Fetch current prompts
  const { data: prompts, isLoading } = useQuery({
    queryKey: ["prompts"],
    queryFn: async () => {
      const result = await window.api.settings.getPrompts();
      if (result.success) {
        return result.data;
      }
      throw new Error(result.error);
    },
  });

  // Fetch EA config
  const { data: eaConfig } = useQuery({
    queryKey: ["ea-config"],
    queryFn: async () => {
      const result = await window.api.settings.getEA();
      if (result.success) {
        return result.data as EAConfig;
      }
      throw new Error(result.error);
    },
  });

  // Fetch general config
  const { data: generalConfig } = useQuery({
    queryKey: ["general-config"],
    queryFn: async () => {
      const result = await window.api.settings.get();
      if (result.success) {
        return result.data as Config;
      }
      throw new Error(result.error);
    },
  });

  useEffect(() => {
    if (prompts) {
      setAnalysisPrompt(prompts.analysisPrompt);
      setDraftPrompt(prompts.draftPrompt);
      setArchiveReadyPrompt(prompts.archiveReadyPrompt || DEFAULT_ARCHIVE_READY_PROMPT);
      setStylePrompt(prompts.stylePrompt || DEFAULT_STYLE_PROMPT);
      setAgentDrafterPrompt(prompts.agentDrafterPrompt || DEFAULT_AGENT_DRAFTER_PROMPT);
    }
  }, [prompts]);

  useEffect(() => {
    if (eaConfig) {
      setEaEnabled(eaConfig.enabled);
      setEaName(eaConfig.name || "");
      setEaEmail(eaConfig.email || "");
    }
  }, [eaConfig]);

  // Check default mail app status on mount
  useEffect(() => {
    window.api.defaultMailApp
      .isDefault()
      .then((result: boolean) => {
        setIsDefaultMailApp(result);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (generalConfig) {
      setEnableSenderLookup(generalConfig.enableSenderLookup ?? true);
      setModelConfig({ ...DEFAULT_MODEL_CONFIG, ...generalConfig.modelConfig });
      setGithubToken(generalConfig.githubToken ?? "");
      setAllowPrereleaseUpdates(generalConfig.allowPrereleaseUpdates ?? false);
      setAiProvider(generalConfig.aiProvider ?? "codex");
      setCodexModel(generalConfig.codex?.model ?? "gpt-5.4");
      setEnableAnthropicFallback(generalConfig.enableAnthropicFallback ?? true);
      setAnthropicApiKey(generalConfig.anthropicApiKey ?? "");
      const browser = generalConfig.agentBrowser;
      if (browser) {
        setBrowserEnabled(browser.enabled);
        setChromeDebugPort(browser.chromeDebugPort);
        setChromeProfilePath(browser.chromeProfilePath ?? "");
      }
      setMcpServers(generalConfig.mcpServers ?? {});
      setCliTools((generalConfig.cliTools ?? []).map((t) => ({ ...t, _key: nextCliToolKey() })));
      setExtraPathDirs(generalConfig.extraPathDirs ?? []);
      // PostHog analytics config — only set once to avoid clobbering unsaved edits on refetch
      if (!analyticsInitialized.current) {
        analyticsInitialized.current = true;
        const ph = generalConfig.posthog;
        if (ph) {
          setPosthogEnabled(ph.enabled);
        }
      }
    }
  }, [generalConfig]);

  useEffect(() => {
    if (generalConfig) {
      setSignatures(generalConfig.signatures ?? []);
      setShowExoBranding(generalConfig.showExoBranding !== false);
    }
  }, [generalConfig]);

  // Fetch app version and subscribe to update status on mount
  useEffect(() => {
    window.api.updates.getVersion().then((result: { success: boolean; data?: string }) => {
      if (result.success && result.data) {
        setAppVersion(result.data);
      }
    });

    window.api.updates
      .getStatus()
      .then(
        (result: {
          success: boolean;
          data?: { state: string; version?: string; progress?: number; message?: string };
        }) => {
          if (result.success && result.data && result.data.state !== "idle") {
            setUpdateStatus(result.data as NonNullable<typeof updateStatus>);
          }
        },
      );

    const cleanup = window.api.updates.onStatusChanged(
      (newStatus: NonNullable<typeof updateStatus>) => {
        setUpdateStatus(newStatus);
      },
    );

    return cleanup;
  }, []);

  // Check Codex + Claude auth state when Agents tab is shown
  useEffect(() => {
    if (activeTab !== "agents") return;

    setCodexAuthStatus("checking");
    (
      window.api.settings.codexAuthStatus() as Promise<{
        success: boolean;
        data?: { cliAvailable: boolean; authenticated: boolean; statusText?: string };
      }>
    )
      .then((result) => {
        if (result.success && result.data) {
          setCodexCliAvailable(result.data.cliAvailable);
          setCodexAuthStatus(result.data.authenticated ? "authenticated" : "not_authenticated");
          setCodexStatusText(result.data.statusText);
        } else {
          setCodexCliAvailable(false);
          setCodexAuthStatus("not_authenticated");
          setCodexStatusText(undefined);
        }
      })
      .catch(() => {
        setCodexCliAvailable(false);
        setCodexAuthStatus("not_authenticated");
        setCodexStatusText(undefined);
      });

    setClaudeAuthStatus("checking");
    (
      window.api.agent.claudeAuthStatus() as Promise<{
        success: boolean;
        data?: { cliAvailable: boolean; authenticated: boolean; email?: string };
      }>
    )
      .then((result) => {
        if (result.success && result.data) {
          setClaudeCliAvailable(result.data.cliAvailable);
          setClaudeAuthStatus(result.data.authenticated ? "authenticated" : "not_authenticated");
          setClaudeAuthEmail(result.data.email);
        } else {
          setClaudeCliAvailable(false);
          setClaudeAuthStatus("not_authenticated");
        }
      })
      .catch(() => {
        setClaudeCliAvailable(false);
        setClaudeAuthStatus("not_authenticated");
      });
  }, [activeTab]);

  // Fetch calendar list when Calendar tab is shown
  useEffect(() => {
    if (activeTab !== "calendar") return;
    setCalendarLoading(true);
    (
      window.api.calendar.getCalendars() as Promise<{
        success: boolean;
        calendars?: Array<{
          accountId: string;
          calendarId: string;
          calendarName: string | null;
          calendarColor: string | null;
          visible: boolean;
        }>;
        accountEmails?: Record<string, string>;
      }>
    )
      .then((result) => {
        if (result.success && result.calendars) {
          setCalendars(result.calendars);
          setAccountEmails(result.accountEmails ?? {});
        }
      })
      .finally(() => setCalendarLoading(false));
  }, [activeTab]);

  const handleCalendarVisibility = async (
    accountId: string,
    calendarId: string,
    visible: boolean,
  ) => {
    // Optimistic update
    setCalendars((prev) =>
      prev.map((c) =>
        c.accountId === accountId && c.calendarId === calendarId ? { ...c, visible } : c,
      ),
    );
    await window.api.calendar.setVisibility(accountId, calendarId, visible);
  };

  const handleThemeChange = async (theme: "light" | "dark" | "system") => {
    const result = await window.api.theme.set(theme);
    if (result.success) {
      setThemePreference(theme);
      setResolvedTheme(result.data.resolved);
    }
  };

  const handleDensityChange = async (density: InboxDensity) => {
    setInboxDensity(density);
    await window.api.settings.set({ inboxDensity: density });
  };

  const handleUndoSendDelayChange = async (seconds: number) => {
    setUndoSendDelay(seconds);
    await window.api.settings.set({ undoSendDelay: seconds });
  };

  const handleKeyboardBindingsChange = async (bindings: "superhuman" | "gmail") => {
    setKeyboardBindings(bindings);
    await window.api.settings.set({ keyboardBindings: bindings });
  };

  const handleSaveGeneral = async () => {
    setIsSavingGeneral(true);
    try {
      await window.api.settings.set({
        enableSenderLookup,
        modelConfig,
        aiProvider,
        codex: {
          model: codexModel || undefined,
        },
        enableAnthropicFallback,
        githubToken: githubToken || undefined,
        allowPrereleaseUpdates,
      });
      queryClient.invalidateQueries({ queryKey: ["general-config"] });
    } finally {
      setIsSavingGeneral(false);
    }
  };

  const handleCheckForUpdates = async () => {
    setUpdateStatus({ state: "checking" });
    try {
      const result = (await window.api.updates.check()) as { success: boolean; error?: string };
      if (!result.success) {
        setUpdateStatus({ state: "error", message: result.error || "Check failed" });
      }
      // On success, the persistent onStatusChanged listener handles the rest
    } catch {
      setUpdateStatus({ state: "error", message: "Failed to check for updates" });
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveResult(null);
    try {
      const result = (await window.api.settings.setPrompts({
        analysisPrompt: analysisPrompt || undefined,
        draftPrompt: draftPrompt || undefined,
        archiveReadyPrompt: archiveReadyPrompt || undefined,
        agentDrafterPrompt: agentDrafterPrompt || undefined,
      })) as {
        success: boolean;
        data?: {
          analysisChanged: boolean;
          draftChanged: boolean;
          archiveReadyChanged: boolean;
          agentDrafterChanged: boolean;
        };
      };
      queryClient.invalidateQueries({ queryKey: ["prompts"] });

      if (result.success && result.data) {
        const { analysisChanged, draftChanged, archiveReadyChanged, agentDrafterChanged } =
          result.data;
        if (analysisChanged || draftChanged || archiveReadyChanged || agentDrafterChanged) {
          const parts: string[] = [];
          if (analysisChanged) parts.push("analysis");
          if (draftChanged || agentDrafterChanged) parts.push("drafts");
          if (archiveReadyChanged) parts.push("archive-ready");
          setSaveResult(`Saved. Re-processing ${parts.join(", ")}...`);
        } else {
          setSaveResult("Saved.");
        }
      } else if (!result.success) {
        setSaveResult("Error saving prompts.");
      }
    } catch {
      setSaveResult("Error saving prompts.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetAnalysis = () => {
    setAnalysisPrompt(DEFAULT_ANALYSIS_PROMPT);
  };

  const handleResetDraft = () => {
    setDraftPrompt(DEFAULT_DRAFT_PROMPT);
  };

  const handleResetArchiveReady = () => {
    setArchiveReadyPrompt(DEFAULT_ARCHIVE_READY_PROMPT);
  };

  const handleResetAgentDrafter = () => {
    setAgentDrafterPrompt(DEFAULT_AGENT_DRAFTER_PROMPT);
  };

  const handleSaveStylePrompt = async () => {
    setIsSaving(true);
    try {
      await window.api.settings.setPrompts({
        stylePrompt: stylePrompt || undefined,
      });
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetStylePrompt = () => {
    setStylePrompt(DEFAULT_STYLE_PROMPT);
  };

  const handleSaveEA = async () => {
    setIsSavingEA(true);
    setEaSaved(false);
    setEaError(null);
    try {
      const result = (await window.api.settings.setEA({
        enabled: eaEnabled,
        name: eaName || undefined,
        email: eaEmail || undefined,
      })) as { success: boolean; error?: string };
      if (result.success) {
        queryClient.invalidateQueries({ queryKey: ["ea-config"] });
        setEaSaved(true);
        setTimeout(() => setEaSaved(false), 2000);
      } else {
        setEaError(result.error ?? "Failed to save EA settings.");
      }
    } catch {
      setEaError("Failed to save EA settings.");
    } finally {
      setIsSavingEA(false);
    }
  };

  const handleSaveSignatures = async (updated: Signature[]) => {
    setIsSavingSignatures(true);
    try {
      await window.api.settings.set({ signatures: updated });
      setSignatures(updated);
      queryClient.invalidateQueries({ queryKey: ["general-config"] });
    } finally {
      setIsSavingSignatures(false);
    }
  };

  const handleToggleExoBranding = async (enabled: boolean) => {
    try {
      await window.api.settings.set({ showExoBranding: enabled });
      setShowExoBranding(enabled);
      queryClient.invalidateQueries({ queryKey: ["general-config"] });
    } catch {
      // state stays at previous value; next config load will re-sync
    }
  };

  const handleAddSignature = () => {
    setEditingSignature({
      id: crypto.randomUUID(),
      name: "",
      bodyHtml: "",
      isDefault: false,
    });
  };

  const handleSaveSignature = async (sig: Signature) => {
    let updated: Signature[];
    const existing = signatures.find((s) => s.id === sig.id);
    if (existing) {
      updated = signatures.map((s) => (s.id === sig.id ? sig : s));
    } else {
      updated = [...signatures, sig];
    }
    // If this is set as default, clear default from other sigs for same scope
    if (sig.isDefault) {
      updated = updated.map((s) =>
        s.id !== sig.id && s.accountId === sig.accountId ? { ...s, isDefault: false } : s,
      );
    }
    await handleSaveSignatures(updated);
    setEditingSignature(null);
  };

  const handleDeleteSignature = async (id: string) => {
    const updated = signatures.filter((s) => s.id !== id);
    await handleSaveSignatures(updated);
    if (editingSignature?.id === id) {
      setEditingSignature(null);
    }
  };

  // Agent authentication handlers
  const handleSaveApiKey = async () => {
    setIsSavingApiKey(true);
    setApiKeySaved(false);
    try {
      await window.api.settings.set({ anthropicApiKey: anthropicApiKey || undefined });
      queryClient.invalidateQueries({ queryKey: ["general-config"] });
      setApiKeySaved(true);
      setTimeout(() => setApiKeySaved(false), 3000);
    } finally {
      setIsSavingApiKey(false);
    }
  };

  const handleTestCodexConnection = async () => {
    setIsTestingCodex(true);
    setCodexTestError(null);
    try {
      const result = (await window.api.settings.testCodexConnection()) as {
        success: boolean;
        error?: string;
      };
      if (!result.success) {
        setCodexTestError(result.error || "Codex connection test failed");
      }
    } finally {
      setIsTestingCodex(false);
    }
  };

  const handleSaveAiConfig = async () => {
    setIsSavingAiConfig(true);
    setAiConfigSaved(false);
    try {
      await window.api.settings.set({
        aiProvider,
        codex: { model: codexModel || undefined },
        enableAnthropicFallback,
      });
      queryClient.invalidateQueries({ queryKey: ["general-config"] });
      setAiConfigSaved(true);
      setTimeout(() => setAiConfigSaved(false), 3000);
    } finally {
      setIsSavingAiConfig(false);
    }
  };

  const handleClaudeLogin = async () => {
    setIsLoggingIn(true);
    setLoginError(null);
    try {
      const result = (await window.api.agent.claudeLogin()) as {
        success: boolean;
        data?: { success: boolean; error?: string };
        error?: string;
      };
      if (result.success && result.data?.success) {
        // Re-check status after login
        const statusResult = (await window.api.agent.claudeAuthStatus()) as {
          success: boolean;
          data?: { authenticated: boolean; email?: string };
        };
        if (statusResult.success && statusResult.data) {
          setClaudeAuthStatus(
            statusResult.data.authenticated ? "authenticated" : "not_authenticated",
          );
          setClaudeAuthEmail(statusResult.data.email);
        }
      } else {
        setLoginError(result.data?.error || result.error || "Login failed or was cancelled");
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setIsLoggingIn(false);
    }
  };

  // Account management handlers
  useEffect(() => {
    const unsubscribe = window.api.accounts.onAddProgress((data: { phase: string }) => {
      setAddAccountPhase(data.phase);
    });
    return unsubscribe;
  }, []);

  const handleAddAccount = async () => {
    // If already authorizing, cancel the current flow and restart
    if (isAddingAccount) {
      await window.api.accounts.cancelAdd();
      // The in-progress add() call will reject with "Authorization cancelled",
      // which resets isAddingAccount via the finally block. Wait briefly for that.
      return;
    }
    setIsAddingAccount(true);
    setAddAccountPhase("Connecting...");
    setAccountError(null);
    try {
      const result = await window.api.accounts.add();
      if (result.success && result.data) {
        const newAccount: Account = {
          id: result.data.accountId,
          email: result.data.email,
          isPrimary: accounts.length === 0,
          isConnected: result.data.isConnected,
        };
        setAccounts([...accounts, newAccount]);
        trackEvent("account_added", { account_count: accounts.length + 1 });
      } else if (!result.cancelled) {
        setAccountError(result.error || "Failed to add account");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add account";
      if (msg !== "Authorization cancelled") {
        setAccountError(msg);
      }
    } finally {
      setIsAddingAccount(false);
    }
  };

  const handleRemoveAccount = async (accountId: string) => {
    if (!confirm("Are you sure you want to remove this account?")) return;
    try {
      const result = await window.api.accounts.remove(accountId);
      if (result.success) {
        removeAccountFromStore(accountId);
        trackEvent("account_removed", { account_count: accounts.length - 1 });
      } else {
        setAccountError(result.error || "Failed to remove account");
      }
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Failed to remove account");
    }
  };

  const handleSetPrimary = async (accountId: string) => {
    try {
      const result = await window.api.accounts.setPrimary(accountId);
      if (result.success) {
        setAccounts(
          accounts.map((a) => ({
            ...a,
            isPrimary: a.id === accountId,
          })),
        );
      } else {
        setAccountError(result.error || "Failed to set primary account");
      }
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : "Failed to set primary account");
    }
  };

  return (
    <div data-testid="settings-panel" className="h-screen flex flex-col exo-app-bg exo-scanline">
      {/* Titlebar */}
      <div className="titlebar-drag h-12 exo-elevated border-b exo-border-subtle flex items-center justify-between px-4">
        <div className="flex items-center space-x-4">
          <div className="w-20" /> {/* Space for traffic lights */}
          <h1 className="text-lg font-semibold exo-text-primary">Settings</h1>
        </div>
        <button
          onClick={onClose}
          className="titlebar-no-drag p-2 text-[var(--exo-text-secondary)] hover:text-[var(--exo-text-primary)] hover:bg-[var(--exo-bg-surface-hover)] rounded-md transition-colors"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>

      {/* Tabs */}
      <div className="exo-elevated border-b exo-border-subtle">
        <div className="flex space-x-1 p-2">
          <button
            onClick={() => setActiveTab("general")}
            data-active={activeTab === "general" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            General
          </button>
          <button
            onClick={() => setActiveTab("accounts")}
            data-active={activeTab === "accounts" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Accounts
          </button>
          <button
            onClick={() => setActiveTab("calendar")}
            data-active={activeTab === "calendar" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Calendar
          </button>
          <button
            onClick={() => setActiveTab("splits")}
            data-active={activeTab === "splits" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Splits
          </button>
          <button
            onClick={() => setActiveTab("snippets")}
            data-active={activeTab === "snippets" ? "true" : undefined}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              activeTab === "snippets"
                ? "bg-[var(--exo-accent-soft)] text-[var(--exo-accent-strong)]"
                : "exo-text-secondary hover:bg-[var(--exo-bg-surface-hover)]"
            }`}
          >
            Snippets
          </button>
          <button
            onClick={() => setActiveTab("signatures")}
            data-active={activeTab === "signatures" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Signatures
          </button>
          <button
            onClick={() => setActiveTab("prompts")}
            data-active={activeTab === "prompts" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Prompts
          </button>
          <button
            onClick={() => setActiveTab("style")}
            data-active={activeTab === "style" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Writing Style
          </button>
          <button
            onClick={() => setActiveTab("assistant")}
            data-active={activeTab === "assistant" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Executive Assistant
          </button>
          <button
            onClick={() => setActiveTab("memories")}
            data-active={activeTab === "memories" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            AI Memories
          </button>
          <button
            onClick={() => setActiveTab("queue")}
            data-active={activeTab === "queue" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Queue
            {prefetchProgress.status === "running" && (
              <span className="ml-2 inline-flex items-center justify-center w-5 h-5 text-xs font-bold text-white bg-[var(--exo-accent)] rounded-full">
                {prefetchProgress.queueLength}
              </span>
            )}
          </button>
          <button
            onClick={() => setActiveTab("agents")}
            data-active={activeTab === "agents" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Agents
          </button>
          <button
            onClick={() => setActiveTab("extensions")}
            data-active={activeTab === "extensions" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Extensions
          </button>
          <button
            onClick={() => setActiveTab("analytics")}
            data-active={activeTab === "analytics" ? "true" : undefined}
            className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
          >
            Analytics
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6 exo-app-bg">
        {activeTab === "general" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold exo-text-primary mb-2">
                General Settings
              </h2>
              <p className="exo-text-secondary mb-4">
                Configure how Exo generates draft replies.
              </p>

              {/* Appearance / Theme Toggle */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="mb-3">
                  <h3 className="font-semibold exo-text-primary exo-micro-label">Appearance</h3>
                  <p className="text-sm exo-text-secondary mt-1">
                    Choose your preferred color theme.
                  </p>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleThemeChange("light")}
                    data-active={themePreference === "light" ? "true" : undefined}
                    className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                  >
                    Light
                  </button>
                  <button
                    onClick={() => handleThemeChange("dark")}
                    data-active={themePreference === "dark" ? "true" : undefined}
                    className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                  >
                    Dark
                  </button>
                  <button
                    onClick={() => handleThemeChange("system")}
                    data-active={themePreference === "system" ? "true" : undefined}
                    className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                  >
                    System
                  </button>
                </div>
              </div>

              {/* Inbox Density */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="mb-3">
                  <h3 className="font-semibold exo-text-primary exo-micro-label">Inbox Density</h3>
                  <p className="text-sm exo-text-secondary mt-1">
                    Control how much space each email takes in the inbox list.
                  </p>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleDensityChange("default")}
                    data-active={inboxDensity === "default" ? "true" : undefined}
                    className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                  >
                    Default
                  </button>
                  <button
                    onClick={() => handleDensityChange("compact")}
                    data-active={inboxDensity === "compact" ? "true" : undefined}
                    className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                  >
                    Compact
                  </button>
                </div>
              </div>

              {/* Keyboard Bindings */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="mb-3">
                  <h3 className="font-semibold exo-text-primary exo-micro-label">
                    Keyboard Shortcuts
                  </h3>
                  <p className="text-sm exo-text-secondary mt-1">
                    Choose which keyboard shortcut preset to use. Gmail adds extra bindings like o,
                    n/p, y, z, a, and section navigation.
                  </p>
                </div>
                <div className="flex space-x-2">
                  <button
                    onClick={() => handleKeyboardBindingsChange("superhuman")}
                    data-active={keyboardBindings === "superhuman" ? "true" : undefined}
                    className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                  >
                    Superhuman
                  </button>
                  <button
                    onClick={() => handleKeyboardBindingsChange("gmail")}
                    data-active={keyboardBindings === "gmail" ? "true" : undefined}
                    className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                  >
                    Gmail
                  </button>
                </div>
              </div>

              {/* Undo Send */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="mb-3">
                  <h3 className="font-semibold exo-text-primary exo-micro-label">Undo Send</h3>
                  <p className="text-sm exo-text-secondary mt-1">
                    Set a delay before emails are actually sent. During the delay you can click Undo
                    to cancel.
                  </p>
                </div>
                <div className="flex space-x-2">
                  {[
                    { label: "Off", value: 0 },
                    { label: "5s", value: 5 },
                    { label: "10s", value: 10 },
                    { label: "15s", value: 15 },
                    { label: "30s", value: 30 },
                  ].map(({ label, value }) => (
                    <button
                      key={value}
                      onClick={() => handleUndoSendDelayChange(value)}
                      data-active={undoSendDelaySeconds === value ? "true" : undefined}
                      className="px-4 py-2 text-sm font-medium transition-colors exo-segment-btn"
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Default Mail App */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-semibold exo-text-primary">
                      Default Mail App
                    </h3>
                    <p className="text-sm exo-text-secondary mt-1">
                      Register Exo as the default handler for mailto: links. Clicking email links in
                      other apps will open a compose window here.
                    </p>
                  </div>
                  <button
                    disabled={isDefaultMailAppLoading}
                    onClick={async () => {
                      if (isDefaultMailAppLoading) return;
                      setIsDefaultMailAppLoading(true);
                      setDefaultMailAppError("");
                      const desired = !isDefaultMailApp;
                      try {
                        await window.api.defaultMailApp.setDefault(desired);
                        const actual = await window.api.defaultMailApp.isDefault();
                        setIsDefaultMailApp(actual);
                        if (actual !== desired) {
                          setDefaultMailAppError(
                            "Could not register as default mail app. This requires the packaged app — it won't work in dev mode.",
                          );
                        }
                      } catch (e) {
                        console.error("Failed to update default mail app setting", e);
                        setDefaultMailAppError("Failed to update default mail app setting.");
                      } finally {
                        setIsDefaultMailAppLoading(false);
                      }
                    }}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      isDefaultMailAppLoading ? "opacity-50 cursor-not-allowed" : ""
                    } ${
                      isDefaultMailApp
                        ? "bg-[var(--exo-accent)]"
                        : "bg-[var(--exo-border-subtle)]"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--exo-bg-elevated)] transition-transform ${
                        isDefaultMailApp ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
                {defaultMailAppError && (
                  <p className="text-sm text-amber-600 dark:text-amber-400 mt-2">
                    {defaultMailAppError}
                  </p>
                )}
              </div>

              {/* AI Models */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="mb-3">
                  <h3 className="font-semibold exo-text-primary">AI Models</h3>
                  <p className="text-sm exo-text-secondary mt-1">
                    {aiProvider === "codex"
                      ? "These model tiers apply to Anthropic-powered features and fallback. Codex uses the model in Agent Settings -> Codex (OAuth)."
                      : "Choose which Claude model to use for each feature. Haiku is fastest and cheapest, Opus is most capable."}
                  </p>
                </div>
                <div className="space-y-3">
                  {[
                    {
                      key: "analysis" as const,
                      label: "Email Analysis",
                      description: "Triaging which emails need replies",
                    },
                    {
                      key: "drafts" as const,
                      label: "Draft Generation",
                      description: "Writing reply drafts",
                    },
                    {
                      key: "refinement" as const,
                      label: "Draft Refinement",
                      description: "Improving drafts based on feedback",
                    },
                    {
                      key: "calendaring" as const,
                      label: "Scheduling Detection",
                      description: "Identifying calendar-related emails",
                    },
                    {
                      key: "archiveReady" as const,
                      label: "Archive-Ready Analysis",
                      description: "Detecting completed conversations",
                    },
                    {
                      key: "senderLookup" as const,
                      label: "Sender Lookup",
                      description: "Web search for sender info",
                    },
                    {
                      key: "agentDrafter" as const,
                      label: "Agent Drafter",
                      description: "Background auto-draft generation",
                    },
                    {
                      key: "agentChat" as const,
                      label: "Agent Chat",
                      description: "Interactive agent sidebar conversations",
                    },
                  ].map(({ key, label, description }) => (
                    <div
                      key={key}
                      className="flex items-center justify-between py-2 border-b exo-border-subtle last:border-0"
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <p className="text-sm font-medium exo-text-primary">
                          {label}
                        </p>
                        <p className="text-xs exo-text-muted">{description}</p>
                      </div>
                      <select
                        value={modelConfig[key]}
                        onChange={(e) => {
                          const tier = e.target.value;
                          if ((MODEL_TIERS as readonly string[]).includes(tier)) {
                            setModelConfig((prev) => ({ ...prev, [key]: tier as ModelTier }));
                          }
                        }}
                        className="px-3 py-1.5 text-sm border border-[var(--exo-border-strong)] rounded-lg bg-[var(--exo-bg-elevated)] exo-text-primary focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                      >
                        {MODEL_TIERS.map((tier) => (
                          <option key={tier} value={tier}>
                            {MODEL_TIER_LABELS[tier]}
                          </option>
                        ))}
                      </select>
                    </div>
                  ))}
                </div>
              </div>

              {/* Updates */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="mb-3">
                  <h3 className="font-semibold exo-text-primary">Updates</h3>
                  {appVersion && (
                    <p className="text-sm exo-text-secondary mt-1">
                      Current version: {appVersion}
                    </p>
                  )}
                </div>

                <div className="space-y-3 mb-4">
                  <div className="flex items-center gap-3">
                    <button
                      onClick={handleCheckForUpdates}
                      disabled={
                        updateStatus?.state === "checking" || updateStatus?.state === "downloading"
                      }
                      className="px-4 py-2 text-sm font-medium rounded-lg transition-colors bg-[var(--exo-bg-surface-soft)] exo-text-secondary hover:bg-[var(--exo-bg-surface-hover)] border border-transparent disabled:opacity-50"
                    >
                      {updateStatus?.state === "checking" ? "Checking..." : "Check for Updates"}
                    </button>
                    {updateStatus?.state === "idle" && (
                      <span className="text-sm exo-text-secondary">
                        You're on the latest version.
                      </span>
                    )}
                    {updateStatus?.state === "error" && (
                      <span className="text-sm text-red-600 dark:text-red-400">
                        {updateStatus.message}
                      </span>
                    )}
                  </div>

                  {updateStatus?.state === "available" && (
                    <div className="flex items-center gap-3 bg-[var(--exo-accent-soft)] p-3 rounded-lg">
                      <span className="text-sm text-[var(--exo-accent-strong)]">
                        Version {updateStatus.version} is available
                      </span>
                      <button
                        onClick={() => window.api.updates.download()}
                        className="px-3 py-1 text-sm font-medium text-white bg-[var(--exo-accent)] hover:bg-[var(--exo-accent-strong)] rounded transition-colors"
                      >
                        Download
                      </button>
                    </div>
                  )}

                  {updateStatus?.state === "downloading" && (
                    <div className="flex items-center gap-3 bg-[var(--exo-accent-soft)] p-3 rounded-lg">
                      <svg
                        className="w-4 h-4 text-[var(--exo-accent)] animate-spin flex-shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
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
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                        />
                      </svg>
                      <span className="text-sm text-[var(--exo-accent-strong)]">
                        Downloading update...
                      </span>
                      <div className="flex-1 max-w-xs">
                        <div className="w-full bg-[var(--exo-accent-soft)] rounded-full h-1.5">
                          <div
                            className="bg-[var(--exo-accent)] h-1.5 rounded-full transition-all duration-300"
                            style={{ width: `${updateStatus.progress}%` }}
                          />
                        </div>
                      </div>
                      <span className="text-[var(--exo-accent)] text-sm tabular-nums">
                        {updateStatus.progress}%
                      </span>
                    </div>
                  )}

                  {updateStatus?.state === "downloaded" && (
                    <div className="flex items-center gap-3 bg-green-50 dark:bg-green-900/30 p-3 rounded-lg">
                      <svg
                        className="w-4 h-4 text-green-600 dark:text-green-400 flex-shrink-0"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                      <span className="text-sm text-green-800 dark:text-green-300">
                        Version {updateStatus.version} ready to install
                      </span>
                      <button
                        onClick={() => window.api.updates.install()}
                        className="px-3 py-1 text-sm font-medium text-white bg-green-600 dark:bg-green-500 hover:bg-green-700 dark:hover:bg-green-600 rounded transition-colors"
                      >
                        Restart Now
                      </button>
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-sm font-medium exo-text-secondary mb-1">
                    GitHub Token
                  </label>
                  <input
                    type="password"
                    value={githubToken}
                    onChange={(e) => setGithubToken(e.target.value)}
                    placeholder="ghp_..."
                    className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                  />
                  <p className="text-xs exo-text-muted mt-1">
                    Required for auto-updates from a private repo. Needs{" "}
                    <code className="bg-[var(--exo-bg-surface-soft)] px-1 rounded">repo</code> scope or
                    fine-grained{" "}
                    <code className="bg-[var(--exo-bg-surface-soft)] px-1 rounded">contents:read</code>{" "}
                    permission. Also used for private extension downloads.
                  </p>
                </div>

                <div className="flex items-center justify-between mt-4 pt-4 border-t exo-border-subtle">
                  <div>
                    <label className="text-sm font-medium exo-text-secondary">
                      Pre-release updates
                    </label>
                    <p className="text-xs exo-text-muted mt-0.5">
                      Receive beta and release candidate builds before official release.
                    </p>
                  </div>
                  <button
                    role="switch"
                    aria-checked={allowPrereleaseUpdates}
                    onClick={() => setAllowPrereleaseUpdates(!allowPrereleaseUpdates)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      allowPrereleaseUpdates
                        ? "bg-[var(--exo-accent)]"
                        : "bg-[var(--exo-border-subtle)]"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--exo-bg-elevated)] transition-transform ${
                        allowPrereleaseUpdates ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>
              </div>

              {/* Sender Lookup Toggle */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <h3 className="font-semibold exo-text-primary">
                      Sender Lookup
                    </h3>
                    <p className="text-sm exo-text-secondary mt-1">
                      When generating a draft, search the web for information about the sender to
                      provide better context.
                    </p>
                  </div>
                  <button
                    onClick={() => setEnableSenderLookup(!enableSenderLookup)}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                      enableSenderLookup
                        ? "bg-[var(--exo-accent)]"
                        : "bg-[var(--exo-border-subtle)]"
                    }`}
                  >
                    <span
                      className={`inline-block h-4 w-4 transform rounded-full bg-[var(--exo-bg-elevated)] transition-transform ${
                        enableSenderLookup ? "translate-x-6" : "translate-x-1"
                      }`}
                    />
                  </button>
                </div>

                {enableSenderLookup && (
                  <div className="bg-[var(--exo-accent-soft)] p-3 rounded-lg text-sm text-[var(--exo-accent-strong)]">
                    <p className="font-medium mb-1">How it works:</p>
                    <ul className="list-disc list-inside space-y-1">
                      <li>Uses Claude's web search to find information about the sender</li>
                      <li>Results are cached for the session to avoid repeated lookups</li>
                      <li>Includes professional background and context in the draft prompt</li>
                    </ul>
                  </div>
                )}
              </div>

              {/* Troubleshooting */}
              <div className="exo-elevated p-4 rounded-lg border exo-border-subtle">
                <h3 className="font-semibold exo-text-primary mb-1">
                  Troubleshooting
                </h3>
                <p className="text-sm exo-text-secondary mb-3">
                  Export log files to share with support. Email content is automatically redacted.
                </p>
                <button
                  onClick={async () => {
                    setIsExportingLogs(true);
                    setExportLogsError(null);
                    try {
                      const result = (await window.api.settings.exportLogs()) as {
                        success: boolean;
                        error?: string;
                      };
                      if (!result?.success && result?.error) {
                        setExportLogsError(result.error);
                      }
                    } finally {
                      setIsExportingLogs(false);
                    }
                  }}
                  disabled={isExportingLogs}
                  className="px-4 py-2 text-sm font-medium exo-text-secondary bg-[var(--exo-bg-surface-soft)] hover:bg-[var(--exo-bg-surface-hover)] rounded-lg transition-colors disabled:opacity-50"
                >
                  {isExportingLogs ? "Exporting..." : "Export Logs"}
                </button>
                {exportLogsError && (
                  <p className="text-sm text-red-600 dark:text-red-400 mt-2">{exportLogsError}</p>
                )}
              </div>

              {/* Save button */}
              <div className="flex justify-end">
                <button
                  onClick={handleSaveGeneral}
                  disabled={isSavingGeneral}
                  className="px-6 py-2 bg-[var(--exo-accent)] text-white text-sm font-medium rounded-lg hover:bg-[var(--exo-accent-strong)] transition-colors disabled:opacity-50"
                >
                  {isSavingGeneral ? "Saving..." : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "accounts" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold exo-text-primary mb-2">
                Connected Accounts
              </h2>
              <p className="exo-text-secondary mb-4">
                Manage your connected Gmail accounts. You can add multiple accounts and switch
                between them.
              </p>

              {accountError && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 px-4 py-3 rounded-lg mb-4">
                  {accountError}
                </div>
              )}

              {/* Account list */}
              <div className="exo-settings-card divide-y divide-[var(--exo-border-subtle)] mb-6">
                {accounts.length === 0 ? (
                  <div className="p-6 text-center exo-text-muted">
                    No accounts connected. Click "Add Account" to connect your first Gmail account.
                  </div>
                ) : (
                  accounts.map((account) => (
                    <div key={account.id} className="p-4 flex items-center justify-between">
                      <div className="flex items-center space-x-3">
                        <div
                          className={`w-3 h-3 rounded-full ${account.isConnected ? "bg-green-500" : "bg-[var(--exo-text-muted)]"}`}
                        />
                        <div>
                          <div className="font-medium exo-text-primary">
                            {account.email}
                          </div>
                          <div className="text-sm exo-text-muted">
                            {account.isPrimary && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--exo-accent-soft)] text-[var(--exo-accent-strong)] mr-2">
                                Primary
                              </span>
                            )}
                            {account.isConnected ? "Connected" : "Disconnected"}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        {!account.isPrimary && (
                          <button
                            onClick={() => handleSetPrimary(account.id)}
                            className="px-3 py-1.5 text-sm text-[var(--exo-accent)] hover:bg-[var(--exo-accent-soft)] rounded-lg transition-colors"
                          >
                            Set as Primary
                          </button>
                        )}
                        <button
                          onClick={() => handleRemoveAccount(account.id)}
                          className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                          title="Remove account"
                        >
                          <svg
                            className="w-5 h-5"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                          >
                            <path
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              strokeWidth={2}
                              d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                            />
                          </svg>
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>

              {/* Add account button */}
              <button
                onClick={handleAddAccount}
                className="w-full py-3 border-2 border-dashed exo-border-strong rounded-lg exo-text-secondary hover:border-[var(--exo-accent)] hover:text-[var(--exo-accent)] hover:bg-[var(--exo-accent-soft)] transition-colors"
              >
                {isAddingAccount ? (
                  <span className="flex items-center justify-center space-x-2">
                    <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
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
                    <span>{addAccountPhase} — Click to cancel</span>
                  </span>
                ) : (
                  "+ Add Gmail Account"
                )}
              </button>

              <p className="text-xs exo-text-muted mt-2">
                Adding an account will open a Google sign-in window. You'll need to authorize Exo to
                access your emails.
              </p>
            </div>
          </div>
        )}

        {activeTab === "calendar" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold exo-text-primary mb-2">
                Calendar Visibility
              </h2>
              <p className="exo-text-secondary mb-4">
                Choose which calendars to show in the sidebar. Only visible calendars will have
                their events displayed.
              </p>

              {calendarLoading ? (
                <p className="exo-text-muted">Loading calendars...</p>
              ) : calendars.length === 0 ? (
                <div className="exo-elevated p-6 rounded-lg border exo-border-subtle text-center exo-text-muted">
                  No calendars found. Calendar sync may not have completed yet.
                </div>
              ) : (
                (() => {
                  // Group calendars by account
                  const grouped = new Map<string, typeof calendars>();
                  for (const cal of calendars) {
                    const list = grouped.get(cal.accountId) ?? [];
                    list.push(cal);
                    grouped.set(cal.accountId, list);
                  }

                  return Array.from(grouped.entries()).map(([accountId, cals]) => (
                    <div key={accountId} className="mb-6">
                      <h3 className="text-sm font-semibold exo-text-secondary mb-3">
                        {accountEmails[accountId] ?? accountId}
                      </h3>
                      <div className="exo-settings-card divide-y divide-[var(--exo-border-subtle)]">
                        {cals.map((cal) => (
                          <div
                            key={cal.calendarId}
                            className="p-4 flex items-center justify-between"
                          >
                            <div className="flex items-center space-x-3">
                              <div
                                className="w-3 h-3 rounded-full flex-shrink-0"
                                style={{ backgroundColor: cal.calendarColor ?? "#4285f4" }}
                              />
                              <span className="exo-text-primary text-sm">
                                {cal.calendarName ?? cal.calendarId}
                              </span>
                            </div>
                            <button
                              onClick={() =>
                                handleCalendarVisibility(
                                  cal.accountId,
                                  cal.calendarId,
                                  !cal.visible,
                                )
                              }
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                                cal.visible
                                  ? "bg-[var(--exo-accent)]"
                                  : "bg-[var(--exo-border-subtle)]"
                              }`}
                            >
                              <span
                                className={`inline-block h-4 w-4 transform rounded-full bg-[var(--exo-bg-elevated)] transition-transform ${
                                  cal.visible ? "translate-x-6" : "translate-x-1"
                                }`}
                              />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ));
                })()
              )}
            </div>
          </div>
        )}

        {activeTab === "splits" && (
          <div className="max-w-3xl">
            <SplitConfigEditor />
          </div>
        )}

        {activeTab === "snippets" && (
          <div className="max-w-3xl">
            <SnippetsEditor />
          </div>
        )}

        {activeTab === "signatures" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold exo-text-primary mb-2">
                Email Signatures
              </h2>
              <p className="exo-text-secondary mb-4">
                Create and manage email signatures. The default signature is automatically appended
                when composing new emails.
              </p>

              {/* Exo branding toggle */}
              <div className="exo-settings-card p-4 mb-6">
                <label className="flex items-center space-x-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showExoBranding}
                    onChange={(e) => handleToggleExoBranding(e.target.checked)}
                    className="h-4 w-4 rounded exo-border-strong text-[var(--exo-accent)] focus:ring-[var(--exo-focus-ring)]"
                  />
                  <div>
                    <span className="text-sm font-medium exo-text-primary">
                      Show &quot;Sent by Exo&quot; branding
                    </span>
                    <p className="text-xs exo-text-muted">
                      Appends a small &quot;Sent by{" "}
                      <a href="https://exo.email" className="text-[var(--exo-accent)] hover:underline">
                        Exo
                      </a>
                      &quot; line after your signature.
                    </p>
                  </div>
                </label>
              </div>

              {/* Signature list */}
              {!editingSignature && (
                <>
                  <div className="exo-settings-card divide-y divide-[var(--exo-border-subtle)] mb-6">
                    {signatures.length === 0 ? (
                      <div className="p-6 text-center exo-text-muted">
                        No signatures yet. Click "Add Signature" to create one.
                      </div>
                    ) : (
                      signatures.map((sig) => (
                        <div key={sig.id} className="p-4 flex items-center justify-between">
                          <div className="flex items-center space-x-3 min-w-0">
                            <div className="min-w-0">
                              <div className="font-medium exo-text-primary truncate">
                                {sig.name || "Untitled"}
                              </div>
                              <div className="text-sm exo-text-muted flex items-center gap-2">
                                {sig.isDefault && (
                                  <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--exo-accent-soft)] text-[var(--exo-accent-strong)]">
                                    Default
                                  </span>
                                )}
                                {sig.accountId && (
                                  <span className="text-xs">
                                    {accounts.find((a) => a.id === sig.accountId)?.email ??
                                      sig.accountId}
                                  </span>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center space-x-2 flex-shrink-0">
                            <button
                              onClick={() => setEditingSignature(sig)}
                              className="px-3 py-1.5 text-sm text-[var(--exo-accent)] hover:bg-[var(--exo-accent-soft)] rounded-lg transition-colors"
                            >
                              Edit
                            </button>
                            <button
                              onClick={() => handleDeleteSignature(sig.id)}
                              className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                              title="Delete signature"
                            >
                              <svg
                                className="w-4 h-4"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                  strokeWidth={2}
                                  d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                                />
                              </svg>
                            </button>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  <button
                    onClick={handleAddSignature}
                    className="w-full py-3 border-2 border-dashed exo-border-strong rounded-lg exo-text-secondary hover:border-[var(--exo-accent)] hover:text-[var(--exo-accent)] hover:bg-[var(--exo-accent-soft)] transition-colors"
                  >
                    + Add Signature
                  </button>
                </>
              )}

              {/* Signature editor */}
              {editingSignature && (
                <div className="exo-settings-card p-6 space-y-4">
                  <div>
                    <label className="block text-sm font-medium exo-text-secondary mb-1">
                      Signature Name
                    </label>
                    <input
                      type="text"
                      value={editingSignature.name}
                      onChange={(e) =>
                        setEditingSignature({ ...editingSignature, name: e.target.value })
                      }
                      placeholder="e.g., Work, Personal"
                      className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium exo-text-secondary mb-1">
                      Signature Content (HTML)
                    </label>
                    <textarea
                      value={editingSignature.bodyHtml}
                      onChange={(e) =>
                        setEditingSignature({ ...editingSignature, bodyHtml: e.target.value })
                      }
                      rows={8}
                      placeholder="<p>Best regards,<br>Your Name</p>"
                      className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm font-mono resize-none focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                    />
                    <p className="text-xs exo-text-muted mt-1">
                      You can use HTML tags for formatting (e.g., &lt;b&gt;, &lt;i&gt;, &lt;a
                      href="..."&gt;).
                    </p>
                  </div>

                  {/* Preview */}
                  {editingSignature.bodyHtml.trim() && (
                    <div>
                      <label className="block text-sm font-medium exo-text-secondary mb-1">
                        Preview
                      </label>
                      <div
                        className="p-3 border exo-border-subtle rounded-lg exo-surface-soft text-sm"
                        dangerouslySetInnerHTML={{
                          __html: DOMPurify.sanitize(editingSignature.bodyHtml),
                        }}
                      />
                    </div>
                  )}

                  {accounts.length > 1 && (
                    <div>
                      <label className="block text-sm font-medium exo-text-secondary mb-1">
                        Account (optional)
                      </label>
                      <select
                        value={editingSignature.accountId ?? ""}
                        onChange={(e) =>
                          setEditingSignature({
                            ...editingSignature,
                            accountId: e.target.value || undefined,
                          })
                        }
                        className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                      >
                        <option value="">All accounts (global)</option>
                        {accounts.map((account) => (
                          <option key={account.id} value={account.id}>
                            {account.email}
                          </option>
                        ))}
                      </select>
                      <p className="text-xs exo-text-muted mt-1">
                        Restrict this signature to a specific account, or leave as global.
                      </p>
                    </div>
                  )}

                  <div className="flex items-center space-x-3">
                    <button
                      onClick={() =>
                        setEditingSignature({
                          ...editingSignature,
                          isDefault: !editingSignature.isDefault,
                        })
                      }
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                        editingSignature.isDefault
                          ? "bg-[var(--exo-accent)]"
                          : "bg-[var(--exo-border-subtle)]"
                      }`}
                    >
                      <span
                        className={`inline-block h-4 w-4 transform rounded-full bg-[var(--exo-bg-elevated)] transition-transform ${
                          editingSignature.isDefault ? "translate-x-6" : "translate-x-1"
                        }`}
                      />
                    </button>
                    <span className="text-sm font-medium exo-text-secondary">
                      Set as default signature
                    </span>
                  </div>

                  <div className="flex justify-end space-x-3 pt-2">
                    <button
                      onClick={() => setEditingSignature(null)}
                      className="px-4 py-2 text-sm exo-text-secondary hover:bg-[var(--exo-bg-surface-hover)] rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => handleSaveSignature(editingSignature)}
                      disabled={isSavingSignatures || !editingSignature.name.trim()}
                      className="px-6 py-2 bg-[var(--exo-accent)] text-white text-sm font-medium rounded-lg hover:bg-[var(--exo-accent-strong)] transition-colors disabled:opacity-50"
                    >
                      {isSavingSignatures ? "Saving..." : "Save Signature"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === "prompts" && (
          <div className="max-w-3xl space-y-6">
            {isLoading ? (
              <p className="exo-text-muted">Loading settings...</p>
            ) : (
              <>
                {/* Analysis Prompt */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-semibold exo-text-secondary">
                      Analysis Prompt
                    </label>
                    <button
                      onClick={handleResetAnalysis}
                      className="text-xs text-[var(--exo-accent)] hover:text-[var(--exo-accent-strong)]"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <p className="text-xs exo-text-muted mb-2">
                    Each email is categorized as SKIP (no reply), or HIGH / MEDIUM / LOW priority.
                    Customize the rules below to control how emails are triaged. The required output
                    format is handled automatically.
                  </p>
                  <textarea
                    value={analysisPrompt}
                    onChange={(e) => setAnalysisPrompt(e.target.value)}
                    rows={12}
                    className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm font-mono resize-none focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                  />
                </div>

                {/* Agent Drafter System Prompt */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-semibold exo-text-secondary">
                      Agent System Prompt
                    </label>
                    <button
                      onClick={handleResetAgentDrafter}
                      className="text-xs text-[var(--exo-accent)] hover:text-[var(--exo-accent-strong)]"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <p className="text-xs exo-text-muted mb-2">
                    System prompt for the AI agent that drafts replies. The agent can look up
                    senders online, search your email history, and use other tools to gather context
                    before writing the draft.
                  </p>
                  <textarea
                    value={agentDrafterPrompt}
                    onChange={(e) => setAgentDrafterPrompt(e.target.value)}
                    rows={10}
                    className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm font-mono resize-none focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                  />
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      onClick={async () => {
                        setIsRerunningAll(true);
                        setRerunResult(null);
                        try {
                          const result = (await window.api.drafts.rerunAllAgents()) as {
                            success: boolean;
                            data?: { clearedCount: number };
                            error?: string;
                          };
                          if (result.success) {
                            // Clear pending drafts from the store in a single atomic update
                            // (not via buffered prompts:changed which races with agent:draft-saved)
                            useAppStore.setState((state) => ({
                              emails: state.emails.map((e) =>
                                e.draft?.status === "pending" ? { ...e, draft: undefined } : e,
                              ),
                            }));
                            setRerunResult(
                              `Cleared ${result.data?.clearedCount ?? 0} drafts. Regeneration started.`,
                            );
                          } else {
                            setRerunResult(`Error: ${result.error}`);
                          }
                        } catch (err) {
                          setRerunResult(
                            `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
                          );
                        } finally {
                          setIsRerunningAll(false);
                        }
                      }}
                      disabled={isRerunningAll}
                      className="px-4 py-1.5 bg-orange-500 dark:bg-orange-600 text-white text-sm font-medium rounded-lg hover:bg-orange-600 dark:hover:bg-orange-700 transition-colors disabled:opacity-50"
                    >
                      {isRerunningAll ? "Rerunning..." : "Rerun All Drafts"}
                    </button>
                    {rerunResult && (
                      <p
                        className={`text-sm ${rerunResult.startsWith("Error") ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}
                      >
                        {rerunResult}
                      </p>
                    )}
                  </div>
                </div>

                {/* Draft Writing Prompt */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-semibold exo-text-secondary">
                      Draft Writing Prompt
                    </label>
                    <button
                      onClick={handleResetDraft}
                      className="text-xs text-[var(--exo-accent)] hover:text-[var(--exo-accent-strong)]"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <p className="text-xs exo-text-muted mb-2">
                    Used by the agent in the final step when it writes the actual reply text.
                    Controls tone, structure, and style of the generated email. The output format is
                    handled automatically.
                  </p>
                  <textarea
                    value={draftPrompt}
                    onChange={(e) => setDraftPrompt(e.target.value)}
                    rows={8}
                    className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm font-mono resize-none focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                  />
                </div>

                {/* Archive Ready Prompt */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <label className="block text-sm font-semibold exo-text-secondary">
                      Archive Ready Prompt
                    </label>
                    <button
                      onClick={handleResetArchiveReady}
                      className="text-xs text-[var(--exo-accent)] hover:text-[var(--exo-accent-strong)]"
                    >
                      Reset to Default
                    </button>
                  </div>
                  <p className="text-xs exo-text-muted mb-2">
                    Each thread is classified as READY or NOT READY to archive. Customize the rules
                    below to control what gets surfaced for archiving. The required output format is
                    handled automatically.
                  </p>
                  <textarea
                    value={archiveReadyPrompt}
                    onChange={(e) => setArchiveReadyPrompt(e.target.value)}
                    rows={12}
                    className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm font-mono resize-none focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                  />
                </div>

                {/* Save button */}
                <div className="flex items-center justify-end gap-3">
                  {saveResult && (
                    <p className="text-sm text-green-600 dark:text-green-400">{saveResult}</p>
                  )}
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="px-6 py-2 bg-[var(--exo-accent)] text-white text-sm font-medium rounded-lg hover:bg-[var(--exo-accent-strong)] transition-colors disabled:opacity-50"
                  >
                    {isSaving ? "Saving..." : "Save Changes"}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {activeTab === "style" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold exo-text-primary mb-2">
                Writing Style
              </h2>
              <p className="exo-text-secondary mb-4">
                Drafts automatically include examples of your past emails to this recipient (or
                similar recipients) so the AI can match your tone and formality. No manual indexing
                needed — it works from your synced sent emails.
              </p>

              <div className="bg-[var(--exo-accent-soft)] p-4 rounded-lg mb-6">
                <h3 className="font-semibold text-[var(--exo-accent-strong)] mb-2">
                  How it works:
                </h3>
                <ol className="text-sm text-[var(--exo-accent-strong)] space-y-1 list-decimal list-inside">
                  <li>
                    Finds sent emails to this recipient (or same domain, or similar formality)
                  </li>
                  <li>Includes 2-3 examples as few-shot context for the AI</li>
                  <li>Computes a formality score per correspondent (greeting, sign-off, length)</li>
                  <li>Your style prompt below guides how the AI uses these examples</li>
                </ol>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="block text-sm font-medium exo-text-secondary">
                    Style Prompt
                  </label>
                  <button
                    onClick={handleResetStylePrompt}
                    className="text-xs text-[var(--exo-accent)] hover:underline"
                  >
                    Reset to default
                  </button>
                </div>
                <textarea
                  value={stylePrompt}
                  onChange={(e) => setStylePrompt(e.target.value)}
                  rows={4}
                  className="w-full px-3 py-2 border border-[var(--exo-border-strong)] rounded-lg exo-elevated exo-text-primary text-sm focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                  placeholder="Describe your writing style..."
                />
                <p className="text-xs exo-text-muted">
                  This prompt is prepended to your draft generation when style examples are
                  available. It tells the AI how to interpret the examples of your past emails.
                </p>
              </div>

              <button
                onClick={handleSaveStylePrompt}
                disabled={isSaving}
                className="mt-4 px-6 py-2 bg-[var(--exo-accent)] text-white font-medium rounded-lg hover:bg-[var(--exo-accent-strong)] transition-colors disabled:opacity-50"
              >
                {isSaving ? "Saving..." : "Save Style Prompt"}
              </button>
            </div>
          </div>
        )}

        {activeTab === "assistant" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold exo-text-primary mb-2">
                Executive Assistant Integration
              </h2>
              <p className="exo-text-secondary mb-4">
                When enabled, Exo will automatically CC your executive assistant on emails that
                involve scheduling or calendar coordination. This lets your assistant handle
                scheduling while you focus on the content of your response.
              </p>

              <div className="bg-[var(--exo-accent-soft)] p-4 rounded-lg mb-6">
                <h3 className="font-semibold text-[var(--exo-accent-strong)] mb-2">
                  How it works:
                </h3>
                <ol className="text-sm text-[var(--exo-accent-strong)] space-y-1 list-decimal list-inside">
                  <li>When you generate a draft, Exo detects scheduling language</li>
                  <li>If scheduling is detected, your EA is automatically added to the CC</li>
                  <li>The draft includes a note deferring scheduling to your EA</li>
                  <li>Your EA can then coordinate directly with the sender</li>
                </ol>
              </div>

              {/* Enable toggle */}
              <div className="flex items-center space-x-3 mb-6">
                <button
                  onClick={() => setEaEnabled(!eaEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    eaEnabled ? "bg-[var(--exo-accent)]" : "bg-[var(--exo-border-subtle)]"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-[var(--exo-bg-elevated)] transition-transform ${
                      eaEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
                <span className="text-sm font-medium exo-text-secondary">
                  Enable EA integration for scheduling
                </span>
              </div>

              {/* EA Details */}
              {eaEnabled && (
                <div className="space-y-4 mb-6">
                  <div>
                    <label className="block text-sm font-medium exo-text-secondary mb-1">
                      EA Name
                    </label>
                    <input
                      type="text"
                      value={eaName}
                      onChange={(e) => setEaName(e.target.value)}
                      placeholder="e.g., Sarah"
                      className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                    />
                    <p className="text-xs exo-text-muted mt-1">
                      This name will be used in the deferral message.
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium exo-text-secondary mb-1">
                      EA Email
                    </label>
                    <input
                      type="email"
                      value={eaEmail}
                      onChange={(e) => setEaEmail(e.target.value)}
                      placeholder="e.g., sarah@company.com"
                      className="w-full p-3 border border-[var(--exo-border-strong)] rounded-lg text-sm focus:ring-2 focus:ring-[var(--exo-focus-ring)] focus:border-transparent"
                    />
                    <p className="text-xs exo-text-muted mt-1">
                      Your EA will be CC'd on scheduling-related emails.
                    </p>
                  </div>
                </div>
              )}

              {/* Save button */}
              {eaError && <p className="text-sm text-red-600 dark:text-red-400 mb-2">{eaError}</p>}
              <div className="flex justify-end">
                <button
                  onClick={handleSaveEA}
                  disabled={isSavingEA || eaSaved}
                  className="px-6 py-2 bg-[var(--exo-accent)] text-white text-sm font-medium rounded-lg hover:bg-[var(--exo-accent-strong)] transition-colors disabled:opacity-50"
                >
                  {isSavingEA ? "Saving..." : eaSaved ? "Saved!" : "Save Changes"}
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === "memories" && (
          <MemoriesTab
            accountId={
              currentAccountId ||
              accounts.find((a) => a.isPrimary)?.id ||
              accounts[0]?.id ||
              "default"
            }
            highlightMemoryIds={highlightMemoryIds}
          />
        )}

        {activeTab === "queue" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h2 className="text-lg font-semibold exo-text-primary mb-2">
                Background Processing Queue
              </h2>
              <p className="exo-text-secondary mb-4">
                Monitor the background processing of email analysis, sender lookups, and draft
                generation.
              </p>

              {/* Status indicator */}
              <div className="exo-settings-card p-4 mb-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center space-x-3">
                    <div
                      className={`w-3 h-3 rounded-full ${
                        prefetchProgress.status === "running"
                          ? "bg-green-500 animate-pulse"
                          : prefetchProgress.status === "error"
                            ? "bg-red-500"
                            : "bg-[var(--exo-text-muted)]"
                      }`}
                    />
                    <span className="font-medium exo-text-primary">
                      {prefetchProgress.status === "running"
                        ? "Processing"
                        : prefetchProgress.status === "error"
                          ? "Error"
                          : "Idle"}
                    </span>
                  </div>
                  <span className="text-sm exo-text-muted">
                    {prefetchProgress.queueLength} items in queue
                  </span>
                </div>

                {/* Current task */}
                {prefetchProgress.currentTask && (
                  <div className="bg-[var(--exo-accent-soft)] p-3 rounded-lg mb-4">
                    <div className="flex items-center space-x-2">
                      <svg
                        className="w-4 h-4 text-[var(--exo-accent)] animate-spin"
                        fill="none"
                        viewBox="0 0 24 24"
                      >
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
                      <span className="text-sm text-[var(--exo-accent-strong)]">
                        <span className="font-medium capitalize">
                          {prefetchProgress.currentTask.type.replace("-", " ")}
                        </span>
                        <span className="text-[var(--exo-accent)] ml-2 font-mono text-xs">
                          {prefetchProgress.currentTask.emailId.slice(0, 8)}...
                        </span>
                      </span>
                    </div>
                  </div>
                )}

                {/* Progress bars */}
                <div className="space-y-3">
                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="exo-text-secondary">Analysis</span>
                      <span className="exo-text-primary font-medium">
                        {prefetchProgress.processed.analysis}
                      </span>
                    </div>
                    <div className="w-full bg-[var(--exo-border-subtle)] rounded-full h-2">
                      <div
                        className="bg-[var(--exo-accent)] h-2 rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(prefetchProgress.processed.analysis, 100)}%` }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="exo-text-secondary">Sender Profiles</span>
                      <span className="exo-text-primary font-medium">
                        {prefetchProgress.processed.senderProfile}
                      </span>
                    </div>
                    <div className="w-full bg-[var(--exo-border-subtle)] rounded-full h-2">
                      <div
                        className="bg-purple-600 dark:bg-purple-500 h-2 rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.min(prefetchProgress.processed.senderProfile, 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="exo-text-secondary">
                        Extension Enrichments
                      </span>
                      <span className="exo-text-primary font-medium">
                        {prefetchProgress.processed.extensionEnrichment}
                      </span>
                    </div>
                    <div className="w-full bg-[var(--exo-border-subtle)] rounded-full h-2">
                      <div
                        className="bg-green-600 dark:bg-green-500 h-2 rounded-full transition-all duration-300"
                        style={{
                          width: `${Math.min(prefetchProgress.processed.extensionEnrichment, 100)}%`,
                        }}
                      />
                    </div>
                  </div>

                  <div>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="exo-text-secondary">Drafts</span>
                      <span className="exo-text-primary font-medium">
                        {prefetchProgress.processed.draft}
                      </span>
                    </div>
                    <div className="w-full bg-[var(--exo-border-subtle)] rounded-full h-2">
                      <div
                        className="bg-amber-600 dark:bg-amber-500 h-2 rounded-full transition-all duration-300"
                        style={{ width: `${Math.min(prefetchProgress.processed.draft, 100)}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>

              {/* Agent Draft Queue */}
              {prefetchProgress.agentDrafts &&
                (prefetchProgress.agentDrafts.running > 0 ||
                  prefetchProgress.agentDrafts.queued > 0 ||
                  prefetchProgress.agentDrafts.completed > 0) && (
                  <div className="exo-settings-card p-4">
                    <h5 className="text-sm font-medium exo-text-primary mb-3">
                      Agent Draft Queue
                    </h5>
                    <div className="flex gap-4 text-xs exo-text-muted mb-3">
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-[var(--exo-accent)] animate-pulse" />
                        {prefetchProgress.agentDrafts.running} running
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-[var(--exo-text-muted)]" />
                        {prefetchProgress.agentDrafts.queued} queued
                      </span>
                      <span className="flex items-center gap-1">
                        <span className="w-2 h-2 rounded-full bg-green-500" />
                        {prefetchProgress.agentDrafts.completed} done
                      </span>
                      {prefetchProgress.agentDrafts.failed > 0 && (
                        <span className="flex items-center gap-1">
                          <span className="w-2 h-2 rounded-full bg-red-500" />
                          {prefetchProgress.agentDrafts.failed} failed
                        </span>
                      )}
                    </div>
                    <div className="space-y-1.5 max-h-48 overflow-y-auto">
                      {prefetchProgress.agentDrafts.items.map((item) => (
                        <div
                          key={item.emailId}
                          className="flex items-center gap-2 text-xs py-1 px-2 rounded bg-[var(--exo-bg-surface-soft)]/50"
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                              item.status === "running"
                                ? "bg-[var(--exo-accent)] animate-pulse"
                                : item.status === "queued"
                                  ? "bg-[var(--exo-text-muted)]"
                                  : item.status === "completed"
                                    ? "bg-green-500"
                                    : "bg-red-500"
                            }`}
                          />
                          <span className="truncate flex-1 exo-text-secondary">
                            {item.subject}
                          </span>
                          <span className="exo-text-muted flex-shrink-0">
                            {
                              item.from
                                .replace(/<[^>]+>/, "")
                                .trim()
                                .split(" ")[0]
                            }
                          </span>
                          <span
                            className={`flex-shrink-0 px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              item.priority === "high"
                                ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                                : item.priority === "medium"
                                  ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400"
                                  : "bg-[var(--exo-bg-surface-soft)] text-[var(--exo-text-secondary)]"
                            }`}
                          >
                            {item.priority}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

              {/* Info box */}
              <div className="exo-surface-soft p-4 rounded-lg text-sm exo-text-secondary">
                <p className="font-medium mb-2">How it works:</p>
                <ul className="list-disc list-inside space-y-1">
                  <li>
                    <strong>Analysis:</strong> Determines if emails need a reply and their priority
                  </li>
                  <li>
                    <strong>Sender Profiles:</strong> Looks up sender information for all inbox
                    emails
                  </li>
                  <li>
                    <strong>Extension Enrichments:</strong> Runs extension plugins to enrich email
                    data
                  </li>
                  <li>
                    <strong>Drafts:</strong> Agent-mode drafts for prioritized emails (max 3
                    concurrent)
                  </li>
                </ul>
              </div>
            </div>
          </div>
        )}

        {activeTab === "agents" && (
          <div className="space-y-6">
            <div>
              <h3 className="text-lg font-medium exo-text-primary mb-4">
                Agent Settings
              </h3>
              <p className="text-sm exo-text-muted mb-6">
                Configure AI agent capabilities including browser automation.
              </p>
            </div>

            {/* Authentication */}
            <div className="exo-settings-card p-6">
              <h4 className="text-base font-medium exo-text-primary mb-4">
                Authentication
              </h4>

              <div className="mb-6">
                <h5 className="text-sm font-medium exo-text-secondary mb-1">
                  Default AI Provider
                </h5>
                <p className="text-xs exo-text-muted mb-3">
                  Codex is recommended. Anthropic remains available as a fallback path.
                </p>
                <div className="grid grid-cols-2 gap-2 mb-3">
                  <button
                    onClick={() => setAiProvider("codex")}
                    className={`px-3 py-2 rounded-lg text-sm border transition-colors ${
                      aiProvider === "codex"
                        ? "bg-[var(--exo-accent)] text-white border-[var(--exo-accent)]"
                        : "bg-[var(--exo-bg-elevated)] exo-text-secondary exo-border-strong"
                    }`}
                  >
                    Codex
                  </button>
                  <button
                    onClick={() => setAiProvider("anthropic")}
                    className={`px-3 py-2 rounded-lg text-sm border transition-colors ${
                      aiProvider === "anthropic"
                        ? "bg-[var(--exo-accent)] text-white border-[var(--exo-accent)]"
                        : "bg-[var(--exo-bg-elevated)] exo-text-secondary exo-border-strong"
                    }`}
                  >
                    Anthropic
                  </button>
                </div>
                <label className="flex items-center gap-2 text-sm exo-text-secondary">
                  <input
                    type="checkbox"
                    checked={enableAnthropicFallback}
                    onChange={(e) => setEnableAnthropicFallback(e.target.checked)}
                    className="rounded exo-border-strong"
                  />
                  Enable Anthropic fallback when Codex fails
                </label>
              </div>

              <div className="mb-6 pt-4 border-t exo-border-subtle">
                <h5 className="text-sm font-medium exo-text-secondary mb-1">
                  Codex (OAuth)
                </h5>
                <p className="text-xs exo-text-muted mb-3">
                  Uses your Codex login from <code>codex login</code>.
                </p>

                <div className="flex items-center gap-3 mb-3">
                  {codexAuthStatus === "checking" && (
                    <span className="text-sm exo-text-muted">Checking...</span>
                  )}
                  {codexAuthStatus === "authenticated" && (
                    <span className="text-sm text-green-700 dark:text-green-400">Logged in</span>
                  )}
                  {codexAuthStatus === "not_authenticated" && (
                    <span className="text-sm exo-text-muted">Not logged in</span>
                  )}
                  {!codexCliAvailable && (
                    <span className="text-xs text-amber-700 dark:text-amber-400">
                      Codex CLI not found
                    </span>
                  )}
                </div>

                <div className="flex gap-2 mb-2">
                  <input
                    type="text"
                    value={codexModel}
                    onChange={(e) => setCodexModel(e.target.value)}
                    placeholder="gpt-5.4"
                    className="flex-1 px-3 py-2 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary"
                  />
                  <button
                    onClick={handleTestCodexConnection}
                    disabled={isTestingCodex}
                    className="px-4 py-2 bg-[var(--exo-bg-surface-soft)] exo-text-secondary text-sm font-medium rounded-lg hover:bg-[var(--exo-bg-surface-hover)] disabled:opacity-50 transition-colors"
                  >
                    {isTestingCodex ? "Testing..." : "Test"}
                  </button>
                </div>
                {codexStatusText && (
                  <p className="text-xs exo-text-muted mb-2">{codexStatusText}</p>
                )}
                {codexTestError && (
                  <p className="text-xs text-red-600 dark:text-red-400">{codexTestError}</p>
                )}
              </div>

              {/* Anthropic API Key */}
              <div className="mb-6">
                <h5 className="text-sm font-medium exo-text-secondary mb-1">
                  Anthropic API Key
                </h5>
                <p className="text-xs exo-text-muted mb-3">
                  Required for email analysis, draft generation, and sender lookup.
                </p>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={anthropicApiKey}
                    onChange={(e) => setAnthropicApiKey(e.target.value)}
                    placeholder="sk-ant-..."
                    className="flex-1 px-3 py-2 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary placeholder-[var(--exo-text-muted)]"
                  />
                  <button
                    onClick={handleSaveApiKey}
                    disabled={isSavingApiKey}
                    className={`px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors ${
                      apiKeySaved
                        ? "bg-green-600 dark:bg-green-500"
                        : "bg-[var(--exo-accent)] hover:bg-[var(--exo-accent-strong)]"
                    }`}
                  >
                    {isSavingApiKey ? "Saving..." : apiKeySaved ? "Saved" : "Save"}
                  </button>
                </div>
              </div>

              <div className="mb-6">
                <button
                  onClick={handleSaveAiConfig}
                  disabled={isSavingAiConfig}
                  className={`px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors ${
                    aiConfigSaved
                      ? "bg-green-600 dark:bg-green-500"
                      : "bg-[var(--exo-accent)] hover:bg-[var(--exo-accent-strong)]"
                  }`}
                >
                  {isSavingAiConfig ? "Saving..." : aiConfigSaved ? "Saved" : "Save AI Settings"}
                </button>
              </div>

              {/* Claude Account (OAuth) — only shown when claude CLI is available */}
              {claudeCliAvailable && (
                <div className="pt-4 border-t exo-border-subtle">
                  <h5 className="text-sm font-medium exo-text-secondary mb-1">
                    Claude Agent
                  </h5>
                  <p className="text-xs exo-text-muted mb-3">
                    The agent can also authenticate via your Claude account. If you have Claude Code
                    installed and logged in, this is detected automatically.
                  </p>

                  <div className="flex items-center gap-3 mb-3">
                    {claudeAuthStatus === "checking" && (
                      <span className="flex items-center gap-2 text-sm exo-text-muted">
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
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                          />
                        </svg>
                        Checking...
                      </span>
                    )}
                    {claudeAuthStatus === "authenticated" && (
                      <span className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                          />
                        </svg>
                        Logged in{claudeAuthEmail ? ` (${claudeAuthEmail})` : ""}
                      </span>
                    )}
                    {claudeAuthStatus === "not_authenticated" && (
                      <span className="flex items-center gap-2 text-sm exo-text-muted">
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                        Not logged in
                      </span>
                    )}
                  </div>

                  <button
                    onClick={handleClaudeLogin}
                    disabled={isLoggingIn}
                    className="px-4 py-2 bg-[var(--exo-bg-surface-soft)] exo-text-secondary text-sm font-medium rounded-lg hover:bg-[var(--exo-bg-surface-hover)] disabled:opacity-50 transition-colors"
                  >
                    {isLoggingIn ? "Logging in..." : "Login with Claude Account"}
                  </button>

                  {loginError && (
                    <p className="text-xs text-red-600 dark:text-red-400 mt-2">{loginError}</p>
                  )}

                  <p className="text-xs exo-text-muted mt-3">
                    An API key above also enables the agent. Claude Account login is only needed if
                    you don't have an API key.
                  </p>
                </div>
              )}
            </div>

            {/* Browser Automation */}
            <div className="exo-settings-card p-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h4 className="text-base font-medium exo-text-primary">
                    Browser Automation
                  </h4>
                  <p className="text-sm exo-text-muted mt-1">
                    Allow agents to browse the web using Chrome DevTools Protocol. Requires Chrome
                    to be running with remote debugging enabled.
                  </p>
                </div>
                <button
                  onClick={() => setBrowserEnabled(!browserEnabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
                    browserEnabled ? "bg-purple-600" : "bg-[var(--exo-border-subtle)]"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-[var(--exo-bg-elevated)] transition-transform ${
                      browserEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>

              {browserEnabled && (
                <div className="space-y-4 pt-4 border-t exo-border-subtle">
                  <div>
                    <label className="block text-sm font-medium exo-text-secondary mb-1">
                      Chrome Debug Port
                    </label>
                    <input
                      type="number"
                      value={chromeDebugPort}
                      onChange={(e) => setChromeDebugPort(Number(e.target.value))}
                      min={1024}
                      max={65535}
                      className="w-32 px-3 py-2 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary"
                    />
                    <p className="text-xs exo-text-muted mt-1">
                      Default: 9222. Chrome must be launched with --remote-debugging-port=
                      {chromeDebugPort}
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium exo-text-secondary mb-1">
                      Chrome Profile Path (optional)
                    </label>
                    <input
                      type="text"
                      value={chromeProfilePath}
                      onChange={(e) => setChromeProfilePath(e.target.value)}
                      placeholder="~/.chrome-debug-profile"
                      className="w-full px-3 py-2 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary placeholder-[var(--exo-text-muted)]"
                    />
                    <p className="text-xs exo-text-muted mt-1">
                      Use a separate profile directory for persistent login sessions.
                    </p>
                  </div>

                  <div className="bg-amber-50 dark:bg-amber-900/30 p-4 rounded-lg">
                    <p className="text-sm text-amber-800 dark:text-amber-300">
                      <strong>How to launch Chrome with debugging:</strong>
                    </p>
                    <code className="block mt-2 text-xs bg-amber-100 dark:bg-amber-900/30 p-2 rounded text-amber-900 dark:text-amber-300 font-mono">
                      /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome
                      --remote-debugging-port={chromeDebugPort}
                      {chromeProfilePath ? ` --user-data-dir="${chromeProfilePath}"` : ""}
                    </code>
                  </div>
                </div>
              )}

              <div className="mt-4 flex justify-end">
                <button
                  onClick={async () => {
                    setIsSavingBrowser(true);
                    try {
                      await window.api.settings.set({
                        agentBrowser: {
                          enabled: browserEnabled,
                          chromeDebugPort,
                          chromeProfilePath: chromeProfilePath || undefined,
                        },
                      });
                    } finally {
                      setIsSavingBrowser(false);
                    }
                  }}
                  disabled={isSavingBrowser}
                  className="px-4 py-2 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
                >
                  {isSavingBrowser ? "Saving..." : "Save"}
                </button>
              </div>
            </div>

            {/* Custom MCP Servers */}
            <div className="exo-settings-card p-6">
              <div className="mb-4">
                <h4 className="text-base font-medium exo-text-primary">
                  Custom MCP Servers
                </h4>
                <p className="text-sm exo-text-muted mt-1">
                  Add MCP servers to give the agent access to custom tools. Paste the JSON config
                  from your MCP server&apos;s docs.
                </p>
              </div>

              {/* Current servers summary */}
              {Object.keys(mcpServers).length > 0 && !isMcpEditing && (
                <div className="space-y-2 mb-4">
                  {Object.entries(mcpServers).map(([name, config]) => {
                    const transport = "url" in config ? (config.type ?? "http") : "stdio";
                    const detail =
                      "url" in config
                        ? config.url
                        : `${"command" in config ? config.command : ""}${"args" in config && config.args?.length ? ` ${config.args.join(" ")}` : ""}`;
                    return (
                      <div
                        key={name}
                        className="flex items-center justify-between p-3 bg-[var(--exo-bg-surface-soft)]/50 rounded-lg"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium exo-text-primary">
                            {name}
                            <span className="ml-2 text-xs font-normal exo-text-muted">
                              {transport}
                            </span>
                          </p>
                          <p className="text-xs exo-text-muted truncate font-mono">
                            {detail}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* JSON editor */}
              {isMcpEditing ? (
                <div className="space-y-3">
                  <textarea
                    value={mcpJsonText}
                    onChange={(e) => {
                      setMcpJsonText(e.target.value);
                      setMcpFormError(null);
                    }}
                    rows={12}
                    spellCheck={false}
                    placeholder={`Paste MCP config JSON, e.g.:\n\n{\n  "mcpServers": {\n    "exa": {\n      "url": "https://mcp.exa.ai/mcp"\n    }\n  }\n}\n\nOr stdio format:\n{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]\n    }\n  }\n}`}
                    className="w-full px-3 py-2 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary placeholder-[var(--exo-text-muted)] font-mono leading-relaxed"
                  />
                  {mcpFormError && (
                    <p className="text-xs text-red-600 dark:text-red-400">{mcpFormError}</p>
                  )}
                  <div className="flex gap-2 justify-end">
                    <button
                      onClick={() => {
                        setIsMcpEditing(false);
                        setMcpFormError(null);
                      }}
                      className="px-3 py-1.5 text-sm exo-text-secondary hover:bg-[var(--exo-bg-surface-hover)] rounded-lg transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={async () => {
                        const text = mcpJsonText.trim();
                        if (!text) {
                          // Empty = clear all servers
                          setMcpServers({});
                          setIsMcpEditing(false);
                          setMcpFormError(null);
                          setIsSavingMcp(true);
                          try {
                            await window.api.settings.set({ mcpServers: undefined });
                          } finally {
                            setIsSavingMcp(false);
                          }
                          return;
                        }

                        let parsed: unknown;
                        try {
                          parsed = JSON.parse(text);
                        } catch {
                          setMcpFormError("Invalid JSON");
                          return;
                        }
                        if (
                          typeof parsed !== "object" ||
                          parsed === null ||
                          Array.isArray(parsed)
                        ) {
                          setMcpFormError("Expected a JSON object");
                          return;
                        }

                        // Accept either { "mcpServers": { ... } } or { "serverName": { ... } } directly
                        const obj = parsed as Record<string, unknown>;
                        let servers: Record<string, unknown>;
                        if (
                          obj.mcpServers &&
                          typeof obj.mcpServers === "object" &&
                          !Array.isArray(obj.mcpServers)
                        ) {
                          servers = obj.mcpServers as Record<string, unknown>;
                        } else {
                          servers = obj;
                        }

                        const reservedNames = new Set(["mail-app-tools", "chrome-devtools"]);
                        const validated: Record<string, McpServerConfig> = {};

                        for (const [name, config] of Object.entries(servers)) {
                          if (reservedNames.has(name)) {
                            setMcpFormError(`"${name}" is a reserved server name`);
                            return;
                          }
                          if (/\s/.test(name)) {
                            setMcpFormError(`Server name "${name}" cannot contain spaces`);
                            return;
                          }
                          if (
                            typeof config !== "object" ||
                            config === null ||
                            Array.isArray(config)
                          ) {
                            setMcpFormError(`Config for "${name}" must be an object`);
                            return;
                          }

                          const cfg = config as Record<string, unknown>;
                          // Validate headers/env values are strings if present
                          const validateStringRecord = (
                            obj: unknown,
                            label: string,
                          ): Record<string, string> | null => {
                            if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
                              setMcpFormError(`${label}s for "${name}" must be a JSON object`);
                              return null;
                            }
                            for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
                              if (typeof v !== "string") {
                                setMcpFormError(
                                  `${label} value for "${k}" in "${name}" must be a string`,
                                );
                                return null;
                              }
                            }
                            return obj as Record<string, string>;
                          };
                          // Detect transport: has "url" → http/sse, has "command" → stdio
                          if (typeof cfg.url === "string") {
                            if (cfg.type && cfg.type !== "http" && cfg.type !== "sse") {
                              setMcpFormError(
                                `Invalid transport type "${String(cfg.type)}" for "${name}" — use "http" or "sse" with url`,
                              );
                              return;
                            }
                            const type = cfg.type === "sse" ? ("sse" as const) : ("http" as const);
                            let headers: Record<string, string> | undefined;
                            if (cfg.headers) {
                              const parsed = validateStringRecord(cfg.headers, "Header");
                              if (parsed === null) return; // error already set
                              headers = parsed;
                            }
                            validated[name] = {
                              type,
                              url: cfg.url,
                              ...(headers ? { headers } : {}),
                            };
                          } else if (typeof cfg.command === "string") {
                            let env: Record<string, string> | undefined;
                            if (cfg.env) {
                              const parsed = validateStringRecord(cfg.env, "Env var");
                              if (parsed === null) return;
                              env = parsed;
                            }
                            validated[name] = {
                              type: "stdio" as const,
                              command: cfg.command,
                              ...(Array.isArray(cfg.args) ? { args: cfg.args.map(String) } : {}),
                              ...(env ? { env } : {}),
                            };
                          } else {
                            setMcpFormError(
                              `Config for "${name}" needs either "url" (http/sse) or "command" (stdio)`,
                            );
                            return;
                          }
                        }

                        if (Object.keys(validated).length === 0) {
                          setMcpFormError("No servers found in JSON");
                          return;
                        }

                        setMcpServers(validated);
                        setIsMcpEditing(false);
                        setMcpFormError(null);
                        setIsSavingMcp(true);
                        try {
                          await window.api.settings.set({ mcpServers: validated });
                        } finally {
                          setIsSavingMcp(false);
                        }
                      }}
                      disabled={isSavingMcp}
                      className="px-4 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 disabled:opacity-50 transition-colors"
                    >
                      {isSavingMcp ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  onClick={() => {
                    // Pre-populate the textarea with existing config for editing
                    if (Object.keys(mcpServers).length > 0) {
                      setMcpJsonText(JSON.stringify({ mcpServers }, null, 2));
                    } else {
                      setMcpJsonText("");
                    }
                    setIsMcpEditing(true);
                    setMcpFormError(null);
                  }}
                  className="text-sm text-purple-600 dark:text-purple-400 hover:underline"
                >
                  {Object.keys(mcpServers).length > 0 ? "Edit MCP Config" : "+ Add MCP Server"}
                </button>
              )}
            </div>

            {/* CLI Tools */}
            <div className="exo-settings-card p-6">
              <div className="mb-4">
                <h4 className="text-base font-medium exo-text-primary">
                  CLI Tools
                </h4>
                <p className="text-sm exo-text-muted mt-1">
                  Allow the agent to run specific CLI commands. Each command becomes a dedicated
                  tool the agent can call.
                </p>
              </div>

              <div className="space-y-3">
                {cliTools.map((tool, idx) => (
                  <div
                    key={tool._key}
                    className="p-3 bg-[var(--exo-bg-surface-soft)]/50 rounded-lg space-y-2"
                  >
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={tool.command}
                        onChange={(e) => {
                          const updated = [...cliTools];
                          updated[idx] = { ...updated[idx], command: e.target.value };
                          setCliTools(updated);
                        }}
                        placeholder="e.g. curl, python3, jq"
                        className="flex-1 px-3 py-1.5 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary placeholder-[var(--exo-text-muted)] font-mono"
                      />
                      <button
                        onClick={() => {
                          setCliTools(cliTools.filter((_, i) => i !== idx));
                        }}
                        className="p-1.5 text-[var(--exo-text-muted)] hover:text-red-500 dark:hover:text-red-400 transition-colors"
                        title="Remove tool"
                      >
                        <svg
                          className="w-4 h-4"
                          fill="none"
                          stroke="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                          />
                        </svg>
                      </button>
                    </div>
                    <textarea
                      value={tool.instructions}
                      onChange={(e) => {
                        const updated = [...cliTools];
                        updated[idx] = { ...updated[idx], instructions: e.target.value };
                        setCliTools(updated);
                      }}
                      placeholder="Instructions for when to use this tool (optional)"
                      rows={2}
                      className="w-full px-3 py-1.5 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary placeholder-[var(--exo-text-muted)]"
                    />
                  </div>
                ))}

                <button
                  onClick={() =>
                    setCliTools([
                      ...cliTools,
                      { command: "", instructions: "", _key: nextCliToolKey() },
                    ])
                  }
                  className="text-sm text-purple-600 dark:text-purple-400 hover:underline"
                >
                  + Add CLI Tool
                </button>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={async () => {
                    setIsSavingCliTools(true);
                    setCliToolsSaved(false);
                    try {
                      // Filter out empty commands and strip internal _key before saving
                      const validTools = cliTools.filter((t) => t.command.trim());
                      const toSave = validTools.map(({ _key, ...rest }) => rest);
                      await window.api.settings.set({
                        cliTools: toSave.length > 0 ? toSave : undefined,
                      });
                      queryClient.invalidateQueries({ queryKey: ["general-config"] });
                      setCliTools(validTools);
                      setCliToolsSaved(true);
                      setTimeout(() => setCliToolsSaved(false), 2000);
                    } finally {
                      setIsSavingCliTools(false);
                    }
                  }}
                  disabled={isSavingCliTools}
                  className={`px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors ${
                    cliToolsSaved
                      ? "bg-green-600 dark:bg-green-500"
                      : "bg-purple-600 hover:bg-purple-700"
                  }`}
                >
                  {isSavingCliTools ? "Saving..." : cliToolsSaved ? "Saved" : "Save"}
                </button>
              </div>
            </div>

            {/* Extra PATH Directories */}
            <div className="exo-settings-card p-6">
              <div className="mb-4">
                <h4 className="text-base font-medium exo-text-primary">
                  Additional Tool Directories
                </h4>
                <p className="text-sm exo-text-muted mt-1">
                  Extra directories to add to the system PATH so agents can find CLI tools installed
                  in non-standard locations.
                </p>
              </div>

              <div className="space-y-2">
                {extraPathDirs.map((dir, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={dir}
                      onChange={(e) => {
                        const updated = [...extraPathDirs];
                        updated[idx] = e.target.value;
                        setExtraPathDirs(updated);
                      }}
                      placeholder="/path/to/tools/bin"
                      className="flex-1 px-3 py-1.5 border exo-border-strong rounded-lg text-sm bg-[var(--exo-bg-elevated)] exo-text-primary placeholder-[var(--exo-text-muted)] font-mono"
                    />
                    <button
                      onClick={() => setExtraPathDirs(extraPathDirs.filter((_, i) => i !== idx))}
                      className="p-1.5 text-[var(--exo-text-muted)] hover:text-red-500 dark:hover:text-red-400 transition-colors"
                      title="Remove directory"
                    >
                      <svg
                        className="w-4 h-4"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2}
                          d="M6 18L18 6M6 6l12 12"
                        />
                      </svg>
                    </button>
                  </div>
                ))}

                <button
                  onClick={() => setExtraPathDirs([...extraPathDirs, ""])}
                  className="text-sm text-purple-600 dark:text-purple-400 hover:underline"
                >
                  + Add Directory
                </button>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  onClick={async () => {
                    setIsSavingPathDirs(true);
                    setPathDirsSaved(false);
                    try {
                      const validDirs = extraPathDirs.filter((d) => d.trim());
                      await window.api.settings.set({
                        extraPathDirs: validDirs.length > 0 ? validDirs : undefined,
                      });
                      queryClient.invalidateQueries({ queryKey: ["general-config"] });
                      setExtraPathDirs(validDirs);
                      setPathDirsSaved(true);
                      setTimeout(() => setPathDirsSaved(false), 2000);
                    } finally {
                      setIsSavingPathDirs(false);
                    }
                  }}
                  disabled={isSavingPathDirs}
                  className={`px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors ${
                    pathDirsSaved
                      ? "bg-green-600 dark:bg-green-500"
                      : "bg-purple-600 hover:bg-purple-700"
                  }`}
                >
                  {isSavingPathDirs ? "Saving..." : pathDirsSaved ? "Saved" : "Save"}
                </button>
              </div>
            </div>

            {/* Agent Capabilities Info */}
            <div className="exo-surface-soft p-4 rounded-lg text-sm exo-text-secondary">
              <p className="font-medium mb-2">Available agent capabilities:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <strong>Email tools:</strong> Read, search, archive, label, draft, and send emails
                </li>
                <li>
                  <strong>Analysis:</strong> Analyze emails and look up sender profiles
                </li>
                <li>
                  <strong>Web search:</strong> Search the web for context
                </li>
                <li>
                  <strong>Browser:</strong> Navigate and extract from web pages (requires Chrome
                  debugging)
                </li>
                <li>
                  <strong>Custom MCP:</strong> Any tools provided by your configured MCP servers
                </li>
                <li>
                  <strong>CLI tools:</strong> Run configured CLI commands
                </li>
                <li>
                  <strong>Batch operations:</strong> Modify labels on multiple emails at once
                </li>
              </ul>
            </div>
          </div>
        )}

        {activeTab === "extensions" && <ExtensionsTab />}

        {activeTab === "analytics" && (
          <div className="max-w-3xl space-y-6">
            <div>
              <h3 className="text-lg font-medium exo-text-primary mb-4">
                Analytics
              </h3>
              <p className="text-sm exo-text-muted mb-6">
                Help improve Exo by sharing usage data and error reports. No email content is ever
                sent.
              </p>
            </div>

            {/* Enable/Disable Toggle */}
            <div className="exo-settings-card p-6">
              <div className="flex items-center justify-between mb-6">
                <div>
                  <h4 className="text-base font-medium exo-text-primary">
                    Enable Analytics
                  </h4>
                  <p className="text-sm exo-text-muted mt-1">
                    Crash reports, app usage data, and session recordings for debugging
                  </p>
                </div>
                <button
                  onClick={() => setPosthogEnabled(!posthogEnabled)}
                  className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
                    posthogEnabled ? "bg-[var(--exo-accent)]" : "bg-[var(--exo-border-subtle)]"
                  }`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-[var(--exo-bg-elevated)] shadow-sm transition-transform ${
                      posthogEnabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* Save button */}
            <div className="flex items-center gap-3">
              <button
                onClick={async () => {
                  setIsSavingAnalytics(true);
                  setAnalyticsSaveResult(null);
                  try {
                    // Session replay is bundled with analytics — both on or both off
                    const posthogConfig = {
                      enabled: posthogEnabled,
                      sessionReplay: posthogEnabled,
                    };
                    console.log("[Settings] Saving analytics config:", posthogConfig);
                    const result = await window.api.settings.set({ posthog: posthogConfig });
                    if (result.success) {
                      // Reconfigure PostHog in the renderer with new settings
                      const apiKey = import.meta.env.VITE_POSTHOG_API_KEY;
                      const host = import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com";
                      reconfigurePostHog({
                        ...posthogConfig,
                        apiKey,
                        host,
                      });
                      console.log("[Settings] Analytics config saved and reconfigured");
                      setAnalyticsSaveResult("saved");
                      setTimeout(() => setAnalyticsSaveResult(null), 3000);
                    } else {
                      console.error("[Settings] Failed to save analytics config:", result.error);
                      setAnalyticsSaveResult("error");
                    }
                  } catch (err) {
                    console.error("[Settings] Error saving analytics config:", err);
                    setAnalyticsSaveResult("error");
                  } finally {
                    setIsSavingAnalytics(false);
                  }
                }}
                disabled={isSavingAnalytics}
                className={`px-4 py-2 text-white text-sm font-medium rounded-lg disabled:opacity-50 transition-colors ${
                  analyticsSaveResult === "saved"
                    ? "bg-green-600 dark:bg-green-500"
                    : "bg-[var(--exo-accent)] hover:bg-[var(--exo-accent-strong)]"
                }`}
              >
                {isSavingAnalytics
                  ? "Saving..."
                  : analyticsSaveResult === "saved"
                    ? "Saved!"
                    : "Save Analytics Settings"}
              </button>
              {analyticsSaveResult === "error" && (
                <span className="text-sm text-red-600 dark:text-red-400">Failed to save</span>
              )}
            </div>

            {/* Info box about what's tracked */}
            <div className="exo-surface-soft p-4 rounded-lg text-sm exo-text-secondary">
              <p className="font-medium mb-2">What we collect:</p>
              <ul className="list-disc list-inside space-y-1">
                <li>
                  <strong>Minimal by default:</strong> Only app launch and user identification are
                  sent during normal use
                </li>
                <li>
                  <strong>Error reports:</strong> When a crash occurs, recent activity context is
                  sent to help us debug
                </li>
                <li>
                  <strong>Session replay:</strong> UI recording for visual debugging — all visible
                  text content is masked
                </li>
                <li>
                  <strong>No autocapture:</strong> Individual clicks and form interactions are NOT
                  tracked
                </li>
              </ul>
            </div>

            {/* AI Usage & Costs */}
            <UsageCostSection />
          </div>
        )}
      </div>
    </div>
  );
}

// ---- Usage / Cost Tracking ----

interface UsageStats {
  today: { totalCostCents: number; totalCalls: number };
  thisWeek: { totalCostCents: number; totalCalls: number };
  thisMonth: { totalCostCents: number; totalCalls: number };
  byModel: Array<{ model: string; costCents: number; calls: number }>;
  byCaller: Array<{ caller: string; costCents: number; calls: number }>;
}

interface LlmCallRecord {
  id: string;
  created_at: string;
  model: string;
  caller: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_cents: number;
  duration_ms: number;
  success: number;
  error_message: string | null;
}

const formatCost = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function UsageCostSection() {
  const { data: statsResult } = useQuery({
    queryKey: ["usage-stats"],
    queryFn: () => window.api.usage.getStats() as Promise<{ success: boolean; data: UsageStats }>,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const { data: historyResult } = useQuery({
    queryKey: ["call-history"],
    queryFn: () =>
      window.api.usage.getCallHistory(50) as Promise<{ success: boolean; data: LlmCallRecord[] }>,
    refetchOnWindowFocus: true,
    staleTime: 30_000,
  });

  const stats = statsResult?.success ? statsResult.data : null;
  const history = historyResult?.success ? historyResult.data : null;

  return (
    <div className="space-y-6 mt-8 border-t exo-border-subtle pt-6">
      <div>
        <h3 className="text-lg font-medium exo-text-primary mb-1">
          AI Usage & Costs
        </h3>
        <p className="text-sm exo-text-muted mb-4">
          Token usage and estimated costs for Claude API calls (last 30 days).
        </p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-4">
        {(
          [
            ["Today", stats?.today],
            ["This Week", stats?.thisWeek],
            ["This Month", stats?.thisMonth],
          ] as const
        ).map(([label, bucket]) => (
          <div
            key={label}
            className="exo-settings-card p-4"
          >
            <p className="text-xs font-medium exo-text-muted uppercase tracking-wide">
              {label}
            </p>
            <p className="text-2xl font-semibold exo-text-primary mt-1">
              {formatCost(bucket?.totalCostCents ?? 0)}
            </p>
            <p className="text-sm exo-text-muted">
              {bucket?.totalCalls ?? 0} calls
            </p>
          </div>
        ))}
      </div>

      {/* Breakdown by Caller */}
      <div className="exo-settings-card p-4">
        <h4 className="text-sm font-medium exo-text-primary mb-3">By Caller</h4>
        {stats?.byCaller && stats.byCaller.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left exo-text-muted border-b exo-border-subtle">
                <th className="pb-2 font-medium">Caller</th>
                <th className="pb-2 font-medium text-right">Cost</th>
                <th className="pb-2 font-medium text-right">Calls</th>
              </tr>
            </thead>
            <tbody>
              {stats.byCaller.map((row) => (
                <tr key={row.caller} className="border-b border-[var(--exo-border-subtle)]/30/50">
                  <td className="py-1.5 exo-text-primary">{row.caller}</td>
                  <td className="py-1.5 text-right exo-text-secondary">
                    {formatCost(row.costCents)}
                  </td>
                  <td className="py-1.5 text-right exo-text-secondary">
                    {row.calls}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm exo-text-muted">No usage data yet.</p>
        )}
      </div>

      {/* Breakdown by Model */}
      <div className="exo-settings-card p-4">
        <h4 className="text-sm font-medium exo-text-primary mb-3">By Model</h4>
        {stats?.byModel && stats.byModel.length > 0 ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left exo-text-muted border-b exo-border-subtle">
                <th className="pb-2 font-medium">Model</th>
                <th className="pb-2 font-medium text-right">Cost</th>
                <th className="pb-2 font-medium text-right">Calls</th>
              </tr>
            </thead>
            <tbody>
              {stats.byModel.map((row) => (
                <tr key={row.model} className="border-b border-[var(--exo-border-subtle)]/30/50">
                  <td className="py-1.5 exo-text-primary font-mono text-xs">
                    {row.model}
                  </td>
                  <td className="py-1.5 text-right exo-text-secondary">
                    {formatCost(row.costCents)}
                  </td>
                  <td className="py-1.5 text-right exo-text-secondary">
                    {row.calls}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm exo-text-muted">No usage data yet.</p>
        )}
      </div>

      {/* Recent Calls */}
      <div className="exo-settings-card p-4">
        <h4 className="text-sm font-medium exo-text-primary mb-3">Recent Calls</h4>
        {history && history.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left exo-text-muted border-b exo-border-subtle">
                  <th className="pb-2 font-medium">Time</th>
                  <th className="pb-2 font-medium">Caller</th>
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium text-right">Tokens (in/out)</th>
                  <th className="pb-2 font-medium text-right">Cost</th>
                  <th className="pb-2 font-medium text-right">Duration</th>
                  <th className="pb-2 font-medium text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id} className="border-b border-[var(--exo-border-subtle)]/30/50">
                    <td className="py-1.5 exo-text-secondary whitespace-nowrap">
                      {new Date(row.created_at.replace(" ", "T") + "Z").toLocaleString()}
                    </td>
                    <td className="py-1.5 exo-text-primary">{row.caller}</td>
                    <td className="py-1.5 exo-text-secondary font-mono">
                      {row.model}
                    </td>
                    <td className="py-1.5 text-right exo-text-secondary">
                      {row.input_tokens.toLocaleString()} / {row.output_tokens.toLocaleString()}
                    </td>
                    <td className="py-1.5 text-right exo-text-secondary">
                      {formatCost(row.cost_cents)}
                    </td>
                    <td className="py-1.5 text-right exo-text-secondary">
                      {(row.duration_ms / 1000).toFixed(1)}s
                    </td>
                    <td className="py-1.5 text-center">
                      <span
                        className={`inline-block w-2 h-2 rounded-full ${
                          row.success ? "bg-green-500" : "bg-red-500"
                        }`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm exo-text-muted">No calls recorded yet.</p>
        )}
      </div>
    </div>
  );
}
