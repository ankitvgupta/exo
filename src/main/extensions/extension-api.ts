import type {
  ExtensionAPI,
  EnrichmentProvider,
  BadgeProvider,
} from "../../shared/extension-types";
import { getExtensionStorage, setExtensionStorage } from "../db";

// Registries for providers (managed by extension-host)
let enrichmentProviderRegistry: Map<string, EnrichmentProvider> = new Map();
let badgeProviderRegistry: Map<string, BadgeProvider> = new Map();

// Callback for extension auth required events (set by extension-host)
let authRequiredCallback: ((extensionId: string, displayName: string, message?: string) => void) | null = null;

// Extension display names (populated during registration)
const extensionDisplayNames: Map<string, string> = new Map();

// Auth handlers registered by extensions (extensionId -> { handler, checkAuth? })
const authHandlers: Map<string, { handler: () => Promise<void>; checkAuth?: () => Promise<boolean> }> = new Map();

/**
 * Set the callback for extension auth required events
 */
export function setAuthRequiredCallback(
  callback: (extensionId: string, displayName: string, message?: string) => void
): void {
  authRequiredCallback = callback;
}

/**
 * Register an extension's display name (called during extension loading)
 */
export function registerExtensionDisplayName(extensionId: string, displayName: string): void {
  extensionDisplayNames.set(extensionId, displayName);
}

/**
 * Set the registries (called by extension-host during initialization)
 */
export function setRegistries(
  enrichmentProviders: Map<string, EnrichmentProvider>,
  badgeProviders: Map<string, BadgeProvider>
): void {
  enrichmentProviderRegistry = enrichmentProviders;
  badgeProviderRegistry = badgeProviders;
}

/**
 * Create ExtensionAPI for a specific extension
 */
export function createExtensionAPI(extensionId: string): ExtensionAPI {
  return {
    registerEnrichmentProvider(provider: EnrichmentProvider): void {
      const fullId = `${extensionId}:${provider.id}`;
      console.log(`[Extensions] Registered enrichment provider: ${fullId}`);
      enrichmentProviderRegistry.set(fullId, {
        ...provider,
        id: fullId,
      });
    },

    registerBadgeProvider(provider: BadgeProvider): void {
      const fullId = `${extensionId}:${provider.id}`;
      console.log(`[Extensions] Registered badge provider: ${fullId}`);
      badgeProviderRegistry.set(fullId, {
        ...provider,
        id: fullId,
      });
    },

    async getSetting<T>(key: string): Promise<T> {
      const fullKey = `setting:${key}`;
      const value = getExtensionStorage(extensionId, fullKey);
      if (value === null) {
        throw new Error(`Setting ${key} not found`);
      }
      return JSON.parse(value) as T;
    },

    async setSetting<T>(key: string, value: T): Promise<void> {
      const fullKey = `setting:${key}`;
      setExtensionStorage(extensionId, fullKey, JSON.stringify(value));
    },

    emitAuthRequired(message?: string): void {
      const displayName = extensionDisplayNames.get(extensionId) || extensionId;
      console.log(`[Extensions] Auth required for ${displayName}: ${message || "(no message)"}`);
      authRequiredCallback?.(extensionId, displayName, message);
    },

    registerAuthHandler(handler: () => Promise<void>, options?: { checkAuth?: () => Promise<boolean> }): void {
      console.log(`[Extensions] Registered auth handler for ${extensionId}`);
      authHandlers.set(extensionId, { handler, checkAuth: options?.checkAuth });
    },
  };
}

/**
 * Get the registered auth handler for an extension
 */
export function getAuthHandler(extensionId: string): (() => Promise<void>) | null {
  const entry = authHandlers.get(extensionId);
  return entry?.handler ?? null;
}

/**
 * Get all extensions that have registered auth handlers.
 * Returns their extensionId and display name.
 */
export function getAuthExtensions(): Array<{ extensionId: string; displayName: string }> {
  const results: Array<{ extensionId: string; displayName: string }> = [];
  for (const extensionId of authHandlers.keys()) {
    const displayName = extensionDisplayNames.get(extensionId) || extensionId;
    results.push({ extensionId, displayName });
  }
  return results;
}

/**
 * Check whether an extension registered a checkAuth callback.
 */
export function hasCheckAuth(extensionId: string): boolean {
  return !!authHandlers.get(extensionId)?.checkAuth;
}

/**
 * Check if an extension is already authenticated.
 * Calls the checkAuth function if the extension provided one.
 * Returns false if no checker is available (assume needs auth).
 */
export async function checkExtensionAuth(extensionId: string): Promise<boolean> {
  const entry = authHandlers.get(extensionId);
  if (!entry?.checkAuth) return false;
  try {
    return await entry.checkAuth();
  } catch (error) {
    console.error(`[Extensions] checkAuth failed for ${extensionId}:`, error);
    return false;
  }
}
