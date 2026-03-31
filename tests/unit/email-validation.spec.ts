/**
 * Unit tests for email composition validation logic
 *
 * The validation rule across all compose surfaces (ComposeView, InlineReply, NewEmailCompose):
 *   - At least one recipient required (any of To, Cc, Bcc)
 *   - Either subject OR body required (not both)
 *
 * These tests verify the source code implements this consistently.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "../../src");

// ============================================================
// Pure validation logic tests
// ============================================================

test.describe("Email validation — subject OR body is sufficient", () => {
  test("to + subject + no body → valid", () => {
    const to = ["user@example.com"];
    const subject = "Hello";
    const bodyText = "";
    const hasRecipient = to.length > 0;
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasRecipient && hasContent).toBe(true);
  });

  test("to + no subject + body → valid", () => {
    const to = ["user@example.com"];
    const subject = "";
    const bodyText = "Some body text";
    const hasRecipient = to.length > 0;
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasRecipient && hasContent).toBe(true);
  });

  test("to + subject + body → valid", () => {
    const to = ["user@example.com"];
    const subject = "Hello";
    const bodyText = "Some body text";
    const hasRecipient = to.length > 0;
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasRecipient && hasContent).toBe(true);
  });

  test("to + no subject + no body → invalid", () => {
    const to = ["user@example.com"];
    const subject = "";
    const bodyText = "";
    const hasRecipient = to.length > 0;
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasRecipient && hasContent).toBe(false);
  });

  test("no recipients + subject + body → invalid", () => {
    const to: string[] = [];
    const cc: string[] = [];
    const bcc: string[] = [];
    const subject = "Hello";
    const bodyText = "Body";
    const hasRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasRecipient && hasContent).toBe(false);
  });

  test("bcc-only + subject → valid", () => {
    const to: string[] = [];
    const cc: string[] = [];
    const bcc = ["secret@example.com"];
    const subject = "Hello";
    const bodyText = "";
    const hasRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasRecipient && hasContent).toBe(true);
  });

  test("cc-only + body → valid", () => {
    const to: string[] = [];
    const cc = ["cc@example.com"];
    const bcc: string[] = [];
    const subject = "";
    const bodyText = "Just a body";
    const hasRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasRecipient && hasContent).toBe(true);
  });

  test("whitespace-only subject and body → invalid", () => {
    const subject = "   ";
    const bodyText = "  \n  ";
    const hasContent = !!subject.trim() || !!bodyText.trim();
    expect(hasContent).toBe(false);
  });
});

// ============================================================
// useComposeForm hook — shared validation logic
// ============================================================

test.describe("useComposeForm — validation allows subject-only send", () => {
  let hookCode: string;

  test.beforeAll(() => {
    hookCode = readFileSync(path.join(srcDir, "renderer/hooks/useComposeForm.ts"), "utf-8");
  });

  test("send guard requires subject OR body, not both", () => {
    // The condition blocks only when BOTH body and subject are empty
    expect(hookCode).toContain("!bodyText.trim() && !subject.trim()");
  });

  test("send checks recipients across To/Cc/Bcc", () => {
    expect(hookCode).toContain(
      "const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0",
    );
  });

  test("canSend derived value combines recipient and content checks", () => {
    expect(hookCode).toContain("const hasContent = !!bodyText.trim() || !!subject.trim()");
    expect(hookCode).toContain("const canSend = hasAnyRecipient && hasContent");
  });
});

// ============================================================
// ComposeToolbar — send button disabled state
// ============================================================

test.describe("ComposeToolbar — send button uses canSend", () => {
  let toolbarCode: string;

  test.beforeAll(() => {
    toolbarCode = readFileSync(
      path.join(srcDir, "renderer/components/ComposeToolbar.tsx"),
      "utf-8",
    );
  });

  test("send button uses canSend for disabled state", () => {
    expect(toolbarCode).toContain("disabled={isSending || isScheduling || !canSend}");
  });

  test("schedule button uses canSend for disabled state", () => {
    expect(toolbarCode).toContain("disabled={isScheduling || isSending || !canSend}");
  });
});

// ============================================================
// No standalone !bodyText.trim() guard anywhere
// ============================================================

test.describe("No component blocks send on empty body alone", () => {
  test("ComposeToolbar.tsx has no standalone bodyText guard in disabled props", () => {
    const code = readFileSync(path.join(srcDir, "renderer/components/ComposeToolbar.tsx"), "utf-8");
    const disabledMatches = code.match(/disabled=\{[^}]+\}/g) || [];
    for (const match of disabledMatches) {
      if (match.includes("!bodyText.trim()")) {
        expect(match.includes("!subject.trim()") || match.includes("!canSend")).toBe(true);
      }
    }
  });
});
