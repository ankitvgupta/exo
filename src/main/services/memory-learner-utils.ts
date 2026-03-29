/**
 * Shared utilities for memory learners (draft-edit-learner + analysis-edit-learner).
 *
 * Pure functions for JSON parsing, scope normalization, and shared constants.
 * No plugin interface — just extracting duplicated logic.
 */
import type { MemoryScope } from "../../shared/types";

/** Valid memory scopes in narrowest→broadest order */
export const VALID_MEMORY_SCOPES: readonly MemoryScope[] = ["person", "domain", "category", "global"] as const;

/** Consumer email domains where "domain" scope is meaningless (millions of unrelated users) */
export const CONSUMER_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com",
  "aol.com", "protonmail.com", "mail.com", "zoho.com", "yandex.com",
]);

/**
 * Parse a JSON array from LLM text output.
 *
 * Finds the first `[` and last `]`, extracts the substring, and JSON.parse's it.
 * Returns null if no brackets found, parse fails, or result is not an array.
 */
export function parseJsonArray<T>(text: string): T[] | null {
  const arrayStart = text.indexOf("[");
  const arrayEnd = text.lastIndexOf("]");
  if (arrayStart === -1 || arrayEnd === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1)) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed as T[];
  } catch {
    return null;
  }
}

/**
 * Normalize a raw scope string from LLM output into a valid MemoryScope + scopeValue.
 *
 * - Invalid scopes default to "person"
 * - "global" always gets null scopeValue
 * - "domain" falls back to senderDomain
 * - "person" falls back to senderEmail
 * - "category" falls back to null
 */
export function normalizeScope(
  rawScope: string,
  scopeValue: string | null,
  senderEmail: string,
  senderDomain: string,
): { scope: MemoryScope; scopeValue: string | null } {
  const scope: MemoryScope = (VALID_MEMORY_SCOPES as readonly string[]).includes(rawScope)
    ? (rawScope as MemoryScope)
    : "person";
  const normalizedScopeValue = scope === "global"
    ? null
    : scope === "domain"
      ? (scopeValue ?? senderDomain)
      : scope === "person"
        ? (scopeValue ?? senderEmail)
        : (scopeValue ?? null);
  return { scope, scopeValue: normalizedScopeValue };
}
