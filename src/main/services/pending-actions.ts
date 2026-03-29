import { EventEmitter } from "events";
import { networkMonitor } from "./network-monitor";
import { isNetworkError } from "./network-errors";
import type { GmailClient } from "./gmail-client";

export interface PendingAction {
  id: string;
  type: "archive" | "trash";
  emailId: string;
  accountId: string;
  retryCount: number;
  createdAt: number;
}

type PendingActionsEvent = "action-failed" | "action-succeeded";

const MAX_RETRIES = 3;

class PendingActionsQueue extends EventEmitter {
  private queue: PendingAction[] = [];
  private processing = false;
  private clientResolver?: (accountId: string) => GmailClient | null;
  private nextId = 0;

  setClientResolver(resolver: (accountId: string) => GmailClient | null): void {
    this.clientResolver = resolver;
  }

  /**
   * Queue an action for later execution.
   * Returns the queued action's ID.
   */
  enqueue(type: "archive" | "trash", emailId: string, accountId: string): string {
    const id = `pending-${++this.nextId}`;
    this.queue.push({ id, type, emailId, accountId, retryCount: 0, createdAt: Date.now() });
    console.log(`[PendingActions] Queued ${type} for email ${emailId} (${this.queue.length} pending)`);
    return id;
  }

  /**
   * Process all pending actions. Called when network comes back online.
   */
  async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    console.log(`[PendingActions] Processing ${this.queue.length} pending action(s)`);

    // Take a snapshot of the queue and clear it; failed items get re-queued
    const items = [...this.queue];
    this.queue = [];

    for (const item of items) {
      if (!networkMonitor.isOnline) {
        // Gone offline again — put everything back
        this.queue.unshift(...items.slice(items.indexOf(item)));
        console.log(`[PendingActions] Went offline, ${this.queue.length} action(s) re-queued`);
        break;
      }

      try {
        const client = this.clientResolver?.(item.accountId);
        if (!client) {
          // Account not connected yet — re-queue
          item.retryCount++;
          if (item.retryCount >= MAX_RETRIES) {
            console.error(`[PendingActions] Permanently failed ${item.type} for ${item.emailId}: account not connected`);
            this.emit("action-failed", { emailId: item.emailId, accountId: item.accountId, action: item.type, error: "Account not connected" });
          } else {
            this.queue.push(item);
          }
          continue;
        }

        if (item.type === "archive") {
          await client.archiveMessage(item.emailId);
        } else {
          await client.trashMessage(item.emailId);
        }

        console.log(`[PendingActions] Successfully processed ${item.type} for ${item.emailId}`);
        this.emit("action-succeeded", { emailId: item.emailId, accountId: item.accountId, action: item.type });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const isNetwork = isNetworkError(error);

        if (isNetwork) {
          // Network error — re-queue and stop processing
          this.queue.unshift(item, ...items.slice(items.indexOf(item) + 1));
          networkMonitor.setOffline();
          console.log(`[PendingActions] Network error, ${this.queue.length} action(s) re-queued`);
          break;
        }

        item.retryCount++;
        if (item.retryCount >= MAX_RETRIES) {
          console.error(`[PendingActions] Permanently failed ${item.type} for ${item.emailId}: ${msg}`);
          this.emit("action-failed", { emailId: item.emailId, accountId: item.accountId, action: item.type, error: msg });
        } else {
          this.queue.push(item);
          console.warn(`[PendingActions] ${item.type} for ${item.emailId} failed (retry ${item.retryCount}/${MAX_RETRIES}): ${msg}`);
        }
      }
    }

    this.processing = false;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  // Type-safe event methods
  on(event: PendingActionsEvent, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  emit(event: PendingActionsEvent, ...args: any[]): boolean {
    return super.emit(event, ...args);
  }
}

export const pendingActionsQueue = new PendingActionsQueue();
