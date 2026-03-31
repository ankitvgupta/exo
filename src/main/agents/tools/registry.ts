import { z } from "zod";
import { type ToolDefinition, type ToolRiskLevel } from "./types";
import type { AgentToolSpec } from "../types";

type ToolFilter = {
  category?: ToolDefinition["category"];
  maxRiskLevel?: ToolRiskLevel;
};

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    // Safe: the toolExecutor validates input via tool.inputSchema.parse() before calling execute().
    // The registry stores heterogeneous tools so we erase the generic at this boundary.
    this.tools.set(tool.name, tool as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(filter?: ToolFilter): ToolDefinition[] {
    let tools = Array.from(this.tools.values());
    if (filter?.category) {
      tools = tools.filter((t) => t.category === filter.category);
    }
    if (filter?.maxRiskLevel !== undefined) {
      tools = tools.filter((t) => t.riskLevel <= filter.maxRiskLevel!);
    }
    return tools;
  }

  /** Convert to the format expected by AgentProvider.run() */
  toAgentToolSpecs(filter?: ToolFilter): AgentToolSpec[] {
    return this.list(filter).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  /** Convert to Claude API tool format */
  toClaudeFormat(
    filter?: ToolFilter,
  ): Array<{ name: string; description: string; input_schema: object }> {
    return this.list(filter).map((tool) => {
      const jsonSchema = z.toJSONSchema(tool.inputSchema);
      // Claude API doesn't want the $schema key
      const { $schema: _, ...inputSchema } = jsonSchema;
      return {
        name: tool.name,
        description: tool.description,
        input_schema: inputSchema,
      };
    });
  }

  /** Create a copy of this registry (for adding per-run dynamic tools). */
  clone(): ToolRegistry {
    const cloned = new ToolRegistry();
    for (const tool of this.tools.values()) {
      cloned.register(tool);
    }
    return cloned;
  }

  /** Convert to OpenAI function calling format */
  toOpenAIFormat(filter?: ToolFilter): Array<{
    type: "function";
    function: { name: string; description: string; parameters: object };
  }> {
    return this.list(filter).map((tool) => {
      const jsonSchema = z.toJSONSchema(tool.inputSchema);
      const { $schema: _, ...parameters } = jsonSchema;
      return {
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters,
        },
      };
    });
  }
}

/** Create and populate a registry with all built-in tools */
export async function buildToolRegistry(): Promise<ToolRegistry> {
  const registry = new ToolRegistry();

  // Dynamically import tool modules to avoid circular deps
  const [emailTools, analysisTools, contextTools, browserTools] = await Promise.all([
    import("./email-tools"),
    import("./analysis-tools"),
    import("./context-tools"),
    import("./browser-tools"),
  ]);

  for (const tool of emailTools.tools) registry.register(tool);
  for (const tool of analysisTools.tools) registry.register(tool);
  for (const tool of contextTools.tools) registry.register(tool);
  for (const tool of browserTools.tools) registry.register(tool);

  return registry;
}
