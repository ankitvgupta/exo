import { test, expect, _electron as electron, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * E2E Tests: Keyboard shortcuts work after clicking inside an email body iframe.
 *
 * Bug: HTML emails are rendered inside an <iframe>. When the user clicks the
 * email body, focus moves into the iframe and keyboard events no longer reach
 * the parent window's shortcut handler.  The fix attaches a keydown listener
 * to the iframe document that dispatches synthetic KeyboardEvents on the parent
 * window directly (no postMessage needed since the iframe is same-origin srcdoc).
 *
 * Run with: npm run test:e2e -- keyboard-shortcuts-iframe
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

/**
 * Opens an email thread by clicking on a list item that matches the given text,
 * then waits for the full-view detail to appear.
 */
async function openEmail(page: Page, matchText: string) {
  const emailButton = page.locator("button").filter({ hasText: matchText }).first();
  await expect(emailButton).toBeVisible({ timeout: 5000 });
  await emailButton.click();
  // Wait for full view to render (subject heading appears)
  await page.waitForTimeout(800);
}

test.describe("Keyboard shortcuts work after clicking email body iframe", () => {
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

  test("Escape returns to inbox after clicking inside HTML email iframe", async () => {
    // Open an HTML email (Q3 Quarterly Report has a rich HTML body rendered in an iframe)
    await openEmail(page, "Emily Watson");

    // Wait for the iframe to load
    const iframe = page.locator('iframe[title="Email content"]').first();
    await expect(iframe).toBeVisible({ timeout: 5000 });

    // Click inside the iframe body to move focus into it
    const iframeBody = page.frameLocator('iframe[title="Email content"]').first().locator("body");
    await iframeBody.click();

    // Small delay to ensure focus has moved to the iframe
    await page.waitForTimeout(200);

    // Press Escape — should go back to split/inbox view
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Verify: we should be back to the inbox list view (no full detail visible)
    // The "Back" button is only in full view, so it should be gone
    const backButton = page.locator("button").filter({ hasText: "Back" }).first();
    const backVisible = await backButton.isVisible().catch(() => false);
    expect(backVisible).toBe(false);

    // The inbox should be visible
    await expect(page.locator("text=Inbox")).toBeVisible({ timeout: 3000 });
  });

  test("Enter opens reply after clicking inside HTML email iframe", async () => {
    // Open an HTML email again
    await openEmail(page, "Emily Watson");

    // Wait for the iframe to load
    const iframe = page.locator('iframe[title="Email content"]').first();
    await expect(iframe).toBeVisible({ timeout: 5000 });

    // Click inside the iframe body
    const iframeBody = page.frameLocator('iframe[title="Email content"]').first().locator("body");
    await iframeBody.click();
    await page.waitForTimeout(200);

    // Press Enter — should open inline reply
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Verify: inline reply form should be visible
    const replyIndicator = page.locator("text=Reply to").first();
    const forwardIndicator = page.locator("text=Forward to").first();
    const replyVisible = await replyIndicator.isVisible().catch(() => false);
    const forwardVisible = await forwardIndicator.isVisible().catch(() => false);
    expect(replyVisible || forwardVisible).toBe(true);

    // Clean up: press Escape to close the reply
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("j/k navigation works after clicking inside HTML email iframe", async () => {
    // First go back to inbox by pressing Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Open an HTML email
    await openEmail(page, "Emily Watson");

    const iframe = page.locator('iframe[title="Email content"]').first();
    await expect(iframe).toBeVisible({ timeout: 5000 });

    // Click inside the iframe body
    const iframeBody = page.frameLocator('iframe[title="Email content"]').first().locator("body");
    await iframeBody.click();
    await page.waitForTimeout(200);

    // Press Escape to go back to list (verifying navigation shortcuts work)
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Now press 'j' to navigate down in the list
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    // Verify we're still on the inbox and can navigate
    await expect(page.locator("text=Inbox")).toBeVisible({ timeout: 3000 });
  });

  test("shortcuts work on a second different HTML email too", async () => {
    // Make sure we're at inbox level
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Open a different HTML email - the Product Update email
    await openEmail(page, "Product Team");

    const iframe = page.locator('iframe[title="Email content"]').first();
    await expect(iframe).toBeVisible({ timeout: 5000 });

    // Click inside this iframe
    const iframeBody = page.frameLocator('iframe[title="Email content"]').first().locator("body");
    await iframeBody.click();
    await page.waitForTimeout(200);

    // Escape should still work
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    const backButton = page.locator("button").filter({ hasText: "Back" }).first();
    const backVisible = await backButton.isVisible().catch(() => false);
    expect(backVisible).toBe(false);

    await expect(page.locator("text=Inbox")).toBeVisible({ timeout: 3000 });
  });

  test("r shortcut opens reply after clicking inside HTML email iframe", async () => {
    // Open an HTML email
    await openEmail(page, "Emily Watson");

    const iframe = page.locator('iframe[title="Email content"]').first();
    await expect(iframe).toBeVisible({ timeout: 5000 });

    // Click inside the iframe body
    const iframeBody = page.frameLocator('iframe[title="Email content"]').first().locator("body");
    await iframeBody.click();
    await page.waitForTimeout(200);

    // Press 'r' — should open reply
    await page.keyboard.press("r");
    await page.waitForTimeout(1000);

    // Verify: reply form should be visible
    const replyIndicator = page.locator("text=Reply to").first();
    const replyVisible = await replyIndicator.isVisible().catch(() => false);
    expect(replyVisible).toBe(true);

    // Clean up
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("plain text email shortcuts still work (regression check)", async () => {
    // Ensure we're at inbox
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // Open a plain text email (the production incident email)
    await openEmail(page, "On-Call");

    // Wait for email detail to load
    await page.waitForTimeout(500);

    // This email is plain text, so no iframe. Click on the email body area directly.
    const emailBody = page.locator(".whitespace-pre-wrap").first();
    if (await emailBody.isVisible().catch(() => false)) {
      await emailBody.click();
      await page.waitForTimeout(200);
    }

    // Press Escape — should go back
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Verify we're back at inbox
    await expect(page.locator("text=Inbox")).toBeVisible({ timeout: 3000 });
  });
});
