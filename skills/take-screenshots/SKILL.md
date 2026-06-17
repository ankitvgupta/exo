---
name: take-screenshots
description: Capture screenshots of the Exo Electron app workflows using Playwright in demo mode. Use when the user asks for screenshots, workflow documentation, or visual captures of the app.
disable-model-invocation: true
---

Captures screenshots of the Exo Electron app by running Playwright tests in demo mode.

## Prerequisites

1. **App must be built first** — screenshots run against the compiled output:
   ```bash
   node_modules/.bin/electron-vite build
   ```

2. **Virtual display required** (headless Linux) — the app needs Xvfb since Electron requires a display server:
   ```bash
   # Xvfb is already installed at /usr/bin/xvfb-run
   ```

## How It Works

- Playwright launches the Electron app with `EXO_DEMO_MODE=true` (no real Gmail API calls)
- Uses **Electron's native `capturePage()` API** for screenshots (not Playwright's `page.screenshot()`, which hangs in headless Electron)
- Screenshots are saved as PNG files to `./screenshots/`
- The app runs against `out/main/index.js` (the built output)

## Running Existing Screenshot Specs

```bash
xvfb-run --auto-servernum --server-args="-screen 0 1920x1080x24" \
  npx playwright test tests/screenshots/take-screenshots.spec.ts --timeout 120000
```

Screenshots are saved to `./screenshots/` with numbered filenames (e.g., `01-inbox-view.png`).

## Writing New Screenshot Specs

Create new `.spec.ts` files in `tests/screenshots/`. Use this template:

```typescript
import { test, _electron as electron, Page, ElectronApplication } from "@playwright/test";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.join(__dirname, "../../screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

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

// IMPORTANT: Use Electron's native capturePage(), NOT page.screenshot()
async function screenshot(name: string) {
  const filepath = path.join(SCREENSHOT_DIR, `${name}.png`);
  const imageBuffer = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const image = await win.webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  fs.writeFileSync(filepath, Buffer.from(imageBuffer, "base64"));
}

test.describe("My Workflow", () => {
  test.setTimeout(120000);

  test.beforeAll(async () => {
    const result = await launchApp();
    electronApp = result.app;
    page = result.page;
  });

  test.afterAll(async () => {
    if (electronApp) await electronApp.close();
  });

  test("capture screenshots", async () => {
    await screenshot("01-step-name");
    // ... interact with the app, then take more screenshots
  });
});
```

## Key UI Selectors

These selectors are useful for navigating the app during screenshot capture:

| Element | Selector |
|---------|----------|
| Compose button | `button:has-text('Compose')` |
| New Message header | `text=New Message` |
| To field | `[data-testid='address-input-to'] input[type='text']` |
| Subject field | `input[placeholder='Subject']` |
| Rich text editor | `.ProseMirror, [contenteditable='true']` |
| Send button | `button` filtered by `hasText: /^Send/` |
| Bold button | `button[title='Bold (Cmd+B)']` |
| Discard button | `button:has-text('Discard')` |
| Reply All button | `button[title='Reply All']` |
| Forward button | `button[title='Forward (F)']` |
| Settings button | settings gear icon in top bar |
| Email list items | `button` elements in the left sidebar |
| Address chips | `[data-testid='address-chip']` |

## Critical Notes

- **NEVER use `page.screenshot()`** — it hangs indefinitely in headless Electron. Always use the `electronApp.evaluate` + `capturePage()` pattern shown above.
- **Always wrap with `xvfb-run`** on headless Linux. Without a display server, Electron exits with "Missing X server or $DISPLAY".
- **Build before running** — the specs use the compiled `out/main/index.js`, not the dev server.
- **Demo mode is safe** — `EXO_DEMO_MODE=true` means no real Gmail API calls, no real emails sent. All data is mock.
- Add `--disable-gpu` and `--disable-software-rasterizer` args to Electron launch for headless compatibility.
- Use `waitForTimeout()` after interactions to let animations/transitions complete before capturing.
