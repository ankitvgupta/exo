// Type-only imports — @hostler/sdk is ESM-only ("type": "module", no
// `require` export condition) and the worker bundle is CJS, so the SDK is
// loaded at runtime via dynamic import (see loadHostlerSdk); same pattern as
// the OpenCode provider.
import type {
  AgentConfig,
  CreateSessionOptions,
  ModelConfig,
  SessionEvent,
  SessionInfo,
  StreamOptions,
  ToolConfirmation,
  ToolResult,
} from "@hostler/sdk";
import type {
  AgentContext,
  AgentEvent,
  AgentFrameworkConfig,
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentToolSpec,
  ToolExecutorFn,
} from "../../types";
import {
  buildAgentConfig,
  ensureAgent,
  stableStringify,
  type HostlerAgentsApi,
} from "./agent-sync";
import { createHostlerEventMapper } from "./event-mapper";
import { createLogger } from "../../../services/logger";

const log = createLogger("hostler-agent");

export const DEFAULT_HOSTLER_HARNESS = "pi";

/** The docs' known-good harness/model pairing (pi + claude-haiku-4-5). Model
 *  ids are NOT validated at agent-create time — an unknown id fails at turn
 *  time, after the sandbox has launched and started billing — so the default
 *  stays on the documented pairing rather than tracking the app's model tiers. */
export const DEFAULT_HOSTLER_MODEL: ModelConfig = {
  provider: "anthropic",
  id: "claude-haiku-4-5",
};

/**
 * Resolve the configured model selector. Accepts "provider/model" (e.g.
 * "anthropic/claude-sonnet-4-5") or a bare model id, which pairs with
 * "anthropic" — Hostler's broker holds the provider credentials, so unlike
 * OpenCode there is no local Ollama/Anthropic routing to consult.
 * Exported for tests.
 */
export function resolveHostlerModel(selector: string | undefined): ModelConfig {
  const trimmed = selector?.trim();
  if (!trimmed) return DEFAULT_HOSTLER_MODEL;
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return { provider: trimmed.slice(0, slash), id: trimmed.slice(slash + 1) };
  }
  return { provider: "anthropic", id: trimmed };
}

/**
 * Structural view of the SDK surface this provider uses. The provider types
 * against these (which the real SDK client satisfies) rather than the SDK
 * classes themselves — the classes carry `#private` nominal markers, so test
 * fakes could never satisfy them. Mirrors the HostlerAgentsApi pattern in
 * agent-sync.ts.
 */
export interface HostlerSessionLike {
  readonly id: string;
  info(): Promise<SessionInfo>;
  send(text: string, options?: { signal?: AbortSignal }): Promise<void>;
  interrupt(): Promise<void>;
  terminate(): Promise<SessionInfo>;
  events(options?: { since?: number }): Promise<SessionEvent[]>;
  submitToolResult(result: ToolResult, options?: { signal?: AbortSignal }): Promise<void>;
  confirmTool(confirmation: ToolConfirmation, options?: { signal?: AbortSignal }): Promise<void>;
  stream(options?: StreamOptions): AsyncGenerator<SessionEvent, void, void>;
}

export interface HostlerClientLike {
  agents: HostlerAgentsApi;
  sessions: {
    create(options: CreateSessionOptions): Promise<HostlerSessionLike>;
    get(id: string): Promise<HostlerSessionLike>;
    list(): Promise<SessionInfo[]>;
  };
}

export type HostlerSdkModule = {
  Hostler: new (options: { apiKey: string | undefined; baseUrl?: string }) => HostlerClientLike;
};

const importDynamic = new Function("s", "return import(s)") as (
  specifier: string,
) => Promise<unknown>;
let sdkCache: HostlerSdkModule | null = null;
async function loadHostlerSdk(): Promise<HostlerSdkModule> {
  if (sdkCache) return sdkCache;
  const mod = (await importDynamic("@hostler/sdk")) as HostlerSdkModule;
  sdkCache = { Hostler: mod.Hostler };
  return sdkCache;
}

interface ActiveRun {
  session: HostlerSessionLike | null;
  abort: AbortController;
  cleanup: () => void;
}

interface PendingToolCall {
  name: string;
  input: unknown;
  locale: "client" | "sandbox" | "mcp";
}

/** How long a session sandbox stays warm after its last run before we
 *  terminate it. Warm sessions make follow-ups instant (no 10–30s sandbox
 *  launch), but Hostler sandboxes bill until deleted, so the window is short.
 *  A follow-up after termination still works — the provider creates a fresh
 *  session and replays context.conversationHistory. */
const IDLE_SESSION_TTL_MS = 5 * 60 * 1000;

/**
 * Hostler Agent Provider — hosted cloud backend for the agent sidebar
 * (https://hostler.dev).
 *
 * Architecture:
 *
 *   Worker process                        Hostler platform
 *     └── HostlerAgentProvider              ├── control plane (/v1 API)
 *           • syncs one versioned agent  ──►│    agents.create/createVersion
 *           • one session per sidebar    ──►│    sessions.create (sandbox,
 *             conversation                  │    ~10–30s launch)
 *           • streams the session event  ◄──│    SSE event log (durable,
 *             log, maps to AgentEvents      │    replayable via seq cursor)
 *           • executes client tools      ──►│    tool_results park-and-post
 *             locally via toolExecutor      └── sandbox runs the harness (pi)
 *
 * Why this shape:
 *   - The model loop runs in Hostler's sandbox, but every mail tool executes
 *     inside this worker via the orchestrator's toolExecutor — so the same
 *     PermissionGate, confirmation flow, and DB/Gmail proxies apply, and
 *     email data never lives in the sandbox beyond what tool results return.
 *   - Model API keys never enter the sandbox either: Hostler's broker holds
 *     provider credentials, which is why the app's Anthropic/Ollama routing
 *     (modelOverride) is deliberately ignored here — the hostler.model
 *     setting names a model in Hostler's brokered catalog instead.
 *   - Sessions map 1:1 to sidebar conversations. The session id is returned
 *     as providerTaskId so follow-ups reuse the live sandbox (via
 *     context.providerConversationIds), and an idle reaper terminates warm
 *     sessions after IDLE_SESSION_TTL_MS since sandboxes bill until deleted.
 */
export class HostlerAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "hostler",
    name: "Hostler",
    description: "Hosted cloud agent (hostler.dev) — sandboxed harness, tools run locally",
    auth: { type: "api_key" },
  };

  private frameworkConfig: AgentFrameworkConfig;
  private client: HostlerClientLike | null = null;
  private activeRuns = new Map<string, ActiveRun>();
  /** Latest agent sync result, keyed by desired-config fingerprint. */
  private agentSync: { fingerprint: string; id: string; version: number } | null = null;
  private agentSyncPromise: Promise<{ fingerprint: string; id: string; version: number }> | null =
    null;
  /** Per-session event-log high-water mark, so follow-up streams resume past
   *  events already rendered instead of replaying the whole log. */
  private sessionSeq = new Map<string, number>();
  private idleTimers = new Map<
    string,
    { timer: ReturnType<typeof setTimeout>; session: HostlerSessionLike }
  >();
  private orphanSweepDone = false;
  private orphanSweep: Promise<void> | null = null;

  constructor(frameworkConfig: AgentFrameworkConfig) {
    this.frameworkConfig = frameworkConfig;
  }

  /** Test hook: inject a fake SDK module (mirrors AnthropicService._setClientForTesting). */
  _setSdkForTesting(sdk: HostlerSdkModule | null): void {
    sdkCache = sdk;
    this.client = null;
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const { taskId, prompt, context, tools, toolExecutor, signal, recordSessionStart } = params;

    yield { type: "state", state: "running" };

    const settings = this.frameworkConfig.hostler;
    if (!settings?.enabled) {
      yield { type: "error", message: "Hostler provider is not enabled in Settings" };
      return { state: "failed" };
    }
    if (!settings.apiKey) {
      yield {
        type: "error",
        message: "Hostler API key not configured — add one in Settings → Extensions",
      };
      return { state: "failed" };
    }

    const model = resolveHostlerModel(settings.model);
    const harness = settings.harness?.trim() || DEFAULT_HOSTLER_HARNESS;

    // The sandbox's LLM calls go through Hostler's broker, invisible to our
    // AnthropicService — without this row there'd be no record the session ran.
    recordSessionStart({
      harness: "hostler",
      provider: model.provider === "ollama-cloud" ? "ollama-cloud" : "anthropic",
      model: model.id,
      accountId: context.accountId,
      emailId: context.currentEmailId,
    });

    let client: HostlerClientLike;
    let agentRef: { id: string; version: number };
    try {
      client = await this.ensureClient(settings);
      agentRef = await this.ensureAgent(client, tools, model, harness);
    } catch (err) {
      yield { type: "error", message: describeHostlerError(err, "sync the Hostler agent") };
      return { state: "failed" };
    }

    // Pre-aborted signal short-circuit — addEventListener after the event has
    // fired is a no-op (mirrors the OpenCode provider's guard).
    if (signal.aborted) {
      yield { type: "state", state: "cancelled" };
      return { state: "cancelled" };
    }
    const abortController = new AbortController();
    const onParentAbort = () => abortController.abort();
    signal.addEventListener("abort", onParentAbort, { once: true });
    const cleanup = () => {
      signal.removeEventListener("abort", onParentAbort);
      this.activeRuns.delete(taskId);
    };
    const active: ActiveRun = { session: null, abort: abortController, cleanup };
    this.activeRuns.set(taskId, active);

    try {
      // --- Acquire a session: reuse the conversation's live sandbox if the
      // renderer passed one back, else launch a fresh one. The prior session's
      // idle timer is cleared only AFTER reuse is confirmed — clearing it
      // before the probe would orphan a live, billing sandbox whenever the
      // probe fails transiently (network blip ≠ dead session; the still-armed
      // timer remains its reaper).
      let session: HostlerSessionLike | null = null;
      let isNewSession = false;
      const priorId = context.providerConversationIds?.[this.config.id];
      if (priorId) {
        session = await client.sessions.get(priorId).catch(() => null);
        if (session) {
          const info = await session.info().catch(() => null);
          if (!info || info.status === "terminated") session = null;
        }
        if (session) this.clearIdleTimer(priorId);
      }
      if (!session) {
        isNewSession = true;
        yield {
          type: "state",
          state: "running",
          message: "Starting Hostler cloud sandbox (~10-30s)…",
        };
        session = await this.createSession(client, agentRef, taskId);
      }
      active.session = session;

      if (abortController.signal.aborted) {
        this.scheduleIdleTermination(session);
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled", providerTaskId: session.id };
      }

      // --- Cursor: stream only events newer than the durable log's CURRENT
      // tail. The tail must be re-fetched on every reuse — the in-memory
      // high-water mark only covers events the previous run consumed, and a
      // cancelled run stops consuming before the platform appends its
      // status_idle(interrupted) (plus any trailing events). Trusting the
      // stale mark would replay that idle into this turn's stream and
      // instantly mis-terminate it (and could re-execute the cancelled turn's
      // unanswered tool calls). sessionSeq is kept purely as a fetch hint so
      // long conversations don't re-download their whole log. An events()
      // failure fails the run — a silent cursor=0 would replay historical
      // client tools (side effects!) and complete on the first turn's idle.
      let cursor = 0;
      if (!isNewSession) {
        const known = this.sessionSeq.get(session.id) ?? 0;
        const tail = await session.events({ since: known });
        cursor = tail.length > 0 ? tail[tail.length - 1].seq : known;
      }

      // --- Send the message. A reused session can die between the info()
      // check and send() (Hostler sessions are ephemeral across platform
      // restarts) — recreate once and resend rather than failing the run. ---
      const message = isNewSession ? buildFirstMessage(context, prompt) : prompt;
      try {
        await session.send(message, { signal: abortController.signal });
      } catch (err) {
        if (isNewSession || !isConflict(err)) throw err;
        log.info(`Session ${session.id} no longer live; recreating for task ${taskId}`);
        this.sessionSeq.delete(session.id);
        yield {
          type: "state",
          state: "running",
          message: "Starting Hostler cloud sandbox (~10-30s)…",
        };
        session = await this.createSession(client, agentRef, taskId);
        active.session = session;
        isNewSession = true;
        cursor = 0;
        await session.send(buildFirstMessage(context, prompt), {
          signal: abortController.signal,
        });
      }

      // --- Stream the event log until the turn settles. ---
      const mapper = createHostlerEventMapper();
      const toolInputs = new Map<string, PendingToolCall>();
      let terminal: AgentRunResult | null = null;

      for await (const ev of session.stream({
        since: cursor,
        signal: abortController.signal,
      })) {
        this.sessionSeq.set(session.id, ev.seq);

        for (const mapped of mapper.next(ev)) {
          yield mapped;
        }

        if (ev.type === "agent.tool_use") {
          // The only event carrying the input — remember it for tool_pending.
          toolInputs.set(ev.toolCallId, { name: ev.name, input: ev.input, locale: ev.locale });
        } else if (ev.type === "agent.tool_pending") {
          this.handleToolPending(session, ev, toolInputs, toolExecutor);
        } else if (ev.type === "session.status_idle") {
          const stop = ev.stopReason;
          if (stop.type === "requires_action") {
            // Parked client tools are still being answered — keep streaming;
            // the turn resumes once results are posted.
            continue;
          }
          terminal = {
            state:
              stop.type === "end_turn"
                ? "completed"
                : stop.type === "interrupted"
                  ? "cancelled"
                  : "failed",
            providerTaskId: session.id,
          };
          break;
        } else if (ev.type === "session.status_terminated") {
          yield { type: "error", message: `Hostler session terminated: ${ev.reason}` };
          this.sessionSeq.delete(session.id);
          cleanup();
          return { state: "failed", providerTaskId: session.id };
        }
      }

      this.scheduleIdleTermination(session);

      if (!terminal) {
        // Stream ended without an idle event: local abort (cancel) or the
        // stream closed unexpectedly.
        cleanup();
        if (abortController.signal.aborted) {
          yield { type: "state", state: "cancelled" };
          return { state: "cancelled", providerTaskId: session.id };
        }
        yield { type: "error", message: "Hostler event stream ended unexpectedly" };
        return { state: "failed", providerTaskId: session.id };
      }

      cleanup();
      if (terminal.state === "completed") {
        yield { type: "done", summary: mapper.lastMessage()?.trim() || "Completed" };
      } else if (terminal.state === "cancelled") {
        yield { type: "state", state: "cancelled" };
      }
      // failed: the mapper already yielded the error from the stopReason; a
      // second error/state event here would double-surface it in the UI
      // (matches the OpenCode provider's pattern).
      return terminal;
    } catch (err) {
      cleanup();
      const session = active.session;
      if (session) this.scheduleIdleTermination(session);
      if (abortController.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled", providerTaskId: session?.id };
      }
      yield { type: "error", message: describeHostlerError(err, "run the Hostler session") };
      return { state: "failed", providerTaskId: session?.id };
    }
  }

  cancel(taskId: string): void {
    const active = this.activeRuns.get(taskId);
    if (!active) return;
    active.abort.abort();
    // Interrupt (not terminate): the turn aborts but the sandbox stays warm
    // for follow-ups; the idle reaper handles eventual termination.
    const session = active.session;
    if (session) {
      session.interrupt().catch((err: unknown) => {
        log.warn(
          `session.interrupt failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
    active.cleanup();
  }

  async isAvailable(): Promise<boolean> {
    const settings = this.frameworkConfig.hostler;
    return Boolean(settings?.enabled && settings.apiKey);
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.frameworkConfig = { ...this.frameworkConfig, ...config };
    // The orchestrator broadcasts every config change to every provider;
    // only hostler settings affect our cached client and synced agent.
    if (!("hostler" in config)) return;

    this.client = null;
    this.agentSync = null;

    if (!this.frameworkConfig.hostler?.enabled) {
      // Disabled ≠ still billing: terminate warm sessions now instead of
      // waiting out their idle TTL.
      void this.terminateWarmSessions();
    }
  }

  // --- Internals ---

  private async ensureClient(settings: {
    apiKey?: string;
    baseUrl?: string;
  }): Promise<HostlerClientLike> {
    if (this.client) return this.client;
    const sdk = await loadHostlerSdk();
    this.client = new sdk.Hostler({
      apiKey: settings.apiKey,
      ...(settings.baseUrl ? { baseUrl: settings.baseUrl } : {}),
    });
    this.sweepOrphanedSessions(this.client);
    return this.client;
  }

  /**
   * Launch a sandbox session. The platform reserves credit per LIVE session,
   * so a create can 402 ("insufficient credit") even with a positive balance
   * while our own warm-but-idle sessions hold reservations (verified against
   * the live platform, July 2026). In that case, reap the warm sessions now
   * — exactly what the idle TTL would do later — and retry once.
   */
  private async createSession(
    client: HostlerClientLike,
    agentRef: { id: string; version: number },
    taskId: string,
  ): Promise<HostlerSessionLike> {
    const options: CreateSessionOptions = {
      agentId: agentRef.id,
      // Pin the version we just synced — deterministic even if another
      // device publishes a newer version mid-run.
      agentVersion: agentRef.version,
      title: `mail-app:${taskId}`,
    };
    try {
      return await client.sessions.create(options);
    } catch (err) {
      if (errorStatus(err) !== 402) throw err;
      // Reservations may be held by our own warm sessions OR by orphans the
      // boot-time sweep (fire-and-forget) is still reaping — settle both,
      // then retry once. A genuine out-of-credit state throws again here.
      log.info("Session create hit a credit reservation (402); freeing our sessions and retrying");
      await this.orphanSweep?.catch(() => undefined);
      await this.terminateWarmSessions();
      return await client.sessions.create(options);
    }
  }

  /** Terminate every warm (idle, timer-held) session now. Awaited so callers
   *  can rely on the reservations actually being released. */
  private async terminateWarmSessions(): Promise<void> {
    const entries = [...this.idleTimers.values()];
    for (const [sessionId, entry] of this.idleTimers) {
      clearTimeout(entry.timer);
      this.sessionSeq.delete(sessionId);
    }
    this.idleTimers.clear();
    await Promise.allSettled(
      entries.map((entry) =>
        entry.session.terminate().catch((err: unknown) => {
          log.warn(
            `warm terminate failed for ${entry.session.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }),
      ),
    );
  }

  /**
   * Reap sandboxes leaked by an app quit or worker crash — in those cases the
   * unref'd idle timer dies with the process and nothing else terminates the
   * session, which bills until deleted. Once per worker lifetime, terminate
   * idle mail-app sessions. Live turns (status running/starting) are spared;
   * if this races another instance's about-to-be-reused idle session, that
   * instance's send() gets a 409 and its recreate path transparently
   * launches a fresh sandbox.
   */
  private sweepOrphanedSessions(client: HostlerClientLike): void {
    if (this.orphanSweepDone) return;
    this.orphanSweepDone = true;
    // Fire-and-forget, but the promise is kept: createSession awaits it on a
    // 402 so a session create that races the sweep can retry after the
    // orphans' credit reservations are actually released.
    this.orphanSweep = (async () => {
      const rows = await client.sessions.list();
      const orphans = rows.filter(
        (row) => row.status === "idle" && (row.title ?? "").startsWith("mail-app:"),
      );
      for (const row of orphans) {
        const session = await client.sessions.get(row.id).catch(() => null);
        await session?.terminate().catch((err: unknown) => {
          log.warn(
            `orphan terminate failed for ${row.id}: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      if (orphans.length > 0) {
        log.info(`Reaped ${orphans.length} orphaned Hostler session(s) from a previous run`);
      }
    })();
    this.orphanSweep.catch((err: unknown) => {
      log.warn(`orphan sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * Sync the versioned Hostler agent to the desired config. Cached by config
   * fingerprint (tool set, model, harness are stable across runs), with
   * single-flight so concurrent first runs don't race duplicate creates.
   * Waiters loop rather than chain once: a run whose fingerprint mismatches
   * the in-flight sync must wait for it to settle and re-check the cache, or
   * concurrent mismatched runs would each publish their own (identical)
   * version — and one run's failed sync must not reject unrelated runs.
   */
  private async ensureAgent(
    client: HostlerClientLike,
    tools: AgentToolSpec[],
    model: ModelConfig,
    harness: string,
  ): Promise<{ id: string; version: number }> {
    const desired = buildAgentConfig({ tools, model, harness });
    const fingerprint = stableStringify(desired);

    for (;;) {
      if (this.agentSync?.fingerprint === fingerprint) return this.agentSync;
      const inFlight = this.agentSyncPromise;
      if (!inFlight) break;
      // Await whatever is running; its failure belongs to the run that
      // started it, not to us. Loop: another waiter may have started a new
      // sync (or populated the cache) while we awaited.
      await inFlight.catch(() => undefined);
    }

    this.agentSyncPromise = this.syncAgent(client.agents, desired, fingerprint).finally(() => {
      this.agentSyncPromise = null;
    });
    return this.agentSyncPromise;
  }

  private async syncAgent(
    agents: HostlerAgentsApi,
    desired: AgentConfig,
    fingerprint: string,
  ): Promise<{ fingerprint: string; id: string; version: number }> {
    const ref = await ensureAgent(agents, desired);
    const synced = { fingerprint, ...ref };
    this.agentSync = synced;
    return synced;
  }

  /**
   * React to a parked tool call. `async` pendings for client tools run
   * through the orchestrator's toolExecutor (PermissionGate + confirmation
   * included) and post the result back; the execution is deliberately not
   * awaited so the stream loop keeps consuming events — the sandbox holds
   * the turn open until the result arrives, and parallel tool calls park
   * concurrently.
   */
  private handleToolPending(
    session: HostlerSessionLike,
    ev: Extract<SessionEvent, { type: "agent.tool_pending" }>,
    toolInputs: Map<string, PendingToolCall>,
    toolExecutor: ToolExecutorFn,
  ): void {
    const call = toolInputs.get(ev.toolCallId);

    if (ev.pendingState === "approval") {
      // We never set always_ask in the agent config, so an approval park only
      // appears when an operator explicitly added toolConfigs in the Hostler
      // console — an intentional platform-side control. Auto-answering here
      // would defeat it, so leave the call parked for the console to decide
      // (Hostler's documented flow for operator approvals). The turn stays
      // blocked until someone answers there.
      log.warn(
        `Tool call ${ev.toolCallId} (${ev.name}) is approval-gated on the Hostler side; ` +
          `waiting for a decision in the Hostler console`,
      );
      return;
    }

    // pendingState "async": the platform is waiting on this app for a client
    // tool result. Sandbox/mcp tools also stream tool events but are not ours
    // to answer.
    if (!call || call.locale !== "client") return;
    toolInputs.delete(ev.toolCallId);
    void this.executeClientTool(session, ev.toolCallId, call, toolExecutor);
  }

  private async executeClientTool(
    session: HostlerSessionLike,
    toolCallId: string,
    call: PendingToolCall,
    toolExecutor: ToolExecutorFn,
  ): Promise<void> {
    let result: ToolResult;
    try {
      if (!isRecord(call.input)) {
        throw new Error(`Tool input for "${call.name}" was not an object`);
      }
      const value = await toolExecutor(call.name, call.input);
      result = {
        toolCallId,
        content: typeof value === "string" ? value : JSON.stringify(value ?? null),
      };
    } catch (err) {
      // Includes PermissionGate rejections ("Tool X was rejected by user") —
      // the message is shown to the model verbatim so it can adjust.
      result = { toolCallId, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      await session.submitToolResult(result);
    } catch (err) {
      // The session can idle/terminate while a slow tool runs; nothing to do.
      log.warn(
        `submitToolResult failed for ${toolCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private scheduleIdleTermination(session: HostlerSessionLike): void {
    this.clearIdleTimer(session.id);
    const timer = setTimeout(() => {
      this.idleTimers.delete(session.id);
      // TOCTOU guard: a follow-up may have re-entered this session in the
      // instant between the timer firing and this callback running — don't
      // kill a sandbox with a live run on it.
      for (const active of this.activeRuns.values()) {
        if (active.session?.id === session.id) return;
      }
      this.sessionSeq.delete(session.id);
      session.terminate().catch((err: unknown) => {
        log.warn(
          `idle terminate failed for ${session.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, IDLE_SESSION_TTL_MS);
    // Don't hold the worker process open just to reap a sandbox.
    timer.unref?.();
    this.idleTimers.set(session.id, { timer, session });
  }

  private clearIdleTimer(sessionId: string): void {
    const entry = this.idleTimers.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.idleTimers.delete(sessionId);
  }
}

/**
 * First message of a session: per-run context that must NOT live in the
 * versioned agent config (it changes every conversation). Follow-ups within
 * a live session skip this — the context is already established in-session.
 */
export function buildFirstMessage(context: AgentContext, prompt: string): string {
  const lines: string[] = ["Context for this conversation:"];
  lines.push(`- Account: ${context.userEmail}${context.userName ? ` (${context.userName})` : ""}`);
  lines.push(`- Account ID: ${context.accountId}`);
  if (context.currentEmailId) {
    lines.push(`- Currently viewing email ID: ${context.currentEmailId}`);
  }
  if (context.currentThreadId) {
    lines.push(`- Current thread ID: ${context.currentThreadId}`);
  }
  if (context.selectedEmailIds && context.selectedEmailIds.length > 0) {
    lines.push(`- Selected emails: ${context.selectedEmailIds.join(", ")}`);
  }
  if (context.currentDraftId) {
    lines.push(`- Currently editing draft ID: ${context.currentDraftId}`);
  }

  if (context.memoryContext) {
    lines.push("", context.memoryContext);
  }

  // Present when this conversation started on a session that has since been
  // reaped/terminated — replay the transcript so the fresh sandbox has the
  // history the user can still see in the sidebar.
  if (context.conversationHistory) {
    lines.push("", "## Previous conversation", context.conversationHistory);
  }

  lines.push("", "---", "", `User request: ${prompt}`);
  return lines.join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** HostlerError without importing the class at runtime (ESM/CJS gap): the
 *  SDK's errors carry a numeric `status` of the failing HTTP response. */
function errorStatus(err: unknown): number | null {
  if (err instanceof Error && "status" in err && typeof err.status === "number") {
    return err.status;
  }
  return null;
}

function isConflict(err: unknown): boolean {
  const status = errorStatus(err);
  // 409: session exists but is not live. 404: session row is gone entirely.
  return status === 409 || status === 404;
}

function describeHostlerError(err: unknown, doing: string): string {
  const message = err instanceof Error ? err.message : String(err);
  switch (errorStatus(err)) {
    case 401:
      return "Hostler rejected the API key — re-check it in Settings → Extensions";
    case 402:
      return `Hostler billing: ${message} — an active subscription with credit is required (hostler.dev → Billing)`;
    case 502:
      return `Hostler sandbox provisioning failed — safe to retry (${message})`;
    default:
      return `Failed to ${doing}: ${message}`;
  }
}
