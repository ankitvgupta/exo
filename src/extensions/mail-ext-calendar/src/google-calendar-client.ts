/**
 * Google Calendar API client.
 * Reuses OAuth2 credentials from the mail client's Gmail auth.
 */
import { google, type calendar_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { readFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { app } from "electron";
import { getDataDir } from "../../../main/data-dir";

export interface CalendarEvent {
  id: string;
  summary: string;
  start: string; // ISO datetime
  end: string; // ISO datetime
  isAllDay: boolean;
  calendarName: string;
  calendarColor: string;
  status: "confirmed" | "tentative" | "cancelled";
  location?: string;
  htmlLink?: string;
}

export interface CalendarInfo {
  id: string;
  name: string;
  color: string;
}

/** Result of an incremental or full sync for a single calendar. */
export interface SyncResult {
  events: CalendarEvent[];
  deletedIds: string[];
  nextSyncToken: string | null;
  /** True when API returned 410 GONE — caller should do a full re-sync. */
  fullSyncRequired: boolean;
}

// Lazy — app.getPath() throws if called before Electron is initialized (e.g. in unit tests).
// getDataDir() is itself lazy (defers app.getPath() to call time), so this is safe.
function getConfigDir(): string {
  return getDataDir();
}

// Bundled OAuth credentials — same build-time injection as gmail-client.ts.
// Fallback when credentials.json doesn't exist on disk (e.g. packaged app).
const _clientId = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_ID ?? "";
const _clientSecret = import.meta.env.MAIN_VITE_GOOGLE_CLIENT_SECRET ?? "";
const BUNDLED_CREDENTIALS =
  _clientId && _clientSecret
    ? { client_id: _clientId, client_secret: _clientSecret }
    : null;

function getTokensFile(accountId: string): string {
  if (accountId === "default") {
    return join(getConfigDir(), "tokens.json");
  }
  return join(getConfigDir(), `tokens-${accountId}.json`);
}

async function getOAuth2Client(accountId: string): Promise<OAuth2Client | null> {
  try {
    let client_id: string;
    let client_secret: string;

    const credentialsPath = join(getConfigDir(), "credentials.json");
    if (existsSync(credentialsPath)) {
      const credRaw = await readFile(credentialsPath, "utf-8");
      const credentials = JSON.parse(credRaw);
      // Handle nested 'installed'/'web' format (same as gmail-client.ts)
      const source = credentials.installed ?? credentials.web ?? credentials;
      client_id = source.client_id;
      client_secret = source.client_secret;
    } else if (BUNDLED_CREDENTIALS) {
      client_id = BUNDLED_CREDENTIALS.client_id;
      client_secret = BUNDLED_CREDENTIALS.client_secret;
    } else {
      return null;
    }

    const tokensPath = getTokensFile(accountId);
    if (!existsSync(tokensPath)) return null;

    const tokenRaw = await readFile(tokensPath, "utf-8");
    const tokens = JSON.parse(tokenRaw);

    const oauth2 = new OAuth2Client(client_id, client_secret);
    oauth2.setCredentials(tokens);
    return oauth2;
  } catch (error) {
    console.error("[Calendar] Failed to get OAuth2 client:", error);
    return null;
  }
}

/**
 * Check if the current tokens include calendar scope.
 */
export async function hasCalendarScope(accountId: string): Promise<boolean> {
  const auth = await getOAuth2Client(accountId);
  if (!auth) return false;
  const scopes = auth.credentials.scope || "";
  return scopes.includes("calendar.readonly") || scopes.includes("calendar");
}

/**
 * Find ALL accounts that have calendar scope.
 * Scans all token files and returns every account ID with calendar access.
 */
let cachedCalendarAccountIds: string[] | undefined;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60_000; // 5 minutes

/** Clear the account-discovery cache so the next sync picks up new accounts. */
export function invalidateCalendarAccountCache(): void {
  cachedCalendarAccountIds = undefined;
  cacheTimestamp = 0;
}

export async function findAllCalendarAccounts(): Promise<string[]> {
  if (cachedCalendarAccountIds !== undefined && Date.now() - cacheTimestamp < CACHE_TTL) {
    return cachedCalendarAccountIds;
  }

  const result: string[] = [];

  // Check default account first
  if (await hasCalendarScope("default")) {
    result.push("default");
  }

  // Scan for other token files
  try {
    const files = await readdir(getConfigDir());
    for (const file of files) {
      const match = file.match(/^tokens-(.+)\.json$/);
      if (match) {
        const accountId = match[1];
        if (await hasCalendarScope(accountId)) {
          result.push(accountId);
        }
      }
    }
  } catch {
    // Config dir doesn't exist
  }

  cachedCalendarAccountIds = result;
  cacheTimestamp = Date.now();
  return result;
}

/**
 * Find any account that has calendar scope (backwards-compatible).
 */
export async function findCalendarAccount(): Promise<string | null> {
  const accounts = await findAllCalendarAccounts();
  return accounts.length > 0 ? accounts[0] : null;
}

/**
 * Get list of calendars (id, name, color) for an account.
 */
export async function getCalendarList(accountId: string): Promise<CalendarInfo[]> {
  const auth = await getOAuth2Client(accountId);
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });
  const response = await calendar.calendarList.list();
  const result: CalendarInfo[] = [];
  for (const cal of response.data.items || []) {
    if (cal.id) {
      result.push({
        id: cal.id,
        name: cal.summary || "Calendar",
        color: cal.backgroundColor || "#4285f4",
      });
    }
  }
  return result;
}

/**
 * Sync calendar events using Google's sync token mechanism.
 *
 * - If syncToken is provided, does an incremental sync.
 * - If syncToken is null, does a full sync for the given time range.
 * - Returns fullSyncRequired=true on 410 GONE (caller must clear and re-sync).
 */
export async function syncCalendarEvents(
  accountId: string,
  calendarId: string,
  calendarName: string,
  calendarColor: string,
  syncToken: string | null
): Promise<SyncResult> {
  const auth = await getOAuth2Client(accountId);
  if (!auth) {
    return { events: [], deletedIds: [], nextSyncToken: null, fullSyncRequired: false };
  }

  const calendar = google.calendar({ version: "v3", auth });
  const events: CalendarEvent[] = [];
  const deletedIds: string[] = [];
  let pageToken: string | undefined;
  let nextSyncToken: string | null = null;

  try {
    do {
      const params: calendar_v3.Params$Resource$Events$List = {
        calendarId,
        maxResults: 250,
        singleEvents: true,
        pageToken,
      };

      if (syncToken) {
        // Incremental sync
        params.syncToken = syncToken;
      } else {
        // Full sync: fetch ±2 months
        const now = new Date();
        const timeMin = new Date(now.getFullYear(), now.getMonth() - 2, 1);
        const timeMax = new Date(now.getFullYear(), now.getMonth() + 3, 0);
        params.timeMin = timeMin.toISOString();
        params.timeMax = timeMax.toISOString();
        params.orderBy = "startTime";
      }

      const response = await calendar.events.list(params);

      for (const item of response.data.items || []) {
        if (item.status === "cancelled") {
          if (item.id) deletedIds.push(item.id);
          continue;
        }
        const event = parseCalendarEvent(item, { name: calendarName, color: calendarColor });
        if (event) events.push(event);
      }

      pageToken = response.data.nextPageToken || undefined;
      if (response.data.nextSyncToken) {
        nextSyncToken = response.data.nextSyncToken;
      }
    } while (pageToken);

    return { events, deletedIds, nextSyncToken, fullSyncRequired: false };
  } catch (error: unknown) {
    // 410 GONE means sync token is invalid — need full re-sync
    const statusCode = (error as { code?: number })?.code;
    if (statusCode === 410) {
      console.log(`[Calendar] Sync token expired for ${calendarName} (410 GONE), full re-sync needed`);
      return { events: [], deletedIds: [], nextSyncToken: null, fullSyncRequired: true };
    }
    throw error;
  }
}

/**
 * Fetch calendar events for a specific date.
 * Returns events from all visible calendars.
 * (Kept for potential fallback usage)
 */
export async function getEventsForDate(
  accountId: string,
  dateStr: string
): Promise<CalendarEvent[]> {
  const auth = await getOAuth2Client(accountId);
  if (!auth) return [];

  const calendar = google.calendar({ version: "v3", auth });

  // Fix: use explicit date component construction to avoid timezone issues
  const [year, month, day] = dateStr.split("-").map(Number);
  const startOfDay = new Date(year, month - 1, day, 0, 0, 0);
  const endOfDay = new Date(year, month - 1, day, 23, 59, 59, 999);

  try {
    // Get list of calendars for color/name info
    const calendarList = await calendar.calendarList.list();
    const calendarsById = new Map<string, { name: string; color: string }>();
    for (const cal of calendarList.data.items || []) {
      if (cal.id) {
        calendarsById.set(cal.id, {
          name: cal.summary || "Calendar",
          color: cal.backgroundColor || "#4285f4",
        });
      }
    }

    // Fetch events from all calendars in parallel
    const calendarIds = Array.from(calendarsById.keys());
    const responses = await Promise.all(
      calendarIds.map(async (calId) => {
        const calInfo = calendarsById.get(calId)!;
        try {
          const response = await calendar.events.list({
            calendarId: calId,
            timeMin: startOfDay.toISOString(),
            timeMax: endOfDay.toISOString(),
            singleEvents: true,
            orderBy: "startTime",
            maxResults: 50,
          });
          const events: CalendarEvent[] = [];
          for (const item of response.data.items || []) {
            const event = parseCalendarEvent(item, calInfo);
            if (event) events.push(event);
          }
          return events;
        } catch (error) {
          console.error(`[Calendar] Failed to fetch events from ${calInfo.name}:`, error);
          return [];
        }
      })
    );

    // Merge, deduplicate by event ID, sort by start time
    const seen = new Set<string>();
    const events: CalendarEvent[] = [];
    for (const calEvents of responses) {
      for (const event of calEvents) {
        if (!seen.has(event.id)) {
          seen.add(event.id);
          events.push(event);
        }
      }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));

    return events;
  } catch (error) {
    console.error("[Calendar] Failed to fetch events:", error);
    return [];
  }
}

function parseCalendarEvent(
  item: calendar_v3.Schema$Event,
  calInfo: { name: string; color: string }
): CalendarEvent | null {
  if (!item.id) return null;

  const isAllDay = !!item.start?.date;
  const start = item.start?.dateTime || item.start?.date || "";
  const end = item.end?.dateTime || item.end?.date || "";

  return {
    id: item.id,
    summary: item.summary || "(No title)",
    start,
    end,
    isAllDay,
    calendarName: calInfo.name,
    calendarColor: calInfo.color,
    status: (item.status as "confirmed" | "tentative" | "cancelled") || "confirmed",
    location: item.location || undefined,
    htmlLink: item.htmlLink || undefined,
  };
}
