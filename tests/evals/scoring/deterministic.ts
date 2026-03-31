/**
 * Deterministic scoring for email analysis evals.
 *
 * Scores structured fields (needs_reply, priority) with exact match.
 * No LLM calls — fast and fully reproducible.
 */

import type { AnalysisResult } from "../../../src/shared/types";

export interface EvalFixtureExpected {
  needs_reply: boolean;
  priority?: "high" | "medium" | "low";
}

export interface DeterministicResult {
  fixture_id: string;
  needs_reply_correct: boolean;
  /** Only checked when expected needs_reply is true */
  priority_correct: boolean;
  /** 0-10 scale: 5 for needs_reply match + 5 for priority match */
  score: number;
}

/**
 * Score a single analysis result against the expected fixture output.
 *
 * Scoring:
 * - needs_reply match: 5 points
 * - priority match (when expected needs_reply=true): 5 points
 * - priority auto-awarded when expected needs_reply=false: 5 points
 *   (because priority is meaningless when no reply is needed)
 */
export function scoreDeterministic(
  fixtureId: string,
  actual: AnalysisResult,
  expected: EvalFixtureExpected,
): DeterministicResult {
  const needsReplyCorrect = actual.needs_reply === expected.needs_reply;

  // Priority only matters when a reply is expected
  let priorityCorrect: boolean;
  if (!expected.needs_reply) {
    // No reply expected — priority is irrelevant, auto-pass
    priorityCorrect = true;
  } else {
    // Reply expected — check priority match
    priorityCorrect = actual.priority === expected.priority;
  }

  let score = 0;
  if (needsReplyCorrect) score += 5;
  if (priorityCorrect) score += 5;

  return {
    fixture_id: fixtureId,
    needs_reply_correct: needsReplyCorrect,
    priority_correct: priorityCorrect,
    score,
  };
}
