import {
  saveExtensionEnrichment,
  getExtensionEnrichments,
  getExtensionEnrichmentBySender,
  clearExpiredEnrichments as dbClearExpired,
  deleteEnrichmentBySender as dbDeleteBySender,
} from "../db";
import type { EnrichmentData, ExtensionEnrichmentResult } from "../../shared/extension-types";

/**
 * Store enrichment data for an email
 */
export function saveEnrichment(
  emailId: string,
  enrichment: EnrichmentData,
  senderEmail?: string
): void {
  saveExtensionEnrichment(
    emailId,
    enrichment.extensionId,
    enrichment.panelId,
    JSON.stringify(enrichment.data),
    enrichment.expiresAt ?? null,
    senderEmail
  );
}

/**
 * Get all enrichments for an email
 */
export function getEnrichments(emailId: string): ExtensionEnrichmentResult[] {
  const t0 = performance.now();
  const records = getExtensionEnrichments(emailId);
  const dbTime = performance.now() - t0;

  const result = records
    .map((record) => {
      const data = parseEnrichmentData(record.data, record.panelId, record.extensionId);
      if (!data) {
        return null;
      }

      return {
        panelId: record.panelId,
        extensionId: record.extensionId,
        data,
        isLoading: false,
      };
    })
    .filter((enrichment): enrichment is ExtensionEnrichmentResult => enrichment !== null);

  const totalTime = performance.now() - t0;
  if (totalTime > 5) {
    console.log(`[PERF] getEnrichments ${emailId.slice(0,8)} DB=${dbTime.toFixed(1)}ms total=${totalTime.toFixed(1)}ms records=${records.length}`);
  }
  return result;
}

/**
 * Get enrichment for a specific panel
 */
export function getEnrichmentForPanel(
  emailId: string,
  panelId: string
): ExtensionEnrichmentResult | null {
  const enrichments = getEnrichments(emailId);
  return enrichments.find((e) => e.panelId === panelId) ?? null;
}

/**
 * Clear expired enrichments (called periodically)
 */
export function clearExpiredEnrichments(): number {
  return dbClearExpired();
}

/**
 * Check if enrichment exists and is not expired
 */
export function hasValidEnrichment(emailId: string, extensionId: string): boolean {
  const enrichments = getEnrichments(emailId);
  return enrichments.some((e) => e.extensionId === extensionId);
}

/**
 * Get enrichment by sender email address (for cross-email caching)
 */
export function getEnrichmentBySender(
  senderEmail: string,
  extensionId: string
): ExtensionEnrichmentResult | null {
  const record = getExtensionEnrichmentBySender(senderEmail, extensionId);
  if (!record) return null;

  const data = parseEnrichmentData(record.data, record.panelId, record.extensionId);
  if (!data) return null;

  return {
    panelId: record.panelId,
    extensionId: record.extensionId,
    data,
    isLoading: false,
  };
}

/**
 * Delete enrichments for a specific sender and extension
 * Used for forcing a refresh of cached data
 */
export function deleteEnrichmentBySender(senderEmail: string, extensionId: string): number {
  return dbDeleteBySender(senderEmail, extensionId);
}

function parseEnrichmentData(
  rawData: string,
  panelId: string,
  extensionId: string
): Record<string, unknown> | null {
  try {
    return JSON.parse(rawData) as Record<string, unknown>;
  } catch (error) {
    console.warn(
      `[EnrichmentStore] Failed to parse enrichment payload`,
      { extensionId, panelId, error: error instanceof Error ? error.message : "Unknown error" }
    );
    return null;
  }
}
