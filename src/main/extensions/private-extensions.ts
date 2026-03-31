/**
 * Auto-loader for private extension modules in the main process.
 *
 * This file dynamically discovers and imports extension modules from the
 * extensions-private folder using Vite's import.meta.glob for build-time
 * discovery. When removing private extensions before open-sourcing, simply
 * delete the extensions-private folder and the glob will return empty.
 */

import type { ExtensionHost } from "./extension-host";
import { ExtensionManifestSchema, type ExtensionModule } from "../../shared/extension-types";
import { createLogger } from "../services/logger";

const log = createLogger("private-extensions");

// Use Vite's import.meta.glob to discover private extension modules at build time
// This will be an empty object if extensions-private doesn't exist
const privateExtensionModules = import.meta.glob<ExtensionModule>(
  "../../extensions-private/*/src/index.ts",
  { eager: true },
);

// Glob the package.json files to get full manifest data
const privateExtensionPackages = import.meta.glob<{ mailExtension?: Record<string, unknown> }>(
  "../../extensions-private/*/package.json",
  { eager: true },
);

/**
 * Get the package.json content for a module path
 */
function getPackageJson(modulePath: string): { mailExtension?: Record<string, unknown> } | null {
  const packagePath = modulePath.replace(/\/src\/index\.ts$/, "/package.json");
  return privateExtensionPackages[packagePath] ?? null;
}

/**
 * Register all private extension modules with the extension host.
 * Uses build-time discovery via import.meta.glob — no filesystem access needed.
 */
export async function registerPrivateExtensions(extensionHost: ExtensionHost): Promise<void> {
  const modulePaths = Object.keys(privateExtensionModules);

  if (modulePaths.length === 0) {
    return;
  }

  for (const path of modulePaths) {
    try {
      const pkg = getPackageJson(path);
      if (!pkg?.mailExtension) {
        log.warn(`[Extensions] Private extension at ${path} missing mailExtension`);
        continue;
      }

      const manifest = ExtensionManifestSchema.parse(pkg.mailExtension);
      const module = privateExtensionModules[path];
      await extensionHost.registerBundledExtensionFull(manifest, module);
      log.info(`[Extensions] Registered private extension: ${manifest.id}`);
    } catch (e) {
      log.warn({ err: e }, `[Extensions] Failed to load private extension from ${path}`);
    }
  }
}
