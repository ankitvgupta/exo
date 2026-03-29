/**
 * Evaluate a JS file in the Electron renderer via CDP.
 * Usage: node scripts/cdp-eval.mjs <js-file-path>
 */
import { chromium } from 'playwright-core';
import { readFileSync } from 'fs';

const CDP_URL = 'http://127.0.0.1:9222';

async function main() {
  const jsFile = process.argv[2];
  if (!jsFile) {
    console.error('Usage: node scripts/cdp-eval.mjs <js-file>');
    process.exit(1);
  }

  const code = readFileSync(jsFile, 'utf-8');
  const browser = await chromium.connectOverCDP(CDP_URL);
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) { console.error('No page'); process.exit(1); }

  try {
    const result = await page.evaluate(code);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
