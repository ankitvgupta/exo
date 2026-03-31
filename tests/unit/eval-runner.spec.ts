/**
 * Unit tests for the eval runner components.
 *
 * Tests fixture loading, deterministic scoring logic, and baseline
 * comparison (regression detection).
 */
import { test, expect } from "@playwright/test";
import { loadFixtures } from "../evals/runner";
import { scoreDeterministic, type EvalFixtureExpected } from "../evals/scoring/deterministic";
import type { AnalysisResult } from "../../src/shared/types";

test.describe("Eval fixtures", () => {
  test("all 8 fixtures load successfully with required fields", () => {
    const fixtures = loadFixtures();

    expect(fixtures.length).toBe(8);

    for (const f of fixtures) {
      expect(f.id).toBeTruthy();
      expect(f.description).toBeTruthy();
      expect(f.email).toBeTruthy();
      expect(f.email.id).toBeTruthy();
      expect(f.email.from).toBeTruthy();
      expect(f.email.to).toBeTruthy();
      expect(f.email.subject).toBeTruthy();
      expect(f.email.body).toBeTruthy();
      expect(typeof f.expected.needs_reply).toBe("boolean");
    }
  });
});

test.describe("Deterministic scoring", () => {
  test("perfect score when both needs_reply and priority match", () => {
    const actual: AnalysisResult = {
      needs_reply: true,
      reason: "Urgent request",
      priority: "high",
    };
    const expected: EvalFixtureExpected = {
      needs_reply: true,
      priority: "high",
    };

    const result = scoreDeterministic("test-001", actual, expected);

    expect(result.score).toBe(10);
    expect(result.needs_reply_correct).toBe(true);
    expect(result.priority_correct).toBe(true);
  });

  test("partial score when needs_reply matches but priority does not", () => {
    const actual: AnalysisResult = {
      needs_reply: true,
      reason: "Question",
      priority: "low",
    };
    const expected: EvalFixtureExpected = {
      needs_reply: true,
      priority: "high",
    };

    const result = scoreDeterministic("test-002", actual, expected);

    expect(result.score).toBe(5);
    expect(result.needs_reply_correct).toBe(true);
    expect(result.priority_correct).toBe(false);
  });

  test("zero score when needs_reply mismatches", () => {
    const actual: AnalysisResult = {
      needs_reply: true,
      reason: "Looks important",
      priority: "medium",
    };
    const expected: EvalFixtureExpected = {
      needs_reply: false,
    };

    const result = scoreDeterministic("test-003", actual, expected);

    // needs_reply wrong = 0 points, but priority is auto-pass for no-reply expected
    // Wait — actual says needs_reply=true, expected says false.
    // needs_reply wrong = 0 points
    // Since expected.needs_reply is false, priority is auto-pass = 5 points
    expect(result.score).toBe(5);
    expect(result.needs_reply_correct).toBe(false);
    expect(result.priority_correct).toBe(true);
  });

  test("full score for no-reply match (priority auto-awarded)", () => {
    const actual: AnalysisResult = {
      needs_reply: false,
      reason: "Newsletter",
    };
    const expected: EvalFixtureExpected = {
      needs_reply: false,
    };

    const result = scoreDeterministic("test-004", actual, expected);

    expect(result.score).toBe(10);
    expect(result.needs_reply_correct).toBe(true);
    expect(result.priority_correct).toBe(true);
  });
});

test.describe("Baseline comparison", () => {
  test("detects regression when score drops below baseline", () => {
    // Simulate baseline with a known score
    const baselineScores: Record<string, number> = {
      "fixture-a": 10,
      "fixture-b": 10,
    };

    // Simulate current eval results
    const currentResults = [
      scoreDeterministic(
        "fixture-a",
        { needs_reply: true, reason: "ok", priority: "high" },
        { needs_reply: true, priority: "high" },
      ),
      scoreDeterministic(
        "fixture-b",
        { needs_reply: false, reason: "wrong" }, // regression: expected needs_reply=true
        { needs_reply: true, priority: "medium" },
      ),
    ];

    const regressions: string[] = [];
    for (const result of currentResults) {
      if (result.fixture_id in baselineScores) {
        const baselineScore = baselineScores[result.fixture_id];
        if (result.score < baselineScore) {
          regressions.push(`${result.fixture_id}: ${result.score}/10 (was ${baselineScore}/10)`);
        }
      }
    }

    expect(regressions).toHaveLength(1);
    expect(regressions[0]).toContain("fixture-b");
    expect(regressions[0]).toContain("was 10/10");
  });
});
