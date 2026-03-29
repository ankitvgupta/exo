import { z } from "zod";
import { ToolDefinition, ToolRiskLevel } from "./types";

const webSearch: ToolDefinition<{ query: string }> = {
  name: "web_search",
  description:
    "Search the web for information. Useful for looking up sender profiles, company info, or other context relevant to email handling.",
  category: "context",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    query: z.string().describe("The search query"),
  }),
  async execute(input, _ctx) {
    // Web search is handled by Claude's built-in web_search tool capability.
    // This tool definition exists so the registry can advertise it and the
    // permission gate can reason about it. The actual execution is delegated
    // to the provider's native web search when available.
    return {
      query: input.query,
      message:
        "Web search should be handled by the provider's native capability (e.g., Claude's web_search tool).",
    };
  },
};

const getCalendar: ToolDefinition<{ accountId: string; date: string }> = {
  name: "get_calendar",
  description:
    "Get calendar events for a date range. Useful for checking availability when handling scheduling emails.",
  category: "context",
  riskLevel: ToolRiskLevel.NONE,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID"),
    date: z
      .string()
      .describe("Date to get events for (YYYY-MM-DD format)"),
  }),
  async execute(input, ctx) {
    const events = await ctx.db(
      "getCalendarEventsForDate",
      input.date,
    );
    return events;
  },
};

const saveMemory: ToolDefinition<{ accountId: string; content: string; scope: string; scopeValue?: string }> = {
  name: "save_memory",
  description:
    "Save a persistent memory or preference that will be applied to future email handling. " +
    "Use this when the user tells you to remember something, always do something a certain way, " +
    "or establishes a preference. Choose the most appropriate scope:\n" +
    "- 'person': applies only to a specific email address (scopeValue = email)\n" +
    "- 'domain': applies to everyone at a company/domain (scopeValue = domain)\n" +
    "- 'category': applies to a type of email (scopeValue = category name like 'scheduling', 'client-requests')\n" +
    "- 'global': applies to all emails",
  category: "context",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    accountId: z.string().describe("The account ID to save the memory for"),
    content: z.string().describe("The preference or instruction to remember"),
    scope: z.enum(["person", "domain", "category", "global"]).describe("Scope of the memory"),
    scopeValue: z.string().optional().describe("Email address (person), domain (domain), or category name (category). Not needed for global."),
  }),
  async execute(input, ctx) {
    const { randomUUID } = await import("crypto");
    const now = Date.now();
    const accountId = input.accountId;
    const memory = {
      id: randomUUID(),
      accountId,
      scope: input.scope,
      scopeValue: input.scopeValue?.toLowerCase() ?? null,
      content: input.content,
      source: "manual",
      sourceEmailId: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await ctx.db("saveMemory", memory);
    return { saved: true, id: memory.id, scope: input.scope, scopeValue: input.scopeValue ?? null };
  },
};

export const tools: ToolDefinition[] = [
  webSearch as ToolDefinition,
  getCalendar as ToolDefinition,
  saveMemory as ToolDefinition,
];
