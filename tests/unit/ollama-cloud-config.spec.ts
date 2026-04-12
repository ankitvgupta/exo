/**
 * Unit tests for Ollama Cloud configuration types and Zod schemas.
 *
 * These are pure schema validation tests — no DB, mocks, or native modules needed.
 */
import { test, expect } from "@playwright/test";
import {
  ConfigSchema,
  LlmProviderSchema,
  OllamaCloudConfigSchema,
} from "../../src/shared/types";

test.describe("Ollama Cloud config schemas", () => {
  test("ConfigSchema parses config with ollamaCloud field", () => {
    const raw = {
      ollamaCloud: {
        apiKey: "test-key-123",
        defaultModel: "minimax-m2.7:cloud",
      },
    };

    const result = ConfigSchema.parse(raw);

    expect(result.ollamaCloud).toBeDefined();
    expect(result.ollamaCloud!.apiKey).toBe("test-key-123");
    expect(result.ollamaCloud!.defaultModel).toBe("minimax-m2.7:cloud");
  });

  test("ConfigSchema parses config without ollamaCloud field", () => {
    const raw = {
      maxEmails: 100,
    };

    const result = ConfigSchema.parse(raw);

    expect(result.ollamaCloud).toBeUndefined();
    // Other defaults should still apply
    expect(result.maxEmails).toBe(100);
  });

  test("ConfigSchema parses featureProviders with ollama-cloud values", () => {
    const raw = {
      featureProviders: {
        analysis: "ollama-cloud",
        drafts: "anthropic",
        refinement: "ollama-cloud",
      },
    };

    const result = ConfigSchema.parse(raw);

    expect(result.featureProviders).toBeDefined();
    expect(result.featureProviders!["analysis"]).toBe("ollama-cloud");
    expect(result.featureProviders!["drafts"]).toBe("anthropic");
    expect(result.featureProviders!["refinement"]).toBe("ollama-cloud");
  });

  test("LlmProviderSchema validates 'anthropic'", () => {
    const result = LlmProviderSchema.parse("anthropic");
    expect(result).toBe("anthropic");
  });

  test("LlmProviderSchema validates 'ollama-cloud'", () => {
    const result = LlmProviderSchema.parse("ollama-cloud");
    expect(result).toBe("ollama-cloud");
  });

  test("LlmProviderSchema rejects invalid provider names", () => {
    expect(() => LlmProviderSchema.parse("openai")).toThrow();
    expect(() => LlmProviderSchema.parse("")).toThrow();
    expect(() => LlmProviderSchema.parse("ollama")).toThrow();
  });

  test("OllamaCloudConfigSchema applies defaults for missing fields", () => {
    const result = OllamaCloudConfigSchema.parse({});

    expect(result.apiKey).toBe("");
    expect(result.defaultModel).toBe("minimax-m2.7:cloud");
    expect(result.featureModels).toBeUndefined();
  });

  test("OllamaCloudConfigSchema parses full config with featureModels", () => {
    const raw = {
      apiKey: "key-abc",
      defaultModel: "llama3.1:cloud",
      featureModels: {
        analysis: "minimax-m2.7:cloud",
        drafts: "llama3.1:cloud",
      },
    };

    const result = OllamaCloudConfigSchema.parse(raw);

    expect(result.apiKey).toBe("key-abc");
    expect(result.defaultModel).toBe("llama3.1:cloud");
    expect(result.featureModels).toEqual({
      analysis: "minimax-m2.7:cloud",
      drafts: "llama3.1:cloud",
    });
  });

  test("ConfigSchema rejects invalid featureProviders values", () => {
    const raw = {
      featureProviders: {
        analysis: "not-a-valid-provider",
      },
    };

    expect(() => ConfigSchema.parse(raw)).toThrow();
  });
});
