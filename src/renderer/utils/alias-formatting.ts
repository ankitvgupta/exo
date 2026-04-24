import type { SendAsAlias } from "../../shared/types";

/**
 * Format an alias as "Display Name <email>" or just "email".
 * Falls back to `fallbackName` when the alias has no display name configured —
 * common for Workspace primary aliases where the name is set via OAuth profile,
 * not Gmail send-as settings.
 */
export function formatAlias(alias: SendAsAlias, fallbackName?: string): string {
  const name = alias.displayName || fallbackName;
  return name ? `${name} <${alias.email}>` : alias.email;
}
