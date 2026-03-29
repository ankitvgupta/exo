/**
 * CDP helper using playwright-core as a CDP client library.
 * Connects to running Electron app via Chrome DevTools Protocol.
 *
 * Usage: node scripts/cdp-helper.mjs <command> [args...]
 *
 * Commands:
 *   screenshot <filename>              - Take a screenshot
 *   eval <js-expression>               - Evaluate JS in the page
 *   click <selector>                   - Click by CSS selector
 *   click-text <text>                  - Click element containing text
 *   type <selector> <text>             - Type into an input
 *   press <key>                        - Press keyboard key (Escape, Enter, etc.)
 *   press-combo <mod> <key>            - Press key combo (Control k, Meta k)
 *   snapshot                           - Get visible UI element summary
 *   colors <selector>                  - Get computed colors for element
 *   hover <selector>                   - Hover over element
 *   wait <ms>                          - Wait milliseconds
 */

import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

const CDP_URL = 'http://127.0.0.1:9222';
const SCREENSHOT_DIR = join(process.cwd(), 'screenshots', 'dark-mode-interactive');

async function main() {
  const [,, command, ...args] = process.argv;
  if (!command) {
    console.error('Usage: node scripts/cdp-helper.mjs <command> [args...]');
    process.exit(1);
  }

  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  const page = contexts[0]?.pages()[0];

  if (!page) {
    console.error('No page found');
    process.exit(1);
  }

  try {
    switch (command) {
      case 'screenshot': {
        const filename = args[0] || 'screenshot.png';
        mkdirSync(SCREENSHOT_DIR, { recursive: true });
        const filepath = join(SCREENSHOT_DIR, filename);
        await page.screenshot({ path: filepath, fullPage: false });
        console.log(`Screenshot saved: ${filepath}`);
        break;
      }

      case 'eval': {
        const expression = args.join(' ');
        const result = await page.evaluate(expression);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'click': {
        const selector = args[0];
        await page.click(selector, { timeout: 5000 });
        console.log(`Clicked: ${selector}`);
        break;
      }

      case 'click-text': {
        const text = args.join(' ');
        await page.click(`text="${text}"`, { timeout: 5000 });
        console.log(`Clicked text: "${text}"`);
        break;
      }

      case 'click-nth': {
        // click-nth <selector> <index>
        const selector = args[0];
        const index = parseInt(args[1]) || 0;
        const elements = await page.$$(selector);
        if (elements[index]) {
          await elements[index].click();
          console.log(`Clicked ${selector} [${index}]`);
        } else {
          console.error(`Element ${selector} [${index}] not found (${elements.length} total)`);
        }
        break;
      }

      case 'type': {
        const selector = args[0];
        const text = args.slice(1).join(' ');
        await page.fill(selector, text, { timeout: 5000 });
        console.log(`Typed "${text}" into ${selector}`);
        break;
      }

      case 'press': {
        const key = args[0];
        await page.keyboard.press(key);
        console.log(`Pressed: ${key}`);
        break;
      }

      case 'press-combo': {
        const modifier = args[0];
        const key = args[1];
        await page.keyboard.press(`${modifier}+${key}`);
        console.log(`Pressed: ${modifier}+${key}`);
        break;
      }

      case 'snapshot': {
        const result = await page.evaluate(() => {
          const summary = [];
          const buttons = [...document.querySelectorAll('button')].filter(b => b.offsetParent !== null);
          summary.push('BUTTONS: ' + buttons.map(b => b.textContent.trim().substring(0, 60)).filter(Boolean).join(' | '));
          const inputs = [...document.querySelectorAll('input, textarea')].filter(i => i.offsetParent !== null);
          summary.push('INPUTS: ' + inputs.map(i => `[${i.type||'text'}] ${i.placeholder || i.name || ''}`).join(' | '));
          const headings = [...document.querySelectorAll('h1,h2,h3,h4,h5')].filter(h => h.offsetParent !== null);
          summary.push('HEADINGS: ' + headings.map(h => h.textContent.trim().substring(0, 60)).join(' | '));
          summary.push('HTML CLASSES: ' + document.documentElement.className);
          summary.push('BODY CLASSES: ' + document.body.className);
          // Check dark mode
          const isDark = document.documentElement.classList.contains('dark');
          summary.push('DARK MODE: ' + (isDark ? 'ENABLED' : 'DISABLED'));
          return summary.join('\n');
        });
        console.log(result);
        break;
      }

      case 'colors': {
        const selector = args[0] || 'body';
        const result = await page.evaluate((sel) => {
          const els = document.querySelectorAll(sel);
          return [...els].slice(0, 5).map(el => {
            const s = getComputedStyle(el);
            return {
              tag: el.tagName,
              classes: el.className.substring(0, 120),
              text: el.textContent?.trim().substring(0, 60),
              bg: s.backgroundColor,
              color: s.color,
              borderColor: s.borderColor,
            };
          });
        }, selector);
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'hover': {
        const selector = args[0];
        await page.hover(selector, { timeout: 5000 });
        console.log(`Hovered: ${selector}`);
        break;
      }

      case 'wait': {
        const ms = parseInt(args[0]) || 1000;
        await new Promise(r => setTimeout(r, ms));
        console.log(`Waited ${ms}ms`);
        break;
      }

      case 'list-emails': {
        const result = await page.evaluate(() => {
          const rows = document.querySelectorAll('[data-thread-id]');
          return [...rows].map((r, i) => ({
            index: i,
            threadId: r.getAttribute('data-thread-id'),
            text: r.textContent?.trim().substring(0, 120),
            classes: r.className.substring(0, 120),
          }));
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      case 'dark-audit': {
        // Check elements that might have dark mode issues
        const result = await page.evaluate(() => {
          const issues = [];
          // Check for elements with light bg colors in dark mode
          const isDark = document.documentElement.classList.contains('dark');
          if (!isDark) return 'Not in dark mode!';

          const allElements = document.querySelectorAll('*');
          for (const el of allElements) {
            if (el.offsetParent === null && el !== document.body) continue;
            const s = getComputedStyle(el);
            const bg = s.backgroundColor;
            // Check for very light backgrounds in dark mode (potential issues)
            const match = bg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
            if (match) {
              const [, r, g, b] = match.map(Number);
              const luminance = (0.299 * r + 0.587 * g + 0.114 * b);
              if (luminance > 200 && el.textContent?.trim().length > 0) {
                issues.push({
                  tag: el.tagName,
                  classes: el.className?.substring(0, 100),
                  text: el.textContent?.trim().substring(0, 60),
                  bg,
                  color: s.color,
                });
              }
            }
          }
          return issues.slice(0, 20); // Limit to first 20
        });
        console.log(JSON.stringify(result, null, 2));
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } finally {
    // Disconnect without closing the browser
    await browser.close();
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
