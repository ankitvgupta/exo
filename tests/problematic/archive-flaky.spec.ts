import { test, expect, _electron as electron, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Flaky archive/trash tests extracted from tests/e2e/archive.spec.ts
 *
 * These tests pass individually but fail in the full suite due to:
 * - Demo database state isolation issues
 * - Timing-sensitive keyboard event handling in Electron
 * - Shared state between tests in serial mode
 *
 * To run these tests: npx playwright test tests/problematic/archive-flaky.spec.ts
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

/** Count inbox thread rows (buttons inside the email list scroll container). */
async function countInboxThreads(page: Page): Promise<number> {
  const rows = page.locator(".overflow-y-auto > div > button");
  return rows.count();
}

/** Get the text content of the currently selected email row. */
async function getSelectedRowText(page: Page): Promise<string | null> {
  const selected = page.locator(".overflow-y-auto button.bg-blue-600").first();
  if (await selected.isVisible().catch(() => false)) {
    return selected.textContent();
  }
  return null;
}

/** Select the first inbox thread by pressing 'j' and wait for selection. */
async function selectFirstThread(page: Page): Promise<void> {
  await page.keyboard.press("j");
  await page.waitForTimeout(300);
  const selected = page.locator(".overflow-y-auto button.bg-blue-600");
  await expect(selected).toBeVisible({ timeout: 3000 });
}

// ---------------------------------------------------------------------------
// Archive persistence — email should not come back after re-fetch
// ---------------------------------------------------------------------------
// This test passes individually but fails in the full suite due to demo database
// state isolation issues. Earlier tests archive emails which affects this test's count.
test.describe("Archive - Persistence", () => {
  test.describe.configure({ mode: 'serial' });
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

  test("archived email does not reappear after clicking Refresh", async () => {
    await page.waitForTimeout(1000);
    await selectFirstThread(page);

    const archivedText = await getSelectedRowText(page);
    expect(archivedText).toBeTruthy();

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(1);

    // Archive
    await page.keyboard.press("e");
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 2000 });

    // Click Refresh — this triggers sync:get-emails which re-fetches from DB
    const refreshButton = page.locator("button[title='Refresh']");
    await refreshButton.click();
    await page.waitForTimeout(2000);

    // The archived email should still be gone
    const countAfterRefresh = await countInboxThreads(page);
    expect(countAfterRefresh).toBe(countBefore - 1);

    // Verify the specific text is not in the list
    const allRowTexts = await page.locator(".overflow-y-auto > div > button").allTextContents();
    const stillPresent = allRowTexts.some((t) => t === archivedText);
    expect(stillPresent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Rapid-succession archive tests
// ---------------------------------------------------------------------------
// These tests are inherently flaky due to timing-sensitive keyboard event handling
// in Electron. The core archive functionality is tested in "Archive - Optimistic UI".
test.describe("Archive - Rapid Succession", () => {
  test.describe.configure({ mode: 'serial' });
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

  test("can archive multiple threads in rapid succession", async () => {
    await page.waitForTimeout(1000);
    await selectFirstThread(page);

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(3);

    for (let i = 0; i < 3; i++) {
      await expect(page.locator(".overflow-y-auto button.bg-blue-600")).toBeVisible({ timeout: 3000 });
      await page.waitForTimeout(200);

      const before = await countInboxThreads(page);
      await page.keyboard.press("e");

      // Wait for count to decrease
      await expect(async () => {
        const after = await countInboxThreads(page);
        expect(after).toBe(before - 1);
      }).toPass({ timeout: 3000 });
    }

    // Total: 3 fewer than when we started
    const countAfter = await countInboxThreads(page);
    expect(countAfter).toBe(countBefore - 3);
  });
});

// ---------------------------------------------------------------------------
// Rapid-succession trash tests
// ---------------------------------------------------------------------------
// These tests are inherently flaky due to timing-sensitive keyboard event handling
// in Electron. The core trash functionality is tested in the single-thread test.
test.describe("Trash - Rapid Succession", () => {
  test.describe.configure({ mode: 'serial' });
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

  test("can trash multiple threads in rapid succession", async () => {
    await page.waitForTimeout(1000);
    const isSelected = await page.locator(".overflow-y-auto button.bg-blue-600").isVisible().catch(() => false);
    if (!isSelected) {
      await selectFirstThread(page);
    }

    const countBefore = await countInboxThreads(page);
    expect(countBefore).toBeGreaterThan(2);

    // Trash first thread and wait for count to decrease
    await page.keyboard.type("#");
    await expect(async () => {
      const count = await countInboxThreads(page);
      expect(count).toBe(countBefore - 1);
    }).toPass({ timeout: 3000 });

    // Ensure selection is still visible before second trash
    await expect(page.locator(".overflow-y-auto button.bg-blue-600")).toBeVisible({ timeout: 2000 });
    await page.waitForTimeout(200);

    // Trash second thread
    await page.keyboard.type("#");
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 2);
    }).toPass({ timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// Navigation edge case - navigate then archive
// ---------------------------------------------------------------------------
// This test is flaky due to shared state with previous test in serial mode.
// The core navigation and archive functionality is tested in other describe blocks.
test.describe("Archive - Navigate Then Archive", () => {
  test.describe.configure({ mode: 'serial' });
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

  test("navigate down then archive selects the next thread", async () => {
    // Wait for page to be ready and click to ensure focus
    await page.waitForTimeout(500);
    await page.locator("body").click();
    await page.waitForTimeout(200);

    // Select first thread
    await selectFirstThread(page);

    // Navigate down twice to get to the third thread
    await page.keyboard.press("j");
    await page.waitForTimeout(300);
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    // Verify selection is active before measuring count
    await expect(page.locator(".overflow-y-auto button.bg-blue-600")).toBeVisible({ timeout: 2000 });

    const countBefore = await countInboxThreads(page);
    const selectedBefore = await getSelectedRowText(page);
    expect(selectedBefore).toBeTruthy();

    // Ensure focus is on page (not in an input field) before archive
    await page.locator(".overflow-y-auto button.bg-blue-600").focus();
    await page.waitForTimeout(100);

    // Archive the current thread
    await page.keyboard.press("e");

    // Count should decrease
    await expect(async () => {
      const countAfter = await countInboxThreads(page);
      expect(countAfter).toBe(countBefore - 1);
    }).toPass({ timeout: 3000 });

    // A new thread should be selected (not the same one)
    const selectedAfter = await getSelectedRowText(page);
    expect(selectedAfter).toBeTruthy();
    expect(selectedAfter).not.toBe(selectedBefore);
  });
});
