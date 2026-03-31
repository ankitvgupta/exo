/**
 * Unit tests for forward draft functionality:
 *
 * 1. Gmail draft sync — forward vs reply mode (subject prefix, recipients, threading headers)
 * 2. Address parsing — extractBareEmail and buildNameMapFromAddresses helpers
 * 3. Draft save/restore — RestoredDraft carries arrays, formatted addresses preserve names
 * 4. onDraftSaved propagation — composeMode and to fields flow through agent → renderer
 *
 * Cannot import modules that depend on electron/DB, so we re-implement
 * the pure logic under test (same pattern as gmail-draft-sync.spec.ts).
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "../../src");

// =============================================================================
// Re-implemented logic from gmail-draft-sync.ts: syncDraftToGmail
// =============================================================================

interface MockEmail {
  from: string;
  subject: string;
  threadId: string;
}

interface DraftSyncResult {
  to: string;
  subject: string;
  inReplyTo: string | undefined;
  references: string | undefined;
  threadId: string;
}

/**
 * Mirrors the recipient/subject/threading-header logic in syncDraftToGmail.
 */
function buildDraftSyncParams(
  email: MockEmail,
  composeMode: string | undefined,
  forwardTo: string[] | undefined,
  parentMessageId: string | undefined,
): DraftSyncResult {
  const isForward = composeMode === "forward";

  let to: string;
  let subject: string;
  if (isForward) {
    to = forwardTo?.join(", ") || "";
    const bare = email.subject.replace(/^(?:Re|Fwd|Fw):\s*/i, "");
    subject = `Fwd: ${bare}`;
  } else {
    const fromMatch = email.from.match(/<([^>]+)>/);
    to = fromMatch ? fromMatch[1] : email.from;
    subject = email.subject.startsWith("Re:") ? email.subject : `Re: ${email.subject}`;
  }

  const inReplyTo = !isForward ? parentMessageId : undefined;
  const references = !isForward ? parentMessageId : undefined;

  return { to, subject, inReplyTo, references, threadId: email.threadId };
}

// =============================================================================
// Re-implemented logic from useComposeForm.ts: address parsing helpers
// =============================================================================

/** Extract bare email from a potentially formatted "Name <email>" address. */
function extractBareEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>$/);
  return match ? match[1] : addr;
}

/** Build a name map from an array of potentially formatted addresses. */
function buildNameMapFromAddresses(addresses: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const addr of addresses) {
    const match = addr.match(/^(.+?)\s*<([^>]+)>$/);
    if (match) {
      map.set(match[2].toLowerCase(), match[1].trim());
    }
  }
  return map;
}

// =============================================================================
// Tests
// =============================================================================

test.describe("Gmail draft sync: forward mode", () => {
  const email: MockEmail = {
    from: "Alice <alice@example.com>",
    subject: "Project Update",
    threadId: "t1",
  };

  test("uses Fwd: prefix and forward recipients for forwards", () => {
    const result = buildDraftSyncParams(email, "forward", ["bob@example.com"], "<msg-id@mail>");
    expect(result.subject).toBe("Fwd: Project Update");
    expect(result.to).toBe("bob@example.com");
  });

  test("skips threading headers for forwards", () => {
    const result = buildDraftSyncParams(email, "forward", ["bob@example.com"], "<msg-id@mail>");
    expect(result.inReplyTo).toBeUndefined();
    expect(result.references).toBeUndefined();
  });

  test("uses Re: prefix and original sender for replies", () => {
    const result = buildDraftSyncParams(email, "reply", undefined, "<msg-id@mail>");
    expect(result.subject).toBe("Re: Project Update");
    expect(result.to).toBe("alice@example.com");
  });

  test("sets threading headers for replies", () => {
    const result = buildDraftSyncParams(email, "reply", undefined, "<msg-id@mail>");
    expect(result.inReplyTo).toBe("<msg-id@mail>");
    expect(result.references).toBe("<msg-id@mail>");
  });

  test("defaults to reply mode when composeMode is undefined", () => {
    const result = buildDraftSyncParams(email, undefined, undefined, "<msg-id@mail>");
    expect(result.subject).toBe("Re: Project Update");
    expect(result.to).toBe("alice@example.com");
    expect(result.inReplyTo).toBe("<msg-id@mail>");
  });

  test("strips existing Fwd: before re-adding for forwards", () => {
    const fwdEmail = { ...email, subject: "Fwd: Project Update" };
    const result = buildDraftSyncParams(fwdEmail, "forward", ["bob@example.com"], undefined);
    expect(result.subject).toBe("Fwd: Project Update");
  });

  test("strips existing Re: before adding Fwd: for forwards", () => {
    const reEmail = { ...email, subject: "Re: Project Update" };
    const result = buildDraftSyncParams(reEmail, "forward", ["bob@example.com"], undefined);
    expect(result.subject).toBe("Fwd: Project Update");
  });

  test("handles multiple forward recipients", () => {
    const result = buildDraftSyncParams(
      email,
      "forward",
      ["bob@example.com", "carol@example.com"],
      undefined,
    );
    expect(result.to).toBe("bob@example.com, carol@example.com");
  });

  test("produces empty to when forwardTo is undefined", () => {
    const result = buildDraftSyncParams(email, "forward", undefined, undefined);
    expect(result.to).toBe("");
  });

  test("preserves threadId for both modes", () => {
    const fwd = buildDraftSyncParams(email, "forward", ["bob@example.com"], undefined);
    const reply = buildDraftSyncParams(email, "reply", undefined, "<msg-id@mail>");
    expect(fwd.threadId).toBe("t1");
    expect(reply.threadId).toBe("t1");
  });
});

test.describe("Address parsing: extractBareEmail", () => {
  test("extracts email from formatted address", () => {
    expect(extractBareEmail("John Doe <john@example.com>")).toBe("john@example.com");
  });

  test("returns bare email unchanged", () => {
    expect(extractBareEmail("john@example.com")).toBe("john@example.com");
  });

  test("handles quoted display name", () => {
    expect(extractBareEmail('"Doe, John" <john@example.com>')).toBe("john@example.com");
  });

  test("handles name with special characters", () => {
    expect(extractBareEmail("O'Brien <ob@example.com>")).toBe("ob@example.com");
  });

  test("handles empty string", () => {
    expect(extractBareEmail("")).toBe("");
  });
});

test.describe("Address parsing: buildNameMapFromAddresses", () => {
  test("builds map from formatted addresses", () => {
    const map = buildNameMapFromAddresses([
      "Alice <alice@example.com>",
      "Bob Smith <bob@example.com>",
    ]);
    expect(map.size).toBe(2);
    expect(map.get("alice@example.com")).toBe("Alice");
    expect(map.get("bob@example.com")).toBe("Bob Smith");
  });

  test("ignores bare emails (no display name to extract)", () => {
    const map = buildNameMapFromAddresses(["plain@example.com"]);
    expect(map.size).toBe(0);
  });

  test("stores keys as lowercase", () => {
    const map = buildNameMapFromAddresses(["Alice <Alice@Example.COM>"]);
    expect(map.get("alice@example.com")).toBe("Alice");
    expect(map.has("Alice@Example.COM")).toBe(false);
  });

  test("handles mixed formatted and bare addresses", () => {
    const map = buildNameMapFromAddresses([
      "Alice <alice@example.com>",
      "plain@example.com",
      "Bob <bob@example.com>",
    ]);
    expect(map.size).toBe(2);
    expect(map.has("plain@example.com")).toBe(false);
  });

  test("returns empty map for empty input", () => {
    expect(buildNameMapFromAddresses([]).size).toBe(0);
  });

  test("trims whitespace from display name", () => {
    const map = buildNameMapFromAddresses(["  Alice  <alice@example.com>"]);
    expect(map.get("alice@example.com")).toBe("Alice");
  });
});

test.describe("Draft save/restore: RestoredDraft type", () => {
  test("RestoredDraft.to/cc/bcc are typed as string arrays", () => {
    const storeCode = readFileSync(path.join(srcDir, "renderer/store/index.ts"), "utf-8");
    // Verify array types (string[]) not plain string
    expect(storeCode).toMatch(/to\?\s*:\s*string\[\]/);
    expect(storeCode).toMatch(/cc\?\s*:\s*string\[\]/);
    expect(storeCode).toMatch(/bcc\?\s*:\s*string\[\]/);
  });

  test("InlineComposeForm initialTo uses restoredDraft.to directly (no split)", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailDetail.tsx"), "utf-8");
    // Should pass array directly, not split a string
    expect(code).toContain("restoredDraft?.to !== undefined ? restoredDraft.to :");
    // Should NOT have .split(",") on restoredDraft.to
    expect(code).not.toMatch(/restoredDraft\.to\.split/);
  });

  test("Draft restoration builds to as array, not joined string", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailDetail.tsx"), "utf-8");
    // The draft restoration should use draft.to directly (already an array from DB)
    expect(code).toContain("to: threadDraftEmail.draft.to,");
    // Should NOT join the array
    expect(code).not.toMatch(/threadDraftEmail\.draft\.to\.join/);
  });

  test("EmailList draft click passes to as array, not joined string", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailList.tsx"), "utf-8");
    expect(code).toContain("to: draft.to,");
    expect(code).not.toMatch(/draft\.to\.join/);
  });
});

test.describe("Address name persistence across save/restore", () => {
  // Simulate the full round-trip: compose → save → restore → compose

  test("formatted addresses survive round-trip through extractBareEmail + nameMap", () => {
    // Step 1: onToChange emits formatted addresses
    const emitted = ["Alice <alice@example.com>", "bob@plain.com"];

    // Step 2: These get stored in to_recipients (the emitted values)
    const stored = emitted;

    // Step 3: On restore, useComposeForm receives them as initialTo
    // It extracts bare emails for form.to
    const bareEmails = stored.map(extractBareEmail);
    expect(bareEmails).toEqual(["alice@example.com", "bob@plain.com"]);

    // And builds nameMap from the formatted addresses
    const nameMap = buildNameMapFromAddresses(stored);
    expect(nameMap.get("alice@example.com")).toBe("Alice");
    // bob@plain.com had no name, so not in map
    expect(nameMap.has("bob@plain.com")).toBe(false);
  });

  test("multiple formatted recipients all restore correctly", () => {
    const emitted = [
      "Alice <alice@example.com>",
      "Bob Smith <bob@example.com>",
      "Carol <carol@example.com>",
    ];
    const bareEmails = emitted.map(extractBareEmail);
    const nameMap = buildNameMapFromAddresses(emitted);

    expect(bareEmails).toEqual(["alice@example.com", "bob@example.com", "carol@example.com"]);
    expect(nameMap.size).toBe(3);
    expect(nameMap.get("alice@example.com")).toBe("Alice");
    expect(nameMap.get("bob@example.com")).toBe("Bob Smith");
    expect(nameMap.get("carol@example.com")).toBe("Carol");
  });
});

test.describe("onDraftSaved propagation: composeMode and to", () => {
  test("onDraftSaved handler accepts composeMode and to fields", () => {
    const code = readFileSync(path.join(srcDir, "renderer/App.tsx"), "utf-8");
    // The onDraftSaved handler should accept composeMode and to in the draft data
    expect(code).toContain("composeMode?: string");
    expect(code).toContain("to?: string[]");
  });

  test("onToChange emits formatted addresses using mergedNameMap", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/EmailDetail.tsx"), "utf-8");
    // The onToChange effect should format addresses with names from mergedNameMap
    expect(code).toContain("mergedNameMap.get(email.toLowerCase())");
    expect(code).toContain("onToChange?.(formatted)");
  });

  test("useComposeForm initializes nameMap from formatted initialTo addresses", () => {
    const code = readFileSync(path.join(srcDir, "renderer/hooks/useComposeForm.ts"), "utf-8");
    // Should call buildNameMapFromAddresses with all initial address fields
    expect(code).toContain(
      "buildNameMapFromAddresses([...initialTo, ...initialCc, ...initialBcc])",
    );
    // Should extract bare emails for form state
    expect(code).toContain("initialTo.map(extractBareEmail)");
  });

  test("saveDraftAndSync passes composeMode and to to syncDraftToGmail", () => {
    const code = readFileSync(path.join(srcDir, "main/services/gmail-draft-sync.ts"), "utf-8");
    // saveDraftAndSync should accept composeMode and to params
    expect(code).toMatch(/function saveDraftAndSync\([^)]*composeMode/);
    expect(code).toMatch(/function saveDraftAndSync\([^)]*to\?\s*:\s*string\[\]/);
    // And pass them to syncDraftToGmail (re-read from DB to survive refine calls)
    expect(code).toContain(
      "syncDraftToGmail(emailId, body, syncCc, syncBcc, oldGmailDraftId, syncComposeMode, syncTo)",
    );
  });
});
