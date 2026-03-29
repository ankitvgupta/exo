# Exo

Desktop Gmail client with AI-powered email analysis and draft generation. Built with Electron, React, TypeScript, and Tailwind CSS.

## Features

- **Multi-account Gmail support** with OAuth authentication
- **AI-powered email analysis** — Claude detects which emails need replies
- **Draft generation** — AI-generated reply drafts with refinement
- **Sender lookup** — web search for sender context
- **Background sync** — incremental sync via Gmail History API
- **Executive assistant integration** — auto-CC and scheduling detection

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Set API Key

```bash
export ANTHROPIC_API_KEY=your_key_here
```

### 3. Run

```bash
npm run dev
```

### Demo Mode (no API keys needed)

```bash
npm run dev:demo
```

## Commands

```bash
npm run dev          # Start dev server
npm run dev:demo     # Demo mode with fake data
npm run build        # Production build
npm test             # Run all tests
npx tsc --noEmit     # Type check
```

## Configuration

All config lives under `~/Library/Application Support/exo/` on macOS.

See [CLAUDE.md](CLAUDE.md) for architecture details and data flows.
