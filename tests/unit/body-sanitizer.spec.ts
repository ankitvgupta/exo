/**
 * Unit tests for db/body-sanitizer.ts — the write-boundary strip of oversized
 * inline data: URIs from email bodies (see migration 8 for the prod numbers
 * that motivated it).
 */
import { test, expect } from "@playwright/test";
import {
  stripLargeDataUris,
  inlineImagePlaceholder,
  DATA_URI_STRIP_THRESHOLD,
} from "../../src/main/db/body-sanitizer";

function dataUriOfLength(totalLength: number): string {
  const prefix = "data:image/png;base64,";
  return prefix + "A".repeat(totalLength - prefix.length);
}

test.describe("stripLargeDataUris", () => {
  test("replaces an oversized img data URI with a placeholder", () => {
    const big = dataUriOfLength(DATA_URI_STRIP_THRESHOLD);
    const body = `<html><body><p>hi</p><img src="${big}" alt="x"></body></html>`;
    const stripped = stripLargeDataUris(body);

    expect(stripped).not.toContain(big);
    expect(stripped).toContain("data:image/svg+xml");
    expect(stripped).toContain("too%20large%20to%20display%20inline");
    // Surrounding HTML is untouched
    expect(stripped).toContain("<p>hi</p>");
    expect(stripped).toContain('alt="x"');
    expect(stripped.length).toBeLessThan(body.length / 10);
  });

  test("keeps data URIs under the threshold (signatures, logos)", () => {
    const small = dataUriOfLength(1_000);
    // Pad the body over the threshold so the early-return doesn't mask the check
    const body = `<img src="${small}">` + "x".repeat(DATA_URI_STRIP_THRESHOLD);
    expect(stripLargeDataUris(body)).toContain(small);
  });

  test("strips only the oversized URI when sizes are mixed", () => {
    const small = dataUriOfLength(1_000);
    const big = dataUriOfLength(DATA_URI_STRIP_THRESHOLD + 1);
    const body = `<img src="${small}"><img src="${big}">`;
    const stripped = stripLargeDataUris(body);
    expect(stripped).toContain(small);
    expect(stripped).not.toContain(big);
  });

  test("returns bodies without data: URIs unchanged", () => {
    const body = "<p>plain old email</p>".repeat(5_000);
    expect(stripLargeDataUris(body)).toBe(body);
  });

  test("placeholder reports the mime type and human-readable size", () => {
    const uri = inlineImagePlaceholder("image/jpeg", 4 * 1024 * 1024);
    const decoded = decodeURIComponent(uri.replace("data:image/svg+xml,", ""));
    expect(decoded).toContain("image/jpeg");
    expect(decoded).toContain("3.0 MB"); // 4M base64 chars ≈ 3MB decoded
  });

  test("empty body is a no-op", () => {
    expect(stripLargeDataUris("")).toBe("");
  });
});
