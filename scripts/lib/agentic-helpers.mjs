/**
 * Pure helpers used by scripts/agentic-verify.mjs. Extracted into a
 * separate module so they can be unit-tested without spinning up
 * Electron or hitting the Anthropic API.
 */

/**
 * Find the LAST JSON object in `text` that has a `verdict` field.
 * Agents often prefix their final answer with prose; we want the
 * structured tail. Returns null if no valid match.
 */
export function extractFinalJson(text) {
  // Match brace-balanced blocks. Greedy enough to handle nested objects
  // but bounded so we don't match across the whole transcript.
  const matches = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) ?? [];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(matches[i]);
      if (parsed && typeof parsed === "object" && "verdict" in parsed) return parsed;
    } catch {
      // try previous
    }
  }
  return null;
}

/**
 * Compress a list of tool-call records into `"name1×3, name2×1"` form
 * for the report header.
 */
export function summarizeToolCalls(calls) {
  const counts = new Map();
  for (const c of calls) counts.set(c.name, (counts.get(c.name) ?? 0) + 1);
  return [...counts.entries()].map(([name, n]) => `${name}×${n}`).join(", ");
}

/**
 * Render a report object to markdown for PR-body injection.
 */
export function renderReportMd(report) {
  const lines = [];
  lines.push(`# Agentic verification — ${report.mode}`);
  lines.push("");
  lines.push(`- **SHA**: \`${report.sha}\``);
  lines.push(`- **Verdict**: ${report.verdict}`);
  lines.push(`- **Anomalies**: ${report.anomalies.length}`);
  lines.push(`- **Actions**: ${report.actions} (${report.tool_calls_summary ?? "—"})`);
  if (report.cost_usd !== null && report.cost_usd !== undefined) {
    lines.push(`- **Cost**: $${Number(report.cost_usd).toFixed(4)}`);
  }
  if (report.turns !== null && report.turns !== undefined) {
    lines.push(`- **Turns**: ${report.turns}`);
  }
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(report.summary || "(no summary)");
  lines.push("");
  if (report.anomalies.length > 0) {
    lines.push("## Anomalies");
    lines.push("");
    for (const a of report.anomalies) {
      const sev = a.severity ? `[${a.severity}] ` : "";
      lines.push(`- **${sev}${a.type ?? "unknown"}** — ${a.description ?? "(no description)"}`);
      if (a.repro) lines.push(`  - Repro: ${a.repro}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
