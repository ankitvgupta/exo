# Eval Variance & Threshold Calibration

How the eval regression threshold and per-fixture baselines were chosen
empirically — not picked out of a hat.

## TL;DR

- **Threshold: 3.0 points** below baseline triggers a regression failure.
- **Baselines: p25** of observed scores across 10 runs per fixture.
- **Tool: `scripts/evals-variance.ts`** — re-run to recalibrate.

## Why this matters

Both the feature and the judge are Sonnet calls. Sonnet is nondeterministic.
Two consecutive runs of the same fixture can score 7 then 9 with zero
code change between them. A 0.5pt or 1.0pt threshold flags noise as
regression every time, blocking the merge gate for no real reason.

The right answer is to **measure the noise floor** and set the
threshold above it.

## Methodology

```bash
npx tsx scripts/evals-variance.ts --runs 10 --concurrency 5
```

For each fixture across every registered feature:

1. Run the feature N times (default 10).
2. Score each output via the LLM judge.
3. Compute stats (min, p25, median, p75, max, mean, stddev) on the
   resulting score distribution.
4. Report.

Total cost for 10 runs × 8 fixtures × 3 features ≈ ~$1-2 and ~90s wall
clock at concurrency=5.

## Results (2026-05-21)

Variance analysis across 8 fixtures, 10 runs each. Sonnet 4.6 judge.

| Feature / Fixture | Range | Stddev | Median | Mean | Scores |
|---|---|---|---|---|---|
| **draft-generator** |  |  |  |  |  |
| dg-1-direct-question | 4 | 1.02 | 7 | 6.5 | 4,6,6,6,7,7,7,7,7,8 |
| dg-2-scheduling | 5 | 1.43 | 5 | 5.4 | 4,4,4,5,5,5,6,6,6,9 |
| dg-3-decline | 5 | 1.33 | 3 | 3.2 | 1,2,2,3,3,3,4,4,4,6 |
| **calendaring-agent** |  |  |  |  |  |
| ca-1-explicit-scheduling | 3 | 0.98 | 10 | 9.2 | 7,8,9,9,9,10,10,10,10,10 |
| ca-2-not-scheduling | 0 | 0 | 10 | 10.0 | 10×10 |
| ca-3-ambiguous-time | 1 | 0.49 | 9 | 9.4 | 9,9,9,9,9,9,10,10,10,10 |
| **archive-ready-analyzer** |  |  |  |  |  |
| ar-1-resolved-thread | 0 | 0 | 10 | 10.0 | 10×10 |
| ar-2-open-question | 0 | 0 | 10 | 10.0 | 10×10 |

## How the threshold was chosen

- **Max stddev across fixtures: 1.43** (dg-2-scheduling)
- **2 × stddev = 2.86**, which is the standard "this is real signal, not
  noise" gate for normal distributions.
- **Rounded up to 3.0** for the regression threshold.

A regression below `baseline - 3.0` empirically only happens when the
judge takes a strong stance about something materially broken — not
random oscillation.

## How baselines were chosen (p25)

For each fixture, the baseline = the 25th percentile of observed scores.
This protects against:

- A fixture occasionally dropping below its mean (set baseline at p25
  → most drops still pass the threshold).
- Over-optimistic baselines from a single "lucky" capture run.

For deterministic fixtures (range=0), p25 = max = the only observed value.

## What the variance analysis revealed

Beyond noise calibration, the analysis surfaced **real product
weaknesses** that no single eval run would have caught:

1. **`dg-3-decline` averages 3.2/10.** The draft-generator consistently
   fails the politely-decline scenario — commits on the user's behalf,
   asks irrelevant questions, doesn't actually decline. This is a real
   prompt weakness, not judge noise. The fixture should drive iteration
   on `DEFAULT_DRAFT_PROMPT` to improve declines.

2. **`dg-2-scheduling` has the widest variance (range 5, stddev 1.43).**
   Output quality genuinely varies — sometimes the draft picks a slot,
   sometimes it just echoes the offered slots back. Worth a prompt
   tweak that emphasizes "pick one" behavior.

3. **calendaring-agent + archive-ready-analyzer are strong.** Five of
   eight fixtures are deterministic 10s, the other three are narrow
   variance. Don't iterate; lock in.

## When to re-run

- After non-trivial changes to `DEFAULT_DRAFT_PROMPT`, `email-analyzer.ts`,
  `calendaring-agent.ts`, or any feature whose output is being evaluated.
- When a fixture's behavior changes (e.g., we add a new fixture).
- Before tightening the regression threshold.

After running, update `tests/evals/baselines/<feature>.json` with the
new p25 scores and bump the `generatedAt` timestamp.
