/**
 * Strips quoted/forwarded email content from an email body.
 * Works in Node.js (no DOM APIs required) — uses regex-based detection.
 *
 * Used to reduce token usage when sending emails to Claude for analysis.
 * Quoted content from previous messages in a thread is redundant when
 * the analyzer already has the thread history or only needs the latest message.
 */

function isHtml(body: string): boolean {
  return /<(div|span|p|br|html|body|table|tr|td|a|img|ul|ol|li|h[1-6]|blockquote|style|head|meta|link)(\s|>|\/)/i.test(
    body,
  );
}

export function stripQuotedContent(body: string): string {
  if (!body) return body;
  const stripped = isHtml(body) ? stripHtmlQuoted(body) : stripPlainTextQuoted(body);
  return stripMediaContent(stripped);
}

// ---------------------------------------------------------------------------
// Media stripping — remove images, videos, audio that waste analysis tokens
// ---------------------------------------------------------------------------

function stripMediaContent(body: string): string {
  return (
    body
      // <img> tags (inline images, tracking pixels, CID-embedded images)
      .replace(/<img\s[^>]*>/gi, "")
      // <video>...</video> and <audio>...</audio>
      .replace(/<video\s[^>]*>[\s\S]*?<\/video>/gi, "")
      .replace(/<audio\s[^>]*>[\s\S]*?<\/audio>/gi, "")
      // Base64 data URIs that may appear in src attributes or plain text
      .replace(/data:(image|video|audio)\/[^;]+;base64,[A-Za-z0-9+/=]+/g, "[media removed]")
  );
}

// ---------------------------------------------------------------------------
// HTML quote stripping (regex-based, no DOM)
// ---------------------------------------------------------------------------

function stripHtmlQuoted(html: string): string {
  // Find the earliest occurrence of a known quoted-content wrapper
  // and truncate everything from that point onward.
  const quotePatterns = [
    /<div\s[^>]*class\s*=\s*["'][^"']*gmail_quote[^"']*["'][^>]*>/i,
    /<div\s[^>]*class\s*=\s*["'][^"']*gmail_extra[^"']*["'][^>]*>/i,
    /<div\s[^>]*id\s*=\s*["']divRplyFwdMsg["'][^>]*>/i,
    /<div\s[^>]*id\s*=\s*["']appendonsend["'][^>]*>/i,
    /<div\s[^>]*class\s*=\s*["'][^"']*yahoo_quoted[^"']*["'][^>]*>/i,
    /<blockquote\s[^>]*type\s*=\s*["']cite["'][^>]*>/i,
  ];

  let cutIndex = html.length;
  for (const pattern of quotePatterns) {
    const match = pattern.exec(html);
    if (match && match.index < cutIndex) {
      cutIndex = match.index;
    }
  }

  if (cutIndex < html.length) {
    return returnIfHasContent(html, cutIndex) ?? html;
  }

  // Fallback: forwarded message marker in HTML text
  const fwdMatch = /-{3,}\s*Forwarded message\s*-{3,}/.exec(html);
  if (fwdMatch) {
    const result = returnIfHasContent(html, fwdMatch.index);
    if (result) return result;
  }

  // Fallback: "On ... wrote:" pattern (common in HTML replies without a class marker).
  // Anchored to a line boundary (start of string, or after <br>/<div>/<p>) to avoid
  // matching mid-sentence occurrences like "On this point, engineers wrote:".
  const wroteMatch = /(?:^|<br\s*\/?>|<\/div>|<\/p>)\s*On\s.+?\swrote:\s*(<br\s*\/?>|\n|$)/i.exec(
    html,
  );
  if (wroteMatch) {
    // Cut at the "On" itself, not the preceding tag
    const onIndex = html.toLowerCase().indexOf("on", wroteMatch.index);
    const result = returnIfHasContent(html, onIndex);
    if (result) return result;
  }

  return html;
}

/** Truncate html at `index` and return it only if visible text remains. */
function returnIfHasContent(html: string, index: number): string | null {
  const trimmed = html.substring(0, index).trim();
  // Check that stripping didn't remove all visible text
  const visibleText = trimmed
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, "")
    .trim();
  return visibleText ? trimmed : null;
}

// ---------------------------------------------------------------------------
// Plain-text quote stripping
// ---------------------------------------------------------------------------

function stripPlainTextQuoted(text: string): string {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // "On ... wrote:" attribution line (may span two lines when Gmail/Outlook
    // wraps long names or dates)
    if (/^On\s/.test(line)) {
      const singleLine = /^On\s.+?\swrote:\s*$/.test(line);
      const nextLine = lines[i + 1]?.trim() ?? "";
      const twoLine = !singleLine && /\swrote:\s*$/.test(nextLine);
      if (singleLine || twoLine) {
        const above = lines.slice(0, i).join("\n").trimEnd();
        if (above) return above;
      }
    }

    // Forwarded message marker
    if (/^-{3,}\s*Forwarded message\s*-{3,}$/.test(line)) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) return above;
    }

    // Block of ">" quoted lines — only strip if there's non-quoted content above
    if (line.startsWith(">")) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above && !above.split("\n").every((l) => l.trim().startsWith(">"))) {
        return above;
      }
    }
  }

  return text;
}
