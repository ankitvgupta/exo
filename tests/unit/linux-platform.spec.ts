import { test, expect } from "@playwright/test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  formatModifierShortcut,
  formatSymbolShortcut,
  getPlatformInfo,
} from "../../src/shared/platform";
import {
  buildFilesystemSandbox,
  buildPlatformSandboxGuidance,
} from "../../src/main/agents/providers/claude-agent-sandbox";
import { extractZipArchive, zipDirectory } from "../../src/main/utils/zip";

test.describe("platform labels", () => {
  test("uses macOS command labels on darwin", () => {
    const platform = getPlatformInfo("darwin");
    expect(platform.isMac).toBe(true);
    expect(formatModifierShortcut("Enter", platform)).toBe("Cmd+Enter");
    expect(formatSymbolShortcut("K", platform)).toBe("\u2318K");
  });

  test("uses control labels on linux", () => {
    const platform = getPlatformInfo("linux");
    expect(platform.isMac).toBe(false);
    expect(formatModifierShortcut("Enter", platform)).toBe("Ctrl+Enter");
    expect(formatSymbolShortcut("K", platform)).toBe("Ctrl+K");
  });
});

test.describe("cross-platform zip helpers", () => {
  test("creates and extracts a zip without platform shell tools", async () => {
    const root = mkdtempSync(join(tmpdir(), "exo-zip-"));
    const source = join(root, "source");
    const extracted = join(root, "extracted");
    const zipPath = join(root, "logs.zip");

    try {
      mkdirSync(join(source, "nested"), { recursive: true });
      writeFileSync(join(source, "exo.log"), "hello logs");
      writeFileSync(join(source, "nested", "trace.log"), "nested trace");

      await zipDirectory(source, zipPath);
      await extractZipArchive(zipPath, extracted);

      expect(readFileSync(join(extracted, "exo.log"), "utf8")).toBe("hello logs");
      expect(readFileSync(join(extracted, "nested", "trace.log"), "utf8")).toBe("nested trace");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test.describe("Claude agent platform sandbox", () => {
  test("keeps macOS TCC-sensitive directories blocked with app data re-allowed", () => {
    const sandbox = buildFilesystemSandbox("/Users/alice", "darwin");
    expect(sandbox.denyRead).toContain("/Users/alice/Library");
    expect(sandbox.denyRead).toContain("/Volumes");
    expect(sandbox.allowRead).toContain("/Users/alice/Library/Application Support/exo");
    expect(buildPlatformSandboxGuidance("darwin")).toContain("On macOS");
  });

  test("blocks sensitive Linux home-directory credential stores", () => {
    const sandbox = buildFilesystemSandbox("/home/alice", "linux");
    expect(sandbox.denyRead).toEqual(
      expect.arrayContaining([
        "/home/alice/.ssh",
        "/home/alice/.gnupg",
        "/home/alice/.aws",
        "/home/alice/.local/share/keyrings",
        // Browser profiles (parity with the macOS ~/Library deny).
        "/home/alice/.mozilla",
        "/home/alice/.config/google-chrome",
        "/home/alice/.config/chromium",
      ]),
    );
    expect(sandbox.allowRead).toBeUndefined();
    expect(buildPlatformSandboxGuidance("linux")).toContain("On Linux");
  });

  test("falls back to default-deny (never unsandboxed) on an unknown platform", () => {
    const sandbox = buildFilesystemSandbox("/home/alice", "freebsd");
    expect(sandbox.denyRead).toContain("/home/alice/.ssh");
    expect(sandbox.denyRead.length).toBeGreaterThan(0);
  });
});
