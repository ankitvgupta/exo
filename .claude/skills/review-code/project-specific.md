# Project-Specific Review Context

Architecture-specific context for the Exo mail client. Each review agent should consult its section for project context that goes beyond the general patterns in SKILL.md. The general patterns already cover the principles — this file tells you WHERE those principles apply in this codebase and which areas have historically been fragile.

---

## Agent 1 — Type Safety

Key type boundaries to verify:
- `IpcResponse<T>` generic params must match handler return types (handlers may return `T | null`)
- `window.api` types are declared inline in multiple components — check consistency against `src/preload/index.ts`
- `ComposeAttachment` shape differs between preload and shared types with no compile-time check
- Zod schemas in `src/shared/types.ts` must stay in sync with TypeScript interfaces

---

## Agent 2 — IPC Contract

This is the #1 bug source. ~100+ IPC channels but `IpcChannels` type covers only ~12.

- **Demo mode**: Every IPC handler needs `if (useFakeData)` early return or e2e tests crash
- **Event coverage**: Main emits `sync:new-emails`, `sync:emails-removed`, `sync:emails-updated`, `sync:status-change`, `sync:action-failed`, `sync:action-succeeded` — each needs a matching `App.tsx` listener
- **Response shapes**: Some handlers return `{ data }`, others `{ queued: true }` — consumers must handle both
- **camelCase/snake_case**: `DashboardEmail` (camelCase) ↔ `AnalysisResult` (snake_case), converted in IPC handlers. New fields need conversion in both directions.
- **Settings propagation**: Changing API key/model must reset cached Anthropic clients and propagate to utility process workers

---

## Agent 3 — Database & Data Integrity

- `label_ids` stored as JSON string ↔ `DashboardEmail.labelIds: string[]` — serialization must be explicit
- Store state in `src/renderer/store/index.ts` must match IPC handler return shapes
- `saveDraftAndSync` passing empty options defeats COALESCE (`? IS NOT NULL` becomes true → clears CC/BCC)
- `clearInboxPendingDrafts` has order-dependent JOINs — call order matters

---

## Agent 4 — React Patterns & State Management

- **Optimistic update + pending queue**: Established pattern for email actions — new actions should follow it
- **IPC event listeners**: New events need listeners in `App.tsx` useEffect block
- **EmailDetail state reset**: New local state MUST be added to the useLayoutEffect that resets on thread switch (repeatedly flagged by both Greptile and Devin)
- **expandedMessages**: When email IDs change (optimistic → real), Maps/Sets tracking expanded state must update
- **Editor-specific**: Tab+autocomplete stale blur, Shift+Tab shiftKey, Escape key plugin exit, stale position in paste/drop async handlers

---

## Agent 5 — Test Quality

- `launchElectronApp()` must receive `{ workerIndex: testInfo.workerIndex }` for DB isolation
- electron-store config changes in tests need cleanup between workers

---

## Agent 6 — Async Logic & Race Conditions

Key functions/patterns to watch:
- `removeEmails|clearSelected|setViewMode` BEFORE await — the #1 async bug in this codebase
- Compare button handlers against `useKeyboardShortcuts.ts` implementations (shortcuts are typically correct, button handlers diverge)
- `useAppStore.getState()` captured before async gap — re-read after await
- `runAgent(...)` and `waitForCompletion()` — missing await / unresolved promises
- `isRetryableError` matching user-initiated 'aborted' — cancelled ops get retried

---

## Agent 7 — Error Handling & Resource Leaks

- `window.api.on` without matching `window.api.off` in cleanup — project-specific IPC listener pattern
- `{ success: true, data: { success: false } }` nesting — outer success misleads consumers

---

## Agent 8 — Security

XSS surfaces specific to this app: email body, quoted content, signature preview, agent tool output — all need DOMPurify.
- MCP server config env vars could override `ANTHROPIC_API_KEY`
- Access tokens stored without encryption alongside encrypted refresh tokens

---

## Agent 9 — Data Loss & Field Preservation

This is the #2 bug category. The core issue: draft operations that don't spread existing fields.

- **Historically lost fields**: `cc`, `bcc`, `calendaringResult`, `attachments`, `agentTaskId`, `subject` — any code touching `saveDraft`, `createDraft`, `sendMessage`, `queueToOutbox` must preserve all of these
- **`agent_task_id`**: Should be preserved on edit, only cleared on full regeneration
- **Outbox table schema**: Must have columns for all composition fields
- **`extractReplyAllCc` regex**: Drops addresses with `+` character

---

## Agent 10 — Cross-Account Safety

- Cache keys must use `${accountId}:${threadId}` format
- IPC event handlers must filter by `accountId`
- `selectedThreadIds` must clear on account switch
- Use `currentAccountId` from store, not `accounts[0]`
- Demo mode: DB uses `me@example.com` but handler returns `demo@example.com`
- Type confusion: `Account` vs `AccountRecord` vs `AccountInfo`
- Unsnoozed return times map grows unbounded

---

## Agent 11 — Email/RFC Compliance

Project-specific functions to watch:
- `hasRichFormatting` — missing `<p>` tag check
- `isHtml` — false positives from angle brackets in plain text
- "On ... wrote:" attribution parser — multi-line handling

---

## Agent 12 — Build & Packaging

- `asar.unpack` glob `**/node_modules/@anthropic-ai/**` is too broad — only runtime files needed
- DER signature parsing uses hardcoded byte offsets (fragile)
- API key written to temp file creates security window
- Migration `copyFile` catch swallows non-ENOENT errors

---

## Agent 13 — Concurrency & Performance

Project-specific hotspots:
- `processAllPending` and `processAnalysis` both queue the same items → dedup needed
- In-flight agents not cancelled before regenerate → both run simultaneously
- Manual operations bypass `MAX_CONCURRENT` pool
- `getConfig()` called on every invocation instead of caching
- `emailId:theme` cache key ignores body content changes
- Sent thread computation runs on every render (not memoized)

---

## Agent 14 — Agent/AI Integration

- `persistTaskEvents` hardcodes status instead of using parameter
- `cancelAll()` scope too broad
- `save_memory` tool uses `accounts[0]` instead of active account
- Worker provider list empty on first task (init race)
- Stale Anthropic clients after settings change
- Running agents not cancelled on prompt/settings change
- Orphaned agent traces in DB after cancellation

---

## False Positive Filters

- Dark mode styling issues (many false positives historically)

---

## File Reading Hints

- **Services**: read the prefetch service if it queues work
- **Agents/tools**: read the coordinator, worker, and renderer-side agent state
