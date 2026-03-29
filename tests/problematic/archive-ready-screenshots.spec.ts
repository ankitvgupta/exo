import { test, expect, chromium, Page, Browser } from "@playwright/test";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import http from "http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Screenshot tests for Archive Ready View using Chromium.
 *
 * Serves the built renderer HTML via a local HTTP server with mocked window.api,
 * so we can take visual screenshots of the Archive Ready feature.
 */

const RENDERER_DIR = path.join(__dirname, "../../out/renderer");
const SCREENSHOTS_DIR = path.join(__dirname, "../screenshots");

// Demo data matching what the real demo mode would produce
const DEMO_EMAILS = [
  {
    id: "demo-001", threadId: "thread-project-alpha",
    subject: "Project Alpha - Timeline Discussion",
    from: "Sarah Chen <sarah.chen@acmecorp.com>", to: "me@example.com",
    date: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    body: "I wanted to kick off the discussion about Project Alpha's timeline...",
    snippet: "I wanted to kick off the discussion about Project Alpha's timeline...",
    accountId: "default",
    analysis: { needsReply: false, reason: "Initial email in thread, already has follow-ups", analyzedAt: Date.now() },
  },
  {
    id: "demo-002", threadId: "thread-project-alpha",
    subject: "Re: Project Alpha - Timeline Discussion",
    from: "Mike Johnson <mike.j@acmecorp.com>", to: "me@example.com, sarah.chen@acmecorp.com",
    date: new Date(Date.now() - 1.5 * 24 * 60 * 60 * 1000).toISOString(),
    body: "The timeline looks reasonable...",
    snippet: "The timeline looks reasonable. I'd suggest we add a buffer week...",
    accountId: "default",
    analysis: { needsReply: false, reason: "Middle of thread, not the latest message", analyzedAt: Date.now() },
  },
  {
    id: "demo-003", threadId: "thread-project-alpha",
    subject: "Re: Project Alpha - Timeline Discussion",
    from: "Sarah Chen <sarah.chen@acmecorp.com>", to: "me@example.com, mike.j@acmecorp.com",
    date: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    body: "Good point Mike. Let's plan for 7 weeks then.",
    snippet: "Good point Mike. Let's plan for 7 weeks then. Can you confirm your availability...",
    accountId: "default",
    analysis: { needsReply: true, priority: "high", reason: "Direct question about availability", analyzedAt: Date.now() },
  },
  {
    id: "demo-sent-reply-001", threadId: "thread-project-alpha",
    subject: "Re: Project Alpha - Timeline Discussion",
    from: "me@example.com", to: "sarah.chen@acmecorp.com, mike.j@acmecorp.com",
    date: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    body: "Monday at 10am PT works perfectly for the kickoff.",
    snippet: "Monday at 10am PT works perfectly for the kickoff...",
    accountId: "default",
    labelIds: ["SENT"],
    analysis: { needsReply: false, reason: "Sent by user", analyzedAt: Date.now() },
  },
  {
    id: "demo-005", threadId: "thread-q4-planning",
    subject: "Meeting Follow-up: Q4 Planning - Action Items",
    from: "Jennifer Park <j.park@techcorp.com>", to: "me@example.com",
    date: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    body: "Great discussion in today's Q4 planning meeting!",
    snippet: "Great discussion in today's Q4 planning meeting! Action items for you...",
    accountId: "default",
    analysis: { needsReply: true, priority: "high", reason: "Action items with deadline", analyzedAt: Date.now() },
  },
  {
    id: "demo-006", threadId: "thread-github-ci",
    subject: "[myorg/myrepo] CI workflow failed on main",
    from: "GitHub <noreply@github.com>", to: "me@example.com",
    date: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    body: "The workflow CI in repository myorg/myrepo has failed.",
    snippet: "The workflow CI in repository myorg/myrepo has failed...",
    accountId: "default",
    analysis: { needsReply: false, reason: "Automated GitHub CI notification", analyzedAt: Date.now() },
  },
  {
    id: "demo-007", threadId: "thread-newsletter",
    subject: "This Week in Tech: AI Developments, Cloud Trends & More",
    from: "Tech Weekly <newsletter@techweekly.com>", to: "me@example.com",
    date: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    body: "TOP STORIES THIS WEEK: Major AI Breakthrough in Reasoning...",
    snippet: "TOP STORIES THIS WEEK: Major AI Breakthrough in Reasoning...",
    accountId: "default",
    analysis: { needsReply: false, reason: "Newsletter/marketing email", analyzedAt: Date.now() },
  },
  {
    id: "demo-008", threadId: "thread-amazon-ship",
    subject: "Your Amazon order has shipped!",
    from: "Amazon.com <ship-confirm@amazon.com>", to: "me@example.com",
    date: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    body: "Your Amazon.com order has shipped!",
    snippet: "Your Amazon.com order has shipped! Estimated delivery Friday...",
    accountId: "default",
    analysis: { needsReply: false, reason: "Automated shipping notification", analyzedAt: Date.now() },
  },
  {
    id: "demo-012", threadId: "thread-bug-report",
    subject: "URGENT: Production issue affecting checkout flow",
    from: "On-Call <oncall@acmecorp.com>", to: "me@example.com",
    date: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    body: "INCIDENT ALERT - Severity: P1",
    snippet: "URGENT: Production issue affecting checkout flow. P1 severity...",
    accountId: "default",
    analysis: { needsReply: true, priority: "high", reason: "Production incident requiring immediate attention", analyzedAt: Date.now() },
  },
];

// Archive-ready threads (conversations the LLM determined are done)
const ARCHIVE_READY_THREADS = [
  {
    threadId: "thread-project-alpha",
    reason: "User confirmed availability and agreed on 7-week timeline - conversation is complete",
    analyzedAt: Date.now(),
    subject: "Project Alpha - Timeline Discussion",
    latestDate: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    from: "Sarah Chen <sarah.chen@acmecorp.com>",
    emails: DEMO_EMAILS.filter(e => e.threadId === "thread-project-alpha"),
  },
  {
    threadId: "thread-github-ci",
    reason: "Automated CI notification - no response needed",
    analyzedAt: Date.now(),
    subject: "[myorg/myrepo] CI workflow failed on main",
    latestDate: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
    from: "GitHub <noreply@github.com>",
    emails: DEMO_EMAILS.filter(e => e.threadId === "thread-github-ci"),
  },
  {
    threadId: "thread-newsletter",
    reason: "Newsletter subscription - informational only",
    analyzedAt: Date.now(),
    subject: "This Week in Tech: AI Developments, Cloud Trends & More",
    latestDate: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
    from: "Tech Weekly <newsletter@techweekly.com>",
    emails: DEMO_EMAILS.filter(e => e.threadId === "thread-newsletter"),
  },
  {
    threadId: "thread-amazon-ship",
    reason: "Shipping confirmation - no response needed",
    analyzedAt: Date.now(),
    subject: "Your Amazon order has shipped!",
    latestDate: new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString(),
    from: "Amazon.com <ship-confirm@amazon.com>",
    emails: DEMO_EMAILS.filter(e => e.threadId === "thread-amazon-ship"),
  },
];

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function startServer(dir: string, port: number): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = req.url || "/";
      let filePath = path.join(dir, url === "/" ? "index.html" : url);

      // Serve index.html with modified CSP that allows our init script
      if (url === "/" || url === "/index.html") {
        let html = fs.readFileSync(path.join(dir, "index.html"), "utf-8");
        // Relax CSP to allow inline scripts (for our mock injection)
        html = html.replace(
          /script-src 'self'/,
          "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
        );
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(html);
        return;
      }

      const ext = path.extname(filePath);
      const contentType = MIME_TYPES[ext] || "application/octet-stream";

      try {
        const content = fs.readFileSync(filePath);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(content);
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function getMockWindowApi() {
  return `
    window.api = {
      gmail: {
        checkAuth: () => Promise.resolve({ success: true, data: { hasCredentials: true, hasTokens: true } }),
        fetchUnread: () => Promise.resolve({ success: true, data: ${JSON.stringify(DEMO_EMAILS)} }),
      },
      sync: {
        init: () => Promise.resolve({
          success: true,
          data: [{ accountId: "default", email: "demo@example.com", isConnected: true }]
        }),
        getEmails: () => Promise.resolve({ success: true, data: ${JSON.stringify(DEMO_EMAILS)} }),
        now: () => Promise.resolve({ success: true, data: undefined }),
        onNewEmails: () => {},
        onStatusChange: () => {},
        onEmailsRemoved: () => {},
        onEmailsUpdated: () => {},
        onActionFailed: () => {},
        onActionSucceeded: () => {},
        removeAllListeners: () => {},
      },
      accounts: {
        list: () => Promise.resolve({
          success: true,
          data: [{ id: "default", email: "demo@example.com", isPrimary: true }]
        }),
      },
      prefetch: {
        onProgress: () => {},
        onEmailAnalyzed: () => {},
        removeAllListeners: () => {},
      },
      backgroundSync: {
        onProgress: () => {},
        removeAllListeners: () => {},
      },
      auth: {
        onTokenExpired: () => {},
        onExtensionAuthRequired: () => {},
        removeAllListeners: () => {},
        reauth: () => Promise.resolve({ success: true }),
      },
      network: {
        getStatus: () => Promise.resolve({ success: true, data: true }),
        onOnline: () => {},
        onOffline: () => {},
        updateStatus: () => Promise.resolve({ success: true }),
        removeAllListeners: () => {},
      },
      outbox: {
        getStats: () => Promise.resolve({ success: true, data: { pending: 0, failed: 0 } }),
        onStatsChanged: () => {},
        onSent: () => {},
        onFailed: () => {},
        removeAllListeners: () => {},
      },
      theme: {
        get: () => Promise.resolve({ success: true, data: { preference: "light", resolved: "light" } }),
        onChange: () => {},
        removeAllListeners: () => {},
      },
      settings: {
        get: () => Promise.resolve({ success: true, data: {} }),
      },
      scheduledSend: {
        stats: () => Promise.resolve({ success: true, data: { scheduled: 0, total: 0 } }),
        list: () => Promise.resolve({ success: true, data: [] }),
        cancel: () => Promise.resolve({ success: true }),
        onSent: () => {},
        onFailed: () => {},
        onStatsChanged: () => {},
        removeAllListeners: () => {},
      },
      emails: {
        search: () => Promise.resolve({ success: true, data: [] }),
      },
      archiveReady: {
        getThreads: () => Promise.resolve({ success: true, data: ${JSON.stringify(ARCHIVE_READY_THREADS)} }),
        analyzeThread: () => Promise.resolve({ success: true, data: { isReady: true, reason: "Demo mode" } }),
        scan: () => Promise.resolve({ success: true, data: { analyzed: 0, ready: 0 } }),
        dismiss: () => Promise.resolve({ success: true, data: undefined }),
        archiveThread: () => Promise.resolve({ success: true, data: undefined }),
        archiveAll: () => Promise.resolve({ success: true, data: { archived: 0 } }),
        onProgress: () => {},
        onResult: () => {},
        removeAllListeners: () => {},
      },
    };
  `;
}

test.describe("Archive Ready - Screenshots", () => {
  let browser: Browser;
  let page: Page;
  let server: http.Server;
  const PORT = 9876;

  test.beforeAll(async () => {
    if (!fs.existsSync(SCREENSHOTS_DIR)) {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
    }

    server = await startServer(RENDERER_DIR, PORT);

    const chromiumPath = "/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome";
    browser = await chromium.launch({
      headless: true,
      executablePath: fs.existsSync(chromiumPath) ? chromiumPath : undefined,
    });
  });

  test.afterAll(async () => {
    if (browser) await browser.close();
    if (server) server.close();
  });

  test.beforeEach(async () => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    await page.addInitScript(getMockWindowApi());
  });

  test.afterEach(async () => {
    if (page) await page.close();
  });

  test("01 - inbox with archive ready button", async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const archiveButton = page.locator("button[title='Archive Ready']");
    await expect(archiveButton).toBeVisible();

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "01-inbox-with-archive-button.png") });
  });

  test("02 - archive ready view with threads", async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const archiveButton = page.locator("button[title='Archive Ready']");
    await archiveButton.click();
    await page.waitForTimeout(500);

    await expect(page.locator("h2:has-text('Archive Ready')")).toBeVisible({ timeout: 5000 });
    await expect(page.locator("text=Conversations that appear to be done")).toBeVisible();

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "02-archive-ready-view.png") });
  });

  test("03 - archive ready thread details", async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const archiveButton = page.locator("button[title='Archive Ready']");
    await archiveButton.click();
    await page.waitForTimeout(500);

    // Thread with user's sent reply (Project Alpha) - conversation complete
    await expect(page.locator("text=Project Alpha - Timeline Discussion")).toBeVisible();
    await expect(page.locator("text=conversation is complete")).toBeVisible();

    // Automated notifications
    await expect(page.locator("text=CI workflow failed")).toBeVisible();
    await expect(page.locator("text=no response needed").first()).toBeVisible();

    // Newsletter
    await expect(page.locator("text=This Week in Tech")).toBeVisible();

    // Shipping confirmation
    await expect(page.locator("text=Your Amazon order has shipped")).toBeVisible();

    // Archive All button with count
    await expect(page.locator("button:has-text('Archive All (4)')")).toBeVisible();

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "03-archive-ready-details.png") });
  });

  test("04 - sent email thread as archive-ready", async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const archiveButton = page.locator("button[title='Archive Ready']");
    await archiveButton.click();
    await page.waitForTimeout(500);

    // Project Alpha thread is ready because user sent a reply
    const projectAlpha = page.locator("text=Project Alpha - Timeline Discussion");
    await expect(projectAlpha).toBeVisible();

    // Thread count badge shows 4 (3 received + 1 sent)
    const badge = page.locator("span:has-text('4')");
    await expect(badge.first()).toBeVisible();

    // The reason mentions the conversation is complete (based on user's reply)
    await expect(page.locator("text=conversation is complete")).toBeVisible();

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "04-sent-email-thread.png") });
  });

  test("05 - dismiss a thread (keep)", async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const archiveButton = page.locator("button[title='Archive Ready']");
    await archiveButton.click();
    await page.waitForTimeout(500);

    const threadsBefore = await page.locator("button:has-text('Keep')").count();
    expect(threadsBefore).toBe(4);

    // Click Keep on the first thread
    await page.locator("button:has-text('Keep')").first().click();
    await page.waitForTimeout(300);

    const threadsAfter = await page.locator("button:has-text('Keep')").count();
    expect(threadsAfter).toBe(3);

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "05-after-dismiss.png") });
  });

  test("06 - back to inbox", async () => {
    await page.goto(`http://127.0.0.1:${PORT}/`);
    await page.waitForSelector("text=Exo", { timeout: 15000 });
    await page.waitForTimeout(1500);

    const archiveButton = page.locator("button[title='Archive Ready']");
    await archiveButton.click();
    await page.waitForTimeout(500);
    await expect(page.locator("h2:has-text('Archive Ready')")).toBeVisible();

    // Click back arrow
    const backButton = page.locator("button").filter({
      has: page.locator("svg path[d*='M10 19l-7-7']"),
    }).first();
    await backButton.click();
    await page.waitForTimeout(500);

    await expect(page.locator("text=Inbox")).toBeVisible({ timeout: 5000 });

    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, "06-back-to-inbox.png") });
  });
});
