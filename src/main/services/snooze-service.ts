import {
  getDueSnoozedEmails,
  unsnoozeEmail,
  getAllSnoozedEmails,
  snoozeEmail as dbSnoozeEmail,
  unsnoozeByThread as dbUnsnoozeByThread,
  getSnoozedEmails as dbGetSnoozedEmails,
  getSnoozedByThread as dbGetSnoozedByThread,
} from "../db";
import type { SnoozedEmail } from "../../shared/types";
import { randomUUID } from "crypto";

const CHECK_INTERVAL_MS = 30_000; // Check every 30 seconds

export type SnoozeCallback = (snoozedEmails: SnoozedEmail[]) => void;

class SnoozeService {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private onUnsnooze: SnoozeCallback | null = null;

  /**
   * Set callback for when emails are unsnoozed (timer expired).
   */
  setOnUnsnooze(callback: SnoozeCallback): void {
    this.onUnsnooze = callback;
  }

  /**
   * Start the periodic check for due snoozed emails.
   */
  start(): void {
    if (this.intervalId) return;

    console.log("[Snooze] Starting snooze service (check interval: 30s)");
    // Don't check immediately — no renderer windows exist yet to receive
    // the unsnoozed IPC event. The renderer's snooze:list call handles
    // expired snoozes on startup. The periodic timer handles ongoing expiry.
    this.intervalId = setInterval(() => {
      this.checkDueSnoozedEmails();
    }, CHECK_INTERVAL_MS);
  }

  /**
   * Stop the periodic check.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[Snooze] Snooze service stopped");
    }
  }

  /**
   * Snooze a thread until the specified time.
   * Purely local — hides the thread in-app without touching Gmail labels.
   */
  snooze(
    emailId: string,
    threadId: string,
    accountId: string,
    snoozeUntil: number
  ): SnoozedEmail {
    const id = randomUUID();
    // Remove any existing snooze for this thread first
    dbUnsnoozeByThread(threadId, accountId);
    dbSnoozeEmail(id, emailId, threadId, accountId, snoozeUntil);

    const snoozeDate = new Date(snoozeUntil);
    console.log(`[Snooze] Snoozed thread ${threadId} until ${snoozeDate.toLocaleString()}`);

    return {
      id,
      emailId,
      threadId,
      accountId,
      snoozeUntil,
      snoozedAt: Date.now(),
    };
  }

  /**
   * Manually unsnooze a thread (user cancels snooze).
   */
  unsnooze(threadId: string, accountId: string): void {
    dbUnsnoozeByThread(threadId, accountId);
    console.log(`[Snooze] Manually unsnoozed thread ${threadId}`);
  }

  /**
   * Get all snoozed emails for an account.
   */
  getSnoozedEmails(accountId: string): SnoozedEmail[] {
    return dbGetSnoozedEmails(accountId);
  }

  /**
   * Get snooze info for a specific thread.
   */
  getSnoozedByThread(threadId: string, accountId: string): SnoozedEmail | null {
    return dbGetSnoozedByThread(threadId, accountId);
  }

  /**
   * Get all snoozed emails across all accounts.
   */
  getAllSnoozed(): SnoozedEmail[] {
    return getAllSnoozedEmails();
  }

  /**
   * Unsnooze any threads that received new emails (replies).
   * Called during sync when new messages arrive.
   */
  unsnoozeForReplies(threadIds: string[], accountId: string): SnoozedEmail[] {
    const unsnoozed: SnoozedEmail[] = [];
    for (const threadId of threadIds) {
      const snoozeInfo = dbGetSnoozedByThread(threadId, accountId);
      if (snoozeInfo) {
        dbUnsnoozeByThread(threadId, accountId);
        unsnoozed.push(snoozeInfo);
        console.log(`[Snooze] Unsnoozed thread ${threadId} — new reply received`);
      }
    }
    if (unsnoozed.length > 0 && this.onUnsnooze) {
      this.onUnsnooze(unsnoozed);
    }
    return unsnoozed;
  }

  /**
   * Check for and process due snoozed emails.
   */
  private checkDueSnoozedEmails(): void {
    const dueEmails = getDueSnoozedEmails();
    if (dueEmails.length === 0) return;

    console.log(`[Snooze] ${dueEmails.length} snoozed email(s) are due`);

    for (const snoozed of dueEmails) {
      unsnoozeEmail(snoozed.id);
    }

    // Notify via callback
    if (this.onUnsnooze) {
      this.onUnsnooze(dueEmails);
    }
  }
}

export const snoozeService = new SnoozeService();
