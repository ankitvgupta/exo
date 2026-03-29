/**
 * Dark Mode Visual Audit - Comprehensive screenshot workflow
 *
 * Takes screenshots of every major UI state in dark mode to audit for visual issues.
 * Uses Electron's native capturePage() for reliable headless screenshots.
 * All navigation happens in a single test to maintain state across steps.
 *
 * Usage: xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
 *   npx playwright test tests/screenshots/dark-mode-audit.spec.ts --timeout 300000 --workers=1
 *
 * Screenshots are saved to ./screenshots/dark-mode/ directory.
 */

import { test, _electron as electron, Page, ElectronApplication, expect } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, "../../screenshots/dark-mode");

let electronApp: ElectronApplication;
let page: Page;

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [
      path.join(__dirname, "../../out/main/index.js"),
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
    env: {
      ...process.env,
      NODE_ENV: "test",
      EXO_DEMO_MODE: "true",
      ELECTRON_DISABLE_GPU: "1",
    },
  });

  const window = await app.firstWindow();
  await window.waitForLoadState("domcontentloaded");
  await window.waitForSelector("text=Exo", { timeout: 30000 });
  await window.waitForTimeout(2000);

  return { app, page: window };
}

let screenshotIndex = 0;
async function screenshot(name: string, description?: string) {
  screenshotIndex++;
  const paddedIndex = String(screenshotIndex).padStart(2, "0");
  const filename = `${paddedIndex}-${name}.png`;
  const filepath = path.join(SCREENSHOT_DIR, filename);

  const imageBuffer = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage();
    return image.toPNG().toString("base64");
  });

  fs.writeFileSync(filepath, Buffer.from(imageBuffer, "base64"));
  console.log(`  [screenshot ${paddedIndex}] ${name}${description ? ` - ${description}` : ""}`);
}

/** Ensure we're in split view (email list visible) by pressing Escape if needed */
async function ensureSplitView() {
  const emailList = page.locator("div[data-thread-id]").first();
  if (!(await emailList.isVisible({ timeout: 500 }).catch(() => false))) {
    // We're likely in full detail view - press Escape to go back to split
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    await emailList.waitFor({ timeout: 5000 });
  }
}

/** Click the first email row containing the given text */
async function clickEmailContaining(text: string): Promise<boolean> {
  await ensureSplitView();
  // The EmailRow has a button inside a div[data-thread-id]. Click the button.
  const row = page.locator(`div[data-thread-id] button`).filter({ hasText: text }).first();
  if (await row.isVisible({ timeout: 2000 }).catch(() => false)) {
    await row.click();
    await page.waitForTimeout(600);
    return true;
  }
  return false;
}

/** Go back to inbox from full detail view */
async function goBackToInbox() {
  // Try back button first
  const backBtn = page.locator("button[title*='Back']").first();
  if (await backBtn.isVisible({ timeout: 500 }).catch(() => false)) {
    await backBtn.click();
    await page.waitForTimeout(300);
    return;
  }
  // Try Escape
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

test.describe("Dark Mode Visual Audit", () => {
  test.setTimeout(300000);

  test.beforeAll(async () => {
    fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const result = await launchApp();
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      if (msg.type() === "error" && !msg.text().includes("407") && !msg.text().includes("ERR_TUNNEL")) {
        console.error(`[Console Error]: ${msg.text()}`);
      }
    });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await electronApp.close();
    }
  });

  test("capture all dark mode screenshots", async () => {
    // Wait for emails to load
    await page.locator("div[data-thread-id]").first().waitFor({ timeout: 15000 });

    // ==========================================
    // STEP 1: Enable dark mode
    // ==========================================
    const settingsBtn = page.locator("button[title='Settings']");
    await settingsBtn.click();
    await page.waitForTimeout(500);
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    const darkButton = page.locator("button:has-text('Dark')").first();
    await darkButton.click();
    await page.waitForTimeout(500);

    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark")
    );
    expect(hasDarkClass).toBe(true);

    // Close settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);

    // Wait for email list to reappear
    await page.locator("div[data-thread-id]").first().waitFor({ timeout: 5000 });

    // ==========================================
    // SECTION 1: Inbox & Email List (Tests 01-04)
    // ==========================================
    await screenshot("inbox-overview", "Main inbox view with email list in dark mode");

    // Click first email to see selected state
    const firstEmailBtn = page.locator("div[data-thread-id] button").first();
    await firstEmailBtn.click();
    await page.waitForTimeout(600);
    await screenshot("email-selected", "Email row selected state + preview sidebar in dark mode");

    // Sidebar sender tab visible
    await screenshot("sidebar-sender", "Email preview sidebar with sender info in dark mode");

    // Scroll email list
    const listContainer = page.locator("div.flex-1.overflow-y-auto").first();
    if (await listContainer.isVisible()) {
      await listContainer.evaluate(el => el.scrollTop = 400);
      await page.waitForTimeout(300);
      await screenshot("email-list-scrolled", "Email list scrolled to show more emails in dark mode");
      await listContainer.evaluate(el => el.scrollTop = 0);
      await page.waitForTimeout(200);
    }

    // ==========================================
    // SECTION 2: Various Email Types (Tests 05-18)
    // ==========================================

    // Rich HTML email (Q3 report with table + attachments)
    if (await clickEmailContaining("Q3 Quarterly Report")) {
      await screenshot("rich-html-email", "Rich HTML email with table rendered on white card");
    }

    // Plain text email thread (Project Alpha)
    if (await clickEmailContaining("Project Alpha")) {
      await screenshot("plain-text-thread", "Plain text email thread in dark mode");
    }

    // Production incident (high priority)
    if (await clickEmailContaining("URGENT")) {
      await screenshot("urgent-email", "High priority production incident email in dark mode");
    }

    // Inline images email
    if (await clickEmailContaining("Landing Page Mockups")) {
      await screenshot("inline-images", "Email with inline images in dark mode");
    }

    // Newsletter HTML
    if (await clickEmailContaining("This Week in Tech")) {
      await screenshot("newsletter-html", "Newsletter with rich HTML/backgrounds on white card");
    }

    // Amazon shipping
    if (await clickEmailContaining("Amazon order")) {
      await screenshot("amazon-shipping", "Amazon shipping HTML email in dark mode");
    }

    // Product update HTML
    if (await clickEmailContaining("Weekly Product Update")) {
      await screenshot("product-update", "Product update HTML email with styled sections");
    }

    // API rate limits question
    if (await clickEmailContaining("API rate limits")) {
      await screenshot("api-question", "Plain text API question email in dark mode");
    }

    // Meeting follow-up
    if (await clickEmailContaining("Meeting Follow-up")) {
      await screenshot("meeting-followup", "Meeting follow-up with action items in dark mode");
    }

    // Interview scheduling
    if (await clickEmailContaining("Interview Scheduling")) {
      await screenshot("interview-scheduling", "Interview scheduling email in dark mode");
    }

    // Personal lunch email
    if (await clickEmailContaining("Lunch this week")) {
      await screenshot("personal-email", "Personal lunch invitation in dark mode");
    }

    // Calendar notification
    if (await clickEmailContaining("Weekly Team Sync")) {
      await screenshot("calendar-notification", "Calendar notification email in dark mode");
    }

    // GitHub CI notification
    if (await clickEmailContaining("CI workflow failed")) {
      await screenshot("github-ci", "GitHub CI notification email in dark mode");
    }

    // Meeting/scheduling (partnership)
    if (await clickEmailContaining("Coffee chat")) {
      await screenshot("partnership-email", "Partnership meeting request in dark mode");
    }

    // ==========================================
    // SECTION 3: Sidebar Tabs (Tests 19-21)
    // ==========================================

    // Make sure an email is selected
    await clickEmailContaining("Project Alpha");

    // Try Agent tab
    const agentTab = page.locator("button").filter({ hasText: "Agent" }).first();
    if (await agentTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await agentTab.click();
      await page.waitForTimeout(300);
      await screenshot("sidebar-agent-tab", "Sidebar agent tab in dark mode");
    }

    // Try Calendar tab
    const calTab = page.locator("button").filter({ hasText: "Calendar" }).first();
    if (await calTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await calTab.click();
      await page.waitForTimeout(300);
      await screenshot("sidebar-calendar-tab", "Sidebar calendar tab in dark mode");
    }

    // Back to Sender tab
    const senderTab = page.locator("button").filter({ hasText: "Sender" }).first();
    if (await senderTab.isVisible({ timeout: 2000 }).catch(() => false)) {
      await senderTab.click();
      await page.waitForTimeout(300);
      await screenshot("sidebar-sender-tab-back", "Sidebar back to sender tab");
    }

    // ==========================================
    // SECTION 4: Compose Flow (Tests 22-26)
    // ==========================================

    const composeBtn = page.locator("button:has-text('Compose')");
    await composeBtn.click();
    await page.waitForTimeout(500);
    await page.waitForSelector("text=New Message", { timeout: 5000 });
    await screenshot("compose-empty", "Empty compose modal in dark mode");

    // Add recipients
    const toField = page.locator("[data-testid='address-input-to'] input[type='text']");
    if (await toField.isVisible()) {
      await toField.fill("alice@example.com");
      await toField.press("Enter");
      await page.waitForTimeout(200);
      await toField.fill("bob@example.com");
      await toField.press("Enter");
      await page.waitForTimeout(200);
      await screenshot("compose-recipients", "Compose with recipient address chips in dark mode");
    }

    // Show CC/BCC
    const ccToggle = page.locator("button:has-text('Cc')").first();
    if (await ccToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
      await ccToggle.click();
      await page.waitForTimeout(200);
    }
    const bccToggle = page.locator("button:has-text('Bcc')").first();
    if (await bccToggle.isVisible({ timeout: 1000 }).catch(() => false)) {
      await bccToggle.click();
      await page.waitForTimeout(200);
    }
    await screenshot("compose-cc-bcc", "Compose with CC/BCC fields expanded in dark mode");

    // Fill subject and body
    const subjectField = page.locator("input[placeholder='Subject']");
    await subjectField.fill("Testing dark mode compose");
    await page.waitForTimeout(100);

    const editor = page.locator(".ProseMirror, [contenteditable='true']").first();
    await editor.click();
    await editor.type(
      "Hi team,\n\nThis is a test email to verify the compose editor looks correct in dark mode.\n\n- Item 1\n- Item 2\n- Item 3\n\nBest regards",
      { delay: 3 }
    );
    await page.waitForTimeout(300);
    await screenshot("compose-filled", "Fully composed email with subject and body in dark mode");

    // Discard compose
    const discardBtn = page.locator("button:has-text('Discard')").first();
    if (await discardBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await discardBtn.click();
      await page.waitForTimeout(500);
      // Confirm discard if dialog
      const confirmDiscard = page.locator("button:has-text('Discard')").first();
      if (await confirmDiscard.isVisible({ timeout: 500 }).catch(() => false)) {
        await confirmDiscard.click();
        await page.waitForTimeout(300);
      }
    } else {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // ==========================================
    // SECTION 5: Reply Compose (Test 27)
    // ==========================================

    await clickEmailContaining("API rate limits");
    const replyBtn = page.locator("button[title*='Reply']").first();
    if (await replyBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await replyBtn.click();
      await page.waitForTimeout(500);
      await screenshot("reply-compose", "Reply compose view in dark mode");
      // Close
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const discardReply = page.locator("button:has-text('Discard')").first();
      if (await discardReply.isVisible({ timeout: 500 }).catch(() => false)) {
        await discardReply.click();
        await page.waitForTimeout(300);
      }
    }

    // ==========================================
    // SECTION 6: Search (Tests 28-29)
    // ==========================================

    await page.keyboard.press("/");
    await page.waitForTimeout(500);
    await screenshot("search-empty", "Empty search modal in dark mode");

    const searchInput = page.locator("input[placeholder*='Search']").first();
    if (await searchInput.isVisible()) {
      await searchInput.fill("Project Alpha");
      await page.waitForTimeout(500);
      await screenshot("search-results", "Search with matching results in dark mode");
    }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ==========================================
    // SECTION 7: Command Palette (Tests 30-31)
    // ==========================================

    // Try Meta+K first, then Ctrl+K
    await page.keyboard.press("Meta+k");
    await page.waitForTimeout(300);
    let cmdInput = page.locator("input[placeholder*='command']").first();
    if (!(await cmdInput.isVisible({ timeout: 1000 }).catch(() => false))) {
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(300);
      cmdInput = page.locator("input[placeholder*='command']").first();
    }
    if (await cmdInput.isVisible({ timeout: 1000 }).catch(() => false)) {
      await screenshot("command-palette", "Command palette open in dark mode");

      await cmdInput.fill("theme");
      await page.waitForTimeout(300);
      await screenshot("command-palette-filtered", "Command palette filtered for 'theme'");

      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // ==========================================
    // SECTION 8: Settings Panel - All 10 Tabs (Tests 32-41)
    // ==========================================

    await settingsBtn.click();
    await page.waitForTimeout(500);
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });
    await screenshot("settings-general", "Settings General tab (theme, density, undo send)");

    // Accounts tab
    const accountsTab = page.locator("button:has-text('Accounts')").first();
    if (await accountsTab.isVisible()) {
      await accountsTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-accounts", "Settings Accounts tab");
    }

    // Calendar tab
    const settingsCalTab = page.locator("button").filter({ hasText: "Calendar" }).first();
    if (await settingsCalTab.isVisible()) {
      await settingsCalTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-calendar", "Settings Calendar tab");
    }

    // Splits tab
    const splitsTab = page.locator("button:has-text('Splits')").first();
    if (await splitsTab.isVisible()) {
      await splitsTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-splits", "Settings Splits tab");
    }

    // Signatures tab
    const sigTab = page.locator("button:has-text('Signatures')").first();
    if (await sigTab.isVisible()) {
      await sigTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-signatures", "Settings Signatures tab");
    }

    // Prompts tab
    const promptsTab = page.locator("button:has-text('Prompts')").first();
    if (await promptsTab.isVisible()) {
      await promptsTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-prompts", "Settings Prompts tab with textareas");
    }

    // Writing Style tab
    const styleTab = page.locator("button:has-text('Writing Style')").first();
    if (await styleTab.isVisible()) {
      await styleTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-style", "Settings Writing Style tab");
    }

    // Executive Assistant tab
    const eaTab = page.locator("button:has-text('Executive Assistant')").first();
    if (await eaTab.isVisible()) {
      await eaTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-ea", "Settings Executive Assistant tab");
    }

    // Queue tab
    const queueTab = page.locator("button:has-text('Queue')").first();
    if (await queueTab.isVisible()) {
      await queueTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-queue", "Settings Queue tab");
    }

    // Agents tab
    const agentsTab = page.locator("button:has-text('Agents')").first();
    if (await agentsTab.isVisible()) {
      await agentsTab.click();
      await page.waitForTimeout(300);
      await screenshot("settings-agents", "Settings Agents tab");
    }

    // Close settings
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    // ==========================================
    // SECTION 9: Keyboard Shortcuts Help (Test 42)
    // ==========================================

    // First click on inbox area to ensure we're not in a modal
    await page.locator("div[data-thread-id]").first().waitFor({ timeout: 5000 });
    await page.keyboard.press("?");
    await page.waitForTimeout(500);
    const shortcutModal = page.locator("text=Keyboard Shortcuts");
    if (await shortcutModal.isVisible({ timeout: 2000 }).catch(() => false)) {
      await screenshot("shortcuts-help", "Keyboard shortcuts help modal");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
    }

    // ==========================================
    // SECTION 10: Batch Selection (Test 43)
    // ==========================================

    // Hover first email to reveal checkbox
    const firstRow = page.locator("div[data-thread-id]").first();
    await firstRow.hover();
    await page.waitForTimeout(300);
    const checkbox = page.locator("[data-testid='thread-checkbox']").first();
    if (await checkbox.isVisible({ timeout: 1000 }).catch(() => false)) {
      await checkbox.click();
      await page.waitForTimeout(300);
      await screenshot("batch-action-bar", "Batch action bar with email selected");
      // Uncheck
      await checkbox.click();
      await page.waitForTimeout(200);
    }

    // ==========================================
    // SECTION 11: Density Toggle (Test 44)
    // ==========================================

    const densityBtn = page.locator("button[title*='density'], button[title*='Density']").first();
    if (await densityBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await densityBtn.click();
      await page.waitForTimeout(500);
      await screenshot("compact-density", "Compact density email list");
      // Toggle back
      await densityBtn.click();
      await page.waitForTimeout(300);
    }

    // ==========================================
    // SECTION 12: Account Switcher (Test 45)
    // ==========================================

    // Look for account selector in titlebar
    const accountDropdownBtn = page.locator("button").filter({ hasText: /@/ }).first();
    if (await accountDropdownBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await accountDropdownBtn.click();
      await page.waitForTimeout(300);
      await screenshot("account-switcher", "Account switcher dropdown");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }

    // ==========================================
    // SECTION 13: Snooze Menu (Test 46)
    // ==========================================

    // Select an email first
    await clickEmailContaining("Lunch this week");
    const snoozeBtn = page.locator("button[title*='Snooze'], button[title*='snooze']").first();
    if (await snoozeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await snoozeBtn.click();
      await page.waitForTimeout(500);
      await screenshot("snooze-menu", "Snooze menu with preset options");
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
    }

    // ==========================================
    // SECTION 14: Thread with sent reply (Test 47)
    // ==========================================

    // Project Alpha thread has a sent reply from user
    if (await clickEmailContaining("Project Alpha")) {
      await page.waitForTimeout(300);
      await screenshot("thread-with-sent-reply", "Thread showing user's own sent reply");
    }

    // ==========================================
    // SECTION 15: Full detail view (Test 48)
    // ==========================================

    // Double-click to enter full view
    const dblClickTarget = page.locator("div[data-thread-id] button").filter({ hasText: "Meeting Follow-up" }).first();
    if (await dblClickTarget.isVisible({ timeout: 2000 }).catch(() => false)) {
      await dblClickTarget.dblclick();
      await page.waitForTimeout(500);
      await screenshot("full-detail-view", "Full detail view of email");
      await goBackToInbox();
    }

    // ==========================================
    // SECTION 16: Hover & empty states (Tests 49-50)
    // ==========================================

    await ensureSplitView();
    // Hover state
    const hoverTarget = page.locator("div[data-thread-id]").nth(3);
    if (await hoverTarget.isVisible()) {
      await hoverTarget.hover();
      await page.waitForTimeout(300);
      await screenshot("email-row-hover", "Email row hover state showing action icons");
    }

    // Empty sidebar state - deselect
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await screenshot("sidebar-empty", "Empty sidebar with no email selected");

    // ==========================================
    // SECTION 17: Final overview (Test 51)
    // ==========================================

    await screenshot("final-overview", "Final overview of app in dark mode");

    console.log(`\n  Total screenshots captured: ${screenshotIndex}`);
  });
});
