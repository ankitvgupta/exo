import { test, expect } from "@playwright/test";
import { parseSuperhumanQuery } from "../../src/main/services/superhuman-import";

test.describe("parseSuperhumanQuery", () => {
  test("parses single from: clause", () => {
    const result = parseSuperhumanQuery("from:apply@ycombinator.com");
    expect(result.conditions).toEqual([
      { type: "from", value: "apply@ycombinator.com" },
    ]);
    expect(result.conditionLogic).toBe("and");
    expect(result.skippedClauses).toEqual([]);
  });

  test("parses two from: clauses joined by OR", () => {
    const result = parseSuperhumanQuery(
      "from:randomemail@ycombinator.com OR from:calendar@ycombinator.com"
    );
    expect(result.conditions).toEqual([
      { type: "from", value: "randomemail@ycombinator.com" },
      { type: "from", value: "calendar@ycombinator.com" },
    ]);
    expect(result.conditionLogic).toBe("or");
    expect(result.skippedClauses).toEqual([]);
  });

  test("parses mixed from: and filename: with OR", () => {
    const result = parseSuperhumanQuery(
      "from:notifications@calendly.com OR from:calendar-notification@google.com OR from:calendar@superhuman.com OR filename:ics"
    );
    expect(result.conditions).toEqual([
      { type: "from", value: "notifications@calendly.com" },
      { type: "from", value: "calendar-notification@google.com" },
      { type: "from", value: "calendar@superhuman.com" },
      { type: "has_attachment", value: "*.ics" },
    ]);
    expect(result.conditionLogic).toBe("or");
    expect(result.skippedClauses).toEqual([]);
  });

  test("parses subject: with quotes", () => {
    const result = parseSuperhumanQuery('subject:"YC Updates"');
    expect(result.conditions).toEqual([
      { type: "subject", value: "*YC Updates*" },
    ]);
    expect(result.conditionLogic).toBe("and");
  });

  test("parses from: with domain-only (no @)", () => {
    const result = parseSuperhumanQuery(
      "from:docs.google.com OR from:drive-shares-noreply@google.com OR from:drive-shares-dm-noreply@google.com"
    );
    expect(result.conditions).toEqual([
      { type: "from", value: "*@docs.google.com" },
      { type: "from", value: "drive-shares-noreply@google.com" },
      { type: "from", value: "drive-shares-dm-noreply@google.com" },
    ]);
    expect(result.conditionLogic).toBe("or");
  });

  test("silently skips autolabel: with parentheses", () => {
    const result = parseSuperhumanQuery("(autolabel:autoLabel_xxx)");
    expect(result.conditions).toEqual([]);
    expect(result.skippedClauses).toEqual([]);
  });

  test("silently skips is:shared", () => {
    const result = parseSuperhumanQuery("is:shared");
    expect(result.conditions).toEqual([]);
    expect(result.skippedClauses).toEqual([]);
  });

  test("returns empty for empty query", () => {
    const result = parseSuperhumanQuery("");
    expect(result.conditions).toEqual([]);
    expect(result.conditionLogic).toBe("and");
    expect(result.skippedClauses).toEqual([]);
  });

  test("parses from:{} brace-grouped addresses", () => {
    const result = parseSuperhumanQuery("from:{alice@example.com, bob@test.com}");
    expect(result.conditions).toEqual([
      { type: "from", value: "alice@example.com" },
      { type: "from", value: "bob@test.com" },
    ]);
    expect(result.conditionLogic).toBe("or");
  });

  test("parses to: clause", () => {
    const result = parseSuperhumanQuery("to:team@company.com");
    expect(result.conditions).toEqual([
      { type: "to", value: "team@company.com" },
    ]);
  });

  test("handles mixed parseable and silently-skipped clauses", () => {
    const result = parseSuperhumanQuery(
      "from:user@test.com OR (autolabel:autoLabel_123)"
    );
    expect(result.conditions).toEqual([
      { type: "from", value: "user@test.com" },
    ]);
    expect(result.conditionLogic).toBe("or");
    expect(result.skippedClauses).toEqual([]);
  });
});
