import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp } from "./launch-helpers";

let electronApp: ElectronApplication;
let page: Page;

// Helper to read store state
async function getStoreState(page: Page) {
  return page.evaluate(() => {
    const store = (window as unknown as { __ZUSTAND_STORE__?: { getState: () => Record<string, unknown> } }).__ZUSTAND_STORE__;
    if (!store) return null;
    const state = store.getState();
    return {
      selectedEmailId: state.selectedEmailId as string | null,
      selectedThreadId: state.selectedThreadId as string | null,
      snoozedThreadIds: Array.from(state.snoozedThreadIds as Set<string>),
      emailCount: (state.emails as unknown[]).length,
      viewMode: state.viewMode as string,
    };
  });
}

test.describe("Snooze — email must leave inbox and cursor must advance", () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
      extraEnv: { EXO_TEST_MODE: "true" },
    });
    electronApp = result.app;
    page = result.page;

    page.on("console", (msg) => {
      console.log(`[RENDERER ${msg.type()}]: ${msg.text()}`);
    });

    // Wait for the app to fully load with emails
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page.locator("button").filter({ hasText: /High|Medium|Low/ }).first().waitFor({ timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("snooze removes email from inbox and advances cursor to next thread", async () => {
    // Step 1: Press j twice to select the 3rd thread (so there's a "next" below)
    await page.keyboard.press("j");
    await page.waitForTimeout(300);
    await page.keyboard.press("j");
    await page.waitForTimeout(300);

    const stateBefore = await getStoreState(page);
    expect(stateBefore).not.toBeNull();
    console.log("State BEFORE snooze:", JSON.stringify(stateBefore));

    const snoozedThreadId = stateBefore!.selectedThreadId;
    expect(snoozedThreadId).not.toBeNull();

    // Step 2: Identify the thread BELOW the selected one (the expected next selection)
    const nextThreadInfo = await page.evaluate((currentThreadId: string) => {
      const store = (window as unknown as { __ZUSTAND_STORE__?: { getState: () => Record<string, unknown> } }).__ZUSTAND_STORE__;
      if (!store) return null;
      // Access the useThreadedEmails derived data by calling the selector
      const state = store.getState();
      const emails = state.emails as Array<{ id: string; threadId: string; accountId: string; date: string; labelIds?: string[] }>;
      const snoozedThreadIds = state.snoozedThreadIds as Set<string>;
      const currentAccountId = state.currentAccountId as string;

      // Reproduce thread grouping logic to get the ordered thread list
      const accountEmails = emails.filter(
        (e) => e.accountId === currentAccountId && (e.labelIds || []).includes("INBOX")
      );
      const threadMap = new Map<string, typeof accountEmails>();
      for (const e of accountEmails) {
        const existing = threadMap.get(e.threadId) || [];
        existing.push(e);
        threadMap.set(e.threadId, existing);
      }
      // Filter out snoozed
      const threadIds = [...threadMap.keys()].filter((tid) => !snoozedThreadIds.has(tid));
      const currentIndex = threadIds.indexOf(currentThreadId);

      if (currentIndex < 0 || threadIds.length <= 1) return { nextThreadId: null, currentIndex, threadCount: threadIds.length };

      // Same logic as archive: Math.min(currentIndex, length - 2), then filter out current
      const nextIndex = Math.min(currentIndex, threadIds.length - 2);
      const remaining = threadIds.filter((tid) => tid !== currentThreadId);
      const nextThreadId = remaining[nextIndex] || null;

      return { nextThreadId, currentIndex, threadCount: threadIds.length, remainingCount: remaining.length };
    }, snoozedThreadId!);

    console.log("Expected next thread:", JSON.stringify(nextThreadInfo));

    // Step 3: Press h to open snooze menu
    await page.keyboard.press("h");
    await page.waitForTimeout(500);

    // Verify snooze menu is visible
    await expect(page.locator("text=Later Today")).toBeVisible({ timeout: 3000 });

    // Step 4: Click "In 1 Week" to snooze
    await page.locator("button").filter({ hasText: "In 1 Week" }).click();
    await page.waitForTimeout(1000);

    const stateAfter = await getStoreState(page);
    console.log("State AFTER snooze:", JSON.stringify(stateAfter));

    // Assertions
    expect(stateAfter).not.toBeNull();

    // The snoozed thread should be in snoozedThreadIds
    expect(stateAfter!.snoozedThreadIds).toContain(snoozedThreadId);

    // Cursor must NOT be null — it should have advanced to the next thread
    expect(stateAfter!.selectedThreadId).not.toBeNull();
    expect(stateAfter!.selectedEmailId).not.toBeNull();

    // Cursor must NOT still be on the snoozed thread
    expect(stateAfter!.selectedThreadId).not.toBe(snoozedThreadId);

    // Cursor should be on the expected next thread
    if (nextThreadInfo?.nextThreadId) {
      expect(stateAfter!.selectedThreadId).toBe(nextThreadInfo.nextThreadId);
    }

    // The selected row in the UI should be highlighted
    const selectedRow = page.locator('.overflow-y-auto div[data-thread-id].bg-blue-600');
    await expect(selectedRow.first()).toBeVisible({ timeout: 2000 });
  });
});
