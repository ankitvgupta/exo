import { test, expect, _electron as electron, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E Tests for Archive Ready (split-tab UI)
 *
 * Tests the archive-ready feature as a split tab:
 * - Tab appears with correct count
 * - Clicking tab filters to archive-ready threads
 * - Archive All button in header
 * - Archive All clears view and returns to "All" inbox
 *
 * Run with: npm run test:e2e -- --grep "Archive Ready"
 */

async function launchElectronApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [path.join(__dirname, "../../out/main/index.js")],
    env: {
      ...process.env,
      NODE_ENV: "test",
      EXO_DEMO_MODE: "true",
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForSelector("text=Exo", { timeout: 15000 });

  return { app, page: window };
}

test.describe("Archive Ready — Split Tab", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectronApp();
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("Archive Ready tab appears in split tabs with count", async () => {
    // The split tabs bar should show an "Archive Ready" tab with the count of demo threads (6)
    const archiveTab = page.locator("button:has-text('Archive Ready')");
    await expect(archiveTab).toBeVisible({ timeout: 10000 });

    // The tab should display a count
    const tabText = await archiveTab.textContent();
    // Demo mode seeds 6 archive-ready threads
    expect(tabText).toContain("6");
  });

  test("clicking Archive Ready tab filters to archive-ready threads", async () => {
    // The split tabs bar has overflow-x-auto; the "All" tab is the first button in it
    const splitTabsBar = page.locator("div.overflow-x-auto");
    const allTab = splitTabsBar.locator("button").first();
    await expect(allTab).toBeVisible();
    const allTabText = await allTab.textContent();
    expect(allTabText).toContain("All");
    const allCountMatch = allTabText?.match(/(\d+)/);
    const allCount = allCountMatch ? parseInt(allCountMatch[1], 10) : 0;
    expect(allCount).toBeGreaterThan(0);

    // Click the Archive Ready tab
    const archiveTab = page.locator("button:has-text('Archive Ready')");
    await archiveTab.click();
    await page.waitForTimeout(500);

    // Header should now say "Archive Ready"
    const header = page.locator("span.text-sm.font-medium:has-text('Archive Ready')");
    await expect(header).toBeVisible();

    // The header shows thread count in parentheses — should be 6 for demo
    const headerText = await header.textContent();
    expect(headerText).toContain("6");
  });

  test("Archive All button visible in header when tab is active", async () => {
    // Ensure we're on the archive-ready tab
    const archiveTab = page.locator("button:has-text('Archive Ready')");
    await archiveTab.click();
    await page.waitForTimeout(300);

    // "Archive All" button should be visible in the header
    const archiveAllBtn = page.locator("button:has-text('Archive All')");
    await expect(archiveAllBtn).toBeVisible();
  });

  test("Archive All clears view and returns to All inbox", async () => {
    // Ensure we're on the archive-ready tab
    const archiveTab = page.locator("button:has-text('Archive Ready')");
    await archiveTab.click();
    await page.waitForTimeout(300);

    // Click Archive All
    const archiveAllBtn = page.locator("button:has-text('Archive All')");
    await archiveAllBtn.click();

    // Wait for the action to complete
    await page.waitForTimeout(1000);

    // Should be back on the "All" inbox (header says "Inbox")
    const header = page.locator("span.text-sm.font-medium");
    await expect(header).toContainText("Inbox", { timeout: 5000 });

    // The inbox should still have threads visible (email rows in the list)
    const threadCount = await header.textContent();
    const countMatch = threadCount?.match(/\((\d+)\)/);
    const count = countMatch ? parseInt(countMatch[1], 10) : 0;
    expect(count).toBeGreaterThan(0);

    // Archive Ready tab should no longer be visible (count is 0, tabs bar hidden)
    await expect(page.locator("button:has-text('Archive Ready')")).not.toBeVisible({ timeout: 3000 });
  });
});

test.describe("Archive Ready — Settings", () => {
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    const result = await launchElectronApp();
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("archive-ready prompt is configurable in settings", async () => {
    // Open settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await page.waitForTimeout(500);

    // Click Prompts tab
    const promptsTab = page.locator("button:has-text('Prompts')");
    await expect(promptsTab).toBeVisible({ timeout: 5000 });
    await promptsTab.click();
    await page.waitForTimeout(300);

    // Should show Archive Ready Prompt textarea
    const archiveReadyLabel = page.locator("text=Archive Ready Prompt");
    await expect(archiveReadyLabel).toBeVisible();
  });
});
