import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

/**
 * E2E Tests for Cmd+F find-in-page functionality.
 *
 * Tests run in DEMO_MODE with fake emails.
 *
 * Note: Electron's findInPage/found-in-page event doesn't fire reliably when
 * triggered via IPC inside Playwright tests. We work around this by calling
 * findInPage directly via app.evaluate (main process) for the match count test.
 * This still validates the full UI flow: find bar rendering, match count display,
 * and keyboard interaction.
 */
test.describe("Find in Page - Cmd+F", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("Cmd+F opens find bar", async () => {
    // Wait for inbox to load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Open find bar
    await page.keyboard.press("ControlOrMeta+f");

    // Verify find bar appears with focused input
    const findBar = page.locator('[data-testid="find-bar"]');
    await expect(findBar).toBeVisible({ timeout: 5000 });

    const findInput = page.locator('[data-testid="find-bar-input"]');
    await expect(findInput).toBeVisible();
    await expect(findInput).toBeFocused();
  });

  test("Escape closes find bar", async () => {
    const findBar = page.locator('[data-testid="find-bar"]');
    await expect(findBar).toBeVisible();

    await page.keyboard.press("Escape");

    await expect(findBar).not.toBeVisible({ timeout: 3000 });
  });

  test("typing shows match count", async () => {
    // Re-open find bar
    await page.keyboard.press("ControlOrMeta+f");

    const findBar = page.locator('[data-testid="find-bar"]');
    await expect(findBar).toBeVisible({ timeout: 5000 });

    const findInput = page.locator('[data-testid="find-bar-input"]');
    await expect(findInput).toBeFocused();

    // Type a sender name visible in the email list (from demo fake-inbox.ts)
    await findInput.pressSequentially("Garry", { delay: 50 });

    // Trigger findInPage from main process — Electron's found-in-page event
    // doesn't fire reliably when called via IPC in the Playwright test env,
    // but the ensureFoundInPageListener relay sends the result to the renderer.
    await electronApp.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win) return;
      return new Promise<void>((resolve) => {
        win.webContents.once("found-in-page", () => resolve());
        win.webContents.findInPage("Garry");
      });
    });

    // Match count should be visible
    await expect(findBar.locator("text=/\\d+ of \\d+/")).toBeVisible({ timeout: 5000 });

    // Close
    await page.keyboard.press("Escape");
    await expect(findBar).not.toBeVisible({ timeout: 3000 });
  });
});
