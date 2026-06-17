# Claude Code Instructions

Follow `AGENTS.md`; it is the canonical repo guidance for all coding agents.

Claude-specific notes:

- Project skills are exposed through `.claude/skills/`, but the real shared skill content lives in `skills/`. Edit `skills/`, not the symlink entrypoints.
- Claude MCP config lives in `.claude/mcp.json`. It currently defines `chrome-devtools` and `posthog`.
- Claude permission and plugin allowlists live in `.claude/settings.json`.
- For long-running shell commands in Claude Code, use the Bash tool's `run_in_background` support instead of shell-backgrounding with `&`.
