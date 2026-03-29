/**
 * Realistic Gmail API response fixtures for testing GmailClient.
 * These match the actual Google Gmail API v1 response format.
 */

// A message in Gmail API format (messages.get with format=full)
export function makeGmailMessage(opts: {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  date?: string;
  labelIds?: string[];
  cc?: string;
  snippet?: string;
  internalDate?: string;
}): GmailApiMessage {
  const date = opts.date || "Mon, 6 Jan 2025 15:45:00 -0800";
  const headers = [
    { name: "From", value: opts.from },
    { name: "To", value: opts.to },
    { name: "Subject", value: opts.subject },
    { name: "Date", value: date },
    { name: "Message-ID", value: `<${opts.id}@mail.gmail.com>` },
  ];
  if (opts.cc) {
    headers.push({ name: "Cc", value: opts.cc });
  }

  return {
    id: opts.id,
    threadId: opts.threadId,
    labelIds: opts.labelIds || ["INBOX", "UNREAD"],
    snippet: opts.snippet || opts.body.substring(0, 100),
    internalDate: opts.internalDate || String(new Date(date).getTime()),
    payload: {
      mimeType: "text/html",
      headers,
      body: {
        size: opts.body.length,
        data: Buffer.from(opts.body).toString("base64url"),
      },
      parts: [],
    },
    sizeEstimate: opts.body.length + 500,
    historyId: "12345",
  };
}

export interface GmailApiMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  internalDate: string;
  payload: {
    mimeType: string;
    headers: Array<{ name: string; value: string }>;
    body: { size: number; data?: string };
    parts: unknown[];
  };
  sizeEstimate: number;
  historyId: string;
}

// Messages.list response
export interface GmailApiListResponse {
  messages: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate: number;
}

// History.list response
export interface GmailApiHistoryResponse {
  history?: Array<{
    id: string;
    messages?: Array<{ id: string; threadId: string }>;
    messagesAdded?: Array<{ message: { id: string; threadId: string; labelIds: string[] } }>;
    messagesDeleted?: Array<{ message: { id: string; threadId: string } }>;
    labelsAdded?: Array<{ message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }>;
    labelsRemoved?: Array<{ message: { id: string; threadId: string; labelIds: string[] }; labelIds: string[] }>;
  }>;
  historyId: string;
  nextPageToken?: string;
}

// Draft response
export interface GmailApiDraft {
  id: string;
  message: {
    id: string;
    threadId: string;
    labelIds: string[];
  };
}

// Profile response
export interface GmailApiProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

// ----- Premade fixtures -----

export const FIXTURE_MESSAGES = [
  makeGmailMessage({
    id: "msg-001",
    threadId: "thread-001",
    from: "Sarah Johnson <sarah@example.com>",
    to: "user@example.com",
    subject: "Project Status Update Request",
    body: "<div>Hi, could you send me a status update on the Q1 project? Need it by Friday. Thanks!</div>",
    labelIds: ["INBOX", "UNREAD"],
  }),
  makeGmailMessage({
    id: "msg-002",
    threadId: "thread-002",
    from: "GitHub <notifications@github.com>",
    to: "user@example.com",
    subject: "[repo/project] Pull request #42 merged",
    body: "<div>Merged #42 into main. CI passed. All checks green.</div>",
    labelIds: ["INBOX", "UNREAD"],
  }),
  makeGmailMessage({
    id: "msg-003",
    threadId: "thread-003",
    from: "Tech Weekly <newsletter@techweekly.com>",
    to: "user@example.com",
    subject: "This Week in AI: Top Stories",
    body: "<div>Welcome to your weekly tech roundup...</div>",
    labelIds: ["INBOX", "UNREAD"],
  }),
];

export const FIXTURE_PROFILE: GmailApiProfile = {
  emailAddress: "user@example.com",
  messagesTotal: 15000,
  threadsTotal: 8000,
  historyId: "99999",
};

export const FIXTURE_LIST_RESPONSE: GmailApiListResponse = {
  messages: FIXTURE_MESSAGES.map((m) => ({ id: m.id, threadId: m.threadId })),
  resultSizeEstimate: FIXTURE_MESSAGES.length,
};

export const FIXTURE_HISTORY_RESPONSE: GmailApiHistoryResponse = {
  history: [
    {
      id: "100000",
      messagesAdded: [
        {
          message: {
            id: "msg-new-001",
            threadId: "thread-new-001",
            labelIds: ["INBOX", "UNREAD"],
          },
        },
      ],
    },
  ],
  historyId: "100001",
};
