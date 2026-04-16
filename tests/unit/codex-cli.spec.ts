import { expect, test } from "@playwright/test";
import {
  buildCodexPrompt,
  buildCodexThreadOptions,
  resolveCodexModel,
} from "../../src/main/services/codex-cli";
import type { LlmRequest } from "../../src/main/services/llm-types";
import {
  resolveConfiguredLlmProvider,
  resolveDefaultBuiltInAgentProviderId,
} from "../../src/shared/types";

test.describe("Codex SDK adapter", () => {
  test("buildCodexPrompt preserves system and conversation structure", () => {
    const request: LlmRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 256,
      system: [{ type: "text", text: "Return only JSON." }],
      messages: [
        { role: "user", content: "Analyze this email." },
        { role: "assistant", content: [{ type: "text", text: "Previous answer." }] },
        { role: "user", content: [{ type: "text", text: "Refine it." }] },
      ],
    };

    const prompt = buildCodexPrompt(request);

    expect(prompt).toContain("<system>");
    expect(prompt).toContain("Return only JSON.");
    expect(prompt).toContain("<user>\nAnalyze this email.\n</user>");
    expect(prompt).toContain("<assistant>\nPrevious answer.\n</assistant>");
    expect(prompt).toContain("<user>\nRefine it.\n</user>");
  });

  test("buildCodexPrompt allows web search when requested", () => {
    const request: LlmRequest = {
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 256,
      tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
      messages: [{ role: "user", content: "Look up this sender." }],
    };

    const prompt = buildCodexPrompt(request);

    expect(prompt).toContain("You may use built-in web search when it helps answer accurately.");
    expect(prompt).toContain("Do not inspect local files, do not run shell commands");
    expect(prompt).toContain("do not use any tool other than web search");
  });

  test("buildCodexThreadOptions keeps the sandbox tight and strips Claude model ids", () => {
    const options = buildCodexThreadOptions({
      model: "claude-sonnet-4-5-20250929",
      webSearchEnabled: true,
    });

    expect(options.model).toBe("gpt-5.3-codex-spark");
    expect(options.sandboxMode).toBe("read-only");
    expect(options.approvalPolicy).toBe("never");
    expect(options.webSearchMode).toBe("live");
    expect(options.skipGitRepoCheck).toBe(true);
  });

  test("resolveCodexModel preserves OpenAI models and falls back from Claude-specific ones", () => {
    expect(resolveCodexModel("claude-opus-4-6")).toBe("gpt-5.3-codex-spark");
    expect(resolveCodexModel("gpt-5.3-codex")).toBe("gpt-5.3-codex");
  });

  test("resolveConfiguredLlmProvider prefers Anthropic when a key exists", () => {
    expect(resolveConfiguredLlmProvider({ anthropicApiKey: "sk-ant-123" })).toBe("anthropic");
    expect(resolveConfiguredLlmProvider({})).toBe("codex");
    expect(
      resolveConfiguredLlmProvider({ llmProvider: "codex", anthropicApiKey: "sk-ant-123" }),
    ).toBe("codex");
  });

  test("resolveDefaultBuiltInAgentProviderId follows the configured LLM backend", () => {
    expect(resolveDefaultBuiltInAgentProviderId({})).toBe("codex");
    expect(resolveDefaultBuiltInAgentProviderId({ anthropicApiKey: "sk-ant-123" })).toBe("claude");
    expect(resolveDefaultBuiltInAgentProviderId({ llmProvider: "codex" })).toBe("codex");
  });
});
