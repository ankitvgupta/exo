---
name: review-code
description: Pre-commit code review for production-critical issues. Use when reviewing staged changes, before committing, or when asked to review code for bugs and consistency issues.
allowed-tools: Bash, Read, Glob, Grep, Edit, Task, LSP
argument-hint: "[base-branch]"
---

Review staged changes for production-critical issues before committing. This catches the kinds of bugs that CI review bots find — type safety violations, IPC contract mismatches, missing references, and frontend/backend inconsistencies. Uses 14 parallel review agents for comprehensive coverage.

## Scope

Review the same diff GitHub would show on a PR: all changes on the current branch relative to `origin/main`. This uses the merge base so it only includes changes introduced by this branch, not unrelated commits on main.

The user may specify a different base branch via $ARGUMENTS (e.g., `/review-code origin/develop`).

## Process

### Step 1: Gather Context

1. Fetch latest remote state: `git fetch origin main`
2. Compute the merge base: `git merge-base origin/main HEAD`
3. Get changed files: `git diff --name-only <merge-base>`
4. Get the full diff: `git diff <merge-base>`
5. Categorize the changed files by boundary: main process (`src/main/`), renderer (`src/renderer/`), preload (`src/preload/`), shared types (`src/shared/`), database (`src/main/db/`), tests (`tests/`), agents (`src/agents*/`, `src/extensions*/`).

### Step 2: Read Full File Context

For every changed file, read the **full current contents** in parallel (not just the diff hunks). The diff shows what changed, but many issues — missing hook dependencies, stale closures, inconsistent patterns — require surrounding context to detect.

Also read closely related files in parallel based on file type:
- **React components**: read the store, hooks, and IPC callers it imports from
- **IPC handlers**: read the preload method AND the renderer-side caller AND the DB functions it calls
- **DB functions**: read the schema AND all callers
- **Types/schemas**: grep for all importers
- **Tests**: read the source file AND the test config (`playwright.config.ts` for E2E)

See `project-specific.md` File Reading Hints for additional codebase-specific file relationships.

Also read `review-patterns.md` and `project-specific.md` from this skill directory and distribute relevant sections to each agent.

Use Glob and Grep to find related files efficiently. Issue all file reads in a single batch of parallel Read calls.

### Step 3: Run 14 Parallel Review Agents

Create a team with `TeamCreate` (team name: `code-review`), then spawn all 14 agents simultaneously as teammates. Each agent receives the diff, the list of changed files, and the full file contents from Step 2, and returns a list of issues with confidence scores (0-100). Only launch agents whose categories are relevant to the changed files — skip agents that have nothing to check. Run all agents in the background and collect results as they complete.

---

**Agent 1 — Type Safety & References**

What it checks:
- `any` types introduced in diff (CLAUDE.md violation)
- Type assertions (`as`) that bypass type checking — prefer type guards
- All new imports reference real exports (read source file to verify symbol exists)
- Unused imports added in diff
- Run `npx tsc --noEmit` and report errors in changed files

See `project-specific.md` Agent 1 section for codebase-specific checks.

Detection heuristics:
```
grep for: `as any`, `: any`, `as unknown as`, `(window as any)`
```

---

**Agent 2 — IPC Contract Consistency**

There are 5 boundaries that must stay in sync:

1. **Renderer → Preload**: `window.api.X()` → verify `X` exists in preload
2. **Preload → Main**: `ipcRenderer.invoke('channel:name')` → verify `ipcMain.handle('channel:name')` exists
3. **Main → Preload**: new IPC handler → verify preload exposes it
4. **Types across layers**: preload returns `Promise<unknown>` → verify renderer checks `.success` before `.data`
5. **Shared types**: changes to shared types → grep all consumers

See `project-specific.md` Agent 2 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: ipcMain.handle\( in changed files → verify preload has matching invoke
grep for: window.api\. in renderer → verify exists in preload
grep for: mainWindow.webContents.send\( → verify listener in renderer
```

---

**Agent 3 — Database & Data Integrity**

What it checks:
- SQL column names match schema definitions
- DB functions return shapes match all callers
- Missing null/undefined checks on async data
- snake_case (DB) → camelCase (renderer) conversion for new fields
- `INSERT OR REPLACE` resetting flags that should be preserved — use `ON CONFLICT DO UPDATE` with explicit column handling
- `ON CONFLICT` clauses: verify they preserve important fields AND reset fields that should change
- `LIKE '%pattern%'` matching unintended rows — use JSON functions or exact equality
- COALESCE in UPDATE/INSERT preserving stale values after regeneration
- Account scoping: queries must include `accountId` WHERE clause

See `project-specific.md` Agent 3 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: INSERT OR REPLACE → verify not resetting flags
grep for: LIKE '%.*%' → verify not matching unintended patterns
grep for: COALESCE → verify not preserving stale values
grep for: UPDATE|DELETE|SELECT without accountId in WHERE
```

---

**Agent 4 — React Patterns & State Management**

What it checks:
- **Missing hook dependencies**: For EVERY `useCallback`, `useEffect`, `useMemo`, `useLayoutEffect` in changed files: verify ALL referenced variables are in the dep array
- State that should be derived — flag `useEffect` that syncs one state to another
- Object/array literals inline in JSX (re-render triggers)
- Server state should use react-query, not useState
- **Rules of Hooks violation**: hooks called after conditional early returns — hook count MUST be the same on every render
- **useRef vs useState confusion**: if a value needs to trigger re-render, it must be useState
- **iframe.onload timing**: handler MUST be set BEFORE src is assigned
- **Timer cleanup**: always clear previous timer before setting new one, and clear on component unmount
- **Ref mutations during render body**: writing to refs during render breaks React Concurrent Mode
- **useLayoutEffect vs useEffect ordering**: useLayoutEffect runs BEFORE useEffect in the same render
- **Dependency array boolean expression vs value**: `[arr.length > 0]` should be `[arr.length]`
- **Component reused across data contexts**: when a component is rendered for different data (e.g., different selected items) without remounting, ALL local state must be reset on context switch
- **Parallel code paths for same action**: if an action exists as both a button handler and a keyboard shortcut (or in multiple components), verify they behave identically

See `project-specific.md` Agent 4 section for codebase-specific checks.

Detection heuristics:
```
grep for: useCallback|useEffect|useMemo|useLayoutEffect → read full function body → verify deps
grep for: useRef.*useState.*return null|return → check hook ordering around returns
grep for: iframe.*onload → check if set before src
grep for: setTimeout|setInterval → check for clearTimeout in cleanup
grep for: dangerouslySetInnerHTML → check for DOMPurify (cross-ref with Agent 8)
```

---

**Agent 5 — Test Quality & Infrastructure** (only if test files changed)

What it checks:
- Meaningful assertions (not just "it doesn't throw")
- Brittle string-matching assertions (`toContain` on JSX source strings)
- Click elements without visibility/existence checks first
- Error-case tests for async code paths
- Shared module-level state requires `test.describe.configure({ mode: 'serial' })`
- **Virtualizer viewport-bound assertions**: `tanstack-virtual` renders only visible rows — count assertions are viewport-bound
- **Platform-specific shortcuts**: test uses `Meta+k` but CI is Linux (should use `Ctrl+k`)
- **Screenshot directory may not exist**: verify `mkdirSync` with `{ recursive: true }`
- **Test contradicts implementation**
- **Unconditional click on missing element**
- **SIGKILL on already-exited process**

See `project-specific.md` Agent 5 section for codebase-specific checks.

---

**Agent 6 — Async Logic & Race Conditions**

What it checks:
- **UI update before API completion**: handlers that update UI state BEFORE awaiting the API call
- **Stale state after await**: reading state variable after an await gap
- **Processing flag not reset**: any flag set to `true` before async op MUST be reset in `finally` block
- **Re-entrancy**: async handlers need guard (`if (processing) return`)
- **Zustand getState() race**: captured state reference may be stale after await gap
- **requestIdleCallback/setTimeout lifecycle**: must store handle, cancel on unmount
- **useEffect ordering**: useLayoutEffect runs before useEffect
- **Stale CSRF/headers in retry loops**
- **Missing await on async function**
- **Promise that never resolves**: cancel() that doesn't resolve completion promise
- **Retry matching user cancellation**: retryable-error check matching user-initiated abort signals

See `project-specific.md` Agent 6 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: isProcessing|isLoading = true → verify finally block sets false
grep for: getState\(\) → check for await between get and use
grep for: requestIdleCallback|setTimeout → verify handle stored and cancelled
grep for: async.*\{[^}]*\} without await in caller
```

---

**Agent 7 — Error Handling & Resource Leaks**

What it checks:
- **Floating promises**: async handler without .catch()
- **Unhandled promise rejections**
- **Processing/loading flags not reset on error**
- **Event listeners without cleanup**
- **Unbounded Maps/Sets**: must have cleanup mechanism
- **Module-level state persisting across context switches**
- **Conversation/history accumulation without limit**
- **Timer handles not returned for cancellation**
- **removeAllListeners() too broad**
- **Circular object in JSON.stringify**
- **Error handler on streams**
- **Silent failures**: catch blocks that swallow errors
- **Double status emission on failure**

See `project-specific.md` Agent 7 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: \.then\( without \.catch\(
grep for: addEventListener|\.on\( in React → verify cleanup return
grep for: new Map|new Set at module level → check for cleanup
grep for: catch.*\{[^}]*\} → check if error is surfaced to user
grep for: removeAllListeners\(\) → verify scope
grep for: JSON\.stringify → check for circular reference risk
```

---

**Agent 8 — Security & Input Validation**

What it checks:
- **XSS via dangerouslySetInnerHTML** without DOMPurify.sanitize()
- **Path traversal**: `path.join(base, userInput)` without `path.basename()`
- **postMessage validation**: must validate event.origin and event.source
- **HTML injection from headers**: display names in HTML templates without escaping
- **SQL injection**: user input in SQL without parameterized queries
- **LIKE with user input** matching unintended rows
- **Credential exposure** in source code, console.log, error messages, URL parameters
- **CSRF ordering**: nonce/state must be verified BEFORE exchanging auth code
- **Electron security**: no nodeIntegration: true, no disabled contextIsolation
- **base64url → base64 padding**: must add `=` padding
- **Sensitive data in logs**
- **HTML entity escaping**: user text interpolated into HTML without escaping

See `project-specific.md` Agent 8 section for codebase-specific XSS surfaces and known pitfalls.

Detection heuristics:
```
grep for: dangerouslySetInnerHTML → verify DOMPurify.sanitize wraps content
grep for: path\.join.*filename|path\.join.*name → verify path.basename
grep for: addEventListener.*message → verify origin check
grep for: LIKE.*\$\{|LIKE.*\+.*\+ → verify parameterized
grep for: postMessage.*\* → verify specific origin
grep for: API_KEY|SECRET|TOKEN|CREDENTIAL → verify not in source
grep for: \.replace\(/-/g → verify = padding added
```

---

**Agent 9 — Data Loss & Field Preservation**

What it checks:
- **Missing spread in object construction**: verify ALL existing fields are spread when updating individual fields
- **COALESCE defeating intended updates**: passing values that make `IS NOT NULL` true for fields that should remain unchanged
- **Partial failure without rollback**: multi-step operations where later steps fail, leaving inconsistent state
- **Object property overwritten by subsequent reassignment**
- **useRef for form fields capturing stale values**
- **Regex dropping valid characters**: patterns that silently drop `+` or other valid RFC characters from addresses
- **Boolean check on collection, action on specific item**: `array.some(predicate)` returns true but subsequent action targets a different item than the one that matched

See `project-specific.md` Agent 9 section for codebase-specific field lists.

Detection heuristics:
```
grep for: { body:.*subject: without ...existing spread
grep for: COALESCE → verify NULL handling
```

---

**Agent 10 — Cross-Account & Multi-Context Safety**

What it checks:
- **Cache keys missing context scope**: keys using only item ID without context/account prefix
- **Event listeners not filtering by context**: handlers update state without checking if event is for current context
- **Selection not cleared on context switch**: batch selection carries across contexts
- **Module-level Sets shared across contexts**: Set tracking "already processed" prevents processing same ID in different context
- **DB queries missing context scoping**: queries without WHERE clause for context
- **`accounts[0]` instead of active**: using first item instead of currently selected for context-dependent operations
- **Hardcoded default context ID**

See `project-specific.md` Agent 10 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: new Map|new Set → check if keys include context scope
grep for: threadId|emailId as standalone key → verify context prefix
grep for: accounts\[0\] → verify this is intentional
grep for: WHERE.*threadId|WHERE.*email_id without context scope
grep for: addEventListener|\.on\( → verify context filter
```

---

**Agent 11 — Email/RFC Compliance & String Handling**

What it checks:
- **RFC 5322 display name quoting**: names with special chars MUST be quoted
- **base64url → base64 padding**
- **MIME header construction** via string concat skips proper escaping
- **"LastName, FirstName" address parsing**: naive `.split(",")` corrupts addresses
- **Email address case sensitivity inconsistency**
- **Angle brackets in non-email context** triggering false HTML detection
- **RFC 2822 quote handling**: escaped quotes inside quoted strings
- **Gmail wildcard queries**: quotes break glob patterns
- **Duplicate React keys from addresses**
- **HTML tag stripping via regex** destroying legitimate content
- **Markdown false positives**
- **Pre-formatted addresses breaking dedup**
- **Trailing quote in extracted names**

See `project-specific.md` Agent 11 section for codebase-specific checks.

Detection heuristics:
```
grep for: \$\{.*name.*\}.*<\$\{.*email → verify RFC 5322 quoting
grep for: replace\(/-/g.*replace\(/_/g → verify = padding
grep for: \.split\(.*,.*\) on email headers → verify handles quoted commas
grep for: toLowerCase\(\) in email comparisons → verify consistency
grep for: <[^>]+> for tag stripping → verify not matching legitimate content
```

---

**Agent 12 — Build, Packaging & Electron**

What it checks:
- **__dirname in packaged app**: relative paths may not resolve correctly
- **Module-level app.getPath()**: called at import time, before app is ready → crashes in tests
- **Config path migration** without migrating existing files
- **removeAllListeners() too broad**
- **Packaged macOS PATH**
- **Notarization completeness**: both ZIP and DMG must be notarized and stapled
- **Icon path resolution**

See `project-specific.md` Agent 12 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: __dirname in main process → verify packaged path handling
grep for: app\.getPath at module level → verify not at import time
grep for: removeAllListeners\(\) → verify not too broad
grep for: asar.*unpack → verify minimal glob
```

---

**Agent 13 — Concurrency, Deduplication & Performance**

What it checks:
- **Cross-collection deduplication**: checking one queue but not another for duplicates
- **Sequential API calls in loops when independent**
- **Timer churn from effects**: effect recreates timers on every state change
- **Re-entrancy without guard**
- **Off-by-one in retry logic**
- **Infinite recursion in queue processing**: queue re-calls itself when no items processable
- **Cache key missing fields**: key doesn't include all inputs that affect the cached value
- **Deleting from Map during iteration**: may skip entries per ECMAScript spec
- **isRunning flag reset in clear()**: flag reset without stopping the running operation

See `project-specific.md` Agent 13 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: queue|backlog|pending → verify dedup across all collections
grep for: for.*of.*await → check if calls can be parallelized
grep for: setInterval|setTimeout in effects → verify not churning
grep for: processQueue|processNext → verify no recursion risk
```

---

**Agent 14 — Agent/AI Integration** (only if agent/AI files changed)

What it checks:
- **Config propagation to workers**: settings changes must reach utility process workers
- **Duplicate terminal events**: done/complete event emitted from multiple sources
- **AbortController without signal wiring**: controller created but signal never passed to API call
- **Permission gate not wired**: gate class exists but tool executor never calls it
- **Empty accounts/context creating invalid state**: agent gets empty context → contaminated data
- **Fragile JSON extraction**: regex-based JSON parsing fails on braces inside string values

See `project-specific.md` Agent 14 section for codebase-specific checks and known pitfalls.

Detection heuristics:
```
grep for: yield.*done|emit.*done → verify single terminal event
grep for: abortController|AbortController → verify signal passed to SDK
```

---

### Step 4: Cross-Agent Deduplication

After all agents complete, deduplicate findings where multiple agents flagged the same issue from different angles. Keep the highest-confidence version and note which agents agreed (agreement between agents increases effective confidence by 10 points).

### Step 5: Systemic Pattern Detection

Look for patterns across individual findings:
- If Agent 6 (async) finds a race condition AND Agent 9 (data loss) finds missing rollback on the same handler → escalate to Critical
- If Agent 9 (data loss) finds missing fields AND Agent 2 (IPC) finds the same field missing across the IPC boundary → escalate to Critical
- If multiple agents independently flag the same file → flag it as a "high-risk file" in the report

### Step 6: Score and Filter

Each agent assigns a confidence score (0-100) to each finding:

| Score | Meaning |
|-------|---------|
| 0-25 | Likely false positive, or pre-existing issue not introduced by this diff |
| 25-50 | Might be real but could be a nitpick or unlikely in practice |
| 50-75 | Real issue but low severity or narrow impact |
| 75-89 | Verified real issue that will likely cause problems in production |
| 90-100 | Confirmed critical — will definitely cause a bug, crash, or security vulnerability |

**Only report issues scored 75 or above.**

Scoring adjustments:
- **Cross-agent agreement bonus**: +10 when 2+ agents flag the same issue
- **Known pitfall match bonus**: +15 when finding matches a pattern from `project-specific.md` (these are confirmed historical bugs)
- **Regression penalty**: If the diff reintroduces a pattern that was previously fixed in a past PR, auto-score 95+

### False Positive Filters

Do NOT flag these — they are the most common false positives from CI review bots:

- Pre-existing issues on unchanged lines (only review what the diff touches)
- Formatting/style issues (linters catch these)
- Missing test coverage (unless a complex code path has zero tests)
- Type errors that `tsc` would catch (report `tsc` errors in a separate section, don't duplicate)
- Intentional `any` or `as` with an explanatory comment or lint-ignore
- Changes in behavior that are clearly intentional from the commit context
- Suggestions to use a different library/pattern when the existing one works correctly
- CLAUDE.md rules explicitly overridden by a code comment
- General code quality (documentation, naming style) unless explicitly required in CLAUDE.md
- API call count concerns for methods called < 10x per user session
- Suggestions to extract utilities for code that appears only twice

See `project-specific.md` False Positive Filters for codebase-specific filters.

### Step 7: Report

Group findings in this format:

```
## Code Review Results

### Critical (score 90-100)
[findings with exact file:line, what's wrong, production impact, suggested fix]

### Important (score 75-89)
[findings]

### Systemic Patterns
[patterns detected across multiple findings]

### High-Risk Files
[files flagged by 3+ agents]

### Type Errors (from tsc)
[if any]

Found X critical, Y important issues across Z files. Reviewed by 14 agents.
```

For each finding:
1. **File and line** — exact location in the diff
2. **What's wrong** — concise description
3. **Why it matters** — how this manifests as a production bug
4. **Suggested fix** — concrete code change, not vague guidance

If no issues scored 75+: "No high-confidence issues found. Reviewed [N] files across [categories]."

### Step 8: Fix Issues

After presenting the report, act on the findings:

**Simple fixes** (single-line changes, missing null checks, adding a variable to a dependency array, clearing state in an existing useLayoutEffect, adding `path.basename()`) — just fix them directly. No need to ask or plan.

**Non-trivial fixes** (architectural changes, new error handling paths, refactoring async flow, adding rollback logic to optimistic updates) — enter plan mode first. Present the plan with the specific issues being addressed, the files that will change, and the approach for each fix. Wait for approval before making changes.

**Type errors from `tsc`** — fix directly if the fix is obvious from the error message. If the error reveals a deeper type design problem, plan first.

After all fixes are applied, re-run `npx tsc --noEmit` to verify no new type errors were introduced by the fixes. If the fixes touched IPC boundaries, re-run the relevant IPC contract checks from Agent 2 to confirm consistency.
