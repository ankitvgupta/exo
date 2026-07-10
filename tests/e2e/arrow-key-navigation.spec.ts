import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp, closeApp, waitForEmailListReady } from "./launch-helpers";

/** Get the data-thread-id of the currently selected (highlighted) row */
async function getSelectedThreadId(page: Page): Promise<string | null> {
  const selected = page.locator(".overflow-y-auto div[data-thread-id].bg-blue-600").first();
  if (await selected.isVisible().catch(() => false)) {
    return selected.getAttribute("data-thread-id");
  }
  return null;
}

async function clearSelection(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (!(await getSelectedThreadId(page))) return;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
  }
}

async function selectFirstThread(page: Page): Promise<string> {
  const selectedRow = page.locator("div[data-thread-id][data-selected='true']");
  await page.keyboard.press("j");
  await expect(selectedRow).toBeVisible({ timeout: 5000 });
  const selectedThreadId = await getSelectedThreadId(page);
  expect(selectedThreadId).not.toBeNull();
  return selectedThreadId!;
}

test.describe("Arrow keys keep native scroll behavior", () => {
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
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("ArrowDown does not select or open mail from the inbox", async () => {
    await waitForEmailListReady(page);
    await clearSelection(page);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);

    expect(await getSelectedThreadId(page)).toBeNull();
    await expect(page.locator("button[title='Reply All']").first()).toBeHidden({ timeout: 3000 });
    await expect(page.locator(".w-96.exo-preview-shell")).toBeHidden({ timeout: 3000 });
    await expect(page.locator(".w-64.exo-preview-shell")).toBeHidden({ timeout: 3000 });
  });

  test("ArrowUp and ArrowDown do not move the highlighted inbox row", async () => {
    await waitForEmailListReady(page);
    await clearSelection(page);
    const selectedBefore = await selectFirstThread(page);

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    expect(await getSelectedThreadId(page)).toBe(selectedBefore);

    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);
    expect(await getSelectedThreadId(page)).toBe(selectedBefore);

    await expect(page.locator(".w-96.exo-preview-shell")).toBeHidden({ timeout: 3000 });
    await expect(page.locator(".w-64.exo-preview-shell")).toBeHidden({ timeout: 3000 });
  });

  test("Arrow keys do not reveal a sidebar in full mail view", async () => {
    await waitForEmailListReady(page);
    await clearSelection(page);
    await selectFirstThread(page);

    await page.keyboard.press("Enter");
    const replyButton = page.locator("button[title='Reply All']").first();
    await expect(replyButton).toBeVisible({ timeout: 5000 });

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(300);
    await page.keyboard.press("ArrowUp");
    await page.waitForTimeout(300);

    await expect(replyButton).toBeVisible({ timeout: 3000 });
    await expect(page.locator(".w-96.exo-preview-shell")).toBeHidden({ timeout: 3000 });
    await expect(page.locator(".w-64.exo-preview-shell")).toBeHidden({ timeout: 3000 });
  });
});
