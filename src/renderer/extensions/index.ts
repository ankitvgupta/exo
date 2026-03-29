// Extension UI exports
export { useExtensionPanels, useExtensionBadges } from "./hooks";
export type { ExtensionPanelData } from "./hooks";
export {
  ExtensionPanelSlot,
  ExtensionPanelLoading,
  registerPanelComponent,
  getPanelComponent,
} from "./ExtensionPanelSlot";
export { ExtensionUIProvider, useExtensionUI } from "./ExtensionUIManager";

// Bundled extensions
export { registerBundledExtensions } from "./bundled";
