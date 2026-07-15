import { test, expect } from "@playwright/test";
import { readFileSync, readdirSync, statSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join, relative } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");

/**
 * Regression guard for the prod-config wipe (July 2026).
 *
 * `clean_test_dbs()` in scripts/run-tests.sh used to `rm -f` the
 * electron-store config from the GLOBAL per-user app dirs — including the
 * packaged app's real install dir — so every `npm test` deleted the user's
 * production API keys and settings. Dev/test state lives exclusively in the
 * project-local `.dev-data/` (src/main/data-dir.ts), so no script or test
 * has any business referencing the global app-data locations.
 *
 * Like data-dir.spec.ts, this guards at the file-content level: any mention
 * of a global app-data path in scripts/ or tests/ is a bug waiting to fire,
 * regardless of how it's used.
 */

const FORBIDDEN = [
  "Application Support/exo",
  "Application Support/Electron",
  ".config/exo",
  ".config/Electron",
];

const SCAN_ROOTS = ["scripts", "tests"];
const TEXT_EXTENSIONS = [".sh", ".mjs", ".js", ".ts", ".tsx"];
const SELF = fileURLToPath(import.meta.url);

function collectFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules") continue;
    if (statSync(full).isDirectory()) {
      collectFiles(full, out);
    } else if (TEXT_EXTENSIONS.some((ext) => entry.endsWith(ext)) && full !== SELF) {
      out.push(full);
    }
  }
}

test("scripts/ and tests/ never reference global per-user app-data dirs", () => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    collectFiles(join(REPO_ROOT, root), files);
  }
  expect(files.length).toBeGreaterThan(0);

  const violations: string[] = [];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    for (const fragment of FORBIDDEN) {
      if (content.includes(fragment)) {
        violations.push(`${relative(REPO_ROOT, file)} contains "${fragment}"`);
      }
    }
  }
  expect(violations).toEqual([]);
});
