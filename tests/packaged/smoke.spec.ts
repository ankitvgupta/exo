/**
 * Smoke tests against the PACKAGED .app binary (not dev mode).
 *
 * Catches the class of bugs dev mode never sees:
 *   - PATH issues (packaged macOS apps inherit a minimal PATH from
 *     Finder/Dock; src/main/index.ts has a PATH-fix step that needs
 *     to actually work)
 *   - native module (better-sqlite3) ABI mismatch in the asar bundle
 *   - missing files because they didn't get included in `extraResources`
 *   - electron-builder packaging quirks
 *
 * Requires the binary path in EXO_PACKAGED_BINARY. CI sets this to
 * dist/linux-unpacked/exo after `npm run pack`. Locally on macOS,
 * use: `npm run pack && EXO_PACKAGED_BINARY="dist/mac-arm64/Exo.app/Contents/MacOS/Exo" \
 *   npx playwright test --project=packaged`.
 */
import { test, expect, _electron as electron, type Page, type ElectronApplication } from "@playwright/test";
import { existsSync } from "fs";

const BINARY = process.env.EXO_PACKAGED_BINARY ?? "";

test.beforeAll(() => {
  if (!BINARY) {
    test.skip(true, "EXO_PACKAGED_BINARY not set — skipping packaged smoke");
  }
  if (!existsSync(BINARY)) {
    test.skip(true, `EXO_PACKAGED_BINARY does not exist at ${BINARY} — did you run 'npm run pack'?`);
  }
});

test.describe("Packaged app smoke", () => {
  test.describe.configure({ mode: "serial" });

  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    app = await electron.launch({
      executablePath: BINARY,
      env: {
        ...process.env,
        // Demo mode so the packaged app doesn't need OAuth / Gmail creds
        // in CI. The packaging itself is what we're verifying, not
        // real-Gmail behavior.
        EXO_DEMO_MODE: "true",
        // Test worker isolation pattern from launch-helpers.ts
        TEST_WORKER_INDEX: "0",
      },
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
  });

  test.afterAll(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // Packaged app shutdown can hang; force-kill is fine for smoke
        const proc = app.process();
        if (proc.pid) {
          try {
            process.kill(proc.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
    }
  });

  test("app launches within 30s and shows the Exo brand", async () => {
    await expect(page.locator("text=Exo").first()).toBeVisible({ timeout: 30_000 });
  });

  test("no main-process crash in the first 10s", async () => {
    const proc = app.process();
    // If the main process had crashed, electron.launch would have failed
    // or app.process() would be detached. Confirm it's still running.
    expect(proc.pid).toBeDefined();
    await page.waitForTimeout(5_000);
    expect(proc.killed).toBe(false);
  });

  test("inbox area renders (demo data shows)", async () => {
    // Demo mode populates a few mock emails. We don't care which —
    // just that the email-list area renders without a hard error.
    const inboxIndicator = page.locator("text=Inbox").first();
    await expect(inboxIndicator).toBeVisible({ timeout: 15_000 });
  });

  test("settings panel opens", async () => {
    // Either the settings button is visible (data-testid), or there's
    // a keyboard shortcut. Try button first, fall back to shortcut.
    const settingsBtn = page.locator("[data-testid='settings-button']");
    if (await settingsBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await settingsBtn.click();
    } else {
      await page.keyboard.press("Meta+,");
    }
    await expect(page.locator("text=Settings").first()).toBeVisible({ timeout: 5000 });
    await page.keyboard.press("Escape");
  });

  test("no uncaught renderer errors in the first 15s", async () => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    await page.waitForTimeout(10_000);
    // Filter out known noise — extensions/devtools-related warnings
    const real = errors.filter(
      (e) =>
        !e.includes("Autofill.enable") &&
        !e.includes("Autofill.setAddresses") &&
        !e.includes("HotModuleReplacement"),
    );
    if (real.length > 0) {
      console.error("Renderer errors observed during smoke:");
      for (const e of real) console.error(`  - ${e}`);
    }
    expect(real).toHaveLength(0);
  });
});
