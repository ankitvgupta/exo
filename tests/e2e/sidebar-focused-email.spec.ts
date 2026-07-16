import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * E2E test: the removed right preview sidebar stays hidden in a multi-sender thread.
 */

test.describe("Preview sidebar is hidden in thread", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("clicking different emails in a multi-sender thread does not show the preview sidebar", async () => {
    // Wait for inbox to load
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 10000 });

    // Find and click the multi-sender thread
    const threadRow = page.locator("button").filter({ hasText: "Launch Readiness" }).first();
    await expect(threadRow).toBeVisible({ timeout: 5000 });
    await threadRow.click();

    // Wait for thread detail to load
    await expect(page.locator("h1").filter({ hasText: /Launch Readiness/ })).toBeVisible({
      timeout: 5000,
    });

    const previewSidebar = page.locator(".w-96.exo-preview-shell");
    const sidebarName = page.locator("[data-testid='sidebar-sender-name']");
    const sidebarEmail = page.locator("[data-testid='sidebar-sender-email']");
    await expect(previewSidebar).toBeHidden({ timeout: 5000 });
    await expect(sidebarName).toBeHidden({ timeout: 5000 });
    await expect(sidebarEmail).toBeHidden({ timeout: 5000 });

    // Click through each email in the thread and verify the right rail stays hidden.
    // Thread messages are rendered inside [data-email-id] wrappers.
    const emailIds = [
      "demo-multi-001",
      "demo-multi-002",
      "demo-multi-003",
      "demo-multi-004",
      "demo-multi-005",
      "demo-multi-006",
    ];
    for (const emailId of emailIds) {
      const emailWrapper = page.locator(`[data-email-id="${emailId}"]`);
      await expect(emailWrapper).toBeVisible({ timeout: 3000 });

      // Click the message row to toggle expand/collapse
      const clickTarget = emailWrapper.locator("button").first();
      await clickTarget.click();
      await page.waitForTimeout(500);

      // The click toggles the email. If it was already expanded, clicking
      // collapsed it (clearing focus). Re-click to expand and set focus.
      const expandedContent = emailWrapper.locator("div.group\\/msg");
      if (!(await expandedContent.isVisible().catch(() => false))) {
        await clickTarget.click();
        await page.waitForTimeout(500);
      }

      await expect(previewSidebar).toBeHidden({ timeout: 3000 });
      await expect(sidebarName).toBeHidden({ timeout: 3000 });
      await expect(sidebarEmail).toBeHidden({ timeout: 3000 });
    }
  });
});
