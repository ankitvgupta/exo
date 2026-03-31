import type { InboxSplit, DashboardEmail } from "../../shared/types";

// Label name → ID lookup for split condition matching, keyed by account.
// Populated asynchronously on app mount; falls back to direct ID comparison when empty.
const labelNameToIdsByAccount = new Map<string, Map<string, string>>();

export function setLabelMap(accountId: string, labels: Array<{ id: string; name: string }>): void {
  const map = new Map<string, string>();
  for (const label of labels) {
    map.set(label.name.toLowerCase(), label.id);
  }
  labelNameToIdsByAccount.set(accountId, map);
}

function resolveLabelNameToId(value: string): string | undefined {
  const lower = value.toLowerCase();
  for (const map of labelNameToIdsByAccount.values()) {
    const id = map.get(lower);
    if (id) return id;
  }
  return undefined;
}

// Convert a glob-like pattern to a regex
// Supports: * (matches anything), ? (matches single char)
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${regexStr}$`, "i");
}

// Check if a value matches a pattern (supports wildcards)
// If pattern has no wildcards, does a case-insensitive substring match
function matchesPattern(value: string, pattern: string): boolean {
  const hasWildcard = pattern.includes("*") || pattern.includes("?");
  if (hasWildcard) {
    return patternToRegex(pattern).test(value);
  }
  return value.toLowerCase().includes(pattern.toLowerCase());
}

// Extract email address from "Name <email>" format
function extractEmailAddress(fromField: string): string {
  const match = fromField.match(/<([^>]+)>/);
  return match ? match[1] : fromField;
}

// Evaluate a split condition against an email
export function evaluateCondition(email: DashboardEmail, condition: InboxSplit["conditions"][0]): boolean {
  let matches = false;
  switch (condition.type) {
    case "from": {
      const emailAddr = extractEmailAddress(email.from);
      matches = matchesPattern(email.from, condition.value) ||
                matchesPattern(emailAddr, condition.value);
      break;
    }
    case "to": {
      const emailAddr = extractEmailAddress(email.to);
      matches = matchesPattern(email.to, condition.value) ||
                matchesPattern(emailAddr, condition.value);
      break;
    }
    case "subject": {
      matches = matchesPattern(email.subject, condition.value);
      break;
    }
    case "label": {
      // Match by label ID directly, or resolve label name → ID
      const labelIds = email.labelIds ?? [];
      if (labelIds.includes(condition.value)) {
        matches = true;
      } else {
        const resolvedId = resolveLabelNameToId(condition.value);
        matches = resolvedId ? labelIds.includes(resolvedId) : false;
      }
      break;
    }
    case "has_attachment": {
      matches = email.attachments?.some((a) => matchesPattern(a.filename, condition.value)) ?? false;
      break;
    }
  }
  return condition.negate ? !matches : matches;
}

// Check if a thread matches a split's conditions.
// Takes the email to evaluate against (typically the latest email in the thread).
export function emailMatchesSplit(email: DashboardEmail, split: InboxSplit): boolean {
  const results = split.conditions.map((c) => evaluateCondition(email, c));
  return split.conditionLogic === "and"
    ? results.every(Boolean)
    : results.some(Boolean);
}
