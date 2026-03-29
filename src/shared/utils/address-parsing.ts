/**
 * RFC 2822-aware address list splitter.
 * Splits a comma-separated list of email addresses while respecting
 * quoted strings, angle brackets, and RFC 2822 comments.
 *
 * e.g. `"Cronin, Brian" <brian@ex.com>, Jane <jane@ex.com>`
 *   → [`"Cronin, Brian" <brian@ex.com>`, `Jane <jane@ex.com>`]
 */
export function splitAddressList(header: string): string[] {
  let inQuote = false;
  let angleBracketDepth = 0;
  let commentDepth = 0;
  let current = "";
  const result: string[] = [];

  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    // Count consecutive preceding backslashes — odd count means this char is escaped
    let backslashes = 0;
    for (let j = i - 1; j >= 0 && header[j] === "\\"; j--) backslashes++;
    const escaped = backslashes % 2 === 1;
    if (ch === '"' && !escaped && commentDepth === 0) {
      inQuote = !inQuote;
      current += ch;
    } else if (!inQuote && ch === "(" && !escaped) {
      commentDepth++;
      current += ch;
    } else if (!inQuote && ch === ")" && !escaped && commentDepth > 0) {
      commentDepth--;
      current += ch;
    } else if (!inQuote && commentDepth === 0 && ch === "<") {
      angleBracketDepth++;
      current += ch;
    } else if (!inQuote && commentDepth === 0 && ch === ">" && angleBracketDepth > 0) {
      angleBracketDepth--;
      current += ch;
    } else if (!inQuote && angleBracketDepth === 0 && commentDepth === 0 && ch === ",") {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) result.push(current.trim());
  return result;
}
