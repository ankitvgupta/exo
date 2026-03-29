/**
 * Re-export shared address parsing utilities.
 * The canonical implementation lives in src/shared/utils/address-parsing.ts
 * so both renderer and main process can use the same code.
 */
export { splitAddressList } from "../../shared/utils/address-parsing";

/**
 * Extract first name from a display name.
 * Handles "LastName, FirstName" format (common in corporate directories).
 * Returns the string as-is if it looks like a bare email address.
 */
export function extractFirstName(name: string): string {
  if (name.includes("@")) return name;
  // "LastName, FirstName ..." → take the first word after the comma
  const commaIdx = name.indexOf(",");
  if (commaIdx !== -1) {
    const afterComma = name.substring(commaIdx + 1).trim();
    if (afterComma) return afterComma.split(/\s+/)[0];
  }
  return name.replace(/,+$/, "").split(/\s+/)[0];
}
