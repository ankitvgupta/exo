// Test the sanitization function with actual email data

function decodeHtmlEntities(text) {
  const entities = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&apos;": "'",
    "&nbsp;": " ",
    "&ndash;": "–",
    "&mdash;": "—",
    "&copy;": "©",
    "&reg;": "®",
    "&trade;": "™",
  };

  let decoded = text;

  // Decode named entities
  for (const [entity, char] of Object.entries(entities)) {
    decoded = decoded.replace(new RegExp(entity, "gi"), char);
  }

  // Decode numeric entities (&#39; &#x27; etc)
  decoded = decoded.replace(/&#(\d+);/g, (_, num) => String.fromCharCode(parseInt(num, 10)));
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

function sanitizeEmailBody(body) {
  let cleaned = body;

  // Decode HTML entities first
  cleaned = decodeHtmlEntities(cleaned);

  // Remove HTML comments
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, "");

  // Remove markdown images: ![alt text](url) or ![](url)
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]+\)/g, "[image]");

  // Remove standalone URLs that look like images (on their own line)
  cleaned = cleaned.replace(/^\s*https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp|svg)[^\s]*\s*$/gim, "[image]");

  // Remove long googleusercontent URLs that are clearly images
  cleaned = cleaned.replace(/https?:\/\/lh\d\.googleusercontent\.com\/[^\s]+/g, "[image]");

  // Clean up long tracking/click URLs (over 60 chars) - replace with [link]
  cleaned = cleaned.replace(/https?:\/\/[^\s]{60,}/g, "[link]");

  // Clean up multiple consecutive [image] or [link] tags
  cleaned = cleaned.replace(/(\[image\]\s*)+/g, "[image]\n");
  cleaned = cleaned.replace(/(\[link\]\s*)+/g, "[link]\n");

  // Remove lines that are just URLs in parentheses
  cleaned = cleaned.replace(/^\s*\(\s*https?:\/\/[^\s]+\s*\)\s*$/gm, "");

  // Clean up "View → [link]" type patterns to just "View"
  cleaned = cleaned.replace(/^(\s*\w+\s*→?\s*)\[link\]\s*$/gm, "$1");

  // Remove markdown bold/italic markers: **text** or *text* or __text__ or _text_
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, "$1");
  cleaned = cleaned.replace(/\*([^*]+)\*/g, "$1");
  cleaned = cleaned.replace(/__([^_]+)__/g, "$1");
  cleaned = cleaned.replace(/_([^_]+)_/g, "$1");

  // Remove leading ** or * markers (incomplete markdown)
  cleaned = cleaned.replace(/^\s*\*\*\s*/gm, "");
  cleaned = cleaned.replace(/^\s*\*\s+/gm, "");

  // Clean up excessive blank lines (more than 2 in a row)
  cleaned = cleaned.replace(/\n{3,}/g, "\n\n");

  // Trim whitespace
  cleaned = cleaned.trim();

  return cleaned;
}

// Actual email body from database
const emailBody = `Dr. Lucy Nam and Mr. Ankit Gupta:

Save the Date for Laura &amp; Sahir&#39;s Wedding!
===============================

  View →
    https://links.paperlesspost.com/ls/click?upn=u001.fp1Y-2B-2B6EsH5Pp5ZB1HM8Q9NOaIRTPFTb2Sy8VZ2FuNM9R7KKRkImDCj8wPpa8MCIKfonrqOebO13hmQkBmwYQVJvjNckXRb-2BM8Stlcp5ntNITBfvAOGK6m1kULnCdw34OcNaWUuoUH-2Fg3nVLifY3qvrDqCcJa0x2MIIbcUgQsqX-2Fgvlx5K2f1WS-2Boxza-2B7Vvy9FaeG1e1Jnhtvwza4G1FBejVoH2kcT2rXqinXUySYogW83QvzdjR3PzW5U5zTcbj25ki3cL2ds7jeYcLB0aFxoL5pDzEFdAwBJQAl4ed

  Hosted by Laura Mead &amp; Sahir Raoof



** Reply To Host
-------------------------------
Not sure if you can make it?
Message host → https://links.paperlesspost.com/ls/click?upn=very-long-url-here

** When
-------------------------------

  Sat. Jul. 11

  4:00pm EDT


** Where
-------------------------------


  The Mansion at Woodside

  225 Muttontown Eastwoods Rd

  Syosset, NY 11791`;

console.log("=== SANITIZED OUTPUT ===\n");
console.log(sanitizeEmailBody(emailBody));
console.log("\n=== END ===");
