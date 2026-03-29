/**
 * Builds a prompt section from relevant memories for a given sender.
 * Returns an empty string if no memories apply.
 *
 * Memories are capped per-scope to guarantee representation from each
 * specificity level, even when one scope has many entries.
 */
import { getRelevantMemories, getAccountMemories } from "../db";
import type { Memory } from "../../shared/types";

export const DRAFTING_CAP = 1000;
export const ANALYSIS_CAP = 50;

/**
 * Filters memories by scope and caps each to `cap`, then builds
 * human-readable sections for each non-empty scope.
 */
export function buildScopedSections(memories: Memory[], cap: number, senderEmail?: string): string[] {
  const person = memories.filter(m => m.scope === "person").slice(0, cap);
  const domain = memories.filter(m => m.scope === "domain").slice(0, cap);
  const category = memories.filter(m => m.scope === "category").slice(0, cap);
  const global = memories.filter(m => m.scope === "global").slice(0, cap);

  const sections: string[] = [];

  if (person.length > 0) {
    const label = person[0].scopeValue ?? senderEmail ?? "this person";
    sections.push(`For ${label} specifically:\n${formatMemories(person)}`);
  }

  if (domain.length > 0) {
    const domainLabel = domain[0].scopeValue ?? "this domain";
    sections.push(`For anyone at ${domainLabel}:\n${formatMemories(domain)}`);
  }

  if (category.length > 0) {
    sections.push(`For certain types of emails (apply only if relevant):\n${formatCategoryMemories(category)}`);
  }

  if (global.length > 0) {
    sections.push(`General preferences:\n${formatMemories(global)}`);
  }

  return sections;
}

export function buildMemoryContext(senderEmail: string, accountId: string): string {
  const memories = getRelevantMemories(senderEmail, accountId, "drafting");
  if (memories.length === 0) return "";
  const sections = buildScopedSections(memories, DRAFTING_CAP, senderEmail);
  return `=== YOUR PREFERENCES (MEMORIES) ===\n${sections.join("\n\n")}\n`;
}

/**
 * Builds a broader memory context for the agent system prompt.
 * With senderEmail: returns person + domain + category + global memories.
 * Without: returns only category + global memories.
 *
 * Fetches both drafting and analysis memories so the agent can apply
 * all user preferences across analysis, lookups, drafts, and general behavior.
 */
export function buildAgentMemoryContext(accountId: string, senderEmail?: string): string {
  const draftingMemories = senderEmail
    ? getRelevantMemories(senderEmail, accountId, "drafting")
    : getAccountMemories(accountId, "drafting");
  const analysisMemories = senderEmail
    ? getRelevantMemories(senderEmail, accountId, "analysis")
    : getAccountMemories(accountId, "analysis");

  const allMemories = [...draftingMemories, ...analysisMemories];
  if (allMemories.length === 0) return "";

  const sections = buildScopedSections(allMemories, DRAFTING_CAP, senderEmail);
  return `## User Preferences & Instructions\nThese are persistent preferences the user has saved. Apply them to all email handling — analysis, lookups, drafts, and general behavior.\n\n${sections.join("\n\n")}\n`;
}

/**
 * Builds a prompt section from analysis memories for a given sender.
 * Injected into the analysis (priority classification) prompt, not the draft prompt.
 * Appended to the user message to preserve system prompt caching.
 */
export function buildAnalysisMemoryContext(senderEmail: string, accountId: string): string {
  const memories = getRelevantMemories(senderEmail, accountId, "analysis");
  if (memories.length === 0) return "";
  const sections = buildScopedSections(memories, ANALYSIS_CAP, senderEmail);
  return `\n=== USER'S PRIORITY PREFERENCES ===\nThe user has saved these preferences about how to classify emails. Apply them when relevant:\n${sections.join("\n\n")}\n`;
}

function formatMemories(memories: Memory[]): string {
  return memories.map(m => `- ${m.content}`).join("\n");
}

function formatCategoryMemories(memories: Memory[]): string {
  return memories.map(m => `- ${m.scopeValue ? `[${m.scopeValue}] ` : ""}${m.content}`).join("\n");
}
