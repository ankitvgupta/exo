import { randomUUID } from "node:crypto";
import type {
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  AgentFrameworkConfig,
} from "../types";
import { createLogger } from "../../services/logger";
import { getCodexAuthStatus, runCodexExec } from "../../services/codex-service";

const log = createLogger("codex-agent");

type ConversationEntry =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string }
  | { role: "tool"; toolName: string; content: string };

type ParsedAction =
  | { type: "final"; content: string }
  | { type: "tool_call"; toolName: string; args: Record<string, unknown> }
  | null;

export class CodexAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "codex-agent",
    name: "Codex Agent",
    description: "Codex CLI (OAuth) with tool access",
    auth: { type: "oauth" },
  };

  private frameworkConfig: AgentFrameworkConfig;
  private activeControllers = new Map<string, AbortController>();

  constructor(frameworkConfig: AgentFrameworkConfig) {
    this.frameworkConfig = frameworkConfig;
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    params.signal.addEventListener("abort", onAbort, { once: true });
    this.activeControllers.set(params.taskId, controller);

    const convo: ConversationEntry[] = [];
    if (params.context.conversationHistory) {
      convo.push({
        role: "user",
        content: `Prior conversation context:\n${params.context.conversationHistory}`,
      });
    }
    convo.push({ role: "user", content: params.prompt });

    yield { type: "state", state: "running" };

    try {
      for (let turn = 0; turn < 20; turn++) {
        if (controller.signal.aborted) {
          yield { type: "state", state: "cancelled" };
          return { state: "cancelled" };
        }

        const model = resolveCodexModel(params.modelOverride, this.frameworkConfig.codex?.model);
        const prompt = buildCodexAgentPrompt(convo, params);
        const response = await runCodexExec(prompt, {
          cliPath: this.frameworkConfig.codex?.cliPath,
          model,
          signal: controller.signal,
          timeoutMs: 180_000,
        });
        const action = parseAction(response.text);

        if (!action) {
          const fallbackText = response.text.trim();
          if (fallbackText) {
            yield { type: "text_delta", text: fallbackText };
            yield { type: "done", summary: summarize(fallbackText) };
            return { state: "completed" };
          }
          yield { type: "error", message: "Codex returned an empty response" };
          return { state: "failed" };
        }

        if (action.type === "final") {
          const finalText = action.content.trim();
          yield { type: "text_delta", text: finalText };
          yield { type: "done", summary: summarize(finalText) };
          return { state: "completed" };
        }

        const toolCallId = randomUUID();
        yield {
          type: "tool_call_start",
          toolName: action.toolName,
          toolCallId,
          input: action.args,
        };

        try {
          const result = await params.toolExecutor(action.toolName, action.args);
          yield { type: "tool_call_end", toolCallId, result };
          convo.push({
            role: "assistant",
            content: JSON.stringify(
              {
                type: "tool_call",
                tool_name: action.toolName,
                arguments: action.args,
              },
              null,
              2,
            ),
          });
          convo.push({
            role: "tool",
            toolName: action.toolName,
            content: JSON.stringify(result),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          yield { type: "tool_call_end", toolCallId, result: { error: message } };
          convo.push({
            role: "assistant",
            content: JSON.stringify(
              {
                type: "tool_call",
                tool_name: action.toolName,
                arguments: action.args,
              },
              null,
              2,
            ),
          });
          convo.push({
            role: "tool",
            toolName: action.toolName,
            content: JSON.stringify({ error: message }),
          });
        }
      }

      yield { type: "error", message: "Codex agent exceeded max tool turns" };
      return { state: "failed" };
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled" };
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error({ err: error }, `[CodexAgent] Run failed: ${message}`);
      yield { type: "error", message };
      return { state: "failed" };
    } finally {
      this.activeControllers.delete(params.taskId);
      params.signal.removeEventListener("abort", onAbort);
    }
  }

  cancel(taskId: string): void {
    this.activeControllers.get(taskId)?.abort();
    this.activeControllers.delete(taskId);
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.frameworkConfig = { ...this.frameworkConfig, ...config };
  }

  async isAvailable(): Promise<boolean> {
    const status = await getCodexAuthStatus(this.frameworkConfig.codex?.cliPath || "codex");
    return status.cliAvailable && status.authenticated;
  }
}

function resolveCodexModel(
  modelOverride: string | undefined,
  defaultModel: string | undefined,
): string {
  const fallback = defaultModel || "gpt-5.4";
  if (!modelOverride) return fallback;

  // Interactive agent runs may pass a model tier resolved for Claude (e.g. "claude-opus-4-6").
  // Codex CLI rejects those model IDs, so fall back to the configured Codex model.
  if (modelOverride.startsWith("claude-")) {
    log.warn(
      `[Codex] Ignoring unsupported model override "${modelOverride}" and using "${fallback}"`,
    );
    return fallback;
  }
  return modelOverride;
}

function buildCodexAgentPrompt(convo: ConversationEntry[], params: AgentRunParams): string {
  const toolList = params.tools.map((tool) => `- ${tool.name}: ${tool.description}`).join("\n");

  const contextLines = [
    `accountId=${params.context.accountId}`,
    params.context.currentEmailId ? `currentEmailId=${params.context.currentEmailId}` : null,
    params.context.currentThreadId ? `currentThreadId=${params.context.currentThreadId}` : null,
    params.context.userEmail ? `userEmail=${params.context.userEmail}` : null,
    params.context.emailSubject ? `emailSubject=${params.context.emailSubject}` : null,
    params.context.emailFrom ? `emailFrom=${params.context.emailFrom}` : null,
    params.context.memoryContext ? `memoryContext=${params.context.memoryContext}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const transcript = convo
    .map((entry) => {
      if (entry.role === "tool") {
        return `TOOL_RESULT (${entry.toolName}):\n${entry.content}`;
      }
      return `${entry.role.toUpperCase()}:\n${entry.content}`;
    })
    .join("\n\n");

  return [
    "You are an email assistant running inside Exo.",
    "You can call tools to inspect email/thread data and draft updates.",
    "When you need a tool, respond with JSON only:",
    '{"type":"tool_call","tool_name":"<tool name>","arguments":{"key":"value"}}',
    'When you are ready to answer, respond with JSON only: {"type":"final","content":"..."}',
    "Do not output markdown fences around the JSON.",
    "",
    "AVAILABLE TOOLS:",
    toolList || "(none)",
    "",
    "RUNTIME CONTEXT:",
    contextLines || "(none)",
    "",
    "CONVERSATION SO FAR:",
    transcript,
  ].join("\n");
}

function parseAction(text: string): ParsedAction {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  const parsed = tryParseJson(withoutFence) ?? tryParseJson(extractJsonObject(withoutFence));
  if (!parsed || typeof parsed !== "object") {
    return { type: "final", content: trimmed };
  }

  const obj = parsed as Record<string, unknown>;
  const type = typeof obj.type === "string" ? obj.type : "";

  if (type === "tool_call" || type === "tool") {
    const toolNameRaw =
      typeof obj.tool_name === "string"
        ? obj.tool_name
        : typeof obj.toolName === "string"
          ? obj.toolName
          : "";
    const argsRaw = obj.arguments;
    const args =
      argsRaw && typeof argsRaw === "object" && !Array.isArray(argsRaw)
        ? (argsRaw as Record<string, unknown>)
        : {};
    if (toolNameRaw) {
      return {
        type: "tool_call",
        toolName: toolNameRaw,
        args,
      };
    }
  }

  if (type === "final" && typeof obj.content === "string") {
    return { type: "final", content: obj.content };
  }

  return { type: "final", content: trimmed };
}

function summarize(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.slice(0, 160) || "Completed";
}

function tryParseJson(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function extractJsonObject(input: string): string {
  const start = input.indexOf("{");
  const end = input.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return input;
  return input.slice(start, end + 1);
}
