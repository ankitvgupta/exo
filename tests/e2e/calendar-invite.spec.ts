import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { closeApp, launchElectronApp, waitForEmailListReady } from "./launch-helpers";

async function selectSchedulingThread(page: Page): Promise<void> {
  const row = page.locator("div[data-thread-id='thread-ea-scheduling']").first();
  await expect(row).toBeVisible({ timeout: 10000 });
  await row.click();
  await page.waitForTimeout(300);
}

test.describe("Calendar invite editor", () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async ({}, testInfo) => {
    const extraEnv = testInfo.title.includes("re-authenticates")
      ? { EXO_DEMO_CALENDAR_REAUTH_REQUIRED: "true" }
      : {};
    const launched = await launchElectronApp({
      workerIndex: testInfo.workerIndex,
      extraEnv,
    });
    app = launched.app;
    page = launched.page;
    await page.setViewportSize({ width: 1280, height: 800 });
    await waitForEmailListReady(page);
  });

  test.afterEach(async () => {
    await closeApp(app);
  });

  test("opens from the i shortcut and previews the proposed event", async () => {
    await selectSchedulingThread(page);

    await page.keyboard.press("i");

    await expect(page.getByTestId("calendar-invite-editor")).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId("calendar-invite-title")).toHaveValue(
      /Meeting to discuss partnership/,
    );
    await expect(page.getByTestId("calendar-invite-guests")).toHaveValue(
      /david\.lieb@partnerco\.io/,
    );
    await expect(page.getByTestId("calendar-invite-proposed-event")).toBeVisible();
  });

  test("is available from the command palette", async () => {
    await selectSchedulingThread(page);

    await page.keyboard.press("ControlOrMeta+k");
    const input = page.locator('input[placeholder="Type a command..."]');
    await expect(input).toBeVisible({ timeout: 5000 });
    await input.fill("calendar invite");

    const command = page.getByText("Create calendar invite", { exact: true });
    await expect(command).toBeVisible();
    await command.click();

    await expect(page.getByTestId("calendar-invite-editor")).toBeVisible({ timeout: 10000 });
  });

  test("blocks creation until required fields are present", async () => {
    await selectSchedulingThread(page);
    await page.keyboard.press("i");
    await expect(page.getByTestId("calendar-invite-editor")).toBeVisible({ timeout: 10000 });

    await page.getByTestId("calendar-invite-title").fill("");
    await page.getByTestId("calendar-invite-create").click();

    await expect(page.getByTestId("calendar-invite-warnings")).toContainText("Add a title.");
    await expect(page.getByTestId("calendar-invite-editor")).toBeVisible();
  });

  test("re-authenticates the selected calendar account when write permission is missing", async () => {
    await selectSchedulingThread(page);
    await page.keyboard.press("i");
    await expect(page.getByTestId("calendar-invite-editor")).toBeVisible({ timeout: 10000 });

    const reauthButton = page.getByTestId("calendar-invite-reauth");
    await expect(page.getByText("Google Calendar write permission needed")).toBeVisible();
    await expect(reauthButton).toBeVisible();
    await expect(reauthButton).toBeEnabled();

    await reauthButton.click();

    await expect(page.getByText("Google Calendar write permission needed")).toBeHidden({
      timeout: 10000,
    });
    await expect(page.getByTestId("calendar-invite-create")).toBeEnabled();
  });
});
