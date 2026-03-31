import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { ExtensionManifestSchema, type ExtensionManifest } from "../../shared/extension-types";
import { createLogger } from "../services/logger";

const log = createLogger("manifest-loader");

/**
 * Load and validate an extension manifest from a package.json file
 */
export function loadManifest(extensionPath: string): ExtensionManifest | null {
  const packageJsonPath = join(extensionPath, "package.json");

  if (!existsSync(packageJsonPath)) {
    log.error(`[Extensions] No package.json found at ${extensionPath}`);
    return null;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

    if (!packageJson.mailExtension) {
      log.error(`[Extensions] No mailExtension field in ${packageJsonPath}`);
      return null;
    }

    const manifest = ExtensionManifestSchema.parse(packageJson.mailExtension);
    log.info(`[Extensions] Loaded manifest for ${manifest.id} (${manifest.displayName})`);

    return manifest;
  } catch (error) {
    log.error({ err: error }, `[Extensions] Failed to load manifest from ${packageJsonPath}`);
    return null;
  }
}

/**
 * Scan a single directory for extension paths
 */
function scanExtensionDirectory(dirPath: string): string[] {
  const paths: string[] = [];

  if (!existsSync(dirPath)) {
    return paths;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync, statSync } = require("fs");
    const entries = readdirSync(dirPath);

    for (const entry of entries) {
      const fullPath = join(dirPath, entry);
      if (statSync(fullPath).isDirectory()) {
        const packageJsonPath = join(fullPath, "package.json");
        if (existsSync(packageJsonPath)) {
          paths.push(fullPath);
        }
      }
    }
  } catch (error) {
    log.error({ err: error }, `[Extensions] Failed to scan extensions at ${dirPath}`);
  }

  return paths;
}

/**
 * Find all extension paths from multiple directories
 */
export function findExtensionPaths(...extensionDirs: (string | undefined)[]): string[] {
  const paths: string[] = [];

  for (const dir of extensionDirs) {
    if (dir) {
      paths.push(...scanExtensionDirectory(dir));
    }
  }

  return paths;
}
