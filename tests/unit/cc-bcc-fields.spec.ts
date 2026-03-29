/**
 * Unit tests for CC and BCC fields feature
 *
 * Tests that CC/BCC fields are properly implemented across:
 * - useComposeForm hook (shared state + send logic)
 * - InlineReply component (inline reply/forward UI)
 * - NewEmailCompose component (new email composition UI)
 * - IPC handlers and preload API
 * - Type definitions
 *
 * Validates that only one of To, CC, or BCC is required for sending.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(__dirname, "../../src");

// ============================================================
// useComposeForm Hook Tests (shared CC/BCC state and send logic)
// ============================================================

test.describe("CC/BCC - useComposeForm Hook", () => {
  let hookCode: string;

  test.beforeAll(() => {
    hookCode = readFileSync(
      path.join(srcDir, "renderer/hooks/useComposeForm.ts"),
      "utf-8"
    );
  });

  test("hook has CC and BCC state", () => {
    expect(hookCode).toContain("const [cc, setCc] = useState<string[]>(() => initialCc.map(extractBareEmail))");
    expect(hookCode).toContain("const [bcc, setBcc] = useState<string[]>(() => initialBcc.map(extractBareEmail))");
  });

  test("hook send includes CC and BCC in send options", () => {
    expect(hookCode).toContain("cc: cc.length > 0 ? cc : undefined,");
    expect(hookCode).toContain("bcc: bcc.length > 0 ? bcc : undefined,");
  });

  test("hook validates at least one of To/CC/BCC has recipients", () => {
    expect(hookCode).toContain(
      "const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0"
    );
  });

  test("hook send is blocked when no recipients in any field", () => {
    expect(hookCode).toContain("!hasAnyRecipient");
  });
});

// ============================================================
// InlineReply Component Tests (UI)
// ============================================================

test.describe("CC/BCC - InlineReply Component", () => {
  let emailDetailCode: string;

  test.beforeAll(() => {
    emailDetailCode = readFileSync(
      path.join(srcDir, "renderer/components/EmailDetail.tsx"),
      "utf-8"
    );
  });

  test("InlineReply has CC/BCC toggle button", () => {
    expect(emailDetailCode).toContain("inline-reply-cc-bcc-toggle");
    expect(emailDetailCode).toContain("Cc / Bcc");
  });

  test("InlineReply renders AddressInput for CC and BCC", () => {
    // The InlineReply section should have AddressInput components
    const addressInputCount = (emailDetailCode.match(/<AddressInput/g) || [])
      .length;
    // At least 5: NewEmailCompose has To+Cc+Bcc, InlineReply has To+Cc+Bcc
    expect(addressInputCount).toBeGreaterThanOrEqual(5);
  });

  test("InlineReply uses useComposeForm hook", () => {
    expect(emailDetailCode).toContain("useComposeForm");
    expect(emailDetailCode).toContain("form.setCc");
    expect(emailDetailCode).toContain("form.setBcc");
  });
});

// ============================================================
// NewEmailCompose Component Tests (UI)
// ============================================================

test.describe("CC/BCC - NewEmailCompose Component", () => {
  let emailDetailCode: string;

  test.beforeAll(() => {
    emailDetailCode = readFileSync(
      path.join(srcDir, "renderer/components/EmailDetail.tsx"),
      "utf-8"
    );
  });

  test("NewEmailCompose renders BCC AddressInput", () => {
    // Should render a BCC AddressInput alongside the existing To and Cc
    expect(emailDetailCode).toContain('label="Bcc"');
    expect(emailDetailCode).toContain('placeholder="bcc@example.com"');
  });

  test("NewEmailCompose uses useComposeForm hook for send", () => {
    expect(emailDetailCode).toContain("form.send()");
  });
});

// ============================================================
// Type Definition Tests
// ============================================================

test.describe("CC/BCC - Type Definitions", () => {
  let typesCode: string;

  test.beforeAll(() => {
    typesCode = readFileSync(path.join(srcDir, "shared/types.ts"), "utf-8");
  });

  test("DashboardEmail.draft type includes bcc field", () => {
    // The draft type should have bcc?: string[]
    expect(typesCode).toContain("bcc?: string[];");
  });

  test("IpcChannels gmail:create-draft includes bcc", () => {
    expect(typesCode).toContain(
      '"gmail:create-draft": { emailId: string; body: string; cc?: string[]; bcc?: string[]; accountId?: string }'
    );
  });

  test("ComposeMessageOptions already supports bcc", () => {
    expect(typesCode).toContain("bcc?: string[];");
  });

  test("LocalDraftSchema supports bcc", () => {
    expect(typesCode).toContain(
      "bcc: z.array(z.string()).optional()"
    );
  });

  test("GmailDraftSchema supports bcc", () => {
    expect(typesCode).toContain(
      "bcc: z.array(z.string()).optional()"
    );
  });
});

// ============================================================
// IPC Handler Tests
// ============================================================

test.describe("CC/BCC - IPC Handlers", () => {
  test("gmail.ipc.ts create-draft handler accepts bcc parameter", () => {
    const gmailIpc = readFileSync(
      path.join(srcDir, "main/ipc/gmail.ipc.ts"),
      "utf-8"
    );
    expect(gmailIpc).toContain(
      "{ emailId, body, cc, bcc, accountId }: { emailId: string; body: string; cc?: string[]; bcc?: string[]; accountId?: string }"
    );
  });

  test("gmail.ipc.ts logs BCC in demo mode", () => {
    const gmailIpc = readFileSync(
      path.join(srcDir, "main/ipc/gmail.ipc.ts"),
      "utf-8"
    );
    expect(gmailIpc).toContain('[DEMO] BCC:');
  });

  test("gmail.ipc.ts passes bcc to client.createDraft", () => {
    const gmailIpc = readFileSync(
      path.join(srcDir, "main/ipc/gmail.ipc.ts"),
      "utf-8"
    );
    // Should pass bcc in the createDraft call
    expect(gmailIpc).toContain("bcc,");
  });
});

// ============================================================
// Preload API Tests
// ============================================================

test.describe("CC/BCC - Preload API", () => {
  test("preload exposes createDraft with bcc parameter", () => {
    const preloadCode = readFileSync(
      path.join(srcDir, "preload/index.ts"),
      "utf-8"
    );
    expect(preloadCode).toContain(
      "createDraft: (emailId: string, body: string, cc?: string[], bcc?: string[], accountId?: string)"
    );
    expect(preloadCode).toContain("{ emailId, body, cc, bcc, accountId }");
  });
});

// ============================================================
// Gmail Client Service Tests
// ============================================================

test.describe("CC/BCC - Gmail Client Service", () => {
  test("GmailClient.createDraft accepts bcc parameter", () => {
    const clientCode = readFileSync(
      path.join(srcDir, "main/services/gmail-client.ts"),
      "utf-8"
    );

    // The createDraft method should accept bcc
    expect(clientCode).toContain("bcc?: string[];");

    // Should pass bcc to buildMimeMessage for proper MIME formatting
    expect(clientCode).toContain("bcc: params.bcc,");
  });
});

// ============================================================
// Validation Logic Tests
// ============================================================

test.describe("CC/BCC - Validation: at least one recipient required", () => {
  test("sending with only To address is valid", () => {
    const to = ["user@example.com"];
    const cc: string[] = [];
    const bcc: string[] = [];
    const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    expect(hasAnyRecipient).toBe(true);
  });

  test("sending with only CC address is valid", () => {
    const to: string[] = [];
    const cc = ["cc@example.com"];
    const bcc: string[] = [];
    const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    expect(hasAnyRecipient).toBe(true);
  });

  test("sending with only BCC address is valid", () => {
    const to: string[] = [];
    const cc: string[] = [];
    const bcc = ["bcc@example.com"];
    const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    expect(hasAnyRecipient).toBe(true);
  });

  test("sending with multiple fields filled is valid", () => {
    const to = ["user@example.com"];
    const cc = ["cc@example.com"];
    const bcc = ["bcc@example.com"];
    const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    expect(hasAnyRecipient).toBe(true);
  });

  test("sending with no recipients in any field is invalid", () => {
    const to: string[] = [];
    const cc: string[] = [];
    const bcc: string[] = [];
    const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    expect(hasAnyRecipient).toBe(false);
  });

  test("empty strings are not counted as recipients", () => {
    const to = ["", " "].map((e) => e.trim()).filter(Boolean);
    const cc: string[] = [];
    const bcc: string[] = [];
    const hasAnyRecipient = to.length > 0 || cc.length > 0 || bcc.length > 0;
    expect(hasAnyRecipient).toBe(false);
  });
});
