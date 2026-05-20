/**
 * Centralized data directory resolution.
 *
 * Non-packaged runs (`!app.isPackaged`) use a project-local `.dev-data/`
 * directory so development never touches production data in
 * `~/Library/Application Support/exo/`.
 *
 * Only packaged (released) builds use `app.getPath("userData")`.
 *
 * As of 2026-05-20, dev runs start with an empty `.dev-data/` and
 * authenticate fresh against the test Gmail account (`exoemailtest@gmail.com`).
 * Real-account state is never copied into dev — the prior bootstrap that
 * pulled tokens/db from the production directory has been removed.
 *
 * Electron is **lazy-required** so this module can be imported in
 * non-Electron contexts (e.g. eval runners under tsx) without crashing.
 * When Electron isn't available, getDataDir() returns a tmpdir-based
 * path scoped by EXO_NON_ELECTRON_DATA_DIR if set, or a default scratch
 * directory. Tests / eval runners SHOULD set EXO_NON_ELECTRON_DATA_DIR
 * if they want isolation, but the default path is safe (separate from
 * .dev-data/, so production-mode dev runs aren't affected).
 */
import { join } from "path";
import { tmpdir } from "os";
import { createRequire } from "module";

const requireFromHere = createRequire(import.meta.url);

let _devDataDir: string | null = null;

interface ElectronShape {
  app: { isPackaged: boolean; getPath: (k: string) => string; getAppPath: () => string };
  is?: { dev: boolean };
}

function tryLoadElectron(): ElectronShape | null {
  try {
    const electron = requireFromHere("electron") as Partial<ElectronShape>;
    if (!electron.app || typeof electron.app.getPath !== "function") {
      // Electron's "main" module returns a string (the binary path) when
      // imported in a non-Electron Node process. Detect and treat as
      // unavailable.
      return null;
    }
    return electron as ElectronShape;
  } catch {
    return null;
  }
}

function tryLoadElectronToolkit(): { is: { dev: boolean } } | null {
  try {
    return requireFromHere("@electron-toolkit/utils") as { is: { dev: boolean } };
  } catch {
    return null;
  }
}

export function getDataDir(): string {
  const electron = tryLoadElectron();
  if (!electron) {
    // Non-Electron caller (eval runner, unit test under tsx, etc.).
    // Use a stable scratch path so the caller can clean up if needed.
    return process.env.EXO_NON_ELECTRON_DATA_DIR ?? join(tmpdir(), "exo-non-electron-data");
  }

  const toolkit = tryLoadElectronToolkit();
  const isDev = toolkit ? toolkit.is.dev : !electron.app.isPackaged;

  if (!isDev) return electron.app.getPath("userData");

  if (!_devDataDir) {
    _devDataDir = join(electron.app.getAppPath(), ".dev-data");
  }
  return _devDataDir;
}
