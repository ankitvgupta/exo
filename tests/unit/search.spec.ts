import { test, expect } from "@playwright/test";

/**
 * Unit tests for search utility functions.
 *
 * Tests stripHtmlForSearch and sanitizeFtsQuery which are pure functions
 * with no Electron/DB dependency.
 *
 * DB-dependent search tests (FTS5, LIKE fallback, etc.) are covered by
 * E2E tests that run inside Electron where better-sqlite3 is available.
 */

// ---- Copied from db/index.ts (pure functions, no Electron dependency) ----

function stripHtmlForSearch(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[#\w]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFtsQuery(query: string): string {
  if (query.startsWith('"') && query.endsWith('"')) {
    return query;
  }
  const ftsOperators = new Set(["AND", "OR", "NOT", "NEAR"]);
  const tokens = query.split(/\s+/).filter(Boolean);
  return tokens.map(token => {
    if (ftsOperators.has(token.toUpperCase())) return token.toUpperCase();
    if (/^(subject|body_text|from_address|to_address):/.test(token)) return token;
    if (/[*"():^{}+\-]/.test(token)) return `"${token.replace(/"/g, '""')}"`;
    return token;
  }).join(" ");
}

// ---- Tests ----

test.describe("stripHtmlForSearch", () => {
  test("strips HTML tags", () => {
    expect(stripHtmlForSearch("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
  });

  test("decodes common HTML entities", () => {
    expect(stripHtmlForSearch("&amp; &lt; &gt; &quot; &#39;")).toBe('& < > " \'');
  });

  test("removes style blocks entirely", () => {
    expect(stripHtmlForSearch("<style>.foo { color: red; }</style>Hello")).toBe("Hello");
  });

  test("removes script blocks entirely", () => {
    expect(stripHtmlForSearch("<script>alert('hi')</script>Hello")).toBe("Hello");
  });

  test("collapses whitespace", () => {
    expect(stripHtmlForSearch("<p>Hello</p>  <p>World</p>")).toBe("Hello World");
  });

  test("UPS in <strong> tag is found, 'strong' is not in output", () => {
    const result = stripHtmlForSearch("<strong>UPS</strong> tracking: 1Z12345");
    expect(result).toContain("UPS");
    expect(result).not.toContain("strong");
  });

  test("handles nbsp entities", () => {
    expect(stripHtmlForSearch("hello&nbsp;world")).toBe("hello world");
  });

  test("handles complex HTML emails", () => {
    const html = `<html><body style="font-family: Arial;">
      <div style="background-color: #232f3e; color: white; padding: 16px;">
        <strong>Amazon.com</strong>
      </div>
      <div style="padding: 20px;">
        <p>Your order <strong>#123</strong> has shipped!</p>
        <p><strong>Tracking Number:</strong> 1Z999AA10123456784 (UPS)</p>
      </div>
    </body></html>`;
    const result = stripHtmlForSearch(html);
    expect(result).toContain("Amazon.com");
    expect(result).toContain("UPS");
    expect(result).toContain("1Z999AA10123456784");
    expect(result).not.toContain("<strong>");
    expect(result).not.toContain("background-color");
  });
});

test.describe("sanitizeFtsQuery", () => {
  test("passes through simple words", () => {
    expect(sanitizeFtsQuery("hello world")).toBe("hello world");
  });

  test("preserves boolean operators", () => {
    expect(sanitizeFtsQuery("hello AND world")).toBe("hello AND world");
    expect(sanitizeFtsQuery("a OR b")).toBe("a OR b");
    expect(sanitizeFtsQuery("a NOT b")).toBe("a NOT b");
  });

  test("quotes tokens with special chars", () => {
    expect(sanitizeFtsQuery("hello (world)")).toBe('hello "(world)"');
  });

  test("quotes tokens with asterisks", () => {
    const result = sanitizeFtsQuery("test*");
    expect(result).toBe('"test*"');
  });

  test("preserves column filters", () => {
    expect(sanitizeFtsQuery("subject:test")).toBe("subject:test");
    expect(sanitizeFtsQuery("from_address:bob")).toBe("from_address:bob");
  });

  test("preserves quoted phrases", () => {
    expect(sanitizeFtsQuery('"exact phrase"')).toBe('"exact phrase"');
  });

  test("handles mixed operators and special chars", () => {
    const result = sanitizeFtsQuery("hello AND (world)");
    expect(result).toBe('hello AND "(world)"');
  });
});
