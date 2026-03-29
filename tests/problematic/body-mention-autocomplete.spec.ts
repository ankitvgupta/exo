/**
 * E2E Tests for @mention autocomplete in draft body.
 *
 * MOVED TO PROBLEMATIC: The @mention feature was built for DraftEditor (textarea-based),
 * which was removed in PR #86. These tests need to be reimplemented for the
 * ProseMirror-based inline reply editor once @mention support is added there.
 */
import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "../e2e/launch-helpers";

test.describe("Body @mention Autocomplete → CC", () => {
  test.describe.configure({ mode: 'serial' });

  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.log(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  /** Navigate to an email with a pending draft so DraftEditor textarea is visible */
  async function navigateToDraftEditor() {
    // Click a HIGH priority email that has a pre-generated draft
    const emailItem = page.locator("button").filter({ hasText: /Sarah.*Chen|Project Alpha/i }).first();
    await expect(emailItem).toBeVisible({ timeout: 10000 });
    await emailItem.click();
    await page.waitForTimeout(500);

    // Generate draft if not already there
    const generateButton = page.locator("button:has-text('Generate Draft')");
    if (await generateButton.isVisible({ timeout: 2000 }).catch(() => false)) {
      await generateButton.click();
      // Demo mode has ~800ms delay
      await page.waitForTimeout(2000);
    }

    // Wait for the DraftEditor textarea to be visible
    const textarea = page.locator("textarea[placeholder='Draft reply...']");
    await expect(textarea).toBeVisible({ timeout: 5000 });
    return textarea;
  }

  test("@mention shows dropdown and Tab adds person to CC", async () => {
    const textarea = await navigateToDraftEditor();

    // Place cursor at end and type @ali to trigger mention
    await textarea.click();
    await textarea.press("End");
    await textarea.pressSequentially("\n@ali", { delay: 50 });

    // Wait for mention dropdown
    const mentionDropdown = page.locator("[data-testid='mention-dropdown']");
    await expect(mentionDropdown).toBeVisible({ timeout: 3000 });

    // First suggestion should be auto-selected (selectedIndex=0), press Tab to confirm
    await textarea.press("Tab");

    // The mention dropdown should close
    await expect(mentionDropdown).not.toBeVisible({ timeout: 2000 });

    // The CC section should now be visible with Alice's email
    const ccSection = page.locator("[data-testid='address-input-cc']");
    await expect(ccSection).toBeVisible({ timeout: 3000 });

    const ccChip = page.locator("[data-testid='address-input-cc'] [data-testid='address-chip']").filter({ hasText: "alice@example.com" });
    await expect(ccChip).toBeVisible({ timeout: 2000 });

    // The body text should contain Alice's first name (not @ali or full name)
    const bodyText = await textarea.inputValue();
    expect(bodyText).toContain("Alice");
    expect(bodyText).not.toContain("Alice Johnson");
    expect(bodyText).not.toContain("@ali");
  });

  test("clicking @mention suggestion adds person to CC", async () => {
    // Body textarea should still be visible from previous test
    const textarea = page.locator("textarea[placeholder='Draft reply...']");
    await expect(textarea).toBeVisible({ timeout: 5000 });

    // Type @bob to trigger mention
    await textarea.click();
    await textarea.press("End");
    await textarea.pressSequentially("\n@bob", { delay: 50 });

    // Wait for mention dropdown
    const mentionDropdown = page.locator("[data-testid='mention-dropdown']");
    await expect(mentionDropdown).toBeVisible({ timeout: 3000 });

    // Click on Bob's suggestion
    const suggestion = page.locator("[data-testid='mention-suggestion']").filter({ hasText: "Bob Smith" });
    await expect(suggestion).toBeVisible({ timeout: 2000 });
    await suggestion.click();

    // Dropdown should close
    await expect(mentionDropdown).not.toBeVisible({ timeout: 2000 });

    // Bob should be added to CC
    const bobChip = page.locator("[data-testid='address-input-cc'] [data-testid='address-chip']").filter({ hasText: "bob@example.com" });
    await expect(bobChip).toBeVisible({ timeout: 2000 });

    // Body should contain Bob's first name only
    const bodyText = await textarea.inputValue();
    expect(bodyText).toContain("Bob");
    expect(bodyText).not.toContain("Bob Smith");
  });
});
