import Anthropic from "@anthropic-ai/sdk";
import type { GmailClient } from "./gmail-client";
import { CalendaringAgent } from "./calendaring-agent";
import { getEnrichmentBySender } from "../extensions/enrichment-store";
import {
  DEFAULT_DRAFT_PROMPT,
  DRAFT_FORMAT_SUFFIX,
  type AnalysisResult,
  type DraftResult,
  type Email,
  type EAConfig,
  type GeneratedDraftResponse,
} from "../../shared/types";

/**
 * Extract reply-all CC recipients from an email's To/CC fields,
 * excluding the sender and the user's own email address.
 */
function extractReplyAllCc(email: { from: string; to: string; cc?: string }, userEmail: string): string[] {
  const parseAddresses = (field: string): string[] =>
    (field.match(/[\w.+-]+@[\w.-]+\.\w+/g) || []).map(e => e.toLowerCase());

  const senderEmail = parseAddresses(email.from)[0];
  const exclude = new Set([senderEmail, userEmail.toLowerCase()].filter(Boolean));

  const seen = new Set<string>();
  return [...parseAddresses(email.to), ...(email.cc ? parseAddresses(email.cc) : [])]
    .filter(addr => {
      const dominated = exclude.has(addr) || seen.has(addr);
      seen.add(addr);
      return !dominated;
    });
}

export class DraftGenerator {
  private anthropic: Anthropic;
  private model: string;
  private calendaringModel: string;
  private prompt: string;

  constructor(model: string = "claude-sonnet-4-20250514", prompt: string = DEFAULT_DRAFT_PROMPT, calendaringModel?: string) {
    this.anthropic = new Anthropic();
    this.model = model;
    this.calendaringModel = calendaringModel ?? model;
    // Always append format suffix so the user can't accidentally remove it
    this.prompt = prompt + DRAFT_FORMAT_SUFFIX;
  }

  async generateDraft(
    email: Email,
    analysis: AnalysisResult,
    eaConfig?: EAConfig,
    options?: { enableSenderLookup?: boolean; userEmail?: string }
  ): Promise<GeneratedDraftResponse> {
    let cc: string[] = [];

    // Default to reply-all: include all original To/CC recipients except sender and user
    if (options?.userEmail) {
      cc.push(...extractReplyAllCc(email, options.userEmail));
    }
    let calendaringContext = "";
    let calendaringResult;
    let senderContext = "";

    // Look up sender information from extension cache if enabled (enabled by default)
    const enableSenderLookup = options?.enableSenderLookup ?? true;
    if (enableSenderLookup) {
      const senderEmail = this.extractSenderEmail(email.from);
      const cached = getEnrichmentBySender(senderEmail, "web-search");
      if (cached?.data) {
        const profile = cached.data as { summary: string; name: string; email: string };
        if (profile.summary) {
          senderContext = `
SENDER CONTEXT (from web search):
${profile.summary}
---`;
          console.log(`[DraftGenerator] Using cached sender context for ${senderEmail}`);
        }
      }
    }

    // Check for scheduling if EA is enabled
    if (eaConfig?.enabled && eaConfig.email) {
      const calAgent = new CalendaringAgent(this.calendaringModel);
      calendaringResult = await calAgent.analyze(email);

      if (
        calendaringResult.hasSchedulingContext &&
        calendaringResult.action === "defer_to_ea"
      ) {
        cc.push(eaConfig.email);
        const deferralLanguage = calAgent.generateEADeferralLanguage(eaConfig);
        calendaringContext = `
IMPORTANT SCHEDULING INSTRUCTION:
This email involves scheduling. INCLUDE this text verbatim in your response: "${deferralLanguage}"
Do NOT propose specific times yourself - defer to the assistant.`;
        calendaringResult.eaDeferralLanguage = deferralLanguage;
      }
    }

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${this.prompt}
${senderContext}
${calendaringContext}
---
ANALYSIS (for context):
Reason for reply: ${analysis.reason}
Priority: ${analysis.priority || "medium"}

---
ORIGINAL EMAIL:

From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date}

${email.body}`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return {
      body: textBlock.text.trim(),
      cc: cc.length > 0 ? cc : undefined,
      calendaringResult,
    };
  }

  async composeNewEmail(
    to: string[],
    subject: string,
    instructions: string,
    options?: { enableSenderLookup?: boolean }
  ): Promise<GeneratedDraftResponse> {
    let recipientContext = "";

    // Look up recipient information from extension cache
    const enableSenderLookup = options?.enableSenderLookup ?? true;
    if (enableSenderLookup) {
      for (const recipient of to) {
        const recipientEmail = this.extractSenderEmail(recipient);
        const cached = getEnrichmentBySender(recipientEmail, "web-search");
        if (cached?.data) {
          const profile = cached.data as { summary: string; name: string; email: string };
          if (profile.summary) {
            recipientContext += `
RECIPIENT CONTEXT (${recipient}, from web search):
${profile.summary}
---`;
            console.log(`[DraftGenerator] Using cached recipient context for ${recipientEmail}`);
          }
        }
      }
    }

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${this.prompt}
${recipientContext}
---
Compose a new email (not a reply to an existing thread).

To: ${to.join(", ")}
Subject: ${subject}

INSTRUCTIONS:
${instructions}`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return { body: textBlock.text.trim() };
  }

  async generateForward(
    email: Email,
    instructions: string,
    options?: { enableSenderLookup?: boolean }
  ): Promise<GeneratedDraftResponse> {
    let recipientContext = "";

    // Look up original sender info from extension cache
    const enableSenderLookup = options?.enableSenderLookup ?? true;
    if (enableSenderLookup) {
      const senderEmail = this.extractSenderEmail(email.from);
      const cached = getEnrichmentBySender(senderEmail, "web-search");
      if (cached?.data) {
        const profile = cached.data as { summary: string; name: string; email: string };
        if (profile.summary) {
          recipientContext = `
ORIGINAL SENDER CONTEXT (${email.from}, from web search):
${profile.summary}
---`;
          console.log(`[DraftGenerator] Using cached sender context for forward from ${senderEmail}`);
        }
      }
    }

    const lowerSubject = email.subject.toLowerCase();
    const subject = (lowerSubject.startsWith("fwd:") || lowerSubject.startsWith("fw:"))
      ? email.subject
      : `Fwd: ${email.subject}`;

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `${this.prompt}
${recipientContext}
---
Write the text for a forwarded email. The original email will be automatically appended as quoted content, so do not reproduce it.

INSTRUCTIONS:
${instructions}

---
ORIGINAL EMAIL BEING FORWARDED:

From: ${email.from}
To: ${email.to}
Subject: ${email.subject}
Date: ${email.date}

${email.body}`,
        },
      ],
    });

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    return { body: textBlock.text.trim(), subject };
  }

  async createDraft(
    gmailClient: GmailClient,
    email: Email,
    draftBody: string,
    dryRun: boolean = false
  ): Promise<DraftResult> {
    // Extract reply-to address (or use from address)
    const replyTo = this.extractReplyAddress(email.from);

    // Format subject with Re: if not already present
    const subject = email.subject.startsWith("Re:")
      ? email.subject
      : `Re: ${email.subject}`;

    if (dryRun) {
      console.log("\n[DRY RUN] Would create draft:");
      console.log(`  To: ${replyTo}`);
      console.log(`  Subject: ${subject}`);
      console.log(`  Thread: ${email.threadId}`);
      console.log(`  Body:\n${draftBody.split("\n").map((l) => "    " + l).join("\n")}`);

      return {
        emailId: email.id,
        threadId: email.threadId,
        subject,
        draftBody,
        created: false,
      };
    }

    try {
      const result = await gmailClient.createDraft({
        to: replyTo,
        subject,
        body: draftBody,
        threadId: email.threadId,
      });

      return {
        emailId: email.id,
        threadId: email.threadId,
        subject,
        draftBody,
        draftId: result?.id,
        created: true,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        emailId: email.id,
        threadId: email.threadId,
        subject,
        draftBody,
        created: false,
        error: errorMessage,
      };
    }
  }

  private extractReplyAddress(from: string): string {
    // Handle formats like "Name <email@example.com>" or just "email@example.com"
    const match = from.match(/<([^>]+)>/);
    return match ? match[1] : from;
  }

  private extractSenderEmail(from: string): string {
    const match = from.match(/<([^>]+)>/);
    return (match ? match[1] : from).toLowerCase();
  }
}
