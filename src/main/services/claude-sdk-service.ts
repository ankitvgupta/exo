/**
 * Claude Agent SDK adapter — translates Anthropic SDK `createMessage()` calls
 * into Claude Agent SDK `query()` calls.
 *
 * This allows the app to use a Claude Max subscription (flat-rate pricing)
 * instead of pay-per-token API billing, while keeping the same interface
 * for all callers.
 */
import type {
  MessageCreateParamsNonStreaming,
  Message,
  TextBlock,
  ContentBlock,
} from "@anthropic-ai/sdk/resources/messages";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type {
  SDKMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKAssistantMessage,
  Options as SDKOptions,
  ThinkingConfig,
} from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "./logger";

const log = createLogger("claude-sdk");

/**
 * Extract system prompt text from Anthropic SDK system param format.
 * The Anthropic SDK accepts system as string or array of content blocks.
 */
function extractSystemPrompt(
  system: MessageCreateParamsNonStreaming["system"],
): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system;
  // Array of text blocks — concatenate text parts
  return system
    .map((block) => {
      if ("text" in block) return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Extract user prompt text from Anthropic SDK messages array.
 * Our callers always send a single user message.
 */
function extractUserPrompt(messages: MessageCreateParamsNonStreaming["messages"]): string {
  // Find the last user message
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      if (typeof msg.content === "string") return msg.content;
      // Array of content blocks — concatenate text parts
      return msg.content
        .map((block) => {
          if (block.type === "text") return block.text;
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
  }
  throw new Error("No user message found in messages array");
}

/**
 * Check if the params include tools that need special handling.
 */
function hasWebSearchTool(params: MessageCreateParamsNonStreaming): boolean {
  if (!params.tools) return false;
  return params.tools.some((tool) => {
    if (!("type" in tool)) return false;
    const toolType: string = tool.type;
    return toolType === "web_search_20250305";
  });
}

/**
 * Extract thinking config from Anthropic SDK params and convert to Claude Agent SDK format.
 * Anthropic SDK uses snake_case (budget_tokens), Claude Agent SDK uses camelCase (budgetTokens).
 */
function extractThinkingConfig(
  params: MessageCreateParamsNonStreaming,
): ThinkingConfig | undefined {
  const thinking = params.thinking;
  if (!thinking) return undefined;
  if (thinking.type === "disabled") return { type: "disabled" };
  return { type: "enabled", budgetTokens: thinking.budget_tokens };
}

/**
 * Build SDK options from Anthropic SDK params.
 */
function buildSdkOptions(
  params: MessageCreateParamsNonStreaming,
  timeoutMs?: number,
): { prompt: string; options: SDKOptions } {
  const systemPrompt = extractSystemPrompt(params.system);
  const prompt = extractUserPrompt(params.messages);
  const thinking = extractThinkingConfig(params);
  const needsWebSearch = hasWebSearchTool(params);

  const options: SDKOptions = {
    model: params.model,
    // Web search needs extra turns: tool call + response
    maxTurns: needsWebSearch ? 3 : 1,
    // Disable all tools by default — we want pure LLM completion
    tools: needsWebSearch ? ["WebSearch", "WebFetch"] : [],
    // Don't persist sessions for these ephemeral API-replacement calls
    persistSession: false,
    // Disable thinking by default (most callers don't use it)
    thinking: thinking ?? { type: "disabled" },
    // Don't prompt for permissions
    permissionMode: "dontAsk",
    // Don't load project settings that might interfere
    settingSources: [],
  };

  if (systemPrompt) {
    options.systemPrompt = systemPrompt;
  }

  if (timeoutMs) {
    const abortController = new AbortController();
    setTimeout(() => abortController.abort(), timeoutMs);
    options.abortController = abortController;
  }

  return { prompt, options };
}

/**
 * Collect the final assistant message and result from the SDK query stream.
 */
async function collectSdkResponse(queryResult: AsyncGenerator<SDKMessage, void>): Promise<{
  assistantMessage: SDKAssistantMessage | null;
  result: (SDKResultSuccess | SDKResultError) | null;
}> {
  let assistantMessage: SDKAssistantMessage | null = null;
  let result: (SDKResultSuccess | SDKResultError) | null = null;

  for await (const message of queryResult) {
    if (message.type === "assistant") {
      // Keep the last assistant message (has the content blocks)
      assistantMessage = message;
    } else if (message.type === "result") {
      result = message;
    }
  }

  return { assistantMessage, result };
}

function makeTextBlock(text: string): TextBlock {
  return { type: "text", text, citations: null };
}

/**
 * The SDK adapter builds a Message-compatible object from SDK responses.
 * Some fields (model, stop_reason) come as plain strings from the SDK rather
 * than the narrow literal unions the Anthropic SDK types declare, so a single
 * boundary assertion is used on the return. This is preferable to double-casting
 * every intermediate value.
 */
type SdkAdaptedMessage = Omit<Message, "model" | "stop_reason"> & {
  model: string;
  stop_reason: string | null;
};

/**
 * Adapt SDK response to match the Anthropic SDK Message shape.
 * Callers expect `response.content` with TextBlock/ThinkingBlock entries.
 */
function adaptResponse(
  assistantMessage: SDKAssistantMessage | null,
  result: (SDKResultSuccess | SDKResultError) | null,
  model: string,
): Message {
  // Build content blocks from the assistant message
  const content: ContentBlock[] = [];

  if (assistantMessage?.message?.content) {
    for (const block of assistantMessage.message.content) {
      if (block.type === "text") {
        content.push(makeTextBlock(block.text));
      } else if (block.type === "thinking" && "thinking" in block) {
        // SDK content blocks from BetaMessage are structurally compatible with ContentBlock
        content.push(block);
      }
    }
  } else if (result && "result" in result && result.subtype === "success") {
    content.push(makeTextBlock(result.result));
  }

  if (content.length === 0) {
    content.push(makeTextBlock(""));
  }

  const usage = {
    input_tokens: result?.usage?.input_tokens ?? 0,
    output_tokens: result?.usage?.output_tokens ?? 0,
  };

  const adapted: SdkAdaptedMessage = {
    id: assistantMessage?.uuid ?? "sdk-msg",
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: result?.stop_reason ?? "end_turn",
    stop_sequence: null,
    usage,
  };

  // Single boundary assertion: SdkAdaptedMessage differs from Message only in
  // model (string vs Model) and stop_reason (string vs StopReason), both of
  // which are compatible at runtime.
  return adapted as Message;
}

/**
 * Create a message using the Claude Agent SDK.
 * Drop-in replacement for the Anthropic SDK's createMessage().
 */
export async function createMessageViaSdk(
  params: MessageCreateParamsNonStreaming,
  options: {
    caller: string;
    emailId?: string;
    accountId?: string;
    timeoutMs?: number;
  },
): Promise<{
  message: Message;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const startTime = Date.now();
  const { prompt, options: sdkOptions } = buildSdkOptions(params, options.timeoutMs);

  log.info(
    { caller: options.caller, model: params.model },
    "Creating message via Claude Agent SDK",
  );

  try {
    const queryResult = sdkQuery({ prompt, options: sdkOptions });
    const { assistantMessage, result } = await collectSdkResponse(queryResult);

    if (result && result.is_error && result.subtype !== "success") {
      const errMsg = result.errors?.join("; ") || "SDK query failed";
      throw new Error(errMsg);
    }

    const message = adaptResponse(assistantMessage, result, params.model);
    const durationMs = Date.now() - startTime;

    // Extract usage from result
    const inputTokens = result?.usage?.input_tokens ?? 0;
    const outputTokens = result?.usage?.output_tokens ?? 0;
    const costUsd = result?.total_cost_usd ?? 0;

    log.info(
      {
        caller: options.caller,
        model: params.model,
        inputTokens,
        outputTokens,
        costUsd: costUsd.toFixed(6),
        durationMs,
      },
      "SDK message created successfully",
    );

    return { message, costUsd, durationMs, inputTokens, outputTokens };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error(
      { caller: options.caller, model: params.model, err: error, durationMs },
      "SDK message creation failed",
    );
    throw error;
  }
}

/**
 * Create a streaming message using the Claude Agent SDK.
 * For callers like draft-edit-learner that need streaming + thinking blocks.
 */
export async function createStreamingMessageViaSdk(
  params: {
    model: string;
    max_tokens: number;
    thinking?: ThinkingConfig;
    messages: Array<{ role: string; content: string }>;
  },
  options: {
    caller: string;
    emailId?: string;
    accountId?: string;
  },
): Promise<{
  message: Message;
  costUsd: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}> {
  const startTime = Date.now();
  const prompt = params.messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n\n");

  const sdkOptions: SDKOptions = {
    model: params.model,
    maxTurns: 1,
    tools: [],
    persistSession: false,
    thinking: params.thinking ?? { type: "disabled" },
    permissionMode: "dontAsk",
    settingSources: [],
  };

  log.info(
    { caller: options.caller, model: params.model },
    "Creating streaming message via Claude Agent SDK",
  );

  try {
    const queryResult = sdkQuery({ prompt, options: sdkOptions });
    const { assistantMessage, result } = await collectSdkResponse(queryResult);

    if (result && result.is_error && result.subtype !== "success") {
      const errMsg = result.errors?.join("; ") || "SDK streaming query failed";
      throw new Error(errMsg);
    }

    const message = adaptResponse(assistantMessage, result, params.model);
    const durationMs = Date.now() - startTime;

    const inputTokens = result?.usage?.input_tokens ?? 0;
    const outputTokens = result?.usage?.output_tokens ?? 0;
    const costUsd = result?.total_cost_usd ?? 0;

    log.info(
      {
        caller: options.caller,
        model: params.model,
        inputTokens,
        outputTokens,
        costUsd: costUsd.toFixed(6),
        durationMs,
      },
      "SDK streaming message created successfully",
    );

    return { message, costUsd, durationMs, inputTokens, outputTokens };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    log.error(
      { caller: options.caller, model: params.model, err: error, durationMs },
      "SDK streaming message creation failed",
    );
    throw error;
  }
}
