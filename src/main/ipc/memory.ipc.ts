import { ipcMain } from "electron";
import { randomUUID } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  saveMemory,
  getMemory,
  getMemories,
  getRelevantMemories,
  updateMemory,
  deleteMemory,
  getMemoryCategories,
  getDraftMemories,
  getDraftMemory,
  deleteDraftMemory,
} from "../db";
import type { IpcResponse, Memory, DraftMemory, MemoryScope, MemorySource, MemoryType } from "../../shared/types";
import { consolidateMemoryScopes } from "../services/draft-edit-learner";

export function registerMemoryIpc(): void {
  // Memory operations use the real SQLite DB even in demo/test mode —
  // unlike Gmail data, memories are local-only and safe to persist.

  // List all memories for an account
  ipcMain.handle(
    "memory:list",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<Memory[]>> => {
      try {
        const memories = getMemories(accountId);
        return { success: true, data: memories };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // Get memories relevant to a specific email's sender
  ipcMain.handle(
    "memory:get-for-email",
    async (_, { senderEmail, accountId }: { senderEmail: string; accountId: string }): Promise<IpcResponse<Memory[]>> => {
      try {
        // Return both drafting and analysis memories for this sender
        const sender = senderEmail.toLowerCase();
        const drafting = getRelevantMemories(sender, accountId, "drafting");
        const analysis = getRelevantMemories(sender, accountId, "analysis");
        const deduped = [...drafting, ...analysis.filter(a => !drafting.some(d => d.id === a.id))];
        return { success: true, data: deduped };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // Save a new memory
  ipcMain.handle(
    "memory:save",
    async (_, { accountId, scope, scopeValue, content, source, sourceEmailId }: {
      accountId: string;
      scope: MemoryScope;
      scopeValue?: string | null;
      content: string;
      source?: MemorySource;
      sourceEmailId?: string;
    }): Promise<IpcResponse<Memory>> => {
      try {
        const now = Date.now();
        const memory: Memory = {
          id: randomUUID(),
          accountId,
          scope,
          scopeValue: scopeValue?.toLowerCase() ?? null,
          content,
          source: source ?? "manual",
          sourceEmailId: sourceEmailId ?? null,
          enabled: true,
          memoryType: "drafting",
          createdAt: now,
          updatedAt: now,
        };
        saveMemory(memory);
        return { success: true, data: memory };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // Update an existing memory
  ipcMain.handle(
    "memory:update",
    async (_, { id, updates }: {
      id: string;
      updates: { content?: string; enabled?: boolean; scope?: MemoryScope; scopeValue?: string | null };
    }): Promise<IpcResponse<Memory | null>> => {
      try {
        if (updates.scopeValue !== undefined && updates.scopeValue !== null) {
          updates.scopeValue = updates.scopeValue.toLowerCase();
        }
        updateMemory(id, updates);
        const updated = getMemory(id);
        return { success: true, data: updated };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // Delete a memory
  ipcMain.handle(
    "memory:delete",
    async (_, { id }: { id: string }): Promise<IpcResponse<void>> => {
      try {
        deleteMemory(id);
        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // Get all category names for autocomplete
  ipcMain.handle(
    "memory:categories",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<string[]>> => {
      try {
        const categories = getMemoryCategories(accountId);
        return { success: true, data: categories };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // AI-assisted scope classification for memories
  ipcMain.handle(
    "memory:classify",
    async (_, { content, senderEmail, senderDomain }: {
      content: string;
      senderEmail: string;
      senderDomain: string;
    }): Promise<IpcResponse<{ scope: MemoryScope; scopeValue: string | null; content: string }>> => {
      // In demo/test mode, skip API call and default to person scope
      if (process.env.EXO_TEST_MODE === "true" || process.env.EXO_DEMO_MODE === "true") {
        return {
          success: true,
          data: { scope: "person", scopeValue: senderEmail, content },
        };
      }
      try {
        const anthropic = new Anthropic();
        const response = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001", // simple JSON classification — always haiku, independent of user model config
          max_tokens: 256,
          messages: [{
            role: "user",
            content: `Classify this email preference/feedback into a scope for future application.

Feedback: "${content}"
Sender email: ${senderEmail}
Sender domain: ${senderDomain}

Determine:
1. scope: "person" (only this sender), "domain" (everyone at ${senderDomain}), "category" (a type of email), or "global" (all emails)
2. scopeValue: the email (person), domain (domain), category name (category), or null (global)
3. content: rephrase the feedback as a clear, reusable instruction (e.g. "Use formal tone" instead of "make it more formal")

Respond in JSON only: {"scope":"...","scopeValue":"...","content":"..."}`,
          }],
        });

        const text = response.content[0]?.type === "text" ? response.content[0].text : "";
        // Extract JSON object — find the first { and match to its closing }
        const jsonStart = text.indexOf("{");
        if (jsonStart === -1) {
          // Fallback: return original content with person scope
          return { success: true, data: { scope: "person", scopeValue: senderEmail, content } };
        }
        // Find matching closing brace, skipping braces inside JSON strings
        let depth = 0;
        let jsonEnd = -1;
        let inString = false;
        let escaped = false;
        for (let i = jsonStart; i < text.length; i++) {
          const ch = text[i];
          if (escaped) { escaped = false; continue; }
          if (ch === "\\") { escaped = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) { jsonEnd = i; break; }
          }
        }
        if (jsonEnd === -1) {
          return { success: true, data: { scope: "person", scopeValue: senderEmail, content } };
        }

        const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as { scope: string; scopeValue: string | null; content: string };
        const validScopes: MemoryScope[] = ["person", "domain", "category", "global"];
        const scope = validScopes.includes(parsed.scope as MemoryScope) ? (parsed.scope as MemoryScope) : "person";
        const scopeValue = scope === "global"
          ? null
          : scope === "domain"
            ? (parsed.scopeValue ?? senderDomain)
            : scope === "category"
              ? (parsed.scopeValue ?? null)
              : (parsed.scopeValue ?? senderEmail);

        return {
          success: true,
          data: {
            scope,
            scopeValue,
            content: parsed.content || content,
          },
        };
      } catch (error) {
        // Fallback: return original with person scope
        return {
          success: true,
          data: { scope: "person", scopeValue: senderEmail, content },
        };
      }
    }
  );

  // ============================================
  // Draft Memory operations
  // ============================================

  // List all draft memories for an account
  ipcMain.handle(
    "draft-memory:list",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<DraftMemory[]>> => {
      try {
        const draftMemories = getDraftMemories(accountId);
        return { success: true, data: draftMemories };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // Manually promote a draft memory to a real memory
  ipcMain.handle(
    "draft-memory:promote",
    async (_, { id, accountId }: { id: string; accountId: string }): Promise<IpcResponse<Memory>> => {
      try {
        const dm = getDraftMemory(id);
        if (!dm) {
          return { success: false, error: "Draft memory not found" };
        }
        if (dm.accountId !== accountId) {
          return { success: false, error: "Draft memory belongs to different account" };
        }

        const memoryType = dm.memoryType ?? "drafting";
        const source = memoryType === "analysis" ? "priority-override" : "draft-edit";
        const existingMemories = getMemories(accountId, memoryType).filter(m => m.enabled);
        const result = await consolidateMemoryScopes(
          { content: dm.content, scope: dm.scope, scopeValue: dm.scope === "global" ? null : dm.scopeValue },
          existingMemories, accountId,
          { source, memoryType },
        );

        if (result.action === "duplicate") {
          const covering = result.coveringMemoryId
            ? existingMemories.find(m => m.id === result.coveringMemoryId)
            : undefined;
          if (!covering) {
            return { success: false, error: "Draft memory is a duplicate but covering memory could not be identified" };
          }
          console.log(`[MemoryIPC] Draft memory "${dm.content}" is already covered by a promoted memory — deleting`);
          deleteDraftMemory(id);
          return { success: true, data: covering };
        }

        const now = Date.now();
        const memory: Memory = {
          id: randomUUID(),
          accountId,
          scope: dm.scope,
          scopeValue: dm.scope === "global" ? null : dm.scopeValue,
          content: dm.content,
          source,
          memoryType,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        };
        // Only save the narrow-scoped candidate when no consolidation happened
        if (result.action !== "consolidate") {
          saveMemory(memory);
        }
        deleteDraftMemory(id);

        if (result.createdGlobal) {
          return { success: true, data: result.createdGlobal };
        }
        if (result.action === "consolidate") {
          // Global already existed and covers this preference — return it
          const coveringGlobal = result.coveringMemoryId
            ? existingMemories.find(m => m.id === result.coveringMemoryId)
            : existingMemories.find(m => m.scope === "global");
          return { success: true, data: coveringGlobal ?? memory };
        }
        return { success: true, data: memory };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );

  // Delete a draft memory
  ipcMain.handle(
    "draft-memory:delete",
    async (_, { id }: { id: string }): Promise<IpcResponse<void>> => {
      try {
        deleteDraftMemory(id);
        return { success: true, data: undefined };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
      }
    }
  );
}
