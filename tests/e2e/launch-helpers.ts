import { _electron as electron, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, "../../tests/screenshots");

export type LaunchOptions = {
  workerIndex?: number;
  extraEnv?: Record<string, string>;
  waitAfterLoad?: number;
};

/**
 * Launch Electron app for E2E testing with per-worker database isolation.
 *
 * Each worker gets its own database file (e.g. exo-demo-w0.db)
 * so E2E tests can run fully in parallel without state conflicts.
 */
export async function launchElectronApp(
  options: LaunchOptions = {},
): Promise<{ app: ElectronApplication; page: Page }> {
  const { workerIndex = 0, extraEnv = {}, waitAfterLoad } = options;

  const app = await electron.launch({
    args: [path.join(__dirname, "../../out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      EXO_DEMO_MODE: "true",
      TEST_WORKER_INDEX: String(workerIndex),
      ...extraEnv,
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForSelector("text=Exo", { timeout: 15000 });

  // The app defaults to the Priority tab. Switch to "All" so tests see every
  // email in the demo inbox (most tests search for specific emails by name).
  const allTab = window.locator("button").filter({ hasText: /^All\s*\d*$/ }).first();
  try {
    await allTab.waitFor({ state: "visible", timeout: 3000 });
    await allTab.click();
    await window.waitForTimeout(300);
  } catch {
    // Tab may not be visible yet (e.g. before sync completes) — continue
  }

  if (waitAfterLoad) {
    await window.waitForTimeout(waitAfterLoad);
  }

  return { app, page: window };
}

/**
 * Best-effort screenshot capture, disabled by default.
 * Set E2E_SCREENSHOTS=true to enable (useful for debugging test failures).
 *
 * Uses Electron's native capturePage first (more reliable under xvfb),
 * falls back to Playwright's page.screenshot.
 */
export async function takeScreenshot(
  app: ElectronApplication,
  page: Page,
  name: string,
  description?: string,
) {
  if (process.env.E2E_SCREENSHOTS !== "true") return;

  // Brief settle time before capture (carried over from screenshot-reply-buttons.spec.ts)
  await page.waitForTimeout(500);

  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const filename = `${name}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);

  try {
    const imageBuffer = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return "";
      const image = await win.webContents.capturePage();
      return image.toPNG().toString("base64");
    });

    if (imageBuffer && imageBuffer.length > 0) {
      fs.writeFileSync(filepath, Buffer.from(imageBuffer, "base64"));
      console.log(`  [screenshot] ${filename}${description ? ` - ${description}` : ""}`);
      return;
    }
  } catch {
    // Fall through to Playwright screenshot
  }

  try {
    await page.screenshot({ path: filepath, timeout: 5000 });
    console.log(`  [screenshot] ${filename} (fallback)${description ? ` - ${description}` : ""}`);
  } catch {
    console.log(`  [screenshot] ${filename} - SKIPPED`);
  }
}
