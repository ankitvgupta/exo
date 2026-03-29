import { useState, useEffect, useCallback } from "react";
import type { InstalledExtensionInfo, ExtensionManifest, SettingDefinition } from "../../shared/extension-types";
import { loadExtensionRenderer } from "../extensions/installed-extensions";
// useStore not needed — OpenClaw config uses window.api.settings directly

interface ExtensionListResult {
  success: boolean;
  data?: InstalledExtensionInfo[];
}

/**
 * Extensions management tab in Settings.
 * Shows bundled and installed extensions, with install/uninstall controls.
 */
export function ExtensionsTab() {
  const [installedExtensions, setInstalledExtensions] = useState<InstalledExtensionInfo[]>([]);
  const [bundledExtensions, setBundledExtensions] = useState<ExtensionManifest[]>([]);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installSuccess, setInstallSuccess] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);
  const [confirmUninstall, setConfirmUninstall] = useState<{ id: string; displayName: string } | null>(null);
  const [healthStatuses, setHealthStatuses] = useState<Record<string, { status: string; message?: string }>>({});
  const [providerSettings, setProviderSettings] = useState<Record<string, Record<string, unknown>>>({});
  const [savingSettings, setSavingSettings] = useState<string | null>(null);
  const [settingsSaveMessage, setSettingsSaveMessage] = useState<{ id: string; type: "success" | "error"; text: string } | null>(null);
  const [retryingProvider, setRetryingProvider] = useState<string | null>(null);

  // OpenClaw agent provider settings
  const [openclawEnabled, setOpenclawEnabled] = useState(false);
  const [openclawGatewayUrl, setOpenclawGatewayUrl] = useState("");
  const [openclawGatewayToken, setOpenclawGatewayToken] = useState("");
  const [openclawTestResult, setOpenclawTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [openclawTesting, setOpenclawTesting] = useState(false);

  const loadExtensions = useCallback(async () => {
    try {
      const [installedResult, allResult] = await Promise.all([
        window.api.extensions.listInstalled() as Promise<ExtensionListResult>,
        window.api.extensions.list() as Promise<ExtensionManifest[]>,
      ]);

      if (installedResult.success && installedResult.data) {
        setInstalledExtensions(installedResult.data);
      }

      // All extensions includes both bundled and installed
      if (Array.isArray(allResult)) {
        setBundledExtensions(allResult.filter((ext: ExtensionManifest) => ext.builtIn));
      }
    } catch (error) {
      console.error("[ExtensionsTab] Failed to load extensions:", error);
    }
  }, []);

  const checkAllProviderHealth = useCallback(async () => {
    for (const ext of installedExtensions) {
      if (ext.hasAgentProvider) {
        try {
          const result = await window.api.extensions.checkProviderHealth(ext.id) as {
            success: boolean;
            data?: { status: string; message?: string };
          };
          if (result.success && result.data) {
            setHealthStatuses(prev => ({ ...prev, [ext.id]: result.data! }));
          }
        } catch { /* ignore */ }
      }
    }
  }, [installedExtensions]);

  const loadProviderSettings = useCallback(async (ext: InstalledExtensionInfo) => {
    if (!ext.agentProviderManifest?.contributes?.settings) return;
    const settingIds = ext.agentProviderManifest.contributes.settings.map((s: SettingDefinition) => s.id);
    try {
      const result = await window.api.extensions.getProviderSettings(ext.id, settingIds) as {
        success: boolean;
        data?: Record<string, unknown>;
      };
      if (result.success && result.data) {
        setProviderSettings(prev => ({ ...prev, [ext.id]: result.data! }));
      }
    } catch { /* ignore */ }
  }, []);

  const handleSaveSettings = async (extensionId: string) => {
    setSavingSettings(extensionId);
    setSettingsSaveMessage(null);
    try {
      const settings = providerSettings[extensionId] ?? {};
      const result = await window.api.extensions.saveProviderSettings(extensionId, settings) as {
        success: boolean;
        error?: string;
      };
      if (result.success) {
        setSettingsSaveMessage({ id: extensionId, type: "success", text: "Settings saved" });
        // Re-check health after saving
        const healthResult = await window.api.extensions.checkProviderHealth(extensionId) as {
          success: boolean;
          data?: { status: string; message?: string };
        };
        if (healthResult.success && healthResult.data) {
          setHealthStatuses(prev => ({ ...prev, [extensionId]: healthResult.data! }));
        }
      } else {
        setSettingsSaveMessage({ id: extensionId, type: "error", text: result.error ?? "Save failed" });
      }
    } catch (error) {
      setSettingsSaveMessage({ id: extensionId, type: "error", text: error instanceof Error ? error.message : "Save failed" });
    } finally {
      setSavingSettings(null);
    }
  };

  const handleRetryProvider = async (extensionId: string) => {
    setRetryingProvider(extensionId);
    try {
      // Re-install triggers reload — for now just re-check health
      const result = await window.api.extensions.checkProviderHealth(extensionId) as {
        success: boolean;
        data?: { status: string; message?: string };
      };
      if (result.success && result.data) {
        setHealthStatuses(prev => ({ ...prev, [extensionId]: result.data! }));
      }
    } finally {
      setRetryingProvider(null);
    }
  };

  useEffect(() => {
    checkAllProviderHealth();
    for (const ext of installedExtensions) {
      if (ext.agentProviderManifest?.contributes?.settings) {
        loadProviderSettings(ext);
      }
    }
  }, [installedExtensions, checkAllProviderHealth, loadProviderSettings]);

  useEffect(() => {
    loadExtensions();

    // Listen for install/uninstall events
    const removeInstalled = window.api.extensions.onInstalled(async (data: Record<string, unknown>) => {
      if (data.hasRenderer && typeof data.id === "string") {
        await loadExtensionRenderer(data.id);
      }
      loadExtensions();
    });
    const removeUninstalled = window.api.extensions.onUninstalled(() => {
      loadExtensions();
    });

    return () => {
      removeInstalled();
      removeUninstalled();
    };
  }, [loadExtensions]);

  // Load OpenClaw config from app settings
  useEffect(() => {
    (async () => {
      const result = await window.api.settings.get() as { success: boolean; data?: Record<string, unknown> };
      const config = result.data ?? result as Record<string, unknown>;
      const oc = config.openclaw as Record<string, unknown> | undefined;
      if (oc) {
        setOpenclawEnabled(Boolean(oc.enabled));
        setOpenclawGatewayUrl(String(oc.gatewayUrl ?? ""));
        setOpenclawGatewayToken(String(oc.gatewayToken ?? ""));
      }
    })();
  }, []);

  const handleInstall = async () => {
    setIsInstalling(true);
    setInstallError(null);
    setInstallSuccess(null);

    try {
      const result = await window.api.extensions.install() as {
        success: boolean;
        data?: InstalledExtensionInfo;
        error?: string;
      };

      if (result.success && result.data) {
        setInstallSuccess(`Installed "${result.data.displayName}" v${result.data.version}`);
        // Load renderer bundle so sidebar panels register immediately
        if (result.data.hasRenderer) {
          await loadExtensionRenderer(result.data.id);
        }
        await loadExtensions();
      } else if (result.error && result.error !== "Installation cancelled") {
        setInstallError(result.error);
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setIsInstalling(false);
    }
  };

  const handleUninstall = async (extensionId: string) => {
    setConfirmUninstall(null);
    setUninstallingId(extensionId);
    try {
      const result = await window.api.extensions.uninstall(extensionId) as {
        success: boolean;
        error?: string;
      };

      if (result.success) {
        await loadExtensions();
      } else {
        setInstallError(result.error ?? "Failed to uninstall");
      }
    } catch (error) {
      setInstallError(error instanceof Error ? error.message : "Unknown error");
    } finally {
      setUninstallingId(null);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Extensions</h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Manage installed extensions that add functionality to Exo.
          </p>
        </div>
        <button
          onClick={handleInstall}
          disabled={isInstalling}
          className="px-4 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 hover:bg-blue-700 dark:hover:bg-blue-600 rounded-lg transition-colors disabled:opacity-50"
        >
          {isInstalling ? "Installing..." : "Install Extension"}
        </button>
      </div>

      {/* Status messages */}
      {installError && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg text-sm text-red-700 dark:text-red-300">
          {installError}
        </div>
      )}
      {installSuccess && (
        <div className="p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg text-sm text-green-700 dark:text-green-300">
          {installSuccess}
        </div>
      )}

      {/* Installed extensions */}
      {installedExtensions.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">
            Installed
          </h3>
          <div className="space-y-3">
            {installedExtensions.map((ext) => (
              <div
                key={ext.id}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 p-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                        {ext.displayName}
                      </h4>
                      <span className="text-xs text-gray-400 dark:text-gray-500">
                        v{ext.version}
                      </span>
                      {ext.isActive ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400">
                          Inactive
                        </span>
                      )}
                      {ext.hasAgentProvider && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400">
                          Agent Provider
                        </span>
                      )}
                      {!ext.hasAgentProvider && (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
                          Extension
                        </span>
                      )}
                    </div>
                    {ext.description && (
                      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        {ext.description}
                      </p>
                    )}
                    {ext.hasAgentProvider && healthStatuses[ext.id] && (
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className={`inline-block w-2 h-2 rounded-full ${
                          healthStatuses[ext.id].status === "connected" ? "bg-green-500" :
                          healthStatuses[ext.id].status === "not_configured" ? "bg-yellow-500" :
                          "bg-red-500"
                        }`} />
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {healthStatuses[ext.id].status === "connected" ? "Connected" :
                           healthStatuses[ext.id].status === "not_configured" ? "Not configured" :
                           `Error${healthStatuses[ext.id].message ? `: ${healthStatuses[ext.id].message}` : ""}`}
                        </span>
                      </div>
                    )}
                    {ext.loadError && (
                      <div className="mt-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-xs text-red-700 dark:text-red-300 flex items-center justify-between">
                        <span>Load error: {ext.loadError}</span>
                        <button
                          onClick={() => handleRetryProvider(ext.id)}
                          disabled={retryingProvider === ext.id}
                          className="ml-2 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-900/40 hover:bg-red-200 dark:hover:bg-red-900/60 rounded transition-colors disabled:opacity-50"
                        >
                          {retryingProvider === ext.id ? "Retrying..." : "Retry"}
                        </button>
                      </div>
                    )}
                    {ext.agentProviderManifest?.contributes?.settings && (
                      <div className="mt-3 border-t border-gray-200 dark:border-gray-600 pt-3">
                        <h5 className="text-xs font-semibold text-gray-600 dark:text-gray-400 uppercase tracking-wide mb-2">
                          Provider Settings
                        </h5>
                        <div className="space-y-2">
                          {ext.agentProviderManifest.contributes.settings.map((setting: SettingDefinition) => (
                            <div key={setting.id}>
                              <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-0.5">
                                {setting.title}
                                {setting.required && <span className="text-red-500 ml-0.5">*</span>}
                              </label>
                              {setting.description && (
                                <p className="text-xs text-gray-400 dark:text-gray-500 mb-1">{setting.description}</p>
                              )}
                              {setting.type === "boolean" ? (
                                <input
                                  type="checkbox"
                                  checked={!!providerSettings[ext.id]?.[setting.id]}
                                  onChange={(e) => setProviderSettings(prev => ({
                                    ...prev,
                                    [ext.id]: { ...prev[ext.id], [setting.id]: e.target.checked },
                                  }))}
                                  className="rounded border-gray-300 dark:border-gray-600"
                                />
                              ) : (
                                <input
                                  type={setting.sensitive ? "password" : setting.type === "number" ? "number" : "text"}
                                  value={String(providerSettings[ext.id]?.[setting.id] ?? setting.default ?? "")}
                                  placeholder={setting.placeholder}
                                  onChange={(e) => setProviderSettings(prev => ({
                                    ...prev,
                                    [ext.id]: {
                                      ...prev[ext.id],
                                      [setting.id]: setting.type === "number" ? Number(e.target.value) : e.target.value,
                                    },
                                  }))}
                                  className="w-full px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                                />
                              )}
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center gap-2 mt-2">
                          <button
                            onClick={() => handleSaveSettings(ext.id)}
                            disabled={savingSettings === ext.id}
                            className="px-3 py-1 text-xs font-medium text-white bg-blue-600 dark:bg-blue-500 hover:bg-blue-700 dark:hover:bg-blue-600 rounded transition-colors disabled:opacity-50"
                          >
                            {savingSettings === ext.id ? "Saving..." : "Save"}
                          </button>
                          {settingsSaveMessage?.id === ext.id && (
                            <span className={`text-xs ${settingsSaveMessage.type === "success" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                              {settingsSaveMessage.text}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                  {confirmUninstall?.id === ext.id ? (
                    <div className="ml-4 flex items-center gap-2">
                      <button
                        onClick={() => handleUninstall(ext.id)}
                        className="px-3 py-1.5 text-xs font-medium text-white bg-red-600 dark:bg-red-500 hover:bg-red-700 dark:hover:bg-red-600 rounded-lg transition-colors"
                      >
                        Confirm
                      </button>
                      <button
                        onClick={() => setConfirmUninstall(null)}
                        className="px-3 py-1.5 text-xs font-medium text-gray-600 dark:text-gray-400 bg-gray-100 dark:bg-gray-700 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setConfirmUninstall({ id: ext.id, displayName: ext.displayName })}
                      disabled={uninstallingId === ext.id}
                      className="ml-4 px-3 py-1.5 text-xs font-medium text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 rounded-lg transition-colors disabled:opacity-50"
                    >
                      {uninstallingId === ext.id ? "Removing..." : "Uninstall"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Bundled extensions */}
      <div>
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide mb-3">
          Built-in
        </h3>
        <div className="space-y-3">
          {bundledExtensions.map((ext) => (
            <div
              key={ext.id}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 p-4"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium text-gray-900 dark:text-gray-100">
                      {ext.displayName}
                    </h4>
                    <span className="text-xs text-gray-400 dark:text-gray-500">
                      v{ext.version}
                    </span>
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400">
                      Built-in
                    </span>
                  </div>
                  {ext.description && (
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                      {ext.description}
                    </p>
                  )}
                </div>
              </div>
            </div>
          ))}
          {bundledExtensions.length === 0 && (
            <p className="text-sm text-gray-500 dark:text-gray-400 italic">Loading...</p>
          )}
        </div>
      </div>

      {/* OpenClaw Agent Provider */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-600 p-6">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="text-base font-medium text-gray-900 dark:text-gray-100">OpenClaw Agent</h4>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
              Connect a local or remote OpenClaw agent for richer context during email drafting.
            </p>
          </div>
          <label className="relative inline-flex items-center cursor-pointer">
            <input
              type="checkbox"
              className="sr-only peer"
              checked={openclawEnabled}
              onChange={async (e) => {
                const val = e.target.checked;
                setOpenclawEnabled(val);
                await window.api.settings.set({ openclaw: { enabled: val, gatewayUrl: openclawGatewayUrl, gatewayToken: openclawGatewayToken } });
              }}
            />
            <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-blue-500 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:after:border-gray-600 peer-checked:bg-blue-600" />
          </label>
        </div>

        {openclawEnabled && (
          <div className="space-y-3 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Gateway URL <span className="text-gray-400 font-normal">(optional — blank = local)</span>
              </label>
              <input
                type="text"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400"
                placeholder="ws://192.168.1.50:18789"
                value={openclawGatewayUrl}
                onChange={(e) => setOpenclawGatewayUrl(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Gateway Token <span className="text-gray-400 font-normal">(optional)</span>
              </label>
              <input
                type="password"
                className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400"
                placeholder="Bearer token"
                value={openclawGatewayToken}
                onChange={(e) => setOpenclawGatewayToken(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 disabled:opacity-50 transition-colors"
                disabled={openclawTesting}
                onClick={async () => {
                  // Save first, then test
                  await window.api.settings.set({ openclaw: { enabled: openclawEnabled, gatewayUrl: openclawGatewayUrl, gatewayToken: openclawGatewayToken } });
                  setOpenclawTesting(true);
                  setOpenclawTestResult(null);
                  const result = await window.api.settings.testOpenclawConnection() as { success: boolean; error?: string };
                  setOpenclawTestResult(result);
                  setOpenclawTesting(false);
                }}
              >
                {openclawTesting ? "Testing..." : "Test Connection"}
              </button>

              <button
                className="px-4 py-2 text-sm font-medium text-white bg-blue-600 dark:bg-blue-500 rounded-lg hover:bg-blue-700 dark:hover:bg-blue-600 transition-colors"
                onClick={async () => {
                  await window.api.settings.set({ openclaw: { enabled: openclawEnabled, gatewayUrl: openclawGatewayUrl, gatewayToken: openclawGatewayToken } });
                }}
              >
                Save
              </button>

              {openclawTestResult && (
                <span className={`text-sm ${openclawTestResult.success ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                  {openclawTestResult.success ? "✓ Connected" : openclawTestResult.error ?? "Connection failed"}
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Info box */}
      <div className="bg-gray-50 dark:bg-gray-800/50 p-4 rounded-lg text-sm text-gray-700 dark:text-gray-300">
        <p className="font-medium mb-2">Installing extensions</p>
        <p>
          Extensions are distributed as <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">.zip</code> files.
          Click "Install Extension" to select a file and install it. Packages can add sidebar panels,
          email enrichment providers, and agent providers.
        </p>
        <p className="mt-2 text-gray-500 dark:text-gray-400">
          To build an extension, run: <code className="bg-gray-100 dark:bg-gray-700 px-1 rounded">node scripts/build-extension.mjs &lt;extension-dir&gt;</code>
        </p>
      </div>
    </div>
  );
}
