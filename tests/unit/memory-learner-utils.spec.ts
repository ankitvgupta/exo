/**
 * Unit tests for memory-learner-utils.ts — shared utilities for memory learners.
 */
import { test, expect } from "@playwright/test";
import {
  parseJsonArray,
  normalizeScope,
  CONSUMER_DOMAINS,
  VALID_MEMORY_SCOPES,
} from "../../src/main/services/memory-learner-utils";

// ============================================================
// parseJsonArray
// ============================================================

test.describe("parseJsonArray", () => {
  test("parses a valid JSON array", () => {
    const result = parseJsonArray<{ name: string }>('[{"name": "alice"}, {"name": "bob"}]');
    expect(result).toEqual([{ name: "alice" }, { name: "bob" }]);
  });

  test("extracts array from surrounding text", () => {
    const result = parseJsonArray<number>("Here is the result: [1, 2, 3] hope that helps!");
    expect(result).toEqual([1, 2, 3]);
  });

  test("returns null for invalid JSON", () => {
    const result = parseJsonArray("[not valid json}");
    expect(result).toBeNull();
  });

  test("returns null when no brackets present", () => {
    const result = parseJsonArray("no array here");
    expect(result).toBeNull();
  });

  test("returns empty array for empty array input", () => {
    const result = parseJsonArray("[]");
    expect(result).toEqual([]);
  });

  test("handles nested objects within array", () => {
    const result = parseJsonArray<{ scope: string; nested: { value: number } }>(
      '[{"scope": "global", "nested": {"value": 42}}]',
    );
    expect(result).toEqual([{ scope: "global", nested: { value: 42 } }]);
  });

  test("returns null when text contains only opening bracket", () => {
    const result = parseJsonArray("here is [ but no closing");
    expect(result).toBeNull();
  });

  test("returns null for a JSON object (not array)", () => {
    // Only has {}, no [], so indexOf("[") returns -1
    const result = parseJsonArray('{"key": "value"}');
    expect(result).toBeNull();
  });
});

// ============================================================
// normalizeScope
// ============================================================

test.describe("normalizeScope", () => {
  test("person scope uses senderEmail as fallback", () => {
    const result = normalizeScope("person", null, "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "person", scopeValue: "alice@example.com" });
  });

  test("person scope preserves explicit scopeValue", () => {
    const result = normalizeScope("person", "bob@other.com", "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "person", scopeValue: "bob@other.com" });
  });

  test("domain scope uses senderDomain as fallback", () => {
    const result = normalizeScope("domain", null, "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "domain", scopeValue: "example.com" });
  });

  test("domain scope preserves explicit scopeValue", () => {
    const result = normalizeScope("domain", "other.com", "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "domain", scopeValue: "other.com" });
  });

  test("category scope uses null as fallback", () => {
    const result = normalizeScope("category", null, "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "category", scopeValue: null });
  });

  test("category scope preserves explicit scopeValue", () => {
    const result = normalizeScope(
      "category",
      "recruiter-outreach",
      "alice@example.com",
      "example.com",
    );
    expect(result).toEqual({ scope: "category", scopeValue: "recruiter-outreach" });
  });

  test("global scope always gets null scopeValue", () => {
    const result = normalizeScope("global", null, "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "global", scopeValue: null });
  });

  test("global scope ignores provided scopeValue", () => {
    const result = normalizeScope(
      "global",
      "should-be-ignored",
      "alice@example.com",
      "example.com",
    );
    expect(result).toEqual({ scope: "global", scopeValue: null });
  });

  test("invalid scope defaults to person", () => {
    const result = normalizeScope("invalid-scope", null, "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "person", scopeValue: "alice@example.com" });
  });

  test("empty string scope defaults to person", () => {
    const result = normalizeScope("", null, "alice@example.com", "example.com");
    expect(result).toEqual({ scope: "person", scopeValue: "alice@example.com" });
  });
});

// ============================================================
// CONSUMER_DOMAINS
// ============================================================

test.describe("CONSUMER_DOMAINS", () => {
  test("includes gmail.com", () => {
    expect(CONSUMER_DOMAINS.has("gmail.com")).toBe(true);
  });

  test("includes yahoo.com", () => {
    expect(CONSUMER_DOMAINS.has("yahoo.com")).toBe(true);
  });

  test("includes hotmail.com", () => {
    expect(CONSUMER_DOMAINS.has("hotmail.com")).toBe(true);
  });

  test("does not include corporate domains", () => {
    expect(CONSUMER_DOMAINS.has("stripe.com")).toBe(false);
  });
});

// ============================================================
// VALID_MEMORY_SCOPES
// ============================================================

test.describe("VALID_MEMORY_SCOPES", () => {
  test("contains all four scope types", () => {
    expect(VALID_MEMORY_SCOPES).toEqual(["person", "domain", "category", "global"]);
  });
});
