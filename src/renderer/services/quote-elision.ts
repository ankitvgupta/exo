import { isHtmlContent } from "./email-body-cache";

/**
 * Splits an email body into new content and quoted/forwarded content.
 *
 * Returns the new (top) portion of the email with trailing quoted text removed,
 * and a flag indicating whether quoted content was found and stripped.
 *
 * Used in thread view to avoid showing redundant quoted text — the previous
 * messages are already visible above in the thread.
 */
export function splitQuotedContent(body: string): {
  newContent: string;
  hasQuotedContent: boolean;
} {
  if (!body) return { newContent: body, hasQuotedContent: false };

  if (isHtmlContent(body)) {
    return splitHtmlQuoted(body);
  }
  return splitPlainTextQuoted(body);
}

// ---------------------------------------------------------------------------
// HTML quote detection
// ---------------------------------------------------------------------------

function splitHtmlQuoted(html: string): {
  newContent: string;
  hasQuotedContent: boolean;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");

  // Selectors for known quoted-content wrappers, most specific first.
  const quoteSelectors = [
    ".gmail_quote", // Gmail
    ".gmail_extra", // Older Gmail
    "#divRplyFwdMsg", // Outlook
    "#appendonsend", // Outlook (newer)
    ".yahoo_quoted", // Yahoo Mail
    'blockquote[type="cite"]', // Apple Mail / Thunderbird
  ];

  let found = false;

  for (const selector of quoteSelectors) {
    const el = doc.body.querySelector(selector);
    if (!el) continue;

    // Walk up to the direct child of <body> that contains the match.
    let target: Element = el;
    while (target.parentElement && target.parentElement !== doc.body) {
      target = target.parentElement;
    }

    // Remove the target and all following siblings (quoted content is at the end).
    removeNodeAndFollowing(target);
    found = true;
    break;
  }

  // Fallback: detect "---------- Forwarded message" in text nodes.
  if (!found) {
    found = removeByTextPattern(
      doc,
      /^-{3,}\s*Forwarded message\s*-{3,}/,
    );
  }

  // Fallback: detect "On ... wrote:" attribution lines without a class marker.
  if (!found) {
    found = removeByTextPattern(doc, /^On\s.+?\swrote:\s*$/);
  }

  if (!found) return { newContent: html, hasQuotedContent: false };

  cleanTrailingWhitespace(doc.body);
  // Preserve <style> tags that the HTML5 parser moved into <head> — without
  // them, newsletters and styled emails would lose their CSS in the trimmed view.
  const headStyles = Array.from(doc.querySelectorAll("head style")).map(s => s.outerHTML).join("");
  const newContent = (headStyles + doc.body.innerHTML).trim();

  // If stripping removed all visible content, show the full body instead.
  // Strip <style> blocks first — their CSS text is not visible content.
  if (!newContent || !newContent.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, "").trim()) {
    return { newContent: html, hasQuotedContent: false };
  }

  return { newContent, hasQuotedContent: true };
}

/** Remove `node` and every sibling that follows it. */
function removeNodeAndFollowing(node: ChildNode): void {
  const toRemove: ChildNode[] = [];
  let current: ChildNode | null = node;
  while (current) {
    toRemove.push(current);
    current = current.nextSibling;
  }
  for (const n of toRemove) n.remove();
}

/**
 * Walk text nodes in `doc.body`, find the first whose trimmed text matches
 * `pattern`, then remove that node's top-level ancestor (direct child of body)
 * and everything after it.
 */
function removeByTextPattern(doc: Document, pattern: RegExp): boolean {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const text = textNode.textContent?.trim() || "";
    // Skip unreasonably long text nodes — genuine attribution lines are short,
    // and regex backtracking on huge strings could stall the UI thread.
    if (text.length > 1000) continue;
    if (!pattern.test(text)) continue;

    // Walk up from the text node itself (not its parent) to find the direct
    // child of <body>. Starting from parentElement would break when the text
    // node is a direct child of <body> — the loop would walk past doc.body
    // up to doc.documentElement, and .remove() would crash on the Document.
    let target: Node = textNode;
    while (target.parentNode && target.parentNode !== doc.body) {
      target = target.parentNode;
    }
    removeNodeAndFollowing(target as ChildNode);
    return true;
  }
  return false;
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

/** Strip trailing <br>, empty whitespace text nodes, and empty container elements. */
function cleanTrailingWhitespace(el: Element): void {
  let last = el.lastChild;
  while (last) {
    if (last.nodeType === Node.TEXT_NODE && !last.textContent?.trim()) {
      const prev = last.previousSibling;
      last.remove();
      last = prev;
    } else if (isElement(last)) {
      if (last.tagName === "BR") {
        const prev = last.previousSibling;
        last.remove();
        last = prev;
      } else if (
        !last.textContent?.trim() &&
        !last.querySelector("img")
      ) {
        const prev = last.previousSibling;
        last.remove();
        last = prev;
      } else {
        break;
      }
    } else {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Plain-text quote detection
// ---------------------------------------------------------------------------

function splitPlainTextQuoted(text: string): {
  newContent: string;
  hasQuotedContent: boolean;
} {
  const lines = text.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // "On ... wrote:" attribution line
    if (/^On\s.+?\swrote:\s*$/.test(line)) {
      const newContent = lines.slice(0, i).join("\n").trimEnd();
      if (newContent) {
        return { newContent, hasQuotedContent: true };
      }
    }

    // Forwarded message marker
    if (/^-{3,}\s*Forwarded message\s*-{3,}$/.test(line)) {
      const newContent = lines.slice(0, i).join("\n").trimEnd();
      if (newContent) {
        return { newContent, hasQuotedContent: true };
      }
    }

    // Block of ">" quoted lines — only split if there's real content above.
    if (line.startsWith(">")) {
      const above = lines.slice(0, i).join("\n").trimEnd();
      if (above) {
        return { newContent: above, hasQuotedContent: true };
      }
    }
  }

  return { newContent: text, hasQuotedContent: false };
}
