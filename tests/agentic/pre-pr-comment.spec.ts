/**
 * Unit tests for the pre-pr GitHub comment builder.
 *
 * The comment is public PR surface. Raw phase output and agentic artifacts can
 * contain local mailbox/calendar data, so the builder must only publish status
 * rows plus local artifact paths.
 */
import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrCommentBody } from "../../scripts/lib/pre-pr-comment.mjs";

test.describe("buildPrCommentBody", () => {
  test("does not inline raw phase output or local agentic artifacts", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "exo-pre-pr-comment-"));
    const reportDir = join(repoRoot, "scripts", ".agentic-runs");
    const md = join(reportDir, "2026-06-15-verify-diff.md");
    const json = join(reportDir, "2026-06-15-verify-diff.json");
    const log = join(reportDir, "2026-06-15-verify-diff.log");
    const sentinel = "PRIVATE_CALENDAR_SENTINEL_casey@example.com";

    try {
      mkdirSync(reportDir, { recursive: true });
      writeFileSync(md, `markdown ${sentinel}`);
      writeFileSync(json, JSON.stringify({ trace: sentinel }));
      writeFileSync(log, `log ${sentinel}`);

      const body = buildPrCommentBody({
        verdict: "FAIL",
        sha: "abcdef0",
        mode: "quick",
        generatedAt: new Date("2026-06-15T12:00:00.000Z"),
        repoRoot,
        verifyReport: { md, json, log },
        phases: [
          {
            name: "agentic-verify",
            status: 1,
            ms: 1234,
            ok: false,
            stdout: `stdout ${sentinel}`,
            stderr: `stderr ${sentinel}`,
          },
        ],
      });

      expect(body).toContain("agentic-verify");
      expect(body).toContain("scripts/.agentic-runs/2026-06-15-verify-diff.md");
      expect(body).toContain("Raw phase output is intentionally not posted to GitHub");
      expect(body).not.toContain(sentinel);
      expect(body).not.toContain("stdout PRIVATE_CALENDAR_SENTINEL");
      expect(body).not.toContain("markdown PRIVATE_CALENDAR_SENTINEL");
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
