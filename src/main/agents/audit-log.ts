/**
 * Audit logging for agent actions.
 *
 * Works via the DB proxy in the utility process — all writes go through
 * the dbProxy function rather than importing better-sqlite3 directly.
 */

import type { DbProxyFn } from "./types";

export interface AuditEntry {
  taskId: string;
  providerId: string;
  timestamp: string;
  eventType: string;
  toolName?: string;
  inputJson?: string;
  outputJson?: string;
  redactionApplied: boolean;
  userApproved?: boolean;
  accountId?: string;
  expiresAt?: string;
}

const MAX_BODY_LENGTH = 200;

/**
 * Redact sensitive content from a payload before logging.
 * Strips email bodies to 200 chars and removes attachment content.
 */
export function redactPayload(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (typeof payload === "string") {
    return payload.length > MAX_BODY_LENGTH
      ? payload.slice(0, MAX_BODY_LENGTH) + "...[redacted]"
      : payload;
  }
  if (Array.isArray(payload)) {
    return payload.map(redactPayload);
  }
  if (typeof payload === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (key === "body" || key === "bodyHtml" || key === "bodyText" || key === "body_text") {
        result[key] =
          typeof value === "string" && value.length > MAX_BODY_LENGTH
            ? value.slice(0, MAX_BODY_LENGTH) + "...[redacted]"
            : value;
      } else if (key === "content" && typeof value === "string" && value.length > MAX_BODY_LENGTH) {
        // Attachment content or large text blocks
        result[key] = "[redacted: content too large]";
      } else {
        result[key] = redactPayload(value);
      }
    }
    return result;
  }
  return payload;
}

export class AuditLog {
  constructor(private readonly dbProxy: DbProxyFn) {}

  async saveEntry(entry: AuditEntry): Promise<void> {
    const redacted = {
      ...entry,
      inputJson: entry.inputJson
        ? JSON.stringify(redactPayload(JSON.parse(entry.inputJson)))
        : undefined,
      outputJson: entry.outputJson
        ? JSON.stringify(redactPayload(JSON.parse(entry.outputJson)))
        : undefined,
      redactionApplied: true,
    };

    await this.dbProxy("saveAuditEntry", redacted);
  }

  async cleanupExpired(): Promise<void> {
    await this.dbProxy("cleanupExpiredAudit");
  }
}
