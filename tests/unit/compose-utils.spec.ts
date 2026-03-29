/**
 * Unit tests for utility functions in compose.ipc.ts
 *
 * These test the pure functions: escapeHtml, parseAddressList, extractReplyInfo
 * which are not exported but contain important logic worth testing.
 * We re-implement them here to test the algorithms.
 */
import { test, expect } from "@playwright/test";

// ============================================================
// escapeHtml
// ============================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

test.describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert('xss')&lt;/script&gt;"
    );
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('He said "hello"')).toBe("He said &quot;hello&quot;");
  });

  test("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  test("handles multiple entities in one string", () => {
    expect(escapeHtml('Tom & "Jerry" <friends>')).toBe(
      "Tom &amp; &quot;Jerry&quot; &lt;friends&gt;"
    );
  });

  test("no-ops on safe text", () => {
    const safe = "Hello world 123";
    expect(escapeHtml(safe)).toBe(safe);
  });
});

// ============================================================
// parseAddressList
// ============================================================

function parseAddressList(header: string): string[] {
  return header
    .split(",")
    .map((s) => s.trim())
    .map((s) => {
      const match = s.match(/<([^>]+)>/);
      return match ? match[1] : s;
    })
    .filter(Boolean);
}

test.describe("parseAddressList", () => {
  test("parses bare email addresses", () => {
    expect(parseAddressList("alice@a.com, bob@b.com")).toEqual([
      "alice@a.com",
      "bob@b.com",
    ]);
  });

  test("extracts email from Name <email> format", () => {
    expect(
      parseAddressList("Alice Smith <alice@a.com>, Bob <bob@b.com>")
    ).toEqual(["alice@a.com", "bob@b.com"]);
  });

  test("handles single address", () => {
    expect(parseAddressList("test@example.com")).toEqual(["test@example.com"]);
  });

  test("handles mixed formats", () => {
    expect(
      parseAddressList("Alice <alice@a.com>, bob@b.com, Carol C <carol@c.com>")
    ).toEqual(["alice@a.com", "bob@b.com", "carol@c.com"]);
  });

  test("handles empty string", () => {
    expect(parseAddressList("")).toEqual([]);
  });

  test("trims whitespace", () => {
    expect(parseAddressList("  alice@a.com  ,  bob@b.com  ")).toEqual([
      "alice@a.com",
      "bob@b.com",
    ]);
  });
});

// ============================================================
// extractReplyInfo logic
// ============================================================

interface MockEmail {
  from: string;
  to: string;
  cc?: string;
  subject: string;
  date: string;
  threadId: string;
  id: string;
  body: string;
  attachments?: Array<{ filename: string }>;
}

type ComposeMode = "reply" | "reply-all" | "forward";

interface ReplyInfo {
  to: string[];
  cc: string[];
  subject: string;
  threadId: string;
  inReplyTo: string;
  references: string;
  quotedBody: string;
  originalBody: string;
  attribution: string;
  forwardedAttachments?: Array<{ filename: string }>;
}

function extractReplyInfo(
  email: MockEmail,
  mode: ComposeMode,
  userEmail?: string
): ReplyInfo | null {
  if (!email) return null;

  const fromMatch = email.from.match(/<([^>]+)>/) || [null, email.from];
  const fromEmail = fromMatch[1] || email.from;
  const toAddresses = parseAddressList(email.to);
  const ccAddresses = email.cc ? parseAddressList(email.cc) : [];

  let cc: string[] = [];
  if (mode === "reply-all") {
    const exclude = new Set([fromEmail.toLowerCase()]);
    if (userEmail) exclude.add(userEmail.toLowerCase());
    const seen = new Set<string>();
    for (const addr of [...toAddresses, ...ccAddresses]) {
      const lower = addr.toLowerCase();
      if (!exclude.has(lower) && !seen.has(lower)) {
        seen.add(lower);
        cc.push(addr);
      }
    }
  }

  let subject = email.subject;
  if (mode === "forward") {
    if (!subject.toLowerCase().startsWith("fwd:")) {
      subject = `Fwd: ${subject}`;
    }
  } else {
    if (!subject.toLowerCase().startsWith("re:")) {
      subject = `Re: ${subject}`;
    }
  }

  const escapedFrom = escapeHtml(email.from);
  const dateStr = new Date(email.date).toLocaleString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

  let quotedBody: string;
  let attribution: string;

  if (mode === "forward") {
    const escapedSubject = escapeHtml(email.subject);
    const escapedTo = escapeHtml(email.to);
    let attachmentLine = "";
    if (email.attachments?.length) {
      const names = email.attachments.map((a) => escapeHtml(a.filename)).join(", ");
      attachmentLine = `<br>Attachments: ${names}`;
    }
    attribution = `---------- Forwarded message ---------<br>From: <strong>${escapedFrom}</strong><br>Date: ${dateStr}<br>Subject: ${escapedSubject}<br>To: ${escapedTo}${attachmentLine}`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><br><br>${email.body}</div>`;
  } else {
    attribution = `On ${dateStr}, ${escapedFrom} wrote:`;
    quotedBody = `<br><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">${attribution}</div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex">${email.body}</blockquote></div>`;
  }

  return {
    to: mode === "forward" ? [] : [fromEmail],
    cc,
    subject,
    threadId: email.threadId,
    inReplyTo: email.id,
    references: email.id,
    quotedBody,
    originalBody: email.body,
    attribution,
    ...(mode === "forward" &&
      email.attachments?.length && {
        forwardedAttachments: email.attachments,
      }),
  };
}

const sampleEmail: MockEmail = {
  from: "Sarah Johnson <sarah@example.com>",
  to: "user@example.com",
  cc: "manager@example.com, lead@example.com",
  subject: "Project Update",
  date: "2025-01-06T15:45:00Z",
  threadId: "thread-001",
  id: "msg-001",
  body: "<div>Please review the project status.</div>",
};

test.describe("extractReplyInfo — reply mode", () => {
  test("sets To to sender email", () => {
    const result = extractReplyInfo(sampleEmail, "reply");
    expect(result!.to).toEqual(["sarah@example.com"]);
  });

  test("adds Re: prefix to subject", () => {
    const result = extractReplyInfo(sampleEmail, "reply");
    expect(result!.subject).toBe("Re: Project Update");
  });

  test("does not duplicate Re: prefix", () => {
    const email = { ...sampleEmail, subject: "Re: Project Update" };
    const result = extractReplyInfo(email, "reply");
    expect(result!.subject).toBe("Re: Project Update");
  });

  test("cc is empty in reply mode", () => {
    const result = extractReplyInfo(sampleEmail, "reply");
    expect(result!.cc).toEqual([]);
  });

  test("includes quoted body with blockquote", () => {
    const result = extractReplyInfo(sampleEmail, "reply");
    expect(result!.quotedBody).toContain("gmail_quote");
    expect(result!.quotedBody).toContain("<blockquote");
    expect(result!.quotedBody).toContain(sampleEmail.body);
  });

  test("preserves original body", () => {
    const result = extractReplyInfo(sampleEmail, "reply");
    expect(result!.originalBody).toBe(sampleEmail.body);
  });

  test("sets threadId and references", () => {
    const result = extractReplyInfo(sampleEmail, "reply");
    expect(result!.threadId).toBe("thread-001");
    expect(result!.inReplyTo).toBe("msg-001");
  });
});

test.describe("extractReplyInfo — reply-all mode", () => {
  test("includes original To and CC recipients (excluding sender and user)", () => {
    const result = extractReplyInfo(sampleEmail, "reply-all", "user@example.com");
    // To should have: sender (sarah)
    expect(result!.to).toEqual(["sarah@example.com"]);
    // CC should have: manager, lead (excluding sender sarah and user@example.com)
    expect(result!.cc).toEqual(["manager@example.com", "lead@example.com"]);
  });

  test("deduplicates CC addresses", () => {
    const email = {
      ...sampleEmail,
      to: "user@example.com, manager@example.com",
      cc: "manager@example.com",
    };
    const result = extractReplyInfo(email, "reply-all", "user@example.com");
    // manager should appear only once
    expect(result!.cc).toEqual(["manager@example.com"]);
  });

  test("excludes sender from CC", () => {
    const email = {
      ...sampleEmail,
      to: "user@example.com, sarah@example.com",
    };
    const result = extractReplyInfo(email, "reply-all", "user@example.com");
    expect(result!.cc).not.toContain("sarah@example.com");
  });
});

test.describe("extractReplyInfo — forward mode", () => {
  test("sets To to empty array", () => {
    const result = extractReplyInfo(sampleEmail, "forward");
    expect(result!.to).toEqual([]);
  });

  test("adds Fwd: prefix to subject", () => {
    const result = extractReplyInfo(sampleEmail, "forward");
    expect(result!.subject).toBe("Fwd: Project Update");
  });

  test("does not duplicate Fwd: prefix", () => {
    const email = { ...sampleEmail, subject: "Fwd: Project Update" };
    const result = extractReplyInfo(email, "forward");
    expect(result!.subject).toBe("Fwd: Project Update");
  });

  test("includes forwarded message header in attribution", () => {
    const result = extractReplyInfo(sampleEmail, "forward");
    expect(result!.attribution).toContain("Forwarded message");
    expect(result!.attribution).toContain("Sarah Johnson");
  });

  test("does not use blockquote for forwarded content", () => {
    const result = extractReplyInfo(sampleEmail, "forward");
    expect(result!.quotedBody).not.toContain("<blockquote");
  });

  test("includes attachment names in forwarded header", () => {
    const email = {
      ...sampleEmail,
      attachments: [
        { filename: "report.pdf" },
        { filename: "budget.xlsx" },
      ],
    };
    const result = extractReplyInfo(email, "forward");
    expect(result!.attribution).toContain("Attachments: report.pdf, budget.xlsx");
    expect(result!.forwardedAttachments).toHaveLength(2);
  });
});

test.describe("extractReplyInfo — edge cases", () => {
  test("handles bare email address (no angle brackets) in From", () => {
    const email = { ...sampleEmail, from: "sarah@example.com" };
    const result = extractReplyInfo(email, "reply");
    expect(result!.to).toEqual(["sarah@example.com"]);
  });

  test("handles email with no CC", () => {
    const email = { ...sampleEmail, cc: undefined };
    const result = extractReplyInfo(email, "reply-all", "user@example.com");
    // Only non-user To recipients in CC
    expect(result!.cc).toEqual([]);
  });

  test("escapes HTML in From field for attribution", () => {
    const email = {
      ...sampleEmail,
      from: 'Tom & "Jerry" <tom@example.com>',
    };
    const result = extractReplyInfo(email, "reply");
    expect(result!.attribution).toContain("&amp;");
    expect(result!.attribution).toContain("&quot;");
  });
});
