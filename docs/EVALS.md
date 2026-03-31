# Evals

Eval harness for measuring email analysis quality. Lives in `tests/evals/`.

## When to Run

Run evals before any prompt change to `EmailAnalyzer`. The harness detects regressions against a stored baseline.

```bash
npm run eval                          # Run all fixtures, compare to baseline
npm run eval -- --update-baseline     # Run and save current scores as new baseline
```

Exit code 1 if any fixture regresses from its baseline score.

## Architecture

```
tests/evals/
├── runner.ts           # Main entry point, loads fixtures, runs analysis, outputs report
├── baseline.json       # Stored per-fixture scores (version-controlled)
├── fixtures/           # One JSON file per test case
│   ├── needs-reply-high.json
│   ├── needs-reply-low.json
│   ├── no-reply-newsletter.json
│   ├── no-reply-notification.json
│   ├── reminder-service.json
│   ├── scheduling-email.json
│   ├── draft-casual.json
│   └── draft-formal.json
└── scoring/
    ├── deterministic.ts  # Exact-match scoring for structured fields
    └── llm-judge.ts      # LLM-as-judge for draft quality (stub, not yet active)
```

## Fixtures

Each fixture is a JSON file with:

```json
{
  "id": "needs-reply-high-001",
  "description": "Urgent production issue requiring approval",
  "email": {
    "id": "fixture-001",
    "threadId": "thread-001",
    "from": "ops@company.com",
    "to": "user@company.com",
    "subject": "URGENT: Production database issue",
    "body": "...",
    "date": "2025-01-15T10:30:00Z",
    "snippet": "..."
  },
  "expected": {
    "needs_reply": true,
    "priority": "high"
  }
}
```

To add a fixture: create a new JSON file in `tests/evals/fixtures/`. The runner auto-discovers all `.json` files in that directory.

## Scoring

### Deterministic (`scoring/deterministic.ts`)

Scores structured fields with exact match on a 0-10 scale:
- **needs_reply match**: 5 points
- **priority match** (when `needs_reply` is true): 5 points
- Priority auto-awarded when `needs_reply` is false (priority is meaningless for no-reply emails)

### LLM Judge (`scoring/llm-judge.ts`)

Stub for future draft quality evaluation. Will score drafts on relevance, tone, and formality using Claude as a judge. Not currently wired into the analysis eval run.

## Baseline

`baseline.json` stores per-fixture scores:

```json
{
  "version": 1,
  "generated_at": "2025-03-29T...",
  "scores": {
    "needs-reply-high-001": 10,
    "no-reply-newsletter-001": 10
  }
}
```

If `generated_at` is null (initial state), no regressions are checked. Run `--update-baseline` after establishing initial quality.

## Reading the Report

The runner prints a summary table, then a full JSON report:

```
=== Email Analysis Eval Report ===

Fixtures:  8
Score:     75/80 (94%)

  [PASS] needs-reply-high-001: 10/10
         Urgent production issue requiring approval
  [PARTIAL] scheduling-email-001: 5/10 (priority mismatch)
         Meeting scheduling request from colleague

--- JSON Report ---
{ ... full structured report ... }
```

Status labels:
- **PASS** (10/10): All fields match
- **PARTIAL** (5-9/10): Some fields match
- **FAIL** (0-4/10): Major mismatch
