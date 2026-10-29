import {
  STALE_AFTER_MS,
  UNAVAILABLE_AFTER_MS,
  type Availability,
  type BusyInterval,
} from "../shared/availability.ts";
import { availabilityWindow, startOfCurrentWeek } from "../shared/window.ts";

const RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface StoredSnapshot {
  status: Availability["status"];
  windowStart: string | null;
  windowEnd: string | null;
  updatedAt: string | null;
  lastAttemptAt: string | null;
  busyJson: string;
}

export interface SnapshotToSave {
  attemptAt: string;
  windowStart: string;
  windowEnd: string;
  updatedAt: string;
  busy: BusyInterval[];
}

export function parseRfc3339(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  if (zone !== "Z") {
    const offsetMatch = /^[+-](\d{2}):(\d{2})$/.exec(zone);
    if (!offsetMatch || Number(offsetMatch[1]) > 23 || Number(offsetMatch[2]) > 59) return null;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function mergeBusyIntervals(
  intervals: readonly BusyInterval[],
  windowStartMs: number,
  windowEndMs: number,
): BusyInterval[] {
  const clipped: Array<{ start: number; end: number }> = [];

  for (const interval of intervals) {
    const start = parseRfc3339(interval.start);
    const end = parseRfc3339(interval.end);
    if (start === null || end === null || start >= end) {
      throw new Error("Invalid busy interval");
    }

    const clippedStart = Math.max(start, windowStartMs);
    const clippedEnd = Math.min(end, windowEndMs);
    if (clippedStart < clippedEnd) clipped.push({ start: clippedStart, end: clippedEnd });
  }

  clipped.sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const current of clipped) {
    const previous = merged.at(-1);
    if (previous && current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
    } else {
      merged.push({ ...current });
    }
  }

  return merged.map(({ start, end }) => ({
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
  }));
}

function parseBusyJson(value: string, startMs: number, endMs: number): BusyInterval[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const intervals: BusyInterval[] = [];
  for (const item of parsed) {
    if (!isRecord(item) || typeof item.start !== "string" || typeof item.end !== "string") {
      return null;
    }
    intervals.push({ start: item.start, end: item.end });
  }

  try {
    return mergeBusyIntervals(intervals, startMs, endMs);
  } catch {
    return null;
  }
}

export function unavailableAvailability(nowMs: number): Availability {
  const { startMs, endMs } = availabilityWindow(nowMs);
  return {
    status: "unavailable",
    windowStart: new Date(startMs).toISOString(),
    windowEnd: new Date(endMs).toISOString(),
    updatedAt: null,
    busy: [],
  };
}

export function makeAvailability(stored: StoredSnapshot | null, nowMs: number): Availability {
  const unavailable = unavailableAvailability(nowMs);
  if (
    !stored ||
    !["fresh", "stale", "unavailable"].includes(stored.status) ||
    stored.updatedAt === null ||
    stored.windowStart === null ||
    stored.windowEnd === null
  ) {
    return unavailable;
  }

  const updatedAtMs = parseRfc3339(stored.updatedAt);
  const storedStartMs = parseRfc3339(stored.windowStart);
  const storedEndMs = parseRfc3339(stored.windowEnd);
  const expectedWindow = updatedAtMs === null ? null : availabilityWindow(updatedAtMs);
  if (
    updatedAtMs === null ||
    storedStartMs === null ||
    storedEndMs === null ||
    expectedWindow === null ||
    storedStartMs !== expectedWindow.startMs ||
    storedEndMs !== expectedWindow.endMs ||
    updatedAtMs > nowMs
  ) {
    return unavailable;
  }

  const ageMs = nowMs - updatedAtMs;
  let status: Availability["status"] = "fresh";
  if (ageMs >= UNAVAILABLE_AFTER_MS || stored.status === "unavailable") {
    return unavailable;
  } else if (ageMs >= STALE_AFTER_MS || stored.status === "stale") {
    status = "stale";
  }

  const parsedBusy = parseBusyJson(stored.busyJson, storedStartMs, storedEndMs);
  if (parsedBusy === null) return unavailable;

  const outputStartMs = Math.max(startOfCurrentWeek(nowMs), storedStartMs);
  const busy = mergeBusyIntervals(parsedBusy, outputStartMs, storedEndMs);

  return {
    status,
    windowStart: new Date(outputStartMs).toISOString(),
    windowEnd: new Date(storedEndMs).toISOString(),
    updatedAt: new Date(updatedAtMs).toISOString(),
    busy,
  };
}
