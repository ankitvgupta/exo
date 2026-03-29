import { z } from "zod";
import semver from "semver";
import type { DashboardEmail } from "./types";

// =============================================================================
// Extension API Version
// =============================================================================
// Bump this integer when you make breaking changes to:
// - ExtensionAPI, ExtensionContext, ExtensionModule interfaces
// - EnrichmentProvider, BadgeProvider interfaces
// - SidebarPanelProps shape
// - AgentProvider interfaces
// Do NOT bump for: UI changes, internal refactors, new features that don't
// touch the extension surface, or adding optional fields to existing interfaces.
export const EXTENSION_API_VERSION = 1;

// =============================================================================
// Extension Manifest Schema (read from package.json's "mailExtension" field)
// =============================================================================

export const SidebarPanelContributionSchema = z.object({
  id: z.string(),
  title: z.string(),
  priority: z.number().default(50), // Higher = shows first
  scope: z.enum(["sender", "email"]).default("sender"), // "sender" = needs sender info only, "email" = needs full email body
});

export type SidebarPanelContribution = z.infer<typeof SidebarPanelContributionSchema>;

export const SettingDefinitionSchema = z.object({
  id: z.string(),
  type: z.enum(["boolean", "string", "number"]),
  default: z.union([z.boolean(), z.string(), z.number()]),
  title: z.string(),
  description: z.string().optional(),
  required: z.boolean().optional(),
  placeholder: z.string().optional(),
  sensitive: z.boolean().optional(),
});

export type SettingDefinition = z.infer<typeof SettingDefinitionSchema>;

export const ExtensionContributesSchema = z.object({
  sidebarPanels: z.array(SidebarPanelContributionSchema).optional(),
  settings: z.array(SettingDefinitionSchema).optional(),
});

export type ExtensionContributes = z.infer<typeof ExtensionContributesSchema>;

export const EnginesSchema = z.object({
  mailClient: z.string().default(">=1"), // semver range against EXTENSION_API_VERSION
});

export type Engines = z.infer<typeof EnginesSchema>;

export const ExtensionManifestSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  version: z.string().default("1.0.0"),
  builtIn: z.boolean().default(false),
  activationEvents: z.array(z.string()).default(["onEmail"]),
  contributes: ExtensionContributesSchema.optional(),
  engines: EnginesSchema.optional(),
});

export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

export const AgentProviderManifestSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  version: z.string().default("1.0.0"),
  authType: z.enum(["browser", "token", "none"]).default("none"),
  contributes: z.object({
    settings: z.array(SettingDefinitionSchema).optional(),
  }).optional(),
  engines: EnginesSchema.optional(),
});

export type AgentProviderManifest = z.infer<typeof AgentProviderManifestSchema>;

/**
 * Check if an extension's engine constraint is compatible with the current API version.
 * Returns { compatible: true } or { compatible: false, reason: string }.
 */
export function checkApiCompatibility(
  engines: Engines | undefined,
  displayName: string,
): { compatible: true } | { compatible: false; reason: string } {
  if (!engines?.mailClient) {
    return { compatible: true };
  }

  const apiVersionStr = `${EXTENSION_API_VERSION}.0.0`;
  if (!semver.satisfies(apiVersionStr, engines.mailClient)) {
    return {
      compatible: false,
      reason: `Extension "${displayName}" requires mail client API ${engines.mailClient}, but this app provides API version ${EXTENSION_API_VERSION}`,
    };
  }

  return { compatible: true };
}

/**
 * Info about an installed (non-bundled) extension for the UI
 */
export interface InstalledExtensionInfo {
  id: string;
  displayName: string;
  description?: string;
  version: string;
  isActive: boolean;
  path: string;
  hasRenderer: boolean;
  hasAgentProvider: boolean;
  agentProviderManifest?: AgentProviderManifest;
  loadError?: string;
  providerHealthStatus?: "connected" | "not_configured" | "error";
  providerHealthMessage?: string;
}

// =============================================================================
// Enrichment Types
// =============================================================================

export const EnrichmentDataSchema = z.object({
  extensionId: z.string(),
  panelId: z.string(), // Maps to contributed sidebar panel
  data: z.record(z.string(), z.unknown()), // Extension-specific data
  expiresAt: z.number().optional(), // Unix timestamp
});

export type EnrichmentData = z.infer<typeof EnrichmentDataSchema>;

// =============================================================================
// Extension Context (provided to extensions)
// =============================================================================

/**
 * Storage API for extensions to persist data
 */
export interface ExtensionStorage {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Secrets API for extensions to store sensitive data
 */
export interface ExtensionSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Logger API for extensions
 */
export interface ExtensionLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Context passed to extension activate()
 */
export interface ExtensionContext {
  extensionId: string;
  extensionPath: string;
  storage: ExtensionStorage;
  secrets: ExtensionSecrets;
  logger: ExtensionLogger;
}

// =============================================================================
// Extension API (what extensions can do)
// =============================================================================

/**
 * Enrichment provider interface - extensions implement this to enrich emails
 */
export interface EnrichmentProvider {
  id: string;
  panelId: string; // Which sidebar panel this enrichment feeds

  /**
   * Called to enrich an email with external data
   * @returns The enrichment data, or null if no enrichment is available
   */
  enrich(email: DashboardEmail, threadEmails: DashboardEmail[]): Promise<EnrichmentData | null>;

  /**
   * Optional: Check if this provider can handle the given email
   * @returns true if this provider should attempt to enrich this email
   */
  canEnrich?(email: DashboardEmail): boolean;

  /**
   * Optional: Priority for this provider (higher = runs first)
   */
  priority?: number;
}

/**
 * Props passed to sidebar panel components
 */
export interface SidebarPanelProps {
  email: DashboardEmail;
  threadEmails: DashboardEmail[];
  enrichment: EnrichmentData | null;
  isLoading: boolean;
}

/**
 * Sidebar panel registration
 */
export interface SidebarPanelRegistration {
  id: string;
  extensionId: string;
  title: string;
  priority: number;
  scope: "sender" | "email";
  // Component is registered separately in the renderer
}

/**
 * Badge to display on email list items
 */
export interface EmailBadge {
  id: string;
  extensionId: string;
  label: string;
  color?: "blue" | "green" | "yellow" | "red" | "gray";
  tooltip?: string;
}

/**
 * Badge provider interface
 */
export interface BadgeProvider {
  id: string;
  getBadge(email: DashboardEmail): EmailBadge | null;
}

/**
 * API exposed to extensions for registering capabilities
 */
export interface ExtensionAPI {
  /**
   * Register an enrichment provider
   */
  registerEnrichmentProvider(provider: EnrichmentProvider): void;

  /**
   * Register a badge provider
   */
  registerBadgeProvider(provider: BadgeProvider): void;

  /**
   * Get a setting value
   */
  getSetting<T>(key: string): Promise<T>;

  /**
   * Set a setting value
   */
  setSetting<T>(key: string, value: T): Promise<void>;

  /**
   * Signal that this extension needs re-authentication.
   * Shows a banner in the UI. The extension still owns its auth flow —
   * this just surfaces the problem to the user.
   */
  emitAuthRequired(message?: string): void;

  /**
   * Register an auth handler that the host can invoke when the user
   * clicks "Authenticate" on the extension auth banner.
   * The handler should open its auth flow and resolve when complete.
   *
   * Options:
   * - checkAuth: Return true if the extension is already authenticated.
   *   Used during onboarding to determine if auth is needed proactively.
   */
  registerAuthHandler(handler: () => Promise<void>, options?: { checkAuth?: () => Promise<boolean> }): void;
}

// =============================================================================
// Extension Module Interface
// =============================================================================

/**
 * Interface that extension entry points must implement
 */
export interface ExtensionModule {
  /**
   * Called when the extension is activated
   */
  activate(context: ExtensionContext, api: ExtensionAPI): Promise<void> | void;

  /**
   * Called when the extension is deactivated
   */
  deactivate?(): Promise<void> | void;
}

// =============================================================================
// Internal Types (used by extension host)
// =============================================================================

export interface LoadedExtension {
  manifest: ExtensionManifest;
  path: string;
  module: ExtensionModule | null;
  context: ExtensionContext;
  isActive: boolean;
}

export interface ExtensionEnrichmentRecord {
  emailId: string;
  extensionId: string;
  panelId: string;
  data: string; // JSON stringified
  expiresAt: number | null;
  createdAt: number;
}

export interface ExtensionStorageRecord {
  extensionId: string;
  key: string;
  value: string; // JSON stringified
  updatedAt: number;
}

// =============================================================================
// IPC Types
// =============================================================================

export interface ExtensionPanelInfo {
  id: string;
  extensionId: string;
  title: string;
  priority: number;
  scope: "sender" | "email";
}

export interface ExtensionEnrichmentResult {
  panelId: string;
  extensionId: string;
  data: Record<string, unknown>;
  isLoading: boolean;
}
