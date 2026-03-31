/**
 * Unit tests for memory-context.ts pure logic.
 *
 * The actual module imports getRelevantMemories/getAccountMemories from "../db",
 * which requires SQLite. We extract and test the pure formatting/capping logic
 * independently, mirroring the source implementation.
 */
import { test, expect } from "@playwright/test";
import type { Memory } from "../../src/shared/types";

// ============================================================
// Pure logic extracted from src/main/services/memory-context.ts
// ============================================================

const DRAFTING_CAP = 1000;
const ANALYSIS_CAP = 50;

function formatMemories(memories: Memory[]): string {
  return memories.map((m) => `- ${m.content}`).join("\n");
}

function formatCategoryMemories(memories: Memory[]): string {
  return memories
    .map((m) => `- ${m.scopeValue ? `[${m.scopeValue}] ` : ""}${m.content}`)
    .join("\n");
}

function buildScopedSections(memories: Memory[], cap: number, senderEmail?: string): string[] {
  const person = memories.filter((m) => m.scope === "person").slice(0, cap);
  const domain = memories.filter((m) => m.scope === "domain").slice(0, cap);
  const category = memories.filter((m) => m.scope === "category").slice(0, cap);
  const global = memories.filter((m) => m.scope === "global").slice(0, cap);

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
    sections.push(
      `For certain types of emails (apply only if relevant):\n${formatCategoryMemories(category)}`,
    );
  }

  if (global.length > 0) {
    sections.push(`General preferences:\n${formatMemories(global)}`);
  }

  return sections;
}

/**
 * Mirrors buildMemoryContext() logic without DB dependency.
 */
function buildMemoryContextFromMemories(memories: Memory[], senderEmail: string): string {
  if (memories.length === 0) return "";
  const sections = buildScopedSections(memories, DRAFTING_CAP, senderEmail);
  return `=== YOUR PREFERENCES (MEMORIES) ===\n${sections.join("\n\n")}\n`;
}

/**
 * Mirrors buildAgentMemoryContext() logic without DB dependency.
 */
function buildAgentMemoryContextFromMemories(memories: Memory[], senderEmail?: string): string {
  if (memories.length === 0) return "";
  const sections = buildScopedSections(memories, DRAFTING_CAP, senderEmail);
  return `## User Preferences & Instructions\nThese are persistent preferences the user has saved. Apply them to all email handling — analysis, lookups, drafts, and general behavior.\n\n${sections.join("\n\n")}\n`;
}

/**
 * Mirrors buildAnalysisMemoryContext() logic without DB dependency.
 */
function buildAnalysisMemoryContextFromMemories(memories: Memory[], senderEmail: string): string {
  if (memories.length === 0) return "";
  const sections = buildScopedSections(memories, ANALYSIS_CAP, senderEmail);
  return `\n=== USER'S PRIORITY PREFERENCES ===\nThe user has saved these preferences about how to classify emails. Apply them when relevant:\n${sections.join("\n\n")}\n`;
}

// ============================================================
// Test helpers
// ============================================================

const makeMemory = (overrides: Partial<Memory> = {}): Memory => ({
  id: "mem-1",
  accountId: "account-1",
  scope: "global",
  scopeValue: null,
  content: "Be concise in replies",
  source: "manual",
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...overrides,
});

// ============================================================
// Tests: buildScopedSections
// ============================================================

test.describe("buildScopedSections", () => {
  test("separates memories into scope sections", () => {
    const memories = [
      makeMemory({
        id: "1",
        scope: "person",
        scopeValue: "bob@example.com",
        content: "Person memory",
      }),
      makeMemory({ id: "2", scope: "domain", scopeValue: "example.com", content: "Domain memory" }),
      makeMemory({
        id: "3",
        scope: "category",
        scopeValue: "newsletters",
        content: "Category memory",
      }),
      makeMemory({ id: "4", scope: "global", content: "Global memory" }),
    ];

    const sections = buildScopedSections(memories, DRAFTING_CAP, "bob@example.com");
    expect(sections).toHaveLength(4);
    expect(sections[0]).toContain("For bob@example.com specifically:");
    expect(sections[1]).toContain("For anyone at example.com:");
    expect(sections[2]).toContain("For certain types of emails");
    expect(sections[3]).toContain("General preferences:");
  });

  test("caps each scope independently", () => {
    const memories = Array.from({ length: 1002 }, (_, i) =>
      makeMemory({ id: `g-${i}`, scope: "global", content: `Global rule ${i}` }),
    );

    const sections = buildScopedSections(memories, 1000);
    // Should have exactly one section (global) with 1000 items
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("Global rule 0");
    expect(sections[0]).toContain("Global rule 999");
    expect(sections[0]).not.toContain("Global rule 1000");
  });

  test("returns empty array for no memories", () => {
    const sections = buildScopedSections([], DRAFTING_CAP);
    expect(sections).toHaveLength(0);
  });

  test("returns empty array when no scope has entries", () => {
    const sections = buildScopedSections([], 50, "bob@example.com");
    expect(sections).toEqual([]);
  });

  test("uses senderEmail as fallback when person scopeValue is null", () => {
    const memories = [makeMemory({ scope: "person", scopeValue: null, content: "Important" })];

    const sections = buildScopedSections(memories, DRAFTING_CAP, "alice@example.com");
    expect(sections[0]).toContain("For alice@example.com specifically:");
  });

  test("uses 'this person' as final fallback when no senderEmail provided", () => {
    const memories = [makeMemory({ scope: "person", scopeValue: null, content: "Important" })];

    const sections = buildScopedSections(memories, DRAFTING_CAP);
    expect(sections[0]).toContain("For this person specifically:");
  });

  test("caps at 50 per scope for analysis", () => {
    const memories = Array.from({ length: 60 }, (_, i) =>
      makeMemory({ id: `g-${i}`, scope: "global", content: `Rule ${i}` }),
    );

    const sections = buildScopedSections(memories, ANALYSIS_CAP);
    expect(sections).toHaveLength(1);
    expect(sections[0]).toContain("Rule 49");
    expect(sections[0]).not.toContain("Rule 50");
  });

  test("caps each scope separately with mixed scopes", () => {
    const personMemories = Array.from({ length: 60 }, (_, i) =>
      makeMemory({
        id: `p-${i}`,
        scope: "person",
        scopeValue: "bob@example.com",
        content: `Person ${i}`,
      }),
    );
    const globalMemories = Array.from({ length: 60 }, (_, i) =>
      makeMemory({ id: `g-${i}`, scope: "global", content: `Global ${i}` }),
    );

    const sections = buildScopedSections(
      [...personMemories, ...globalMemories],
      50,
      "bob@example.com",
    );
    expect(sections).toHaveLength(2);
    // Person section should have 50 entries
    expect(sections[0]).toContain("Person 49");
    expect(sections[0]).not.toContain("Person 50");
    // Global section should have 50 entries
    expect(sections[1]).toContain("Global 49");
    expect(sections[1]).not.toContain("Global 50");
  });
});

// ============================================================
// Tests: formatMemories
// ============================================================

test.describe("formatMemories", () => {
  test("formats memories as bullet list", () => {
    const memories = [
      makeMemory({ content: "Be concise" }),
      makeMemory({ content: "Use formal tone" }),
    ];

    expect(formatMemories(memories)).toBe("- Be concise\n- Use formal tone");
  });

  test("returns empty string for empty array", () => {
    expect(formatMemories([])).toBe("");
  });
});

test.describe("formatCategoryMemories", () => {
  test("includes scopeValue as prefix when present", () => {
    const memories = [
      makeMemory({ scope: "category", scopeValue: "newsletters", content: "Skip these" }),
    ];

    expect(formatCategoryMemories(memories)).toBe("- [newsletters] Skip these");
  });

  test("omits prefix when scopeValue is null", () => {
    const memories = [
      makeMemory({ scope: "category", scopeValue: null, content: "General category rule" }),
    ];

    expect(formatCategoryMemories(memories)).toBe("- General category rule");
  });
});

// ============================================================
// Tests: buildMemoryContext (pure logic, no DB)
// ============================================================

test.describe("buildMemoryContextFromMemories", () => {
  test("returns empty string for no memories", () => {
    expect(buildMemoryContextFromMemories([], "bob@example.com")).toBe("");
  });

  test("includes person section with scopeValue label", () => {
    const memories = [
      makeMemory({
        scope: "person",
        scopeValue: "bob@example.com",
        content: "Always CC his assistant",
      }),
    ];

    const result = buildMemoryContextFromMemories(memories, "bob@example.com");
    expect(result).toContain("=== YOUR PREFERENCES (MEMORIES) ===");
    expect(result).toContain("For bob@example.com specifically:");
    expect(result).toContain("- Always CC his assistant");
  });

  test("falls back to senderEmail when scopeValue is null", () => {
    const memories = [
      makeMemory({ scope: "person", scopeValue: null, content: "Important contact" }),
    ];

    const result = buildMemoryContextFromMemories(memories, "alice@example.com");
    expect(result).toContain("For alice@example.com specifically:");
  });

  test("includes domain section", () => {
    const memories = [
      makeMemory({
        scope: "domain",
        scopeValue: "acme.com",
        content: "Formal tone for this company",
      }),
    ];

    const result = buildMemoryContextFromMemories(memories, "bob@acme.com");
    expect(result).toContain("For anyone at acme.com:");
    expect(result).toContain("- Formal tone for this company");
  });

  test("includes category section with scope labels", () => {
    const memories = [
      makeMemory({ scope: "category", scopeValue: "scheduling", content: "Defer to EA" }),
    ];

    const result = buildMemoryContextFromMemories(memories, "bob@example.com");
    expect(result).toContain("For certain types of emails (apply only if relevant):");
    expect(result).toContain("- [scheduling] Defer to EA");
  });

  test("includes global section", () => {
    const memories = [makeMemory({ scope: "global", content: "Keep replies under 3 sentences" })];

    const result = buildMemoryContextFromMemories(memories, "bob@example.com");
    expect(result).toContain("General preferences:");
    expect(result).toContain("- Keep replies under 3 sentences");
  });

  test("includes all sections in correct order", () => {
    const memories = [
      makeMemory({ id: "1", scope: "global", content: "Global rule" }),
      makeMemory({
        id: "2",
        scope: "person",
        scopeValue: "bob@example.com",
        content: "Person rule",
      }),
      makeMemory({ id: "3", scope: "domain", scopeValue: "example.com", content: "Domain rule" }),
      makeMemory({ id: "4", scope: "category", scopeValue: "billing", content: "Category rule" }),
    ];

    const result = buildMemoryContextFromMemories(memories, "bob@example.com");

    // Verify section ordering: person -> domain -> category -> global
    const personIdx = result.indexOf("For bob@example.com specifically:");
    const domainIdx = result.indexOf("For anyone at example.com:");
    const categoryIdx = result.indexOf("For certain types of emails");
    const globalIdx = result.indexOf("General preferences:");

    expect(personIdx).toBeLessThan(domainIdx);
    expect(domainIdx).toBeLessThan(categoryIdx);
    expect(categoryIdx).toBeLessThan(globalIdx);
  });
});

// ============================================================
// Tests: buildAgentMemoryContext (pure logic, no DB)
// ============================================================

test.describe("buildAgentMemoryContextFromMemories", () => {
  test("returns empty string for no memories", () => {
    expect(buildAgentMemoryContextFromMemories([])).toBe("");
  });

  test("uses agent-specific header", () => {
    const memories = [makeMemory({ scope: "global", content: "Be helpful" })];

    const result = buildAgentMemoryContextFromMemories(memories);
    expect(result).toContain("## User Preferences & Instructions");
    expect(result).toContain("persistent preferences the user has saved");
    expect(result).not.toContain("=== YOUR PREFERENCES");
  });

  test("includes person section when senderEmail is provided", () => {
    const memories = [
      makeMemory({ scope: "person", scopeValue: "bob@example.com", content: "VIP contact" }),
    ];

    const result = buildAgentMemoryContextFromMemories(memories, "bob@example.com");
    expect(result).toContain("For bob@example.com specifically:");
  });

  test("person section uses senderEmail parameter as fallback", () => {
    const memories = [makeMemory({ scope: "person", scopeValue: null, content: "Important" })];

    const result = buildAgentMemoryContextFromMemories(memories, "alice@example.com");
    expect(result).toContain("For alice@example.com specifically:");
  });

  test("works without senderEmail (category + global only)", () => {
    const memories = [
      makeMemory({ id: "1", scope: "global", content: "Global pref" }),
      makeMemory({ id: "2", scope: "category", scopeValue: "urgent", content: "Category pref" }),
    ];

    const result = buildAgentMemoryContextFromMemories(memories);
    expect(result).toContain("General preferences:");
    expect(result).toContain("For certain types of emails");
    expect(result).not.toContain("specifically:");
  });
});

// ============================================================
// Tests: buildAnalysisMemoryContext (pure logic, no DB)
// ============================================================

test.describe("buildAnalysisMemoryContextFromMemories", () => {
  test("returns empty string for no memories", () => {
    expect(buildAnalysisMemoryContextFromMemories([], "bob@example.com")).toBe("");
  });

  test("uses analysis-specific header", () => {
    const memories = [makeMemory({ scope: "global", content: "Important emails first" })];

    const result = buildAnalysisMemoryContextFromMemories(memories, "bob@example.com");
    expect(result).toContain("=== USER'S PRIORITY PREFERENCES ===");
    expect(result).toContain("how to classify emails");
    expect(result).not.toContain("## User Preferences");
  });

  test("uses ANALYSIS_CAP (50) instead of DRAFTING_CAP", () => {
    const memories = Array.from({ length: 60 }, (_, i) =>
      makeMemory({ id: `g-${i}`, scope: "global", content: `Analysis rule ${i}` }),
    );

    const result = buildAnalysisMemoryContextFromMemories(memories, "bob@example.com");
    expect(result).toContain("Analysis rule 49");
    expect(result).not.toContain("Analysis rule 50");
  });
});
