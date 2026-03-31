/**
 * Calendar Extension - Main process entry point
 *
 * Extracts dates mentioned in email bodies and shows calendar events
 * for those dates in the sidebar.
 */
import type {
  ExtensionModule,
  ExtensionContext,
  ExtensionAPI,
} from "../../../shared/extension-types";
import { createCalendarProvider } from "./calendar-provider";

const extension: ExtensionModule = {
  async activate(context: ExtensionContext, api: ExtensionAPI): Promise<void> {
    context.logger.info("Activating calendar extension");
    const provider = createCalendarProvider(context);
    api.registerEnrichmentProvider(provider);
    context.logger.info("Calendar extension activated");
  },

  async deactivate(): Promise<void> {
    console.log("[Ext:calendar] Deactivated");
  },
};

export const { activate, deactivate } = extension;
