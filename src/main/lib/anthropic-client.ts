import Anthropic from "@anthropic-ai/sdk";
import AnthropicBedrock from "@anthropic-ai/bedrock-sdk";
import type { Config } from "../../shared/types";

// Structural type capturing the messages API methods used across the codebase.
// Both Anthropic and AnthropicBedrock satisfy this interface (AnthropicBedrock.messages
// is Omit<Messages, 'batches'|'countTokens'>, so 'create' and 'stream' are available
// with identical signatures).
export type AnthropicClient = { messages: Pick<Anthropic["messages"], "create" | "stream"> };

export function createAnthropicClientFromConfig(config: Config): AnthropicClient {
  if (config.apiProvider === "bedrock" && config.bedrock) {
    const { region, accessKeyId, secretAccessKey, sessionToken } = config.bedrock;
    return new AnthropicBedrock({
      awsRegion: region ?? "us-east-1",
      awsAccessKey: accessKeyId,
      awsSecretKey: secretAccessKey,
      awsSessionToken: sessionToken,
    });
  }
  return new Anthropic();
}
