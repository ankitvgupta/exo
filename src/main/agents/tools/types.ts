import { type z } from "zod";

export const ToolRiskLevel = {
  NONE: 0, // Read-only, no side effects
  LOW: 1, // Reversible writes (labels, read status)
  MEDIUM: 2, // Creates artifacts (drafts, CC additions)
  HIGH: 3, // Irreversible (send email, delete, forward)
} as const;
export type ToolRiskLevel = (typeof ToolRiskLevel)[keyof typeof ToolRiskLevel];

/** Proxy functions for cross-process DB/Gmail access */
export interface ProxyContext {
  db: (method: string, ...args: unknown[]) => Promise<unknown>;
  gmail: (method: string, accountId: string, ...args: unknown[]) => Promise<unknown>;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  category: "email" | "analysis" | "context" | "browser" | "external";
  riskLevel: ToolRiskLevel;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  execute: (input: TInput, ctx: ProxyContext) => Promise<TOutput>;
}
