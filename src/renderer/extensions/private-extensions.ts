/**
 * Auto-loader for private extension panel components.
 *
 * This file dynamically discovers and imports panel components from extensions
 * in the extensions-private folder. When removing private extensions before
 * open-sourcing, simply delete the extensions-private folder and this file
 * will gracefully handle the missing modules.
 *
 * Each private extension should export a `panelRegistrations` array from its
 * renderer/index.ts file with the format:
 *   [{ extensionId: string, panelId: string, component: React.ComponentType }]
 */

import { registerPanelComponent, type PanelComponentProps } from "./ExtensionPanelSlot";

// Use Vite's import.meta.glob to discover private extension renderer modules
// eager: true ensures modules are loaded synchronously at bundle time,
// avoiding race conditions where the panel component isn't registered
// by the time the sidebar tries to render it
const privateExtensionModules = import.meta.glob(
  "../../extensions-private/*/src/renderer/index.ts",
  { eager: true },
);

interface PanelRegistration {
  extensionId: string;
  panelId: string;
  component: React.ComponentType<PanelComponentProps>;
}

interface PrivateExtensionRendererModule {
  panelRegistrations?: PanelRegistration[];
}

/**
 * Register all private extension panel components.
 * Call this during app initialization.
 */
export function registerPrivateExtensions(): void {
  const modulePaths = Object.keys(privateExtensionModules);

  if (modulePaths.length === 0) {
    return;
  }

  for (const path of modulePaths) {
    try {
      const module = privateExtensionModules[path] as PrivateExtensionRendererModule;

      if (module.panelRegistrations) {
        for (const reg of module.panelRegistrations) {
          registerPanelComponent(reg.extensionId, reg.panelId, reg.component);
          console.log(`[Extensions] Registered private panel: ${reg.extensionId}:${reg.panelId}`);
        }
      }
    } catch (e) {
      console.warn(`[Extensions] Failed to load private extension from ${path}:`, e);
    }
  }
}
