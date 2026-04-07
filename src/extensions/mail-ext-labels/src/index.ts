import type {
  ExtensionContext,
  ExtensionAPI,
  ExtensionModule,
} from "../../../shared/extension-types";
import { createLabelsProvider } from "./labels-provider";

const extension: ExtensionModule = {
  async activate(context: ExtensionContext, api: ExtensionAPI): Promise<void> {
    context.logger.info("Activating labels extension");
    const provider = createLabelsProvider(context);
    api.registerEnrichmentProvider(provider);
    context.logger.info("Labels extension activated");
  },

  async deactivate(): Promise<void> {
    console.log("[Ext:labels] Deactivated");
  },
};

export const { activate, deactivate } = extension;
