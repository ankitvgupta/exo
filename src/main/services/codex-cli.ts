import { execFile as nodeExecFile } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  Codex,
  type CodexConfigObject,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from "@openai/codex-sdk";
import { createLogger } from "./logger";
import type { LlmCreateOptions, LlmRequest, LlmResponse } from "./llm-types";
import { CODEX_DEFAULT_MODEL, resolveCodexModelId } from "../../shared/types";

const log = createLogger("codex-cli");
const require = createRequire(import.meta.url);

const CODEX_STATUS_TIMEOUT_MS = 10_000;
const CODEX_REQUEST_TIMEOUT_MS = 180_000;

interface CodexThreadLike {
  readonly id: string | null;
  run(
    input: string,
    options?: {
      outputSchema?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<{
    finalResponse: string;
    usage: Usage | null;
  }>;
  runStreamed(
    input: string,
    options?: {
      outputSchema?: unknown;
      signal?: AbortSignal;
    },
  ): Promise<{
    events: AsyncGenerator<ThreadEvent>;
  }>;
}

interface CodexClientLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(threadId: string, options?: ThreadOptions): CodexThreadLike;
}

type ExecFileFn = typeof nodeExecFile;
type CodexClientFactory = (options: {
  codexPathOverride: string;
  env: Record<string, string>;
  config?: CodexConfigObject;
}) => CodexClientLike;

let execFileImpl: ExecFileFn = nodeExecFile;
let codexClientFactory: CodexClientFactory = (options) => new Codex(options);

function copyProcessEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.NO_COLOR = "1";
  env.FORCE_COLOR = "0";
  return env;
}

export function ensureCodexWorkingDir(): string {
  const dir = join(tmpdir(), "exo-codex");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function unpackAsarPath(value: string): string {
  return value.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
}

function resolveTargetTriple(): string {
  switch (process.platform) {
    case "darwin":
      if (process.arch === "arm64") return "aarch64-apple-darwin";
      if (process.arch === "x64") return "x86_64-apple-darwin";
      break;
    case "linux":
    case "android":
      if (process.arch === "arm64") return "aarch64-unknown-linux-musl";
      if (process.arch === "x64") return "x86_64-unknown-linux-musl";
      break;
    case "win32":
      if (process.arch === "arm64") return "aarch64-pc-windows-msvc";
      if (process.arch === "x64") return "x86_64-pc-windows-msvc";
      break;
  }

  throw new Error(`Unsupported platform for Codex: ${process.platform} (${process.arch})`);
}

function resolvePlatformPackage(targetTriple: string): string {
  switch (targetTriple) {
    case "x86_64-unknown-linux-musl":
      return "@openai/codex-linux-x64";
    case "aarch64-unknown-linux-musl":
      return "@openai/codex-linux-arm64";
    case "x86_64-apple-darwin":
      return "@openai/codex-darwin-x64";
    case "aarch64-apple-darwin":
      return "@openai/codex-darwin-arm64";
    case "x86_64-pc-windows-msvc":
      return "@openai/codex-win32-x64";
    case "aarch64-pc-windows-msvc":
      return "@openai/codex-win32-arm64";
    default:
      throw new Error(`Unsupported Codex target triple: ${targetTriple}`);
  }
}

export function resolveCodexCliPath(): string {
  const targetTriple = resolveTargetTriple();
  const platformPackage = resolvePlatformPackage(targetTriple);

  const codexPackageJsonPath = require.resolve("@openai/codex/package.json");
  const codexRequire = createRequire(codexPackageJsonPath);
  const platformPackageJsonPath = codexRequire.resolve(`${platformPackage}/package.json`);
  const vendorRoot = join(dirname(platformPackageJsonPath), "vendor");
  const binaryName = process.platform === "win32" ? "codex.exe" : "codex";

  return unpackAsarPath(join(vendorRoot, targetTriple, "codex", binaryName));
}

function buildCodexEnv(): Record<string, string> {
  return copyProcessEnv();
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    "text" in value &&
    value.type === "text" &&
    typeof value.text === "string"
  );
}

function flattenContent(content: LlmRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (isTextBlock(block) ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

function flattenSystem(system: LlmRequest["system"]): string {
  if (typeof system === "string") return system.trim();
  if (!Array.isArray(system)) return "";
  return system
    .map((block) => (isTextBlock(block) ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

function hasWebSearchTool(params: LlmRequest): boolean {
  if (!Array.isArray(params.tools)) return false;
  return params.tools.some((tool) => {
    if (typeof tool !== "object" || tool === null || !("type" in tool)) {
      return false;
    }
    return tool.type === "web_search_20250305";
  });
}

export function buildCodexPrompt(params: LlmRequest): string {
  const allowsWebSearch = hasWebSearchTool(params);
  const sections: string[] = [];

  if (allowsWebSearch) {
    sections.push(
      [
        "You are handling an internal Exo request.",
        "You may use built-in web search when it helps answer accurately.",
        "Do not inspect local files, do not run shell commands, and do not use any tool other than web search.",
        "Respond only from the instructions and data included below.",
      ].join(" "),
    );
  } else {
    sections.push(
      [
        "You are handling an internal Exo request.",
        "Do not inspect local files, do not run shell commands, and do not use external tools.",
        "Respond only from the instructions and data included below.",
      ].join(" "),
    );
  }

  const systemText = flattenSystem(params.system);
  if (systemText) {
    sections.push(`<system>\n${systemText}\n</system>`);
  }

  for (const message of params.messages) {
    const text = flattenContent(message.content);
    if (!text) continue;
    sections.push(`<${message.role}>\n${text}\n</${message.role}>`);
  }

  return sections.join("\n\n");
}

function mapCodexUsage(usage: Usage | null): Record<string, number> {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_read_input_tokens: usage?.cached_input_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

export function resolveCodexModel(model: string | undefined): string {
  if (!model || model.startsWith("claude-")) return CODEX_DEFAULT_MODEL;
  return resolveCodexModelId(model);
}

export function buildCodexThreadOptions(
  options: {
    model?: string;
    workingDirectory?: string;
    webSearchEnabled?: boolean;
    sandboxMode?: ThreadOptions["sandboxMode"];
    approvalPolicy?: ThreadOptions["approvalPolicy"];
  } = {},
): ThreadOptions {
  const resolvedModel = resolveCodexModel(options.model);

  return {
    workingDirectory: options.workingDirectory ?? ensureCodexWorkingDir(),
    skipGitRepoCheck: true,
    sandboxMode: options.sandboxMode ?? "read-only",
    approvalPolicy: options.approvalPolicy ?? "never",
    webSearchMode: options.webSearchEnabled ? "live" : "disabled",
    model: resolvedModel,
  };
}

export function createCodexClient(config?: CodexConfigObject): CodexClientLike {
  return codexClientFactory({
    codexPathOverride: resolveCodexCliPath(),
    env: buildCodexEnv(),
    ...(config ? { config } : {}),
  });
}

export async function getCodexAuthStatus(): Promise<{
  cliAvailable: boolean;
  authenticated: boolean;
}> {
  let cliPath: string;
  try {
    cliPath = resolveCodexCliPath();
  } catch (error) {
    log.warn({ err: error }, "Failed to resolve Codex CLI path");
    return { cliAvailable: false, authenticated: false };
  }

  return new Promise((resolve) => {
    execFileImpl(
      cliPath,
      ["login", "status"],
      {
        env: buildCodexEnv(),
        timeout: CODEX_STATUS_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (error) {
          if ("code" in error && error.code === "ENOENT") {
            resolve({ cliAvailable: false, authenticated: false });
            return;
          }
          resolve({ cliAvailable: true, authenticated: false });
          return;
        }

        const combined = `${stdout}\n${stderr}`;
        resolve({
          cliAvailable: true,
          authenticated: combined.includes("Logged in"),
        });
      },
    );
  });
}

export async function createCodexMessage(
  params: LlmRequest,
  options: LlmCreateOptions,
): Promise<LlmResponse> {
  const prompt = buildCodexPrompt(params);
  const timeoutMs = options.timeoutMs ?? CODEX_REQUEST_TIMEOUT_MS;
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const thread = createCodexClient().startThread(
      buildCodexThreadOptions({
        model: params.model,
        webSearchEnabled: hasWebSearchTool(params),
      }),
    );

    const turn = await thread.run(prompt, { signal: controller.signal });
    const usage = mapCodexUsage(turn.usage);

    log.info(
      {
        caller: options.caller,
        durationMs: Date.now() - startTime,
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      },
      "Codex SDK request completed",
    );

    return {
      model: resolveCodexModel(params.model),
      content: [{ type: "text", text: turn.finalResponse }],
      usage,
    };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Codex request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function _setExecFileForTesting(execFileFn: ExecFileFn): void {
  execFileImpl = execFileFn;
}

export function _setCodexClientFactoryForTesting(factory: CodexClientFactory): void {
  codexClientFactory = factory;
}
