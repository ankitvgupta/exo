/**
 * Unit tests for address-parsing.ts — RFC 2822-aware address list
 * splitting and first-name extraction.
 */
import { test, expect } from "@playwright/test";
import {
  splitAddressList,
  extractFirstName,
} from "../../src/renderer/utils/address-parsing";

// ============================================================
// splitAddressList
// ============================================================

test.describe("splitAddressList", () => {
  test("simple comma-separated addresses", () => {
    expect(splitAddressList("a@b.com, c@d.com")).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });

  test("Name <email> format", () => {
    const input = "John Doe <john@example.com>, Jane <jane@example.com>";
    expect(splitAddressList(input)).toEqual([
      "John Doe <john@example.com>",
      "Jane <jane@example.com>",
    ]);
  });

  test("quoted names with commas", () => {
    const input = '"Smith, John" <john@example.com>, jane@example.com';
    expect(splitAddressList(input)).toEqual([
      '"Smith, John" <john@example.com>',
      "jane@example.com",
    ]);
  });

  test("angle bracket addresses", () => {
    expect(splitAddressList("<alice@example.com>")).toEqual([
      "<alice@example.com>",
    ]);
  });

  test("single address", () => {
    expect(splitAddressList("solo@example.com")).toEqual(["solo@example.com"]);
  });

  test("empty string returns empty array", () => {
    expect(splitAddressList("")).toEqual([]);
  });

  test("whitespace handling", () => {
    expect(splitAddressList("  a@b.com ,  c@d.com  ")).toEqual([
      "a@b.com",
      "c@d.com",
    ]);
  });

  test("multiple addresses with mixed formats", () => {
    const input =
      'Alice <alice@a.com>, "Doe, Bob" <bob@b.com>, plain@c.com';
    expect(splitAddressList(input)).toEqual([
      "Alice <alice@a.com>",
      '"Doe, Bob" <bob@b.com>',
      "plain@c.com",
    ]);
  });

  test("RFC 2822 comments in parentheses", () => {
    const input = "alice@example.com (Alice), bob@example.com";
    expect(splitAddressList(input)).toEqual([
      "alice@example.com (Alice)",
      "bob@example.com",
    ]);
  });
});

// ============================================================
// extractFirstName
// ============================================================

test.describe("extractFirstName", () => {
  test('"John Doe" → "John"', () => {
    expect(extractFirstName("John Doe")).toBe("John");
  });

  test('"Doe, John" → "John" (LastName, FirstName format)', () => {
    expect(extractFirstName("Doe, John")).toBe("John");
  });

  test('"Alice" → "Alice"', () => {
    expect(extractFirstName("Alice")).toBe("Alice");
  });

  test('empty string → ""', () => {
    expect(extractFirstName("")).toBe("");
  });

  test('"Dr. John Smith" → "Dr."', () => {
    expect(extractFirstName("Dr. John Smith")).toBe("Dr.");
  });

  test("email address returns as-is", () => {
    expect(extractFirstName("alice@example.com")).toBe("alice@example.com");
  });

  test('"Doe, John Michael" → "John" (takes first word after comma)', () => {
    expect(extractFirstName("Doe, John Michael")).toBe("John");
  });
});
