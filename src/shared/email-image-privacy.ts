const TRACKING_PIXEL_MAX_SIZE = 4;
const DEFAULT_PLACEHOLDER_WIDTH = 320;
const DEFAULT_PLACEHOLDER_HEIGHT = 72;
const MAX_PLACEHOLDER_WIDTH = 640;
const MAX_PLACEHOLDER_HEIGHT = 240;

function extractNumericAttribute(tag: string, attr: "width" | "height"): number | null {
  const attrMatch = tag.match(new RegExp(`\\b${attr}\\s*=\\s*["']?(\\d+)(?:px)?["']?`, "i"));
  if (attrMatch) return Number(attrMatch[1]);

  const styleMatch = tag.match(/\bstyle\s*=\s*["']([^"']+)["']/i);
  if (!styleMatch) return null;

  const styleValue = styleMatch[1];
  const cssMatch = styleValue.match(new RegExp(`${attr}\\s*:\\s*(\\d+)(?:px)?`, "i"));
  return cssMatch ? Number(cssMatch[1]) : null;
}

function clampDimension(value: number | null, fallback: number, max: number): number {
  if (!value || Number.isNaN(value) || value <= 0) return fallback;
  return Math.min(value, max);
}

function isLikelyTrackingPixel(tag: string): boolean {
  const width = extractNumericAttribute(tag, "width");
  const height = extractNumericAttribute(tag, "height");
  return (
    width !== null &&
    height !== null &&
    width <= TRACKING_PIXEL_MAX_SIZE &&
    height <= TRACKING_PIXEL_MAX_SIZE
  );
}

function buildPrivacyPlaceholderDataUri(
  width: number,
  height: number,
  useLightMode: boolean,
): string {
  const fill = useLightMode ? "#f9fafb" : "#1f2937";
  const stroke = useLightMode ? "#d1d5db" : "#4b5563";
  const text = useLightMode ? "#6b7280" : "#9ca3af";
  const safeWidth = Math.max(width, 160);
  const safeHeight = Math.max(height, 48);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${safeWidth}" height="${safeHeight}" viewBox="0 0 ${safeWidth} ${safeHeight}">` +
    `<rect width="${safeWidth}" height="${safeHeight}" rx="8" fill="${fill}" stroke="${stroke}"/>` +
    `<text x="${safeWidth / 2}" y="${Math.round(safeHeight / 2) + 5}" text-anchor="middle" fill="${text}" font-family="system-ui" font-size="13">` +
    `Remote image blocked for privacy` +
    `</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Replace remote <img src="https://..."> loads with a local placeholder.
 * Tiny tracking pixels are removed outright.
 */
export function replaceRemoteImageSources(html: string, useLightMode: boolean): string {
  if (!html.includes("<img")) return html;

  return html.replace(
    /<img\b[^>]*\bsrc\s*=\s*(["'])(https?:\/\/[^"']+)\1[^>]*>/gi,
    (fullTag: string) => {
      if (isLikelyTrackingPixel(fullTag)) {
        return "";
      }

      const width = clampDimension(
        extractNumericAttribute(fullTag, "width"),
        DEFAULT_PLACEHOLDER_WIDTH,
        MAX_PLACEHOLDER_WIDTH,
      );
      const height = clampDimension(
        extractNumericAttribute(fullTag, "height"),
        DEFAULT_PLACEHOLDER_HEIGHT,
        MAX_PLACEHOLDER_HEIGHT,
      );
      const placeholderSrc = buildPrivacyPlaceholderDataUri(width, height, useLightMode);

      let replaced = fullTag.replace(
        /(\bsrc\s*=\s*["'])https?:\/\/[^"']+(["'])/i,
        `$1${placeholderSrc}$2`,
      );
      replaced = replaced.replace(/\s+\bsrcset\s*=\s*(["'])[^"']*\1/i, "");

      const missingAttrs: string[] = [];
      if (!/\balt\s*=/.test(replaced)) {
        missingAttrs.push('alt="Remote image blocked for privacy"');
      }
      if (!/\btitle\s*=/.test(replaced)) {
        missingAttrs.push('title="Remote image blocked for privacy"');
      }
      if (missingAttrs.length > 0) {
        replaced = replaced.replace(/<img\b/i, `<img ${missingAttrs.join(" ")}`);
      }

      return replaced;
    },
  );
}
