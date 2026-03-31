/**
 * Unit tests for src/shared/draft-utils.ts
 *
 * Tests the draftBodyToHtml function which converts plain text (from Claude)
 * to HTML for the TipTap editor. Covers: HTML stripping, entity handling,
 * bold/italic marker conversion, paragraph wrapping, bullet lists, numbered lists.
 */
import { test, expect } from "@playwright/test";
import { draftBodyToHtml } from "../../src/shared/draft-utils";

test.describe("draftBodyToHtml", () => {
  // ---------------------------------------------------------------------------
  // Basic paragraph wrapping
  // ---------------------------------------------------------------------------

  test("wraps a single line in <p> tags", () => {
    expect(draftBodyToHtml("Hello world")).toBe("<p>Hello world</p>");
  });

  test("converts single newlines within a block to <br>", () => {
    expect(draftBodyToHtml("Line one\nLine two")).toBe("<p>Line one<br>Line two</p>");
  });

  test("splits on double newlines into separate paragraphs", () => {
    expect(draftBodyToHtml("Para one\n\nPara two")).toBe("<p>Para one</p><p>Para two</p>");
  });

  test("handles triple+ newlines as block separator", () => {
    expect(draftBodyToHtml("A\n\n\nB")).toBe("<p>A</p><p>B</p>");
  });

  // ---------------------------------------------------------------------------
  // Inline formatting: bold and italic
  // ---------------------------------------------------------------------------

  test("converts **bold** markers to <strong>", () => {
    expect(draftBodyToHtml("This is **bold** text")).toBe(
      "<p>This is <strong>bold</strong> text</p>",
    );
  });

  test("converts *italic* markers to <em>", () => {
    expect(draftBodyToHtml("This is *italic* text")).toBe("<p>This is <em>italic</em> text</p>");
  });

  test("handles both bold and italic in the same line", () => {
    const result = draftBodyToHtml("**bold** and *italic*");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
  });

  test("does not convert * surrounded by spaces as italic", () => {
    // The regex requires non-space chars adjacent to the asterisks
    const result = draftBodyToHtml("a * b * c");
    expect(result).not.toContain("<em>");
  });

  // ---------------------------------------------------------------------------
  // HTML stripping: Claude sometimes outputs stray tags
  // ---------------------------------------------------------------------------

  test("strips HTML tags from input, treating as plain text", () => {
    expect(draftBodyToHtml("<div>Hello</div>")).toBe("<p>Hello</p>");
  });

  test("converts <b>/<strong> tags to bold markers before stripping", () => {
    expect(draftBodyToHtml("<b>Bold</b> text")).toBe("<p><strong>Bold</strong> text</p>");
    expect(draftBodyToHtml("<strong>Bold</strong> text")).toBe("<p><strong>Bold</strong> text</p>");
  });

  test("converts <i>/<em> tags to italic markers before stripping", () => {
    expect(draftBodyToHtml("<i>Italic</i> text")).toBe("<p><em>Italic</em> text</p>");
    expect(draftBodyToHtml("<em>Italic</em> text")).toBe("<p><em>Italic</em> text</p>");
  });

  test("strips arbitrary HTML tags like <span>, <a>, <br>", () => {
    const result = draftBodyToHtml('<span class="foo">Hello</span> <a href="x">link</a>');
    expect(result).not.toContain("<span");
    expect(result).not.toContain("<a ");
    expect(result).toContain("Hello");
    expect(result).toContain("link");
  });

  // ---------------------------------------------------------------------------
  // HTML entity handling
  // ---------------------------------------------------------------------------

  test("decodes HTML entities from stripped HTML, then re-escapes for output", () => {
    // Input has HTML entities (as if from stripped HTML)
    // &#39; -> ' -> output stays as ' (no HTML entity needed)
    const result = draftBodyToHtml("It&#39;s a &quot;test&quot;");
    expect(result).toBe('<p>It\'s a "test"</p>');
  });

  test("escapes literal & in plain text to prevent HTML injection", () => {
    // Note: The function strips ALL HTML tags first (including things that look
    // like tags, e.g. "< b >"), then escapes &. So `<` and `>` that form a
    // tag-like pattern get stripped. Only & survives for escaping.
    const result = draftBodyToHtml("Tom & Jerry");
    expect(result).toBe("<p>Tom &amp; Jerry</p>");
  });

  test("strips tag-like content from plain text (by design)", () => {
    // This is intentional: Claude's output is treated as plain text, so
    // any angle-bracket content is stripped as a stray HTML tag.
    const result = draftBodyToHtml("if a < b && b > c");
    // The `< b && b >` portion is removed by the tag stripper
    expect(result).toBe("<p>if a  c</p>");
  });

  test("decodes &amp; then re-encodes it", () => {
    // &amp; -> & -> &amp; in output
    const result = draftBodyToHtml("A &amp; B");
    expect(result).toBe("<p>A &amp; B</p>");
  });

  test("decodes &lt; and &gt; then re-encodes them", () => {
    const result = draftBodyToHtml("&lt;tag&gt;");
    expect(result).toBe("<p>&lt;tag&gt;</p>");
  });

  // ---------------------------------------------------------------------------
  // Bullet lists
  // ---------------------------------------------------------------------------

  test("converts lines starting with '- ' into a <ul>", () => {
    const input = "- Item one\n- Item two\n- Item three";
    const result = draftBodyToHtml(input);
    expect(result).toBe("<ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>");
  });

  test("converts lines starting with '• ' into a <ul>", () => {
    const input = "• Alpha\n• Beta";
    const result = draftBodyToHtml(input);
    expect(result).toBe("<ul><li>Alpha</li><li>Beta</li></ul>");
  });

  test("applies bold/italic within bullet list items", () => {
    const input = "- **Bold item**\n- *Italic item*";
    const result = draftBodyToHtml(input);
    expect(result).toContain("<li><strong>Bold item</strong></li>");
    expect(result).toContain("<li><em>Italic item</em></li>");
  });

  // ---------------------------------------------------------------------------
  // Numbered lists
  // ---------------------------------------------------------------------------

  test("converts lines starting with 'N. ' into an <ol>", () => {
    const input = "1. First\n2. Second\n3. Third";
    const result = draftBodyToHtml(input);
    expect(result).toBe("<ol><li>First</li><li>Second</li><li>Third</li></ol>");
  });

  test("converts lines starting with 'N) ' into an <ol>", () => {
    const input = "1) First\n2) Second";
    const result = draftBodyToHtml(input);
    expect(result).toBe("<ol><li>First</li><li>Second</li></ol>");
  });

  test("applies bold/italic within numbered list items", () => {
    const input = "1. **Important**\n2. *Note*";
    const result = draftBodyToHtml(input);
    expect(result).toContain("<li><strong>Important</strong></li>");
    expect(result).toContain("<li><em>Note</em></li>");
  });

  // ---------------------------------------------------------------------------
  // Mixed content: paragraphs + lists
  // ---------------------------------------------------------------------------

  test("handles paragraph followed by bullet list", () => {
    const input = "Here are the items:\n\n- Item A\n- Item B";
    const result = draftBodyToHtml(input);
    expect(result).toBe("<p>Here are the items:</p><ul><li>Item A</li><li>Item B</li></ul>");
  });

  test("handles numbered list followed by paragraph", () => {
    const input = "1. Step one\n2. Step two\n\nThat's all.";
    const result = draftBodyToHtml(input);
    expect(result).toBe("<ol><li>Step one</li><li>Step two</li></ol><p>That's all.</p>");
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  test("handles empty string", () => {
    expect(draftBodyToHtml("")).toBe("<p></p>");
  });

  test("handles string with only whitespace", () => {
    // Whitespace stays as-is within a <p>
    const result = draftBodyToHtml("   ");
    expect(result).toBe("<p>   </p>");
  });

  test("handles multiple bold markers in one line", () => {
    const result = draftBodyToHtml("**A** then **B**");
    expect(result).toBe("<p><strong>A</strong> then <strong>B</strong></p>");
  });
});
