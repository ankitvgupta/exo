/**
 * Pure helpers used by scripts/agentic-verify.mjs. Extracted into a
 * separate module so they can be unit-tested without spinning up
 * Electron or hitting the Anthropic API.
 */

/**
 * Find the LAST JSON object in `text` that has a `verdict` field.
 * Agents often prefix their final answer with prose; we want the
 * structured tail. Returns null if no valid match.
 *
 * Candidates are found with a string-aware brace scanner, not a regex: the
 * agent's anomaly descriptions routinely quote UI text or API bodies
 * containing braces (`{error: ...}`), and braces inside JSON string values
 * break any regex-counted nesting — the whole final JSON then silently
 * fails to match and a real fail verdict is read as "inconclusive". That
 * is a silent false-negative in the safety harness itself, since pre-pr
 * soft-passes some inconclusive-with-0-anomalies runs (live evidence:
 * managed-agents PR #7, a 6-anomaly verdict misread as inconclusive).
 */
export function extractFinalJson(text) {
  let last = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    const end = findMatchingBrace(text, i);
    if (end === -1) continue;
    try {
      const parsed = JSON.parse(text.slice(i, end + 1));
      if (parsed && typeof parsed === "object" && "verdict" in parsed) {
        last = parsed;
        i = end; // don't re-scan inside an object we already accepted
      }
    } catch {
      // not valid JSON from this position — keep scanning
    }
  }
  return last;
}

/** Index of the `}` closing the `{` at `start`, honoring JSON string
 *  literals (braces and escaped quotes inside strings don't count). -1 if
 *  unbalanced. */
function findMatchingBrace(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
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
