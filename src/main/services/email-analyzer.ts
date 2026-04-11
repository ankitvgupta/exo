import { createMessage } from "./llm-router";
import {
  AnalysisResultSchema,
  ANALYSIS_JSON_FORMAT,
  DEFAULT_ANALYSIS_PROMPT,
  type AnalysisResult,
  type Email,
} from "../../shared/types";
import { stripQuotedContent } from "./strip-quoted-content";
import { stripJsonFences } from "../../shared/strip-json-fences";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../../shared/prompt-safety";
import { createLogger } from "./logger";
import { classifySenderByHeuristics } from "./sender-classifier";

const log = createLogger("analyzer");
// Lazy-imported to avoid pulling in ../db → electron at module load time,
// which breaks unit tests running under plain Node (not Electron).
let _buildAnalysisMemoryContext: // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  typeof import("./memory-context").buildAnalysisMemoryContext | null = null;
async function getBuildAnalysisMemoryContext() {
  if (!_buildAnalysisMemoryContext) {
    const mod = await import("./memory-context");
    _buildAnalysisMemoryContext = mod.buildAnalysisMemoryContext;
  }
  return _buildAnalysisMemoryContext;
}

// Extended system prompt with examples to enable prompt caching (requires 1024+ tokens)
const ANALYSIS_SYSTEM_PROMPT = `You are an email triage assistant. Your job is to analyze emails, classify the sender, and determine if a reply is needed.

The user's email address may be provided. If given, use it to understand the user's role in the conversation:
- If the "From" address matches the user's email, the user SENT this email. It almost never needs a reply from the user.
- If the user asked a question or made a request and someone replied with an answer, that does NOT need a reply unless the answer explicitly asks a follow-up question or requests action from the user.
- Focus on whether someone is asking something OF the user, not whether someone is responding TO the user's question.

INSTRUCTIONS:
Analyze the email. Respond with ONLY valid JSON (no markdown, no code blocks).

OUTPUT FORMAT:
{
  "needs_reply": true or false,
  "reason": "brief explanation",
  "priority": "high" or "low" (only if needs_reply is true),
  "sender_type": "person" or "automated",
  "automated_category": "orders" or "travel" or "receipts" or "newsletters" or "notifications" or "other" (only if sender_type is "automated")
}

SENDER TYPE CLASSIFICATION:
Classify the sender as "person" (a real human writing personally) or "automated" (a system, service, or bot).

"automated" includes:
- Newsletters, marketing, promotions
- GitHub, Jira, Linear, Slack, calendar notifications
- Order confirmations, shipping updates, receipts
- CI/CD, build status, monitoring alerts
- Social media notifications (LinkedIn, Twitter, etc.)
- Mailing list digests, group announcements
- Auto-replies, out-of-office, read receipts
- Travel confirmations, boarding passes, itineraries
- Any email from a noreply/donotreply address

"person" includes ONLY:
- A real human writing a personal or business email
- Even if sent through a company email system, if a person composed it, it's "person"

Be STRICT about "person" — when in doubt, classify as "automated".

AUTOMATED CATEGORIES:
When sender_type is "automated", classify into one of:
- "orders": Purchase confirmations, shipping updates, delivery notifications
- "travel": Flight/hotel/car confirmations, boarding passes, itineraries
- "receipts": Payment receipts, subscription billing, invoices
- "newsletters": Newsletters, marketing, promotions, digests
- "notifications": GitHub, Jira, Slack, calendar, social media, CI/CD, monitoring
- "other": Any automated email that doesn't fit the above

REPLY PRIORITY:
- high: Urgent requests, time-sensitive matters, important business decisions, requests from executives/VIPs
- low: Everything else that needs a reply (standard requests, networking, non-urgent coordination)

EXAMPLES:

Example 1 - Newsletter:
Email Subject: "Weekly Tech Digest: Top 10 AI Stories This Week"
Email Body: "Welcome to your weekly tech newsletter!..."
Output: {"needs_reply": false, "reason": "Newsletter/marketing content", "sender_type": "automated", "automated_category": "newsletters"}

Example 2 - Direct question from a person:
Email Subject: "Q3 Budget Proposal Review"
Email Body: "Hi, I've attached the Q3 budget proposal for your review. Could you please take a look?..."
Output: {"needs_reply": true, "reason": "Direct request for document review", "priority": "low", "sender_type": "person"}

Example 3 - GitHub notification:
Email Subject: "[company/repo] Pull request #123: Fix authentication bug was merged"
Email Body: "Merged #123 into main..."
Output: {"needs_reply": false, "reason": "Automated GitHub notification", "sender_type": "automated", "automated_category": "notifications"}

Example 4 - Meeting request from a person:
Email Subject: "Sync on project timeline?"
Email Body: "Hey! Would you be available for a quick 30-min call tomorrow?..."
Output: {"needs_reply": true, "reason": "Meeting coordination request", "priority": "low", "sender_type": "person"}

Example 5 - Urgent escalation:
Email Subject: "URGENT: Production database issue"
Email Body: "I need your approval to scale up the database instance. Please respond ASAP..."
Output: {"needs_reply": true, "reason": "Urgent production issue requiring immediate decision", "priority": "high", "sender_type": "person"}

Example 6 - Shipping notification:
Email Subject: "Your Amazon order has shipped!"
Email Body: "Great news! Your order is on its way. Track your package..."
Output: {"needs_reply": false, "reason": "Automated shipping notification", "sender_type": "automated", "automated_category": "orders"}

Example 7 - Personal introduction:
Email Subject: "Introduction from Jared Friedman"
Email Body: "Hi! Jared mentioned you're working on interesting AI tools. Would you be open to a brief call?..."
Output: {"needs_reply": true, "reason": "Personal introduction requesting networking call", "priority": "low", "sender_type": "person"}

Example 8 - Travel confirmation:
Email Subject: "Your flight confirmation - SFO to JFK"
Email Body: "Your booking is confirmed. Flight UA123, departing Jan 30..."
Output: {"needs_reply": false, "reason": "Flight booking confirmation", "sender_type": "automated", "automated_category": "travel"}

Example 9 - Payment receipt:
Email Subject: "Payment receipt for your subscription"
Email Body: "Thank you for your payment of $29.99. Your subscription has been renewed..."
Output: {"needs_reply": false, "reason": "Payment receipt", "sender_type": "automated", "automated_category": "receipts"}

Example 10 - Calendar invite notification:
Email Subject: "Invitation: Team standup @ Mon Jan 27"
Email Body: "You have been invited to a meeting..."
Output: {"needs_reply": false, "reason": "Calendar invite notification", "sender_type": "automated", "automated_category": "notifications"}

Example 11 - Contract sign-off (high priority):
Email Subject: "Need your sign-off on vendor contract"
Email Body: "We need your signature by EOD today to lock in current pricing..."
Output: {"needs_reply": true, "reason": "Time-sensitive contract requiring sign-off", "priority": "high", "sender_type": "person"}

Example 12 - Jira ticket assignment:
Email Subject: "[PROJ-456] Bug assigned to you: Login timeout"
Email Body: "A bug has been assigned to you by Sarah. Priority: High..."
Output: {"needs_reply": false, "reason": "Automated Jira notification", "sender_type": "automated", "automated_category": "notifications"}

Now analyze the following email:`;

export class EmailAnalyzer {
  private model: string;
  private customPrompt: string | null;

  constructor(model: string = "claude-sonnet-4-20250514", prompt?: string) {
    this.model = model;
    // Only use custom prompt if it differs from default
    this.customPrompt = prompt && prompt !== DEFAULT_ANALYSIS_PROMPT ? prompt : null;
  }

  async analyze(email: Email, userEmail?: string, accountId?: string): Promise<AnalysisResult> {
    const emailContent = this.formatEmailForAnalysis(email);

    // Always append JSON format suffix to ensure structured output,
    // whether using the default system prompt or a custom user prompt.
    const systemPrompt = this.customPrompt
      ? this.customPrompt + ANALYSIS_JSON_FORMAT
      : ANALYSIS_SYSTEM_PROMPT;

    const userIdentityLine = userEmail ? `Your email address: ${userEmail}\n\n` : "";

    // Inject analysis memories into the user message (not system) to preserve prompt caching.
    // The system prompt is static and cached; per-sender memories vary per email.
    const senderMatch = email.from.match(/<([^>]+)>/) ?? email.from.match(/([^\s<]+@[^\s>]+)/);
    const senderEmail = senderMatch ? senderMatch[1].toLowerCase() : email.from.toLowerCase();
    let analysisMemoryContext = "";
    if (accountId) {
      const buildCtx = await getBuildAnalysisMemoryContext();
      analysisMemoryContext = buildCtx(senderEmail, accountId);
    }

    // Prompt caching enabled via cache_control (requires 1024+ tokens in system)
    const response = await createMessage(
      {
        model: this.model,
        max_tokens: 256,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [
          {
            role: "user",
            content: `${UNTRUSTED_DATA_INSTRUCTION}

${userIdentityLine}${wrapUntrustedEmail(`From: ${email.from}\nTo: ${email.to}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${emailContent}`)}${analysisMemoryContext}`,
          },
        ],
      },
      { caller: "email-analyzer", feature: "analysis", emailId: email.id, accountId },
    );

    // Log cache performance
    const usage = response.usage as unknown as Record<string, number>;
    log.info(
      `[Analyzer] Usage: input=${usage.input_tokens}, output=${usage.output_tokens}, cache_read=${usage.cache_read_input_tokens || 0}, cache_create=${usage.cache_creation_input_tokens || 0}`,
    );

    const textBlock = response.content.find((block) => block.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    try {
      const parsed = JSON.parse(stripJsonFences(textBlock.text));
      const result = AnalysisResultSchema.parse(parsed);

      // Apply heuristic sender classification as an override when it's definitive
      const heuristicType = classifySenderByHeuristics({ from: email.from });
      if (heuristicType === "automated") {
        result.sender_type = "automated";
        // Keep the LLM's category if it also said automated, otherwise default to "other"
        if (!result.automated_category) {
          result.automated_category = "other";
        }
      }
      // If heuristics are null (ambiguous), trust the LLM's classification
      // If the LLM didn't return sender_type (old prompt / parsing issue), default to "person"
      if (!result.sender_type) {
        result.sender_type = "person";
      }

      return result;
    } catch (_error) {
      log.error({ err: textBlock.text }, "Failed to parse analysis response");
      // Default to not needing reply if parsing fails
      return {
        needs_reply: false,
        reason: "Failed to parse analysis - skipping for safety",
        sender_type: "person", // Conservative default
      };
    }
  }

  private formatEmailForAnalysis(email: Email): string {
    // Strip quoted content from previous messages in the thread —
    // only the new content of this message matters for analysis.
    let body = stripQuotedContent(email.body);

    // Truncate very long emails to avoid token limits
    const maxBodyLength = 4000;
    if (body.length > maxBodyLength) {
      body = body.substring(0, maxBodyLength) + "\n[... email truncated ...]";
    }

    return body;
  }
}
