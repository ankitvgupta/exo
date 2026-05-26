#!/usr/bin/env node
/**
 * Seed .dev-data/exo-config.json with Ollama Cloud credentials + route the
 * drafts feature to ollama-cloud, so the agentic-verify phase of pre-pr can
 * actually exercise the Ollama code path (callOllamaNative) when the diff
 * touches it.
 *
 * Without this, dev runs default to Anthropic for every feature and the
 * Ollama path is structurally unreachable from the harness — agentic-verify
 * reports "inconclusive" and the gate fails for legitimate Ollama-only fixes.
 *
 * Idempotent: re-running just re-asserts the same keys.
 *
 * Reads OLLAMA_API_KEY from .env / .env.local. Uses `conf` directly (the
 * underlying library electron-store wraps) so this works from plain Node.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEV_DATA = join(REPO_ROOT, ".dev-data");

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

const apiKey = process.env.OLLAMA_API_KEY;
if (!apiKey) {
  console.error("FATAL: OLLAMA_API_KEY missing from .env / .env.local.");
  process.exit(1);
}

// conf is electron-store's underlying engine and runs in plain Node.
// Match the schema electron-store would produce when called from
// src/main/ipc/settings.ipc.ts: name=exo-config, encryptionKey=exo-encryption-key.
const require = createRequire(import.meta.url);
const Conf = require("conf").default;

const store = new Conf({
  cwd: DEV_DATA,
  configName: "exo-config",
  encryptionKey: "exo-encryption-key",
  // No schema validation — we just want to read/write the same file the
  // app reads. Strict shape validation happens inside the app via Zod.
});

const current = store.get("config") ?? {};

const next = {
  ...current,
  ollamaCloud: {
    ...(current.ollamaCloud ?? {}),
    apiKey,
    defaultModel: current.ollamaCloud?.defaultModel ?? "kimi-k2.6:cloud",
  },
  featureProviders: {
    ...(current.featureProviders ?? {}),
    // Route the writing-path features through Ollama so composeNewEmail /
    // generateDraft / drafts:refine all hit callOllamaNative — that's the
    // code path the verify-diff agent needs to exercise.
    drafts: "ollama-cloud",
    draftsRefine: "ollama-cloud",
  },
};

store.set("config", next);

console.log(`Wrote ${join(DEV_DATA, "exo-config.json")}`);
console.log(`  ollamaCloud.apiKey: ${apiKey.length} chars`);
console.log(`  ollamaCloud.defaultModel: ${next.ollamaCloud.defaultModel}`);
console.log(`  featureProviders: ${JSON.stringify(next.featureProviders)}`);
