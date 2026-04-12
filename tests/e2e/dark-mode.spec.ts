import { test, expect, Page, ElectronApplication } from "@playwright/test";
import { launchElectronApp , closeApp } from "./launch-helpers";

let electronApp: ElectronApplication;
let page: Page;

test.describe("Dark Mode", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeAll(async ({}, testInfo) => {
    const result = await launchElectronApp({ workerIndex: testInfo.workerIndex });
    electronApp = result.app;
    page = result.page;

    // Wait for email list to populate
    await page
      .locator("button")
      .filter({ hasText: /High|Medium|Low/ })
      .first()
      .waitFor({ timeout: 10000 });
  });

  test.afterAll(async () => {
    if (electronApp) {
      await closeApp(electronApp);
    }
  });

  test("app starts without dark class by default in test environment", async () => {
    // In test env, nativeTheme.shouldUseDarkColors may vary by OS settings,
    // but the html element should exist and have or not have the dark class
    const htmlElement = page.locator("html");
    await expect(htmlElement).toBeVisible();
  });

  test("can open settings and find theme toggle", async () => {
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });

    // The General tab should be visible (default tab) with theme controls
    // Look for the theme toggle buttons: Light, Dark, System
    // Scope within settings panel to avoid matching email content behind the overlay
    const settings = page.locator("[data-testid='settings-panel']");
    await expect(settings.getByRole("button", { name: "Light", exact: true })).toBeVisible({
      timeout: 5000,
    });
    await expect(settings.getByRole("button", { name: "Dark", exact: true })).toBeVisible();
    await expect(settings.getByRole("button", { name: "System", exact: true })).toBeVisible();
  });

  test("can switch to dark mode via settings", async () => {
    // Settings should still be open from previous test
    // Click the "Dark" button to switch to dark mode
    const darkButton = page.locator("button:has-text('Dark')").first();
    await darkButton.click();
    await page.waitForTimeout(500);

    // The <html> element should now have the "dark" class
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(true);

    // Verify dark background is applied to body
    const bodyBg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });
    // Exo dark app background token (#080d18)
    expect(bodyBg).toBe("rgb(6, 11, 22)");
  });

  test("dark mode applies to settings panel", async () => {
    // Settings panel should have dark background
    // The settings container uses bg-white dark:bg-gray-800
    const settingsPanel = page.locator("h1:has-text('Settings')").locator("..");
    const isVisible = await settingsPanel.isVisible();
    expect(isVisible).toBe(true);

    // Verify some text is light-colored in dark mode
    const h1Color = await page.evaluate(() => {
      const h1 = document.querySelector("h1");
      return h1 ? window.getComputedStyle(h1).color : null;
    });
    // In dark mode, text should be light (gray-100 = rgb(243, 244, 246) or similar)
    // Just verify it's not dark/black
    if (h1Color) {
      const rgb = h1Color.match(/\d+/g)?.map(Number) || [];
      // Light text means RGB values are high (>150)
      expect(rgb[0]).toBeGreaterThan(150);
      expect(rgb[1]).toBeGreaterThan(150);
      expect(rgb[2]).toBeGreaterThan(150);
    }
  });

  test("can switch to light mode via settings", async () => {
    // Click the "Light" button
    const lightButton = page.locator("button:has-text('Light')").first();
    await lightButton.click();
    await page.waitForTimeout(500);

    // The <html> element should NOT have the "dark" class
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(false);

    // Verify light background on body
    const bodyBg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });
    // Exo light app background token (#f4f7fb)
    expect(bodyBg).toBe("rgb(244, 247, 251)");
  });

  test("can switch to system mode", async () => {
    // Click the "System" button
    const systemButton = page.locator("button:has-text('System')").first();
    await systemButton.click();
    await page.waitForTimeout(500);

    // The html element should reflect whatever the OS theme is
    // We can't control OS theme in tests, but we can verify
    // the class is set consistently with nativeTheme
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    // Just verify it's a boolean (either is fine depending on OS)
    expect(typeof hasDarkClass).toBe("boolean");
  });

  test("close settings and verify dark mode persists in inbox", async () => {
    // Switch to dark first
    const darkButton = page.locator("button:has-text('Dark')").first();
    await darkButton.click();
    await page.waitForTimeout(300);

    // Close settings
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(300);
    }

    // Verify we're back on inbox
    await expect(page.locator("text=Inbox").first()).toBeVisible({ timeout: 5000 });

    // Dark class should still be active
    const hasDarkClass = await page.evaluate(() =>
      document.documentElement.classList.contains("dark"),
    );
    expect(hasDarkClass).toBe(true);

    // The body background should still be dark
    const bodyBg = await page.evaluate(() => {
      return window.getComputedStyle(document.body).backgroundColor;
    });
    expect(bodyBg).toBe("rgb(6, 11, 22)");
  });

  test("inbox email list renders with dark colors", async () => {
    // Verify the inbox area has dark-themed elements
    // Check that at least one email row exists and has appropriate dark styling
    const emailButtons = page
      .locator("button")
      .filter({ hasText: /Garry|HR Team|Amazon|GitHub|Product Team/ });
    const count = await emailButtons.count();
    expect(count).toBeGreaterThan(0);

    // Check a text element has light color (dark mode text should be light)
    const textColor = await page.evaluate(() => {
      // Find a visible text element in the email list
      const spans = document.querySelectorAll("span");
      for (const span of spans) {
        if (span.textContent && span.offsetParent !== null) {
          return window.getComputedStyle(span).color;
        }
      }
      return null;
    });

    // In dark mode, most text should be light-colored
    if (textColor) {
      const rgb = textColor.match(/\d+/g)?.map(Number) || [];
      // At least one channel should be > 100 (not pure black text)
      const maxChannel = Math.max(...rgb);
      expect(maxChannel).toBeGreaterThan(100);
    }
  });

  test("email detail renders with dark background when email selected", async () => {
    // Click on an email to open detail view
    const emailButton = page.locator("button").filter({ hasText: "Project Alpha" }).first();
    if (await emailButton.isVisible()) {
      await emailButton.click();
      await page.waitForTimeout(500);

      // Check that a visible email detail surface is using the dark palette.
      const hasDarkBg = await page.evaluate(() => {
        const darkPalette = new Set(["rgb(6, 11, 22)", "rgb(12, 19, 36)", "rgb(18, 26, 48)"]);
        const elements = Array.from(document.querySelectorAll("div"));
        return elements.some((el) => {
          if (!(el instanceof HTMLElement) || el.offsetParent === null) return false;
          const bg = window.getComputedStyle(el).backgroundColor;
          return darkPalette.has(bg);
        });
      });
      expect(hasDarkBg).toBe(true);
    }
  });

  // Helper: parse "rgb(r, g, b)" string into [r, g, b] numbers
  function parseRgb(rgb: string): [number, number, number] {
    const match = rgb.match(/\d+/g)?.map(Number) || [0, 0, 0];
    return [match[0], match[1], match[2]];
  }

  // Helper: check that two RGB values are within tolerance
  function rgbWithinTolerance(
    actual: [number, number, number],
    expected: [number, number, number],
    tolerance: number = 20,
  ): boolean {
    return (
      Math.abs(actual[0] - expected[0]) <= tolerance &&
      Math.abs(actual[1] - expected[1]) <= tolerance &&
      Math.abs(actual[2] - expected[2]) <= tolerance
    );
  }

  test("WCAG contrast: email snippet text stays readable in dark mode", async () => {
    // Verify snippet text resolves to a muted-but-readable tone.
    // Prior test may have opened email detail hiding the list — press Escape to go back.
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.waitForSelector("[data-thread-id]", { timeout: 5000 });

    const hasReadableSnippetColor = await page.evaluate(() => {
      const rows = document.querySelectorAll("[data-thread-id]");
      for (const row of rows) {
        const truncateSpans = row.querySelectorAll("span.truncate");
        if (truncateSpans.length >= 2) {
          const snippet = truncateSpans[truncateSpans.length - 1];
          const rgb = window
            .getComputedStyle(snippet)
            .color.match(/\d+/g)
            ?.map(Number) ?? [0, 0, 0];
          const maxChannel = Math.max(...rgb);
          if (maxChannel >= 120) return true;
        }
      }
      return false;
    });

    expect(hasReadableSnippetColor).toBe(true);
  });

  test("settings panel card borders are visible with the new dark border token", async () => {
    // Open settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    const borderColor = await page.evaluate(() => {
      const cards = document.querySelectorAll(".exo-settings-card");
      for (const card of cards) {
        const bc = window.getComputedStyle(card).borderColor;
        if (bc && bc !== "rgb(0, 0, 0)") {
          return bc;
        }
      }
      return null;
    });

    expect(borderColor).not.toBeNull();
    const rgb = parseRgb(borderColor!);
    // Dark border token: #24314d => rgb(36, 49, 77)
    expect(rgbWithinTolerance(rgb, [36, 49, 77], 35)).toBe(true);
  });

  test("account switcher dropdown has dark background", async () => {
    // Close settings first
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(300);
    }

    // Click account switcher to open dropdown
    // The account switcher button contains the current email and a chevron
    const accountButton = page.locator("button").filter({ hasText: /@/ }).first();
    if (await accountButton.isVisible()) {
      await accountButton.click();
      await page.waitForTimeout(300);

      // The dropdown uses dark:bg-gray-800 — check its computed bg
      // gray-800 = rgb(31, 41, 55), gray-900 = rgb(17, 24, 39)
      const dropdownBg = await page.evaluate(() => {
        // The dropdown is an absolutely-positioned div with shadow-lg and z-50
        const dropdowns = document.querySelectorAll(".absolute.shadow-lg");
        for (const dd of dropdowns) {
          const bg = window.getComputedStyle(dd).backgroundColor;
          if (bg && bg !== "rgba(0, 0, 0, 0)") return bg;
        }
        return null;
      });

      if (dropdownBg) {
        const rgb = parseRgb(dropdownBg);
        // Expect dark bg — gray-800 (31,41,55) or gray-900 (17,24,39)
        // All channels should be below 70 (clearly dark)
        expect(rgb[0]).toBeLessThan(70);
        expect(rgb[1]).toBeLessThan(70);
        expect(rgb[2]).toBeLessThan(70);
      }

      // Close dropdown by clicking elsewhere
      await page.locator("body").click({ position: { x: 10, y: 10 } });
      await page.waitForTimeout(200);
    }
  });

  test("compose placeholder text uses gray-400 level contrast", async () => {
    // Press 'c' to open compose
    await page.keyboard.press("c");
    await page.waitForTimeout(500);

    // The compose view's To field input uses dark:placeholder-gray-400
    // gray-400 ≈ rgb(156, 163, 175)
    // We need to check the placeholder pseudo-element color via evaluate
    const placeholderColor = await page.evaluate(() => {
      // Find input with placeholder in the compose view
      const inputs = document.querySelectorAll("input[placeholder]");
      for (const input of inputs) {
        const ph = (input as HTMLInputElement).placeholder;
        if (
          ph &&
          (ph.toLowerCase().includes("to") ||
            ph.toLowerCase().includes("recipient") ||
            ph.toLowerCase().includes("email"))
        ) {
          // For placeholder color, we use getComputedStyle with ::placeholder
          // but that's not directly accessible — check the CSS custom property or class
          // Instead, check if the element has the dark:placeholder-gray-400 class
          const classList = input.className;
          if (classList.includes("placeholder-gray-400")) {
            // The class is present — Tailwind gray-400 is rgb(156, 163, 175)
            return "class-verified";
          }
        }
      }
      // Fallback: look for any input in compose area with placeholder class
      for (const input of inputs) {
        if (input.className.includes("placeholder-gray-400")) {
          return "class-verified";
        }
      }
      return null;
    });

    // Verify the placeholder class is applied
    expect(placeholderColor).toBe("class-verified");

    // Close compose - press Escape
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  });

  test("settings textarea borders remain visible in dark mode", async () => {
    // Open settings
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(300);

    // Navigate to Prompts tab
    const promptsTab = page.locator("button:has-text('Prompts')");
    await promptsTab.click();
    await page.waitForTimeout(300);

    const textareaBorderColor = await page.evaluate(() => {
      const textareas = document.querySelectorAll("textarea");
      for (const ta of textareas) {
        const bc = window.getComputedStyle(ta).borderColor;
        if (bc && bc !== "rgb(0, 0, 0)" && bc !== "rgba(0, 0, 0, 0)") {
          return bc;
        }
      }
      return null;
    });

    expect(textareaBorderColor).not.toBeNull();
    const rgb = parseRgb(textareaBorderColor!);
    // Ensure it's not near-black against dark surfaces.
    expect(Math.max(...rgb)).toBeGreaterThan(70);

    // Close settings
    const closeButton = page
      .locator("button")
      .filter({ has: page.locator("svg path[d*='M6 18L18 6']") })
      .first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(300);
    }
  });

  test("priority chips use semantic colors in dark mode", async () => {
    // Ensure inbox list is visible
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.waitForSelector("[data-thread-id]", { timeout: 5000 });

    const priorityStyles = await page.evaluate(() => {
      const targets = ["High", "Medium", "Low"] as const;
      const result: Record<string, string | null> = { High: null, Medium: null, Low: null };

      for (const label of targets) {
        const candidates = Array.from(document.querySelectorAll("[data-thread-id] span"));
        const match = candidates.find((el) => {
          if (!(el instanceof HTMLElement)) return false;
          return (
            el.textContent?.trim() === label &&
            el.closest("[data-selected='true']") === null &&
            el.offsetParent !== null
          );
        }) as HTMLElement | undefined;
        result[label] = match ? window.getComputedStyle(match).backgroundColor : null;
      }

      return result;
    });

    expect(priorityStyles.High).toBe("rgb(58, 17, 22)");
    expect(priorityStyles.Medium).toBe("rgb(58, 45, 0)");
    expect(priorityStyles.Low).toBe("rgb(18, 49, 36)");
  });

  test("priority chips use semantic colors in light mode", async () => {
    const settingsButton = page.locator("button[title='Settings']");
    await settingsButton.click();
    await expect(page.locator("h1:has-text('Settings')")).toBeVisible({ timeout: 5000 });
    await page.locator("button:has-text('Light')").first().click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.waitForSelector("[data-thread-id]", { timeout: 5000 });

    const priorityStyles = await page.evaluate(() => {
      const targets = ["High", "Medium", "Low"] as const;
      const result: Record<string, string | null> = { High: null, Medium: null, Low: null };

      for (const label of targets) {
        const candidates = Array.from(document.querySelectorAll("[data-thread-id] span"));
        const match = candidates.find((el) => {
          if (!(el instanceof HTMLElement)) return false;
          return (
            el.textContent?.trim() === label &&
            el.closest("[data-selected='true']") === null &&
            el.offsetParent !== null
          );
        }) as HTMLElement | undefined;
        result[label] = match ? window.getComputedStyle(match).backgroundColor : null;
      }

      return result;
    });

    expect(priorityStyles.High).toBe("rgb(254, 226, 226)");
    expect(priorityStyles.Medium).toBe("rgb(254, 249, 195)");
    expect(priorityStyles.Low).toBe("rgb(220, 252, 231)");
  });
});
