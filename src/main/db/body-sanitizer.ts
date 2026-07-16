/**
 * Strip oversized inline `data:` URIs from email HTML bodies.
 *
 * Prod forensics (July 2026) found 1.54GB of the 1.6GB emails table was
 * base64 image payloads inlined into body HTML (avg 106KB/row, max 29MB) —
 * the renderer strips them before display anyway, so storing them only
 * bloats every synchronous main-process query into a beach ball. Bodies are
 * therefore stripped once at the write boundary (saveEmail + migration 8)
 * instead of on every read.
 *
 * This module must stay dependency-free (no electron, no data-dir): it is
 * imported by db/migrations.ts, which runs in non-Electron test contexts —
 * see the header comment in migrations.ts.
 */

/** Data URIs at or above this length (chars) are replaced with a placeholder. */
export const DATA_URI_STRIP_THRESHOLD = 50_000;

/**
 * A small SVG data URI shown in place of a stripped inline image.
 * Theme-neutral colors: the main process doesn't know the renderer's theme,
 * so use mid-tone grays that are legible on both light and dark backgrounds.
 */
export function inlineImagePlaceholder(mime: string, dataUriLength: number): string {
  const sizeKB = Math.round((dataUriLength * 3) / 4 / 1024);
  const sizeLabel = sizeKB >= 1024 ? `${(sizeKB / 1024).toFixed(1)} MB` : `${sizeKB} KB`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="60">` +
    `<rect width="400" height="60" rx="8" fill="#d1d5db"/>` +
    `<text x="200" y="35" text-anchor="middle" fill="#4b5563" font-family="system-ui" font-size="13">` +
    `Inline ${mime} (${sizeLabel}) — too large to display inline` +
    `</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Replace inline `<img src="data:...">` URIs larger than
 * DATA_URI_STRIP_THRESHOLD with a placeholder SVG. Smaller data URIs
 * (signatures, logos) are preserved and still display.
 */
export function stripLargeDataUris(body: string): string {
  if (!body || !body.includes("data:")) return body;
  // If the body is under the threshold total, no substring can exceed it
  if (body.length < DATA_URI_STRIP_THRESHOLD) return body;

  return body.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*["'])(data:[^"']+)(["'][^>]*>)/gi,
    (match, before: string, dataUri: string, after: string) => {
      if (dataUri.length < DATA_URI_STRIP_THRESHOLD) return match;
      const mimeMatch = dataUri.match(/^data:([^;,]+)/);
      const mime = mimeMatch?.[1] ?? "image";
      return `${before}${inlineImagePlaceholder(mime, dataUri.length)}${after}`;
    },
  );
}
