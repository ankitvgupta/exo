import { useState, useEffect, useCallback, useRef, startTransition } from "react";
import type { DashboardEmail } from "../../shared/types";
import type {
  ExtensionPanelInfo,
  ExtensionEnrichmentResult,
  InstalledExtensionInfo,
} from "../../shared/extension-types";
import { unregisterExtensionPanels, onRegistryChange } from "./ExtensionPanelSlot";
import { loadExtensionRenderer } from "./installed-extensions";

// Type for window.api.extensions
type ExtensionsAPI = {
  getPanels: () => Promise<{ success: boolean; data?: ExtensionPanelInfo[] }>;
  getEnrichments: (
    emailId: string,
  ) => Promise<{ success: boolean; data?: ExtensionEnrichmentResult[] }>;
  enrichEmail: (emailId: string) => Promise<{
    success: boolean;
    data?: ExtensionEnrichmentResult[];
    pending?: boolean;
    error?: string;
  }>;
  onEnrichmentReady: (
    callback: (data: { emailId: string; enrichment: ExtensionEnrichmentResult }) => void,
  ) => void;
  onInstalled: (callback: (data: InstalledExtensionInfo) => void) => () => void;
  onUninstalled: (callback: (data: { extensionId: string }) => void) => () => void;
  removeEnrichmentListeners: () => void;
};

declare global {
  interface Window {
    api: {
      extensions: ExtensionsAPI;
      [key: string]: unknown;
    };
  }
}

/**
 * Panel data with enrichment info
 */
export type ExtensionPanelData = {
  panelInfo: ExtensionPanelInfo;
  enrichment: ExtensionEnrichmentResult | null;
  isLoading: boolean;
};

/**
 * Hook to get extension panels with their enrichment data for an email
 */
export function useExtensionPanels(
  email: DashboardEmail | null,
  _threadEmails: DashboardEmail[],
): {
  panels: ExtensionPanelData[];
  isLoading: boolean;
  refresh: () => Promise<void>;
} {
  const [panels, setPanels] = useState<ExtensionPanelInfo[]>([]);
  const [enrichments, setEnrichments] = useState<Map<string, ExtensionEnrichmentResult>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [loadingPanels, setLoadingPanels] = useState<Set<string>>(new Set());

  // Track current email ID with a ref to prevent stale closures
  const currentEmailIdRef = useRef<string | null>(null);
  // Track safety timeout so it can be cancelled on cleanup/navigation
  const safetyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update ref when email changes
  useEffect(() => {
    currentEmailIdRef.current = email?.id ?? null;
  }, [email?.id]);

  // Load available panels on mount and when extensions change
  const [extensionVersion, setExtensionVersion] = useState(0);

  useEffect(() => {
    const loadPanels = async () => {
      try {
        const result = await window.api.extensions.getPanels();
        if (result.success && result.data) {
          setPanels(result.data);
        }
      } catch (error) {
        console.error("[Extensions] Failed to load panels:", error);
      }
    };
    loadPanels();
  }, [extensionVersion]);

  // Re-render when panel components are registered/unregistered.
  // This handles: startup async loading, mid-session install, uninstall.
  useEffect(() => {
    return onRegistryChange(() => {
      setExtensionVersion((v) => v + 1);
    });
  }, []);

  // Load renderer bundle on install; unregister components on uninstall.
  // The registry change listener above handles the re-render.
  useEffect(() => {
    const removeInstalled = window.api.extensions.onInstalled(
      async (data: InstalledExtensionInfo) => {
        if (data.hasRenderer) {
          await loadExtensionRenderer(data.id);
        }
      },
    );
    const removeUninstalled = window.api.extensions.onUninstalled(
      (data: { extensionId: string }) => {
        unregisterExtensionPanels(data.extensionId);
      },
    );
    return () => {
      removeInstalled();
      removeUninstalled();
    };
  }, []);

  // Load enrichments when email changes (debounced to avoid blocking j/k navigation)
  useEffect(() => {
    if (!email) {
      setEnrichments(new Map());
      return;
    }

    const emailId = email.id;

    const loadEnrichments = async () => {
      // Use startTransition to mark these updates as non-urgent
      // This prevents sidebar loading from blocking keyboard navigation
      startTransition(() => {
        setIsLoading(true);
        setLoadingPanels(new Set(panels.map((p) => `${p.extensionId}:${p.id}`)));
      });

      // When enrichment is pending (async background lookup), don't clear
      // loading state in finally — the enrichment-ready handler will do it.
      let keepLoading = false;

      try {
        // First get cached enrichments
        const cachedResult = await window.api.extensions.getEnrichments(emailId);

        // Check if we're still on the same email before updating state
        if (currentEmailIdRef.current !== emailId) {
          return; // User switched to a different email, ignore this result
        }

        if (cachedResult.success && cachedResult.data) {
          const enrichmentMap = new Map<string, ExtensionEnrichmentResult>();
          for (const enrichment of cachedResult.data) {
            const key = `${enrichment.extensionId}:${enrichment.panelId}`;
            enrichmentMap.set(key, enrichment);
          }

          startTransition(() => {
            setEnrichments(enrichmentMap);

            // Remove panels that have cached data from loading set
            const stillLoading = new Set<string>();
            for (const panel of panels) {
              const key = `${panel.extensionId}:${panel.id}`;
              if (!enrichmentMap.has(key)) {
                stillLoading.add(key);
              }
            }
            setLoadingPanels(stillLoading);

            // If all panels have cached data, skip enrichment call
            if (stillLoading.size === 0) {
              setIsLoading(false);
            }
          });

          if (panels.length > 0 && [...enrichmentMap.keys()].length >= panels.length) {
            return; // All cached, skip enrichment
          }
        }

        // Then trigger enrichment for panels without cached data
        const enrichResult = await window.api.extensions.enrichEmail(emailId);

        // Check again if we're still on the same email
        if (currentEmailIdRef.current !== emailId) {
          return; // User switched to a different email, ignore this result
        }

        const enrichData = enrichResult.success ? enrichResult.data : undefined;
        if (enrichData) {
          startTransition(() => {
            setEnrichments((prev) => {
              const newMap = new Map(prev);
              for (const enrichment of enrichData) {
                const key = `${enrichment.extensionId}:${enrichment.panelId}`;
                newMap.set(key, enrichment);
              }
              return newMap;
            });
          });
        }

        // If enrichment is pending (async lookup in progress), keep panels
        // without data in loading state — results arrive via enrichment-ready event.
        if (enrichResult.pending) {
          keepLoading = true;
          // Safety timeout: if enrichment-ready never arrives (e.g. provider
          // throws without notifying), clear loading state after 15s.
          // Tracked in a ref so it can be cancelled on navigation/cleanup.
          if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
          safetyTimeoutRef.current = setTimeout(() => {
            safetyTimeoutRef.current = null;
            if (currentEmailIdRef.current === emailId) {
              startTransition(() => {
                setIsLoading(false);
                setLoadingPanels(new Set());
              });
            }
          }, 15_000);
        }
      } catch (error) {
        console.error("[Extensions] Failed to load enrichments:", error);
      } finally {
        // Only clear loading state if we're still on the same email
        // and no async enrichment is pending
        if (currentEmailIdRef.current === emailId && !keepLoading) {
          startTransition(() => {
            setIsLoading(false);
            setLoadingPanels(new Set());
          });
        }
      }
    };

    // Debounce to avoid blocking rapid j/k navigation
    const timeoutId = setTimeout(loadEnrichments, 150);
    return () => {
      clearTimeout(timeoutId);
      if (safetyTimeoutRef.current) {
        clearTimeout(safetyTimeoutRef.current);
        safetyTimeoutRef.current = null;
      }
    };
  }, [email?.id, panels]);

  // Listen for enrichment updates
  useEffect(() => {
    if (!email) return;

    const handleEnrichmentReady = (data: {
      emailId: string;
      enrichment: ExtensionEnrichmentResult;
    }) => {
      // Use the ref to get the current email ID (avoids stale closure)
      if (data.emailId === currentEmailIdRef.current) {
        // Use startTransition to avoid blocking keyboard navigation
        startTransition(() => {
          setEnrichments((prev) => {
            const newMap = new Map(prev);
            const key = `${data.enrichment.extensionId}:${data.enrichment.panelId}`;
            newMap.set(key, data.enrichment);
            return newMap;
          });
          setLoadingPanels((prev) => {
            const newSet = new Set(prev);
            const key = `${data.enrichment.extensionId}:${data.enrichment.panelId}`;
            newSet.delete(key);
            // When all panels have received data, clear global loading too
            if (newSet.size === 0) {
              setIsLoading(false);
            }
            return newSet;
          });
        });
      }
    };

    window.api.extensions.onEnrichmentReady(handleEnrichmentReady);

    return () => {
      // Only remove enrichment listeners — not install/uninstall listeners
      // which are registered in a separate useEffect with [] deps.
      window.api.extensions.removeEnrichmentListeners();
    };
  }, [email?.id]);

  // Build panel data with enrichments
  const panelData: ExtensionPanelData[] = panels.map((panel) => {
    const key = `${panel.extensionId}:${panel.id}`;
    return {
      panelInfo: panel,
      enrichment: enrichments.get(key) ?? null,
      isLoading: loadingPanels.has(key),
    };
  });

  // Refresh function
  const refresh = useCallback(async () => {
    if (!email) return;

    const emailId = email.id;
    let keepLoading = false;
    startTransition(() => {
      setIsLoading(true);
      setLoadingPanels(new Set(panels.map((p) => `${p.extensionId}:${p.id}`)));
    });

    try {
      const enrichResult = await window.api.extensions.enrichEmail(emailId);

      // Check if still on the same email
      if (currentEmailIdRef.current !== emailId) return;

      const enrichData = enrichResult.success ? enrichResult.data : undefined;
      if (enrichData) {
        startTransition(() => {
          setEnrichments((prev) => {
            const newMap = new Map(prev);
            for (const enrichment of enrichData) {
              const key = `${enrichment.extensionId}:${enrichment.panelId}`;
              newMap.set(key, enrichment);
            }
            return newMap;
          });
        });
      }

      if (enrichResult.pending) {
        keepLoading = true;
        if (safetyTimeoutRef.current) clearTimeout(safetyTimeoutRef.current);
        safetyTimeoutRef.current = setTimeout(() => {
          safetyTimeoutRef.current = null;
          if (currentEmailIdRef.current === emailId) {
            startTransition(() => {
              setIsLoading(false);
              setLoadingPanels(new Set());
            });
          }
        }, 15_000);
      }
    } catch (error) {
      console.error("[Extensions] Failed to refresh enrichments:", error);
    } finally {
      if (currentEmailIdRef.current === emailId && !keepLoading) {
        startTransition(() => {
          setIsLoading(false);
          setLoadingPanels(new Set());
        });
      }
    }
  }, [email?.id, panels]);

  return {
    panels: panelData,
    isLoading,
    refresh,
  };
}

/**
 * Hook for badges (future use)
 */
export function useExtensionBadges(_email: DashboardEmail | null): {
  badges: Array<{ id: string; label: string; color?: string }>;
} {
  // TODO: Implement badge fetching from enrichments
  return { badges: [] };
}
