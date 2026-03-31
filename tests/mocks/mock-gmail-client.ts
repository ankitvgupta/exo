import type { Email, EmailSearchResult, SentEmail } from "../../src/shared/types";
import { FAKE_INBOX_EMAILS, FAKE_SENT_EMAILS } from "../fixtures/fake-emails";

// Types for compose operations
interface ComposeMessageOptions {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyHtml?: string;
  bodyText?: string;
  threadId?: string;
  inReplyTo?: string;
  references?: string;
}

interface MockDraft {
  id: string;
  to: string | string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  threadId?: string;
  cc?: string[];
  bcc?: string[];
}

interface MockSentMessage {
  id: string;
  threadId: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  sentAt: Date;
}

// Mock Gmail client that uses fake emails instead of real Gmail API
// IMPORTANT: This client NEVER makes real API calls - all operations are mocked
export class MockGmailClient {
  private connected = false;
  private drafts: Map<string, MockDraft> = new Map();
  private draftCounter = 0;
  private sentMessages: Map<string, MockSentMessage> = new Map();
  private sentCounter = 0;

  async connect(): Promise<void> {
    this.connected = true;
    console.log("[MOCK] Connected to fake Gmail API");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    console.log("[MOCK] Disconnected from fake Gmail API");
  }

  hasCredentials(): boolean {
    return true; // Always return true for testing
  }

  hasTokens(): boolean {
    return true; // Always return true for testing
  }

  async saveCredentials(_clientId: string, _clientSecret: string): Promise<void> {
    console.log("[MOCK] Credentials saved");
  }

  async listCapabilities(): Promise<string[]> {
    return ["search_emails", "read_email", "create_draft"];
  }

  async searchEmails(
    query: string,
    maxResults: number = 50,
    _pageToken?: string,
  ): Promise<{ results: EmailSearchResult[]; nextPageToken?: string }> {
    // Filter emails based on simple query matching
    let emails = FAKE_INBOX_EMAILS;

    if (query.includes("is:unread") && query.includes("in:inbox")) {
      // Return all fake inbox emails
      emails = FAKE_INBOX_EMAILS;
    } else if (query.includes("in:sent")) {
      // Return sent email IDs
      return {
        results: FAKE_SENT_EMAILS.slice(0, maxResults).map((e) => ({
          id: e.id,
          threadId: `thread-${e.id}`,
          snippet: e.body.substring(0, 100),
        })),
      };
    }

    return {
      results: emails.slice(0, maxResults).map((e) => ({
        id: e.id,
        threadId: e.threadId,
        snippet: e.snippet || "",
      })),
    };
  }

  async readEmail(messageId: string): Promise<Email | null> {
    const email = FAKE_INBOX_EMAILS.find((e) => e.id === messageId);
    if (email) return email;

    // Check sent emails
    const sentEmail = FAKE_SENT_EMAILS.find((e) => e.id === messageId);
    if (sentEmail) {
      return {
        id: sentEmail.id,
        threadId: `thread-${sentEmail.id}`,
        subject: sentEmail.subject,
        from: "me@example.com",
        to: sentEmail.toAddress,
        date: sentEmail.date,
        body: sentEmail.body,
      };
    }

    return null;
  }

  async createDraft(params: {
    to: string;
    subject: string;
    body: string;
    threadId?: string;
  }): Promise<{ id: string }> {
    this.draftCounter++;
    const draftId = `draft-${this.draftCounter}`;
    this.drafts.set(draftId, { id: draftId, ...params });
    console.log(`[MOCK] Created draft ${draftId} to ${params.to}: ${params.subject}`);
    return { id: draftId };
  }

  async searchSentEmails(maxResults: number = 500): Promise<SentEmail[]> {
    return FAKE_SENT_EMAILS.slice(0, maxResults);
  }

  // =====================================
  // Compose/Send Operations (all mocked)
  // =====================================

  /**
   * MOCK: Send a message (does NOT actually send)
   * Returns a fake message ID and thread ID
   */
  async sendMessage(options: ComposeMessageOptions): Promise<{ id: string; threadId: string }> {
    this.sentCounter++;
    const messageId = `mock-sent-${this.sentCounter}`;
    const threadId = options.threadId || `mock-thread-${this.sentCounter}`;

    this.sentMessages.set(messageId, {
      id: messageId,
      threadId,
      to: options.to,
      cc: options.cc,
      subject: options.subject,
      body: options.bodyHtml || options.bodyText || "",
      sentAt: new Date(),
    });

    console.log(`[MOCK] Sent message ${messageId} to ${options.to.join(", ")} (NOT REAL)`);
    return { id: messageId, threadId };
  }

  /**
   * MOCK: Create a full draft with compose options
   */
  async createFullDraft(
    options: ComposeMessageOptions,
  ): Promise<{ id: string; messageId: string }> {
    this.draftCounter++;
    const draftId = `mock-draft-${this.draftCounter}`;
    const messageId = `mock-draft-msg-${this.draftCounter}`;

    this.drafts.set(draftId, {
      id: draftId,
      to: options.to,
      subject: options.subject,
      body: options.bodyText || "",
      bodyHtml: options.bodyHtml,
      threadId: options.threadId,
      cc: options.cc,
      bcc: options.bcc,
    });

    console.log(`[MOCK] Created draft ${draftId} to ${options.to.join(", ")} (NOT REAL)`);
    return { id: draftId, messageId };
  }

  /**
   * MOCK: Update an existing draft
   */
  async updateDraft(
    draftId: string,
    options: ComposeMessageOptions,
  ): Promise<{ id: string; messageId: string }> {
    if (!this.drafts.has(draftId)) {
      throw new Error(`Draft ${draftId} not found`);
    }

    this.drafts.set(draftId, {
      id: draftId,
      to: options.to,
      subject: options.subject,
      body: options.bodyText || "",
      bodyHtml: options.bodyHtml,
      threadId: options.threadId,
      cc: options.cc,
      bcc: options.bcc,
    });

    console.log(`[MOCK] Updated draft ${draftId}`);
    return { id: draftId, messageId: `mock-draft-msg-${draftId}` };
  }

  /**
   * MOCK: Send an existing draft (does NOT actually send)
   */
  async sendDraft(draftId: string): Promise<{ id: string; threadId: string }> {
    const draft = this.drafts.get(draftId);
    if (!draft) {
      throw new Error(`Draft ${draftId} not found`);
    }

    this.sentCounter++;
    const messageId = `mock-sent-${this.sentCounter}`;
    const threadId = draft.threadId || `mock-thread-${this.sentCounter}`;

    const toAddresses = Array.isArray(draft.to) ? draft.to : [draft.to];
    this.sentMessages.set(messageId, {
      id: messageId,
      threadId,
      to: toAddresses,
      cc: draft.cc,
      subject: draft.subject,
      body: draft.bodyHtml || draft.body,
      sentAt: new Date(),
    });

    // Remove draft after sending
    this.drafts.delete(draftId);

    console.log(`[MOCK] Sent draft ${draftId} as message ${messageId} (NOT REAL)`);
    return { id: messageId, threadId };
  }

  /**
   * MOCK: List all drafts
   */
  async listDrafts(
    maxResults: number = 100,
  ): Promise<Array<{ id: string; message: { id: string; threadId: string } }>> {
    const drafts = Array.from(this.drafts.values())
      .slice(0, maxResults)
      .map((d) => ({
        id: d.id,
        message: {
          id: `msg-${d.id}`,
          threadId: d.threadId || `thread-${d.id}`,
        },
      }));
    return drafts;
  }

  /**
   * MOCK: Get a single draft
   */
  async getDraft(draftId: string): Promise<MockDraft | null> {
    return this.drafts.get(draftId) || null;
  }

  /**
   * MOCK: Delete a draft
   */
  async deleteDraft(draftId: string): Promise<void> {
    if (!this.drafts.has(draftId)) {
      throw new Error(`Draft ${draftId} not found`);
    }
    this.drafts.delete(draftId);
    console.log(`[MOCK] Deleted draft ${draftId}`);
  }

  /**
   * MOCK: Archive a message (just logs, no real action)
   */
  async archiveMessage(messageId: string): Promise<void> {
    console.log(`[MOCK] Archived message ${messageId} (NOT REAL)`);
  }

  /**
   * MOCK: Trash a message (just logs, no real action)
   */
  async trashMessage(messageId: string): Promise<void> {
    console.log(`[MOCK] Trashed message ${messageId} (NOT REAL)`);
  }

  /**
   * MOCK: Star/unstar a message (just logs, no real action)
   */
  async setStarred(messageId: string, starred: boolean): Promise<void> {
    console.log(`[MOCK] Set starred=${starred} for message ${messageId} (NOT REAL)`);
  }

  /**
   * MOCK: Mark read/unread (just logs, no real action)
   */
  async setRead(messageId: string, read: boolean): Promise<void> {
    console.log(`[MOCK] Set read=${read} for message ${messageId} (NOT REAL)`);
  }

  /**
   * MOCK: Get message headers for reply threading
   */
  async getMessageHeaders(
    messageId: string,
  ): Promise<{ messageId: string; references: string; subject: string } | null> {
    const email = FAKE_INBOX_EMAILS.find((e) => e.id === messageId);
    if (!email) return null;

    return {
      messageId: `<${messageId}@mock.example.com>`,
      references: `<ref-${messageId}@mock.example.com>`,
      subject: email.subject,
    };
  }

  // =====================================
  // Test helper methods
  // =====================================

  getDrafts(): Map<string, MockDraft> {
    return this.drafts;
  }

  clearDrafts(): void {
    this.drafts.clear();
    this.draftCounter = 0;
  }

  getSentMessages(): Map<string, MockSentMessage> {
    return this.sentMessages;
  }

  clearSentMessages(): void {
    this.sentMessages.clear();
    this.sentCounter = 0;
  }

  clearAll(): void {
    this.clearDrafts();
    this.clearSentMessages();
  }
}

// Export a singleton instance for use in tests
export const mockGmailClient = new MockGmailClient();
