import { DEFAULT_TIME_ZONE, WINDOW_DAYS } from "./availability.ts";

const formatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DEFAULT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

function localAsUtc(timestamp: number): number {
  const parts = new Map(formatter.formatToParts(timestamp).map((part) => [part.type, Number(part.value)]));
  return Date.UTC(parts.get("year")!, parts.get("month")! - 1, parts.get("day")!,
    parts.get("hour")!, parts.get("minute")!, parts.get("second")!);
}

function resolveLocalWallClock(localTimestamp: number): number {
  let candidate = localTimestamp;
  for (let attempt = 0; attempt < 4; attempt++) {
    const correction = localTimestamp - localAsUtc(candidate);
    if (correction === 0) return candidate;
    candidate += correction;
  }
  throw new RangeError("Could not resolve the public calendar boundary");
}

/** The public history boundary is Sunday midnight in the owner's timezone. */
export function startOfCurrentWeek(nowMs: number): number {
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid calendar time");

  const date = new Date(localAsUtc(nowMs));
  const sunday = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - date.getUTCDay());
  return resolveLocalWallClock(sunday);
}

export function availabilityWindow(nowMs: number): { startMs: number; endMs: number } {
  if (!Number.isFinite(nowMs)) throw new RangeError("Invalid calendar time");

  const lastIncludedDate = new Date(localAsUtc(nowMs));
  lastIncludedDate.setUTCDate(lastIncludedDate.getUTCDate() + WINDOW_DAYS - 1);
  const nextSunday = Date.UTC(
    lastIncludedDate.getUTCFullYear(),
    lastIncludedDate.getUTCMonth(),
    lastIncludedDate.getUTCDate() + 7 - lastIncludedDate.getUTCDay(),
  );
  return {
    startMs: startOfCurrentWeek(nowMs),
    endMs: resolveLocalWallClock(nextSunday),
  };
}
