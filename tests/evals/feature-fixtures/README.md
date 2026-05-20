# Feature eval fixtures

One directory per AI feature, with N JSON fixtures inside. Each fixture is
graded by the LLM judge against its rubric.

## Directory layout

```
feature-fixtures/
├── draft-generator/        # IMPLEMENTED — 3 starter fixtures
│   ├── dg-1-direct-question.json
│   ├── dg-2-scheduling.json
│   └── dg-3-decline.json
├── calendaring-agent/      # TODO
├── sender-lookup/          # TODO
├── style-profiler/         # TODO
├── archive-ready-analyzer/ # TODO
├── analysis-edit-learner/  # TODO
└── draft-edit-learner/     # TODO
```

Baselines live at `tests/evals/baselines/<feature>.json` and are created
the first time you run `--update-baseline`.

## Fixture shape

```json
{
  "id": "unique-stable-id",
  "description": "one-line description of what this fixture tests",
  "input": { /* feature-specific shape — see tests/evals/features/<name>.ts */ },
  "rubric": "Markdown checklist of what good output looks like.\n- bullet\n- bullet",
  "expectedMinScore": 7
}
```

The `input` schema is defined by the feature's runFixture function in
`tests/evals/features/<feature>.ts`. The judge sees the rubric + the
feature's output — never the rubric inputs or expected score.

## Adding a feature

1. Create `tests/evals/features/<feature>.ts` exporting
   `async function runXxxFixture(input: unknown, fixtureId: string): Promise<string>`.
2. Register it in `tests/evals/feature-evals.ts` under `FEATURES`.
3. Drop fixture JSON files in `feature-fixtures/<feature>/`.
4. Run `npm run eval:features -- --feature <name> --update-baseline`
   once to capture the initial baseline.
5. Remove the feature from `TODO_FEATURES` in `feature-evals.ts`.

## Known limitation: Electron-imports in service modules

The existing analyzer runner (`tests/evals/runner.ts`) works with plain
`tsx` because `email-analyzer.ts` uses lazy `await import()` for any
chain that ultimately imports `electron` (e.g. via `../db` →
`../data-dir`). Other services like `draft-generator.ts` import the
same chains eagerly at module load — running their evals via plain
`tsx` crashes with `'electron' does not provide an export named
'BrowserWindow'`.

Options to address per-feature:

- **Easiest**: add the same lazy-import pattern that `email-analyzer.ts`
  uses (see lines 1-25 of that file for the template). Small change in
  the prod service; no behavior change.
- **Alternative**: run feature-evals inside an Electron test context
  (a Playwright project) — heavier but no prod changes needed.

The framework here works the moment one of those is done for a given
feature. The `draft-generator` starter fixtures are committed so the
fixture format is established; the runner crashes today on the
electron import (filed as TODO in this README).
