import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";

export type LlmRequest = MessageCreateParamsNonStreaming;

export type LlmContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string };

export interface LlmResponse {
  model: string;
  content: LlmContentBlock[];
  usage: Record<string, number>;
}

export interface LlmCreateOptions {
  caller: string;
  emailId?: string;
  accountId?: string;
  timeoutMs?: number;
}
