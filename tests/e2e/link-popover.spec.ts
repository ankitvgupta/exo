import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp } from "./launch-helpers";

/**
 * E2E Tests for Link Popover in Compose Editor
 *
 * Verifies the fix for #66: window.prompt() replaced with inline popover.
 * Tests that clicking the link button opens a popover (not a prompt()),
 * that URLs can be entered and applied, and that the popover dismisses correctly.
 */

test.describe("Link Popover", () => {
  test.describe.configure({ mode: "serial" });
  let electronApp: ElectronApplication;
  let page: Page;

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });

    // Open compose view
    const composeButton = page.locator("button:has-text('Compose')");
    await expect(composeButton).toBeVisible();
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5000 });

    // Type some text in the editor so we have content to work with
    const editor = page.locator(".ProseMirror").first();
    await expect(editor).toBeVisible({ timeout: 5000 });
    await editor.click();
    await page.keyboard.type("Click here for example");
    await page.waitForTimeout(300);
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("link button opens inline popover instead of window.prompt()", async () => {
    // Find the link toolbar button (has title "Insert link")
    const linkButton = page.locator('button[title="Insert link"]');
    await expect(linkButton).toBeVisible();

    // Click the link button — should open a popover, NOT call window.prompt()
    await linkButton.click();
    await page.waitForTimeout(300);

    // The popover should contain a URL input and an Apply button
    const urlInput = page.locator('input[type="url"]');
    await expect(urlInput).toBeVisible({ timeout: 2000 });

    const applyButton = page.locator('button:has-text("Apply")');
    await expect(applyButton).toBeVisible();

    // Default value should be https://
    await expect(urlInput).toHaveValue("https://");

    // Close by toggling the button
    await linkButton.click();
    await page.waitForTimeout(200);
    await expect(urlInput).not.toBeVisible();
  });

  test("can enter a URL and apply it to selected text", async () => {
    const editor = page.locator(".ProseMirror").first();

    // Select "Click here" (first 10 chars)
    await editor.click();
    await page.keyboard.press("Home");
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Shift+ArrowRight");
    }
    await page.waitForTimeout(200);

    // Open link popover
    const linkButton = page.locator('button[title="Insert link"]');
    await linkButton.click();
    await page.waitForTimeout(300);

    // Fill in a URL
    const urlInput = page.locator('input[type="url"]');
    await expect(urlInput).toBeVisible({ timeout: 2000 });
    await urlInput.fill("https://example.com");

    // Click Apply
    const applyButton = page.locator('button:has-text("Apply")');
    await applyButton.click();
    await page.waitForTimeout(300);

    // Popover should be closed
    await expect(page.locator('input[type="url"]')).not.toBeVisible();

    // The text should now be a link
    const link = editor.locator('a[href="https://example.com"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText("Click here");
  });

  test("clicking link button toggles popover open and closed", async () => {
    const linkButton = page.locator('button[title="Insert link"]');
    const urlInput = page.locator('input[type="url"]');

    // Open
    await linkButton.click();
    await page.waitForTimeout(300);
    await expect(urlInput).toBeVisible({ timeout: 2000 });

    // Close by clicking button again
    await linkButton.click();
    await page.waitForTimeout(300);
    await expect(urlInput).not.toBeVisible();
  });

  test("popover dismisses on click outside", async () => {
    // Click the link button
    const linkButton = page.locator('button[title="Insert link"]');
    await linkButton.click();
    await page.waitForTimeout(300);

    const urlInput = page.locator('input[type="url"]');
    await expect(urlInput).toBeVisible({ timeout: 2000 });

    // Click somewhere outside (the editor body)
    const editor = page.locator(".ProseMirror").first();
    await editor.click({ position: { x: 5, y: 5 } });
    await page.waitForTimeout(300);

    // Popover should be gone
    await expect(urlInput).not.toBeVisible();
  });

  test("Enter key in URL input applies the link", async () => {
    const editor = page.locator(".ProseMirror").first();

    // Move to end and type new text
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" visit site");
    await page.waitForTimeout(200);

    // Select "visit site"
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Shift+ArrowLeft");
    }

    // Open link popover
    const linkButton = page.locator('button[title="Insert link"]');
    await linkButton.click();
    await page.waitForTimeout(300);

    const urlInput = page.locator('input[type="url"]');
    await expect(urlInput).toBeVisible({ timeout: 2000 });
    await urlInput.fill("https://test.com");

    // Press Enter to apply
    await urlInput.press("Enter");
    await page.waitForTimeout(300);

    // Popover should close
    await expect(urlInput).not.toBeVisible();

    // Link should be applied
    const link = editor.locator('a[href="https://test.com"]');
    await expect(link).toBeVisible();
  });

  test("existing link shows Remove button and pre-fills URL", async () => {
    const editor = page.locator(".ProseMirror").first();

    // Click on the link we created earlier
    const link = editor.locator('a[href="https://example.com"]');
    await link.click();
    await page.waitForTimeout(200);

    // Open link popover — should show the existing URL
    const linkButton = page.locator('button[title="Insert link"]');
    await linkButton.click();
    await page.waitForTimeout(300);

    const urlInput = page.locator('input[type="url"]');
    await expect(urlInput).toBeVisible({ timeout: 2000 });
    await expect(urlInput).toHaveValue("https://example.com");

    // Remove button should be visible for existing links
    const removeButton = page.locator('button:has-text("Remove")');
    await expect(removeButton).toBeVisible();

    // Click Remove to unlink
    await removeButton.click();
    await page.waitForTimeout(300);

    // Popover should close
    await expect(urlInput).not.toBeVisible();

    // The text should no longer be a link
    await expect(editor.locator('a[href="https://example.com"]')).not.toBeVisible();
  });

  test("no window.prompt errors in console", async () => {
    // Verify no "prompt() is not supported" errors were logged
    const errors: string[] = [];
    const errorHandler = (msg: { type: () => string; text: () => string }) => {
      if (msg.type() === "error" && msg.text().includes("prompt")) {
        errors.push(msg.text());
      }
    };
    page.on("console", errorHandler);

    // Click the link button one more time
    const linkButton = page.locator('button[title="Insert link"]');
    await linkButton.click();
    await page.waitForTimeout(500);

    await linkButton.click();
    await page.waitForTimeout(200);

    page.removeListener("console", errorHandler);
    expect(errors).toHaveLength(0);
  });
});
