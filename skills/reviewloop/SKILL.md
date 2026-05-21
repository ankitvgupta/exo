---
name: reviewloop
description: >
  Iteratively improves a PR until all review bots (Greptile, Devin, and others) are satisfied
  with zero unresolved comments, then fixes any CI failures. Triggers reviews, fixes all
  actionable comments, pushes, re-triggers, and repeats. Use when the user wants to fully
  optimize a PR against all automated code review feedback.
license: MIT
compatibility: Requires git, gh (GitHub CLI) authenticated, and at least one review bot installed on the repo.
metadata:
  author: ankitvgupta
  version: "2.0"
allowed-tools: Bash(gh:*) Bash(git:*) Bash(sleep:*)
---

# Reviewloop

Iteratively fix a PR until **all review bots** give clean feedback and CI passes.

**CI strategy:** On the first iteration, wait for both CI and review bots together, fixing any CI issues alongside bot feedback. On subsequent iterations, only wait for review bots (skipping CI) to keep the loop fast. After all review bots are satisfied, do one final CI check.

## Inputs

- **PR number** (optional): If not provided, detect the PR for the current branch.

## Known review bots

Detect and handle reviews from any of these (and any others that appear):

| Bot login pattern | Name | Notes |
|---|---|---|
| `greptile-apps[bot]`, `greptile-apps-staging[bot]` | Greptile | |
| `devin-ai-integration[bot]`, `devin-ai[bot]` | Devin | |
| `coderabbitai[bot]` | CodeRabbit | |
| `sourcery-ai[bot]` | Sourcery | |
| `ellipsis-dev[bot]` | Ellipsis | |
| `github-actions[bot]` | **Excluded** | Powers too many non-review workflows (labeling, stale issues, deployments) — creates false positives |
| Any other login ending in `[bot]` with diff-attached review comments | Other bots | |

The loop should handle **all** bots it discovers, not just the ones listed above. A `[bot]` author counts as a review bot only if it has left **diff-attached inline comments** (comments with a `path` and `line`). General PR-level comments without a diff position are not treated as review feedback.

## Instructions

### 1. Identify the PR

```bash
gh pr view --json number,headRefName -q '{number: .number, branch: .headRefName}'
```

Switch to the PR branch if not already on it.

### 2. Discover active review bots

Fetch all reviews and review comments to identify which bots are active on this PR:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments
```

Build a set of active bot logins (any author whose login ends in `[bot]`). These are the bots whose feedback we need to satisfy.

### 3. Review bot loop

Repeat the following cycle. **Max 5 iterations** to avoid runaway loops.

#### A. Push and wait for reviews

Push the latest changes (if any):

```bash
git push
```

**First iteration only:** Wait for both review bots AND CI checks to complete — poll them concurrently. Poll CI every 30 seconds for up to 15 minutes:

```bash
gh pr checks <PR_NUMBER>
```

If CI failures are found on this first iteration, fix them alongside the review bot feedback in step D (treat them like any other actionable issue). This avoids a separate CI fix cycle later for issues caught early.

**Subsequent iterations:** Only wait for review bot responses — do NOT wait for CI checks. This keeps the loop fast since CI runs are slow relative to review bots.

For review bot polling (all iterations): use exponential backoff — check at 15s, 30s, 60s, 90s, then 120s. On each poll, count the total bot reviews on the PR — if the count increased since the push, bots have responded and you can proceed to step B. If no new reviews appear after 120s, proceed anyway (some bots may not re-review small changes).

#### B. Fetch all bot review results

Get all reviews:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/reviews --paginate
```

For each active bot, find its **most recent** review. Parse for:
- **Greptile**: confidence score (e.g. `3/5` or `5/5`) in the review body, plus inline comments
- **Devin / other bots**: review state (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`), plus inline comments

Fetch all unresolved inline comments:

```bash
gh api repos/{owner}/{repo}/pulls/<PR_NUMBER>/comments --paginate
```

Filter to comments from bot authors that are on the latest commit or still unresolved.

Also fetch unresolved review threads via GraphQL (see [GraphQL reference](references/graphql-queries.md)):

Loop with cursor-based pagination to fetch **all** review threads:

```bash
# First page (no cursor)
gh api graphql -f query='
{
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 5) {
            nodes { body path line author { login } createdAt }
          }
        }
      }
    }
  }
}'

# If pageInfo.hasNextPage is true, fetch next page:
gh api graphql -f query='
query($cursor: String!) {
  repository(owner: "OWNER", name: "REPO") {
    pullRequest(number: PR_NUMBER) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: 5) {
            nodes { body path line author { login } createdAt }
          }
        }
      }
    }
  }
}' -F cursor="<endCursor from previous page>"
```

Continue until `hasNextPage` is false. Collect all nodes across pages before processing.

#### C. Check exit conditions

Stop the review bot loop if **all** of these are true:
- **Greptile** (if active): confidence is **5/5** AND zero unresolved Greptile comments
- **All other bots** (Devin, CodeRabbit, etc.): zero unresolved inline comments from the bot

**Do not use GitHub review state** (`APPROVED`, `CHANGES_REQUESTED`, `COMMENTED`) as a satisfaction signal for any bot. Bots like Devin use `COMMENTED` even when leaving substantive feedback, and `CHANGES_REQUESTED` may persist after all inline comments are resolved. The only reliable signal is: **zero unresolved inline comments from that bot**.

Also stop if max iterations reached (report current state).

#### D. Fix actionable comments

For each unresolved bot comment (process by bot, prioritizing bots with the most comments first):

1. Read the file and understand the comment in context.
2. Determine if it's actionable (code change needed) or informational/false-positive.
3. If actionable, make the fix.
4. If informational or a false positive, note it but still resolve the thread.

When multiple bots flag the same file/region, address all comments together to avoid redundant changes.

#### E. Resolve threads

Fetch unresolved review threads and resolve all that have been addressed (see [GraphQL reference](references/graphql-queries.md)):

```bash
gh api graphql -f query='
mutation {
  t1: resolveReviewThread(input: {threadId: "ID1"}) { thread { isResolved } }
  t2: resolveReviewThread(input: {threadId: "ID2"}) { thread { isResolved } }
}'
```

#### F. Commit and push

```bash
git add -A
git commit -m "address review bot feedback (reviewloop iteration N)"
git push
```

Then go back to step **A**.

### 4. Final CI check

After review bots are satisfied (or max iterations reached), do a final CI check. Since CI was only waited on during the first iteration, subsequent review-only iterations may have introduced new CI failures.

Wait for CI checks to complete:

```bash
gh pr checks <PR_NUMBER>
```

Poll every 30 seconds for up to 15 minutes until all CI checks have finished.

If CI is passing, proceed to step 5.

If there are CI failures:

1. Identify failing checks and fetch their logs:
   ```bash
   gh run view <RUN_ID> --log-failed
   ```
2. Fix the failures.
3. Commit and push:
   ```bash
   git add -A
   git commit -m "fix CI failures (reviewloop)"
   git push
   ```
4. **Go back to step 1** — the CI fix push may trigger new review bot feedback, so re-run the full process (discover bots, review bot loop, final CI check). This counts as a new top-level cycle.

**Max 3 top-level CI-fix cycles** to avoid infinite loops. If CI is still failing after 3 cycles, stop and report.

### 5. Report

After exiting all loops, summarize:

| Field | Value |
|-------|-------|
| Review iterations | N |
| CI fix attempts | N |
| Bots satisfied | list of bot names |
| Bots with remaining issues | list (if any) |
| CI status | passing / failing |
| Total comments resolved | N |
| Remaining comments | N (if any) |

## Output format

```
Reviewloop complete.
  Review iterations: 2
  CI fix attempts:   1
  Bots satisfied:    Greptile (5/5), Devin (0 unresolved)
  CI status:         passing
  Resolved:          12 comments
  Remaining:         0
```

If not fully resolved:

```
Reviewloop stopped after 5 review iterations + 3 CI attempts.
  Bots satisfied:    Greptile (5/5)
  Bots unsatisfied:  Devin (2 unresolved comments)
  CI status:         failing (lint)
  Resolved:          10 comments
  Remaining:         2

Remaining issues:
  - [Devin] src/auth.ts:45 — "Consider rate limiting this endpoint"
  - [Devin] src/db.ts:112 — "Missing index on user_id column"
  - [CI] lint: unused import in src/utils.ts:3
```
