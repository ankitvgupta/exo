import type {
  MessageCreateParamsNonStreaming,
  Message,
} from "@anthropic-ai/sdk/resources/messages";
import { createLogger } from "./logger";
import { createMessage as createAnthropicMessage, recordStreamingCall } from "./anthropic-service";
import { runCodexExec } from "./codex-service";

const log = createLogger("llm-router");

interface CreateOptions {
  caller: string;
  /** Feature key from ModelConfig — used to select the right Codex model override. */
  feature?: string;
  emailId?: string;
  accountId?: string;
  timeoutMs?: number;
}

type AiProvider = "codex" | "anthropic";

export async function createMessage(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
): Promise<Message> {
  const runtimeConfig = await getRuntimeAiConfig();
  const primary = runtimeConfig.aiProvider;

  if (primary === "anthropic") {
    return createAnthropicMessage(params, options);
  }

  const codexModel = resolveCodexModel(runtimeConfig, options.feature);
  try {
    return await createCodexMessage(params, options, codexModel, runtimeConfig.codexCliPath);
  } catch (error) {
    if (runtimeConfig.enableAnthropicFallback && runtimeConfig.hasAnthropicAuth) {
      log.warn(
        {
          err: error,
          caller: options.caller,
        },
        "[LLM] Codex failed, falling back to Anthropic",
      );
      return createAnthropicMessage(params, options);
    }
    throw error;
  }
}

async function createCodexMessage(
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
  codexModel: string,
  codexCliPath?: string,
): Promise<Message> {
  const prompt = buildCodexPrompt(params);
  const startedAt = Date.now();
  const res = await runCodexExec(prompt, {
    model: codexModel,
    cliPath: codexCliPath,
    timeoutMs: options.timeoutMs,
  });

  recordStreamingCall(`codex:${codexModel}`, options.caller, res.usage, Date.now() - startedAt, {
    emailId: options.emailId,
    accountId: options.accountId,
  });

  const message: Message = {
    id: `msg_codex_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: `codex:${codexModel}`,
    content: [{ type: "text", text: res.text }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      cache_read_input_tokens: res.usage.cache_read_input_tokens,
      cache_creation_input_tokens: res.usage.cache_creation_input_tokens,
    },
  } as Message;

  return message;
}

function buildCodexPrompt(params: MessageCreateParamsNonStreaming): string {
  const systemText = serializeSystemPrompt(params.system);
  const messageText = params.messages
    .map((m) => `${m.role.toUpperCase()}:\n${serializeContent(m.content)}`)
    .join("\n\n");

  return [
    "You are assisting an email workflow.",
    "Return only the final answer requested by the prompt.",
    "",
    systemText ? `SYSTEM:\n${systemText}\n` : "",
    "CONVERSATION:",
    messageText,
  ]
    .filter(Boolean)
    .join("\n");
}

function serializeSystemPrompt(
  system: MessageCreateParamsNonStreaming["system"] | undefined,
): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (Array.isArray(system)) {
    return system
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (
          typeof entry === "object" &&
          entry &&
          "text" in entry &&
          typeof entry.text === "string"
        ) {
          return entry.text;
        }
        return JSON.stringify(entry);
      })
      .join("\n");
  }
  return String(system);
}

function serializeContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const obj = part as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          return JSON.stringify(obj);
        }
        return String(part);
      })
      .join("\n");
  }
  if (content && typeof content === "object") {
    return JSON.stringify(content);
  }
  return String(content ?? "");
}

function resolveCodexModel(config: RuntimeAiConfig, feature?: string): string {
  if (feature) {
    const override = config.codexModelOverrides?.[feature];
    if (override) return override;
  }
  return config.codexModel;
}

interface RuntimeAiConfig {
  aiProvider: AiProvider;
  enableAnthropicFallback: boolean;
  hasAnthropicAuth: boolean;
  codexModel: string;
  codexModelOverrides?: Record<string, string>;
  codexCliPath?: string;
}

async function getRuntimeAiConfig(): Promise<RuntimeAiConfig> {
  const { DEFAULT_CODEX_MODEL_OVERRIDES } = await import("../../shared/types");
  const settings = await import("../ipc/settings.ipc");
  const cfg = settings.getConfig();
  return {
    aiProvider: cfg.aiProvider ?? "codex",
    enableAnthropicFallback: cfg.enableAnthropicFallback ?? true,
    hasAnthropicAuth: Boolean(cfg.anthropicApiKey || process.env.ANTHROPIC_API_KEY),
    codexModel: cfg.codex?.model || "gpt-5.4",
    codexModelOverrides: { ...DEFAULT_CODEX_MODEL_OVERRIDES, ...cfg.codex?.modelOverrides },
    codexCliPath: cfg.codex?.cliPath,
  };
}
