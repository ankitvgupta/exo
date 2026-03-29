import { ipcMain } from "electron";
import { GmailClient } from "../services/gmail-client";
import { emailSyncService, type AccountInfo } from "../services/email-sync";
import { getAccounts, saveAccount } from "../db";
import type { IpcResponse, OnboardingSyncResult } from "../../shared/types";

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

// Store clients created during onboarding so sync:init can reuse them
const onboardingClients: Map<string, GmailClient> = new Map();
// Track actively running syncs (separate from client cache which persists after success)
const onboardingSyncInProgress = new Set<string>();

export function getOnboardingClient(accountId: string): GmailClient | undefined {
  return onboardingClients.get(accountId);
}

export function clearOnboardingClient(accountId: string): void {
  onboardingClients.delete(accountId);
}

export function registerOnboardingIpc(): void {
  /**
   * Run the initial sync for a newly-added account during onboarding.
   * Fetches emails, marks old ones as skip + archive-ready, but does NOT
   * start the sync loop or prefetch pipeline. The caller must invoke
   * onboarding:start-processing after showing the triage screen.
   */
  ipcMain.handle(
    "onboarding:initial-sync",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<OnboardingSyncResult>> => {
      if (useFakeData) {
        return {
          success: true,
          data: {
            accountId,
            email: "me@example.com",
            totalSynced: 0,
            totalInboxCount: 0,
            oldMarked: 0,
            recentCount: 0,
            recentEmailIds: [],
          },
        };
      }

      // Guard against concurrent onboarding (e.g. double-click retry while sync is running)
      if (onboardingSyncInProgress.has(accountId)) {
        return { success: false, error: "Onboarding already in progress for this account" };
      }

      onboardingSyncInProgress.add(accountId);
      try {
        const client = new GmailClient(accountId);
        await client.connect();

        // Register with sync service (gets profile, sets up for full sync)
        const accountInfo: AccountInfo = await emailSyncService.registerAccount(client);

        // Store client so sync:init can reuse it instead of creating a new one
        onboardingClients.set(accountId, client);

        // Ensure account is in the DB (startOAuth should have saved it,
        // but handle the edge case where it wasn't)
        const accounts = getAccounts();
        if (!accounts.some(a => a.id === accountId)) {
          const isPrimary = accounts.length === 0;
          saveAccount(accountId, accountInfo.email, accountInfo.displayName, isPrimary);
        }

        // Run full sync with onboarding triage (marks old emails, skips prefetch)
        const result = await emailSyncService.runOnboardingSync(accountId);

        onboardingSyncInProgress.delete(accountId);
        return {
          success: true,
          data: {
            accountId,
            email: accountInfo.email,
            totalSynced: result.totalSynced,
            totalInboxCount: result.totalInboxCount,
            oldMarked: result.oldMarked,
            recentCount: result.recentCount,
            recentEmailIds: result.recentEmailIds,
          },
        };
      } catch (error) {
        onboardingSyncInProgress.delete(accountId);
        // Clean up so the user can retry onboarding
        onboardingClients.delete(accountId);
        emailSyncService.unregisterAccount(accountId);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );

  /**
   * Start prefetch processing and the sync loop after onboarding triage.
   * Called when the user dismisses the triage screen.
   */
  ipcMain.handle(
    "onboarding:start-processing",
    async (_, { accountId, recentEmailIds }: { accountId: string; recentEmailIds: string[] }): Promise<IpcResponse<void>> => {
      if (useFakeData) {
        return { success: true, data: undefined };
      }

      try {
        await emailSyncService.startAfterOnboarding(accountId, recentEmailIds);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    }
  );
}
