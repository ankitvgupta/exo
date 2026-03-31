---
name: electron-devtools-testing
description: Test the Electron app interactively using Chrome DevTools Protocol. Use when the user asks to test, verify, or interact with the running app via browser automation.
---

Test the Exo Electron app interactively using Chrome DevTools Protocol (CDP) via the `chrome-devtools` MCP.

## Prerequisites

1. **chrome-devtools MCP must be configured** — add it to your MCP config:
   ```bash
   claude mcp add chrome-devtools -- npx -y chrome-devtools-mcp@latest --browser-url=http://127.0.0.1:9222
   ```

2. **App must be launched with remote debugging port**:
   ```bash
   npx electron-vite dev -- --remote-debugging-port=9222
   ```
   This exposes CDP on port 9222 so the MCP can connect to Electron's renderer process.

## How It Works

- Electron exposes a CDP endpoint at `http://127.0.0.1:9222` when launched with `--remote-debugging-port=9222`
- The `chrome-devtools` MCP connects to this endpoint and provides tools for page interaction
- You can navigate, click, type, take screenshots, and inspect the DOM — just like Chrome DevTools

## Workflow

1. **Start the app** (run in background so the terminal is free):
   ```bash
   npx electron-vite dev -- --remote-debugging-port=9222
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
- **Port conflicts**: If port 9222 is already in use, pick another port and update both the launch command and MCP config.
- **Multiple windows**: Electron may open multiple pages (main window, DevTools, etc). Always select the correct renderer page before interacting.
- **Hot reload**: `electron-vite dev` supports HMR. After code changes, the renderer reloads automatically but you may need to re-select the page.
