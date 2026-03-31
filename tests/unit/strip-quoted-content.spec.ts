/**
 * Unit tests for strip-quoted-content.ts — regex-based quote stripping
 * used by the email analyzer and archive-ready analyzer.
 */
import { test, expect } from "@playwright/test";
import { stripQuotedContent } from "../../src/main/services/strip-quoted-content";

// ============================================================
// Plain text: "On ... wrote:" attribution
// ============================================================

test.describe("plain text — On ... wrote:", () => {
  test("strips single-line attribution and quoted text", () => {
    const input = `Thanks, I'll review it.

On Mon, Jan 6, 2025 at 3:45 PM Bob <bob@example.com> wrote:
> Could you review the Q1 budget proposal?`;

    expect(stripQuotedContent(input)).toBe("Thanks, I'll review it.");
  });

  test("strips multi-line attribution (Gmail wraps long names)", () => {
    const input = `Sounds good.

On Monday, January 1, 2024 at 10:00:00 AM UTC,
John Doe <john@example.com> wrote:
> What do you think?`;

    expect(stripQuotedContent(input)).toBe("Sounds good.");
  });

  test("keeps attribution but strips > lines when attribution is first line", () => {
    const input = `On Mon, Jan 6, 2025 at 3:45 PM Bob <bob@example.com> wrote:
> Some quoted text`;

    // Attribution line stays (no content above it to return), but > lines
    // after it are stripped since the attribution is non-quoted content above them
    expect(stripQuotedContent(input)).toBe(
      "On Mon, Jan 6, 2025 at 3:45 PM Bob <bob@example.com> wrote:",
    );
  });
});

// ============================================================
// Plain text: Forwarded message
// ============================================================

test.describe("plain text — forwarded messages", () => {
  test("strips forwarded message marker and content below", () => {
    const input = `FYI — see below.

---------- Forwarded message ----------
From: vendor@supply.co
Subject: Invoice`;

    expect(stripQuotedContent(input)).toBe("FYI — see below.");
  });
});

// ============================================================
// Plain text: > quoted lines
// ============================================================

test.describe("plain text — > quoted lines", () => {
  test("strips > quoted block", () => {
    const input = `Sounds good, let's go with option B.

> What do you think about the two options?
> Option A: Keep current vendor
> Option B: Switch to new vendor`;

    expect(stripQuotedContent(input)).toBe("Sounds good, let's go with option B.");
  });

  test("returns original when entire email is > quoted", () => {
    const input = `> Some quoted text
> More quoted text`;

    // All lines are > quoted — nothing to strip, return original
    expect(stripQuotedContent(input)).toBe(input);
  });
});

// ============================================================
// HTML: Gmail quote
// ============================================================

test.describe("HTML — Gmail .gmail_quote", () => {
  test("strips gmail_quote div and everything after", () => {
    const input = `<div>Sure, 3pm works.</div>
<div class="gmail_quote"><div>On Tue wrote:</div><blockquote>Are you free?</blockquote></div>`;

    expect(stripQuotedContent(input)).toBe("<div>Sure, 3pm works.</div>");
  });

  test("strips gmail_extra div", () => {
    const input = `<div>Got it, thanks.</div><div class="gmail_extra"><br><div>Previous content</div></div>`;

    expect(stripQuotedContent(input)).toBe("<div>Got it, thanks.</div>");
  });
});

// ============================================================
// HTML: Outlook
// ============================================================

test.describe("HTML — Outlook #divRplyFwdMsg", () => {
  test("strips Outlook reply marker", () => {
    const input = `<div>Approved.</div><hr><div id="divRplyFwdMsg"><b>From:</b> DevOps</div>`;

    expect(stripQuotedContent(input)).toBe("<div>Approved.</div><hr>");
  });

  test("strips #appendonsend marker", () => {
    const input = `<div>Will do.</div><div id="appendonsend"><hr><div>Original message</div></div>`;

    expect(stripQuotedContent(input)).toBe("<div>Will do.</div>");
  });
});

// ============================================================
// HTML: Yahoo
// ============================================================

test.describe("HTML — Yahoo .yahoo_quoted", () => {
  test("strips yahoo_quoted div", () => {
    const input = `<div>Thanks for the info.</div><div class="yahoo_quoted"><div>Previous message</div></div>`;

    expect(stripQuotedContent(input)).toBe("<div>Thanks for the info.</div>");
  });
});

// ============================================================
// HTML: Apple Mail / Thunderbird blockquote[type=cite]
// ============================================================

test.describe("HTML — blockquote[type=cite]", () => {
  test("strips Apple Mail blockquote", () => {
    const input = `<div>That works for me.</div><br><blockquote type="cite"><div>Proposed March 15th launch</div></blockquote>`;

    expect(stripQuotedContent(input)).toBe("<div>That works for me.</div><br>");
  });
});

// ============================================================
// HTML: "On ... wrote:" fallback (anchored)
// ============================================================

test.describe("HTML — On ... wrote: fallback", () => {
  test("strips 'On ... wrote:' after a <br> tag", () => {
    const input = `<div>Looks good to me.</div><br>On Mon, Jan 6 Bob wrote:<br>> question`;

    // Trailing <br> before the "On" is kept (cut point is at "On")
    expect(stripQuotedContent(input)).toBe("<div>Looks good to me.</div><br>");
  });

  test("strips lowercase 'on ... wrote:' (case-insensitive match)", () => {
    const input = `<div>Looks good.</div><br>on Mon, Jan 6 Bob wrote:<br>> question`;

    expect(stripQuotedContent(input)).toBe("<div>Looks good.</div><br>");
  });

  test("does NOT false-positive on mid-sentence 'wrote:'", () => {
    const input = `<div>On this point, several engineers wrote: the API needs updating.</div>`;

    // Should not strip — "On" is mid-sentence, not after a line break
    expect(stripQuotedContent(input)).toBe(input);
  });
});

// ============================================================
// HTML: Forwarded message fallback
// ============================================================

test.describe("HTML — forwarded message marker", () => {
  test("strips forwarded message in HTML", () => {
    const input = `<div>See below</div><br>---------- Forwarded message ----------<br>From: someone`;

    expect(stripQuotedContent(input)).toBe("<div>See below</div><br>");
  });
});

// ============================================================
// Safety: returnIfHasContent guard
// ============================================================

test.describe("safety — returnIfHasContent", () => {
  test("returns original HTML when stripping would remove all visible text", () => {
    // The gmail_quote is the entire body — stripping leaves nothing visible
    const input = `<div class="gmail_quote"><div>This is the only content</div></div>`;

    expect(stripQuotedContent(input)).toBe(input);
  });

  test("plain text with attribution + only quoted lines strips the quoted lines", () => {
    const input = `On Mon wrote:
> everything is quoted`;

    // The attribution is non-quoted content, so > lines below it are stripped
    expect(stripQuotedContent(input)).toBe("On Mon wrote:");
  });
});

// ============================================================
// Passthrough: no quoted content
// ============================================================

test.describe("passthrough — no quoted content", () => {
  test("plain text without quotes returns unchanged", () => {
    const input = "Just a simple email with no quoted content.";
    expect(stripQuotedContent(input)).toBe(input);
  });

  test("HTML without quotes returns unchanged", () => {
    const input = "<div>A simple HTML email with no quoted content.</div>";
    expect(stripQuotedContent(input)).toBe(input);
  });

  test("empty string returns empty", () => {
    expect(stripQuotedContent("")).toBe("");
  });
});

// ============================================================
// isHtml detection
// ============================================================

test.describe("isHtml detection", () => {
  test("plain text with angle-bracket email address is treated as plain text", () => {
    // Should NOT be classified as HTML — <alice@example.com> is not an HTML tag
    const input = `Thanks for the update.

On Mon, Jan 6, Bob <bob@example.com> wrote:
> question here`;

    // Should strip via plain-text path (not HTML path)
    expect(stripQuotedContent(input)).toBe("Thanks for the update.");
  });

  test("plain text with <team> is treated as plain text", () => {
    const input = `The <team> is ready.

> Previous message`;

    expect(stripQuotedContent(input)).toBe("The <team> is ready.");
  });
});

// ============================================================
// Media stripping — images, video, audio, base64 data URIs
// ============================================================

test.describe("media stripping", () => {
  test("strips <img> tags from HTML", () => {
    const input = `<div>Check out this photo:</div><img src="cid:image001.png" width="500"><div>What do you think?</div>`;
    expect(stripQuotedContent(input)).toBe(
      `<div>Check out this photo:</div><div>What do you think?</div>`,
    );
  });

  test("strips tracking pixels (1x1 images)", () => {
    const input = `<div>Hello</div><img src="https://tracker.example.com/open.gif" width="1" height="1">`;
    expect(stripQuotedContent(input)).toBe("<div>Hello</div>");
  });

  test("strips <video> tags", () => {
    const input = `<div>Watch this:</div><video src="video.mp4" controls>fallback</video><div>Cool right?</div>`;
    expect(stripQuotedContent(input)).toBe("<div>Watch this:</div><div>Cool right?</div>");
  });

  test("strips <audio> tags", () => {
    const input = `<div>Listen:</div><audio src="clip.mp3" controls>fallback</audio><div>Thoughts?</div>`;
    expect(stripQuotedContent(input)).toBe("<div>Listen:</div><div>Thoughts?</div>");
  });

  test("replaces base64 data URIs with placeholder", () => {
    const input = `<div>See image: data:image/png;base64,iVBORw0KGgoAAAANSUhEUg== embedded here</div>`;
    expect(stripQuotedContent(input)).toBe("<div>See image: [media removed] embedded here</div>");
  });

  test("strips multiple images at once", () => {
    const input = `<div>Photos:</div><img src="a.jpg"><img src="b.png"><div>Done</div>`;
    expect(stripQuotedContent(input)).toBe("<div>Photos:</div><div>Done</div>");
  });
});
