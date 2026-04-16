import { test, expect } from "@playwright/test";
import { replaceRemoteImageSources } from "../../src/shared/email-image-privacy";

test.describe("replaceRemoteImageSources", () => {
  test("replaces remote image URLs with local privacy placeholders", () => {
    const input =
      '<div><img src="https://tracker.example.com/logo.png" width="120" height="40"></div>';
    const output = replaceRemoteImageSources(input, true);

    expect(output).not.toContain("https://tracker.example.com/logo.png");
    expect(output).toContain("data:image/svg+xml,");
    expect(output).toContain('alt="Remote image blocked for privacy"');
    expect(output).toContain('title="Remote image blocked for privacy"');
  });

  test("removes likely tracking pixels entirely", () => {
    const input =
      '<div>Hello</div><img src="https://tracker.example.com/open.gif" width="1" height="1">';
    const output = replaceRemoteImageSources(input, true);

    expect(output).not.toContain("<img");
    expect(output).toContain("<div>Hello</div>");
  });

  test("leaves local and inline image sources untouched", () => {
    const input =
      '<img src="data:image/png;base64,abc"><img src="cid:image001@domain"><img src="/local.png">';
    const output = replaceRemoteImageSources(input, false);

    expect(output).toBe(input);
  });
});
