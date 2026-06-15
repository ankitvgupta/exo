import { createMessage, type CreateOptions } from "./llm-service";
import type { MessageCreateParamsNonStreaming } from "@anthropic-ai/sdk/resources/messages";
import {
  buildCalendarEventInsertParams,
  CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING,
  chooseCalendarTimezone,
  parseCalendarInviteDraft,
  validateCalendarInviteDraft,
} from "../../shared/calendar-invite";
import type {
  CalendarInviteCalendarOption,
  CalendarInviteDraft,
  DashboardEmail,
  LlmProvider,
} from "../../shared/types";
import { UNTRUSTED_DATA_INSTRUCTION, wrapUntrustedEmail } from "../../shared/prompt-safety";
import { createLogger } from "./logger";

export {
  buildCalendarEventInsertParams,
  chooseCalendarTimezone,
  parseCalendarInviteDraft,
  validateCalendarInviteDraft,
};
export type { CalendarInviteCalendarOption };

const log = createLogger("calendar-invite");

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAX_INVITE_THREAD_MESSAGES = 6;
const MAX_INVITE_BODY_CHARS = 2_500;
const CALENDAR_INVITE_MAX_TOKENS = 3000;
const CALENDAR_INVITE_RETRY_MAX_TOKENS = 4096;
const ANTHROPIC_CALENDAR_INVITE_EXTRACTION_TIMEOUT_MS = 60_000;
const OLLAMA_CALENDAR_INVITE_EXTRACTION_TIMEOUT_MS = 120_000;
const EXTRACTION_TIMEOUT_WARNING = "AI extraction timed out. Fill in the invite manually.";
type CalendarInviteExtractionAttempt = "initial" | "retry";
type CalendarInviteModelConfig = { provider: LlmProvider; model: string };
type CalendarInviteMetadata = { emailId?: string; accountId?: string };
export type CalendarInviteMessageSender = (
  params: MessageCreateParamsNonStreaming,
  options: CreateOptions,
) => ReturnType<typeof createMessage>;

const CALENDAR_INVITE_OUTPUT_FORMAT = {
  type: "json_schema",
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "start",
      "end",
      "timezone",
      "guests",
      "conference",
      "location",
      "description",
      "calendarId",
      "confidence",
      "warnings",
    ],
    properties: {
      title: { type: "string" },
      start: {
        type: "string",
        description: "ISO 8601 datetime string, or empty string if unknown.",
      },
      end: {
        type: "string",
        description: "ISO 8601 datetime string, or empty string if unknown.",
      },
      timezone: { type: "string" },
      guests: {
        type: "array",
        items: { type: "string" },
      },
      conference: {
        type: "object",
        additionalProperties: false,
        required: ["type"],
        properties: {
          type: { type: "string", enum: ["googleMeet", "link", "phone", "none"] },
          value: { type: "string" },
        },
      },
      location: { type: "string" },
      description: { type: "string" },
      calendarId: { type: "string" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      warnings: {
        type: "array",
        items: { type: "string" },
      },
    },
  },
} as const satisfies NonNullable<MessageCreateParamsNonStreaming["output_config"]>["format"];

function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function parseEmails(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(value.matchAll(EMAIL_RE), (match) => match[0].toLowerCase());
}

function uniqueEmails(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function defaultStartFromEmailDate(emailDate: string): { start: string; end: string } {
  const base = new Date(emailDate);
  if (!Number.isFinite(base.getTime())) {
    base.setTime(Date.now());
  }
  base.setDate(base.getDate() + 7);
  base.setHours(14, 0, 0, 0);
  const end = new Date(base.getTime() + 30 * 60_000);
  return { start: base.toISOString(), end: end.toISOString() };
}

function chooseDefaultCalendar(
  calendars: CalendarInviteCalendarOption[],
): CalendarInviteCalendarOption | null {
  return (
    calendars.find((calendar) => calendar.writable && calendar.primary) ??
    calendars.find((calendar) => calendar.writable) ??
    calendars[0] ??
    null
  );
}

export function getCalendarInviteExtractionTimeoutMs(provider: LlmProvider): number {
  return provider === "ollama-cloud"
    ? OLLAMA_CALENDAR_INVITE_EXTRACTION_TIMEOUT_MS
    : ANTHROPIC_CALENDAR_INVITE_EXTRACTION_TIMEOUT_MS;
}

export function getCalendarInviteExtractionMaxTokens(): number {
  return CALENDAR_INVITE_MAX_TOKENS;
}

function getCalendarInviteAttemptMaxTokens(attempt: CalendarInviteExtractionAttempt): number {
  return attempt === "retry" ? CALENDAR_INVITE_RETRY_MAX_TOKENS : CALENDAR_INVITE_MAX_TOKENS;
}

function getCalendarInviteThinkMode(
  modelConfig: CalendarInviteModelConfig,
): CreateOptions["think"] {
  if (
    modelConfig.provider === "ollama-cloud" &&
    modelConfig.model.toLowerCase().startsWith("kimi-k2.6")
  ) {
    return false;
  }
  return "low";
}

function shouldRetryCalendarInviteExtraction(draft: CalendarInviteDraft): boolean {
  return draft.warnings.includes(CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING);
}

export function createCalendarInviteFallbackDraft(
  defaults: { calendarId: string; timezone: string },
  warning = CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING,
): CalendarInviteDraft {
  const draft = parseCalendarInviteDraft("", defaults);
  return {
    ...draft,
    warnings: [
      warning,
      ...draft.warnings.filter((item) => item !== CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING),
    ],
  };
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  if (error instanceof Error) {
    return error.name === "AbortError" || /aborted/i.test(error.message);
  }
  return false;
}

function truncateBody(body: string | undefined): string {
  const value = body ?? "";
  if (value.length <= MAX_INVITE_BODY_CHARS) return value;
  return `${value.slice(0, MAX_INVITE_BODY_CHARS)}\n\n[Body truncated: ${value.length - MAX_INVITE_BODY_CHARS} characters omitted]`;
}

export function buildCalendarInviteExtractionPrompt(threadEmails: DashboardEmail[]): string {
  const omitted = Math.max(0, threadEmails.length - MAX_INVITE_THREAD_MESSAGES);
  const emails = threadEmails.slice(-MAX_INVITE_THREAD_MESSAGES);
  const prompt = emails
    .map((email, index) =>
      [
        `Message ${omitted + index + 1}`,
        `From: ${email.from}`,
        `To: ${email.to}`,
        email.cc ? `Cc: ${email.cc}` : null,
        `Date: ${email.date}`,
        `Subject: ${email.subject}`,
        "",
        truncateBody(email.body),
      ]
        .filter((line): line is string => line !== null)
        .join("\n"),
    )
    .join("\n\n---\n\n");

  if (omitted === 0) return prompt;
  return `Showing the latest ${emails.length} messages. ${omitted} older messages omitted to keep invite extraction responsive.\n\n${prompt}`;
}

function buildCalendarInviteExtractionSystemPrompt(
  calendarSummary: string,
  defaults: { calendarId: string; timezone: string },
  attempt: CalendarInviteExtractionAttempt,
): string {
  const retryInstruction =
    attempt === "retry"
      ? "\nThis is a retry because the previous response was not parseable JSON. Keep the response terse. Return one JSON object only; no analysis, markdown, or prose.\n"
      : "";

  return `Extract a Google Calendar invite draft from the selected email thread.

Return ONLY valid JSON with this shape:
{
  "title": "string",
  "start": "ISO datetime string",
  "end": "ISO datetime string",
  "timezone": "IANA timezone",
  "guests": ["email@example.com"],
  "conference": { "type": "googleMeet" | "link" | "phone" | "none", "value": "optional string" },
  "location": "string",
  "description": "string",
  "calendarId": "string",
  "confidence": 0.0,
  "warnings": ["string"]
}
${retryInstruction}
Infer guests from the actual scheduling context, not by blindly copying every sender, To, and Cc recipient. Use Google Meet by default unless the thread clearly contains another meeting link, phone bridge, or physical location. Normalize displayed times to the selected calendar timezone when possible.

Date and duration defaults:
- If a weekday or month/day is provided without an explicit year, assume the same calendar year as the relevant email message date unless the thread explicitly says otherwise. Do not add a warning for this.
- If a start time is clear but no end time is provided, assume a 30-minute duration. Do not add a warning for this.
- If a multi-day event has dates but no explicit end time on the final date, infer a reasonable end time on the final day from the event context. Do not add a warning for this.

Warnings are only for actionable items the user must review before sending, such as a missing email address for a named guest, genuinely ambiguous date/time wording, conflicting meeting details, or missing required fields. Do not include speculative attendee advice like whether the sender or current user may not need to attend.

Available calendars:
${calendarSummary || "(none)"}

Default calendarId: ${defaults.calendarId || "(none)"}
Default timezone: ${defaults.timezone}

${UNTRUSTED_DATA_INSTRUCTION}`;
}

async function requestCalendarInviteExtraction(args: {
  threadEmails: DashboardEmail[];
  calendarSummary: string;
  defaults: { calendarId: string; timezone: string };
  modelConfig: CalendarInviteModelConfig;
  metadata?: CalendarInviteMetadata;
  attempt: CalendarInviteExtractionAttempt;
  sendMessage: CalendarInviteMessageSender;
}) {
  const maxTokens = getCalendarInviteAttemptMaxTokens(args.attempt);
  return args.sendMessage(
    {
      model: args.modelConfig.model,
      max_tokens: maxTokens,
      output_config: {
        format: CALENDAR_INVITE_OUTPUT_FORMAT,
      },
      system: [
        {
          type: "text",
          text: buildCalendarInviteExtractionSystemPrompt(
            args.calendarSummary,
            args.defaults,
            args.attempt,
          ),
        },
      ],
      messages: [
        {
          role: "user",
          content: wrapUntrustedEmail(buildCalendarInviteExtractionPrompt(args.threadEmails)),
        },
      ],
    },
    {
      caller: "calendar-invite-extractor",
      emailId: args.metadata?.emailId,
      accountId: args.metadata?.accountId,
      provider: args.modelConfig.provider,
      think: getCalendarInviteThinkMode(args.modelConfig),
      timeoutMs: getCalendarInviteExtractionTimeoutMs(args.modelConfig.provider),
    },
  );
}

function parseResponseTextOrFallback(
  response: Awaited<ReturnType<CalendarInviteMessageSender>>,
  defaults: { calendarId: string; timezone: string },
): {
  draft: CalendarInviteDraft;
  textLength: number;
  outputTokens: number;
  contentBlockTypes: string[];
  thinkingLength: number;
} {
  const textBlock = response.content.find((block) => block.type === "text");
  const thinkingBlock = response.content.find((block) => block.type === "thinking");
  const thinkingLength =
    thinkingBlock && "thinking" in thinkingBlock && typeof thinkingBlock.thinking === "string"
      ? thinkingBlock.thinking.length
      : 0;
  const text = textBlock && textBlock.type === "text" ? textBlock.text : "";
  return {
    draft: parseCalendarInviteDraft(text, defaults),
    textLength: text.length,
    outputTokens: response.usage.output_tokens,
    contentBlockTypes: response.content.map((block) => block.type),
    thinkingLength,
  };
}

export function buildDemoCalendarInviteDraft(
  threadEmails: DashboardEmail[],
  calendars: CalendarInviteCalendarOption[],
  fallbackTimezone = localTimezone(),
): CalendarInviteDraft {
  const latest = threadEmails[threadEmails.length - 1];
  const defaultCalendar = chooseDefaultCalendar(calendars);
  const timezone = chooseCalendarTimezone(
    calendars,
    defaultCalendar?.calendarId,
    defaultCalendar?.timezone ?? fallbackTimezone,
  );
  const { start, end } = defaultStartFromEmailDate(latest?.date ?? new Date().toISOString());
  const currentUserEmails = new Set([
    "me@example.com",
    "demo@example.com",
    "ankit@example.com",
    "assistant@example.com",
  ]);
  const guests = uniqueEmails(
    threadEmails.flatMap((email) => [
      ...parseEmails(email.from),
      ...parseEmails(email.to),
      ...parseEmails(email.cc),
    ]),
  ).filter((email) => !currentUserEmails.has(email));

  return {
    title: latest?.subject || "New meeting",
    start,
    end,
    timezone,
    guests,
    conference: { type: "googleMeet" },
    location: "",
    description: latest?.body || "",
    calendarId: defaultCalendar?.calendarId ?? "",
    confidence: 0.6,
    warnings: ["Demo mode inferred the time so no live calendar or AI data is used."],
  };
}

export async function extractCalendarInviteDraft(
  threadEmails: DashboardEmail[],
  calendars: CalendarInviteCalendarOption[],
  fallbackTimezone = localTimezone(),
  metadata?: CalendarInviteMetadata,
): Promise<CalendarInviteDraft> {
  const { getFeatureModelConfig } = await import("../ipc/settings.ipc");
  return extractCalendarInviteDraftWithProvider(
    threadEmails,
    calendars,
    getFeatureModelConfig("calendaring"),
    fallbackTimezone,
    metadata,
  );
}

export async function extractCalendarInviteDraftWithProvider(
  threadEmails: DashboardEmail[],
  calendars: CalendarInviteCalendarOption[],
  modelConfig: CalendarInviteModelConfig,
  fallbackTimezone = localTimezone(),
  metadata?: CalendarInviteMetadata,
  sendMessage: CalendarInviteMessageSender = createMessage,
): Promise<CalendarInviteDraft> {
  const scopedCalendars = metadata?.accountId
    ? calendars.filter((calendar) => calendar.accountId === metadata.accountId)
    : calendars;
  const defaultCalendar = chooseDefaultCalendar(scopedCalendars);
  const defaultTimezone = chooseCalendarTimezone(
    scopedCalendars,
    defaultCalendar?.calendarId,
    defaultCalendar?.timezone ?? fallbackTimezone,
  );
  const defaults = {
    calendarId: defaultCalendar?.calendarId ?? "",
    timezone: defaultTimezone,
  };

  const calendarSummary = scopedCalendars
    .map((calendar) =>
      JSON.stringify({
        calendarId: calendar.calendarId,
        name: calendar.calendarName,
        timezone: calendar.timezone,
        writable: calendar.writable,
        primary: calendar.primary,
      }),
    )
    .join("\n");

  let response: Awaited<ReturnType<CalendarInviteMessageSender>>;
  try {
    response = await requestCalendarInviteExtraction({
      threadEmails,
      calendarSummary,
      defaults,
      modelConfig,
      metadata,
      attempt: "initial",
      sendMessage,
    });
  } catch (error) {
    const warning = isAbortError(error)
      ? EXTRACTION_TIMEOUT_WARNING
      : CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING;
    log.warn(
      { err: error, emailId: metadata?.emailId, accountId: metadata?.accountId },
      "Calendar invite extraction failed; falling back to manual draft",
    );
    return createCalendarInviteFallbackDraft(defaults, warning);
  }

  const initial = parseResponseTextOrFallback(response, defaults);
  if (!shouldRetryCalendarInviteExtraction(initial.draft)) {
    return initial.draft;
  }

  log.warn(
    {
      emailId: metadata?.emailId,
      accountId: metadata?.accountId,
      provider: modelConfig.provider,
      model: modelConfig.model,
      outputTokens: initial.outputTokens,
      maxTokens: CALENDAR_INVITE_MAX_TOKENS,
      hitTokenBudget: initial.outputTokens >= CALENDAR_INVITE_MAX_TOKENS,
      textLength: initial.textLength,
      contentBlockTypes: initial.contentBlockTypes,
      thinkingLength: initial.thinkingLength,
    },
    "Calendar invite extraction returned unparseable structured output; retrying with larger budget",
  );

  try {
    const retryResponse = await requestCalendarInviteExtraction({
      threadEmails,
      calendarSummary,
      defaults,
      modelConfig,
      metadata,
      attempt: "retry",
      sendMessage,
    });
    const retry = parseResponseTextOrFallback(retryResponse, defaults);
    if (shouldRetryCalendarInviteExtraction(retry.draft)) {
      log.warn(
        {
          emailId: metadata?.emailId,
          accountId: metadata?.accountId,
          provider: modelConfig.provider,
          model: modelConfig.model,
          outputTokens: retry.outputTokens,
          maxTokens: CALENDAR_INVITE_RETRY_MAX_TOKENS,
          hitTokenBudget: retry.outputTokens >= CALENDAR_INVITE_RETRY_MAX_TOKENS,
          textLength: retry.textLength,
          contentBlockTypes: retry.contentBlockTypes,
          thinkingLength: retry.thinkingLength,
        },
        "Calendar invite extraction retry also returned unparseable structured output",
      );
    }
    return retry.draft;
  } catch (error) {
    const warning = isAbortError(error)
      ? EXTRACTION_TIMEOUT_WARNING
      : CALENDAR_INVITE_EXTRACTION_FAILURE_WARNING;
    log.warn(
      { err: error, emailId: metadata?.emailId, accountId: metadata?.accountId },
      "Calendar invite extraction retry failed; falling back to manual draft",
    );
    return createCalendarInviteFallbackDraft(defaults, warning);
  }
}
