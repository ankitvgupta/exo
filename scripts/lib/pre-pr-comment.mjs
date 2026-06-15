import { existsSync } from "node:fs";

export function appendPrivateFailureDetails(lines, phase) {
  lines.push(`<details><summary>${phase.name} — exit ${phase.status}</summary>`);
  lines.push("");
  lines.push(
    "Raw phase output is intentionally not posted to GitHub. `pre-pr` can run against real mailbox/calendar data, so logs stay in the local terminal and local artifacts only.",
  );
  lines.push("");
  lines.push("</details>");
  lines.push("");
}

function localArtifactPath(path, repoRoot) {
  const prefix = repoRoot.endsWith("/") ? repoRoot : `${repoRoot}/`;
  return path.startsWith(prefix) ? path.replace(prefix, "") : path;
}

/**
 * Compose the human-readable PR comment. Keep this free of raw subprocess
 * output. `pre-pr` can run against real mailbox/calendar data, so logs and
 * agentic reports are local-only artifacts.
 *
 * GitHub comments have a 65,536-character body cap. We intentionally do not
 * inline the agentic report or trace because both can contain private data.
 */
export function buildPrCommentBody({
  verdict,
  phases,
  sha,
  mode,
  verifyReport,
  repoRoot = process.cwd(),
  generatedAt = new Date(),
}) {
  const headerLines = [];
  const emoji = verdict === "PASS" ? "✅" : "❌";
  headerLines.push(`## ${emoji} Pre-PR verification — ${verdict}`);
  headerLines.push("");
  headerLines.push(`- **mode**: \`${mode}\``);
  headerLines.push(`- **sha**: \`${sha}\``);
  headerLines.push(`- **generated**: ${generatedAt.toISOString()}`);
  headerLines.push("");
  headerLines.push("| Phase | Status | Duration |");
  headerLines.push("|---|---|---|");
  for (const p of phases) {
    const status = p.ok ? "✅" : "❌";
    headerLines.push(`| ${p.name} | ${status} exit ${p.status} | ${(p.ms / 1000).toFixed(1)}s |`);
  }
  headerLines.push("");
  const header = headerLines.join("\n");

  const trailerLines = [];
  const failed = phases.filter((p) => !p.ok);
  if (failed.length > 0) {
    trailerLines.push("### Failures");
    trailerLines.push("");
    for (const p of failed) {
      appendPrivateFailureDetails(trailerLines, p);
    }
  }
  trailerLines.push("");
  trailerLines.push(
    "<sub>This comment is upserted by `npm run pre-pr`. The CI gate reads the marker block in the PR description, not this comment.</sub>",
  );
  const trailer = trailerLines.join("\n");

  let summarySection = "";
  if (verifyReport?.md && existsSync(verifyReport.md)) {
    const localMd = localArtifactPath(verifyReport.md, repoRoot);
    const localJson = verifyReport.json ? localArtifactPath(verifyReport.json, repoRoot) : null;
    const localLog = verifyReport.log ? localArtifactPath(verifyReport.log, repoRoot) : null;
    const artifactLines = [`- Markdown: \`${localMd}\``];
    if (localJson) artifactLines.push(`- JSON: \`${localJson}\``);
    if (localLog) artifactLines.push(`- Trace: \`${localLog}\``);
    summarySection =
      "<details open><summary><strong>Agentic verification — local report</strong></summary>\n\n" +
      "Agentic verification wrote local artifacts. Their contents are not posted to GitHub because the verifier can inspect real mailbox/calendar data.\n\n" +
      artifactLines.join("\n") +
      "\n\n</details>\n";
  }

  if (!summarySection) {
    summarySection =
      "_Agentic verification report not found — likely the phase failed before writing its report. See the local terminal output and local artifacts._\n";
  }

  return [header, summarySection, trailer].join("\n");
}
