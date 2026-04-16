import type { Message } from "@anthropic-ai/sdk/resources/messages";
import type { LlmProvider } from "../../shared/types";
import { resolveConfiguredLlmProvider } from "../../shared/types";
import {
  createMessage as createAnthropicMessage,
  recordProviderCall,
} from "./anthropic-service";
import { createCodexMessage } from "./codex-cli";
import type { LlmCreateOptions, LlmRequest, LlmResponse, LlmContentBlock } from "./llm-types";

let currentProvider: LlmProvider = "anthropic";

function normalizeAnthropicContent(message: Message): LlmContentBlock[] {
  return message.content.flatMap((block) => {
    if (block.type === "text") {
      return [{ type: "text", text: block.text }];
    }
    if (block.type === "thinking") {
      return [{ type: "thinking", thinking: block.thinking }];
    }
    return [];
  });
}

function normalizeAnthropicResponse(message: Message): LlmResponse {
  return {
    model: message.model,
    content: normalizeAnthropicContent(message),
    usage: message.usage as unknown as Record<string, number>,
  };
}

export function configureLlmService(config: {
  llmProvider?: LlmProvider;
  anthropicApiKey?: string;
}): void {
  currentProvider = resolveConfiguredLlmProvider(config);
}

export function getCurrentLlmProvider(): LlmProvider {
  return currentProvider;
}

export async function createMessage(
  params: LlmRequest,
  options: LlmCreateOptions,
): Promise<LlmResponse> {
  if (currentProvider === "anthropic") {
    const response = await createAnthropicMessage(params, options);
    return normalizeAnthropicResponse(response);
  }

  const startTime = Date.now();
  try {
    const response = await createCodexMessage(params, options);
    recordProviderCall(response.model, options.caller, response.usage, Date.now() - startTime, {
      emailId: options.emailId,
      accountId: options.accountId,
      costCents: 0,
    });
    return response;
  } catch (error) {
    recordProviderCall("codex-sdk", options.caller, {}, Date.now() - startTime, {
      emailId: options.emailId,
      accountId: options.accountId,
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
      costCents: 0,
    });
    throw error;
  }
}
