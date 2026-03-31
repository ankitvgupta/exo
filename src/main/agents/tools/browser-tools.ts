import { z } from "zod";
import { type ToolDefinition, ToolRiskLevel } from "./types";

/**
 * Browse the web via a headless/local browser.
 *
 * This tool definition exists so the registry can advertise it and the
 * permission gate can reason about it. Actual browser automation is handled
 * by the Chrome DevTools MCP server attached to the Claude Agent SDK —
 * this tool is a fallback for providers that don't support MCP.
 */
const browseWeb: ToolDefinition<{ url: string; instruction: string }> = {
  name: "browse_web",
  description:
    "Navigate to a URL in a browser and extract information. " +
    "Useful for deep research on senders, companies, or looking up information that requires visiting specific pages. " +
    "Requires browser automation to be enabled in settings.",
  category: "browser",
  riskLevel: ToolRiskLevel.LOW,
  inputSchema: z.object({
    url: z.string().url().describe("The URL to navigate to"),
    instruction: z.string().describe("What information to extract from the page"),
  }),
  async execute(input, _ctx) {
    // Browser automation is handled by the Chrome DevTools MCP server
    // attached to the Claude Agent SDK. This tool exists as a registry
    // entry so the UI can advertise the capability and the permission gate
    // can reason about it. When the MCP server is not available, we return
    // a helpful message.
    return {
      url: input.url,
      instruction: input.instruction,
      message:
        "Browser automation should be handled via the Chrome DevTools MCP server. " +
        "Ensure browser automation is enabled in Settings → Agents.",
    };
  },
};

/**
 * Batch modify labels on multiple emails.
 * Enables commands like "star all emails from this sender".
 */
const batchModifyLabels: ToolDefinition<{
  emailIds: string[];
  addLabelIds?: string[];
  removeLabelIds?: string[];
  accountId: string;
}> = {
  name: "batch_modify_labels",
  description:
    "Modify labels on multiple emails at once. " +
    "Useful for batch operations like starring or marking multiple emails as read. " +
    "Supports adding and removing labels in a single operation. " +
    "Note: removing the INBOX label (archiving) is disabled.",
  category: "email",
  riskLevel: ToolRiskLevel.MEDIUM,
  inputSchema: z.object({
    emailIds: z.array(z.string()).min(1).describe("Array of email IDs to modify"),
    addLabelIds: z.array(z.string()).optional().describe("Label IDs to add (e.g. ['STARRED'])"),
    removeLabelIds: z
      .array(z.string())
      .optional()
      .describe("Label IDs to remove (e.g. ['UNREAD'] to mark as read)"),
    accountId: z.string().describe("The account ID that owns these emails"),
  }),
  async execute(input, ctx) {
    // Block archiving (removing INBOX label) before any mutations
    if (input.removeLabelIds?.includes("INBOX")) {
      throw new Error("Archiving (removing INBOX label) is disabled — too disruptive");
    }

    const results: Array<{ emailId: string; success: boolean; error?: string }> = [];

    // Process in batches to avoid overwhelming the Gmail API
    const BATCH_SIZE = 10;
    for (let i = 0; i < input.emailIds.length; i += BATCH_SIZE) {
      const batch = input.emailIds.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (emailId) => {
          await ctx.gmail("modifyLabels", input.accountId, emailId, {
            addLabelIds: input.addLabelIds ?? [],
            removeLabelIds: input.removeLabelIds ?? [],
          });
          return emailId;
        }),
      );

      for (const [idx, result] of batchResults.entries()) {
        if (result.status === "fulfilled") {
          results.push({ emailId: result.value, success: true });
        } else {
          results.push({
            emailId: batch[idx],
            success: false,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          });
        }
      }
    }

    const successCount = results.filter((r) => r.success).length;
    const failCount = results.length - successCount;

    return {
      totalProcessed: results.length,
      successCount,
      failCount,
      results,
    };
  },
};

export const tools: ToolDefinition[] = [
  browseWeb as ToolDefinition,
  batchModifyLabels as ToolDefinition,
];
