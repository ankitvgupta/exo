import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { closeApp, launchElectronApp } from "./launch-helpers";

type TestEmail = {
  id: string;
  threadId: string;
  subject: string;
  body?: string;
};

type TestStore = {
  getState: () => {
    emails: TestEmail[];
  };
  setState: (patch: Record<string, unknown>) => void;
};

test.describe("Open Links & Attachments palette", () => {
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

  test("Cmd+O opens current-email links and attachments in a searchable picker", async () => {
    const reportEmail = page.locator("button").filter({ hasText: "Q3 Quarterly Report" }).first();
    await expect(reportEmail).toBeVisible({ timeout: 15000 });
    await reportEmail.click();

    await page.keyboard.press("ControlOrMeta+o");

    const palette = page.getByRole("dialog", { name: "Open Links & Attachments" });
    const input = palette.locator('input[placeholder="Open Links & Attachments..."]');
    await expect(input).toBeVisible({ timeout: 3000 });
    await expect(palette.getByText("Links", { exact: true })).toBeVisible();
    await expect(palette.getByText("Attachments", { exact: true })).toBeVisible();
    await expect(palette.getByText("Q3 Report Dashboard")).toBeVisible();
    await expect(palette.getByText("dashboard.example.com/q3-report")).toBeVisible();
    await expect(palette.getByText("Dashboard mirror", { exact: true })).toBeHidden();
    await expect(palette.getByText("Email analytics", { exact: true })).toBeHidden();
    await expect(palette.getByText("Q3_Report_2025.pdf")).toBeVisible();
    await expect(palette.getByText("Q3_Metrics.xlsx")).toBeVisible();

    await input.fill("metrics");
    await expect(palette.getByText("Q3_Metrics.xlsx")).toBeVisible();
    await expect(palette.getByText("Q3_Report_2025.pdf")).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(input).toBeHidden();
  });

  test("Escape closes attachment preview without closing the picker", async () => {
    const selectedReport = await page.evaluate(() => {
      const store = (window as unknown as { __ZUSTAND_STORE__?: TestStore }).__ZUSTAND_STORE__;
      if (!store) return false;

      const state = store.getState();
      const reportEmail = state.emails.find((email) =>
        email.subject.includes("Q3 Quarterly Report"),
      );
      if (!reportEmail) return false;

      store.setState({
        selectedEmailId: reportEmail.id,
        selectedThreadId: reportEmail.threadId,
        focusedThreadEmailId: null,
        viewMode: "split",
      });
      return true;
    });
    expect(selectedReport).toBe(true);

    await page.keyboard.press("ControlOrMeta+o");

    const palette = page.getByRole("dialog", { name: "Open Links & Attachments" });
    await expect(palette).toBeVisible({ timeout: 3000 });
    await palette.getByText("Q3_Report_2025.pdf", { exact: true }).click();

    const previewHeading = page.getByRole("heading", { name: "Q3_Report_2025.pdf" });
    await expect(previewHeading).toBeVisible({ timeout: 3000 });

    await page.keyboard.press("Escape");
    await expect(previewHeading).toBeHidden();
    await expect(palette).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("Cmd+O includes bare URLs from plain text email bodies", async () => {
    await page.evaluate(() => {
      const store = (window as unknown as { __ZUSTAND_STORE__?: TestStore }).__ZUSTAND_STORE__;
      if (!store) return;

      const state = store.getState();
      const incidentEmail = {
        id: "e2e-openables-incident-link",
        threadId: "thread-e2e-openables-incident-link",
        subject: "URGENT: Production issue affecting checkout flow",
        from: "Incident <incident@example.com>",
        to: "Test <test@example.com>",
        date: new Date().toISOString(),
        body: `INCIDENT ALERT

Severity: P1
Status: Investigating

Slack: #incident-checkout-012
Zoom: https://zoom.us/j/123456789`,
        attachments: [],
      };

      store.setState({
        emails: [...state.emails.filter((email) => email.id !== incidentEmail.id), incidentEmail],
        selectedEmailId: incidentEmail.id,
        selectedThreadId: incidentEmail.threadId,
        focusedThreadEmailId: null,
        viewMode: "split",
      });
    });

    await page.keyboard.press("ControlOrMeta+o");

    const palette = page.getByRole("dialog", { name: "Open Links & Attachments" });
    await expect(palette).toBeVisible({ timeout: 3000 });
    await expect(palette.getByText("Links", { exact: true })).toBeVisible();
    await expect(palette.getByText("zoom.us/j/123456789", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("Cmd+O preserves anchor URL punctuation and trims bare URL punctuation", async () => {
    await page.evaluate(() => {
      const store = (window as unknown as { __ZUSTAND_STORE__?: TestStore }).__ZUSTAND_STORE__;
      if (!store) return;

      const state = store.getState();
      const syntheticEmail = {
        id: "e2e-openables-punctuation-links",
        threadId: "thread-e2e-openables-punctuation-links",
        subject: "Punctuation links",
        from: "Links <links@example.com>",
        to: "Test <test@example.com>",
        date: new Date().toISOString(),
        body: `
          <p><a href="https://en.wikipedia.org/wiki/Rust_(programming_language)">Rust reference</a></p>
          <p>Bare runbook: https://docs.example.com/runbook.</p>
        `,
        attachments: [],
      };

      store.setState({
        emails: [...state.emails.filter((email) => email.id !== syntheticEmail.id), syntheticEmail],
        selectedEmailId: syntheticEmail.id,
        selectedThreadId: syntheticEmail.threadId,
        focusedThreadEmailId: null,
        viewMode: "split",
      });
    });

    await page.keyboard.press("ControlOrMeta+o");

    const palette = page.getByRole("dialog", { name: "Open Links & Attachments" });
    await expect(palette).toBeVisible({ timeout: 3000 });
    await expect(
      palette.getByText("en.wikipedia.org/wiki/Rust_(programming_language)", { exact: true }),
    ).toBeVisible();
    await expect(palette.getByText("docs.example.com/runbook", { exact: true })).toBeVisible();
    await expect(palette.getByText("docs.example.com/runbook.", { exact: true })).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("Cmd+O ignores stale focused-thread email outside full view", async () => {
    await page.evaluate(() => {
      const store = (window as unknown as { __ZUSTAND_STORE__?: TestStore }).__ZUSTAND_STORE__;
      if (!store) return;

      const state = store.getState();
      const selectedEmail = {
        id: "e2e-openables-selected-email",
        threadId: "thread-e2e-openables-selected",
        subject: "Selected split email",
        from: "Selected <selected@example.com>",
        to: "Test <test@example.com>",
        date: new Date().toISOString(),
        body: `<a href="https://current.example.com/runbook">Current split link</a>`,
        attachments: [],
      };
      const staleFocusedEmail = {
        id: "e2e-openables-stale-focused-email",
        threadId: "thread-e2e-openables-stale",
        subject: "Stale focused email",
        from: "Stale <stale@example.com>",
        to: "Test <test@example.com>",
        date: new Date().toISOString(),
        body: `Zoom: https://zoom.us/j/123456789`,
        attachments: [],
      };

      store.setState({
        emails: [
          ...state.emails.filter(
            (email) => email.id !== selectedEmail.id && email.id !== staleFocusedEmail.id,
          ),
          selectedEmail,
          staleFocusedEmail,
        ],
        selectedEmailId: selectedEmail.id,
        selectedThreadId: selectedEmail.threadId,
        focusedThreadEmailId: staleFocusedEmail.id,
        viewMode: "split",
      });
    });

    await page.keyboard.press("ControlOrMeta+o");

    const palette = page.getByRole("dialog", { name: "Open Links & Attachments" });
    await expect(palette.getByText("Current split link")).toBeVisible({ timeout: 3000 });
    await expect(palette.getByText("zoom.us/j/123456789", { exact: true })).toBeHidden();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });

  test("Cmd+O caps large result sets while keeping search complete", async () => {
    await page.evaluate(() => {
      const store = (window as unknown as { __ZUSTAND_STORE__?: TestStore }).__ZUSTAND_STORE__;
      if (!store) return;

      const state = store.getState();
      const syntheticEmail = {
        id: "e2e-openables-many-links",
        threadId: "thread-e2e-openables-many-links",
        subject: "Many links",
        from: "Load Test <load@example.com>",
        to: "Test <test@example.com>",
        date: new Date().toISOString(),
        body: Array.from(
          { length: 120 },
          (_, index) =>
            `<a href="https://example.com/openable-${index + 1}">Synthetic link ${index + 1}</a>`,
        ).join("<br>"),
        attachments: [],
      };

      store.setState({
        emails: [...state.emails.filter((email) => email.id !== syntheticEmail.id), syntheticEmail],
        selectedEmailId: syntheticEmail.id,
        selectedThreadId: syntheticEmail.threadId,
        focusedThreadEmailId: null,
        viewMode: "split",
      });
    });

    await page.keyboard.press("ControlOrMeta+o");

    const palette = page.getByRole("dialog", { name: "Open Links & Attachments" });
    const input = palette.locator('input[placeholder="Open Links & Attachments..."]');
    await expect(input).toBeVisible({ timeout: 3000 });
    await expect(palette.locator("[data-index]")).toHaveCount(100);
    await expect(
      palette.getByText(/20 more items match\. Keep\s+typing to narrow\./),
    ).toBeVisible();

    await input.fill("Synthetic link 120");
    await expect(palette.locator("[data-index]")).toHaveCount(1);
    await expect(palette.getByText("Synthetic link 120", { exact: true })).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();
  });
});
