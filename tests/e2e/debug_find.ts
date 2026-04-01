import { _electron as electron } from "@playwright/test";

async function main() {
  const app = await electron.launch({
    args: ["."],
    env: { ...process.env, EXO_DEMO_MODE: "true", NODE_ENV: "test" },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("text=Inbox", { timeout: 10000 });
  console.log("✓ Inbox loaded");

  // Open find bar
  await page.keyboard.press("Meta+f");
  await page.waitForSelector('[data-testid="find-bar"]', { timeout: 5000 });
  await page.waitForTimeout(300);

  const findBar = page.locator('[data-testid="find-bar"]');
  const findInput = page.locator('[data-testid="find-bar-input"]');

  // Fill + initial IPC call
  await findInput.fill("the");
  await page.evaluate(() => {
    (window as any).api.find.find("the", { findNext: true, forward: true });
  });
  await page.waitForTimeout(500);

  // 3 more IPC calls
  for (let i = 0; i < 3; i++) {
    await page.evaluate(() => {
      (window as any).api.find.find("the", { findNext: true, forward: true });
    });
    await page.waitForTimeout(300);
  }

  // Dump debug state
  const debug = await app.evaluate(() => JSON.stringify((global as any).__findDebug, null, 2));
  console.log("Debug state:");
  console.log(debug);

  const text = await findBar.innerText();
  console.log("\nUI: " + text);

  await app.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
