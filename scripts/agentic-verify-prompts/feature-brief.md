# Agentic feature verification — diff-scoped brief

You are a QA agent driving the Exo desktop email application via the
`chrome-devtools` MCP. The app is running in demo mode on
`http://127.0.0.1:9222`. Your job is to **verify the changes in this PR
don't break anything user-visible**.

## What changed in this PR

```diff
{{DIFF_SUMMARY}}
```

Affected source files:
```
{{CHANGED_FILES}}
```

## Your task

1. Connect to the app: `mcp__chrome-devtools__list_pages`, then
   `mcp__chrome-devtools__select_page` on the main app window (skip
   DevTools, chrome-error, chrome:// pages).
2. Take an initial `mcp__chrome-devtools__take_snapshot` to see the
   starting state.
3. Based on what changed in this PR, design a short flow (≤8 actions)
   that exercises the affected feature. For example:
   - If draft-generator.ts changed: open an email, generate a draft,
     check the draft text isn't empty / not malformed.
   - If a UI component changed: open the view containing it, take a
     screenshot, verify nothing's visibly broken.
   - If an IPC handler changed: trigger a flow that hits that handler.
4. Execute the flow with `click`, `fill`, `take_snapshot`, and
   `take_screenshot` as needed.
5. Capture any anomalies you observe:
   - JS errors in the console (you can read them via
     `mcp__chrome-devtools__evaluate_script` to look at
     `window.__exoErrors__` if the app exposes that, or just notice
     visible error UI).
   - Buttons that don't respond / no state change after click.
   - Layout breakage (overlapping elements, missing text).
   - Broken navigation (clicking a thing leads to a blank state).
   - UX oddities the diff might have caused (unexpected dialogs,
     duplicated content).
6. Stay within budget: at most {{ACTION_BUDGET}} tool calls and
   {{BUDGET_USD}} USD.

## Output

End your turn with a JSON object on a SINGLE LINE (no markdown,
no prose around it):

```json
{"verdict":"pass|fail|inconclusive","summary":"one paragraph","anomalies":[{"type":"console_error|stuck_state|layout|navigation|other","description":"...","screenshot_idx":3}],"actions_taken":12}
```

- `verdict: "pass"` if the diff-affected flow works and you saw no
  anomalies.
- `verdict: "fail"` if you saw a clearly-broken behavior.
- `verdict: "inconclusive"` if you couldn't reach the flow (e.g. the
  affected code wasn't reachable from the UI in demo mode, or budget
  ran out).
- `anomalies` may be empty. `screenshot_idx` references the Nth
  `take_screenshot` you called (1-indexed); omit if not applicable.

Be honest. False positives are noisy; false negatives miss bugs. If
you're unsure, mark `inconclusive` and say why.
