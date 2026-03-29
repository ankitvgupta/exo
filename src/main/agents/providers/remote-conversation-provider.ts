import type {
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentResumeParams,
  AgentToolDecisionParams,
  AgentEvent,
} from "../types";

type StreamProtocol = "sse" | "null_json";

/** Generic parsed event from a remote conversation stream */
export type RemoteStreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_call_start"; tool_name: string; call_id: string; input: unknown }
  | { type: "tool_call_end"; call_id: string; result: unknown }
  | { type: "pending_approval"; call_id: string; tool_name: string; description?: string }
  | { type: "pending_async"; call_id: string; tool_name: string; description?: string }
  | { type: "done"; summary?: string }
  | { type: "error"; message: string };

export interface RemoteConversationConfig {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  apiKey: string;
  streamProtocol?: StreamProtocol;
}

/**
 * Generic provider for external conversation-based agents.
 * Supports SSE and null-delimited JSON stream protocols.
 *
 * State machine:
 *   running -> pending_approval -> completed/failed
 *   running -> pending_async -> completed/failed
 *   running -> completed/failed
 */
export class RemoteConversationProvider implements AgentProvider {
  readonly config: AgentProviderConfig;

  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly protocol: StreamProtocol;
  private inFlight = new Map<string, AbortController>();

  constructor(cfg: RemoteConversationConfig) {
    this.baseUrl = cfg.endpoint;
    this.apiKey = cfg.apiKey;
    this.protocol = cfg.streamProtocol ?? "sse";
    this.config = {
      id: cfg.id,
      name: cfg.name,
      description: cfg.description,
      auth: { type: "api_key" },
    };
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const controller = new AbortController();
    this.inFlight.set(params.taskId, controller);
    const signal = composeSignals(params.signal, controller.signal, 30_000);

    yield { type: "state", state: "running" };

    const startResponse = await fetch(`${this.baseUrl}/conversations`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        prompt: params.prompt,
        context: params.context,
        available_tools: params.tools.map((t) => t.name),
      }),
    });

    if (!startResponse.ok) {
      yield { type: "error", message: `Remote provider start failed (${startResponse.status})` };
      return { state: "failed" };
    }

    const session = (await startResponse.json()) as {
      conversation_id: string;
      stream_url: string;
    };
    const providerTaskId = session.conversation_id;

    try {
      for await (const event of this.streamEvents(session.stream_url, signal)) {
        const result = yield* this.handleStreamEvent(event, providerTaskId);
        if (result) return result;
      }
      return { state: "failed", providerTaskId };
    } finally {
      this.inFlight.delete(params.taskId);
    }
  }

  async *resume(params: AgentResumeParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const signal = composeSignals(params.signal, undefined, 30_000);

    for await (const event of this.streamEvents(
      `${this.baseUrl}/conversations/${params.providerTaskId}/stream`,
      signal,
    )) {
      const result = yield* this.handleStreamEvent(event, params.providerTaskId);
      if (result) return result;
    }
    return { state: "failed", providerTaskId: params.providerTaskId };
  }

  async submitToolDecision(params: AgentToolDecisionParams): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/conversations/${params.providerTaskId}/tool-calls/${params.toolCallId}/decision`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ approved: params.approved }),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to submit tool decision (${response.status})`);
    }
  }

  cancel(taskId: string): void {
    this.inFlight.get(taskId)?.abort();
    this.inFlight.delete(taskId);
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey && this.baseUrl);
  }

  // --- Internals ---

  protected headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  /**
   * Handle a single stream event and optionally return a terminal result.
   * Uses a generator so the caller can yield* the AgentEvents.
   */
  private *handleStreamEvent(
    event: RemoteStreamEvent,
    providerTaskId: string,
  ): Generator<AgentEvent, AgentRunResult | undefined> {
    switch (event.type) {
      case "text":
        yield { type: "text_delta", text: event.content };
        return undefined;

      case "tool_call_start":
        yield {
          type: "tool_call_start",
          toolName: event.tool_name,
          toolCallId: event.call_id,
          input: event.input,
        };
        return undefined;

      case "tool_call_end":
        yield {
          type: "tool_call_end",
          toolCallId: event.call_id,
          result: event.result,
        };
        return undefined;

      case "pending_approval":
      case "pending_async":
        yield {
          type: "tool_call_pending",
          toolCallId: event.call_id,
          toolName: event.tool_name,
          pendingState: event.type,
          description: event.description,
        };
        yield { type: "state", state: event.type };
        return { state: event.type, providerTaskId };

      case "done":
        yield { type: "done", summary: event.summary ?? "Completed" };
        return { state: "completed", providerTaskId };

      case "error":
        yield { type: "error", message: event.message };
        return { state: "failed", providerTaskId };
    }
  }

  /**
   * Open a streaming connection and parse events according to the configured protocol.
   */
  protected async *streamEvents(
    url: string,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteStreamEvent> {
    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.apiKey}` },
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`Remote provider stream failed (${response.status})`);
    }

    if (this.protocol === "null_json") {
      yield* parseNullDelimitedStream(response.body);
    } else {
      yield* parseSseStream(response.body);
    }
  }
}

// --- Stream Parsers ---

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RemoteStreamEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      buffer = lines.pop() ?? "";

      let eventData = "";
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          eventData += line.slice(6);
        } else if (line === "" && eventData) {
          try {
            yield JSON.parse(eventData) as RemoteStreamEvent;
          } catch {
            // Skip malformed JSON events
          }
          eventData = "";
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function* parseNullDelimitedStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<RemoteStreamEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\0");
      // Keep the last (possibly incomplete) segment
      buffer = parts.pop() ?? "";

      for (const part of parts) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        try {
          yield JSON.parse(trimmed) as RemoteStreamEvent;
        } catch {
          // Skip malformed JSON segments
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// --- Helpers ---

/**
 * Compose multiple abort signals + an optional timeout into a single signal.
 */
function composeSignals(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const signals: AbortSignal[] = [primary, AbortSignal.timeout(timeoutMs)];
  if (secondary) signals.push(secondary);
  return AbortSignal.any(signals);
}
