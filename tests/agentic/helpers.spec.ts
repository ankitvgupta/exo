/**
 * Unit tests for scripts/lib/agentic-helpers.mjs.
 *
 * Covers the pure logic in the agentic-verify driver: JSON extraction
 * from messy agent output, tool-call summarization, and markdown
 * report rendering.
 *
 * These tests intentionally don't run the agent itself — that requires
 * Electron + an Anthropic key. End-to-end self-test of the driver
 * lifecycle lives in driver-behavior.spec.ts.
 */
import { test, expect } from "@playwright/test";
import {
  extractFinalJson,
  summarizeToolCalls,
  renderReportMd,
  // @ts-expect-error — .mjs without type declarations; helpers are pure JS.
} from "../../scripts/lib/agentic-helpers.mjs";

test.describe("extractFinalJson", () => {
  test("finds a clean trailing JSON object", () => {
    const text = `I did the steps. Here's the result:
{"verdict":"pass","summary":"all good","anomalies":[],"actions_taken":5}`;
    const r = extractFinalJson(text);
    expect(r.verdict).toBe("pass");
    expect(r.actions_taken).toBe(5);
  });

  test("ignores JSON that doesn't have a verdict field", () => {
    const text = `{"foo":"bar"} some text {"verdict":"fail","summary":"x","anomalies":[]}`;
    const r = extractFinalJson(text);
    expect(r.verdict).toBe("fail");
  });

  test("picks the LAST verdict-bearing JSON if multiple", () => {
    const text =
      `{"verdict":"pass","summary":"early","anomalies":[]} ` +
      `more text ` +
      `{"verdict":"fail","summary":"final","anomalies":[]}`;
    const r = extractFinalJson(text);
    expect(r.summary).toBe("final");
  });

  test("returns null when no verdict-bearing JSON present", () => {
    expect(extractFinalJson("no json here")).toBeNull();
    expect(extractFinalJson("{not valid json}")).toBeNull();
    expect(extractFinalJson('{"some": "object"}')).toBeNull();
  });

  test("handles nested objects in the same blob", () => {
    const text = `{"verdict":"pass","summary":"x","anomalies":[{"type":"layout","description":"d"}],"actions_taken":2}`;
    const r = extractFinalJson(text);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0].type).toBe("layout");
  });
});

test.describe("summarizeToolCalls", () => {
  test("counts and joins tool calls", () => {
    const calls = [
      { name: "mcp__chrome-devtools__list_pages" },
      { name: "mcp__chrome-devtools__select_page" },
      { name: "mcp__chrome-devtools__click" },
      { name: "mcp__chrome-devtools__click" },
      { name: "mcp__chrome-devtools__take_snapshot" },
    ];
    const s = summarizeToolCalls(calls);
    expect(s).toContain("mcp__chrome-devtools__click×2");
    expect(s).toContain("mcp__chrome-devtools__list_pages×1");
  });

  test("empty input → empty string", () => {
    expect(summarizeToolCalls([])).toBe("");
  });
});

test.describe("renderReportMd", () => {
  test("renders a pass report with no anomalies", () => {
    const md = renderReportMd({
      mode: "verify-diff",
      sha: "abc1234",
      verdict: "pass",
      anomalies: [],
      actions: 8,
      tool_calls_summary: "list_pages×1, click×3",
      cost_usd: 0.0823,
      turns: 4,
      summary: "Verified the affected flow — nothing broken.",
    });
    expect(md).toContain("# Agentic verification — verify-diff");
    expect(md).toContain("**SHA**: `abc1234`");
    expect(md).toContain("**Verdict**: pass");
    expect(md).toContain("**Anomalies**: 0");
    expect(md).toContain("$0.0823");
    expect(md).toContain("**Turns**: 4");
    expect(md).toContain("Verified the affected flow");
    expect(md).not.toContain("## Anomalies");
  });

  test("includes Anomalies section when anomalies present", () => {
    const md = renderReportMd({
      mode: "explore",
      sha: "def5678",
      verdict: "anomalies_found",
      anomalies: [
        {
          type: "stuck_state",
          severity: "high",
          description: "Generate Draft button does nothing on high-priority emails",
          repro: "1. Click any HIGH-tagged email. 2. Click Generate Draft.",
        },
        {
          type: "ux",
          severity: "low",
          description: "Settings panel close button is misaligned",
        },
      ],
      actions: 47,
      tool_calls_summary: "list_pages×1, click×20, take_screenshot×8",
      cost_usd: 1.42,
      turns: 22,
      summary: "Found 2 issues during exploration.",
    });
    expect(md).toContain("## Anomalies");
    expect(md).toContain("[high]");
    expect(md).toContain("Generate Draft button");
    expect(md).toContain("- Repro: 1. Click any HIGH-tagged email");
    expect(md).toContain("[low]");
    expect(md).toContain("Settings panel close button");
  });

  test("handles missing optional fields gracefully", () => {
    const md = renderReportMd({
      mode: "verify-diff",
      sha: "0000000",
      verdict: "inconclusive",
      anomalies: [],
      actions: 0,
      summary: "",
    });
    expect(md).toContain("**Verdict**: inconclusive");
    expect(md).toContain("(no summary)");
    expect(md).not.toContain("**Cost**");
    expect(md).not.toContain("**Turns**");
  });
});
