# Packaged OpenCode Binary Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the packaged macOS Exo app discover its bundled OpenCode executable so enabled OpenCode settings produce an OpenCode option in the agent picker.

**Architecture:** Keep the existing development-path discovery and add a direct candidate for OpenCode's platform-specific optional dependency, which electron-builder already unpacks. Cover the path translation with a unit test and the real bundle with the packaged smoke suite.

**Tech Stack:** Electron, TypeScript, Node.js filesystem/module resolution, Playwright.

## Global Constraints

- Preserve the existing development resolution paths and memoization.
- Do not read or modify the production Exo profile during tests.
- Use Node.js `22.22.0` for install, tests, and packaging.
- Keep the PR limited to OpenCode binary resolution, its regression coverage, and this plan.

---

### Task 1: Resolve the platform package executable

**Files:**

- Modify: `src/main/agents/providers/opencode/opencode-agent-provider.ts`
- Create: `tests/unit/opencode-binary-resolution.spec.ts`

**Interfaces:**

- Consumes: `platform`, `arch`, and a resolved `opencode-<platform>-<arch>/package.json` path.
- Produces: `resolveOpencodePlatformBinary(options?: ResolveOpencodePlatformBinaryOptions): string | null`.

- [ ] **Step 1: Write the failing unit test**

```ts
import { expect, test } from "@playwright/test";
import { resolveOpencodePlatformBinary } from "../../src/main/agents/providers/opencode/opencode-agent-provider";

test("maps the packaged darwin arm64 dependency to its executable", () => {
  expect(
    resolveOpencodePlatformBinary({
      platform: "darwin",
      arch: "arm64",
      resolvePackageJson: () =>
        "/Applications/Exo.app/Contents/Resources/app.asar/node_modules/opencode-darwin-arm64/package.json",
      fileExists: () => true,
    }),
  ).toBe(
    "/Applications/Exo.app/Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode",
  );
});
```

- [ ] **Step 2: Run the unit test and verify RED**

Run: `npx playwright test --project=unit tests/unit/opencode-binary-resolution.spec.ts`

Expected: FAIL because `resolveOpencodePlatformBinary` is not exported.

- [ ] **Step 3: Implement the minimal candidate helper and resolver branch**

Add a pure helper that joins the package directory with `bin/opencode` (`opencode.exe` on Windows), translates `app.asar` to `app.asar.unpacked`, and return that candidate. Resolve `opencode-${normalizedPlatform}-${process.arch}/package.json` and add the candidate before the legacy shim paths.

- [ ] **Step 4: Run focused OpenCode tests and verify GREEN**

Run: `npx playwright test --project=unit tests/unit/opencode-binary-resolution.spec.ts tests/unit/opencode-resolve-route.spec.ts tests/unit/opencode-event-mapper.spec.ts tests/unit/opencode-mcp-bridge.spec.ts`

Expected: all tests pass.

### Task 2: Prove the packaged artifact

**Files:**

- Modify: `tests/packaged/smoke.spec.ts`

**Interfaces:**

- Consumes: `EXO_PACKAGED_BINARY` pointing to the packaged executable.
- Produces: smoke assertions that the platform executable is present and executable and that enabled OpenCode appears in the packaged agent picker after restart.

- [ ] **Step 1: Add the packaged smoke assertion**

Derive `Contents/Resources/app.asar.unpacked/node_modules/opencode-darwin-arm64/bin/opencode` from the macOS packaged executable, assert it exists, and assert its execute bits are non-zero.

Persist enabled OpenCode settings in the smoke suite's isolated profile, restart that packaged app, open the agent palette, and assert the `OpenCode` provider button is visible.

- [ ] **Step 2: Build and package**

Run: `npm run build`

Run: `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`

- [ ] **Step 3: Run the packaged smoke suite**

Run: `EXO_PACKAGED_BINARY=release/mac-arm64/Exo.app/Contents/MacOS/Exo npx playwright test --project=packaged`

Expected: all packaged smoke tests pass without touching `~/Library/Application Support/exo`.

### Task 3: Validate and publish the draft PR

**Files:**

- Review all changed files from Tasks 1 and 2.

**Interfaces:**

- Consumes: the green fix branch.
- Produces: a pushed branch and draft PR against `ankitvgupta/exo:main`.

- [ ] **Step 1: Run local gates**

Run: `npm run typecheck`

Run: `npm run lint`

Run: `npm run format:check`

Run: `npm test`

- [ ] **Step 2: Commit and push**

Stage only the plan, resolver, unit test, and packaged smoke test. Commit as `Fix packaged OpenCode binary resolution`, then push `codex/fix-packaged-opencode-binary` to `upstream-pr`.

- [ ] **Step 3: Open the draft PR**

Create a draft PR against `ankitvgupta/exo:main` with root cause, impact, and exact validation commands.

- [ ] **Step 4: Run required post-PR gates**

Run full `npm run pre-pr`, then `/review`, `/reviewloop`, and `gh pr checks`. Fix major findings and rerun required gates until the PR is clean or an external credential/CI blocker is proven.

### Task 4: Build and install the all-PR integration app

**Files:**

- No source edits beyond merge conflict resolution in a dedicated integration worktree.

**Interfaces:**

- Consumes: current `upstream/main`, PR heads #169, #170, #171, #180, #190, and the new OpenCode fix PR head.
- Produces: a packaged and installed `/Applications/Exo.app` using the unchanged production profile.

- [ ] **Step 1: Create the integration worktree and merge authoritative PR heads**

Create a fresh integration branch from current `upstream/main`. Merge each Mick-authored open PR head and the new fix head, preserving all feature behavior during conflict resolution.

- [ ] **Step 2: Install, build, test, and package**

Use Node.js `22.22.0`, run `npm install`, focused conflict-area tests, `npm run build`, and `CSC_IDENTITY_AUTO_DISCOVERY=false npm run pack`.

- [ ] **Step 3: Install safely**

Preserve a rollback copy of `/Applications/Exo.app`, replace only the app bundle, and leave `~/Library/Application Support/exo` untouched.

- [ ] **Step 4: Verify installed provenance and behavior**

Compare packaged and installed `app.asar` SHA-256 values, confirm the live process runs `/Applications/Exo.app` with the production profile, and confirm the OpenCode provider appears after `Cmd+J`.
