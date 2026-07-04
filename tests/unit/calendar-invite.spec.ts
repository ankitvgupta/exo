import { test, expect } from "@playwright/test";
import {
  buildCalendarEventInsertParams,
  buildCalendarInviteExtractionPrompt,
  chooseCalendarTimezone,
  createCalendarInviteFallbackDraft,
  extractCalendarInviteDraftWithProvider,
  getCalendarInviteExtractionMaxTokens,
  getCalendarInviteExtractionTimeoutMs,
  parseCalendarInviteDraft,
  validateCalendarInviteDraft,
  type CalendarInviteMessageSender,
  type CalendarInviteCalendarOption,
} from "../../src/main/services/calendar-invite";
import type { DashboardEmail } from "../../src/shared/types";

const writableCalendars: CalendarInviteCalendarOption[] = [
  {
    accountId: "demo",
    accountEmail: "demo@example.com",
    calendarId: "primary",
    calendarName: "Demo Calendar",
    calendarColor: "#2563eb",
    timezone: "America/New_York",
    writable: true,
    primary: true,
  },
  {
    accountId: "demo",
    accountEmail: "demo@example.com",
    calendarId: "team",
    calendarName: "Team",
    calendarColor: "#16a34a",
    timezone: "America/Chicago",
    writable: true,
    primary: false,
  },
];

test.describe("calendar invite helpers", () => {
  test("uses a longer extraction timeout for slower Ollama Cloud structured output", () => {
    expect(getCalendarInviteExtractionTimeoutMs("anthropic")).toBe(60_000);
    expect(getCalendarInviteExtractionTimeoutMs("ollama-cloud")).toBe(120_000);
  });

  test("uses a bounded extraction token budget that does not truncate typical structured output", () => {
    expect(getCalendarInviteExtractionMaxTokens()).toBeGreaterThan(1472);
    expect(getCalendarInviteExtractionMaxTokens()).toBeLessThan(4096);
  });

  test("bounds extraction prompt size for long live threads", () => {
    const longBody = "Please find a time next week. ".repeat(400);
    const emails: DashboardEmail[] = Array.from({ length: 10 }, (_, index) => ({
      id: `email-${index + 1}`,
      accountId: "default",
      threadId: "thread-long",
      from: `person${index + 1}@example.com`,
      to: "me@example.com",
      cc: "",
      subject: `Message ${index + 1}`,
      body: longBody,
      date: `2026-06-${String(index + 1).padStart(2, "0")}T12:00:00.000Z`,
      isUnread: false,
      isStarred: false,
      snippet: "",
      labels: [],
      attachments: [],
    }));

    const prompt = buildCalendarInviteExtractionPrompt(emails);

    expect(prompt).toContain("Showing the latest 6 messages");
    expect(prompt).not.toContain("Message 1\nFrom: person1@example.com");
    expect(prompt).toContain("Message 10\nFrom: person10@example.com");
    expect(prompt).toContain("[Body truncated");
    expect(prompt.length).toBeLessThan(60_000);
  });

  test("builds an editable fallback draft with a specific extraction warning", () => {
    const draft = createCalendarInviteFallbackDraft(
      { calendarId: "primary", timezone: "America/New_York" },
      "AI extraction timed out. Fill in the invite manually.",
    );

    expect(draft.calendarId).toBe("primary");
    expect(draft.timezone).toBe("America/New_York");
    expect(draft.warnings[0]).toBe("AI extraction timed out. Fill in the invite manually.");
    expect(draft.warnings).toContain("Missing title.");
  });

  test("parses structured invite JSON and adds warnings for missing fields", () => {
    const draft = parseCalendarInviteDraft(
      JSON.stringify({
        title: "",
        start: "2026-06-02T14:00:00-04:00",
        end: "2026-06-02T14:30:00-04:00",
        timezone: "America/New_York",
        guests: ["kat@example.com"],
        conference: { type: "googleMeet" },
        location: "",
        description: "Discuss partnership opportunity.",
        calendarId: "primary",
        confidence: 0.72,
        warnings: ["Original time was inferred from vague language."],
      }),
      { calendarId: "primary", timezone: "America/New_York" },
    );

    // The -04:00 offset is America/New_York's summer offset and the calendar is
    // also America/New_York, so normalizing to floating calendar wall-clock keeps
    // the same clock time and drops the (now redundant) offset.
    expect(draft.start).toBe("2026-06-02T14:00:00");
    expect(draft.end).toBe("2026-06-02T14:30:00");
    expect(draft.conference.type).toBe("googleMeet");
    expect(draft.warnings).toContain("Original time was inferred from vague language.");
    expect(draft.warnings).toContain("Missing title.");
  });

  test("drops non-actionable invite assumptions while keeping missing guest warnings", () => {
    const draft = parseCalendarInviteDraft(
      JSON.stringify({
        title: "Intro call",
        start: "2026-06-01T15:00:00-04:00",
        end: "2026-06-01T15:30:00-04:00",
        timezone: "America/New_York",
        guests: ["matthew@example.com"],
        conference: { type: "googleMeet" },
        location: "",
        description: "",
        calendarId: "primary",
        confidence: 0.82,
        warnings: [
          "No explicit year mentioned for 'Monday' - inferred as June 1, 2026 based on email date of May 29, 2026",
          "Year 2026 inferred from email date; please confirm this is correct",
          "No end time specified - assumed 30-minute duration (common for intro calls)",
          "This is a multi-day event (Sept 23-25) with no explicit end time on Sept 25; used 10:00 AM as approximate sendoff coffee end",
          "Dr. Andy's email address not provided in thread - may need to add manually",
          "Mick is scheduling but may not need to attend; consider removing him if this is just Matthew + Dr. Andy",
        ],
      }),
      { calendarId: "primary", timezone: "America/New_York" },
    );

    expect(draft.warnings).toEqual([
      "Dr. Andy's email address not provided in thread - may need to add manually",
    ]);
  });

  test("instructs invite extraction to make safe defaults without warning", async () => {
    const emails: DashboardEmail[] = [
      {
        id: "email-scheduling-defaults",
        accountId: "default",
        threadId: "thread-scheduling-defaults",
        from: "alex@example.com",
        to: "demo@example.com",
        cc: "",
        subject: "Monday intro",
        body: "Monday at 3 works for Dr. Andy.",
        date: "2026-05-29T12:00:00.000Z",
        isUnread: false,
        isStarred: false,
        snippet: "",
        labels: [],
        attachments: [],
      },
    ];
    let systemPrompt = "";
    const sendMessage: CalendarInviteMessageSender = async (params) => {
      const systemBlock = Array.isArray(params.system) ? params.system[0] : undefined;
      systemPrompt =
        systemBlock && systemBlock.type === "text" && typeof systemBlock.text === "string"
          ? systemBlock.text
          : "";

      return {
        id: "msg-defaults",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              title: "Monday intro",
              start: "2026-06-01T15:00:00-04:00",
              end: "2026-06-01T15:30:00-04:00",
              timezone: "America/New_York",
              guests: ["alex@example.com"],
              conference: { type: "googleMeet" },
              location: "",
              description: "",
              calendarId: "primary",
              confidence: 0.8,
              warnings: [],
            }),
          },
        ],
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 200,
          output_tokens: 120,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      };
    };

    await extractCalendarInviteDraftWithProvider(
      emails,
      writableCalendars,
      { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      "America/New_York",
      { emailId: "email-scheduling-defaults", accountId: "default" },
      sendMessage,
    );

    expect(systemPrompt).toContain("same calendar year");
    expect(systemPrompt).toContain("Do not add a warning for this");
    expect(systemPrompt).toContain("assume a 30-minute duration");
    expect(systemPrompt).toContain("multi-day event");
    expect(systemPrompt).toContain("reasonable end time on the final day");
    expect(systemPrompt).toContain("Do not include speculative attendee advice");
    expect(systemPrompt).toContain("missing email address");
  });

  test("scopes LLM calendar metadata to the source email account", async () => {
    const emails: DashboardEmail[] = [
      {
        id: "email-account-b",
        accountId: "account-b",
        threadId: "thread-account-b",
        from: "alex@example.com",
        to: "demo@example.com",
        cc: "",
        subject: "Intro call",
        body: "Can we meet tomorrow at 2pm ET?",
        date: "2026-06-01T12:00:00.000Z",
        isUnread: false,
        isStarred: false,
        snippet: "",
        labels: [],
        attachments: [],
      },
    ];
    let systemPrompt = "";
    const sendMessage: CalendarInviteMessageSender = async (params) => {
      const systemBlock = Array.isArray(params.system) ? params.system[0] : undefined;
      systemPrompt =
        systemBlock && systemBlock.type === "text" && typeof systemBlock.text === "string"
          ? systemBlock.text
          : "";

      return {
        id: "msg-account-scope",
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              title: "Intro call",
              start: "2026-06-02T14:00:00-04:00",
              end: "2026-06-02T14:30:00-04:00",
              timezone: "America/New_York",
              guests: ["alex@example.com"],
              conference: { type: "googleMeet" },
              location: "",
              description: "",
              calendarId: "primary",
              confidence: 0.8,
              warnings: [],
            }),
          },
        ],
        model: "claude-sonnet-4-20250514",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 200,
          output_tokens: 120,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      };
    };

    await extractCalendarInviteDraftWithProvider(
      emails,
      [
        {
          accountId: "account-a",
          accountEmail: "a@example.com",
          calendarId: "primary",
          calendarName: "Account A Private Calendar",
          calendarColor: "#2563eb",
          timezone: "America/Los_Angeles",
          writable: true,
          primary: true,
        },
        {
          accountId: "account-b",
          accountEmail: "b@example.com",
          calendarId: "primary",
          calendarName: "Account B Work Calendar",
          calendarColor: "#16a34a",
          timezone: "America/New_York",
          writable: true,
          primary: true,
        },
      ],
      { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      "UTC",
      { emailId: "email-account-b", accountId: "account-b" },
      sendMessage,
    );

    expect(systemPrompt).toContain("Account B Work Calendar");
    expect(systemPrompt).not.toContain("Account A Private Calendar");
    expect(systemPrompt).toContain("Calendar timezone: America/New_York");
  });

  test("normalizes common LLM invite variants instead of dropping extracted fields", () => {
    const draft = parseCalendarInviteDraft(
      JSON.stringify({
        title: "Intro call",
        start: "2026-06-02T14:00:00-04:00",
        end: "2026-06-02T14:30:00-04:00",
        timezone: "",
        guests: "alice@example.com, bob@example.com",
        conference: "googleMeet",
        location: null,
        description: null,
        calendarId: "",
        confidence: "0.8",
        warnings: "",
      }),
      { calendarId: "primary", timezone: "America/New_York" },
    );

    expect(draft.title).toBe("Intro call");
    expect(draft.guests).toEqual(["alice@example.com", "bob@example.com"]);
    expect(draft.conference).toEqual({ type: "googleMeet" });
    expect(draft.location).toBe("");
    expect(draft.description).toBe("");
    expect(draft.calendarId).toBe("primary");
    expect(draft.timezone).toBe("America/New_York");
    expect(draft.confidence).toBe(0.8);
    expect(draft.warnings).not.toContain("AI extraction failed. Fill in the invite manually.");
  });

  test("falls back to a blank editable invite when extraction JSON is invalid", () => {
    const draft = parseCalendarInviteDraft("not json", {
      calendarId: "primary",
      timezone: "America/New_York",
    });

    expect(draft.title).toBe("");
    expect(draft.calendarId).toBe("primary");
    expect(draft.timezone).toBe("America/New_York");
    expect(draft.warnings).toContain("AI extraction failed. Fill in the invite manually.");
  });

  test("retries unparseable extraction output with the same provider and a larger budget", async () => {
    const emails: DashboardEmail[] = [
      {
        id: "email-scheduling",
        accountId: "default",
        threadId: "thread-scheduling",
        from: "alex@example.com",
        to: "demo@example.com",
        cc: "",
        subject: "Intro call",
        body: "Can we meet tomorrow at 2pm ET?",
        date: "2026-06-01T12:00:00.000Z",
        isUnread: false,
        isStarred: false,
        snippet: "",
        labels: [],
        attachments: [],
      },
    ];
    const calls: Array<{
      maxTokens: number;
      provider: string | undefined;
      think: Parameters<CalendarInviteMessageSender>[1]["think"];
    }> = [];
    const sendMessage: CalendarInviteMessageSender = async (params, options) => {
      calls.push({
        maxTokens: params.max_tokens,
        provider: options.provider,
        think: options.think,
      });

      return {
        id: `msg-${calls.length}`,
        type: "message",
        role: "assistant",
        content: [
          {
            type: "text",
            text:
              calls.length === 1
                ? '{"title":"Intro call"'
                : JSON.stringify({
                    title: "Intro call",
                    start: "2026-06-02T14:00:00-04:00",
                    end: "2026-06-02T14:30:00-04:00",
                    timezone: "America/New_York",
                    guests: ["alex@example.com"],
                    conference: { type: "googleMeet" },
                    location: "",
                    description: "",
                    calendarId: "primary",
                    confidence: 0.82,
                    warnings: [],
                  }),
          },
        ],
        model: "kimi-k2.6:cloud",
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: {
          input_tokens: 200,
          output_tokens: calls.length === 1 ? getCalendarInviteExtractionMaxTokens() : 180,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      };
    };

    const draft = await extractCalendarInviteDraftWithProvider(
      emails,
      writableCalendars,
      { provider: "ollama-cloud", model: "kimi-k2.6:cloud" },
      "America/New_York",
      { emailId: "email-scheduling", accountId: "default" },
      sendMessage,
    );

    expect(draft.title).toBe("Intro call");
    expect(draft.guests).toEqual(["alex@example.com"]);
    expect(calls).toEqual([
      {
        maxTokens: getCalendarInviteExtractionMaxTokens(),
        provider: "ollama-cloud",
        think: false,
      },
      {
        maxTokens: 4096,
        provider: "ollama-cloud",
        think: false,
      },
    ]);
  });

  test("uses selected calendar timezone before primary calendar and local fallback", () => {
    expect(chooseCalendarTimezone(writableCalendars, "team", "America/Los_Angeles")).toBe(
      "America/Chicago",
    );
    expect(chooseCalendarTimezone(writableCalendars, undefined, "America/Los_Angeles")).toBe(
      "America/New_York",
    );
    expect(chooseCalendarTimezone([], undefined, "America/Los_Angeles")).toBe(
      "America/Los_Angeles",
    );
  });

  test("never defaults to a read-only calendar when no writable calendar exists", async () => {
    const emails: DashboardEmail[] = [
      {
        id: "email-readonly",
        accountId: "default",
        threadId: "thread-readonly",
        from: "alex@example.com",
        to: "demo@example.com",
        cc: "",
        subject: "Intro call",
        body: "Tuesday 3pm works.",
        date: "2026-06-01T12:00:00.000Z",
        isUnread: false,
        isStarred: false,
        snippet: "",
        labels: [],
        attachments: [],
      },
    ];
    // Model echoes back whatever default calendarId it was given (empty here).
    const sendMessage: CalendarInviteMessageSender = async () => ({
      id: "msg-readonly",
      type: "message",
      role: "assistant",
      content: [
        {
          type: "text",
          text: JSON.stringify({
            title: "Intro call",
            start: "2026-06-02T15:00:00",
            end: "2026-06-02T15:30:00",
            timezone: "America/New_York",
            guests: ["alex@example.com"],
            conference: { type: "googleMeet" },
            location: "",
            description: "",
            calendarId: "",
            confidence: 0.8,
            warnings: [],
          }),
        },
      ],
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: 100,
        output_tokens: 80,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        server_tool_use: null,
        service_tier: null,
      },
    });

    const draft = await extractCalendarInviteDraftWithProvider(
      emails,
      [
        {
          accountId: "default",
          accountEmail: "demo@example.com",
          calendarId: "shared-readonly",
          calendarName: "Shared (read-only)",
          calendarColor: "#999999",
          timezone: "America/New_York",
          writable: false,
          primary: true,
        },
      ],
      { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      "America/New_York",
      { emailId: "email-readonly", accountId: "default" },
      sendMessage,
    );

    // No writable calendar → no default is chosen; validation will block on it.
    expect(draft.calendarId).toBe("");
  });

  test("validates required fields before final creation", () => {
    const errors = validateCalendarInviteDraft({
      title: "",
      start: "",
      end: "",
      timezone: "America/New_York",
      guests: [],
      conference: { type: "none" },
      location: "",
      description: "",
      calendarId: "",
      confidence: 0,
      warnings: [],
    });

    expect(errors).toEqual([
      "Add a title.",
      "Choose a start time.",
      "Choose an end time.",
      "Add at least one guest.",
      "Choose a calendar.",
    ]);
  });

  test("validates guest email shape before final creation", () => {
    const errors = validateCalendarInviteDraft({
      title: "Partnership coffee chat",
      start: "2026-06-02T14:00:00-04:00",
      end: "2026-06-02T14:30:00-04:00",
      timezone: "America/New_York",
      guests: ["kat@example.com", "not an email"],
      conference: { type: "googleMeet" },
      location: "",
      description: "",
      calendarId: "primary",
      confidence: 0.9,
      warnings: [],
    });

    expect(errors).toEqual(["Fix invalid guest email address: not an email."]);
  });

  test("builds Google Calendar insert params with guest notifications and Meet payload", () => {
    const params = buildCalendarEventInsertParams({
      title: "Partnership coffee chat",
      start: "2026-06-02T14:00:00-04:00",
      end: "2026-06-02T14:30:00-04:00",
      timezone: "America/New_York",
      guests: ["kat@example.com", "alex@example.com"],
      conference: { type: "googleMeet" },
      location: "",
      description: "Discuss partnership opportunity.",
      calendarId: "primary",
      confidence: 0.9,
      warnings: [],
    });

    expect(params.calendarId).toBe("primary");
    expect(params.sendUpdates).toBe("all");
    expect(params.conferenceDataVersion).toBe(1);
    expect(params.requestBody.summary).toBe("Partnership coffee chat");
    expect(params.requestBody.attendees).toEqual([
      { email: "kat@example.com" },
      { email: "alex@example.com" },
    ]);
    expect(params.requestBody.conferenceData?.createRequest?.conferenceSolutionKey?.type).toBe(
      "hangoutsMeet",
    );
  });

  test("derives a stable Meet requestId so retries reuse the same conference", () => {
    const draft = {
      title: "Partnership coffee chat",
      start: "2026-06-02T14:00:00",
      end: "2026-06-02T14:30:00",
      timezone: "America/New_York",
      guests: ["kat@example.com", "alex@example.com"],
      conference: { type: "googleMeet" as const },
      location: "",
      description: "Discuss partnership opportunity.",
      calendarId: "primary",
      confidence: 0.9,
      warnings: [],
    };

    const first = buildCalendarEventInsertParams(draft);
    const second = buildCalendarEventInsertParams(draft);
    const firstId = first.requestBody.conferenceData?.createRequest?.requestId;
    const secondId = second.requestBody.conferenceData?.createRequest?.requestId;

    expect(firstId).toBeTruthy();
    expect(firstId).toBe(secondId);
    // A materially different event must not collide with the same id.
    const other = buildCalendarEventInsertParams({ ...draft, start: "2026-06-03T14:00:00" });
    expect(other.requestBody.conferenceData?.createRequest?.requestId).not.toBe(firstId);
  });

  test("preserves external conference links instead of requesting Google Meet", () => {
    const params = buildCalendarEventInsertParams({
      title: "Zoom intro",
      start: "2026-06-02T14:00:00-04:00",
      end: "2026-06-02T14:30:00-04:00",
      timezone: "America/New_York",
      guests: ["kat@example.com"],
      conference: { type: "link", value: "https://zoom.us/j/123" },
      location: "",
      description: "Discuss partnership opportunity.",
      calendarId: "primary",
      confidence: 0.9,
      warnings: [],
    });

    expect(params.conferenceDataVersion).toBeUndefined();
    expect(params.requestBody.conferenceData).toBeUndefined();
    expect(params.requestBody.description).toContain("https://zoom.us/j/123");
  });
});
