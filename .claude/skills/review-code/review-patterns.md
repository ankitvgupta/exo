# Generalized Review Patterns

Patterns organized by review agent category. Each pattern includes detection heuristics, production impact, and fix templates. Patterns are derived from confirmed bugs across 150+ PRs in this codebase, generalized for reuse.

---

## Section 1: Type Safety & References (Agent 1)

### Pattern: Implicit `any` from Untyped Import
- **Category**: TypeScript / Type Safety
- **What to look for**: `import X from 'untyped-module'` where the module has no `@types/` package or local `.d.ts`
- **Why it's a bug**: TypeScript treats all values as `any`, hiding type errors throughout the consumer. Violates CLAUDE.md "NEVER use `any`" rule.
- **The correct pattern**:
```ts
// BAD: no types available
import parser from 'some-untyped-lib';
parser.parse(data); // parser is any, data errors hidden

// GOOD: add declaration
// src/types/some-untyped-lib.d.ts
declare module 'some-untyped-lib' {
  export function parse(data: string): ParsedResult;
}
```
- **Confidence heuristic**: HIGH if the import is used in new code with property access or passed to typed functions. MEDIUM if only used in one place with obvious semantics.

---

### Pattern: Type Assertion Bypassing Null Check
- **Category**: TypeScript / Null Safety
- **What to look for**: `value as SomeType` without prior `null`/`undefined` check, especially when value comes from async/optional source
- **Why it's a bug**: Runtime null access crash when value is actually null/undefined. The assertion silences TypeScript but doesn't prevent the runtime error.
- **The correct pattern**:
```ts
// BAD
const email = getEmail(id) as Email;
console.log(email.subject); // crash if null

// GOOD
const email = getEmail(id);
if (!email) {
  throw new Error(`Email ${id} not found`);
}
email.subject; // TypeScript knows non-null here
```
- **Confidence heuristic**: HIGH (90) if value comes from DB query, Map.get(), or async IPC call. MEDIUM if value is from a guaranteed source like a filtered array.

---

### Pattern: IpcResponse Generic Mismatch
- **Category**: TypeScript / IPC
- **What to look for**: Handler returns `T | null` but caller expects `IpcResponse<T>` with guaranteed `.data` property access
- **Why it's a bug**: Crash on `.data` access when result is null. Confirmed from PRs #43, #44.
- **The correct pattern**:
```ts
// BAD: caller assumes data exists
const result = await window.api.getAnalysis(id);
setAnalysis(result.data); // crash when data is null

// GOOD: check before access
const result = await window.api.getAnalysis(id);
if (result.success && result.data) {
  setAnalysis(result.data);
}
```
- **Confidence heuristic**: HIGH (95) when handler has nullable return path. Check the handler implementation to verify.

---

### Pattern: Divergent Window.api Type Declarations
- **Category**: TypeScript / Interface Drift
- **What to look for**: `declare global { interface Window { api: { ... } } }` in component files that overlap with but differ from `src/preload/index.ts`
- **Why it's a bug**: Component's type declaration drifts from actual preload implementation. TypeScript says method exists but preload doesn't expose it, or vice versa.
- **The correct pattern**:
```ts
// BAD: component declares its own window.api shape
declare global {
  interface Window {
    api: {
      getEmails: () => Promise<Email[]>; // different return type than preload
    };
  }
}

// GOOD: import types from shared declaration
import type { PreloadApi } from '../preload/types';
// or use typeof preloadApi
```
- **Confidence heuristic**: MEDIUM when shapes overlap. HIGH when the shapes actually diverge on a method the component calls.

---

### Pattern: Zod Schema / TypeScript Interface Drift
- **Category**: TypeScript / Validation
- **What to look for**: Changes to a Zod schema in `types.ts` without matching TypeScript interface update, or vice versa
- **Why it's a bug**: Runtime validation (Zod) passes but TypeScript compile fails, or TypeScript compiles but runtime validation rejects valid data.
- **The correct pattern**:
```ts
// BAD: separate Zod schema and interface
const EmailSchema = z.object({ subject: z.string(), priority: z.number() });
interface Email { subject: string; priority: string; } // mismatch: number vs string

// GOOD: derive type from Zod
const EmailSchema = z.object({ subject: z.string(), priority: z.number() });
type Email = z.infer<typeof EmailSchema>;
```
- **Confidence heuristic**: HIGH if both exist in the same file or module. MEDIUM if they're in different files but clearly represent the same entity.

---

### Pattern: Unused Import from Diff
- **Category**: TypeScript / Dead Code
- **What to look for**: New import added in diff but symbol never referenced in the changed file
- **Why it's a bug**: Dead code at minimum. May indicate a forgotten usage — the developer intended to use the import but didn't.
- **The correct pattern**: Remove unused import, or add the intended usage.
- **Confidence heuristic**: MEDIUM for utility imports. HIGH if the import is a service or handler that was clearly meant to be called.

---

## Section 2: IPC Contract Consistency (Agent 2)

### Pattern: Missing Preload Bridge Method
- **Category**: Electron / IPC
- **What to look for**: New `ipcMain.handle('channel:name')` in `src/main/ipc/*.ipc.ts` without corresponding `ipcRenderer.invoke('channel:name')` in `src/preload/index.ts`
- **Why it's a bug**: Handler is unreachable from renderer — dead code or half-implemented feature.
- **The correct pattern**:
```ts
// main/ipc/drafts.ipc.ts
ipcMain.handle('drafts:refine', async (_, args) => { ... });

// preload/index.ts — MUST add this
refineDraft: (args: RefineArgs) => ipcRenderer.invoke('drafts:refine', args),
```
- **Confidence heuristic**: HIGH (90) if the handler is newly added in the diff. LOW if it's a handler used only by main-process code.

---

### Pattern: Missing Demo Mode Branch
- **Category**: Electron / Testing
- **What to look for**: New IPC handler without `if (useFakeData)` early return
- **Why it's a bug**: Tests and demo mode crash or make real API calls. Confirmed across PRs #22, #124.
- **The correct pattern**:
```ts
// BAD: no demo mode handling
ipcMain.handle('analysis:run', async (_, emailId) => {
  const result = await analyzer.analyze(emailId);
  return { success: true, data: result };
});

// GOOD: demo mode early return
ipcMain.handle('analysis:run', async (_, emailId) => {
  if (useFakeData) {
    return { success: true, data: mockAnalysis };
  }
  const result = await analyzer.analyze(emailId);
  return { success: true, data: result };
});
```
- **Confidence heuristic**: HIGH (90) for any new handler that calls external APIs or DB.

---

### Pattern: IPC Event Without Renderer Listener
- **Category**: Electron / IPC Events
- **What to look for**: `mainWindow.webContents.send('event-name', data)` without matching `window.api.on('event-name', callback)` listener in `App.tsx`
- **Why it's a bug**: Main process fires event but no one handles it — silent failure. Data updates never reach the UI.
- **The correct pattern**:
```ts
// main process emits
mainWindow.webContents.send('sync:new-emails', { accountId, emails });

// App.tsx MUST have listener with cleanup
useEffect(() => {
  const cleanup = window.api.on('sync:new-emails', (data) => {
    addEmails(data.emails);
  });
  return cleanup;
}, []);
```
- **Confidence heuristic**: HIGH if the event carries data that should update UI state.

---

### Pattern: Settings Change Not Propagating
- **Category**: Electron / Configuration
- **What to look for**: Settings change IPC handler that stores new value but doesn't invalidate cached service instances
- **Why it's a bug**: Cached clients continue using stale config (API keys, model names). Confirmed from PR #146: changing API key didn't reset Anthropic clients.
- **The correct pattern**:
```ts
// BAD: store new key but keep old client
ipcMain.handle('settings:set-api-key', async (_, key) => {
  config.set('apiKey', key);
  return { success: true };
});

// GOOD: reset cached instances
ipcMain.handle('settings:set-api-key', async (_, key) => {
  config.set('apiKey', key);
  analyzerInstance = null;   // force re-creation with new key
  draftGenInstance = null;
  return { success: true };
});
```
- **Confidence heuristic**: HIGH (90) when the setting affects a cached service. MEDIUM for UI-only settings.

---

### Pattern: Queued Response Not Handled
- **Category**: Electron / IPC Response
- **What to look for**: IPC response with `{ queued: true }` flag but consumer only checks `.data`
- **Why it's a bug**: Consumer treats queued operation as completed, showing incorrect UI state.
- **The correct pattern**:
```ts
// BAD
const result = await window.api.sendDraft(draft);
if (result.success) {
  showToast('Sent!'); // wrong: it's queued, not sent
}

// GOOD
const result = await window.api.sendDraft(draft);
if (result.success && result.queued) {
  showToast('Queued for sending');
} else if (result.success) {
  showToast('Sent!');
}
```
- **Confidence heuristic**: HIGH if the handler returns queued responses (check for offline/queue logic).

---

## Section 3: Database & Data Integrity (Agent 3)

### Pattern: INSERT OR REPLACE Resetting Flags
- **Category**: SQLite / Data Integrity
- **What to look for**: `INSERT OR REPLACE INTO` on table with boolean/flag columns (e.g., `dismissed`, `is_read`, `is_starred`)
- **Why it's a bug**: All non-specified columns reset to defaults (usually 0/NULL). User's dismissed flag, read status, etc. silently lost. Confirmed in PR #22.
- **The correct pattern**:
```sql
-- BAD: resets dismissed to 0
INSERT OR REPLACE INTO analyses (email_id, needs_reply, dismissed)
VALUES (?, ?, 0);

-- GOOD: preserve existing flag
INSERT INTO analyses (email_id, needs_reply, dismissed)
VALUES (?, ?, 0)
ON CONFLICT(email_id) DO UPDATE SET
  needs_reply = excluded.needs_reply,
  dismissed = CASE WHEN analyses.dismissed = 1 THEN 1 ELSE excluded.dismissed END;
```
- **Confidence heuristic**: HIGH (95) when the table has user-mutable flags. Check schema.ts for boolean columns.

---

### Pattern: LIKE Substring False Match
- **Category**: SQLite / Query Correctness
- **What to look for**: `LIKE '%"VALUE"%'` on JSON string columns
- **Why it's a bug**: Matches any value containing the substring. `LIKE '%"SENT"%'` matches `"SENTIMENT"`, `"UNSENT"`, etc. Confirmed in PRs #36, #75, #79, #105.
- **The correct pattern**:
```sql
-- BAD: matches SENTIMENT, UNSENT, etc.
WHERE label_ids LIKE '%"SENT"%'

-- GOOD: use json_each for exact match
WHERE EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = 'SENT')

-- GOOD (simpler but less robust): exact JSON element match
WHERE label_ids LIKE '%"SENT"%' AND label_ids NOT LIKE '%"UNSENT"%'
```
- **Confidence heuristic**: HIGH (90) when querying JSON columns. Check if the search value is a substring of other valid values.

---

### Pattern: COALESCE Preserving Stale Values
- **Category**: SQLite / Update Logic
- **What to look for**: `COALESCE(?, column)` in UPDATE/INSERT where the column should be reset on regeneration
- **Why it's a bug**: Passing NULL preserves old value instead of clearing it. Stale `gmail_draft_id` preserved after regeneration (PR #133). `saveDraftAndSync` always passing options defeating COALESCE (PR #139).
- **The correct pattern**:
```sql
-- BAD: COALESCE keeps stale gmail_draft_id on regeneration
UPDATE drafts SET
  body = ?,
  gmail_draft_id = COALESCE(?, gmail_draft_id)
WHERE id = ?;

-- GOOD: explicit NULL when regenerating
UPDATE drafts SET
  body = ?,
  gmail_draft_id = NULL  -- clear on regeneration
WHERE id = ?;
```
- **Confidence heuristic**: HIGH if the operation is a regeneration/reset. MEDIUM for optional field updates where COALESCE is intentional.

---

### Pattern: Missing accountId in WHERE
- **Category**: SQLite / Multi-Account
- **What to look for**: SELECT/UPDATE/DELETE on per-account tables without `WHERE accountId = ?`
- **Why it's a bug**: Returns or modifies data from all accounts — cross-account data leaks. Confirmed in PRs #22, #34.
- **The correct pattern**:
```sql
-- BAD: no account scoping
SELECT * FROM emails WHERE thread_id = ?;

-- GOOD: scoped to account
SELECT * FROM emails WHERE thread_id = ? AND account_id = ?;
```
- **Confidence heuristic**: HIGH (95) for any query on `emails`, `analyses`, `drafts`, `sender_profiles`, or `sync_state` tables.

---

### Pattern: Column Name Mismatch with Schema
- **Category**: SQLite / Schema
- **What to look for**: SQL column name in query that doesn't exist in `schema.ts` table definition
- **Why it's a bug**: Query fails at runtime with "no such column" error.
- **The correct pattern**: Cross-reference every column name in new SQL against `src/main/db/schema.ts`. Update both if renaming.
- **Confidence heuristic**: HIGH (95) — immediate runtime error. Always verify against schema.

---

### Pattern: JSON Column Without Serialization
- **Category**: SQLite / Serialization
- **What to look for**: Reading or writing a JSON column (e.g., `label_ids`, `attachments`) without `JSON.parse`/`JSON.stringify`
- **Why it's a bug**: Stores `"[object Object]"` on write, or reads raw JSON string as value on read.
- **The correct pattern**:
```ts
// Write
db.run('INSERT INTO emails (label_ids) VALUES (?)', JSON.stringify(labelIds));

// Read
const row = db.get('SELECT label_ids FROM emails WHERE id = ?', id);
const labelIds: string[] = JSON.parse(row.label_ids || '[]');
```
- **Confidence heuristic**: HIGH if the column stores arrays or objects. Check schema.ts for TEXT columns that hold structured data.

---

## Section 4: React Patterns & State Management (Agent 4)

### Pattern: Stale Closure in Async Hook Callback
- **Category**: React / Async
- **What to look for**: `useCallback` with async body referencing a state variable that's not in the dependency array
- **Why it's a bug**: Callback captures stale state value at closure creation time. Sends wrong data or makes wrong decision. Confirmed from PR #40: `composeAttachments` missing from `handleSend` deps.
- **The correct pattern**:
```tsx
// BAD: attachments stale in closure
const handleSend = useCallback(async () => {
  await sendEmail({ body, attachments }); // attachments is stale
}, [body]); // missing attachments

// GOOD: all referenced state in deps
const handleSend = useCallback(async () => {
  await sendEmail({ body, attachments });
}, [body, attachments]);

// ALTERNATIVE: useRef for values that change often
const attachmentsRef = useRef(attachments);
useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);
```
- **Confidence heuristic**: HIGH (90) when the missing dep is used in an API call or state update. MEDIUM for deps used only in logging.

---

### Pattern: Rules of Hooks Violation
- **Category**: React / Hooks
- **What to look for**: Hook call (`useState`, `useRef`, `useCallback`, `useEffect`, etc.) appearing after a conditional `return` statement
- **Why it's a bug**: React crashes with "Rendered fewer hooks than expected" on the conditional path. Confirmed in PR #41.
- **The correct pattern**:
```tsx
// BAD: hooks after conditional return
function EmailDetail({ email }: Props) {
  if (!email) return <Empty />;
  const [draft, setDraft] = useState(''); // CRASH: fewer hooks on null path
  // ...
}

// GOOD: all hooks before any conditional returns
function EmailDetail({ email }: Props) {
  const [draft, setDraft] = useState('');
  if (!email) return <Empty />;
  // ...
}
```
- **Confidence heuristic**: HIGH (95) — immediate crash on the conditional path.

---

### Pattern: useRef for Values That Affect Render
- **Category**: React / State
- **What to look for**: `useRef` storing a value that appears in JSX output or determines what's rendered
- **Why it's a bug**: Changing ref value doesn't trigger re-render — user sees stale data. Confirmed in PR #58.
- **The correct pattern**:
```tsx
// BAD: ref change won't re-render
const selectedTab = useRef('inbox');
return <div>{selectedTab.current === 'inbox' ? <Inbox /> : <Sent />}</div>;

// GOOD: useState triggers re-render
const [selectedTab, setSelectedTab] = useState('inbox');
return <div>{selectedTab === 'inbox' ? <Inbox /> : <Sent />}</div>;
```
- **Confidence heuristic**: HIGH if the ref value flows into JSX or a conditional rendering path.

---

### Pattern: Missing State Reset on Context Switch
- **Category**: React / State Lifecycle
- **What to look for**: New `useState` in `EmailDetail` (or similar reused component) without corresponding reset in the `useLayoutEffect` that runs on thread/email switch
- **Why it's a bug**: State from previous email bleeds into new email view. User sees stale errors, loading states, or draft data. Confirmed pattern from PRs #17, #44, #95, #96.
- **The correct pattern**:
```tsx
// When adding new state:
const [newFeatureState, setNewFeatureState] = useState(false);

// MUST add reset to existing useLayoutEffect
useLayoutEffect(() => {
  setDraftError(null);
  setIsLoading(false);
  setNewFeatureState(false); // <-- add this
}, [threadId]);
```
- **Confidence heuristic**: HIGH (90) for any new state in EmailDetail. Check that the reset useLayoutEffect includes the new setter.

---

### Pattern: Timer Without Cleanup
- **Category**: React / Effects
- **What to look for**: `setTimeout`/`setInterval` in `useEffect` without storing handle and returning cleanup function
- **Why it's a bug**: Timer fires after unmount — setState on unmounted component, memory leak, potential crash. Confirmed in PRs #117, #122, #139.
- **The correct pattern**:
```tsx
// BAD: no cleanup
useEffect(() => {
  setTimeout(() => setStatus('done'), 3000);
}, []);

// GOOD: cleanup on unmount
useEffect(() => {
  const timer = setTimeout(() => setStatus('done'), 3000);
  return () => clearTimeout(timer);
}, []);
```
- **Confidence heuristic**: HIGH if the timer triggers state updates. MEDIUM for timers that only log.

---

### Pattern: Dependency Array Boolean Collapse
- **Category**: React / Effects
- **What to look for**: `[someArray.length > 0]` or `[!!value]` in dependency array
- **Why it's a bug**: Effect doesn't re-run when value changes between truthy values (e.g., length 1 → 5 both collapse to `true`). Confirmed in PR #19.
- **The correct pattern**:
```tsx
// BAD: effect runs on false→true and true→false only
useEffect(() => { ... }, [emails.length > 0]);

// GOOD: effect runs on actual count changes
useEffect(() => { ... }, [emails.length]);
```
- **Confidence heuristic**: MEDIUM — only a bug if the effect should re-run on value changes, not just presence changes.

---

### Pattern: Object Literal in JSX Props
- **Category**: React / Performance
- **What to look for**: `<Component style={{ ... }}/>` or `options={[...]}` inline in JSX
- **Why it's a bug**: Creates new reference on every render — unnecessary child re-renders if child uses React.memo or shouldComponentUpdate.
- **The correct pattern**:
```tsx
// BAD: new object every render
<EmailRow style={{ padding: 8, margin: 4 }} />

// GOOD: stable reference
const rowStyle = useMemo(() => ({ padding: 8, margin: 4 }), []);
<EmailRow style={rowStyle} />

// GOOD: module-level constant if no dynamic values
const ROW_STYLE = { padding: 8, margin: 4 } as const;
```
- **Confidence heuristic**: LOW-MEDIUM — only impactful if the child does expensive rendering or the parent renders frequently.

---

### Pattern: Ref Mutation During Render
- **Category**: React / Concurrent Mode
- **What to look for**: `someRef.current = value` in the render function body (not inside `useEffect` or `useLayoutEffect`)
- **Why it's a bug**: Breaks React Concurrent Mode. Ref may be mutated during aborted renders, leaving inconsistent state. Confirmed in PR #147.
- **The correct pattern**:
```tsx
// BAD: mutation during render
function Component({ value }) {
  const ref = useRef(value);
  ref.current = value; // mutation during render body

  // GOOD: mutation in effect
  useEffect(() => {
    ref.current = value;
  }, [value]);
}
```
- **Confidence heuristic**: HIGH in React 18+ with concurrent features enabled.

---

### Pattern: iframe.onload After src Assignment
- **Category**: React / DOM Timing
- **What to look for**: `iframe.src = url; iframe.onload = handler;` — src assigned before onload handler
- **Why it's a bug**: iframe may load synchronously (cached content) before handler is set — onload never fires. Confirmed in PR #39.
- **The correct pattern**:
```ts
// BAD: handler set after src
iframe.src = emailContentUrl;
iframe.onload = () => adjustHeight();

// GOOD: handler set before src
iframe.onload = () => adjustHeight();
iframe.src = emailContentUrl;
```
- **Confidence heuristic**: HIGH (90) — especially for cached/local content.

---

### Pattern: Escape Key Handler Without Proper Cleanup
- **Category**: React / Events
- **What to look for**: Event handler for Escape key that calls `preventDefault()` unconditionally
- **Why it's a bug**: Prevents other Escape handlers (dropdowns, modals) from working. Confirmed in PR #119.
- **The correct pattern**:
```ts
// BAD: unconditional prevent
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault(); // blocks ALL other Escape handlers
    closePanel();
  }
};

// GOOD: only preventDefault when actually consuming
const handleKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && isPanelOpen) {
    e.preventDefault();
    closePanel();
  }
};
```
- **Confidence heuristic**: MEDIUM — depends on how many Escape handlers coexist.

---

## Section 5: Test Quality & Infrastructure (Agent 5)

### Pattern: Missing workerIndex for DB Isolation
- **Category**: Testing / Isolation
- **What to look for**: `launchElectronApp()` call without `{ workerIndex: testInfo.workerIndex }`
- **Why it's a bug**: Tests share database file — cross-test contamination, flaky failures. Confirmed pattern in PR #46.
- **The correct pattern**:
```ts
// BAD: shared DB
test.beforeAll(async () => {
  app = await launchElectronApp();
});

// GOOD: per-worker DB
test.beforeAll(async ({ }, testInfo) => {
  app = await launchElectronApp({ workerIndex: testInfo.workerIndex });
});
```
- **Confidence heuristic**: HIGH (90) for any test that reads/writes DB state.

---

### Pattern: Platform-Specific Keyboard Shortcut in Test
- **Category**: Testing / Cross-Platform
- **What to look for**: `Meta+k`, `Cmd+` in test assertions on a CI system that runs Linux
- **Why it's a bug**: Meta/Cmd doesn't work on Linux — test always fails on CI. Confirmed in PR #32.
- **The correct pattern**:
```ts
// BAD: Mac-only shortcut
await page.keyboard.press('Meta+k');

// GOOD: platform-aware
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
await page.keyboard.press(`${modifier}+k`);
```
- **Confidence heuristic**: HIGH if CI runs on Linux.

---

### Pattern: Assertion on Virtualized Row Count
- **Category**: Testing / Virtual Lists
- **What to look for**: `expect(rows).toHaveLength(totalItems)` with tanstack-virtual or any virtualizer
- **Why it's a bug**: Virtualizer only renders visible rows — count depends on viewport height, not total items. Confirmed in PR #147.
- **The correct pattern**:
```ts
// BAD: assumes all rows rendered
const rows = page.locator('.email-row');
await expect(rows).toHaveCount(50); // fails: only 15 visible

// GOOD: assert visible subset
await expect(rows.first()).toBeVisible();
await expect(page.getByText('Showing 50 emails')).toBeVisible();
```
- **Confidence heuristic**: HIGH if using tanstack-virtual or any windowed list.

---

### Pattern: Click Without Visibility Check
- **Category**: Testing / Robustness
- **What to look for**: `await page.click('selector')` without prior visibility assertion
- **Why it's a bug**: Clicks on non-existent or hidden element — confusing test failure message. Confirmed in PR #38.
- **The correct pattern**:
```ts
// BAD: confusing failure
await page.click('.draft-button');

// GOOD: clear failure message
const draftBtn = page.locator('.draft-button');
await expect(draftBtn).toBeVisible();
await draftBtn.click();
```
- **Confidence heuristic**: MEDIUM — often works but fragile in dynamic UIs.

---

### Pattern: SIGKILL on Already-Exited Process
- **Category**: Testing / Cleanup
- **What to look for**: `process.kill(pid, 'SIGKILL')` in test cleanup without checking if process still running
- **Why it's a bug**: Throws ESRCH error — test cleanup fails — subsequent tests broken. Confirmed in PR #119.
- **The correct pattern**:
```ts
// BAD: crashes if already exited
process.kill(pid, 'SIGKILL');

// GOOD: check first
try {
  process.kill(pid, 0); // check if alive (signal 0)
  process.kill(pid, 'SIGKILL');
} catch {
  // already exited, nothing to do
}
```
- **Confidence heuristic**: MEDIUM — depends on whether the process lifecycle is deterministic.

---

## Section 6: Async Logic & Race Conditions (Agent 6)

### Pattern: UI Update Before API Completion
- **Category**: Async / Race Condition
- **What to look for**: State mutations like `removeEmails(ids)`, `clearSelection()`, `setViewMode()` BEFORE `await apiCall()`
- **Why it's a bug**: If API fails, UI is out of sync — items appear removed/changed but aren't. This is the #1 bug pattern in this codebase. Confirmed in PRs #26, #28, #34, #45.
- **The correct pattern**:
```ts
// BAD: UI updated before API completes
const handleArchive = async (ids: string[]) => {
  removeEmails(ids); // UI updates immediately
  await gmail.archive(ids); // if this fails, emails are gone from UI
};

// GOOD: await API first
const handleArchive = async (ids: string[]) => {
  await gmail.archive(ids);
  removeEmails(ids); // only update UI on success
};
```
- **Confidence heuristic**: HIGH (95) when the API call can fail (network, rate limits). Always flag this pattern.

---

### Pattern: Processing Flag Without Finally Block
- **Category**: Async / State Consistency
- **What to look for**: `isLoading = true; await ...; isLoading = false;` without `finally` block
- **Why it's a bug**: Error skips the reset — loading/processing state stuck forever. Confirmed in PRs #20, #96, #130, #151.
- **The correct pattern**:
```ts
// BAD: stuck on error
setIsLoading(true);
await fetchData();
setIsLoading(false);

// GOOD: always resets
setIsLoading(true);
try {
  await fetchData();
} finally {
  setIsLoading(false);
}
```
- **Confidence heuristic**: HIGH (90) for any flag set before an async operation. Check for `finally`.

---

### Pattern: Stale Zustand State After Await
- **Category**: Async / State
- **What to look for**: `const state = useAppStore.getState()` followed by `await` and then reading from `state`
- **Why it's a bug**: State object is a snapshot — may have changed during the await gap. Confirmed in PRs #75, #84, #124, #127, #142.
- **The correct pattern**:
```ts
// BAD: stale snapshot
const state = useAppStore.getState();
await someAsyncOperation();
const emails = state.emails; // stale!

// GOOD: re-read after await
await someAsyncOperation();
const freshState = useAppStore.getState();
const emails = freshState.emails;
```
- **Confidence heuristic**: HIGH if state is mutated concurrently (e.g., background sync running).

---

### Pattern: Missing Re-entrancy Guard
- **Category**: Async / Concurrency
- **What to look for**: Async handler callable from UI (button click, IPC) without `if (isProcessing) return` guard
- **Why it's a bug**: Rapid clicks trigger duplicate concurrent operations — duplicate API calls, double state updates. Confirmed in PRs #124, #151.
- **The correct pattern**:
```ts
// BAD: no guard
const handleGenerate = async () => {
  const draft = await generateDraft(emailId);
  setDraft(draft);
};

// GOOD: ref-based guard
const isProcessing = useRef(false);
const handleGenerate = async () => {
  if (isProcessing.current) return;
  isProcessing.current = true;
  try {
    const draft = await generateDraft(emailId);
    setDraft(draft);
  } finally {
    isProcessing.current = false;
  }
};
```
- **Confidence heuristic**: MEDIUM-HIGH depending on operation cost. HIGH for API calls, MEDIUM for local-only operations.

---

### Pattern: Retry Matching User Cancellation
- **Category**: Async / Abort Handling
- **What to look for**: `isRetryableError` or retry logic that matches 'abort' or 'cancel' strings
- **Why it's a bug**: User-initiated cancel gets retried instead of stopping. Confirmed in PR #99.
- **The correct pattern**:
```ts
// BAD: retries user cancellation
function isRetryable(err: Error) {
  return err.message.includes('aborted') || err.message.includes('timeout');
}

// GOOD: exclude user cancellation
function isRetryable(err: Error) {
  if (err.name === 'AbortError') return false; // user cancelled
  return err.message.includes('timeout') || err.message.includes('rate_limit');
}
```
- **Confidence heuristic**: HIGH if abort controller is used in the same code path.

---

### Pattern: Missing Await on Async Call
- **Category**: Async / Correctness
- **What to look for**: Async function call without `await` keyword where the result or side effect is needed
- **Why it's a bug**: Downstream code runs before async setup completes — race condition. Confirmed in PR #124.
- **The correct pattern**:
```ts
// BAD: initialization races
initializeService(); // forgot await
const result = service.process(data); // service not ready

// GOOD
await initializeService();
const result = service.process(data);
```
- **Confidence heuristic**: HIGH if the function's result or side effect is needed by subsequent code.

---

### Pattern: Promise That Never Resolves
- **Category**: Async / Deadlock
- **What to look for**: Cancel/abort path that doesn't resolve or reject the associated promise
- **Why it's a bug**: `await promise` hangs forever after cancellation. Confirmed in PR #124.
- **The correct pattern**:
```ts
// BAD: cancel doesn't resolve promise
let resolve: () => void;
const promise = new Promise<void>(r => { resolve = r; });
function cancel() {
  abortController.abort(); // forgets to resolve promise
}

// GOOD: cancel resolves the promise
function cancel() {
  abortController.abort();
  resolve(); // unblock any awaiter
}
```
- **Confidence heuristic**: HIGH (90) when there's a cancel/abort path and an associated promise.

---

### Pattern: requestIdleCallback Without Cleanup
- **Category**: Async / Lifecycle
- **What to look for**: `requestIdleCallback(fn)` without storing handle for `cancelIdleCallback`
- **Why it's a bug**: Callback fires after component unmounts — crash or stale state update. Confirmed in PRs #98, #115.
- **The correct pattern**:
```ts
// BAD: no cleanup
useEffect(() => {
  requestIdleCallback(() => computeExpensiveThing());
}, []);

// GOOD: cleanup on unmount
useEffect(() => {
  const handle = requestIdleCallback(() => computeExpensiveThing());
  return () => cancelIdleCallback(handle);
}, []);
```
- **Confidence heuristic**: HIGH in useEffect. MEDIUM in module-level code.

---

## Section 7: Error Handling & Resource Leaks (Agent 7)

### Pattern: Floating Promise (No .catch())
- **Category**: Error Handling / Async
- **What to look for**: `asyncFn().then(...)` without `.catch()`, or async function call without try/catch
- **Why it's a bug**: Unhandled rejection — process crash in Node.js/Electron. Confirmed in PRs #124, #133.
- **The correct pattern**:
```ts
// BAD: floating promise
fetchEmails().then(emails => updateStore(emails));

// GOOD: handle errors
fetchEmails()
  .then(emails => updateStore(emails))
  .catch(err => console.error('Failed to fetch emails:', err));

// GOOD: async/await with try/catch
try {
  const emails = await fetchEmails();
  updateStore(emails);
} catch (err) {
  console.error('Failed to fetch emails:', err);
}
```
- **Confidence heuristic**: HIGH at IPC boundary (main process crash terminates app). MEDIUM for renderer-side fire-and-forget.

---

### Pattern: Event Listener Without Cleanup Return
- **Category**: Resource Leak / React
- **What to look for**: `addEventListener` or `.on()` in React useEffect without returning a cleanup function
- **Why it's a bug**: Listener accumulates on re-renders — memory leak, duplicate event handling. Confirmed in PRs #23, #66, #98, #147.
- **The correct pattern**:
```tsx
// BAD: listener leaks
useEffect(() => {
  window.addEventListener('resize', handleResize);
}, []);

// GOOD: cleanup return
useEffect(() => {
  window.addEventListener('resize', handleResize);
  return () => window.removeEventListener('resize', handleResize);
}, []);
```
- **Confidence heuristic**: HIGH (90) for any addEventListener/on() in useEffect.

---

### Pattern: Unbounded Map/Set Growth
- **Category**: Resource Leak / Memory
- **What to look for**: `Map` or `Set` that adds entries without corresponding delete/clear logic
- **Why it's a bug**: Memory grows proportional to operations — eventual OOM in long-running app. Confirmed in PRs #28, #57, #98, #101.
- **The correct pattern**:
```ts
// BAD: grows forever
const processedEmails = new Map<string, boolean>();
function markProcessed(id: string) {
  processedEmails.set(id, true); // never cleared
}

// GOOD: bounded with cleanup
const processedEmails = new Map<string, boolean>();
function markProcessed(id: string) {
  processedEmails.set(id, true);
  if (processedEmails.size > 10000) {
    const oldest = [...processedEmails.keys()].slice(0, 5000);
    oldest.forEach(k => processedEmails.delete(k));
  }
}
```
- **Confidence heuristic**: HIGH if entries are per-operation (per-email, per-request). MEDIUM for bounded-by-design collections.

---

### Pattern: Module-Level State Not Reset on Context Change
- **Category**: Resource Leak / Multi-Account
- **What to look for**: `let cache = new Map()` at module level, never cleared on account switch
- **Why it's a bug**: State persists across account switches — stale/cross-account data. Confirmed in PR #115.
- **The correct pattern**:
```ts
// BAD: persists across accounts
let senderCache = new Map<string, SenderProfile>();

// GOOD: clear on account switch
let senderCache = new Map<string, SenderProfile>();
export function resetSenderCache() {
  senderCache.clear();
}
// Call resetSenderCache() in account switch handler
```
- **Confidence heuristic**: HIGH in multi-account app. Check if module-level state is account-scoped.

---

### Pattern: removeAllListeners() Too Broad
- **Category**: Resource Leak / Events
- **What to look for**: `emitter.removeAllListeners()` without specifying event name
- **Why it's a bug**: Removes ALL listeners including other modules' — breaks unrelated features. Confirmed in PR #22.
- **The correct pattern**:
```ts
// BAD: removes everything
ipcMain.removeAllListeners();

// GOOD: remove specific handler
ipcMain.removeListener('sync:start', syncHandler);

// GOOD: remove by event name at most
emitter.removeAllListeners('specific-event');
```
- **Confidence heuristic**: HIGH (90) on shared emitters like `ipcMain`.

---

### Pattern: Silent Catch Block
- **Category**: Error Handling / UX
- **What to look for**: `catch (e) { console.error(e) }` without user-facing feedback
- **Why it's a bug**: User sees nothing happened — retries — confused. Confirmed in PRs #23, #124, #128, #147, #153, #154.
- **The correct pattern**:
```ts
// BAD: silent failure
try {
  await sendDraft(draft);
} catch (e) {
  console.error(e); // user sees nothing
}

// GOOD: user feedback
try {
  await sendDraft(draft);
} catch (e) {
  console.error('Send failed:', e);
  showToast('Failed to send email. Please try again.', 'error');
}
```
- **Confidence heuristic**: MEDIUM-HIGH depending on operation visibility. HIGH for user-initiated actions.

---

### Pattern: Circular Object in JSON.stringify
- **Category**: Error Handling / Serialization
- **What to look for**: `JSON.stringify(obj)` where obj may contain circular references (DOM nodes, Electron objects)
- **Why it's a bug**: Throws TypeError — suppresses all subsequent output if in logging path. Confirmed in PR #102.
- **The correct pattern**:
```ts
// BAD: throws on circular refs
console.log(JSON.stringify(electronResponse));

// GOOD: safe serialization
import { inspect } from 'util';
console.log(inspect(electronResponse, { depth: 2 }));
```
- **Confidence heuristic**: MEDIUM — depends on object source. HIGH for Electron/DOM objects.

---

### Pattern: Writable Stream Without Error Handler
- **Category**: Error Handling / IO
- **What to look for**: `fs.createWriteStream(path)` without `.on('error', handler)`
- **Why it's a bug**: Disk errors (full disk, permissions) — uncaught exception — process crash. Confirmed in PR #102.
- **The correct pattern**:
```ts
// BAD: no error handler
const stream = fs.createWriteStream(outputPath);
stream.write(data);

// GOOD: error handler
const stream = fs.createWriteStream(outputPath);
stream.on('error', (err) => {
  console.error(`Write failed for ${outputPath}:`, err);
});
stream.write(data);
```
- **Confidence heuristic**: HIGH — always add error handler to writable streams.

---

## Section 8: Security & Input Validation (Agent 8)

### Pattern: dangerouslySetInnerHTML Without Sanitization
- **Category**: Security / XSS
- **What to look for**: `dangerouslySetInnerHTML={{ __html: content }}` without `DOMPurify.sanitize()` wrapping content
- **Why it's a bug**: XSS — malicious email content executes JavaScript in Electron renderer. Full access to Node.js if contextIsolation is disabled. Confirmed in PRs #56, #82, #95, #118.
- **The correct pattern**:
```tsx
// BAD: raw HTML injection
<div dangerouslySetInnerHTML={{ __html: emailBody }} />

// GOOD: sanitized
import DOMPurify from 'dompurify';
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(emailBody) }} />
```
- **Confidence heuristic**: HIGH (95) — critical security issue. Always flag unsanitized innerHTML.

---

### Pattern: Path Traversal via User Input
- **Category**: Security / File System
- **What to look for**: `path.join(baseDir, filename)` where filename comes from untrusted source (email attachment, user input)
- **Why it's a bug**: `../../.ssh/authorized_keys` writes outside intended directory. Confirmed in PR #40.
- **The correct pattern**:
```ts
// BAD: path traversal
const filePath = path.join(attachmentDir, attachment.filename);

// GOOD: strip directory components
const filePath = path.join(attachmentDir, path.basename(attachment.filename));
```
- **Confidence heuristic**: HIGH (95) if filename comes from email/external source.

---

### Pattern: postMessage Without Origin Check
- **Category**: Security / IPC
- **What to look for**: `window.addEventListener('message', handler)` without `event.origin` validation
- **Why it's a bug**: Any iframe/window can send messages to the app — potential XSS vector. Confirmed in PR #39.
- **The correct pattern**:
```ts
// BAD: accepts from anywhere
window.addEventListener('message', (event) => {
  processData(event.data);
});

// GOOD: validate origin
window.addEventListener('message', (event) => {
  if (event.origin !== expectedOrigin) return;
  processData(event.data);
});
```
- **Confidence heuristic**: HIGH if the app processes message data from iframes.

---

### Pattern: SQL LIKE With User Input
- **Category**: Security / SQL
- **What to look for**: `LIKE '%${userInput}%'` or string concatenation in LIKE clause
- **Why it's a bug**: Matches unintended rows. If input is directly concatenated, potential SQL injection. Confirmed in PRs #75, #79.
- **The correct pattern**:
```ts
// BAD: string concat in LIKE
db.all(`SELECT * FROM emails WHERE subject LIKE '%${searchTerm}%'`);

// GOOD: parameterized
db.all('SELECT * FROM emails WHERE subject LIKE ?', [`%${searchTerm}%`]);
```
- **Confidence heuristic**: HIGH (90) for string concatenation. MEDIUM for parameterized LIKE with wildcard issues.

---

### Pattern: base64url to base64 Without Padding
- **Category**: Security / Encoding
- **What to look for**: `replace(/-/g, '+').replace(/_/g, '/')` without adding `=` padding
- **Why it's a bug**: Corrupts binary data (attachments, images). Decoder misinterprets final bytes. Confirmed in PRs #40, #41.
- **The correct pattern**:
```ts
// BAD: missing padding
function base64urlToBase64(str: string): string {
  return str.replace(/-/g, '+').replace(/_/g, '/');
}

// GOOD: add padding
function base64urlToBase64(str: string): string {
  let result = str.replace(/-/g, '+').replace(/_/g, '/');
  while (result.length % 4) result += '=';
  return result;
}
```
- **Confidence heuristic**: HIGH (90) — confirmed corruption pattern.

---

### Pattern: HTML Interpolation Without Escaping
- **Category**: Security / XSS
- **What to look for**: Template literal `<div>${userName}</div>` without HTML entity escaping
- **Why it's a bug**: User input with `<script>` tags or event handlers executes. Confirmed in PR #82.
- **The correct pattern**:
```ts
// BAD: raw interpolation
const html = `<span class="sender">${senderName}</span>`;

// GOOD: escape entities
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
const html = `<span class="sender">${escapeHtml(senderName)}</span>`;
```
- **Confidence heuristic**: HIGH if interpolated value comes from external source (email headers, user input).

---

### Pattern: Credentials in Source Code
- **Category**: Security / Secrets
- **What to look for**: Hardcoded API keys, tokens, secrets in .ts/.js files
- **Why it's a bug**: Credentials exposed in git history and to all users. Confirmed in PR #149.
- **The correct pattern**: Use environment variables or secure config storage (`electron-store` with encryption).
- **Confidence heuristic**: HIGH (95) — always flag hardcoded secrets.

---

### Pattern: CSRF State Checked After Token Exchange
- **Category**: Security / OAuth
- **What to look for**: OAuth flow where state parameter is verified AFTER calling the token endpoint
- **Why it's a bug**: CSRF attack succeeds because token exchange happens before validation. Confirmed in PR #76.
- **The correct pattern**:
```ts
// BAD: verify after exchange
const tokens = await exchangeCodeForTokens(code);
if (state !== savedState) throw new Error('CSRF');

// GOOD: verify before exchange
if (state !== savedState) throw new Error('CSRF');
const tokens = await exchangeCodeForTokens(code);
```
- **Confidence heuristic**: HIGH (90) — always verify state before token exchange.

---

## Section 9: Data Loss & Field Preservation (Agent 9)

### Pattern: Missing Spread in Object Construction
- **Category**: Data Loss / Object Construction
- **What to look for**: `{ body: newBody, subject }` without `...existingObject` for save/send operations
- **Why it's a bug**: Drops all fields not explicitly listed — CC, BCC, attachments, calendaringResult, agentTaskId, subject all silently lost. This is the #2 most common bug pattern. Confirmed in PRs #31, #40, #58, #118, #133, #139.
- **The correct pattern**:
```ts
// BAD: drops cc, bcc, attachments, etc.
const updatedDraft = {
  body: newBody,
  subject: draft.subject,
};
await saveDraft(updatedDraft);

// GOOD: preserve all existing fields
const updatedDraft = {
  ...existingDraft,
  body: newBody, // only override what changed
};
await saveDraft(updatedDraft);
```
- **Confidence heuristic**: HIGH (95) for save/send/queue operations. Check all fields against the full type definition.

---

### Pattern: COALESCE Defeating Reset
- **Category**: Data Loss / DB Updates
- **What to look for**: `COALESCE(?, existing_column)` where the column SHOULD be reset during regeneration
- **Why it's a bug**: Stale values persist after regeneration. Old `gmail_draft_id` kept when draft is regenerated. Confirmed in PRs #133, #139.
- **The correct pattern**:
```sql
-- BAD: COALESCE preserves stale value on regeneration
UPDATE drafts SET body = ?, gmail_draft_id = COALESCE(?, gmail_draft_id)

-- GOOD: explicit NULL for regeneration, COALESCE only for incremental update
-- Regeneration path:
UPDATE drafts SET body = ?, gmail_draft_id = NULL
-- Incremental update path:
UPDATE drafts SET body = ?, gmail_draft_id = COALESCE(?, gmail_draft_id)
```
- **Confidence heuristic**: HIGH if the operation is a regeneration/reset path.

---

### Pattern: Queue/Outbox Missing Fields
- **Category**: Data Loss / Serialization
- **What to look for**: `queueToOutbox()` or similar serialization without all composition fields
- **Why it's a bug**: Queued emails sent without CC/BCC/attachments when network restores. Confirmed in PR #40.
- **The correct pattern**:
```ts
// BAD: missing fields
function queueToOutbox(draft: Draft) {
  return { to: draft.to, body: draft.body, subject: draft.subject };
  // cc, bcc, attachments all lost
}

// GOOD: all fields included
function queueToOutbox(draft: Draft) {
  return { ...draft }; // or explicitly list ALL fields
}
```
- **Confidence heuristic**: HIGH (90) — verify outbox schema has matching columns for all composition fields.

---

### Pattern: Partial Failure Without Rollback
- **Category**: Data Loss / Consistency
- **What to look for**: Multiple API calls where first succeeds but second may fail
- **Why it's a bug**: Inconsistent state — labels removed but new labels not added. Confirmed in PR #68.
- **The correct pattern**:
```ts
// BAD: partial failure
await gmail.removeLabel(emailId, 'INBOX');
await gmail.addLabel(emailId, 'ARCHIVE'); // if this fails, email has no label

// GOOD: handle partial failure
try {
  await gmail.removeLabel(emailId, 'INBOX');
  await gmail.addLabel(emailId, 'ARCHIVE');
} catch (err) {
  // attempt rollback
  await gmail.addLabel(emailId, 'INBOX').catch(() => {});
  throw err;
}
```
- **Confidence heuristic**: HIGH if both operations must succeed or both fail.

---

### Pattern: Regex Dropping Valid Characters
- **Category**: Data Loss / Validation
- **What to look for**: Email address regex that doesn't allow `+`, `.` or other valid local-part characters
- **Why it's a bug**: Valid email addresses silently removed from recipient list. `user+tag@example.com` rejected. Confirmed in PR #139.
- **The correct pattern**:
```ts
// BAD: rejects user+tag@example.com
const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// GOOD: allows + and other valid chars
const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
```
- **Confidence heuristic**: HIGH if `+` addressing is common (most modern email services support it).

---

### Pattern: Object Overwritten After Property Set
- **Category**: Data Loss / Logic Error
- **What to look for**: `obj.prop = value; obj = { ...otherObj }` in sequence
- **Why it's a bug**: First assignment lost when object is replaced on the next line.
- **The correct pattern**:
```ts
// BAD: first assignment lost
draft.cc = recipientList;
draft = { ...generatedDraft }; // cc gone

// GOOD: set after construction
draft = { ...generatedDraft, cc: recipientList };
```
- **Confidence heuristic**: HIGH — always flag overwrite-after-set patterns.

---

## Section 10: Cross-Account & Multi-Context Safety (Agent 10)

### Pattern: Cache Key Without Account Scope
- **Category**: Multi-Account / Cache
- **What to look for**: `cache.set(threadId, ...)` without accountId in the cache key
- **Why it's a bug**: Same threadId in different accounts shares cache — wrong data displayed. Confirmed in PR #22.
- **The correct pattern**:
```ts
// BAD: key collision across accounts
cache.set(threadId, analysis);

// GOOD: account-scoped key
cache.set(`${accountId}:${threadId}`, analysis);
```
- **Confidence heuristic**: HIGH (90) in multi-account apps.

---

### Pattern: accounts[0] Instead of Active Account
- **Category**: Multi-Account / Context
- **What to look for**: `accounts[0]` or `accounts[0].id` for context-dependent operations
- **Why it's a bug**: Uses first account instead of currently selected — wrong data, wrong API calls. Confirmed in PR #139.
- **The correct pattern**:
```ts
// BAD: always uses first account
const client = getGmailClient(accounts[0].id);

// GOOD: uses active account
const client = getGmailClient(currentAccountId);
```
- **Confidence heuristic**: HIGH if user can switch accounts.

---

### Pattern: Selection Not Cleared on Context Switch
- **Category**: Multi-Account / State
- **What to look for**: State like `selectedIds`, `checkedItems` not cleared when switching account or context
- **Why it's a bug**: Batch operations apply to wrong context. Archive on Account B deletes from Account A. Confirmed in PR #34.
- **The correct pattern**:
```ts
// In account switch handler:
function switchAccount(newAccountId: string) {
  setCurrentAccountId(newAccountId);
  clearSelectedThreadIds(); // MUST clear selections
  clearDraftState();
  clearSearchResults();
}
```
- **Confidence heuristic**: HIGH (90) for any selection/checked state.

---

### Pattern: Event Listener Without Account Filter
- **Category**: Multi-Account / Events
- **What to look for**: IPC event listener that processes events without checking accountId
- **Why it's a bug**: Events from Account B update Account A's state. Confirmed in PR #23.
- **The correct pattern**:
```ts
// BAD: processes all events
window.api.on('sync:new-emails', ({ emails }) => {
  addEmails(emails);
});

// GOOD: filter by active account
window.api.on('sync:new-emails', ({ accountId, emails }) => {
  if (accountId === currentAccountId) {
    addEmails(emails);
  }
});
```
- **Confidence heuristic**: HIGH in multi-account apps.

---

### Pattern: Hardcoded Default Account ID
- **Category**: Multi-Account / Configuration
- **What to look for**: `accountId: "default"` or `accountId: "1"` in code
- **Why it's a bug**: Breaks multi-account features — all operations target one hardcoded account. Confirmed in PRs #104, #139.
- **The correct pattern**: Always use dynamic account ID from context (store, function parameter, IPC payload).
- **Confidence heuristic**: HIGH (90) — always flag hardcoded account IDs.

---

## Section 11: Email/RFC Compliance & String Handling (Agent 11)

### Pattern: Unquoted Display Name with Special Characters
- **Category**: Email / RFC 5322
- **What to look for**: `${name} <${email}>` string construction for email headers without quoting the name
- **Why it's a bug**: Names with commas parsed as multiple addresses: `Doe, John <j@x.com>` becomes two entries `Doe` and `John <j@x.com>`. Confirmed in PRs #85, #155.
- **The correct pattern**:
```ts
// BAD: comma in name breaks parsing
const header = `${displayName} <${email}>`;

// GOOD: quote the display name
const header = `"${displayName.replace(/"/g, '\\"')}" <${email}>`;
```
- **Confidence heuristic**: HIGH (90) — display names from contacts frequently contain commas, periods, and other special characters.

---

### Pattern: Naive Comma Split on Email Headers
- **Category**: Email / Parsing
- **What to look for**: `.split(',')` on To/CC/BCC fields
- **Why it's a bug**: Splits inside quoted names: `"Doe, John" <j@x.com>` becomes fragments. Confirmed in PR #137.
- **The correct pattern**:
```ts
// BAD: naive split
const addresses = toHeader.split(',').map(s => s.trim());

// GOOD: proper parser
import { parseAddressList } from 'email-addresses';
const addresses = parseAddressList(toHeader);

// GOOD (manual): respect quotes
function splitAddresses(header: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (const char of header) {
    if (char === '"') inQuotes = !inQuotes;
    else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) result.push(current.trim());
  return result;
}
```
- **Confidence heuristic**: HIGH (90) whenever splitting email header fields.

---

### Pattern: Email Case-Sensitive Comparison
- **Category**: Email / RFC
- **What to look for**: `email1 === email2` without `.toLowerCase()` on both sides
- **Why it's a bug**: Same email address treated as different due to case. Deduplication fails. Confirmed in PR #21.
- **The correct pattern**:
```ts
// BAD
if (email === existingEmail) { ... }

// GOOD
if (email.toLowerCase() === existingEmail.toLowerCase()) { ... }
```
- **Confidence heuristic**: MEDIUM — domain part is case-insensitive by RFC, local part technically case-sensitive but insensitive in practice for virtually all providers.

---

### Pattern: base64url to base64 Missing Padding
- **Category**: Email / Encoding (cross-ref with Security Section 8)
- **What to look for**: `replace(/-/g, '+').replace(/_/g, '/')` without adding `=` padding to make length a multiple of 4
- **Why it's a bug**: Corrupts binary data — attachment downloads produce garbled files. Confirmed in PRs #40, #41.
- **The correct pattern**: Pad string to multiple of 4 with `=` after character replacement.
- **Confidence heuristic**: HIGH (90).

---

### Pattern: Regex HTML Tag Stripping
- **Category**: Email / Content Processing
- **What to look for**: `content.replace(/<[^>]+>/g, '')` for HTML stripping
- **Why it's a bug**: Matches angle brackets in math or comparison operators: `x < y > z` becomes `x  z`. Confirmed in PR #135.
- **The correct pattern**:
```ts
// BAD: destroys non-HTML angle brackets
const text = html.replace(/<[^>]+>/g, '');

// GOOD: use DOM parser
const doc = new DOMParser().parseFromString(html, 'text/html');
const text = doc.body.textContent || '';
```
- **Confidence heuristic**: HIGH if processing content that may contain non-HTML angle brackets (code snippets, math).

---

### Pattern: Markdown False Positive
- **Category**: Email / Content Processing
- **What to look for**: Regex matching `*text*` for italic/bold in content that may contain math or plain asterisks
- **Why it's a bug**: `2 * 3 = 6` becomes `2 <em> 3 = 6</em>`. Confirmed in PR #135.
- **The correct pattern**: Use more specific patterns requiring word boundaries, or use a proper Markdown parser.
- **Confidence heuristic**: MEDIUM — depends on content source.

---

### Pattern: Pre-formatted Address Comparison
- **Category**: Email / Deduplication
- **What to look for**: String equality check on email addresses that may include display names
- **Why it's a bug**: `"John" <john@x.com>` !== `john@x.com` — duplicate detection fails. Confirmed in PR #155.
- **The correct pattern**:
```ts
// BAD: format-dependent comparison
if (addresses.includes(newAddress)) { ... }

// GOOD: extract and compare address portion only
function extractEmail(addr: string): string {
  const match = addr.match(/<([^>]+)>/);
  return (match ? match[1] : addr).toLowerCase();
}
if (addresses.map(extractEmail).includes(extractEmail(newAddress))) { ... }
```
- **Confidence heuristic**: HIGH for deduplication logic.

---

## Section 12: Build, Packaging & Electron (Agent 12)

### Pattern: __dirname in Packaged App
- **Category**: Electron / Packaging
- **What to look for**: `path.join(__dirname, '../../resources/')` in main process code
- **Why it's a bug**: `__dirname` in asar points to virtual path — file not found in production. Works in dev but breaks in packaged build. Confirmed in PR #67.
- **The correct pattern**:
```ts
// BAD: works in dev, fails in production
const resourcePath = path.join(__dirname, '../../resources/icon.png');

// GOOD: detect packaged mode
const resourcePath = app.isPackaged
  ? path.join(process.resourcesPath, 'icon.png')
  : path.join(__dirname, '../../resources/icon.png');
```
- **Confidence heuristic**: HIGH if the path is for runtime resources (icons, binaries, config files).

---

### Pattern: Module-Level app.getPath()
- **Category**: Electron / Initialization
- **What to look for**: `const x = app.getPath('userData')` at module scope (top-level, not inside a function)
- **Why it's a bug**: Called at import time, before app 'ready' event — crashes. Confirmed in PR #150.
- **The correct pattern**:
```ts
// BAD: called at import time
const DB_PATH = path.join(app.getPath('userData'), 'data', 'app.db');

// GOOD: lazy getter
function getDbPath(): string {
  return path.join(app.getPath('userData'), 'data', 'app.db');
}
```
- **Confidence heuristic**: HIGH (90) — immediate crash in test environments and certain import orders.

---

### Pattern: Config Migration Missing
- **Category**: Electron / Upgrade
- **What to look for**: New config file path without migration from old path
- **Why it's a bug**: Users lose auth/config on update. Confirmed in PR #150.
- **The correct pattern**:
```ts
// GOOD: check old location on startup
const oldPath = path.join(os.homedir(), '.exo', 'config.json');
const newPath = path.join(app.getPath('userData'), 'config.json');
if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
  fs.copyFileSync(oldPath, newPath);
}
```
- **Confidence heuristic**: HIGH if changing paths in an existing app with users.

---

### Pattern: removeAllListeners() Scope
- **Category**: Electron / Events (cross-ref with Section 7)
- **What to look for**: `emitter.removeAllListeners()` on shared emitters like `ipcMain` without specifying event name
- **Why it's a bug**: Removes other modules' listeners — breaks unrelated features. Confirmed in PR #22.
- **The correct pattern**: Store handler references, use `removeListener(event, handler)` to remove specific handlers.
- **Confidence heuristic**: HIGH (90) on shared emitters.

---

## Section 13: Concurrency, Deduplication & Performance (Agent 13)

### Pattern: Missing Cross-Collection Deduplication
- **Category**: Concurrency / Queue
- **What to look for**: Queue system with `activeQueue` and `backlog` where only one collection is checked for duplicates before adding
- **Why it's a bug**: Item in backlog gets re-added to active queue — processed twice. Confirmed in PR #124.
- **The correct pattern**:
```ts
// BAD: only checks active
function enqueue(item: WorkItem) {
  if (activeQueue.has(item.id)) return;
  activeQueue.set(item.id, item); // backlog not checked
}

// GOOD: check all collections
function enqueue(item: WorkItem) {
  if (activeQueue.has(item.id) || backlog.has(item.id) || completed.has(item.id)) return;
  activeQueue.set(item.id, item);
}
```
- **Confidence heuristic**: HIGH if multiple code paths can queue items.

---

### Pattern: Sequential Awaits in Loop
- **Category**: Performance / Async
- **What to look for**: `for (const item of items) { await process(item); }`
- **Why it's a bug**: N sequential API calls when they could run in parallel — N * latency instead of max(latency). Confirmed in PRs #105, #131.
- **The correct pattern**:
```ts
// BAD: sequential, N * latency
for (const email of emails) {
  await fetchSenderProfile(email.from);
}

// GOOD: parallel, max(latency)
await Promise.all(emails.map(email => fetchSenderProfile(email.from)));

// GOOD: batched parallel with concurrency limit
const BATCH_SIZE = 10;
for (let i = 0; i < emails.length; i += BATCH_SIZE) {
  const batch = emails.slice(i, i + BATCH_SIZE);
  await Promise.all(batch.map(email => fetchSenderProfile(email.from)));
}
```
- **Confidence heuristic**: MEDIUM — only if calls are independent. Sequential is correct for dependent calls (pagination, ordered writes).

---

### Pattern: Timer Churn in Effects
- **Category**: Performance / React
- **What to look for**: `useEffect` that creates new timers on every state change
- **Why it's a bug**: Unnecessary timer destroy/create cycles — performance degradation, potential UI jank. Confirmed in PR #122.
- **The correct pattern**:
```tsx
// BAD: new timer every render
useEffect(() => {
  const timer = setInterval(refresh, 30000);
  return () => clearInterval(timer);
}, [someFrequentlyChangingState]);

// GOOD: stable timer with ref for current callback
const refreshRef = useRef(refresh);
useEffect(() => { refreshRef.current = refresh; }, [refresh]);
useEffect(() => {
  const timer = setInterval(() => refreshRef.current(), 30000);
  return () => clearInterval(timer);
}, []); // stable deps
```
- **Confidence heuristic**: MEDIUM — depends on how often the effect re-runs.

---

### Pattern: Re-entrancy Without Guard
- **Category**: Concurrency / UI (cross-ref with Section 6)
- **What to look for**: Async function callable from UI without `if (processing) return` guard
- **Why it's a bug**: Rapid clicks → duplicate concurrent operations. Confirmed in PR #151.
- **The correct pattern**: Use ref-based guard (see Section 6: Missing Re-entrancy Guard).
- **Confidence heuristic**: HIGH for expensive operations (API calls).

---

### Pattern: Cache Key Missing Relevant Fields
- **Category**: Performance / Cache
- **What to look for**: Cache keyed by `id` alone but result depends on more inputs (body, theme, settings)
- **Why it's a bug**: Stale cached result served when other inputs change. Confirmed in PR #98.
- **The correct pattern**:
```ts
// BAD: key ignores body
const cacheKey = emailId;
const cached = cache.get(cacheKey);

// GOOD: key includes all dependencies
const cacheKey = `${emailId}:${bodyHash}:${theme}`;
const cached = cache.get(cacheKey);
```
- **Confidence heuristic**: HIGH if the cached function's output depends on the missing field.

---

### Pattern: Deleting From Map During Iteration
- **Category**: Concurrency / Data Structures
- **What to look for**: `map.forEach((v, k) => { if (...) map.delete(k); })` or similar in-loop deletion
- **Why it's a bug**: May skip entries per ECMAScript specification — iterator behavior with deletions is implementation-defined. Confirmed in PR #98.
- **The correct pattern**:
```ts
// BAD: may skip entries
map.forEach((v, k) => {
  if (shouldRemove(v)) map.delete(k);
});

// GOOD: collect then delete
const keysToDelete = [...map.entries()]
  .filter(([_, v]) => shouldRemove(v))
  .map(([k]) => k);
keysToDelete.forEach(k => map.delete(k));
```
- **Confidence heuristic**: HIGH — always use collect-then-delete pattern.

---

### Pattern: Infinite Recursion in Queue Processor
- **Category**: Concurrency / Queue
- **What to look for**: `processQueue()` that calls itself when certain task types remain in the queue
- **Why it's a bug**: Non-processable tasks → infinite recursion → stack overflow. Confirmed in PR #124.
- **The correct pattern**:
```ts
// BAD: non-processable item causes infinite recursion
function processQueue() {
  const item = queue.shift();
  if (!canProcess(item)) {
    queue.push(item); // put it back
    processQueue(); // infinite loop
  }
}

// GOOD: iteration with progress check
function processQueue() {
  let processed = 0;
  while (queue.length > 0) {
    const item = queue[0];
    if (!canProcess(item)) break; // stop, don't recurse
    queue.shift();
    process(item);
    processed++;
  }
  if (processed === 0 && queue.length > 0) {
    console.warn('Queue stuck: non-processable items remaining');
  }
}
```
- **Confidence heuristic**: HIGH — always verify that recursive queue processing makes progress.

---

## Section 14: Agent/AI Integration (Agent 14)

### Pattern: Config Not Propagated to Workers
- **Category**: Agent / Configuration
- **What to look for**: Worker utility process that caches config at startup without update mechanism
- **Why it's a bug**: Settings change in main process (API key, model name) not reflected in workers. Workers continue using stale config. Confirmed in PRs #124, #146.
- **The correct pattern**:
```ts
// BAD: cached at startup
const apiKey = config.get('apiKey');
const client = new Anthropic({ apiKey });

// GOOD: update mechanism
let client: Anthropic | null = null;
function getClient(): Anthropic {
  const key = config.get('apiKey');
  if (!client || client.apiKey !== key) {
    client = new Anthropic({ apiKey: key });
  }
  return client;
}
// Also: listen for config change events and reset client
```
- **Confidence heuristic**: HIGH (90) for any service that caches config.

---

### Pattern: Duplicate Terminal Events
- **Category**: Agent / Events
- **What to look for**: `done` or `completed` event emitted from multiple sources for same operation
- **Why it's a bug**: Downstream processes terminal event twice — duplicate state updates, double notifications. Confirmed in PR #47.
- **The correct pattern**:
```ts
// BAD: emitted from both success and catch paths
try {
  await runAgent();
  emit('done', { status: 'success' });
} catch (err) {
  emit('done', { status: 'error' }); // also emitted in finally
} finally {
  emit('done', { status: 'completed' }); // duplicate!
}

// GOOD: single emission point
let result: AgentResult;
try {
  result = await runAgent();
} catch (err) {
  result = { status: 'error', error: err };
}
emit('done', result); // single point of emission
```
- **Confidence heuristic**: HIGH — always ensure terminal events emit exactly once.

---

### Pattern: AbortController Without Signal Wiring
- **Category**: Agent / Cancellation
- **What to look for**: `new AbortController()` where `.signal` is never passed to the actual async operation
- **Why it's a bug**: Cancel button does nothing — operation continues uninterrupted. User thinks they cancelled but agent keeps running. Confirmed in PRs #47, #50.
- **The correct pattern**:
```ts
// BAD: signal created but not used
const controller = new AbortController();
await sdk.messages.create({ model, messages }); // no signal!

// GOOD: signal wired to operation
const controller = new AbortController();
await sdk.messages.create({ model, messages, signal: controller.signal });
```
- **Confidence heuristic**: HIGH (90) — always verify signal is passed to the cancellable operation.

---

### Pattern: Hardcoded Account in Agent Context
- **Category**: Agent / Multi-Account
- **What to look for**: `accountId: "default"` or `accounts[0]` in agent initialization
- **Why it's a bug**: Agent uses wrong account's style/memory/context. Confirmed in PRs #104, #139.
- **The correct pattern**: Use active account from context (store, IPC argument).
- **Confidence heuristic**: HIGH (90) — always flag hardcoded accounts in agent code.

---

### Pattern: Permission Gate Not Wired
- **Category**: Agent / Safety
- **What to look for**: Permission/approval class exists but tool executor doesn't call `gate.check()` before executing
- **Why it's a bug**: Medium-risk tools execute without user approval — safety gap. Confirmed in PR #47.
- **The correct pattern**:
```ts
// BAD: gate exists but unused
class ToolExecutor {
  async execute(tool: Tool, args: Args) {
    return await tool.run(args); // no permission check
  }
}

// GOOD: gate wired
class ToolExecutor {
  async execute(tool: Tool, args: Args) {
    if (tool.riskLevel !== 'low') {
      const approved = await gate.check(tool, args);
      if (!approved) throw new Error('User denied tool execution');
    }
    return await tool.run(args);
  }
}
```
- **Confidence heuristic**: HIGH (90) — critical safety gap.

---

### Pattern: Empty Accounts Creating Invalid Context
- **Category**: Agent / Initialization
- **What to look for**: Agent initialization without checking if accounts array is non-empty
- **Why it's a bug**: Agent runs with empty accountId — data saved without scoping — cross-account contamination. Confirmed in PR #124.
- **The correct pattern**:
```ts
// BAD: no check
function initAgent(accounts: Account[]) {
  const accountId = accounts[0]?.id; // undefined if empty
  agent.setContext({ accountId }); // accountId = undefined
}

// GOOD: explicit check
function initAgent(accounts: Account[]) {
  if (accounts.length === 0) {
    throw new Error('No accounts configured — cannot initialize agent');
  }
  const accountId = accounts[0].id;
  agent.setContext({ accountId });
}
```
- **Confidence heuristic**: HIGH — always validate accounts before agent initialization.

---

### Pattern: Fragile JSON Extraction via Regex
- **Category**: Agent / Parsing
- **What to look for**: Regex-based JSON extraction like `/{[^}]*}/` or `/\{.*\}/s`
- **Why it's a bug**: Fails on nested braces, braces in strings, multi-line JSON. AI output frequently contains nested objects. Confirmed in PR #139.
- **The correct pattern**:
```ts
// BAD: fails on nested braces
const match = response.match(/\{[^}]*\}/);

// GOOD: depth-counting brace matcher
function extractJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (!inString) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
    }
  }
  return null;
}
```
- **Confidence heuristic**: HIGH if AI output can contain nested JSON.
