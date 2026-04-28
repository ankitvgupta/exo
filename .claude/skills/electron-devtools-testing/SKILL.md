---
name: electron-devtools-testing
description: Test the Electron app interactively using Chrome DevTools Protocol. Use when the user asks to test, verify, or interact with the running app via browser automation.
---

Test the Exo Electron app interactively using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP.

## Prerequisites

1. **chrome-devtools MCP must be configured** — add it to your MCP config:
   ```bash
   claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9223
   ```

   Port `9223` (not the chrome-devtools-mcp default of `9222`) avoids conflicting
   with the user's main Chrome browser, which on this machine already runs with
   `--remote-debugging-port=9222` for the browser-harness setup. If you change
   the port here, you must change BOTH the MCP `--browser-url` AND the Electron
   launch flag below to match.

2. **App must be launched with remote debugging port**:
   ```bash
   EXO_DEMO_MODE=true npm run dev -- --remote-debugging-port=9223
   ```
   This exposes CDP on port 9223 so the MCP can connect to Electron's renderer process.
   `npm run dev` is preferred over `npx electron-vite dev` directly because the
   `dev` script also runs `npm run build:worker` first — without that, the agent
   sidebar fails to start with "Agent worker failed to start" since the bundled
   utility-process worker file is missing.

## How It Works

- Electron exposes a CDP endpoint at `http://127.0.0.1:9223` when launched with `--remote-debugging-port=9223`
- The `chrome-devtools` MCP connects to this endpoint and provides tools for page interaction
- You can navigate, click, type, take screenshots, and inspect the DOM — just like Chrome DevTools

## Workflow

1. **Start the app** (run in background so the terminal is free):
   ```bash
   EXO_DEMO_MODE=true npm run dev -- --remote-debugging-port=9223
   ```
   Wait for the dev server to be ready (look for "dev server running" or similar output).

2. **List available pages**:
   Use `mcp__chrome-devtools__list_pages` to see Electron's renderer windows.

3. **Select the main window**:
   Use `mcp__chrome-devtools__select_page` with the page ID of the main app window (not DevTools or blank pages).

4. **Take a snapshot** to see the current UI state:
   Use `mcp__chrome-devtools__take_snapshot` to get an accessibility tree of the page.

5. **Interact with the app**:
   - `mcp__chrome-devtools__click` — click buttons, links, tabs
   - `mcp__chrome-devtools__fill` — type into inputs and textareas
   - `mcp__chrome-devtools__take_screenshot` — capture visual state
   - `mcp__chrome-devtools__evaluate_script` — run JS in the renderer context

6. **Stop the app** when done by killing the background process.

## Key UI Navigation

| Action | How |
|--------|-----|
| Open Settings | Click the gear icon in the top bar |
| Switch to Prompts tab | Click "Prompts" tab inside Settings |
| Edit a prompt | Click into the textarea and modify text |
| Save prompts | Click the "Save" button |
| Close Settings | Click "X" or press Escape |
| Switch accounts | Click account selector in the sidebar |

## Notes

- **Demo mode**: When launched with `EXO_DEMO_MODE=true`, the app uses mock data and makes no real Gmail API calls. Useful for testing UI without credentials.
- **Port conflicts**: If port 9223 is already in use, pick another port and update BOTH the launch flag AND the MCP `--browser-url` (then restart Claude Code so the MCP config takes effect — the MCP subprocess only reads its args at startup).
- **Stale Electron processes**: `pkill -f "electron-vite dev"` doesn't always kill all child Electron processes from prior dev sessions. If the MCP attaches to a stale Electron whose source code is out of date with the disk, code changes will appear to silently no-op. Use `pkill -9 -f "managua-v1.*Electron.app"` and `pkill -9 -f "electron-vite dev.*--remote-debugging-port=9223"` to be sure, then verify with `ps aux | grep -E "Electron.app\|electron-vite" | grep managua | grep -v grep | wc -l` returning 0.
- **Multiple windows**: Electron may open multiple pages (main window, DevTools, etc). Always select the correct renderer page before interacting.
- **Hot reload**: `electron-vite dev` supports HMR for the renderer. After main-process code changes, you must restart the app — main-process code does NOT hot-reload.
- **Worker bundle is separate**: `src/main/agents/agent-worker.ts` and code it imports get bundled into `out/worker/agent-worker.cjs` by `npm run build:worker`. After changes to the agent worker, the bundle must rebuild — `npm run dev` does this automatically; `npx electron-vite dev` does NOT.

## Driving the agent directly via IPC

To trigger an agent task without simulating Cmd+J + typing in the palette:

```js
mcp__chrome-devtools__evaluate_script({
  function: `async () => {
    const taskId = "test-" + Date.now();
    return await window.api.agent.run(
      taskId,
      ["claude"],          // provider id is "claude" (not "claude-agent")
      "Reply with OK",
      { accountId: "default", userEmail: "me@example.com" }
    );
  }`,
})
```

Then poll the trace:
```js
mcp__chrome-devtools__evaluate_script({
  function: `async () => await window.api.agent.getTrace("<taskId>")`,
})
```

The trace returns `{ events: [...] }` with `state`, `tool_call_start`, `tool_call_end`, `text_delta`, and `done` events.
