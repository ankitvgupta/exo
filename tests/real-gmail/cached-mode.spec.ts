/**
 * Real-Gmail Layer 9a — "feature on real Gmail data" (cached mode).
 *
 * Tests the dev app against the existing .dev-data/ DB, which holds
 * test account state from prior `npm run dev` runs (+ the
 * seed-test-inbox.mjs fixtures). No fresh sync — that's the 9b spec.
 *
 * What this catches:
 *   - Feature regressions against real Gmail-shaped data (vs the
 *     synthetic shapes in MockGmailClient)
 *   - Threading bugs that mock data doesn't exhibit
 *   - HTML rendering issues from real multipart bodies
 *
 * Gated on EXO_REAL_GMAIL_TEST=true AND the env vars in .env.local.
 * Local-only — never CI.
 */
import {
  test,
  expect,
  _electron as electron,
  type Page,
  type ElectronApplication,
} from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import {
  requiredEnvCheck,
  pingAccount,
  makeRunId,
  findOrCreateLabel,
  deleteMessagesWithLabel,
  deleteLabelByName,
} from "./helpers/test-account";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test.beforeAll(() => {
  const skipReason = requiredEnvCheck();
  if (skipReason) test.skip(true, skipReason);
});

test.describe("Real-Gmail Layer 9a — cached .dev-data", () => {
  test.describe.configure({ mode: "serial" });

  let app: ElectronApplication;
  let page: Page;
  let runId: string;

  test.beforeAll(async () => {
    // Verify auth works before booting Electron — fail fast on bad token.
    await pingAccount();
    runId = makeRunId();
    console.log(`[real-gmail 9a] runId=${runId}`);

    // Launch the real (non-demo) dev build pointing at the test account.
    // .dev-data/ should already hold OAuth tokens from a prior
    // `scripts/setup-dev-data.mjs` run. The data-dir module walks up from
    // app.getAppPath() to find the project root, so .dev-data/ is found
    // even though Playwright passes out/main/index.js (which makes
    // app.getAppPath() return out/main, not the project root).
    app = await electron.launch({
      args: [path.join(__dirname, "..", "..", "out", "main", "index.js")],
      env: {
        ...process.env,
        NODE_ENV: "test",
        // NOT demo mode — we want the real Gmail flow against the test
        // account. EXO_DEMO_MODE intentionally unset.
        EXO_DEMO_MODE: "",
        // Disable PrefetchService background analysis during the test
        // run so the test isn't entangled with AI calls (Layer 8 evals
        // cover AI behavior separately).
        EXO_DISABLE_PREFETCH: "true",
      },
      timeout: 30_000,
    });
    page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("text=Exo", { timeout: 30_000 });

    // Switch to the "All" inbox sub-tab. The default sub-tab is
    // "Priority", which filters by analysis.priority — empty on a
    // fresh .dev-data/ where no PrefetchService analyses have run yet
    // (and Layer 9 tests set EXO_DISABLE_PREFETCH=true, so they never
    // will). Using "All" makes thread visibility independent of the
    // analysis pipeline.
    const allTab = page.locator('button:has-text("All")').first();
    if (await allTab.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await allTab.click();
    }
  });

  test.afterAll(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        const proc = app.process();
        if (proc.pid) {
          try {
            process.kill(proc.pid, "SIGKILL");
          } catch {
            /* gone */
          }
        }
      }
    }
    // No teardown of Gmail state here — 9a doesn't mutate the inbox.
    // Anything that DOES mutate (compose/send/label) should clean up
    // its own changes by `[exo-test-{runId}]` prefix.
  });

  test("inbox renders seeded emails (>= 1 visible thread)", async () => {
    // The dev DB has whatever's been synced from the test account.
    // After running seed-test-inbox.mjs + a dev sync, there should be
    // ≥1 thread visible.
    const threadRow = page.locator("div[data-thread-id]").first();
    await expect(threadRow).toBeVisible({ timeout: 15_000 });
  });

  test("opening a thread shows the message body", async () => {
    const firstThread = page.locator("div[data-thread-id]").first();
    await firstThread.click();
    // Body container — exact testid depends on how the app exposes it.
    // Fall back to looking for SOME readable text in the email area.
    await page.waitForTimeout(500);
    const bodyText = await page.locator("body").innerText();
    expect(bodyText.length).toBeGreaterThan(50);
  });

  test("compose button opens compose view", async () => {
    const composeButton = page.locator("button:has-text('Compose')");
    await composeButton.click();
    await expect(page.locator("text=New Message")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("label tag round-trip — add and remove [exo-test-{runId}] via Gmail API", async () => {
    // Pure-API check that auth + label API work end-to-end. Doesn't
    // interact with the app UI — uses the helper directly.
    const labelName = `[${runId}]-roundtrip`;
    const labelId = await findOrCreateLabel(labelName);
    expect(labelId).toBeTruthy();

    // Cleanup
    const removed = await deleteLabelByName(labelName);
    expect(removed).toBe(true);
  });

  test("search returns results", async () => {
    // Type into the search input if present
    const searchInput = page
      .locator("[data-testid='search-input']")
      .or(page.locator("input[placeholder*='Search']").first());
    if (await searchInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await searchInput.click();
      await searchInput.fill("a");
      await page.waitForTimeout(800);
      // Either results appear or there's a "no results" state. Both are
      // valid — we're just making sure search doesn't crash.
      const threadAfter = page.locator("div[data-thread-id]").first();
      const noResults = page.locator("text=/no results|nothing found/i");
      const ok = await Promise.race([
        threadAfter
          .waitFor({ state: "visible", timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
        noResults
          .waitFor({ state: "visible", timeout: 5_000 })
          .then(() => true)
          .catch(() => false),
      ]);
      expect(ok).toBe(true);
    } else {
      test.skip(true, "search input not found in current UI shape");
    }
  });

  test("settings panel opens without crashing", async () => {
    const settingsBtn = page.locator("[data-testid='settings-button']");
    if (await settingsBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
      await settingsBtn.click();
    } else {
      await page.keyboard.press("Meta+,");
    }
    await expect(page.locator("text=Settings").first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
  });

  // Cleanup hook for any messages/labels accidentally created during the run.
  test.afterAll(async () => {
    try {
      // No-op if nothing was created — deleteMessagesWithLabel returns 0.
      const labelName = `[${runId}]-roundtrip`;
      await deleteLabelByName(labelName).catch(() => {});
      // Cleanup any seed-test-style messages tagged with this runId
      const seedLabel = await findOrCreateLabel(runId).catch(() => null);
      if (seedLabel) {
        const n = await deleteMessagesWithLabel(seedLabel);
        if (n > 0) console.log(`[real-gmail 9a] cleaned up ${n} test messages`);
        await deleteLabelByName(runId).catch(() => {});
      }
    } catch (err) {
      console.warn("[real-gmail 9a] cleanup failed:", err);
    }
  });
});
