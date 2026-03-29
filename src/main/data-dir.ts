/**
 * Centralized data directory resolution.
 *
 * Any non-packaged run (`!app.isPackaged`) uses a project-local `.dev-data/`
 * directory so that development never touches production data in
 * `~/Library/Application Support/exo/`.
 *
 * Only packaged (released) builds use `app.getPath("userData")`.
 */
import { app } from "electron";
import { join } from "path";
import { existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from "fs";
import { is } from "@electron-toolkit/utils";

let _devDataDir: string | null = null;
const BOOTSTRAP_MARKER = ".bootstrapped";

export function getDataDir(): string {
  if (!is.dev) return app.getPath("userData");

  if (!_devDataDir) {
    _devDataDir = join(app.getAppPath(), ".dev-data");
  }
  return _devDataDir;
}

/**
 * On first dev run, bootstrap `.dev-data/` by copying key files from the
 * production data directory so OAuth tokens, credentials, config, and the
 * database are available without manual setup.
 *
 * Safe to call multiple times — uses a marker file to detect prior bootstrap
 * (the directory itself may be created early by electron-store or mkdirSync).
 */
export function initDevData(): void {
  if (!is.dev) return;

  const devDir = getDataDir();
  // Use a marker file, not directory existence, since other modules may
  // create the directory before this function runs (e.g. electron-store).
  if (existsSync(join(devDir, BOOTSTRAP_MARKER))) return;

  const prodDir = app.getPath("userData");
  if (!existsSync(prodDir)) {
    // No production data to copy — still write the marker so we don't
    // re-check on every startup.
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(devDir, BOOTSTRAP_MARKER), new Date().toISOString());
    console.log("[DataDir] No production data found, created empty dev data directory");
    return;
  }

  console.log(`[DataDir] Bootstrapping dev data directory: ${devDir}`);
  mkdirSync(devDir, { recursive: true });

  // Copy top-level config/credential files
  const filesToCopy = ["credentials.json"];
  // Also copy token files (tokens.json + tokens-{accountId}.json)
  try {
    const entries = readdirSync(prodDir);
    for (const entry of entries) {
      if (entry === "tokens.json" || /^tokens-.+\.json$/.test(entry)) {
        filesToCopy.push(entry);
      }
    }
  } catch { /* ignore */ }

  for (const file of filesToCopy) {
    const src = join(prodDir, file);
    const dst = join(devDir, file);
    if (existsSync(src) && !existsSync(dst)) {
      try {
        copyFileSync(src, dst);
        console.log(`[DataDir]   Copied ${file}`);
      } catch (e) {
        console.warn(`[DataDir]   Failed to copy ${file}:`, e);
      }
    }
  }

  // Copy database (including WAL/SHM so all committed data is present).
  // Note: if the production app is running, these non-atomic copies may produce
  // an inconsistent snapshot. For safety, close the production app before the
  // first dev run. On subsequent runs this is skipped (marker file).
  const prodDbDir = join(prodDir, "data");
  const devDbDir = join(devDir, "data");
  if (existsSync(prodDbDir)) {
    mkdirSync(devDbDir, { recursive: true });
    const dbFiles = ["exo.db", "exo.db-wal", "exo.db-shm"];
    for (const dbFile of dbFiles) {
      const src = join(prodDbDir, dbFile);
      const dst = join(devDbDir, dbFile);
      if (existsSync(src) && !existsSync(dst)) {
        try {
          copyFileSync(src, dst);
          console.log(`[DataDir]   Copied data/${dbFile}`);
        } catch (e) {
          console.warn(`[DataDir]   Failed to copy data/${dbFile}:`, e);
        }
      }
    }
  }

  // Copy electron-store config files
  const storeFiles = ["exo-config.json", "exo-splits.json"];
  for (const storeFile of storeFiles) {
    const storeSrc = join(prodDir, storeFile);
    const storeDst = join(devDir, storeFile);
    if (existsSync(storeSrc) && !existsSync(storeDst)) {
      try {
        copyFileSync(storeSrc, storeDst);
        console.log(`[DataDir]   Copied ${storeFile}`);
      } catch (e) {
        console.warn(`[DataDir]   Failed to copy ${storeFile}:`, e);
      }
    }
  }

  // Write marker so we don't re-bootstrap on next launch
  writeFileSync(join(devDir, BOOTSTRAP_MARKER), new Date().toISOString());

  console.log("[DataDir] Dev data directory bootstrapped");
}
