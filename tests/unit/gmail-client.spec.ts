/**
 * Unit tests for gmail-client.ts logic.
 *
 * Cannot import GmailClient directly because it transitively imports Electron.
 * Instead, we re-implement the pure/testable functions inline and test them,
 * and use MSW (Mock Service Worker) for testing HTTP-level behaviors against
 * the Gmail API endpoints.
 */
import { test, expect } from "@playwright/test";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import {
  makeGmailMessage,
  FIXTURE_MESSAGES,
  FIXTURE_PROFILE,
  FIXTURE_LIST_RESPONSE,
  FIXTURE_HISTORY_RESPONSE,
  type GmailApiMessage,
} from "../mocks/gmail-api-fixtures";

// ============================================================================
// Re-implemented pure functions from gmail-client.ts
// ============================================================================

/**
 * Extract a header value from a Gmail API message payload.
 * Case-insensitive lookup, returns empty string if not found.
 */
function getHeader(headers: Array<{ name?: string; value?: string }>, name: string): string {
  const header = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return header?.value || "";
}

/**
 * Extract body from a Gmail API message payload.
 * Handles direct body, multipart (preferring HTML over plain text),
 * and nested multipart structures.
 */
function extractBody(payload: Record<string, unknown> | null | undefined): string {
  if (!payload) return "";

  const body = payload.body as { data?: string } | undefined;
  // Direct body
  if (body?.data) {
    return Buffer.from(body.data, "base64").toString("utf-8");
  }

  // Multipart — prefer HTML, fall back to plain text
  const parts = payload.parts as Array<Record<string, unknown>> | undefined;
  if (parts) {
    // First try HTML
    for (const part of parts) {
      const partBody = part.body as { data?: string } | undefined;
      if (part.mimeType === "text/html" && partBody?.data) {
        return Buffer.from(partBody.data, "base64").toString("utf-8");
      }
    }
    // Fall back to plain text
    for (const part of parts) {
      const partBody = part.body as { data?: string } | undefined;
      if (part.mimeType === "text/plain" && partBody?.data) {
        return Buffer.from(partBody.data, "base64").toString("utf-8");
      }
    }
    // Recurse into nested parts
    for (const part of parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return "";
}

/**
 * Collect inline image parts from MIME tree (parts with Content-ID headers).
 * Returns a map from Content-ID (without angle brackets) to image metadata.
 */
function collectInlineImages(
  payload: Record<string, unknown>,
): Map<string, { mimeType: string; data?: string; attachmentId?: string }> {
  const images = new Map<string, { mimeType: string; data?: string; attachmentId?: string }>();

  const walk = (part: Record<string, unknown>) => {
    const headers: Array<{ name?: string; value?: string }> =
      (part.headers as Array<{ name?: string; value?: string }>) || [];
    const contentId = headers.find((h) => h.name?.toLowerCase() === "content-id")?.value;

    if (contentId && typeof part.mimeType === "string" && part.mimeType.startsWith("image/")) {
      const cid = contentId.replace(/^<|>$/g, "");
      const body = part.body as { data?: string; attachmentId?: string } | undefined;
      images.set(cid, {
        mimeType: part.mimeType,
        data: body?.data,
        attachmentId: body?.attachmentId,
      });
    }

    const childParts = part.parts as Array<Record<string, unknown>> | undefined;
    if (childParts) {
      for (const child of childParts) {
        walk(child);
      }
    }
  };

  walk(payload);
  return images;
}

interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string;
}

/**
 * Extract attachment metadata from a Gmail message payload.
 * Recursively walks multipart MIME structure to find parts with a filename.
 */
function extractAttachments(payload: Record<string, unknown> | null | undefined): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  if (!payload) return attachments;
  collectAttachments(payload, attachments);
  return attachments;
}

function collectAttachments(part: Record<string, unknown>, result: AttachmentMeta[]): void {
  const filename = part.filename as string | undefined;
  const body = part.body as { attachmentId?: string; size?: number } | undefined;
  if (filename && filename.length > 0 && body?.attachmentId) {
    result.push({
      id: `${(part.partId as string) || "0"}-${filename}`,
      filename,
      mimeType: (part.mimeType as string) || "application/octet-stream",
      size: body?.size || 0,
      attachmentId: body.attachmentId,
    });
  }

  const parts = part.parts as Array<Record<string, unknown>> | undefined;
  if (parts) {
    for (const child of parts) {
      collectAttachments(child, result);
    }
  }
}

/**
 * Detect whether an error is an OAuth authentication error.
 */
function isAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  if (msg.includes("invalid_grant") || msg.includes("token has been expired or revoked")) {
    return true;
  }
  const anyErr = error as unknown as Record<string, unknown>;
  if (anyErr.code === 401 || anyErr.status === 401) {
    return true;
  }
  return false;
}

/**
 * Check if token is expired (within 5 minute buffer).
 */
function isTokenExpired(expiryDate: number | undefined): boolean {
  return expiryDate != null && expiryDate < Date.now() + 5 * 60 * 1000;
}

/**
 * Resolve cid: references in HTML with data: URIs.
 * Gmail uses base64url encoding; this converts to standard base64 for data URIs.
 */
function resolveInlineImagesSync(
  html: string,
  inlineImages: Map<string, { mimeType: string; data?: string; attachmentId?: string }>,
): string {
  if (inlineImages.size === 0) return html;

  const cidRefs = new Set<string>();
  const cidRegex = /cid:([^\s"'<>)]+)/g;
  let match;
  while ((match = cidRegex.exec(html)) !== null) {
    cidRefs.add(match[1]);
  }

  if (cidRefs.size === 0) return html;

  const replacements = new Map<string, string>();

  for (const cid of cidRefs) {
    const imageInfo = inlineImages.get(cid);
    if (!imageInfo || !imageInfo.data) continue;

    // Convert base64url to standard base64
    let standardBase64 = imageInfo.data.replace(/-/g, "+").replace(/_/g, "/");
    const pad = standardBase64.length % 4;
    if (pad) standardBase64 += "=".repeat(4 - pad);
    replacements.set(`cid:${cid}`, `data:${imageInfo.mimeType};base64,${standardBase64}`);
  }

  let result = html;
  for (const [from, to] of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}

/**
 * Format sender address with display name (RFC 5322).
 */
function getSenderAddress(email: string, displayName: string | null): string {
  if (displayName) {
    const needsQuoting = /[",.<>@;:\\[\]()]/.test(displayName);
    const formatted = needsQuoting ? `"${displayName.replace(/["\\]/g, "\\$&")}"` : displayName;
    return `${formatted} <${email}>`;
  }
  return email;
}

/**
 * Parse a Gmail API message into an Email-like object.
 * This mirrors the readEmail/getThread parsing logic.
 */
function parseGmailMessage(message: GmailApiMessage): {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  date: string;
  body: string;
  snippet: string;
  labelIds: string[];
  attachments?: AttachmentMeta[];
  messageIdHeader?: string;
  inReplyTo?: string;
} {
  const headers = message.payload?.headers || [];
  const body = extractBody(message.payload);
  const attachments = extractAttachments(message.payload);

  const cc = getHeader(headers, "cc");
  const bcc = getHeader(headers, "bcc");
  const messageIdHeader = getHeader(headers, "message-id");
  const inReplyToHeader = getHeader(headers, "in-reply-to");

  return {
    id: message.id,
    threadId: message.threadId,
    subject: getHeader(headers, "subject"),
    from: getHeader(headers, "from"),
    to: getHeader(headers, "to"),
    ...(cc && { cc }),
    ...(bcc && { bcc }),
    date: getHeader(headers, "date"),
    body,
    snippet: message.snippet || "",
    labelIds: message.labelIds || [],
    ...(attachments.length > 0 && { attachments }),
    ...(messageIdHeader && { messageIdHeader }),
    ...(inReplyToHeader && { inReplyTo: inReplyToHeader }),
  };
}

// ============================================================================
// Header extraction tests
// ============================================================================

test.describe("getHeader", () => {
  const headers = [
    { name: "From", value: "alice@example.com" },
    { name: "To", value: "bob@example.com" },
    { name: "Subject", value: "Hello World" },
    { name: "Date", value: "Mon, 6 Jan 2025 15:45:00 -0800" },
    { name: "Message-ID", value: "<abc123@mail.gmail.com>" },
    { name: "Cc", value: "charlie@example.com" },
    { name: "In-Reply-To", value: "<parent123@mail.gmail.com>" },
  ];

  test("finds headers case-insensitively", () => {
    expect(getHeader(headers, "from")).toBe("alice@example.com");
    expect(getHeader(headers, "FROM")).toBe("alice@example.com");
    expect(getHeader(headers, "From")).toBe("alice@example.com");
  });

  test("returns empty string for missing headers", () => {
    expect(getHeader(headers, "Bcc")).toBe("");
    expect(getHeader(headers, "X-Custom-Header")).toBe("");
  });

  test("extracts all standard email headers", () => {
    expect(getHeader(headers, "to")).toBe("bob@example.com");
    expect(getHeader(headers, "subject")).toBe("Hello World");
    expect(getHeader(headers, "date")).toBe("Mon, 6 Jan 2025 15:45:00 -0800");
    expect(getHeader(headers, "message-id")).toBe("<abc123@mail.gmail.com>");
    expect(getHeader(headers, "cc")).toBe("charlie@example.com");
    expect(getHeader(headers, "in-reply-to")).toBe("<parent123@mail.gmail.com>");
  });

  test("handles empty headers array", () => {
    expect(getHeader([], "from")).toBe("");
  });

  test("handles headers with undefined name or value", () => {
    const weirdHeaders = [
      { name: undefined, value: "orphan" },
      { name: "X-Test", value: undefined },
    ];
    expect(getHeader(weirdHeaders, "X-Test")).toBe("");
    expect(getHeader(weirdHeaders, "unknown")).toBe("");
  });
});

// ============================================================================
// Body decoding tests
// ============================================================================

test.describe("extractBody", () => {
  test("decodes base64url body from direct payload", () => {
    const payload = {
      mimeType: "text/html",
      body: {
        data: Buffer.from("<div>Hello World</div>").toString("base64url"),
      },
    };
    expect(extractBody(payload)).toBe("<div>Hello World</div>");
  });

  test("returns empty string for null/undefined payload", () => {
    expect(extractBody(null)).toBe("");
    expect(extractBody(undefined)).toBe("");
  });

  test("returns empty string for empty payload", () => {
    expect(extractBody({})).toBe("");
  });

  test("prefers HTML over plain text in multipart", () => {
    const payload = {
      mimeType: "multipart/alternative",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Plain text version").toString("base64url"),
          },
        },
        {
          mimeType: "text/html",
          body: {
            data: Buffer.from("<b>HTML version</b>").toString("base64url"),
          },
        },
      ],
    };
    expect(extractBody(payload)).toBe("<b>HTML version</b>");
  });

  test("falls back to plain text when no HTML part exists", () => {
    const payload = {
      mimeType: "multipart/alternative",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Just plain text").toString("base64url"),
          },
        },
      ],
    };
    expect(extractBody(payload)).toBe("Just plain text");
  });

  test("handles nested multipart structures", () => {
    const payload = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "multipart/alternative",
          body: { size: 0 },
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from("Nested plain").toString("base64url"),
              },
            },
            {
              mimeType: "text/html",
              body: {
                data: Buffer.from("<p>Nested HTML</p>").toString("base64url"),
              },
            },
          ],
        },
        {
          mimeType: "application/pdf",
          filename: "doc.pdf",
          body: { attachmentId: "att-1", size: 1024 },
        },
      ],
    };
    expect(extractBody(payload)).toBe("<p>Nested HTML</p>");
  });

  test("returns empty string when no text parts in multipart", () => {
    const payload = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "application/pdf",
          filename: "doc.pdf",
          body: { attachmentId: "att-1", size: 1024 },
        },
      ],
    };
    expect(extractBody(payload)).toBe("");
  });

  test("handles base64url encoding with special characters", () => {
    // base64url uses - and _ instead of + and /
    const text = "Special chars: <>&\"' 日本語";
    const payload = {
      body: { data: Buffer.from(text).toString("base64url") },
    };
    expect(extractBody(payload)).toBe(text);
  });

  test("handles multipart with body data absent from some parts", () => {
    const payload = {
      mimeType: "multipart/alternative",
      body: { size: 0 },
      parts: [
        {
          mimeType: "text/html",
          body: { size: 0 }, // No data field
        },
        {
          mimeType: "text/plain",
          body: {
            data: Buffer.from("Fallback plain").toString("base64url"),
          },
        },
      ],
    };
    expect(extractBody(payload)).toBe("Fallback plain");
  });
});

// ============================================================================
// Attachment extraction tests
// ============================================================================

test.describe("extractAttachments", () => {
  test("returns empty array for null payload", () => {
    expect(extractAttachments(null)).toEqual([]);
  });

  test("extracts attachment with filename and attachmentId", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "1",
          mimeType: "text/html",
          body: {
            data: Buffer.from("<p>Email body</p>").toString("base64url"),
          },
        },
        {
          partId: "2",
          filename: "report.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "ANGjdJ_123", size: 50000 },
        },
      ],
    };

    const attachments = extractAttachments(payload);
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toEqual({
      id: "2-report.pdf",
      filename: "report.pdf",
      mimeType: "application/pdf",
      size: 50000,
      attachmentId: "ANGjdJ_123",
    });
  });

  test("ignores inline parts without attachmentId", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          partId: "1",
          filename: "logo.png",
          mimeType: "image/png",
          body: {
            // Inline image with data but no attachmentId
            data: "iVBORw0KGgo",
            size: 500,
          },
        },
      ],
    };

    const attachments = extractAttachments(payload);
    expect(attachments).toHaveLength(0);
  });

  test("handles nested multipart with multiple attachments", () => {
    const payload = {
      mimeType: "multipart/mixed",
      parts: [
        {
          mimeType: "multipart/alternative",
          parts: [
            {
              mimeType: "text/plain",
              body: {
                data: Buffer.from("text").toString("base64url"),
              },
            },
          ],
        },
        {
          partId: "2",
          filename: "doc.pdf",
          mimeType: "application/pdf",
          body: { attachmentId: "att-1", size: 1024 },
        },
        {
          partId: "3",
          filename: "image.jpg",
          mimeType: "image/jpeg",
          body: { attachmentId: "att-2", size: 2048 },
        },
      ],
    };

    const attachments = extractAttachments(payload);
    expect(attachments).toHaveLength(2);
    expect(attachments[0].filename).toBe("doc.pdf");
    expect(attachments[1].filename).toBe("image.jpg");
  });

  test("uses default mimeType when none provided", () => {
    const payload = {
      partId: "0",
      filename: "mystery.bin",
      body: { attachmentId: "att-x", size: 100 },
    };
    // collectAttachments is called on the top-level payload
    const attachments = extractAttachments(payload);
    expect(attachments).toHaveLength(1);
    expect(attachments[0].mimeType).toBe("application/octet-stream");
  });

  test("uses '0' as default partId when missing", () => {
    const payload = {
      filename: "file.txt",
      mimeType: "text/plain",
      body: { attachmentId: "att-y", size: 10 },
    };
    const attachments = extractAttachments(payload);
    expect(attachments[0].id).toBe("0-file.txt");
  });

  test("ignores parts with empty filename", () => {
    const payload = {
      partId: "1",
      filename: "",
      mimeType: "application/pdf",
      body: { attachmentId: "att-z", size: 500 },
    };
    expect(extractAttachments(payload)).toHaveLength(0);
  });
});

// ============================================================================
// Inline image collection tests
// ============================================================================

test.describe("collectInlineImages", () => {
  test("finds inline images with Content-ID headers", () => {
    const payload = {
      mimeType: "multipart/related",
      parts: [
        {
          mimeType: "text/html",
          body: {
            data: Buffer.from('<img src="cid:image001@domain">').toString("base64url"),
          },
        },
        {
          mimeType: "image/png",
          headers: [
            {
              name: "Content-ID",
              value: "<image001@domain>",
            },
          ],
          body: {
            data: "iVBORw0KGgo",
          },
        },
      ],
    };

    const images = collectInlineImages(payload);
    expect(images.size).toBe(1);
    expect(images.has("image001@domain")).toBe(true);
    expect(images.get("image001@domain")!.mimeType).toBe("image/png");
    expect(images.get("image001@domain")!.data).toBe("iVBORw0KGgo");
  });

  test("handles images with attachmentId (not inline data)", () => {
    const payload = {
      mimeType: "multipart/related",
      parts: [
        {
          mimeType: "image/jpeg",
          headers: [{ name: "Content-ID", value: "<photo@domain>" }],
          body: {
            attachmentId: "ANGjdJ_abc",
            size: 50000,
          },
        },
      ],
    };

    const images = collectInlineImages(payload);
    expect(images.get("photo@domain")!.attachmentId).toBe("ANGjdJ_abc");
    expect(images.get("photo@domain")!.data).toBeUndefined();
  });

  test("ignores non-image parts even with Content-ID", () => {
    const payload = {
      mimeType: "multipart/related",
      parts: [
        {
          mimeType: "application/pdf",
          headers: [{ name: "Content-ID", value: "<doc@domain>" }],
          body: { attachmentId: "att-1", size: 100 },
        },
      ],
    };

    const images = collectInlineImages(payload);
    expect(images.size).toBe(0);
  });

  test("strips angle brackets from Content-ID", () => {
    const payload = {
      mimeType: "multipart/related",
      parts: [
        {
          mimeType: "image/gif",
          headers: [{ name: "Content-ID", value: "<animation@domain>" }],
          body: { data: "R0lGODlh" },
        },
      ],
    };

    const images = collectInlineImages(payload);
    expect(images.has("animation@domain")).toBe(true);
    // No angle brackets in the key
    expect(images.has("<animation@domain>")).toBe(false);
  });

  test("returns empty map when no inline images", () => {
    const payload = {
      mimeType: "text/html",
      body: {
        data: Buffer.from("<p>No images</p>").toString("base64url"),
      },
    };
    expect(collectInlineImages(payload).size).toBe(0);
  });
});

// ============================================================================
// Inline image resolution (cid: → data: URI)
// ============================================================================

test.describe("resolveInlineImagesSync", () => {
  test("replaces cid: references with data: URIs", () => {
    const html = '<img src="cid:image001@domain">';
    const images = new Map([["image001@domain", { mimeType: "image/png", data: "iVBORw0KGgo" }]]);

    const result = resolveInlineImagesSync(html, images);
    expect(result).toContain("data:image/png;base64,");
    expect(result).not.toContain("cid:");
  });

  test("converts base64url to standard base64 with padding", () => {
    // base64url chars: - and _
    // standard base64 chars: + and /
    const html = '<img src="cid:test@domain">';
    const data = "abc-def_ghi"; // 11 chars → needs 1 pad char
    const images = new Map([["test@domain", { mimeType: "image/jpeg", data }]]);

    const result = resolveInlineImagesSync(html, images);
    // base64url → standard: - → +, _ → /
    expect(result).toContain("abc+def/ghi=");
  });

  test("returns html unchanged when no images map is empty", () => {
    const html = '<img src="cid:missing@domain">';
    const result = resolveInlineImagesSync(html, new Map());
    expect(result).toBe(html);
  });

  test("returns html unchanged when no cid: references found", () => {
    const html = '<img src="https://example.com/image.png">';
    const images = new Map([["unused@domain", { mimeType: "image/png", data: "data" }]]);
    const result = resolveInlineImagesSync(html, images);
    expect(result).toBe(html);
  });

  test("handles multiple cid: references", () => {
    const html = '<img src="cid:a@d"><img src="cid:b@d">';
    const images = new Map([
      ["a@d", { mimeType: "image/png", data: "AAAA" }],
      ["b@d", { mimeType: "image/jpeg", data: "BBBB" }],
    ]);
    const result = resolveInlineImagesSync(html, images);
    expect(result).toContain("data:image/png;base64,AAAA");
    expect(result).toContain("data:image/jpeg;base64,BBBB");
    expect(result).not.toContain("cid:");
  });

  test("skips cid references not found in images map", () => {
    const html = '<img src="cid:found@d"><img src="cid:notfound@d">';
    const images = new Map([["found@d", { mimeType: "image/png", data: "AAAA" }]]);
    const result = resolveInlineImagesSync(html, images);
    expect(result).toContain("data:image/png;base64,AAAA");
    expect(result).toContain("cid:notfound@d");
  });

  test("skips images with no data and no attachmentId", () => {
    const html = '<img src="cid:nodata@d">';
    const images = new Map([["nodata@d", { mimeType: "image/png" }]]);
    const result = resolveInlineImagesSync(html, images);
    // No data available, cid reference remains
    expect(result).toBe(html);
  });
});

// ============================================================================
// isAuthError tests
// ============================================================================

test.describe("isAuthError", () => {
  test("detects invalid_grant error", () => {
    expect(isAuthError(new Error("invalid_grant"))).toBe(true);
  });

  test("detects token expired or revoked error", () => {
    expect(isAuthError(new Error("Token has been expired or revoked"))).toBe(true);
  });

  test("detects HTTP 401 via code property", () => {
    const err = Object.assign(new Error("Unauthorized"), {
      code: 401,
    });
    expect(isAuthError(err)).toBe(true);
  });

  test("detects HTTP 401 via status property", () => {
    const err = Object.assign(new Error("Unauthorized"), {
      status: 401,
    });
    expect(isAuthError(err)).toBe(true);
  });

  test("returns false for non-Error values", () => {
    expect(isAuthError("invalid_grant")).toBe(false);
    expect(isAuthError(401)).toBe(false);
    expect(isAuthError(null)).toBe(false);
    expect(isAuthError(undefined)).toBe(false);
  });

  test("returns false for regular errors", () => {
    expect(isAuthError(new Error("ECONNREFUSED"))).toBe(false);
    expect(isAuthError(new Error("Network timeout"))).toBe(false);
  });

  test("returns false for HTTP 403 (forbidden, not auth)", () => {
    const err = Object.assign(new Error("Forbidden"), { code: 403 });
    expect(isAuthError(err)).toBe(false);
  });

  test("returns false for HTTP 500 errors", () => {
    const err = Object.assign(new Error("Internal Server Error"), {
      code: 500,
    });
    expect(isAuthError(err)).toBe(false);
  });
});

// ============================================================================
// Token expiry check tests
// ============================================================================

test.describe("isTokenExpired", () => {
  test("returns false when expiryDate is undefined", () => {
    expect(isTokenExpired(undefined)).toBe(false);
  });

  test("returns false when token expires far in the future", () => {
    const future = Date.now() + 60 * 60 * 1000; // 1 hour from now
    expect(isTokenExpired(future)).toBe(false);
  });

  test("returns true when token already expired", () => {
    const past = Date.now() - 60 * 1000; // 1 minute ago
    expect(isTokenExpired(past)).toBe(true);
  });

  test("returns true when token expires within 5 minutes", () => {
    const soonExpiry = Date.now() + 3 * 60 * 1000; // 3 min from now (within 5 min buffer)
    expect(isTokenExpired(soonExpiry)).toBe(true);
  });

  test("returns false when token expires exactly after 5 minutes", () => {
    const justOutside = Date.now() + 6 * 60 * 1000; // 6 min from now
    expect(isTokenExpired(justOutside)).toBe(false);
  });
});

// ============================================================================
// getSenderAddress (RFC 5322 formatting)
// ============================================================================

test.describe("getSenderAddress", () => {
  test("returns just email when no display name", () => {
    expect(getSenderAddress("user@example.com", null)).toBe("user@example.com");
  });

  test("formats with display name", () => {
    expect(getSenderAddress("user@example.com", "John Doe")).toBe("John Doe <user@example.com>");
  });

  test("quotes display name with special characters", () => {
    expect(getSenderAddress("user@example.com", "Doe, John")).toBe(
      '"Doe, John" <user@example.com>',
    );
  });

  test("quotes display name containing angle brackets", () => {
    expect(getSenderAddress("user@example.com", "Name <tag>")).toBe(
      '"Name <tag>" <user@example.com>',
    );
  });

  test("quotes display name containing @ symbol", () => {
    expect(getSenderAddress("user@example.com", "user@work")).toBe(
      '"user@work" <user@example.com>',
    );
  });

  test("escapes quotes inside display name that needs quoting", () => {
    expect(getSenderAddress("user@example.com", 'John "The Man" Doe, Jr')).toBe(
      '"John \\"The Man\\" Doe, Jr" <user@example.com>',
    );
  });

  test("escapes backslashes inside display name that needs quoting", () => {
    expect(getSenderAddress("user@example.com", "Path\\Name, Inc.")).toBe(
      '"Path\\\\Name, Inc." <user@example.com>',
    );
  });

  test("does not quote simple display names", () => {
    const result = getSenderAddress("user@example.com", "Alice Bob");
    expect(result).toBe("Alice Bob <user@example.com>");
    // No quotes around the name
    expect(result).not.toMatch(/^"/);
  });
});

// ============================================================================
// Full message parsing tests (using fixtures)
// ============================================================================

test.describe("parseGmailMessage", () => {
  test("parses fixture message correctly", () => {
    const msg = FIXTURE_MESSAGES[0];
    const parsed = parseGmailMessage(msg);

    expect(parsed.id).toBe("msg-001");
    expect(parsed.threadId).toBe("thread-001");
    expect(parsed.from).toBe("Sarah Johnson <sarah@example.com>");
    expect(parsed.to).toBe("user@example.com");
    expect(parsed.subject).toBe("Project Status Update Request");
    expect(parsed.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(parsed.body).toContain("could you send me a status update");
    expect(parsed.messageIdHeader).toBe("<msg-001@mail.gmail.com>");
  });

  test("parses all fixture messages", () => {
    for (const msg of FIXTURE_MESSAGES) {
      const parsed = parseGmailMessage(msg);
      expect(parsed.id).toBe(msg.id);
      expect(parsed.threadId).toBe(msg.threadId);
      expect(parsed.from).toBeTruthy();
      expect(parsed.subject).toBeTruthy();
      expect(parsed.body).toBeTruthy();
    }
  });

  test("includes cc when present", () => {
    const msg = makeGmailMessage({
      id: "msg-cc",
      threadId: "thread-cc",
      from: "a@example.com",
      to: "b@example.com",
      subject: "CC test",
      body: "Body",
      cc: "c@example.com, d@example.com",
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.cc).toBe("c@example.com, d@example.com");
  });

  test("omits cc when not present", () => {
    const msg = makeGmailMessage({
      id: "msg-nocc",
      threadId: "thread-nocc",
      from: "a@example.com",
      to: "b@example.com",
      subject: "No CC",
      body: "Body",
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.cc).toBeUndefined();
  });

  test("omits empty messageIdHeader and inReplyTo", () => {
    // Build a message with no Message-ID header
    const msg: GmailApiMessage = {
      id: "msg-no-headers",
      threadId: "thread-x",
      labelIds: ["INBOX"],
      snippet: "test",
      internalDate: String(Date.now()),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
          { name: "Subject", value: "Test" },
          { name: "Date", value: "Mon, 1 Jan 2025 00:00:00 +0000" },
        ],
        body: {
          size: 4,
          data: Buffer.from("test").toString("base64url"),
        },
        parts: [],
      },
      sizeEstimate: 100,
      historyId: "1",
    };

    const parsed = parseGmailMessage(msg);
    expect(parsed.messageIdHeader).toBeUndefined();
    expect(parsed.inReplyTo).toBeUndefined();
  });

  test("includes attachments when present", () => {
    const msg: GmailApiMessage = {
      id: "msg-att",
      threadId: "thread-att",
      labelIds: ["INBOX"],
      snippet: "See attached",
      internalDate: String(Date.now()),
      payload: {
        mimeType: "multipart/mixed",
        headers: [
          { name: "From", value: "sender@example.com" },
          { name: "To", value: "receiver@example.com" },
          { name: "Subject", value: "With attachment" },
          { name: "Date", value: "Mon, 1 Jan 2025 00:00:00 +0000" },
          {
            name: "Message-ID",
            value: "<msg-att@mail.gmail.com>",
          },
        ],
        body: { size: 0 },
        parts: [
          {
            mimeType: "text/plain",
            body: {
              data: Buffer.from("See the attached file").toString("base64url"),
              size: 21,
            },
          },
          {
            partId: "1",
            filename: "document.pdf",
            mimeType: "application/pdf",
            body: { attachmentId: "ANGjdJ_xyz", size: 12345 },
          },
        ] as unknown[],
      },
      sizeEstimate: 13000,
      historyId: "2",
    };

    const parsed = parseGmailMessage(msg);
    expect(parsed.attachments).toBeDefined();
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments![0].filename).toBe("document.pdf");
    expect(parsed.attachments![0].attachmentId).toBe("ANGjdJ_xyz");
  });

  test("omits attachments array when empty", () => {
    const parsed = parseGmailMessage(FIXTURE_MESSAGES[0]);
    expect(parsed.attachments).toBeUndefined();
  });
});

// ============================================================================
// MSW-based tests for Gmail API HTTP interactions
// ============================================================================

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const server = setupServer();

test.describe("Gmail API interactions (MSW)", () => {
  test.beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
  test.afterEach(() => server.resetHandlers());
  test.afterAll(() => server.close());

  test("messages.list returns message IDs and thread IDs", async () => {
    let capturedQuery: string | null = null;
    server.use(
      http.get(`${GMAIL_BASE}/messages`, ({ request }) => {
        const url = new URL(request.url);
        capturedQuery = url.searchParams.get("q");
        return HttpResponse.json(FIXTURE_LIST_RESPONSE);
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/messages?q=in%3Ainbox`);
    const data = await response.json();
    expect(capturedQuery).toBe("in:inbox");
    expect(data.messages).toHaveLength(3);
    expect(data.messages[0].id).toBe("msg-001");
    expect(data.messages[0].threadId).toBe("thread-001");
  });

  test("messages.get returns full message with payload", async () => {
    const fixtureMsg = FIXTURE_MESSAGES[0];
    let capturedMessageId: string | readonly string[] | undefined;
    server.use(
      http.get(`${GMAIL_BASE}/messages/:messageId`, ({ params }) => {
        capturedMessageId = params.messageId;
        return HttpResponse.json(fixtureMsg);
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/messages/msg-001`);
    const data = await response.json();
    expect(capturedMessageId).toBe("msg-001");
    expect(data.id).toBe("msg-001");
    expect(data.payload.headers).toBeDefined();

    // Verify we can parse the response
    const parsed = parseGmailMessage(data);
    expect(parsed.from).toBe("Sarah Johnson <sarah@example.com>");
  });

  test("profile endpoint returns email and historyId", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/profile`, () => {
        return HttpResponse.json(FIXTURE_PROFILE);
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/profile`);
    const data = await response.json();
    expect(data.emailAddress).toBe("user@example.com");
    expect(data.historyId).toBe("99999");
  });

  test("history.list returns added and deleted messages", async () => {
    let capturedStartId: string | null = null;
    server.use(
      http.get(`${GMAIL_BASE}/history`, ({ request }) => {
        const url = new URL(request.url);
        capturedStartId = url.searchParams.get("startHistoryId");
        return HttpResponse.json(FIXTURE_HISTORY_RESPONSE);
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/history?startHistoryId=99999`);
    const data = await response.json();
    expect(capturedStartId).toBe("99999");
    expect(data.historyId).toBe("100001");
    expect(data.history).toHaveLength(1);
    expect(data.history[0].messagesAdded).toHaveLength(1);
    expect(data.history[0].messagesAdded[0].message.id).toBe("msg-new-001");
  });

  test("messages.get returns 404 for non-existent message", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/messages/:messageId`, () => {
        return HttpResponse.json({ error: { code: 404, message: "Not Found" } }, { status: 404 });
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/messages/nonexistent`);
    expect(response.status).toBe(404);
  });

  test("401 response triggers auth error handling", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/profile`, () => {
        return HttpResponse.json(
          {
            error: {
              code: 401,
              message: "Request had invalid authentication credentials",
            },
          },
          { status: 401 },
        );
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/profile`);
    expect(response.status).toBe(401);

    const data = await response.json();
    const err = Object.assign(new Error(data.error.message), {
      code: data.error.code,
    });
    expect(isAuthError(err)).toBe(true);
  });

  test("history.list returns 404 for expired history ID", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/history`, () => {
        return HttpResponse.json(
          {
            error: {
              code: 404,
              message: "History ID is too old",
            },
          },
          { status: 404 },
        );
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/history?startHistoryId=1`);
    expect(response.status).toBe(404);
  });

  test("messages.list handles pagination with nextPageToken", async () => {
    let page = 0;
    server.use(
      http.get(`${GMAIL_BASE}/messages`, ({ request }) => {
        const url = new URL(request.url);
        const pageToken = url.searchParams.get("pageToken");

        if (!pageToken) {
          page = 1;
          return HttpResponse.json({
            messages: [{ id: "msg-page1", threadId: "thread-1" }],
            nextPageToken: "token-page2",
            resultSizeEstimate: 2,
          });
        } else {
          page = 2;
          return HttpResponse.json({
            messages: [{ id: "msg-page2", threadId: "thread-2" }],
            resultSizeEstimate: 2,
          });
        }
      }),
    );

    // First page
    const r1 = await fetch(`${GMAIL_BASE}/messages?q=in:inbox`);
    const d1 = await r1.json();
    expect(d1.messages).toHaveLength(1);
    expect(d1.nextPageToken).toBe("token-page2");
    expect(page).toBe(1);

    // Second page
    const r2 = await fetch(`${GMAIL_BASE}/messages?q=in:inbox&pageToken=token-page2`);
    const d2 = await r2.json();
    expect(d2.messages).toHaveLength(1);
    expect(d2.nextPageToken).toBeUndefined();
    expect(page).toBe(2);
  });

  test("attachments.get returns base64url data", async () => {
    const attachmentData = Buffer.from("fake PDF content").toString("base64url");

    let capturedMessageId: string | readonly string[] | undefined;
    let capturedAttachmentId: string | readonly string[] | undefined;
    server.use(
      http.get(`${GMAIL_BASE}/messages/:messageId/attachments/:attachmentId`, ({ params }) => {
        capturedMessageId = params.messageId;
        capturedAttachmentId = params.attachmentId;
        return HttpResponse.json({
          size: 16,
          data: attachmentData,
        });
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/messages/msg-001/attachments/att-123`);
    const data = await response.json();
    expect(capturedMessageId).toBe("msg-001");
    expect(capturedAttachmentId).toBe("att-123");
    expect(data.data).toBe(attachmentData);
  });

  test("OAuth token refresh endpoint returns new access token", async () => {
    let capturedBody: string | undefined;
    server.use(
      http.post("https://oauth2.googleapis.com/token", async ({ request }) => {
        capturedBody = await request.text();
        return HttpResponse.json({
          access_token: "new-access-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      }),
    );

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=refresh_token&refresh_token=old-refresh-token&client_id=test&client_secret=test",
    });

    const data = await response.json();
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(data.access_token).toBe("new-access-token");
    expect(data.expires_in).toBe(3600);
  });

  test("OAuth token refresh returns invalid_grant for revoked token", async () => {
    server.use(
      http.post("https://oauth2.googleapis.com/token", () => {
        return HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Token has been expired or revoked.",
          },
          { status: 400 },
        );
      }),
    );

    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=refresh_token&refresh_token=revoked-token",
    });

    const data = await response.json();
    expect(data.error).toBe("invalid_grant");
    expect(isAuthError(new Error(data.error))).toBe(true);
  });

  test("labels.get returns message count", async () => {
    let capturedLabelId: string | readonly string[] | undefined;
    server.use(
      http.get(`${GMAIL_BASE}/labels/:labelId`, ({ params }) => {
        capturedLabelId = params.labelId;
        return HttpResponse.json({
          id: "INBOX",
          name: "INBOX",
          messagesTotal: 1234,
          messagesUnread: 56,
          type: "system",
        });
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/labels/INBOX`);
    const data = await response.json();
    expect(capturedLabelId).toBe("INBOX");
    expect(data.messagesTotal).toBe(1234);
  });

  test("drafts.create returns draft with ID", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${GMAIL_BASE}/drafts`, async ({ request }) => {
        capturedBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: "draft-001",
          message: {
            id: "msg-draft-001",
            threadId: "thread-001",
            labelIds: ["DRAFT"],
          },
        });
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/drafts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          raw: Buffer.from("test").toString("base64url"),
          threadId: "thread-001",
        },
      }),
    });

    const data = await response.json();
    expect(capturedBody).toHaveProperty("message");
    expect(data.id).toBe("draft-001");
    expect(data.message.id).toBe("msg-draft-001");
  });

  test("messages.send returns sent message with thread ID", async () => {
    server.use(
      http.post(`${GMAIL_BASE}/messages/send`, () => {
        return HttpResponse.json({
          id: "msg-sent-001",
          threadId: "thread-001",
          labelIds: ["SENT"],
        });
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/messages/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        raw: Buffer.from("test").toString("base64url"),
      }),
    });

    const data = await response.json();
    expect(data.id).toBe("msg-sent-001");
    expect(data.threadId).toBe("thread-001");
  });

  test("messages.modify for archiving removes INBOX label", async () => {
    let capturedModifyMessageId: string | readonly string[] | undefined;
    let capturedModifyBody: Record<string, unknown> | undefined;
    server.use(
      http.post(`${GMAIL_BASE}/messages/:messageId/modify`, async ({ request, params }) => {
        capturedModifyBody = (await request.json()) as Record<string, unknown>;
        capturedModifyMessageId = params.messageId;
        return HttpResponse.json({
          id: "msg-001",
          labelIds: ["UNREAD"], // INBOX removed
        });
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/messages/msg-001/modify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
    });

    const data = await response.json();
    expect(capturedModifyMessageId).toBe("msg-001");
    expect(capturedModifyBody).toEqual({
      removeLabelIds: ["INBOX"],
    });
    expect(data.labelIds).not.toContain("INBOX");
  });

  test("threads.get filters out DRAFT messages", async () => {
    const threadMessages = [
      makeGmailMessage({
        id: "msg-t1",
        threadId: "thread-001",
        from: "a@b.com",
        to: "c@d.com",
        subject: "Thread",
        body: "First message",
        labelIds: ["INBOX"],
      }),
      makeGmailMessage({
        id: "msg-t2",
        threadId: "thread-001",
        from: "c@d.com",
        to: "a@b.com",
        subject: "Re: Thread",
        body: "Reply",
        labelIds: ["SENT"],
      }),
      makeGmailMessage({
        id: "msg-t3-draft",
        threadId: "thread-001",
        from: "a@b.com",
        to: "c@d.com",
        subject: "Re: Thread",
        body: "Draft reply",
        labelIds: ["DRAFT"],
      }),
    ];

    server.use(
      http.get(`${GMAIL_BASE}/threads/:threadId`, () => {
        return HttpResponse.json({
          id: "thread-001",
          messages: threadMessages,
        });
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/threads/thread-001`);
    const data = await response.json();

    // Simulate the DRAFT filtering logic from getThread()
    const nonDraftMessages = data.messages.filter(
      (m: GmailApiMessage) => !m.labelIds?.includes("DRAFT"),
    );

    expect(nonDraftMessages).toHaveLength(2);
    expect(nonDraftMessages.every((m: GmailApiMessage) => !m.labelIds.includes("DRAFT"))).toBe(
      true,
    );

    // Verify parsing works on filtered messages
    for (const msg of nonDraftMessages) {
      const parsed = parseGmailMessage(msg);
      expect(parsed.body).toBeTruthy();
    }
  });

  test("rate limiting returns 429 with retry-after", async () => {
    server.use(
      http.get(`${GMAIL_BASE}/messages`, () => {
        return HttpResponse.json(
          {
            error: {
              code: 429,
              message: "Rate Limit Exceeded",
            },
          },
          {
            status: 429,
            headers: { "Retry-After": "5" },
          },
        );
      }),
    );

    const response = await fetch(`${GMAIL_BASE}/messages`);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("5");
  });
});

// ============================================================================
// History change deduplication logic
// ============================================================================

test.describe("History change deduplication", () => {
  // Re-implements the dedup logic from getHistoryChanges()
  function deduplicateHistoryChanges(
    newMessageIds: string[],
    deletedMessageIds: string[],
    readMessageIds: string[],
    unreadMessageIds: string[],
  ) {
    const newSet = new Set(newMessageIds);
    const deletedSet = new Set(deletedMessageIds);
    const filterHandled = (id: string) => !newSet.has(id) && !deletedSet.has(id);

    return {
      newMessageIds: [...newSet],
      deletedMessageIds: [...deletedSet],
      readMessageIds: [...new Set(readMessageIds)].filter(filterHandled),
      unreadMessageIds: [...new Set(unreadMessageIds)].filter(filterHandled),
    };
  }

  test("deduplicates new message IDs", () => {
    const result = deduplicateHistoryChanges(["msg-1", "msg-1", "msg-2"], [], [], []);
    expect(result.newMessageIds).toEqual(["msg-1", "msg-2"]);
  });

  test("deduplicates deleted message IDs", () => {
    const result = deduplicateHistoryChanges([], ["msg-1", "msg-1"], [], []);
    expect(result.deletedMessageIds).toEqual(["msg-1"]);
  });

  test("excludes read IDs that are in new or deleted sets", () => {
    const result = deduplicateHistoryChanges(
      ["msg-new"],
      ["msg-del"],
      ["msg-new", "msg-del", "msg-read"],
      [],
    );
    expect(result.readMessageIds).toEqual(["msg-read"]);
  });

  test("excludes unread IDs that are in new or deleted sets", () => {
    const result = deduplicateHistoryChanges(
      ["msg-new"],
      ["msg-del"],
      [],
      ["msg-new", "msg-del", "msg-unread"],
    );
    expect(result.unreadMessageIds).toEqual(["msg-unread"]);
  });

  test("handles all empty arrays", () => {
    const result = deduplicateHistoryChanges([], [], [], []);
    expect(result.newMessageIds).toEqual([]);
    expect(result.deletedMessageIds).toEqual([]);
    expect(result.readMessageIds).toEqual([]);
    expect(result.unreadMessageIds).toEqual([]);
  });

  test("handles complex scenario with overlapping IDs", () => {
    const result = deduplicateHistoryChanges(
      ["msg-1", "msg-2", "msg-1"],
      ["msg-3", "msg-4", "msg-3"],
      ["msg-1", "msg-3", "msg-5", "msg-5"],
      ["msg-2", "msg-4", "msg-6"],
    );

    expect(result.newMessageIds).toEqual(["msg-1", "msg-2"]);
    expect(result.deletedMessageIds).toEqual(["msg-3", "msg-4"]);
    // msg-1 excluded (in new), msg-3 excluded (in deleted), msg-5 deduped
    expect(result.readMessageIds).toEqual(["msg-5"]);
    // msg-2 excluded (in new), msg-4 excluded (in deleted)
    expect(result.unreadMessageIds).toEqual(["msg-6"]);
  });
});

// ============================================================================
// Label ID mapping tests
// ============================================================================

test.describe("Label handling", () => {
  test("INBOX and UNREAD labels are standard Gmail system labels", () => {
    const msg = makeGmailMessage({
      id: "msg-labels",
      threadId: "thread-labels",
      from: "a@b.com",
      to: "c@d.com",
      subject: "Labels test",
      body: "Test",
      labelIds: ["INBOX", "UNREAD", "IMPORTANT", "CATEGORY_PRIMARY"],
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.labelIds).toContain("INBOX");
    expect(parsed.labelIds).toContain("UNREAD");
    expect(parsed.labelIds).toContain("IMPORTANT");
    expect(parsed.labelIds).toContain("CATEGORY_PRIMARY");
  });

  test("SENT label messages are correctly identified", () => {
    const msg = makeGmailMessage({
      id: "msg-sent",
      threadId: "thread-sent",
      from: "me@example.com",
      to: "them@example.com",
      subject: "Sent message",
      body: "I sent this",
      labelIds: ["SENT"],
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.labelIds).toEqual(["SENT"]);
    expect(parsed.labelIds).not.toContain("INBOX");
  });

  test("STARRED label is preserved", () => {
    const msg = makeGmailMessage({
      id: "msg-star",
      threadId: "thread-star",
      from: "a@b.com",
      to: "c@d.com",
      subject: "Starred",
      body: "Important",
      labelIds: ["INBOX", "UNREAD", "STARRED"],
    });

    const parsed = parseGmailMessage(msg);
    expect(parsed.labelIds).toContain("STARRED");
  });

  test("empty labelIds defaults to empty array", () => {
    const msg: GmailApiMessage = {
      id: "msg-nolabels",
      threadId: "thread-x",
      labelIds: [],
      snippet: "test",
      internalDate: String(Date.now()),
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "a@b.com" },
          { name: "To", value: "c@d.com" },
          { name: "Subject", value: "No labels" },
          { name: "Date", value: "Mon, 1 Jan 2025 00:00:00 +0000" },
        ],
        body: {
          size: 4,
          data: Buffer.from("test").toString("base64url"),
        },
        parts: [],
      },
      sizeEstimate: 100,
      historyId: "1",
    };

    const parsed = parseGmailMessage(msg);
    expect(parsed.labelIds).toEqual([]);
  });
});

// ============================================================================
// Edge cases for body extraction
// ============================================================================

test.describe("Body extraction edge cases", () => {
  test("deeply nested multipart/related inside multipart/mixed", () => {
    const payload = {
      mimeType: "multipart/mixed",
      body: { size: 0 },
      parts: [
        {
          mimeType: "multipart/related",
          body: { size: 0 },
          parts: [
            {
              mimeType: "multipart/alternative",
              body: { size: 0 },
              parts: [
                {
                  mimeType: "text/plain",
                  body: {
                    data: Buffer.from("Plain deep").toString("base64url"),
                  },
                },
                {
                  mimeType: "text/html",
                  body: {
                    data: Buffer.from("<div>HTML deep</div>").toString("base64url"),
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(extractBody(payload)).toBe("<div>HTML deep</div>");
  });

  test("handles UTF-8 encoded body with emoji", () => {
    const text = "Hello 🌍 World! こんにちは 🎉";
    const payload = {
      body: { data: Buffer.from(text, "utf-8").toString("base64url") },
    };
    expect(extractBody(payload)).toBe(text);
  });

  test("handles very long body content", () => {
    const longText = "x".repeat(100_000);
    const payload = {
      body: {
        data: Buffer.from(longText).toString("base64url"),
      },
    };
    expect(extractBody(payload)).toBe(longText);
    expect(extractBody(payload)).toHaveLength(100_000);
  });

  test("handles HTML entities in body", () => {
    const html = "<p>Price: $100 &amp; tax &lt;10%&gt;</p>";
    const payload = {
      body: { data: Buffer.from(html).toString("base64url") },
    };
    expect(extractBody(payload)).toBe(html);
  });
});

// ============================================================================
// Fixture helper tests
// ============================================================================

test.describe("makeGmailMessage fixture helper", () => {
  test("creates message with default date", () => {
    const msg = makeGmailMessage({
      id: "test-id",
      threadId: "test-thread",
      from: "sender@test.com",
      to: "recipient@test.com",
      subject: "Test Subject",
      body: "<p>Test body</p>",
    });

    expect(msg.id).toBe("test-id");
    expect(msg.threadId).toBe("test-thread");
    expect(msg.payload.headers).toHaveLength(5); // From, To, Subject, Date, Message-ID
    expect(msg.labelIds).toEqual(["INBOX", "UNREAD"]);
  });

  test("creates message with custom labels and CC", () => {
    const msg = makeGmailMessage({
      id: "test-cc",
      threadId: "thread-cc",
      from: "a@b.com",
      to: "c@d.com",
      subject: "CC test",
      body: "body",
      cc: "e@f.com",
      labelIds: ["SENT"],
    });

    expect(msg.payload.headers).toHaveLength(6); // +CC
    expect(msg.labelIds).toEqual(["SENT"]);
  });

  test("encodes body as base64url", () => {
    const body = "<div>Encoded body</div>";
    const msg = makeGmailMessage({
      id: "encode-test",
      threadId: "thread",
      from: "a@b.com",
      to: "c@d.com",
      subject: "Encode",
      body,
    });

    const decoded = Buffer.from(msg.payload.body.data!, "base64url").toString("utf-8");
    expect(decoded).toBe(body);
  });
});
