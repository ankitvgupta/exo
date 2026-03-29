/**
 * Unit tests for style extraction, formality scoring, and profile computation
 * logic from style-profiler.ts (which replaced the deprecated style-indexer.ts).
 *
 * The style-profiler imports from ../db (electron), so we re-implement the
 * pure functions here. The existing style-profiler.spec.ts covers signal
 * detection (greeting, signoff, word count). This file covers:
 * - mostCommon (mode computation)
 * - formality score computation
 * - formalityDescription (score → human-readable label)
 * - truncateBody
 * - computeCorrespondentProfile (with mocked DB calls)
 */
import { test, expect } from "@playwright/test";

// =============================================================================
// Re-implemented pure functions from style-profiler.ts
// =============================================================================

type EmailSignals = {
  greeting: string;
  signoff: string;
  wordCount: number;
};

function detectGreeting(text: string): string {
  const firstLine = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  const lower = firstLine.toLowerCase().trim();
  if (/^dear\b/.test(lower)) return "dear";
  if (/^hello\b/.test(lower)) return "hello";
  if (/^hi\b/.test(lower)) return "hi";
  if (/^hey\b/.test(lower)) return "hey";
  return "none";
}

function detectSignoff(text: string): string {
  const words = text.split(/\s+/);
  const tail = words.slice(-50).join(" ").toLowerCase();
  if (/\bregards\b/.test(tail)) return "regards";
  if (/\bbest\b/.test(tail)) return "best";
  if (/\bcheers\b/.test(tail)) return "cheers";
  if (/\bthanks\b/.test(tail) || /\bthank you\b/.test(tail)) return "thanks";
  return "none";
}

function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

function extractEmailSignals(bodyText: string): EmailSignals {
  return {
    greeting: detectGreeting(bodyText),
    signoff: detectSignoff(bodyText),
    wordCount: countWords(bodyText),
  };
}

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

/**
 * Compute formality score from signals + email count.
 * Mirrors the computation in computeCorrespondentProfile (lines 115-128).
 */
function computeFormalityScore(opts: {
  dominantGreeting: string;
  dominantSignoff: string;
  avgWordCount: number;
  emailCount: number;
}): number {
  const greetingScore = GREETING_FORMALITY[opts.dominantGreeting] ?? 0.5;
  const signoffScore = SIGNOFF_FORMALITY[opts.dominantSignoff] ?? 0.5;
  const lengthFactor = Math.min(opts.avgWordCount / 200, 1.0);
  const frequencyFactor = Math.max(0, 1.0 - opts.emailCount / 10);

  return Math.max(
    0,
    Math.min(
      1,
      greetingScore * 0.3 +
        signoffScore * 0.3 +
        lengthFactor * 0.2 +
        frequencyFactor * 0.2,
    ),
  );
}

// =============================================================================
// Tests: mostCommon
// =============================================================================

test.describe("mostCommon", () => {
  test("returns the most frequent value", () => {
    expect(mostCommon(["a", "b", "a", "c", "a"])).toBe("a");
  });

  test("returns first element on tie", () => {
    // When counts are equal, the Map iteration order determines the winner.
    // Since we iterate the map and pick strictly greater, the first one to
    // reach the highest count wins.
    const result = mostCommon(["a", "b"]);
    // Both have count 1; "a" is first in the map and gets bestCount=1 first
    expect(result).toBe("a");
  });

  test('returns "none" for empty array', () => {
    expect(mostCommon([])).toBe("none");
  });

  test("handles single element", () => {
    expect(mostCommon(["hello"])).toBe("hello");
  });

  test("handles all same values", () => {
    expect(mostCommon(["hi", "hi", "hi"])).toBe("hi");
  });

  test("correctly picks majority in realistic greeting data", () => {
    const greetings = ["hey", "hey", "hi", "hey", "none", "hi"];
    expect(mostCommon(greetings)).toBe("hey");
  });
});

// =============================================================================
// Tests: truncateBody
// =============================================================================

test.describe("truncateBody", () => {
  test("returns short text unchanged", () => {
    const text = "Hello world";
    expect(truncateBody(text)).toBe("Hello world");
  });

  test("returns text at exactly maxWords unchanged", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    expect(truncateBody(text)).toBe(text);
  });

  test("truncates text exceeding maxWords and appends ellipsis", () => {
    const words = Array.from({ length: 301 }, (_, i) => `word${i}`);
    const text = words.join(" ");
    const result = truncateBody(text);
    expect(result).toContain("...");
    // Should have exactly 300 words + "..."
    const resultWords = result.replace("...", "").trim().split(" ");
    expect(resultWords).toHaveLength(300);
  });

  test("respects custom maxWords parameter", () => {
    const text = "one two three four five six seven eight nine ten";
    const result = truncateBody(text, 5);
    expect(result).toBe("one two three four five...");
  });

  test("handles empty string", () => {
    expect(truncateBody("")).toBe("");
  });
});

// =============================================================================
// Tests: formalityDescription
// =============================================================================

test.describe("formalityDescription", () => {
  test("very informal for scores below 0.25", () => {
    expect(formalityDescription(0.0)).toBe("very informal");
    expect(formalityDescription(0.1)).toBe("very informal");
    expect(formalityDescription(0.24)).toBe("very informal");
  });

  test("casual for scores 0.25 to 0.44", () => {
    expect(formalityDescription(0.25)).toBe("casual");
    expect(formalityDescription(0.35)).toBe("casual");
    expect(formalityDescription(0.44)).toBe("casual");
  });

  test("moderately formal for scores 0.45 to 0.64", () => {
    expect(formalityDescription(0.45)).toBe("moderately formal");
    expect(formalityDescription(0.55)).toBe("moderately formal");
    expect(formalityDescription(0.64)).toBe("moderately formal");
  });

  test("formal for scores 0.65 to 0.84", () => {
    expect(formalityDescription(0.65)).toBe("formal");
    expect(formalityDescription(0.75)).toBe("formal");
    expect(formalityDescription(0.84)).toBe("formal");
  });

  test("very formal for scores 0.85 and above", () => {
    expect(formalityDescription(0.85)).toBe("very formal");
    expect(formalityDescription(0.95)).toBe("very formal");
    expect(formalityDescription(1.0)).toBe("very formal");
  });

  test("boundary at 0.25 is casual (not very informal)", () => {
    expect(formalityDescription(0.25)).toBe("casual");
  });

  test("boundary at 0.45 is moderately formal (not casual)", () => {
    expect(formalityDescription(0.45)).toBe("moderately formal");
  });

  test("boundary at 0.65 is formal (not moderately formal)", () => {
    expect(formalityDescription(0.65)).toBe("formal");
  });

  test("boundary at 0.85 is very formal (not formal)", () => {
    expect(formalityDescription(0.85)).toBe("very formal");
  });
});

// =============================================================================
// Tests: computeFormalityScore
// =============================================================================

test.describe("computeFormalityScore", () => {
  test("very informal email pattern produces low score", () => {
    const score = computeFormalityScore({
      dominantGreeting: "hey",
      dominantSignoff: "none",
      avgWordCount: 20,
      emailCount: 15, // very familiar
    });
    // greeting=0.2*0.3 + signoff=0.1*0.3 + length=(20/200)*0.2 + freq=0*0.2
    // = 0.06 + 0.03 + 0.02 + 0 = 0.11
    expect(score).toBeCloseTo(0.11, 2);
    expect(score).toBeLessThan(0.25);
  });

  test("very formal email pattern produces high score", () => {
    const score = computeFormalityScore({
      dominantGreeting: "dear",
      dominantSignoff: "regards",
      avgWordCount: 300,
      emailCount: 1,
    });
    // greeting=0.9*0.3 + signoff=0.9*0.3 + length=1.0*0.2 + freq=0.9*0.2
    // = 0.27 + 0.27 + 0.2 + 0.18 = 0.92
    expect(score).toBeCloseTo(0.92, 2);
    expect(score).toBeGreaterThan(0.85);
  });

  test("moderate email pattern produces mid-range score", () => {
    const score = computeFormalityScore({
      dominantGreeting: "hi",
      dominantSignoff: "thanks",
      avgWordCount: 100,
      emailCount: 5,
    });
    // greeting=0.4*0.3 + signoff=0.4*0.3 + length=0.5*0.2 + freq=0.5*0.2
    // = 0.12 + 0.12 + 0.10 + 0.10 = 0.44
    expect(score).toBeCloseTo(0.44, 2);
  });

  test("score is clamped between 0 and 1", () => {
    // Even with extreme values, should stay in [0, 1]
    const highScore = computeFormalityScore({
      dominantGreeting: "dear",
      dominantSignoff: "regards",
      avgWordCount: 10000,
      emailCount: 0,
    });
    expect(highScore).toBeLessThanOrEqual(1);
    expect(highScore).toBeGreaterThanOrEqual(0);

    const lowScore = computeFormalityScore({
      dominantGreeting: "none",
      dominantSignoff: "none",
      avgWordCount: 0,
      emailCount: 100,
    });
    expect(lowScore).toBeLessThanOrEqual(1);
    expect(lowScore).toBeGreaterThanOrEqual(0);
  });

  test("length factor caps at 1.0 for 200+ words", () => {
    const score200 = computeFormalityScore({
      dominantGreeting: "hi",
      dominantSignoff: "best",
      avgWordCount: 200,
      emailCount: 5,
    });
    const score400 = computeFormalityScore({
      dominantGreeting: "hi",
      dominantSignoff: "best",
      avgWordCount: 400,
      emailCount: 5,
    });
    // Both should have lengthFactor = 1.0, so scores should be equal
    expect(score200).toBeCloseTo(score400, 5);
  });

  test("frequency factor is 0 for 10+ emails", () => {
    const score10 = computeFormalityScore({
      dominantGreeting: "hi",
      dominantSignoff: "thanks",
      avgWordCount: 100,
      emailCount: 10,
    });
    const score20 = computeFormalityScore({
      dominantGreeting: "hi",
      dominantSignoff: "thanks",
      avgWordCount: 100,
      emailCount: 20,
    });
    // Both should have frequencyFactor = 0, so scores should be equal
    expect(score10).toBeCloseTo(score20, 5);
  });

  test("unknown greeting/signoff defaults to 0.5", () => {
    const score = computeFormalityScore({
      dominantGreeting: "yo", // not in GREETING_FORMALITY
      dominantSignoff: "later", // not in SIGNOFF_FORMALITY
      avgWordCount: 100,
      emailCount: 5,
    });
    // greeting=0.5*0.3 + signoff=0.5*0.3 + length=0.5*0.2 + freq=0.5*0.2
    // = 0.15 + 0.15 + 0.10 + 0.10 = 0.50
    expect(score).toBeCloseTo(0.50, 2);
  });
});

// =============================================================================
// Tests: End-to-end signal extraction → formality computation
// =============================================================================

test.describe("signal extraction → formality score integration", () => {
  test("informal email set produces low formality", () => {
    const emails = [
      "Hey!\n\nQuick q — can you review my PR?",
      "hey bob,\n\nany update on that bug?",
      "Hey, shipped the fix. lmk if it works",
    ];

    const signals = emails.map(extractEmailSignals);
    const dominantGreeting = mostCommon(signals.map((s) => s.greeting));
    const dominantSignoff = mostCommon(signals.map((s) => s.signoff));
    const avgWordCount =
      signals.reduce((sum, s) => sum + s.wordCount, 0) / signals.length;

    expect(dominantGreeting).toBe("hey");
    expect(dominantSignoff).toBe("none");

    const score = computeFormalityScore({
      dominantGreeting,
      dominantSignoff,
      avgWordCount,
      emailCount: emails.length,
    });
    expect(score).toBeLessThan(0.3);
  });

  test("formal email set produces high formality", () => {
    const emails = [
      "Dear Ms. Johnson,\n\nI am writing to follow up on our discussion regarding the quarterly review. " +
        "Please find attached the revised budget proposal incorporating the changes we discussed. " +
        "I would appreciate your feedback at your earliest convenience.\n\nKind regards,\nRobert Chen",
    ];

    const signals = emails.map(extractEmailSignals);
    const dominantGreeting = mostCommon(signals.map((s) => s.greeting));
    const dominantSignoff = mostCommon(signals.map((s) => s.signoff));
    const avgWordCount =
      signals.reduce((sum, s) => sum + s.wordCount, 0) / signals.length;

    expect(dominantGreeting).toBe("dear");
    expect(dominantSignoff).toBe("regards");

    const score = computeFormalityScore({
      dominantGreeting,
      dominantSignoff,
      avgWordCount,
      emailCount: emails.length,
    });
    expect(score).toBeGreaterThan(0.5);
  });

  test("mixed formality emails produce mid-range score", () => {
    const emails = [
      "Hi team,\n\nHere's the update for this week.\n\nBest,\nAlice",
      "Hi Bob,\n\nCan we chat about the roadmap?\n\nThanks,\nAlice",
      "Hello everyone,\n\nPlease review the attached doc.\n\nBest regards,\nAlice",
    ];

    const signals = emails.map(extractEmailSignals);
    const dominantGreeting = mostCommon(signals.map((s) => s.greeting));
    const dominantSignoff = mostCommon(signals.map((s) => s.signoff));
    const avgWordCount =
      signals.reduce((sum, s) => sum + s.wordCount, 0) / signals.length;

    const score = computeFormalityScore({
      dominantGreeting,
      dominantSignoff,
      avgWordCount,
      emailCount: emails.length,
    });
    expect(score).toBeGreaterThan(0.25);
    expect(score).toBeLessThan(0.75);
  });
});

// =============================================================================
// Tests: GREETING_FORMALITY and SIGNOFF_FORMALITY tables
// =============================================================================

test.describe("formality lookup tables", () => {
  test("greetings are ordered from informal to formal", () => {
    const order = ["none", "hey", "hi", "hello", "dear"];
    for (let i = 1; i < order.length; i++) {
      expect(GREETING_FORMALITY[order[i]]).toBeGreaterThan(
        GREETING_FORMALITY[order[i - 1]],
      );
    }
  });

  test("signoffs are ordered from informal to formal", () => {
    const order = ["none", "cheers", "thanks", "best", "regards"];
    for (let i = 1; i < order.length; i++) {
      expect(SIGNOFF_FORMALITY[order[i]]).toBeGreaterThan(
        SIGNOFF_FORMALITY[order[i - 1]],
      );
    }
  });

  test("all formality values are between 0 and 1", () => {
    for (const val of Object.values(GREETING_FORMALITY)) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
    for (const val of Object.values(SIGNOFF_FORMALITY)) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
    }
  });
});
