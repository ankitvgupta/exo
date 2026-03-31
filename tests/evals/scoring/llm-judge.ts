/**
 * LLM judge for draft quality evaluation.
 *
 * Uses Claude Sonnet to score draft tone, relevance, and formality.
 * Records judge costs in llm_calls (caller: "eval-judge").
 *
 * Not used in the analysis eval run — structured here for future draft evals.
 */

import type { Email } from "../../../src/shared/types";

export interface DraftJudgment {
  fixture_id: string;
  /** 1-10 scale: does the draft address the email's core question/request? */
  relevance: number;
  /** 1-10 scale: is the tone appropriate for the email context? */
  tone: number;
  /** 1-10 scale: is the formality level correct given the sender/context? */
  formality: number;
  /** Free-text explanation from the judge */
  reasoning: string;
  /** Combined weighted score (0-10) */
  overall: number;
}

/**
 * Judge the quality of a generated draft reply.
 *
 * Calls Claude Sonnet as a judge with a rubric prompt.
 * The judge never sees the expected output — it evaluates the draft
 * against the original email context only.
 */
export interface DraftJudgeInput {
  fixtureId: string;
  email: Email;
  draftBody: string;
  expectedFormality: "formal" | "casual" | "neutral";
}

/**
 * Judge the quality of a generated draft reply.
 *
 * Calls Claude Sonnet as a judge with a rubric prompt.
 * The judge never sees the expected output — it evaluates the draft
 * against the original email context only.
 */
export async function judgeDraftQuality(input: DraftJudgeInput): Promise<DraftJudgment> {
  // TODO: Implement when draft evals are needed.
  // Will use createMessage with caller: "eval-judge" for cost attribution.
  // The input parameter will be destructured here:
  // const { fixtureId, email, draftBody, expectedFormality } = input;
  void input;
  throw new Error("Draft quality judging not yet implemented — analysis evals only for now");
}
