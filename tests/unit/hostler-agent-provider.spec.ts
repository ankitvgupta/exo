/**
 * Unit tests for the Hostler agent provider's run loop, using a scripted
 * fake SDK injected via _setSdkForTesting. Properties tested:
 *   - Happy path: agent synced (client tools declared, sandbox tools off),
 *     session created with a pinned version, context preamble sent, client
 *     tool executed through toolExecutor with the result posted back, done
 *     summary from the final message, completed result with the session id.
 *   - Tool executor failures post error tool-results (turn still completes).
 *   - Follow-ups reuse the live session: no create, no preamble, stream
 *     cursor resumes past the existing event log.
 *   - Disabled/unconfigured provider and billing failures surface as
 *     friendly errors.
 *   - Model selector parsing and first-message construction.
 */
import { test, expect } from "@playwright/test";
import { z } from "zod";
import type {
  CreateSessionOptions,
  SessionEvent,
  SessionInfo,
  ToolConfirmation,
  ToolResult,
} from "@hostler/sdk";
import {
  buildFirstMessage,
  DEFAULT_HOSTLER_MODEL,
  HostlerAgentProvider,
  resolveHostlerModel,
  type HostlerClientLike,
  type HostlerSdkModule,
  type HostlerSessionLike,
} from "../../src/main/agents/providers/hostler/hostler-agent-provider";
import type { HostlerAgentsApi } from "../../src/main/agents/providers/hostler/agent-sync";
import type {
  AgentEvent,
  AgentFrameworkConfig,
  AgentRunParams,
  AgentRunResult,
} from "../../src/main/agents/types";

let seq = 0;
function base(): { seq: number; id: string; ts: number } {
  seq += 1;
  return { seq, id: `sevt_${seq}`, ts: seq };
}

test.beforeEach(() => {
  seq = 0;
});

type StreamScript = (session: FakeSession) => AsyncGenerator<SessionEvent, void, void>;

class FakeSession implements HostlerSessionLike {
  readonly id: string;
  status: SessionInfo["status"] = "idle";
  sentMessages: string[] = [];
  toolResults: ToolResult[] = [];
  confirmations: ToolConfirmation[] = [];
  interrupted = false;
  terminated = false;
  streamOptions: { since?: number; signal?: AbortSignal } | undefined;
  history: SessionEvent[] = [];
  private script: StreamScript;
  private toolResultWaiters: ((r: ToolResult) => void)[] = [];
  private postedResults: ToolResult[] = [];

  constructor(id: string, script: StreamScript) {
    this.id = id;
    this.script = script;
  }

  info(): Promise<SessionInfo> {
    return Promise.resolve({
      id: this.id,
      agentId: "agt_1",
      agentVersion: 1,
      status: this.status,
      title: null,
      createdAt: "2026-07-13T00:00:00Z",
      terminatedAt: null,
      environmentId: null,
      vaultIds: [],
      deploymentId: null,
    });
  }
  send(text: string): Promise<void> {
    this.sentMessages.push(text);
    return Promise.resolve();
  }
  interrupt(): Promise<void> {
    this.interrupted = true;
    return Promise.resolve();
  }
  terminate(): Promise<SessionInfo> {
    this.terminated = true;
    this.status = "terminated";
    return this.info();
  }
  events(): Promise<SessionEvent[]> {
    return Promise.resolve(this.history);
  }
  submitToolResult(result: ToolResult): Promise<void> {
    this.toolResults.push(result);
    const waiter = this.toolResultWaiters.shift();
    if (waiter) waiter(result);
    else this.postedResults.push(result);
    return Promise.resolve();
  }
  confirmTool(confirmation: ToolConfirmation): Promise<void> {
    this.confirmations.push(confirmation);
    return Promise.resolve();
  }
  /** Lets a stream script park until the provider posts a tool result.
   *  Results posted before the script gets here are buffered, since the
   *  provider executes tools concurrently with stream consumption. */
  nextToolResult(): Promise<ToolResult> {
    const queued = this.postedResults.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.toolResultWaiters.push(resolve));
  }
  stream(options?: { since?: number; signal?: AbortSignal }) {
    this.streamOptions = options;
    const inner = this.script(this);
    const signal = options?.signal;
    // Mirror the real SDK contract: the stream generator returns cleanly
    // when the caller's signal aborts, even mid-await.
    async function* wrapped(): AsyncGenerator<SessionEvent, void, void> {
      while (true) {
        if (signal?.aborted) return;
        const aborted = new Promise<null>((resolve) => {
          signal?.addEventListener("abort", () => resolve(null), { once: true });
        });
        const step = await Promise.race([inner.next(), aborted]);
        if (step === null || step.done) return;
        yield step.value;
      }
    }
    return wrapped();
  }
}

class FakeHostlerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function makeAgentsApi(): HostlerAgentsApi & { created: unknown[] } {
  const created: unknown[] = [];
  return {
    created,
    list: async () => [],
    create: async (config) => {
      created.push(config);
      return { id: "agt_1", version: 1, config, createdAt: "2026-07-13T00:00:00Z" };
    },
    createVersion: async (id, config) => ({
      id,
      version: 2,
      config,
      createdAt: "2026-07-13T00:00:00Z",
    }),
  };
}

function makeClient(sessions: {
  create: (options: CreateSessionOptions) => Promise<HostlerSessionLike>;
  get: (id: string) => Promise<HostlerSessionLike>;
}): HostlerClientLike & { agents: ReturnType<typeof makeAgentsApi> } {
  return { agents: makeAgentsApi(), sessions };
}

function makeSdk(client: HostlerClientLike): HostlerSdkModule {
  return {
    Hostler: class {
      agents = client.agents;
      sessions = client.sessions;
      constructor(_options: { apiKey: string | undefined; baseUrl?: string }) {}
    },
  };
}

function makeFrameworkConfig(
  hostler: AgentFrameworkConfig["hostler"],
): AgentFrameworkConfig {
  return { model: "claude-sonnet-4-5", hostler };
}

function makeRunParams(overrides?: Partial<AgentRunParams>): AgentRunParams {
  return {
    taskId: "task-1",
    prompt: "How many unread emails do I have?",
    context: { accountId: "acc1", userEmail: "user@example.com" },
    tools: [
      { name: "read_email", description: "Read an email", inputSchema: z.object({ id: z.string() }) },
    ],
    toolExecutor: async () => "ok",
    netFetch: async () => ({ status: 200, headers: {}, body: "" }),
    recordSessionStart: () => {},
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function drain(
  gen: AsyncGenerator<AgentEvent, AgentRunResult, void>,
): Promise<{ events: AgentEvent[]; result: AgentRunResult }> {
  const events: AgentEvent[] = [];
  let step = await gen.next();
  while (!step.done) {
    events.push(step.value);
    step = await gen.next();
  }
  return { events, result: step.value };
}

test("happy path: syncs agent, runs a client tool locally, completes", async () => {
  async function* script(s: FakeSession): AsyncGenerator<SessionEvent, void, void> {
    yield { ...base(), type: "session.status_running" };
    yield {
      ...base(),
      type: "agent.tool_use",
      toolCallId: "call_1",
      name: "read_email",
      input: { id: "e1" },
      locale: "client",
    };
    yield {
      ...base(),
      type: "agent.tool_pending",
      toolCallId: "call_1",
      name: "read_email",
      pendingState: "async",
    };
    const posted = await s.nextToolResult();
    yield {
      ...base(),
      type: "agent.tool_result",
      toolCallId: "call_1",
      name: "read_email",
      isError: false,
      content: [{ type: "text", text: posted.content ?? "" }],
    };
    yield { ...base(), type: "agent.message", text: "You have 3 unread emails." };
    yield { ...base(), type: "session.status_idle", stopReason: { type: "end_turn" } };
  }

  const session = new FakeSession("ses_1", script);
  const createdWith: CreateSessionOptions[] = [];
  const client = makeClient({
    create: async (options) => {
      createdWith.push(options);
      return session;
    },
    get: async () => {
      throw new FakeHostlerError("not found", 404);
    },
  });

  const executed: { name: string; args: Record<string, unknown> }[] = [];
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const params = makeRunParams({
    toolExecutor: async (name, args) => {
      executed.push({ name, args });
      return { emailBody: "hello" };
    },
  });
  const { events, result } = await drain(provider.run(params));

  expect(events[0]).toEqual({ type: "state", state: "running" });
  expect(events).toContainEqual({
    type: "tool_call_start",
    toolName: "read_email",
    toolCallId: "call_1",
    input: { id: "e1" },
  });
  expect(events).toContainEqual({
    type: "tool_call_end",
    toolCallId: "call_1",
    result: JSON.stringify({ emailBody: "hello" }),
  });
  expect(events).toContainEqual({ type: "text_delta", text: "You have 3 unread emails." });
  expect(events).toContainEqual({ type: "done", summary: "You have 3 unread emails." });
  expect(result).toEqual({ state: "completed", providerTaskId: "ses_1" });

  // The tool executed locally through the orchestrator's executor.
  expect(executed).toEqual([{ name: "read_email", args: { id: "e1" } }]);
  expect(session.toolResults).toEqual([
    { toolCallId: "call_1", content: JSON.stringify({ emailBody: "hello" }) },
  ]);

  // Agent synced with client tools declared.
  expect(client.agents.created).toHaveLength(1);
  expect(client.agents.created[0]).toMatchObject({
    harness: "pi",
    model: DEFAULT_HOSTLER_MODEL,
    clientTools: [{ name: "read_email" }],
  });

  // Session pinned to the synced agent version; first message carries context.
  expect(createdWith[0]).toMatchObject({ agentId: "agt_1", agentVersion: 1 });
  expect(session.sentMessages).toHaveLength(1);
  expect(session.sentMessages[0]).toContain("Context for this conversation");
  expect(session.sentMessages[0]).toContain("User request: How many unread emails do I have?");
});

test("tool executor failure posts an error tool-result and the turn completes", async () => {
  async function* script(s: FakeSession): AsyncGenerator<SessionEvent, void, void> {
    yield {
      ...base(),
      type: "agent.tool_use",
      toolCallId: "call_1",
      name: "read_email",
      input: { id: "e1" },
      locale: "client",
    };
    yield {
      ...base(),
      type: "agent.tool_pending",
      toolCallId: "call_1",
      name: "read_email",
      pendingState: "async",
    };
    await s.nextToolResult();
    yield { ...base(), type: "agent.message", text: "I could not read that email." };
    yield { ...base(), type: "session.status_idle", stopReason: { type: "end_turn" } };
  }

  const session = new FakeSession("ses_1", script);
  const client = makeClient({
    create: async () => session,
    get: async () => {
      throw new FakeHostlerError("not found", 404);
    },
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const { result } = await drain(
    provider.run(
      makeRunParams({
        toolExecutor: async () => {
          throw new Error('Tool "read_email" was rejected by user');
        },
      }),
    ),
  );

  expect(result.state).toBe("completed");
  expect(session.toolResults).toEqual([
    { toolCallId: "call_1", error: 'Tool "read_email" was rejected by user' },
  ]);
});

test("follow-up reuses the live session: no create, no preamble, resumed cursor", async () => {
  async function* script(): AsyncGenerator<SessionEvent, void, void> {
    seq = 7; // continue past the existing log
    yield { ...base(), type: "agent.message", text: "Done." };
    yield { ...base(), type: "session.status_idle", stopReason: { type: "end_turn" } };
  }

  const session = new FakeSession("ses_prior", script);
  session.history = [
    { seq: 7, id: "sevt_7", ts: 7, type: "session.status_idle", stopReason: { type: "end_turn" } },
  ];
  let created = 0;
  const client = makeClient({
    create: async () => {
      created += 1;
      return session;
    },
    get: async (id) => {
      expect(id).toBe("ses_prior");
      return session;
    },
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const { result } = await drain(
    provider.run(
      makeRunParams({
        prompt: "Now archive it",
        context: {
          accountId: "acc1",
          userEmail: "user@example.com",
          providerConversationIds: { hostler: "ses_prior" },
        },
      }),
    ),
  );

  expect(created).toBe(0);
  expect(result).toEqual({ state: "completed", providerTaskId: "ses_prior" });
  // Follow-ups send the raw prompt — context is already in-session.
  expect(session.sentMessages).toEqual(["Now archive it"]);
  // Stream resumes past the log the sidebar already rendered.
  expect(session.streamOptions?.since).toBe(7);
});

test("provider disabled or missing key fails fast with a friendly error", async () => {
  const disabled = new HostlerAgentProvider(makeFrameworkConfig({ enabled: false }));
  const { events: e1, result: r1 } = await drain(disabled.run(makeRunParams()));
  expect(r1.state).toBe("failed");
  expect(e1).toContainEqual({
    type: "error",
    message: "Hostler provider is not enabled in Settings",
  });

  const keyless = new HostlerAgentProvider(makeFrameworkConfig({ enabled: true }));
  const { result: r2 } = await drain(keyless.run(makeRunParams()));
  expect(r2.state).toBe("failed");

  expect(await disabled.isAvailable()).toBe(false);
  expect(await keyless.isAvailable()).toBe(false);
});

test("billing failure on session create surfaces the subscription hint", async () => {
  const client = makeClient({
    create: async () => {
      throw new FakeHostlerError("no active subscription", 402);
    },
    get: async () => {
      throw new FakeHostlerError("not found", 404);
    },
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const { events, result } = await drain(provider.run(makeRunParams()));

  expect(result.state).toBe("failed");
  const error = events.find((e) => e.type === "error");
  expect(error).toBeDefined();
  expect(error && "message" in error ? error.message : "").toContain("subscription");
});

test("requires_action idle keeps the loop alive until the tool result lands", async () => {
  // The harness's run can end while a client tool is still parked — the
  // platform then idles with requires_action. That idle must NOT terminate
  // the run; the turn resumes once the tool result is posted.
  async function* script(s: FakeSession): AsyncGenerator<SessionEvent, void, void> {
    yield {
      ...base(),
      type: "agent.tool_use",
      toolCallId: "call_1",
      name: "read_email",
      input: { id: "e1" },
      locale: "client",
    };
    yield {
      ...base(),
      type: "agent.tool_pending",
      toolCallId: "call_1",
      name: "read_email",
      pendingState: "async",
    };
    yield {
      ...base(),
      type: "session.status_idle",
      stopReason: { type: "requires_action", toolCallIds: ["call_1"] },
    };
    await s.nextToolResult();
    yield { ...base(), type: "agent.message", text: "Done after requires_action." };
    yield { ...base(), type: "session.status_idle", stopReason: { type: "end_turn" } };
  }

  const session = new FakeSession("ses_1", script);
  const client = makeClient({
    create: async () => session,
    get: async () => {
      throw new FakeHostlerError("not found", 404);
    },
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const { events, result } = await drain(provider.run(makeRunParams()));

  expect(result).toEqual({ state: "completed", providerTaskId: "ses_1" });
  expect(session.toolResults).toHaveLength(1);
  expect(events).toContainEqual({ type: "done", summary: "Done after requires_action." });
});

test("dead reused session recreates on send conflict: fresh sandbox, preamble, cursor reset", async () => {
  async function* freshScript(): AsyncGenerator<SessionEvent, void, void> {
    yield { ...base(), type: "agent.message", text: "Fresh sandbox reply." };
    yield { ...base(), type: "session.status_idle", stopReason: { type: "end_turn" } };
  }
  async function* deadScript(): AsyncGenerator<SessionEvent, void, void> {
    // Never streams — send() rejects before streaming starts.
  }

  const deadSession = new FakeSession("ses_dead", deadScript);
  deadSession.send = () => Promise.reject(new FakeHostlerError("session is not live", 409));
  deadSession.history = [
    { seq: 9, id: "sevt_9", ts: 9, type: "session.status_idle", stopReason: { type: "end_turn" } },
  ];
  const freshSession = new FakeSession("ses_fresh", freshScript);
  const client = makeClient({
    create: async () => freshSession,
    get: async () => deadSession,
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const { result } = await drain(
    provider.run(
      makeRunParams({
        prompt: "Follow up after reap",
        context: {
          accountId: "acc1",
          userEmail: "user@example.com",
          providerConversationIds: { hostler: "ses_dead" },
        },
      }),
    ),
  );

  expect(result).toEqual({ state: "completed", providerTaskId: "ses_fresh" });
  // The fresh session must get the full context preamble (it has no history)
  // and stream from the top of its own log, not the dead session's cursor.
  expect(freshSession.sentMessages).toHaveLength(1);
  expect(freshSession.sentMessages[0]).toContain("Context for this conversation");
  expect(freshSession.sentMessages[0]).toContain("User request: Follow up after reap");
  expect(freshSession.streamOptions?.since).toBe(0);
});

test("cancel mid-stream yields cancelled and interrupts (not terminates) the session", async () => {
  async function* script(s: FakeSession): AsyncGenerator<SessionEvent, void, void> {
    yield { ...base(), type: "agent.message_delta", text: "Thinking about" };
    // Park forever — only the abort ends the stream.
    await s.nextToolResult();
  }

  const session = new FakeSession("ses_1", script);
  const client = makeClient({
    create: async () => session,
    get: async () => {
      throw new FakeHostlerError("not found", 404);
    },
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const draining = drain(provider.run(makeRunParams({ taskId: "task-cancel" })));
  // Let the run reach the stream loop before cancelling.
  await new Promise((r) => setTimeout(r, 50));
  provider.cancel("task-cancel");
  const { events, result } = await draining;

  expect(result).toEqual({ state: "cancelled", providerTaskId: "ses_1" });
  expect(events).toContainEqual({ type: "state", state: "cancelled" });
  // The sandbox stays warm for follow-ups: interrupted, never terminated here.
  expect(session.interrupted).toBe(true);
  expect(session.terminated).toBe(false);
});

test("follow-up after cancel resumes past the interrupted idle instead of replaying it", async () => {
  // The critical replay bug: a cancelled run stops consuming the stream
  // before the platform appends status_idle(interrupted) to the durable log.
  // If the follow-up trusted the cancelled run's in-memory cursor, the SDK
  // would replay that stale idle first and the follow-up would instantly
  // mis-terminate as "cancelled". The provider must re-fetch the log tail on
  // reuse and stream strictly past it.
  let turn = 0;
  async function* script(s: FakeSession): AsyncGenerator<SessionEvent, void, void> {
    turn += 1;
    if (turn === 1) {
      yield { seq: 1, id: "sevt_1", ts: 1, type: "agent.message_delta", text: "half an ans" };
      await s.nextToolResult(); // park until the abort ends the stream
      return;
    }
    // Durable-log replay semantics: a cursor below the stale idle replays it.
    if ((s.streamOptions?.since ?? 0) < 2) {
      yield {
        seq: 2,
        id: "sevt_2",
        ts: 2,
        type: "session.status_idle",
        stopReason: { type: "interrupted" },
      };
    }
    yield { seq: 3, id: "sevt_3", ts: 3, type: "agent.message", text: "Second answer." };
    yield { seq: 4, id: "sevt_4", ts: 4, type: "session.status_idle", stopReason: { type: "end_turn" } };
  }

  const session = new FakeSession("ses_1", script);
  const client = makeClient({
    create: async () => session,
    get: async () => session,
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  // Turn 1: cancel mid-answer. The platform then appends the interrupted
  // idle (seq 2) to the durable log — an event this run never consumed.
  const draining = drain(provider.run(makeRunParams({ taskId: "t1" })));
  await new Promise((r) => setTimeout(r, 50));
  provider.cancel("t1");
  const first = await draining;
  expect(first.result.state).toBe("cancelled");
  session.history = [
    { seq: 2, id: "sevt_2", ts: 2, type: "session.status_idle", stopReason: { type: "interrupted" } },
  ];

  // Turn 2: follow-up on the same session must complete with the new answer.
  const { events, result } = await drain(
    provider.run(
      makeRunParams({
        taskId: "t2",
        prompt: "and the follow-up?",
        context: {
          accountId: "acc1",
          userEmail: "user@example.com",
          providerConversationIds: { hostler: "ses_1" },
        },
      }),
    ),
  );

  expect(session.streamOptions?.since).toBe(2);
  expect(result).toEqual({ state: "completed", providerTaskId: "ses_1" });
  expect(events).toContainEqual({ type: "done", summary: "Second answer." });
});

test("stream ending without an idle event fails the run (never fakes completion)", async () => {
  async function* script(): AsyncGenerator<SessionEvent, void, void> {
    yield { ...base(), type: "agent.message_delta", text: "partial answ" };
    // Stream dies with no status_idle / status_terminated.
  }

  const session = new FakeSession("ses_1", script);
  const client = makeClient({
    create: async () => session,
    get: async () => {
      throw new FakeHostlerError("not found", 404);
    },
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  const { events, result } = await drain(provider.run(makeRunParams()));

  expect(result).toEqual({ state: "failed", providerTaskId: "ses_1" });
  expect(events).toContainEqual({
    type: "error",
    message: "Hostler event stream ended unexpectedly",
  });
  expect(events.filter((e) => e.type === "done")).toHaveLength(0);
});

test("402 on session create reaps warm sessions and retries once", async () => {
  // The platform reserves credit per LIVE session, so a warm-but-idle
  // session from a finished conversation can block a new sandbox with a 402
  // despite a positive balance. The provider must free its own warm sessions
  // and retry rather than surfacing a bogus "top up" error.
  async function* answer(): AsyncGenerator<SessionEvent, void, void> {
    yield { ...base(), type: "agent.message", text: "Answered." };
    yield { ...base(), type: "session.status_idle", stopReason: { type: "end_turn" } };
  }

  const warmSession = new FakeSession("ses_warm", answer);
  const freshSession = new FakeSession("ses_fresh", answer);
  let creates = 0;
  const client = makeClient({
    create: async () => {
      creates += 1;
      if (creates === 1) return warmSession;
      if (creates === 2) throw new FakeHostlerError("insufficient credit balance", 402);
      return freshSession;
    },
    get: async () => {
      throw new FakeHostlerError("not found", 404);
    },
  });
  const provider = new HostlerAgentProvider(
    makeFrameworkConfig({ enabled: true, apiKey: "cpk_test" }),
  );
  provider._setSdkForTesting(makeSdk(client));

  // Run 1 completes and leaves ses_warm idle-with-timer.
  const first = await drain(provider.run(makeRunParams({ taskId: "t1" })));
  expect(first.result.state).toBe("completed");

  // Run 2 (new conversation): create 402s once, warm session is reaped, retry succeeds.
  seq = 0;
  const second = await drain(provider.run(makeRunParams({ taskId: "t2" })));
  expect(second.result).toEqual({ state: "completed", providerTaskId: "ses_fresh" });
  expect(warmSession.terminated).toBe(true);
  expect(creates).toBe(3);
});

test("resolveHostlerModel parses selectors", () => {
  expect(resolveHostlerModel(undefined)).toEqual(DEFAULT_HOSTLER_MODEL);
  expect(resolveHostlerModel("  ")).toEqual(DEFAULT_HOSTLER_MODEL);
  expect(resolveHostlerModel("claude-sonnet-4-5")).toEqual({
    provider: "anthropic",
    id: "claude-sonnet-4-5",
  });
  expect(resolveHostlerModel("openai/gpt-6")).toEqual({ provider: "openai", id: "gpt-6" });
});

test("buildFirstMessage includes context, memory, and replayed history", () => {
  const message = buildFirstMessage(
    {
      accountId: "acc1",
      userEmail: "user@example.com",
      userName: "Ankit",
      currentEmailId: "e42",
      currentThreadId: "t7",
      memoryContext: "## Memory\nPrefers short replies.",
      conversationHistory: "User: hi\nAssistant: hello",
    },
    "Reply to this",
  );

  expect(message).toContain("user@example.com (Ankit)");
  expect(message).toContain("Currently viewing email ID: e42");
  expect(message).toContain("Current thread ID: t7");
  expect(message).toContain("Prefers short replies.");
  expect(message).toContain("## Previous conversation");
  expect(message).toContain("User request: Reply to this");
});
