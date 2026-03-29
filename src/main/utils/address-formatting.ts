import { splitAddressList } from "../../shared/utils/address-parsing";

/** RFC 2822 special characters that require quoting in display names */
const RFC2822_SPECIALS = /[,;<>@"()[\]\\]/;

/**
 * Format a display name for use in an RFC 2822 address string.
 * Names containing special characters are wrapped in double quotes
 * with internal backslashes and double quotes escaped.
 */
export function quoteDisplayName(name: string): string {
  if (!RFC2822_SPECIALS.test(name)) return name;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Extract the bare email address from a string that may be either
 * a bare email ("foo@bar.com") or a formatted address ("Name <foo@bar.com>").
 */
export function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return match ? match[1] : addr;
}

/**
 * Format bare email addresses as "Name <email>" using the recipientNames map.
 * Handles both bare emails and pre-formatted "Name <email>" strings.
 */
export function formatAddressesWithNames(
  addresses: string[],
  recipientNames?: Record<string, string>,
): string[] {
  if (!recipientNames) return addresses;
  return addresses.map((addr) => {
    const email = extractEmail(addr);
    const name = recipientNames[email.toLowerCase()];
    if (name) return `${quoteDisplayName(name)} <${email}>`;
    return addr;
  });
}

/**
 * Build a map of lowercase email → display name from thread email headers.
 * First name found for a given email wins (thread-chronological ordering).
 */
export function extractThreadNames(
  threadEmails: Array<{ from: string; to: string; cc?: string | null; bcc?: string | null }>,
): Record<string, string> {
  const threadNames: Record<string, string> = {};
  for (const email of threadEmails) {
    for (const header of [email.from, email.to, email.cc || "", email.bcc || ""]) {
      for (const part of splitAddressList(header)) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const match = trimmed.match(/^([^<]+)<([^>]+)>/);
        if (match) {
          const name = match[1]
            .trim()
            .replace(/^"|"$/g, "")    // strip outer quotes only
            .replace(/\\(.)/g, "$1"); // unescape \X → X
          const addr = match[2].trim().toLowerCase();
          if (name && !threadNames[addr]) threadNames[addr] = name;
        }
      }
    }
  }
  return threadNames;
}
