#!/usr/bin/env node
/**
 * Pre-PR local gate.
 *
 * Runs every LLM-dependent check locally, aggregates results into a
 * single report, and injects that report into the current PR's body
 * via a marker block (gh pr edit). The CI job `verify-prepr-report`
 * fails the PR if the marker block is missing or stale (SHA mismatch),
 * so this script's run is functionally required before merge.
 *
 * Modes:
 *   default      : full run (~15 min, ~$5)
 *     1. eval suite — every feature with fixtures
 *     2. agentic-verify --mode=verify-diff
 *     3. real-gmail mode 9a (cached .dev-data)
 *   --quick      : fast iteration (~3-5 min, ~$1)
 *     - eval ONLY for features whose source dirs the diff touched
 *     - agentic-verify --mode=verify-diff (already diff-scoped)
 *     - skip real-gmail
 *   --full-sync  : default + real-gmail mode 9b (full sync test)
 *   --no-inject  : run everything but don't touch the PR body
 *
 * Output:
 *   .pre-pr-report.md         — committed locally (gitignored)
 *   <PR body>                 — marker block updated via gh
 *   stdout                    — progress + final verdict
 *
 * Local-only. Requires ANTHROPIC_API_KEY in .env.local or env.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { injectIntoPrBody } from "./lib/pr-body-splice.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const REPORT_PATH = join(REPO_ROOT, ".pre-pr-report.md");

// ============================================================
// .env.local loader
// ============================================================

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(join(REPO_ROOT, ".env.local"));
loadEnvFile(join(REPO_ROOT, ".env"));

// ============================================================
// CLI
// ============================================================

const args = new Set(process.argv.slice(2));
const QUICK = args.has("--quick");
const FULL_SYNC = args.has("--full-sync");
const NO_INJECT = args.has("--no-inject");

const MODE = QUICK ? "quick" : FULL_SYNC ? "full-sync" : "full";

function gitShortSha() {
  // --short=7 (not bare --short) so the length matches the CI side
  // (`${PR_HEAD_SHA:0:7}` always takes exactly 7 chars). Git's bare
  // --short uses `core.abbrev` which auto-grows beyond 7 for large
  // repos and would produce a marker that CI flags as stale.
  return execSync("git rev-parse --short=7 HEAD", { cwd: REPO_ROOT }).toString().trim();
}

function gitChangedFiles() {
  try {
    const base = execSync("git merge-base origin/main HEAD", { cwd: REPO_ROOT }).toString().trim();
    return execSync(`git diff --name-only ${base}..HEAD`, { cwd: REPO_ROOT })
      .toString()
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================================
// Feature → source-dir mapping (quick mode)
// ============================================================

const FEATURE_PATHS = {
  "draft-generator": [/^src\/main\/services\/draft-generator\.ts$/, /draft-generator/],
  "calendaring-agent": [/^src\/main\/services\/calendaring-agent\.ts$/, /calendaring-agent/],
  "sender-lookup": [/^src\/main\/services\/sender-lookup\.ts$/, /sender-lookup/],
  "style-profiler": [
    /^src\/main\/services\/style-profiler\.ts$/,
    /style-(profiler|indexer|inference)/,
  ],
  "archive-ready-analyzer": [/^src\/main\/services\/archive-ready-analyzer\.ts$/, /archive-ready/],
  "analysis-edit-learner": [/analysis-edit-learner/, /memory-learner/],
  "draft-edit-learner": [/draft-edit-learner/, /memory-learner/],
};

// Mirror of the FEATURES registry in tests/evals/feature-evals.ts. Kept
// in sync manually — when an eval suite lands for a TODO feature, add
// its name here. Letting a feature into the quick-mode eval list
// without scaffolding makes feature-evals throw "Unknown feature" and
// fail the eval phase with a misleading spurious failure.
const REGISTERED_FEATURES = new Set([
  "draft-generator",
  "calendaring-agent",
  "archive-ready-analyzer",
]);

function affectedFeatures(changedFiles) {
  const features = new Set();
  const skipped = new Set();
  for (const file of changedFiles) {
    for (const [feature, patterns] of Object.entries(FEATURE_PATHS)) {
      if (patterns.some((p) => p.test(file))) {
        if (REGISTERED_FEATURES.has(feature)) features.add(feature);
        else skipped.add(feature);
      }
    }
  }
  if (skipped.size > 0) {
    console.log(
      `[evals] note: diff touched feature(s) without eval scaffolding yet: ${[...skipped].join(", ")}`,
    );
  }
  return [...features];
}

// ============================================================
// Subprocess runner — captures output, tags with phase name.
// ============================================================

// Paths whose changes can't be exercised through the Electron UI:
// test scaffolding, build/CI scripts, documentation, repo metadata.
// When a diff touches ONLY these paths, agentic-verify will correctly
// return "inconclusive" (exit 3) because there's nothing UI-reachable
// to verify — we treat that as a soft pass instead of a hard failure.
const INFRA_PATH_PREFIXES = ["tests/", "scripts/", "docs/", ".github/"];
const INFRA_PATH_FILES = new Set([".gitignore", "CLAUDE.md", "README.md"]);

function isInfraOnlyDiff(changedFiles) {
  if (changedFiles.length === 0) return false;
  return changedFiles.every(
    (f) => INFRA_PATH_PREFIXES.some((p) => f.startsWith(p)) || INFRA_PATH_FILES.has(f),
  );
}

function runPhase(name, cmd, argv, opts = {}) {
  const start = Date.now();
  console.log(`\n──── ${name} ────`);
  console.log(`  $ ${cmd} ${argv.join(" ")}`);
  const res = spawnSync(cmd, argv, {
    cwd: opts.cwd ?? REPO_ROOT,
    stdio: ["inherit", "pipe", "pipe"],
    env: { ...process.env, ...(opts.env ?? {}) },
    encoding: "utf8",
  });
  const ms = Date.now() - start;
  const stdout = (res.stdout ?? "").toString();
  const stderr = (res.stderr ?? "").toString();
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  const status = res.status ?? -1;
  console.log(`  → exit=${status} (${(ms / 1000).toFixed(1)}s)`);
  // agentic-verify exit 3 = inconclusive ("couldn't reach the
  // diff-affected flow"). For infra-only diffs (tests/scripts/docs),
  // the diff is structurally unreachable from the UI, so inconclusive
  // is the right answer and shouldn't fail the gate. opts.softExits
  // lets the caller widen `ok` for known-non-fatal exit codes.
  const softExits = opts.softExits ?? [];
  const ok = status === 0 || softExits.includes(status);
  return { name, status, ms, stdout, stderr, ok };
}

// ============================================================
// Main
// ============================================================

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required. Put it in .env.local (see .env.local.example).");
    process.exit(1);
  }

  const sha = gitShortSha();
  const changed = gitChangedFiles();
  console.log(`pre-pr mode=${MODE} sha=${sha}`);
  console.log(`changed files: ${changed.length}`);

  const phases = [];

  // ============================================================
  // Phase 1 — Evals
  // ============================================================

  if (MODE === "quick") {
    const features = affectedFeatures(changed);
    if (features.length === 0) {
      console.log("\n[evals] no AI-feature files in diff — skipping eval phase");
    } else {
      console.log(`\n[evals] affected features: ${features.join(", ")}`);
      for (const feature of features) {
        phases.push(
          runPhase(`eval:${feature}`, "npx", [
            "tsx",
            "tests/evals/feature-evals.ts",
            "--feature",
            feature,
          ]),
        );
      }
    }
  } else {
    // Full / full-sync: run analyzer eval (existing) + every feature suite
    phases.push(runPhase("eval:analyzer", "npx", ["tsx", "tests/evals/runner.ts"]));
    phases.push(runPhase("eval:features", "npx", ["tsx", "tests/evals/feature-evals.ts", "--all"]));
  }

  // ============================================================
  // Phase 2 — Agentic verify (diff-scoped)
  // ============================================================
  //
  // For infra-only diffs (tests/scripts/docs), the agent has no
  // UI-reachable code path to exercise and will correctly report
  // "inconclusive" (exit 3). We still run the phase to confirm the
  // app boots clean, but accept inconclusive as a soft pass in that
  // case so eval-infra-only PRs aren't blocked.
  const infraOnly = isInfraOnlyDiff(changed);
  if (infraOnly) {
    console.log(
      `\n[agentic-verify] diff is infra-only (tests/scripts/docs); will accept "inconclusive" verdict.`,
    );
  }
  phases.push(
    runPhase(
      "agentic-verify",
      "node",
      ["scripts/agentic-verify.mjs", "--mode=verify-diff"],
      infraOnly ? { softExits: [3] } : {},
    ),
  );

  // ============================================================
  // Phase 3 — Real-Gmail (optional)
  // ============================================================

  if (MODE !== "quick") {
    const env = { EXO_REAL_GMAIL_TEST: "true" };
    if (MODE === "full-sync") {
      phases.push(
        runPhase(
          "real-gmail:full-sync",
          "npx",
          ["playwright", "test", "--project=real-gmail-full-sync"],
          {
            env,
          },
        ),
      );
    } else {
      phases.push(
        runPhase("real-gmail:cached", "npx", ["playwright", "test", "--project=real-gmail"], {
          env,
        }),
      );
    }
  }

  // ============================================================
  // Aggregate report
  // ============================================================

  const allOk = phases.every((p) => p.ok);
  const verdict = allOk ? "PASS" : "FAIL";
  const reportLines = [];
  reportLines.push(`**Pre-PR verdict**: ${verdict}`);
  reportLines.push("");
  reportLines.push(`- mode: \`${MODE}\``);
  reportLines.push(`- sha: \`${sha}\``);
  reportLines.push(`- generated: ${new Date().toISOString()}`);
  reportLines.push("");
  reportLines.push("| Phase | Status | Duration |");
  reportLines.push("|---|---|---|");
  for (const p of phases) {
    const statusEmoji = p.ok ? "✅" : "❌";
    reportLines.push(
      `| ${p.name} | ${statusEmoji} exit ${p.status} | ${(p.ms / 1000).toFixed(1)}s |`,
    );
  }
  reportLines.push("");
  if (!allOk) {
    reportLines.push("### Failures");
    reportLines.push("");
    for (const p of phases.filter((x) => !x.ok)) {
      reportLines.push(`<details><summary>${p.name} — exit ${p.status}</summary>`);
      reportLines.push("");
      reportLines.push("```");
      const tail = (p.stdout + p.stderr).split("\n").slice(-40).join("\n");
      reportLines.push(tail);
      reportLines.push("```");
      reportLines.push("</details>");
      reportLines.push("");
    }
  }

  const report = reportLines.join("\n");
  writeFileSync(REPORT_PATH, report);
  console.log(`\nReport written to ${REPORT_PATH}`);

  if (!NO_INJECT) {
    try {
      const status = injectIntoPrBody({
        content: report,
        meta: { SHA: sha, mode: MODE },
      });
      if (status === "no-pr") {
        console.log(
          "No PR open for the current branch — local report only. Open the PR and re-run.",
        );
      } else {
        console.log(`PR body ${status} with the report block.`);
      }
    } catch (err) {
      console.error(`Failed to update PR body: ${err instanceof Error ? err.message : err}`);
      console.error("Local report is still valid at " + REPORT_PATH);
    }
  }

  console.log(`\nVerdict: ${verdict}`);
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("pre-pr crashed:", err);
  process.exit(1);
});
