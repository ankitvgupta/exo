import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type ThreadEvent,
  type ThreadItem,
  type TurnOptions,
  type ThreadOptions,
} from "@openai/codex-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type {
  AgentProvider,
  AgentProviderConfig,
  AgentRunParams,
  AgentRunResult,
  AgentEvent,
  AgentToolSpec,
  AgentFrameworkConfig,
} from "../types";
import { createLogger } from "../../services/logger";
import {
  buildCodexThreadOptions,
  createCodexClient,
  getCodexAuthStatus,
  resolveCodexModel,
} from "../../services/codex-cli";
import { buildAgentSystemPrompt } from "./shared/system-prompt";

const log = createLogger("codex-agent");

type ToolBridge = {
  url: string;
  close: () => Promise<void>;
};

type CodexRunState = {
  startedToolIds: Set<string>;
  completedToolIds: Set<string>;
  lastAgentTextById: Map<string, string>;
  finalResponse: string;
};

export class CodexAgentProvider implements AgentProvider {
  readonly config: AgentProviderConfig = {
    id: "codex",
    name: "Codex",
    description: "OpenAI Codex with Exo email tools and ChatGPT/Codex login",
    auth: { type: "oauth" },
  };

  private frameworkConfig: AgentFrameworkConfig;
  private activeTasks = new Map<string, AbortController>();

  constructor(frameworkConfig: AgentFrameworkConfig) {
    this.frameworkConfig = frameworkConfig;
  }

  updateConfig(config: Partial<AgentFrameworkConfig>): void {
    this.frameworkConfig = { ...this.frameworkConfig, ...config };
  }

  async isAvailable(): Promise<boolean> {
    const status = await getCodexAuthStatus();
    return status.cliAvailable && status.authenticated;
  }

  async *run(params: AgentRunParams): AsyncGenerator<AgentEvent, AgentRunResult, void> {
    const status = await getCodexAuthStatus();
    if (!status.cliAvailable || !status.authenticated) {
      yield { type: "error", message: "AGENT_AUTH_REQUIRED" };
      return { state: "failed" };
    }

    yield { type: "state", state: "running" };

    const controller = new AbortController();
    this.activeTasks.set(params.taskId, controller);

    const onParentAbort = () => controller.abort();
    params.signal.addEventListener("abort", onParentAbort, { once: true });

    let toolBridge: ToolBridge | null = null;

    try {
      toolBridge = await startToolBridge(params.tools, params.toolExecutor);

      const threadOptions = this.buildThreadOptions(params.modelOverride);
      const threadId = params.context.providerConversationIds?.[this.config.id];

      const codex = createCodexClient({
        mcp_servers: {
          exo: {
            url: toolBridge.url,
            enabled_tools: params.tools.map((tool) => tool.name),
          },
        },
      });

      const thread = threadId ? codex.resumeThread(threadId, threadOptions) : codex.startThread(threadOptions);
      const prompt = buildCodexAgentPrompt(
        buildAgentSystemPrompt(
          params.context,
          params.tools,
          params.context.memoryContext,
        ),
        params.prompt,
      );

      const run = await thread.runStreamed(prompt, {
        signal: controller.signal,
      } satisfies TurnOptions);

      const state: CodexRunState = {
        startedToolIds: new Set<string>(),
        completedToolIds: new Set<string>(),
        lastAgentTextById: new Map<string, string>(),
        finalResponse: "",
      };

      for await (const event of run.events) {
        if (controller.signal.aborted) {
          yield { type: "state", state: "cancelled" };
          return { state: "cancelled", providerTaskId: thread.id ?? threadId };
        }

        if (event.type === "thread.started") {
          continue;
        }

        if (event.type === "turn.failed") {
          yield { type: "error", message: event.error.message };
          return { state: "failed", providerTaskId: thread.id ?? threadId };
        }

        if (event.type === "error") {
          yield { type: "error", message: event.message };
          return { state: "failed", providerTaskId: thread.id ?? threadId };
        }

        if (event.type === "turn.completed") {
          yield { type: "done", summary: state.finalResponse || "Completed" };
          return { state: "completed", providerTaskId: thread.id ?? threadId };
        }

        if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
          yield* mapCodexItemEvent(event.item, event.type, state);
        }
      }

      return { state: controller.signal.aborted ? "cancelled" : "completed", providerTaskId: thread.id ?? threadId };
    } catch (error) {
      if (controller.signal.aborted) {
        yield { type: "state", state: "cancelled" };
        return { state: "cancelled" };
      }

      yield {
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      };
      return { state: "failed" };
    } finally {
      params.signal.removeEventListener("abort", onParentAbort);
      this.activeTasks.delete(params.taskId);
      if (toolBridge) {
        await toolBridge.close().catch((error: unknown) => {
          log.warn({ err: error }, "Failed to close Codex tool bridge");
        });
      }
    }
  }

  cancel(taskId: string): void {
    this.activeTasks.get(taskId)?.abort();
    this.activeTasks.delete(taskId);
  }

  private buildThreadOptions(modelOverride?: string): ThreadOptions {
    const resolvedModel = resolveCodexModel(modelOverride ?? this.frameworkConfig.model);
    return buildCodexThreadOptions({
      model: resolvedModel,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchEnabled: true,
    });
  }
}

function buildCodexAgentPrompt(systemPrompt: string, prompt: string): string {
  return [
    "<system>",
    systemPrompt,
    "",
    "You have access only to the Exo app tools and built-in web search.",
    "Do not inspect local files and do not run shell commands.",
    "</system>",
    "",
    "<user>",
    prompt.trim(),
    "</user>",
  ].join("\n");
}

async function startToolBridge(
  tools: AgentToolSpec[],
  toolExecutor: AgentRunParams["toolExecutor"],
): Promise<ToolBridge> {
  const server = new McpServer({
    name: "exo-mail-app-tools",
    version: "1.0.0",
  });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args) => {
        if (typeof args !== "object" || args === null || Array.isArray(args)) {
          return {
            isError: true,
            content: [{ type: "text", text: `Invalid arguments for tool ${tool.name}` }],
          };
        }

        const input = Object.fromEntries(Object.entries(args));

        try {
          const result = await toolExecutor(tool.name, input);
          const structuredContent =
            typeof result === "object" && result !== null && !Array.isArray(result)
              ? result
              : undefined;
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            ...(structuredContent ? { structuredContent } : {}),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return {
            isError: true,
            content: [{ type: "text", text: message }],
          };
        }
      },
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });

  await server.connect(transport);

  const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (!req.url?.startsWith("/mcp")) {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    transport.handleRequest(req, res).catch((error: unknown) => {
      log.warn({ err: error }, "Codex MCP bridge request failed");
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      if (!res.writableEnded) {
        res.end("MCP request failed");
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to determine Codex MCP bridge address");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      await server.close().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function* mapCodexItemEvent(
  item: ThreadItem,
  eventType: ThreadEvent["type"],
  state: CodexRunState,
): Generator<AgentEvent> {
  switch (item.type) {
    case "agent_message": {
      const previous = state.lastAgentTextById.get(item.id) ?? "";
      if (item.text.length > previous.length && item.text.startsWith(previous)) {
        yield { type: "text_delta", text: item.text.slice(previous.length) };
      } else if (item.text !== previous) {
        yield { type: "text_delta", text: item.text };
      }
      state.lastAgentTextById.set(item.id, item.text);
      if (eventType === "item.completed") {
        state.finalResponse = item.text;
      }
      return;
    }

    case "mcp_tool_call": {
      if (!state.startedToolIds.has(item.id)) {
        state.startedToolIds.add(item.id);
        yield {
          type: "tool_call_start",
          toolName: item.tool,
          toolCallId: item.id,
          input: item.arguments,
        };
      }

      if (item.status !== "in_progress" && !state.completedToolIds.has(item.id)) {
        state.completedToolIds.add(item.id);
        yield {
          type: "tool_call_end",
          toolCallId: item.id,
          result: item.result?.structured_content ?? item.result?.content ?? { error: item.error?.message },
        };
      }
      return;
    }

    case "web_search": {
      if (!state.startedToolIds.has(item.id)) {
        state.startedToolIds.add(item.id);
        yield {
          type: "tool_call_start",
          toolName: "web_search",
          toolCallId: item.id,
          input: { query: item.query },
        };
      }

      if (eventType === "item.completed" && !state.completedToolIds.has(item.id)) {
        state.completedToolIds.add(item.id);
        yield {
          type: "tool_call_end",
          toolCallId: item.id,
          result: { query: item.query },
        };
      }
      return;
    }

    case "command_execution": {
      if (!state.startedToolIds.has(item.id)) {
        state.startedToolIds.add(item.id);
        yield {
          type: "tool_call_start",
          toolName: "command_execution",
          toolCallId: item.id,
          input: { command: item.command },
        };
      }

      if (item.status !== "in_progress" && !state.completedToolIds.has(item.id)) {
        state.completedToolIds.add(item.id);
        yield {
          type: "tool_call_end",
          toolCallId: item.id,
          result: {
            command: item.command,
            status: item.status,
            output: item.aggregated_output,
            exitCode: item.exit_code,
          },
        };
      }
      return;
    }

    case "file_change": {
      if (!state.startedToolIds.has(item.id)) {
        state.startedToolIds.add(item.id);
        yield {
          type: "tool_call_start",
          toolName: "file_change",
          toolCallId: item.id,
          input: { changes: item.changes },
        };
      }

      if (!state.completedToolIds.has(item.id)) {
        state.completedToolIds.add(item.id);
        yield {
          type: "tool_call_end",
          toolCallId: item.id,
          result: {
            status: item.status,
            changes: item.changes,
          },
        };
      }
      return;
    }

    case "error":
      yield { type: "error", message: item.message };
      return;

    case "reasoning":
    case "todo_list":
      return;
  }
}
