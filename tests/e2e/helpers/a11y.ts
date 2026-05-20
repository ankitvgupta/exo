import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export type A11yImpact = "minor" | "moderate" | "serious" | "critical";

export type CheckA11yOptions = {
  failOn?: "critical" | "serious";
  /**
   * CSS selectors to exclude from analysis. Useful for transient regions
   * (toasts, focus-trap sentinels, animated elements) where axe sees
   * intermediate states.
   */
  exclude?: string[];
};

const IMPACT_RANK: Record<A11yImpact, number> = {
  minor: 0,
  moderate: 1,
  serious: 2,
  critical: 3,
};

/**
 * Run axe-core against the current page and throw if any violations meet
 * the configured impact threshold. Default threshold is "serious" (also
 * fails on "critical"). Minor/moderate violations are silent — capture
 * those separately when you care.
 *
 * Scoped to WCAG 2.0 A/AA + WCAG 2.1 A/AA rule sets, which is the
 * pragmatic baseline for shipping a desktop app.
 */
export async function checkA11y(page: Page, options: CheckA11yOptions = {}): Promise<void> {
  const failOn = options.failOn ?? "serious";
  const threshold = IMPACT_RANK[failOn];

  let builder = new AxeBuilder({ page }).withTags([
    "wcag2a",
    "wcag2aa",
    "wcag21a",
    "wcag21aa",
  ]);

  for (const sel of options.exclude ?? []) {
    builder = builder.exclude(sel);
  }

  const results = await builder.analyze();

  const blocking = results.violations.filter((v) => {
    const impact = (v.impact ?? "minor") as A11yImpact;
    return IMPACT_RANK[impact] >= threshold;
  });

  if (blocking.length === 0) return;

  const summary = blocking
    .map((v) => `  - [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`)
    .join("\n");
  throw new Error(
    `Accessibility violations (>= ${failOn}) detected:\n${summary}\n` +
      `See https://dequeuniversity.com/rules/axe/ for rule details.`,
  );
}
