/** Convert a draft body (plain text from Claude) to HTML for the TipTap editor.
 *  Strips all HTML tags first (Claude sometimes outputs stray tags),
 *  converts **bold** / *italic* markers to <strong> / <em>, then converts
 *  plain text to paragraphs, detecting bullet/numbered lists. */
export function draftBodyToHtml(body: string): string {
  // Strip ALL HTML tags — Claude's raw output is treated as plain text.
  // Convert known inline tags to markers first so we can restore them.
  let text = body
    .replace(/<(b|strong)>(.*?)<\/\1>/gi, "**$2**")
    .replace(/<(i|em)>(.*?)<\/\1>/gi, "*$2*");
  // Strip any remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode HTML entities left over from stripped HTML before re-escaping
  text = text
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
  // Escape so literal < > & in text don't break output HTML
  text = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Convert markers back to HTML after stripping
  // (done per-line below so they end up inside <p>/<li> wrappers)
  function restoreMarkers(s: string): string {
    return s
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^\s*](?:.*?[^\s*])?)\*/g, "<em>$1</em>");
  }

  // Split into blocks separated by double newlines
  const blocks = text.split(/\n{2,}/);

  return blocks
    .map((block) => {
      const lines = block.split("\n");

      // Detect bullet list: all lines start with "- " or "• "
      if (lines.length > 0 && lines.every((l) => /^[-•]\s/.test(l.trim()))) {
        const items = lines.map(
          (l) => `<li>${restoreMarkers(l.trim().replace(/^[-•]\s+/, ""))}</li>`,
        );
        return `<ul>${items.join("")}</ul>`;
      }

      // Detect numbered list: all lines start with "N. " or "N) "
      if (lines.length > 0 && lines.every((l) => /^\d+[.)]\s/.test(l.trim()))) {
        const items = lines.map(
          (l) => `<li>${restoreMarkers(l.trim().replace(/^\d+[.)]\s+/, ""))}</li>`,
        );
        return `<ol>${items.join("")}</ol>`;
      }

      // Regular paragraph: single newlines become <br>
      return `<p>${restoreMarkers(block.replace(/\n/g, "<br>"))}</p>`;
    })
    .join("");
}
