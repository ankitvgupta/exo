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
 */
import { app } from "electron";
import { join } from "path";
import { is } from "@electron-toolkit/utils";

let _devDataDir: string | null = null;

export function getDataDir(): string {
  if (!is.dev) return app.getPath("userData");

  if (!_devDataDir) {
    _devDataDir = join(app.getAppPath(), ".dev-data");
  }
  return _devDataDir;
}
