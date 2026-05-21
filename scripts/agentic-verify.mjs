#!/usr/bin/env node
/**
 * Agentic feature verification driver.
 *
 * Spawns an LLM agent (claude-agent-sdk) that drives the running
 * Electron app via the chrome-devtools MCP and writes a structured
 * report. Two modes:
 *
 *   --mode=verify-diff  : diff-scoped — reads `git diff origin/main..HEAD`,
 *                         substitutes into the feature-brief template,
 *                         agent verifies the affected flow works.
 *   --mode=explore      : open-ended exploration — agent wanders the
 *                         app looking for anything broken.
 *
 * The agent uses ONLY the chrome-devtools MCP for app interaction.
 * No file access, no bash, no shell — sandboxed by tool whitelist.
 *
 * Local-only. Never CI. Requires ANTHROPIC_API_KEY (loaded from
 * .env.local).
 *
 * Usage:
 *   node scripts/agentic-verify.mjs --mode=verify-diff
 *   node scripts/agentic-verify.mjs --mode=explore --action-budget=100 --budget-usd=2
 *
 * Writes a report to scripts/.agentic-runs/<timestamp>-<mode>.{md,json}.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { createServer } from "node:net";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { extractFinalJson, summarizeToolCalls, renderReportMd } from "./lib/agentic-helpers.mjs";

/**
 * Find an available TCP port in [9223, 9999]. Skips 9222 by default
 * because Chrome's remote-debug port is commonly 9222 and would conflict.
 * Tries up to 20 ports starting from `start`.
 */
async function findFreePort(start = 9223, attempts = 20) {
  for (let i = 0; i < attempts; i++) {
    const candidate = start + i;
    const ok = await new Promise((resolve) => {
      const server = createServer();
      server.once("error", () => resolve(false));
      server.once("listening", () => {
        server.close(() => resolve(true));
      });
      try {
        server.listen(candidate, "127.0.0.1");
      } catch {
        resolve(false);
      }
    });
    if (ok) return candidate;
  }
  throw new Error(`No free port in [${start}, ${start + attempts}]`);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ============================================================
// .env.local loader (avoid adding dotenv as a dep)
// ============================================================

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
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
// Args
// ============================================================

const args = process.argv.slice(2);
function flag(name, defaultValue = null) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < args.length && !args[idx + 1].startsWith("--")) {
    return args[idx + 1];
  }
  return defaultValue;
}

const MODE = flag("mode", "verify-diff");
// --data=auto|real|demo
//   auto  : detect from the diff. Files matching DATA_REAL_PATTERNS push
//           the run toward real-account mode; everything else is demo.
//   real  : force real mode (uses .dev-data/ tokens for the test account
//           and sets EXO_DISABLE_PREFETCH so we don't burn API spend on
//           background analysis).
//   demo  : force demo mode (current default). Hermetic, no real Gmail.
const DATA_MODE_RAW = flag("data", "auto");
const ACTION_BUDGET = Number(flag("action-budget", MODE === "explore" ? 100 : 40));
const BUDGET_USD = Number(flag("budget-usd", MODE === "explore" ? 2 : 0.5));
const TIMEOUT_MS = Number(flag("timeout-ms", 10 * 60 * 1000));
// CDP_PORT defaults to "auto" — pick a free port at runtime so we don't
// clash with a running Chrome (which often holds 9222). User can pin
// via --cdp-port=<N>. Resolved later in main() once we can await.
const CDP_PORT_RAW = flag("cdp-port", "auto");
let CDP_PORT = CDP_PORT_RAW === "auto" ? 0 : Number(CDP_PORT_RAW);
let CDP_URL = CDP_PORT ? `http://127.0.0.1:${CDP_PORT}` : "";

if (!["verify-diff", "explore"].includes(MODE)) {
  console.error(`Unknown mode: ${MODE}. Use --mode=verify-diff or --mode=explore.`);
  process.exit(1);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    `ANTHROPIC_API_KEY is required. Put it in .env.local (see .env.local.example).`,
  );
  process.exit(1);
}

// ============================================================
// Paths
// ============================================================

const RUNS_DIR = join(__dirname, ".agentic-runs");
mkdirSync(RUNS_DIR, { recursive: true });
const TIMESTAMP = new Date().toISOString().replace(/[:.]/g, "-");
const REPORT_BASE = join(RUNS_DIR, `${TIMESTAMP}-${MODE}`);
const LOG_PATH = `${REPORT_BASE}.log`;
const REPORT_MD = `${REPORT_BASE}.md`;
const REPORT_JSON = `${REPORT_BASE}.json`;

const logLines = [];
function log(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  console.log(entry);
  logLines.push(entry);
}
function flushLog() {
  writeFileSync(LOG_PATH, logLines.join("\n") + "\n");
}

// ============================================================
// Diff (verify-diff mode only)
// ============================================================

function gitDiffSummary() {
  try {
    const base = execSync("git merge-base origin/main HEAD", { cwd: REPO_ROOT })
      .toString()
      .trim();
    const files = execSync(`git diff --name-only ${base}..HEAD`, { cwd: REPO_ROOT })
      .toString()
      .trim();
    const stat = execSync(`git diff --shortstat ${base}..HEAD`, { cwd: REPO_ROOT })
      .toString()
      .trim();
    return { base, files: files || "(none)", shortstat: stat || "(no changes)" };
  } catch (err) {
    return {
      base: "(unknown)",
      files: "(diff failed)",
      shortstat: `diff failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Files whose changes warrant testing against the REAL test Gmail
 * account, not demo data. Anything matching these patterns means the
 * agent is more likely to find real bugs when it can interact with
 * actual Gmail-shaped state (multipart bodies, threading, labels,
 * send-as aliases, etc.) than with the curated demo fixtures.
 */
const DATA_REAL_PATTERNS = [
  /^src\/main\/services\/gmail-client\.ts$/,
  /^src\/main\/services\/email-sync\.ts$/,
  /^src\/main\/services\/prefetch-service\.ts$/,
  /^src\/main\/services\/email-analyzer\.ts$/,
  /^src\/main\/services\/draft-generator\.ts$/,
  /^src\/main\/services\/calendaring-agent\.ts$/,
  /^src\/main\/services\/archive-ready-analyzer\.ts$/,
  /^src\/main\/services\/sender-lookup\.ts$/,
  /^src\/main\/services\/style-profiler\.ts$/,
  /^src\/main\/ipc\/gmail\.ipc\.ts$/,
  /^src\/main\/ipc\/sync\.ipc\.ts$/,
  /^src\/main\/ipc\/analysis\.ipc\.ts$/,
  /^src\/main\/ipc\/drafts\.ipc\.ts$/,
  /^src\/main\/ipc\/compose\.ipc\.ts$/,
];

/**
 * Decide whether the agent should run against the real test account
 * or demo data, given the changed files and the user's explicit flag.
 */
function resolveDataMode(rawFlag, changedFiles) {
  if (rawFlag === "real" || rawFlag === "demo") return rawFlag;
  // auto: any changed file matching a real-pattern → real
  const realRelevant = changedFiles.filter((f) =>
    DATA_REAL_PATTERNS.some((p) => p.test(f)),
  );
  if (realRelevant.length > 0) {
    return { mode: "real", reason: `diff touches ${realRelevant.join(", ")}` };
  }
  return { mode: "demo", reason: "diff is UI/scripts/tests only" };
}

function headSha() {
  try {
    // Pin abbreviation length to 7 to match the CI side (see pre-pr.mjs).
    return execSync("git rev-parse --short=7 HEAD", { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return "(unknown)";
  }
}

// ============================================================
// Prompt assembly
// ============================================================

function loadPrompt(mode) {
  const path =
    mode === "verify-diff"
      ? join(__dirname, "agentic-verify-prompts", "feature-brief.md")
      : join(__dirname, "agentic-verify-prompts", "exploration-rubric.md");
  return readFileSync(path, "utf8");
}

function fillTemplate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(String(v));
  }
  return out;
}

// ============================================================
// Electron lifecycle
// ============================================================

async function waitForCdp(timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(`${CDP_URL}/json/version`);
      if (r.ok) return;
    } catch {
      // not ready
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error(`CDP at ${CDP_URL} not ready after ${timeoutMs}ms`);
}

function launchElectron(dataMode) {
  // In `real` mode: don't set EXO_DEMO_MODE — the app boots against the
  // test account using .dev-data/ tokens. Set EXO_DISABLE_PREFETCH so
  // the agent's run doesn't trigger background Claude analysis on every
  // seeded email (would burn $$).
  const launchEnv =
    dataMode === "real"
      ? { ...process.env, EXO_DEMO_MODE: "", EXO_DISABLE_PREFETCH: "true" }
      : { ...process.env, EXO_DEMO_MODE: "true" };
  log(
    `Launching Electron in ${dataMode} mode with --remote-debugging-port=${CDP_PORT}...`,
  );
  const electron = spawn(
    "npx",
    ["electron-vite", "dev", "--", `--remote-debugging-port=${CDP_PORT}`],
    {
      env: launchEnv,
      stdio: ["ignore", "pipe", "pipe"],
      cwd: REPO_ROOT,
    },
  );
  electron.stdout.on("data", (d) =>
    process.stderr.write(`[electron] ${d.toString().split("\n")[0]}\n`),
  );
  electron.stderr.on("data", (d) =>
    process.stderr.write(`[electron-err] ${d.toString().split("\n")[0]}\n`),
  );
  return electron;
}

function killElectron(electron) {
  if (electron.killed) return;
  try {
    electron.kill("SIGTERM");
    setTimeout(() => {
      if (!electron.killed) electron.kill("SIGKILL");
    }, 3000);
  } catch {
    // ignore
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const sha = headSha();

  // Resolve CDP port lazily so we can pick a free one if the user didn't pin.
  if (CDP_PORT === 0) {
    CDP_PORT = await findFreePort(9223);
    CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
    log(`Auto-selected CDP port: ${CDP_PORT}`);
  } else {
    CDP_URL = `http://127.0.0.1:${CDP_PORT}`;
  }

  log(`mode=${MODE} sha=${sha} action_budget=${ACTION_BUDGET} budget_usd=${BUDGET_USD}`);

  // Resolve data mode (real vs demo) from the diff + the user's flag.
  // In explore mode, default to demo since there's no diff to consult.
  const diffForMode = MODE === "verify-diff" ? gitDiffSummary() : { files: "" };
  const changedList =
    diffForMode.files && diffForMode.files !== "(none)" && diffForMode.files !== "(diff failed)"
      ? diffForMode.files.split("\n").filter(Boolean)
      : [];
  const dataResolution = resolveDataMode(DATA_MODE_RAW, changedList);
  const dataMode = typeof dataResolution === "string" ? dataResolution : dataResolution.mode;
  if (typeof dataResolution === "object") {
    log(`data mode: ${dataResolution.mode} (${dataResolution.reason})`);
  } else {
    log(`data mode: ${dataResolution} (forced via --data)`);
  }

  let prompt;
  if (MODE === "verify-diff") {
    const diff = diffForMode;
    if (diff.files === "(none)" || diff.files === "(diff failed)") {
      log(
        `No diff vs origin/main detected (base=${diff.base}). verify-diff has nothing to scope — bailing.`,
      );
      const report = {
        mode: MODE,
        sha,
        verdict: "skipped",
        summary: "No diff vs origin/main — nothing to verify.",
        anomalies: [],
        actions: 0,
        cost_usd: 0,
      };
      writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
      writeFileSync(REPORT_MD, renderReportMd(report));
      flushLog();
      console.log(`\nSKIPPED — see ${REPORT_MD}`);
      process.exit(0);
    }
    log(`diff base=${diff.base} ${diff.shortstat}`);
    log(`changed files:\n${diff.files}`);
    const template = loadPrompt("verify-diff");
    prompt = fillTemplate(template, {
      DIFF_SUMMARY: diff.shortstat,
      CHANGED_FILES: diff.files,
      ACTION_BUDGET,
      BUDGET_USD,
    });
  } else {
    const template = loadPrompt("explore");
    prompt = fillTemplate(template, { ACTION_BUDGET, BUDGET_USD });
  }

  const electron = launchElectron(dataMode);
  let killed = false;
  function cleanup() {
    if (killed) return;
    killed = true;
    killElectron(electron);
  }
  process.on("SIGINT", () => {
    log("SIGINT");
    cleanup();
    flushLog();
    process.exit(130);
  });

  const timeout = setTimeout(() => {
    log(`hard timeout after ${TIMEOUT_MS}ms`);
    cleanup();
    flushLog();
    process.exit(124);
  }, TIMEOUT_MS);

  try {
    await waitForCdp();
    log("CDP ready. Spawning agent...");

    const result = query({
      prompt,
      options: {
        model: "claude-sonnet-4-6",
        maxTurns: ACTION_BUDGET,
        maxBudgetUsd: BUDGET_USD,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        mcpServers: {
          "chrome-devtools": {
            type: "stdio",
            command: "npx",
            args: ["-y", "chrome-devtools-mcp@1.0.1", `--browser-url=${CDP_URL}`],
          },
        },
      },
    });

    const toolCalls = [];
    const textChunks = [];
    let resultMeta = null;

    for await (const msg of result) {
      if (msg.type === "system" && msg.subtype === "init") {
        const cdpTools = (msg.tools ?? []).filter((t) =>
          t.startsWith("mcp__chrome-devtools__"),
        );
        log(`session init — chrome-devtools tools: ${cdpTools.length}`);
      }
      if (msg.type === "assistant") {
        for (const block of msg.message.content ?? []) {
          if (block.type === "tool_use") {
            toolCalls.push({ name: block.name, input: block.input });
            log(`tool: ${block.name}`);
          } else if (block.type === "text" && block.text) {
            textChunks.push(block.text);
            log(`text: ${block.text.replace(/\n/g, " ").slice(0, 200)}`);
          }
        }
      }
      if (msg.type === "result") {
        resultMeta = msg;
        log(
          `result: subtype=${msg.subtype} cost=${msg.total_cost_usd ?? "?"} turns=${msg.num_turns ?? "?"}`,
        );
      }
    }

    cleanup();
    clearTimeout(timeout);

    const finalText = textChunks.join("\n\n");
    const parsed = extractFinalJson(finalText);

    const report = {
      mode: MODE,
      sha,
      verdict: parsed?.verdict ?? "inconclusive",
      summary: parsed?.summary ?? finalText.slice(0, 1000),
      anomalies: parsed?.anomalies ?? [],
      actions: toolCalls.length,
      tool_calls_summary: summarizeToolCalls(toolCalls),
      cost_usd: resultMeta?.total_cost_usd ?? null,
      turns: resultMeta?.num_turns ?? null,
      duration_ms: resultMeta?.duration_ms ?? null,
      raw_final_text: finalText,
    };

    writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2));
    writeFileSync(REPORT_MD, renderReportMd(report));
    flushLog();

    console.log(`\nverdict: ${report.verdict}`);
    console.log(`anomalies: ${report.anomalies.length}`);
    console.log(`actions: ${report.actions}`);
    console.log(`cost: $${(report.cost_usd ?? 0).toFixed(4)}`);
    console.log(`report: ${REPORT_MD}`);

    // Exit codes:
    //   0 = clean / pass
    //   2 = anomalies found / fail verdict
    //   3 = inconclusive
    if (report.verdict === "fail" || report.anomalies.some((a) => a.severity === "high")) {
      process.exit(2);
    } else if (report.verdict === "inconclusive") {
      process.exit(3);
    }
    process.exit(0);
  } catch (err) {
    log(`FATAL: ${err instanceof Error ? err.stack : String(err)}`);
    cleanup();
    clearTimeout(timeout);
    flushLog();
    console.error(`\nFATAL — see ${LOG_PATH}`);
    process.exit(1);
  }
}

main();
