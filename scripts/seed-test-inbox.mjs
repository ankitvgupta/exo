#!/usr/bin/env node
/**
 * Seed the test Gmail account (exoemailtest@gmail.com) with realistic
 * fixture emails via Gmail API `users.messages.insert`. This is NOT an
 * external send — `messages.insert` places a message directly into the
 * inbox with whatever From/To/Subject headers we specify in the raw
 * RFC 2822 body. No SMTP, no external traffic.
 *
 * Used as a precondition for:
 *   - Layer 9a real-Gmail smoke tests (need realistic data in the inbox)
 *   - `npm run dev` against the test account (so dev feels real)
 *
 * Idempotent: every inserted message gets a `[exo-seed]` Gmail label.
 * On a second run with no flag, if ≥ TARGET_COUNT messages already have
 * the label, the script exits 0. Pass `--reset` to delete all labeled
 * messages first and re-seed.
 *
 * One-time OAuth setup
 * --------------------
 * Before running this, you need a refresh token for exoemailtest@gmail.com
 * with the gmail.modify scope. The simplest path:
 *
 *   1. In a browser signed in as exoemailtest@gmail.com, visit the OAuth
 *      consent URL printed by the script when EXOEMAILTEST_REFRESH_TOKEN
 *      is missing.
 *   2. Approve the consent (you'll need the test account added as a test
 *      user on the project's OAuth consent screen).
 *   3. Paste the resulting code back into the script.
 *   4. The script prints the refresh token; save it in .env.local as
 *      EXOEMAILTEST_REFRESH_TOKEN.
 *
 * Usage:
 *   node scripts/seed-test-inbox.mjs           # idempotent seed
 *   node scripts/seed-test-inbox.mjs --reset   # delete labeled, re-seed
 *   node scripts/seed-test-inbox.mjs --dry-run # validate fixtures, no API
 */

import { createInterface } from "node:readline";
import { google } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

import { directQuestions } from "./seed-fixtures/direct-questions.mjs";
import { newsletters } from "./seed-fixtures/newsletters.mjs";
import { scheduling } from "./seed-fixtures/scheduling.mjs";
import { withAttachments } from "./seed-fixtures/with-attachments.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env parser — keeps the script dependency-free.
 * Handles `KEY=value`, `KEY="value with spaces"`, comments, blank lines.
 * Does not handle multiline values or shell expansion (we don't need them).
 */
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

// .env.local takes precedence over .env (loaded first wins because we
// check `key in process.env` before setting).
loadEnvFile(join(__dirname, "..", ".env.local"));
loadEnvFile(join(__dirname, "..", ".env"));

const TEST_ACCOUNT = "exoemailtest@gmail.com";
const SEED_LABEL = "exo-seed";
const TARGET_COUNT_DEFAULT = 80;
const OAUTH_SCOPES = ["https://www.googleapis.com/auth/gmail.modify"];
const OAUTH_REDIRECT = "urn:ietf:wg:oauth:2.0:oob";

const args = new Set(process.argv.slice(2));
const FLAG_RESET = args.has("--reset");
const FLAG_DRY_RUN = args.has("--dry-run");

const ALL_FIXTURES = [
  ...directQuestions,
  ...newsletters,
  ...scheduling,
  ...withAttachments,
];

// ============================================================
// RFC 2822 builder
// ============================================================

function base64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function rfcDate(d) {
  return d.toUTCString();
}

/**
 * Construct an RFC 2822 message. Returns { raw: base64urlString, messageId }.
 *
 * The Message-ID we set here gets pinned to the fixture id so subsequent
 * fixtures with `inReplyTo`/`references` can stitch threads together.
 */
function buildRawMessage(fixture, indexAcrossAll, idToMessageId) {
  const to = fixture.to ?? TEST_ACCOUNT;
  const messageId = `<${fixture.id}-${Date.now()}@exoemailtest.local>`;
  idToMessageId.set(fixture.id, messageId);

  // Spread dates across ~30 days, most recent fixtures get most recent dates
  const daysAgo = 30 * (1 - indexAcrossAll / ALL_FIXTURES.length);
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);

  const headers = [
    `From: ${fixture.from}`,
    `To: ${to}`,
    fixture.cc ? `Cc: ${fixture.cc}` : null,
    `Subject: ${fixture.subject}`,
    `Date: ${rfcDate(fixture.date ? new Date(fixture.date) : date)}`,
    `Message-ID: ${messageId}`,
    fixture.inReplyTo ? `In-Reply-To: ${idToMessageId.get(fixture.inReplyTo) ?? `<${fixture.inReplyTo}@exoemailtest.local>`}` : null,
    fixture.references
      ? `References: ${fixture.references.map((r) => idToMessageId.get(r) ?? `<${r}@exoemailtest.local>`).join(" ")}`
      : null,
    "MIME-Version: 1.0",
  ].filter(Boolean);

  const hasAttachments = (fixture.attachments?.length ?? 0) > 0;
  const isHtml = !!fixture.html;

  let body;
  if (hasAttachments) {
    const boundary = `----=_Part_${fixture.id}_${Math.random().toString(36).slice(2)}`;
    headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

    const parts = [];
    parts.push(
      `--${boundary}\r\n` +
        `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8\r\n` +
        `Content-Transfer-Encoding: 7bit\r\n\r\n` +
        fixture.body +
        `\r\n`,
    );
    for (const att of fixture.attachments) {
      parts.push(
        `--${boundary}\r\n` +
          `Content-Type: ${att.mimeType}; name="${att.filename}"\r\n` +
          `Content-Disposition: attachment; filename="${att.filename}"\r\n` +
          `Content-Transfer-Encoding: base64\r\n\r\n` +
          // Wrap base64 at 76 chars per RFC 2045
          att.contentBase64.match(/.{1,76}/g).join("\r\n") +
          `\r\n`,
      );
    }
    parts.push(`--${boundary}--\r\n`);
    body = parts.join("");
  } else {
    headers.push(
      `Content-Type: ${isHtml ? "text/html" : "text/plain"}; charset=UTF-8`,
      "Content-Transfer-Encoding: 7bit",
    );
    body = fixture.body;
  }

  const raw = headers.join("\r\n") + "\r\n\r\n" + body;
  return { raw: base64url(raw), messageId };
}

// ============================================================
// OAuth + label helpers
// ============================================================

async function promptForCode() {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Paste the OAuth code here: ", (code) => {
      rl.close();
      resolve(code.trim());
    });
  });
}

async function ensureCredentials() {
  const { EXOEMAILTEST_CLIENT_ID, EXOEMAILTEST_CLIENT_SECRET, EXOEMAILTEST_REFRESH_TOKEN } =
    process.env;

  if (!EXOEMAILTEST_CLIENT_ID || !EXOEMAILTEST_CLIENT_SECRET) {
    console.error(
      `\nMissing OAuth client credentials. Set EXOEMAILTEST_CLIENT_ID and\n` +
        `EXOEMAILTEST_CLIENT_SECRET in .env.local. You can reuse the same OAuth\n` +
        `client you use for app dev (the test account just needs to be added\n` +
        `as a test user on the OAuth consent screen).\n`,
    );
    process.exit(1);
  }

  const client = new OAuth2Client(
    EXOEMAILTEST_CLIENT_ID,
    EXOEMAILTEST_CLIENT_SECRET,
    OAUTH_REDIRECT,
  );

  if (EXOEMAILTEST_REFRESH_TOKEN) {
    client.setCredentials({ refresh_token: EXOEMAILTEST_REFRESH_TOKEN });
    return client;
  }

  // Interactive one-time setup
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: OAUTH_SCOPES,
  });
  console.log(
    `\nNo EXOEMAILTEST_REFRESH_TOKEN found. One-time setup:\n\n` +
      `  1. Sign in to ${TEST_ACCOUNT} in your browser.\n` +
      `  2. Visit:\n     ${authUrl}\n` +
      `  3. Approve.\n` +
      `  4. Paste the resulting code here.\n`,
  );

  const code = await promptForCode();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    console.error("Google didn't return a refresh token. Try revoking the app in Google Account settings and re-running.");
    process.exit(1);
  }

  console.log(
    `\nSuccess. Add this to .env.local and re-run:\n\n` +
      `  EXOEMAILTEST_REFRESH_TOKEN=${tokens.refresh_token}\n`,
  );
  client.setCredentials(tokens);
  return client;
}

async function findOrCreateLabel(gmail, name) {
  const list = await gmail.users.labels.list({ userId: "me" });
  const existing = (list.data.labels ?? []).find((l) => l.name === name);
  if (existing?.id) return existing.id;
  const created = await gmail.users.labels.create({
    userId: "me",
    requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" },
  });
  if (!created.data.id) throw new Error(`failed to create label ${name}`);
  return created.data.id;
}

async function countLabeledMessages(gmail, labelId) {
  let count = 0;
  let pageToken = undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: 500,
      pageToken,
    });
    count += res.data.messages?.length ?? 0;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return count;
}

async function deleteLabeledMessages(gmail, labelId) {
  let deleted = 0;
  let pageToken = undefined;
  do {
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds: [labelId],
      maxResults: 500,
      pageToken,
    });
    const ids = (res.data.messages ?? []).map((m) => m.id).filter(Boolean);
    if (ids.length > 0) {
      await gmail.users.messages.batchDelete({ userId: "me", requestBody: { ids } });
      deleted += ids.length;
      console.log(`  Deleted ${deleted} messages...`);
    }
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return deleted;
}

// ============================================================
// Main
// ============================================================

function categoryOf(id) {
  if (id.startsWith("dq-")) return "direct-questions";
  if (id.startsWith("nl-")) return "newsletters";
  if (id.startsWith("sched-")) return "scheduling";
  if (id.startsWith("att-")) return "with-attachments";
  return "other";
}

async function main() {
  console.log(`Loaded ${ALL_FIXTURES.length} fixtures across categories:`);
  const byCategory = new Map();
  for (const f of ALL_FIXTURES) {
    const cat = categoryOf(f.id);
    byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
  }
  for (const [cat, n] of byCategory) console.log(`  - ${cat}: ${n}`);

  if (FLAG_DRY_RUN) {
    console.log("\n[dry-run] Validating fixture shapes...");
    for (const f of ALL_FIXTURES) {
      if (!f.id || !f.from || !f.subject || !f.body) {
        console.error(`  ✗ ${f.id ?? "(no id)"}: missing required field`);
        process.exit(1);
      }
    }
    console.log("  ✓ All fixtures valid.");
    console.log(`\n[dry-run] Skipping API calls. Run without --dry-run to actually seed.`);
    return;
  }

  const auth = await ensureCredentials();
  const gmail = google.gmail({ version: "v1", auth });

  console.log(`\nEnsuring label "${SEED_LABEL}" exists...`);
  const labelId = await findOrCreateLabel(gmail, SEED_LABEL);
  console.log(`  Label id: ${labelId}`);

  if (FLAG_RESET) {
    console.log(`\n--reset: deleting existing "${SEED_LABEL}" messages...`);
    const deleted = await deleteLabeledMessages(gmail, labelId);
    console.log(`  Deleted ${deleted} messages.`);
  } else {
    const existing = await countLabeledMessages(gmail, labelId);
    console.log(`\nFound ${existing} existing labeled messages.`);
    if (existing >= ALL_FIXTURES.length) {
      console.log(`  Already seeded (>= ${ALL_FIXTURES.length}). Skipping. Pass --reset to re-seed.`);
      return;
    }
  }

  console.log(`\nInserting ${ALL_FIXTURES.length} fixtures...`);
  const idToMessageId = new Map();
  let inserted = 0;
  for (let i = 0; i < ALL_FIXTURES.length; i++) {
    const fixture = ALL_FIXTURES[i];
    const { raw } = buildRawMessage(fixture, i, idToMessageId);
    try {
      await gmail.users.messages.insert({
        userId: "me",
        internalDateSource: "dateHeader",
        requestBody: { raw, labelIds: ["INBOX", "UNREAD", labelId] },
      });
      inserted++;
      if (inserted % 10 === 0 || inserted === ALL_FIXTURES.length) {
        console.log(`  ${inserted}/${ALL_FIXTURES.length}`);
      }
    } catch (err) {
      console.error(`  ✗ Failed to insert ${fixture.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log(`\nDone. Inserted ${inserted}/${ALL_FIXTURES.length} fixtures.`);
  console.log(`\nNext step: open the app (npm run dev), sign in as ${TEST_ACCOUNT}, and watch the seeded emails sync in.`);
}

main().catch((err) => {
  console.error("FATAL:", err instanceof Error ? err.stack : err);
  process.exit(1);
});
