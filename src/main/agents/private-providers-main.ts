import type { AgentFrameworkConfig } from "./types";
import { createLogger } from "../services/logger";

const log = createLogger("private-providers");

export type MainSetup = {
  populateConfig?: (config: AgentFrameworkConfig) => Promise<AgentFrameworkConfig>;
  openAuthWindow?: () => Promise<boolean>;
  checkAuth?: () => Promise<boolean>;
  displayName?: string;
};

const modules = import.meta.glob("../../agents-private/*/main-setup.ts", { eager: true }) as Record<
  string,
  MainSetup
>;

/**
 * Build a map of providerId → auth function from discovered private providers.
 * The provider ID is derived from the directory name (e.g. "my-agent" from agents-private/my-agent/).
 */
const authHandlers = new Map<string, () => Promise<boolean>>();
const authCheckers = new Map<string, () => Promise<boolean>>();
const providerDisplayNames = new Map<string, string>();
const installedConfigEnrichers = new Map<
  string,
  (config: AgentFrameworkConfig) => Promise<AgentFrameworkConfig>
>();

for (const [path, mod] of Object.entries(modules)) {
  // Extract directory name: "../../agents-private/my-agent/main-setup.ts" → "my-agent"
  const match = path.match(/agents-private\/([^/]+)\//);
  if (!match) continue;
  const id = match[1];

  if (mod.openAuthWindow) {
    authHandlers.set(id, mod.openAuthWindow);
  }
  if (mod.checkAuth) {
    authCheckers.set(id, mod.checkAuth);
  }
  if (mod.displayName) {
    providerDisplayNames.set(id, mod.displayName);
  }
}

export async function populatePrivateProviderConfig(
  config: AgentFrameworkConfig,
): Promise<AgentFrameworkConfig> {
  let enriched = config;
  for (const [modulePath, mod] of Object.entries(modules)) {
    if (mod.populateConfig) {
      try {
        enriched = await mod.populateConfig(enriched);
      } catch (err) {
        log.warn({ err: err }, `[PrivateProviders] Config enrichment failed for ${modulePath}`);
      }
    }
  }

  // Also run config enrichers from installed providers
  for (const [id, enricher] of installedConfigEnrichers) {
    try {
      enriched = await enricher(enriched);
    } catch (err) {
      log.warn(
        { err: err },
        `[PrivateProviders] Config enrichment failed for installed provider ${id}`,
      );
    }
  }

  return enriched;
}

/**
 * Open an auth window for a specific private provider.
 * Returns true if auth succeeded, false otherwise.
 */
export async function authenticateProvider(providerId: string): Promise<boolean> {
  const handler = authHandlers.get(providerId);
  if (!handler) {
    throw new Error(`No auth handler for provider: ${providerId}`);
  }
  return handler();
}

/**
 * Query all agent providers that have auth handlers and check their current status.
 * Used by the onboarding flow to show login buttons for services needing auth.
 */
export async function getProvidersNeedingAuth(): Promise<
  Array<{ providerId: string; displayName: string; needsAuth: boolean }>
> {
  const results: Array<{ providerId: string; displayName: string; needsAuth: boolean }> = [];
  for (const [id] of authHandlers) {
    const checker = authCheckers.get(id);
    // Skip providers without checkAuth — we can't determine their auth state
    if (!checker) continue;
    const name = providerDisplayNames.get(id) || id;
    let needsAuth = true;
    try {
      needsAuth = !(await checker());
    } catch (error) {
      log.error({ err: error }, `[PrivateProviders] checkAuth failed for ${id}`);
    }
    results.push({ providerId: id, displayName: name, needsAuth });
  }
  return results;
}

/**
 * Register auth/config handlers for an installed (non-bundled) agent provider.
 * Called by ExtensionHost when loading a provider's main-setup.js.
 */
export function registerProviderAuth(id: string, setup: MainSetup): void {
  if (setup.openAuthWindow) {
    authHandlers.set(id, setup.openAuthWindow);
  }
  if (setup.checkAuth) {
    authCheckers.set(id, setup.checkAuth);
  }
  if (setup.displayName) {
    providerDisplayNames.set(id, setup.displayName);
  }
  if (setup.populateConfig) {
    installedConfigEnrichers.set(id, setup.populateConfig);
  }
  log.info(`[PrivateProviders] Registered installed provider auth: ${id}`);
}

/**
 * Unregister auth/config handlers for an installed provider.
 * Called by ExtensionHost when uninstalling a provider.
 */
export function unregisterProviderAuth(id: string): void {
  authHandlers.delete(id);
  authCheckers.delete(id);
  providerDisplayNames.delete(id);
  installedConfigEnrichers.delete(id);
  log.info(`[PrivateProviders] Unregistered installed provider auth: ${id}`);
}
