import type { CorrespondentProfile, Email } from "../../shared/types";
import { stripHtmlForSearch, saveEmail } from "../db";
import {
  getSentEmailsToRecipient,
  getSentEmailsToSameDomain,
  getSentEmailsByFormalityRange,
  getCorrespondentProfile,
  saveCorrespondentProfile,
  getSentEmailCountToRecipient,
} from "../db";
import type { GmailClient } from "./gmail-client";

// ============================================
// Heuristic signal extraction
// ============================================

type EmailSignals = {
  greeting: string;   // "hey" | "hi" | "hello" | "dear" | "none"
  signoff: string;    // "thanks" | "best" | "cheers" | "regards" | "none"
  wordCount: number;
};

function detectGreeting(text: string): string {
  const firstLine = text.split("\n").find(l => l.trim().length > 0) ?? "";
  const lower = firstLine.toLowerCase().trim();

  if (/^dear\b/.test(lower)) return "dear";
  if (/^hello\b/.test(lower)) return "hello";
  if (/^hi\b/.test(lower)) return "hi";
  if (/^hey\b/.test(lower)) return "hey";
  return "none";
}

function detectSignoff(text: string): string {
  // body_text may have newlines stripped (from stripHtmlForSearch), so check
  // the last ~50 words instead of relying on line breaks
  const words = text.split(/\s+/);
  const tail = words.slice(-50).join(" ").toLowerCase();

  if (/\bregards\b/.test(tail)) return "regards";
  if (/\bbest\b/.test(tail)) return "best";
  if (/\bcheers\b/.test(tail)) return "cheers";
  if (/\bthanks\b/.test(tail) || /\bthank you\b/.test(tail)) return "thanks";
  return "none";
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(w => w.length > 0).length;
}

export function extractEmailSignals(bodyText: string): EmailSignals {
  return {
    greeting: detectGreeting(bodyText),
    signoff: detectSignoff(bodyText),
    wordCount: countWords(bodyText),
  };
}

// ============================================
// Profile computation
// ============================================

const GREETING_FORMALITY: Record<string, number> = {
  none: 0.1,
  hey: 0.2,
  hi: 0.4,
  hello: 0.5,
  dear: 0.9,
};

const SIGNOFF_FORMALITY: Record<string, number> = {
  none: 0.1,
  cheers: 0.3,
  thanks: 0.4,
  best: 0.6,
  regards: 0.9,
};

function mostCommon(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) {
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best = values[0] ?? "none";
  let bestCount = 0;
  for (const [val, count] of counts) {
    if (count > bestCount) {
      best = val;
      bestCount = count;
    }
  }
  return best;
}

export function computeCorrespondentProfile(
  recipientEmail: string,
  accountId: string
): CorrespondentProfile | null {
  const sentEmails = getSentEmailsToRecipient(recipientEmail, accountId, 50);
  if (sentEmails.length === 0) return null;

  const signals = sentEmails.map(e => {
    const text = e.body_text ?? stripHtmlForSearch(e.body);
    return extractEmailSignals(text);
  });

  const greetings = signals.map(s => s.greeting);
  const signoffs = signals.map(s => s.signoff);
  const wordCounts = signals.map(s => s.wordCount);
  const avgWordCount = wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length;

  const dominantGreeting = mostCommon(greetings);
  const dominantSignoff = mostCommon(signoffs);

  // Compute formality score from weighted heuristics
  const greetingScore = GREETING_FORMALITY[dominantGreeting] ?? 0.5;
  const signoffScore = SIGNOFF_FORMALITY[dominantSignoff] ?? 0.5;

  // Length factor: shorter avg → lower formality (normalize against 200 words as "moderate")
  const lengthFactor = Math.min(avgWordCount / 200, 1.0);

  // Frequency factor: more emails → lower formality (familiarity)
  // 10+ emails = very familiar (0.0), 1 email = formal (1.0)
  const frequencyFactor = Math.max(0, 1.0 - sentEmails.length / 10);

  const formalityScore = Math.max(0, Math.min(1,
    greetingScore * 0.3 + signoffScore * 0.3 + lengthFactor * 0.2 + frequencyFactor * 0.2
  ));

  const profile: CorrespondentProfile = {
    email: recipientEmail,
    accountId,
    displayName: null, // Could be extracted from email headers later
    emailCount: getSentEmailCountToRecipient(recipientEmail, accountId),
    avgWordCount,
    dominantGreeting,
    dominantSignoff,
    formalityScore,
    lastComputedAt: Date.now(),
  };

  saveCorrespondentProfile(profile);
  return profile;
}

// ============================================
// Context builder
// ============================================

function truncateBody(bodyText: string, maxWords: number = 300): string {
  const words = bodyText.split(/\s+/);
  if (words.length <= maxWords) return bodyText;
  return words.slice(0, maxWords).join(" ") + "...";
}

function formalityDescription(score: number): string {
  if (score < 0.25) return "very informal";
  if (score < 0.45) return "casual";
  if (score < 0.65) return "moderately formal";
  if (score < 0.85) return "formal";
  return "very formal";
}

type ExampleEmail = {
  recipientEmail: string;
  date: string;
  body: string;
};

type SentEmailRow = {
  id: string;
  subject: string;
  body_text: string | null;
  body: string;
  date: string;
  is_reply: number;
};

/**
 * Search Gmail for sent emails matching `query`, save them locally, and
 * return them in SentEmailRow shape for immediate use as style examples.
 */
async function fetchAndCacheSentEmails(
  gmailClient: GmailClient,
  query: string,
  accountId: string,
  limit: number,
): Promise<SentEmailRow[]> {
  const { results: searchResults } = await gmailClient.searchEmails(query, limit);
  if (searchResults.length === 0) return [];

  const fetched = await Promise.allSettled(
    searchResults.map(r => gmailClient.readEmail(r.id)),
  );

  const rows: SentEmailRow[] = [];
  for (const result of fetched) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const email: Email = result.value;
    // Persist to local DB so future calls find them without hitting Gmail
    try {
      saveEmail(email, accountId);
    } catch (err) {
      console.warn(`[StyleProfiler] Failed to cache email ${email.id}:`, err);
    }
    rows.push({
      id: email.id,
      subject: email.subject,
      body_text: stripHtmlForSearch(email.body),
      body: email.body,
      date: email.date,
      is_reply: email.subject.toLowerCase().startsWith("re:") ? 1 : 0,
    });
  }

  console.log(`[StyleProfiler] Gmail search "${query}" → fetched ${rows.length} emails`);
  return rows;
}

function addRowsToExamples(
  rows: SentEmailRow[],
  label: string,
  examples: ExampleEmail[],
  seenIds: Set<string>,
  maxTotal: number,
): void {
  for (const e of rows) {
    if (examples.length >= maxTotal) break;
    if (seenIds.has(e.id)) continue;
    seenIds.add(e.id);
    const text = e.body_text ?? stripHtmlForSearch(e.body);
    examples.push({ recipientEmail: label, date: e.date, body: truncateBody(text) });
  }
}

const MIN_EXAMPLES = 3;

async function selectExamples(
  recipientEmail: string,
  accountId: string,
  gmailClient?: GmailClient | null,
): Promise<ExampleEmail[]> {
  const examples: ExampleEmail[] = [];
  const seenIds = new Set<string>();

  // 1. Direct emails to this person (prefer replies, most recent)
  const directEmails = getSentEmailsToRecipient(recipientEmail, accountId, 5);
  // Sort replies first, then by date (already sorted by date DESC from query)
  const sorted = [...directEmails].sort((a, b) => b.is_reply - a.is_reply);
  addRowsToExamples(sorted, recipientEmail, examples, seenIds, MIN_EXAMPLES);

  // 1.5. Gmail fallback for direct recipient
  if (examples.length < MIN_EXAMPLES && gmailClient) {
    try {
      const gmailRows = await fetchAndCacheSentEmails(
        gmailClient,
        `from:me to:"${recipientEmail.replace(/"/g, '\\"')}" in:sent`,
        accountId,
        5,
      );
      addRowsToExamples(gmailRows, recipientEmail, examples, seenIds, MIN_EXAMPLES);
    } catch (err) {
      console.warn("[StyleProfiler] Gmail recipient search failed:", err);
    }
  }

  if (examples.length >= MIN_EXAMPLES) return examples.slice(0, MIN_EXAMPLES);

  // 2. Fallback: same domain
  const domain = recipientEmail.includes("@") ? recipientEmail.split("@")[1] : null;
  if (domain) {
    const domainEmails = getSentEmailsToSameDomain(domain, accountId, 5);
    addRowsToExamples(domainEmails, `@${domain}`, examples, seenIds, MIN_EXAMPLES);

    // 2.5. Gmail fallback for domain
    if (examples.length < MIN_EXAMPLES && gmailClient) {
      try {
        const gmailRows = await fetchAndCacheSentEmails(
          gmailClient,
          `from:me to:*@${domain} in:sent`,
          accountId,
          5,
        );
        addRowsToExamples(gmailRows, `@${domain}`, examples, seenIds, MIN_EXAMPLES);
      } catch (err) {
        console.warn("[StyleProfiler] Gmail domain search failed:", err);
      }
    }
  }

  if (examples.length >= MIN_EXAMPLES) return examples.slice(0, MIN_EXAMPLES);

  // 3. Fallback: similar formality from any correspondent (local only)
  const profile = getCorrespondentProfile(recipientEmail, accountId);
  if (profile) {
    const range = 0.15;
    const low = Math.max(0, profile.formalityScore - range);
    const high = Math.min(1, profile.formalityScore + range);
    const similarEmails = getSentEmailsByFormalityRange(accountId, low, high, 5);
    addRowsToExamples(similarEmails, "similar formality", examples, seenIds, MIN_EXAMPLES);
  }

  return examples.slice(0, MIN_EXAMPLES);
}

export async function buildStyleContext(
  recipientEmail: string,
  accountId: string,
  stylePrompt: string,
  gmailClient?: GmailClient | null,
): Promise<string> {
  // Get or compute correspondent profile
  let profile = getCorrespondentProfile(recipientEmail, accountId);

  const STALE_DAYS = 7;
  const isStale = profile && (Date.now() - profile.lastComputedAt > STALE_DAYS * 24 * 60 * 60 * 1000);
  const countChanged = profile && getSentEmailCountToRecipient(recipientEmail, accountId) !== profile.emailCount;

  if (!profile || isStale || countChanged) {
    profile = computeCorrespondentProfile(recipientEmail, accountId);
  }

  // Select examples (with optional Gmail fallback)
  const examples = await selectExamples(recipientEmail, accountId, gmailClient);

  // No examples = no style context
  if (examples.length === 0) return "";

  let context = `=== YOUR WRITING STYLE ===\n${stylePrompt}\n`;

  if (profile) {
    const desc = formalityDescription(profile.formalityScore);
    context += `\nFormality with this person: ${desc} (${profile.emailCount} previous email${profile.emailCount === 1 ? "" : "s"})\n`;
  }

  context += "\n=== EXAMPLES OF EMAILS YOU'VE SENT ===\n";

  examples.forEach((ex, i) => {
    context += `\nExample ${i + 1} (to ${ex.recipientEmail}, ${ex.date}):\n${ex.body}\n`;
  });

  return context;
}
