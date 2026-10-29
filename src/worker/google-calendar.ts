import type { BusyInterval } from "../shared/availability.ts";
import { mergeBusyIntervals, parseRfc3339 } from "./model.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const FREEBUSY_URL = "https://www.googleapis.com/calendar/v3/freeBusy";
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_CALENDAR_PAGES = 100;
const MAX_PARALLEL_FREEBUSY_REQUESTS = 4;
const MAX_REFRESH_DURATION_MS = 10 * 60 * 1000;

export interface GoogleCredentials {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

interface RefreshOptions {
  fetcher?: typeof fetch;
  budgetMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonBounded(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const advertisedBytes = Number(contentLength);
    if (Number.isFinite(advertisedBytes) && advertisedBytes > maxBytes) {
      await response.body?.cancel();
      throw new Error("Google response exceeded size limit");
    }
  }

  if (!response.body) throw new Error("Google response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteCount = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maxBytes) {
        await reader.cancel();
        throw new Error("Google response exceeded size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

async function fetchJson(
  url: string | URL,
  init: RequestInit,
  fetcher: typeof fetch,
  deadlineAt: number,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<unknown> {
  const remainingMs = Math.floor(deadlineAt - performance.now());
  const timeoutMs = Math.min(REQUEST_TIMEOUT_MS, remainingMs);
  if (timeoutMs <= 0) throw new Error("Google refresh time budget exhausted");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      try {
        await response.body?.cancel();
      } catch {
        // The response body is intentionally discarded on HTTP errors.
      }
      throw new Error("Google request failed");
    }
    return await readJsonBounded(response, maxBytes);
  } catch {
    throw new Error("Google request failed");
  } finally {
    clearTimeout(timeout);
  }
}

function requireCredentials(credentials: GoogleCredentials): {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
} {
  const { clientId, clientSecret, refreshToken } = credentials;
  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    typeof clientSecret !== "string" ||
    clientSecret.length === 0 ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0
  ) {
    throw new Error("Google credentials are not configured");
  }
  return { clientId, clientSecret, refreshToken };
}

async function refreshAccessToken(
  credentials: GoogleCredentials,
  fetcher: typeof fetch,
  deadlineAt: number,
): Promise<string> {
  const validCredentials = requireCredentials(credentials);
  const body = new URLSearchParams({
    client_id: validCredentials.clientId,
    client_secret: validCredentials.clientSecret,
    refresh_token: validCredentials.refreshToken,
    grant_type: "refresh_token",
  });
  const payload = await fetchJson(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    },
    fetcher,
    deadlineAt,
    32_768,
  );

  if (
    !isRecord(payload) ||
    typeof payload.access_token !== "string" ||
    payload.access_token.length === 0 ||
    payload.access_token.length > 8192 ||
    typeof payload.token_type !== "string" ||
    payload.token_type.toLowerCase() !== "bearer" ||
    typeof payload.expires_in !== "number" ||
    !Number.isInteger(payload.expires_in) ||
    payload.expires_in <= 0
  ) {
    throw new Error("Google token response was invalid");
  }
  return payload.access_token;
}

function calendarIdListPage(payload: unknown): {
  ownedIds: string[];
  nextPageToken: string | null;
} {
  if (!isRecord(payload) || !Array.isArray(payload.items)) {
    throw new Error("Google calendar list response was invalid");
  }

  const ownedIds: string[] = [];
  for (const item of payload.items) {
    if (!isRecord(item) || typeof item.id !== "string" || item.id.length === 0) {
      throw new Error("Google calendar list entry was invalid");
    }
    if (
      item.accessRole !== "owner" &&
      item.accessRole !== "writer" &&
      item.accessRole !== "writerWithoutPrivateAccess" &&
      item.accessRole !== "reader" &&
      item.accessRole !== "freeBusyReader"
    ) {
      throw new Error("Google calendar access role was invalid");
    }
    if (item.accessRole === "owner") ownedIds.push(item.id);
  }

  let nextPageToken: string | null = null;
  if (Object.hasOwn(payload, "nextPageToken")) {
    if (
      typeof payload.nextPageToken !== "string" ||
      payload.nextPageToken.length === 0 ||
      payload.nextPageToken.length > 4096
    ) {
      throw new Error("Google calendar pagination token was invalid");
    }
    nextPageToken = payload.nextPageToken;
  }

  return { ownedIds, nextPageToken };
}

async function listOwnedCalendars(
  accessToken: string,
  fetcher: typeof fetch,
  deadlineAt: number,
): Promise<string[]> {
  const ids = new Set<string>();
  const seenPageTokens = new Set<string>();
  let pageToken: string | null = null;

  for (let page = 0; page < MAX_CALENDAR_PAGES; page += 1) {
    const url = new URL(CALENDAR_LIST_URL);
    url.searchParams.set("maxResults", "250");
    url.searchParams.set("showHidden", "true");
    url.searchParams.set("fields", "items(id,accessRole),nextPageToken");
    if (pageToken !== null) url.searchParams.set("pageToken", pageToken);

    const payload = await fetchJson(
      url,
      { headers: { authorization: `Bearer ${accessToken}` } },
      fetcher,
      deadlineAt,
    );
    const result = calendarIdListPage(payload);
    for (const id of result.ownedIds) ids.add(id);
    if (result.nextPageToken === null) return [...ids];
    if (seenPageTokens.has(result.nextPageToken)) {
      throw new Error("Google calendar pagination loop detected");
    }
    seenPageTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }

  throw new Error("Google calendar list exceeded page limit");
}

function parseFreeBusyPage(
  payload: unknown,
  requestedIds: readonly string[],
  windowStartMs: number,
  windowEndMs: number,
): BusyInterval[] {
  if (!isRecord(payload) || !isRecord(payload.calendars)) {
    throw new Error("Google freebusy response was invalid");
  }

  const responseStartMs = parseRfc3339(payload.timeMin);
  const responseEndMs = parseRfc3339(payload.timeMax);
  if (responseStartMs !== windowStartMs || responseEndMs !== windowEndMs) {
    throw new Error("Google freebusy range did not match request");
  }

  const intervals: BusyInterval[] = [];
  for (const id of requestedIds) {
    if (!Object.hasOwn(payload.calendars, id)) {
      throw new Error("Google freebusy response omitted a calendar");
    }
    const calendar = payload.calendars[id];
    if (!isRecord(calendar)) throw new Error("Google freebusy calendar response was invalid");

    if (Object.hasOwn(calendar, "errors")) {
      if (!Array.isArray(calendar.errors) || calendar.errors.length > 0) {
        throw new Error("Google freebusy calendar returned errors");
      }
    }

    if (calendar.busy === undefined) continue;
    if (!Array.isArray(calendar.busy)) throw new Error("Google freebusy intervals were invalid");
    for (const interval of calendar.busy) {
      if (
        !isRecord(interval) ||
        typeof interval.start !== "string" ||
        typeof interval.end !== "string"
      ) {
        throw new Error("Google freebusy interval was invalid");
      }
      const start = parseRfc3339(interval.start);
      const end = parseRfc3339(interval.end);
      if (start === null || end === null || start >= end) {
        throw new Error("Google freebusy interval was invalid");
      }
      intervals.push({ start: interval.start, end: interval.end });
    }
  }
  return intervals;
}

async function queryFreeBusyBatch(
  accessToken: string,
  ids: readonly string[],
  windowStart: string,
  windowEnd: string,
  windowStartMs: number,
  windowEndMs: number,
  fetcher: typeof fetch,
  deadlineAt: number,
): Promise<BusyInterval[]> {
  if (ids.length < 1 || ids.length > 50) throw new Error("Invalid freebusy batch size");
  const payload = await fetchJson(
    FREEBUSY_URL,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        timeMin: windowStart,
        timeMax: windowEnd,
        timeZone: "UTC",
        calendarExpansionMax: 50,
        items: ids.map((id) => ({ id })),
      }),
    },
    fetcher,
    deadlineAt,
  );
  return parseFreeBusyPage(payload, ids, windowStartMs, windowEndMs);
}

function chunks(values: readonly string[], size: number): string[][] {
  const output: string[][] = [];
  for (let index = 0; index < values.length; index += size) {
    output.push(values.slice(index, index + size));
  }
  return output;
}

async function readAllBusyIntervals(
  accessToken: string,
  ids: readonly string[],
  windowStart: string,
  windowEnd: string,
  fetcher: typeof fetch,
  deadlineAt: number,
): Promise<BusyInterval[]> {
  const windowStartMs = parseRfc3339(windowStart);
  const windowEndMs = parseRfc3339(windowEnd);
  if (windowStartMs === null || windowEndMs === null || windowStartMs >= windowEndMs) {
    throw new Error("Invalid freebusy window");
  }

  const batches = chunks(ids, 50);
  const results: BusyInterval[][] = new Array(batches.length);
  let nextBatch = 0;
  let failed = false;

  const worker = async (): Promise<void> => {
    while (!failed) {
      const batchIndex = nextBatch;
      nextBatch += 1;
      if (batchIndex >= batches.length) return;
      try {
        results[batchIndex] = await queryFreeBusyBatch(
          accessToken,
          batches[batchIndex],
          windowStart,
          windowEnd,
          windowStartMs,
          windowEndMs,
          fetcher,
          deadlineAt,
        );
      } catch {
        failed = true;
      }
    }
  };

  const workerCount = Math.min(MAX_PARALLEL_FREEBUSY_REQUESTS, batches.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (failed) throw new Error("Google freebusy request failed");
  return results.flat();
}

export async function fetchGoogleBusyIntervals(
  credentials: GoogleCredentials,
  windowStart: string,
  windowEnd: string,
  options: RefreshOptions = {},
): Promise<BusyInterval[]> {
  const fetcher = options.fetcher ?? fetch;
  const deadlineAt = performance.now() + (options.budgetMs ?? MAX_REFRESH_DURATION_MS);
  const accessToken = await refreshAccessToken(credentials, fetcher, deadlineAt);
  const calendarIds = await listOwnedCalendars(accessToken, fetcher, deadlineAt);
  if (calendarIds.length === 0) throw new Error("No owned calendars were found");
  const intervals = await readAllBusyIntervals(
    accessToken,
    calendarIds,
    windowStart,
    windowEnd,
    fetcher,
    deadlineAt,
  );
  const startMs = parseRfc3339(windowStart);
  const endMs = parseRfc3339(windowEnd);
  if (startMs === null || endMs === null) throw new Error("Invalid refresh window");
  return mergeBusyIntervals(intervals, startMs, endMs);
}
