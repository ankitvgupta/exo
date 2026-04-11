import { ipcMain } from "electron";
import Store from "electron-store";
import { randomUUID } from "crypto";
import { stripJsonFences } from "../../shared/strip-json-fences";
import { type InboxSplit, type IpcResponse, InboxSplitSchema } from "../../shared/types";
import { getDataDir } from "../data-dir";
import { getEmailsByThread } from "../db";
import { createMessage } from "../services/llm-router";
import {
  discoverSuperhumanAccounts,
  readSuperhumanSplits,
  convertSuperhumanSplits,
} from "../services/superhuman-import";
import { createLogger } from "../services/logger";
import { getModelIdForFeature } from "./settings.ipc";

const log = createLogger("splits-ipc");

// Cache discovered Superhuman account paths to avoid double filesystem scan
const discoveredPaths = new Map<string, string>();

type SplitsStore = {
  splits: InboxSplit[];
  splitAssignments: Record<string, Record<string, string>>;
};

// Lazy-initialized to avoid running before initDevData() (see settings.ipc.ts)
let _store: Store<SplitsStore> | null = null;
function getStore(): Store<SplitsStore> {
  if (!_store) {
    _store = new Store<SplitsStore>({
      name: "exo-splits",
      cwd: getDataDir(),
      defaults: {
        splits: [],
        splitAssignments: {},
      },
    });
  }
  return _store;
}

function getSplits(): InboxSplit[] {
  return getStore().get("splits");
}

function saveSplits(splits: InboxSplit[]): void {
  const prunedAssignments = pruneAssignmentsAgainstSplits(
    getStore().get("splitAssignments"),
    splits,
  );
  getStore().set("splits", splits);
  getStore().set("splitAssignments", prunedAssignments);
}

function getSplitAssignmentsStore(): Record<string, Record<string, string>> {
  return getStore().get("splitAssignments");
}

function getSplitAssignments(accountId: string): Record<string, string> {
  return getSplitAssignmentsStore()[accountId] ?? {};
}

function saveSplitAssignments(accountId: string, assignments: Record<string, string>): void {
  const all = getSplitAssignmentsStore();
  if (Object.keys(assignments).length === 0) {
    delete all[accountId];
  } else {
    all[accountId] = assignments;
  }
  getStore().set("splitAssignments", all);
}

function pruneAssignmentsAgainstSplits(
  assignmentsByAccount: Record<string, Record<string, string>>,
  splits: InboxSplit[],
): Record<string, Record<string, string>> {
  const splitIdsByAccount = new Map<string, Set<string>>();
  for (const split of splits) {
    if (!splitIdsByAccount.has(split.accountId)) {
      splitIdsByAccount.set(split.accountId, new Set());
    }
    splitIdsByAccount.get(split.accountId)!.add(split.id);
  }

  const cleaned: Record<string, Record<string, string>> = {};
  for (const [accountId, assignments] of Object.entries(assignmentsByAccount)) {
    const validSplitIds = splitIdsByAccount.get(accountId);
    if (!validSplitIds || validSplitIds.size === 0) continue;

    const accountCleaned: Record<string, string> = {};
    for (const [threadId, splitId] of Object.entries(assignments)) {
      if (validSplitIds.has(splitId)) {
        accountCleaned[threadId] = splitId;
      }
    }

    if (Object.keys(accountCleaned).length > 0) {
      cleaned[accountId] = accountCleaned;
    }
  }

  return cleaned;
}

type SplitAssignment = { threadId: string; splitId: string };
type SplitSuggestion = { splitId: string; score: number; reason: string };
const SUGGESTION_CONFIDENCE_THRESHOLD = 0.55;

function summarizeSplitConditions(split: InboxSplit): string {
  return split.conditions
    .map((c) => `${c.negate ? "NOT " : ""}${c.type}=${c.value}`)
    .join(` ${split.conditionLogic.toUpperCase()} `);
}

function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function parseSuggestionResponse(rawText: string, allowedSplitIds: Set<string>): SplitSuggestion[] {
  const text = stripJsonFences(rawText).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    const extracted = extractJsonObject(text);
    if (!extracted) return [];
    try {
      parsed = JSON.parse(extracted);
    } catch {
      return [];
    }
  }

  const obj = parsed as { suggestions?: unknown };
  if (!obj || !Array.isArray(obj.suggestions)) return [];

  const deduped = new Map<string, SplitSuggestion>();
  for (const candidate of obj.suggestions) {
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as { splitId?: unknown; score?: unknown; reason?: unknown };
    if (typeof row.splitId !== "string" || !allowedSplitIds.has(row.splitId)) continue;
    if (typeof row.reason !== "string" || !row.reason.trim()) continue;
    if (typeof row.score !== "number" || Number.isNaN(row.score)) continue;

    const score = Math.min(1, Math.max(0, row.score));
    const existing = deduped.get(row.splitId);
    if (!existing || score > existing.score) {
      deduped.set(row.splitId, {
        splitId: row.splitId,
        score,
        reason: row.reason.trim(),
      });
    }
  }

  return [...deduped.values()].sort((a, b) => b.score - a.score).slice(0, 3);
}

function toPlainText(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function registerSplitsIpc(): void {
  // Get all splits
  ipcMain.handle("splits:get-all", async (): Promise<IpcResponse<InboxSplit[]>> => {
    try {
      const splits = getSplits();
      return { success: true, data: splits };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Save all splits (replaces existing)
  ipcMain.handle("splits:save", async (_, splits: InboxSplit[]): Promise<IpcResponse<void>> => {
    try {
      // Validate each split
      for (const split of splits) {
        InboxSplitSchema.parse(split);
      }
      saveSplits(splits);
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Create a new split
  ipcMain.handle(
    "splits:create",
    async (_, split: Omit<InboxSplit, "id">): Promise<IpcResponse<InboxSplit>> => {
      try {
        const newSplit: InboxSplit = {
          ...split,
          id: randomUUID(),
        };
        InboxSplitSchema.parse(newSplit);

        const splits = getSplits();
        splits.push(newSplit);
        saveSplits(splits);

        return { success: true, data: newSplit };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Update an existing split
  ipcMain.handle(
    "splits:update",
    async (
      _,
      { id, updates }: { id: string; updates: Partial<Omit<InboxSplit, "id">> },
    ): Promise<IpcResponse<InboxSplit>> => {
      try {
        const splits = getSplits();
        const index = splits.findIndex((s) => s.id === id);

        if (index === -1) {
          return { success: false, error: `Split with id ${id} not found` };
        }

        const updatedSplit: InboxSplit = {
          ...splits[index],
          ...updates,
        };
        InboxSplitSchema.parse(updatedSplit);

        splits[index] = updatedSplit;
        saveSplits(splits);

        return { success: true, data: updatedSplit };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Delete a split
  ipcMain.handle("splits:delete", async (_, { id }: { id: string }): Promise<IpcResponse<void>> => {
    try {
      const splits = getSplits();
      const newSplits = splits.filter((s) => s.id !== id);

      if (newSplits.length === splits.length) {
        return { success: false, error: `Split with id ${id} not found` };
      }

      saveSplits(newSplits);
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  });

  // Get persisted thread assignments for one account
  ipcMain.handle(
    "splits:get-assignments",
    async (_, { accountId }: { accountId: string }): Promise<IpcResponse<SplitAssignment[]>> => {
      try {
        const assignments = getSplitAssignments(accountId);
        const data = Object.entries(assignments).map(([threadId, splitId]) => ({
          threadId,
          splitId,
        }));
        return { success: true, data };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Assign one thread to a split
  ipcMain.handle(
    "splits:assign-thread",
    async (
      _,
      { accountId, threadId, splitId }: { accountId: string; threadId: string; splitId: string },
    ): Promise<IpcResponse<void>> => {
      try {
        const split = getSplits().find((s) => s.accountId === accountId && s.id === splitId);
        if (!split) {
          return {
            success: false,
            error: `Split ${splitId} not found for account ${accountId}`,
          };
        }

        const assignments = { ...getSplitAssignments(accountId), [threadId]: splitId };
        saveSplitAssignments(accountId, assignments);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Clear one thread assignment
  ipcMain.handle(
    "splits:clear-thread-assignment",
    async (
      _,
      { accountId, threadId }: { accountId: string; threadId: string },
    ): Promise<IpcResponse<void>> => {
      try {
        const assignments = { ...getSplitAssignments(accountId) };
        delete assignments[threadId];
        saveSplitAssignments(accountId, assignments);
        return { success: true, data: undefined };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // On-demand AI suggestion for assigning one thread to existing splits
  ipcMain.handle(
    "splits:suggest-thread",
    async (
      _,
      { accountId, threadId }: { accountId: string; threadId: string },
    ): Promise<IpcResponse<{ suggestions: SplitSuggestion[] }>> => {
      try {
        const accountSplits = getSplits().filter((s) => s.accountId === accountId);
        if (accountSplits.length === 0) {
          return { success: true, data: { suggestions: [] } };
        }

        const threadEmails = getEmailsByThread(threadId, accountId);
        if (threadEmails.length === 0) {
          return { success: true, data: { suggestions: [] } };
        }

        const latestEmail = threadEmails[threadEmails.length - 1];
        const latestReceivedEmail =
          [...threadEmails].reverse().find((e) => !e.labelIds?.includes("SENT")) ?? latestEmail;
        const bodyExcerpt = toPlainText(latestReceivedEmail.body ?? "").slice(0, 1200);
        const snippet = toPlainText(latestReceivedEmail.snippet ?? "").slice(0, 280);
        const splitSummary = accountSplits
          .map(
            (s) =>
              `- id=${s.id}\n  name=${s.name}\n  exclusive=${s.exclusive ? "true" : "false"}\n  rules=${summarizeSplitConditions(s) || "none"}`,
          )
          .join("\n");

        const prompt = [
          "You are ranking which existing inbox split best fits one email thread.",
          "Return JSON only with this shape:",
          '{"suggestions":[{"splitId":"<id>","score":0.0,"reason":"short reason"}]}',
          "",
          "Rules:",
          "- Use only splitId values from the provided split list.",
          "- score must be a number between 0 and 1.",
          "- Keep reason concise and specific (max 140 chars).",
          "- Return up to 3 suggestions sorted by confidence.",
          "",
          `Thread subject: ${latestReceivedEmail.subject || "(none)"}`,
          `From: ${latestReceivedEmail.from || "(unknown)"}`,
          `Snippet: ${snippet || "(none)"}`,
          `Body excerpt: ${bodyExcerpt || "(none)"}`,
          "",
          "Available splits:",
          splitSummary,
        ].join("\n");

        const response = await createMessage(
          {
            model: getModelIdForFeature("analysis"),
            max_tokens: 400,
            messages: [{ role: "user", content: prompt }],
          },
          {
            caller: "splits-suggest-thread",
            feature: "analysis",
            accountId,
            emailId: latestReceivedEmail.id,
          },
        );
        const rawText = response.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");

        const suggestions = parseSuggestionResponse(
          rawText,
          new Set(accountSplits.map((s) => s.id)),
        );
        if (suggestions.length > 0 && suggestions[0].score < SUGGESTION_CONFIDENCE_THRESHOLD) {
          log.info(
            `[SplitSuggest] low-confidence top suggestion for thread=${threadId}: ${suggestions[0].score.toFixed(2)}`,
          );
        }
        return { success: true, data: { suggestions } };
      } catch (error) {
        log.error({ err: error }, `[SplitSuggest] failed for thread ${threadId}`);
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Discover Superhuman accounts available for import
  ipcMain.handle(
    "splits:discover-superhuman",
    async (): Promise<IpcResponse<{ accounts: Array<{ email: string; splitCount: number }> }>> => {
      try {
        const rawAccounts = await discoverSuperhumanAccounts();
        discoveredPaths.clear();
        const accounts: Array<{ email: string; splitCount: number }> = [];

        for (const { email, filePath } of rawAccounts) {
          discoveredPaths.set(email, filePath);
          try {
            const shSplits = await readSuperhumanSplits(filePath);
            // Run conversion to get the actual importable count (skips disabled/shared)
            const { splits: converted } = convertSuperhumanSplits(shSplits, "", 0);
            log.info(
              `[SuperhumanImport] ${email}: ${converted.length} importable of ${shSplits.length} total`,
            );
            accounts.push({ email, splitCount: converted.length });
          } catch (e) {
            log.error({ err: e }, `[SuperhumanImport] Failed to read splits for ${email}`);
            accounts.push({ email, splitCount: 0 });
          }
        }

        return { success: true, data: { accounts } };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );

  // Import splits from Superhuman for a given email
  ipcMain.handle(
    "splits:import-superhuman",
    async (
      _,
      { superhumanEmail, targetAccountId }: { superhumanEmail: string; targetAccountId: string },
    ): Promise<IpcResponse<{ imported: number; warnings: string[] }>> => {
      try {
        // Use cached path from discovery to avoid a second filesystem scan
        let filePath = discoveredPaths.get(superhumanEmail);
        if (!filePath) {
          // Fallback: re-discover if cache was cleared (e.g. app restart between steps)
          const rawAccounts = await discoverSuperhumanAccounts();
          const account = rawAccounts.find((a) => a.email === superhumanEmail);
          if (!account) {
            return {
              success: false,
              error: `Superhuman account ${superhumanEmail} not found`,
            };
          }
          filePath = account.filePath;
        }

        const shSplits = await readSuperhumanSplits(filePath);
        const existingSplits = getSplits();
        const startingOrder = existingSplits.filter((s) => s.accountId === targetAccountId).length;

        const { splits: newSplits, warnings } = convertSuperhumanSplits(
          shSplits,
          targetAccountId,
          startingOrder,
        );

        // Deduplicate against existing splits by name (for the same account)
        const existingNames = new Set(
          existingSplits.filter((s) => s.accountId === targetAccountId).map((s) => s.name),
        );
        const uniqueNewSplits = newSplits.filter((s) => !existingNames.has(s.name));
        const skippedCount = newSplits.length - uniqueNewSplits.length;
        if (skippedCount > 0) {
          warnings.push(`Skipped ${skippedCount} split(s) that already exist.`);
        }

        // Validate each split against our schema before saving
        const validSplits: InboxSplit[] = [];
        for (const split of uniqueNewSplits) {
          try {
            validSplits.push(InboxSplitSchema.parse(split));
          } catch {
            warnings.push(`Skipped "${split.name}": failed schema validation`);
          }
        }

        // Append to existing splits
        saveSplits([...existingSplits, ...validSplits]);

        return {
          success: true,
          data: { imported: validSplits.length, warnings },
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    },
  );
}
