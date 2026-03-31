/**
 * Calendar enrichment provider.
 * Minimal: just reports whether the user has calendar access so the panel
 * knows whether to show the permission prompt. Actual event fetching is
 * driven by the CalendarPanel through the calendar:get-events IPC channel.
 */
import type {
  EnrichmentProvider,
  EnrichmentData,
  ExtensionContext,
} from "../../../shared/extension-types";
import type { DashboardEmail } from "../../../shared/types";
import { findAllCalendarAccounts } from "./google-calendar-client";

const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const isTestMode = process.env.EXO_TEST_MODE === "true";

export function createCalendarProvider(context: ExtensionContext): EnrichmentProvider {
  return {
    id: "calendar-events",
    panelId: "day-view",
    priority: 100,

    canEnrich(_email: DashboardEmail): boolean {
      return true;
    },

    async enrich(
      _email: DashboardEmail,
      _threadEmails: DashboardEmail[],
    ): Promise<EnrichmentData | null> {
      context.logger.info("Checking calendar access");

      if (isDemoMode || isTestMode) {
        return {
          extensionId: "calendar",
          panelId: "day-view",
          data: { hasCalendarAccess: true },
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
      }

      const calendarAccounts = await findAllCalendarAccounts();

      return {
        extensionId: "calendar",
        panelId: "day-view",
        data: { hasCalendarAccess: calendarAccounts.length > 0 },
        expiresAt: Date.now() + 5 * 60 * 1000,
      };
    },
  };
}
