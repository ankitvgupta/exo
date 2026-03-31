import { ipcMain } from "electron";
import {
  searchEmails,
  getSearchSuggestions,
  getContactSuggestions,
  rebuildSearchIndex,
  stripHtmlForSearch,
  type SearchResult,
  type SearchOptions,
} from "../db";
import type { IpcResponse, ContactSuggestion } from "../../shared/types";

const isTestMode = process.env.EXO_TEST_MODE === "true";
const isDemoMode = process.env.EXO_DEMO_MODE === "true";
const useFakeData = isTestMode || isDemoMode;

/**
 * Build demo search results dynamically from DEMO_INBOX_EMAILS
 * so IDs match actual demo emails and clicks work correctly.
 */
async function searchDemoEmails(query: string): Promise<SearchResult[]> {
  const { DEMO_INBOX_EMAILS } = await import("../demo/fake-inbox");
  const q = query.toLowerCase();

  return DEMO_INBOX_EMAILS.filter((email) => {
    const bodyText = stripHtmlForSearch(email.body).toLowerCase();
    return (
      email.subject.toLowerCase().includes(q) ||
      bodyText.includes(q) ||
      email.from.toLowerCase().includes(q) ||
      email.to.toLowerCase().includes(q) ||
      (email.snippet?.toLowerCase().includes(q) ?? false)
    );
  }).map((email) => ({
    id: email.id,
    threadId: email.threadId,
    accountId: "default",
    subject: email.subject,
    from: email.from,
    to: email.to,
    date: email.date,
    snippet: email.snippet || stripHtmlForSearch(email.body).substring(0, 150),
    rank: 0,
  }));
}

export function registerSearchIpc(): void {
  // Search emails using FTS5
  ipcMain.handle(
    "search:query",
    async (
      _,
      { query, options }: { query: string; options?: SearchOptions },
    ): Promise<IpcResponse<SearchResult[]>> => {
      if (useFakeData) {
        const filtered = await searchDemoEmails(query);
        return { success: true, data: filtered };
      }

      try {
        const results = searchEmails(query, options);
        return { success: true, data: results };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Search failed",
        };
      }
    },
  );

  // Get search suggestions
  ipcMain.handle(
    "search:suggestions",
    async (
      _,
      { query, limit }: { query: string; limit?: number },
    ): Promise<IpcResponse<string[]>> => {
      if (useFakeData) {
        return { success: true, data: ["alice@example.com", "bob@example.com"] };
      }

      try {
        const suggestions = getSearchSuggestions(query, limit);
        return { success: true, data: suggestions };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get suggestions",
        };
      }
    },
  );

  // Contact suggestions for email autocomplete
  ipcMain.handle(
    "contacts:suggest",
    async (
      _,
      { query, limit }: { query: string; limit?: number },
    ): Promise<IpcResponse<ContactSuggestion[]>> => {
      if (useFakeData) {
        const demo: ContactSuggestion[] = [
          { email: "alice@example.com", name: "Alice Johnson", frequency: 10 },
          { email: "bob@example.com", name: "Bob Smith", frequency: 5 },
        ].filter(
          (c) =>
            c.email.toLowerCase().includes(query.toLowerCase()) ||
            c.name.toLowerCase().includes(query.toLowerCase()),
        );
        return { success: true, data: demo };
      }

      try {
        const suggestions = getContactSuggestions(query, limit);
        return { success: true, data: suggestions };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to get contact suggestions",
        };
      }
    },
  );

  // Rebuild search index (admin operation)
  ipcMain.handle("search:rebuild-index", async (): Promise<IpcResponse<void>> => {
    if (useFakeData) {
      return { success: true, data: undefined };
    }

    try {
      rebuildSearchIndex();
      return { success: true, data: undefined };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to rebuild index",
      };
    }
  });
}
