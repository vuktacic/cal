import { STALE_AFTER_MS, UNAVAILABLE_AFTER_MS } from "../src/shared/availability.ts";

export type CalendarInterval = {
  start: string;
  end: string;
};

export type DaySegment = {
  start: string;
  end: string;
};

export type DaySegments = Map<string, DaySegment[]>;
export type AvailabilityFreshness = "fresh" | "stale" | "unavailable";
export type WeekDateState = "past" | "uncovered" | "available" | "outside";

export type WeekDate = {
  date: string;
  state: WeekDateState;
};

export type TimeGridMark = {
  topMinutes: number;
  label: string;
};

export type TimeGridBlock = {
  topMinutes: number;
  heightMinutes: number;
  sourceIntervals: CalendarInterval[];
};

export type DayTimeGrid = {
  date: string;
  durationMinutes: number;
  blocks: TimeGridBlock[];
};

const timestampPattern =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/;
const dateKeyFormatters = new Map<string, Intl.DateTimeFormat>();
const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
const wallTimeFormatters = new Map<string, Intl.DateTimeFormat>();
const dayStartCache = new Map<string, number>();

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const match = timestampPattern.exec(value);
  if (!match) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , offset] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();

  if (
    year < 1970 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return null;
  }

  if (offset !== "Z" && Number(offset.slice(1, 3)) === 14 && Number(offset.slice(4, 6)) !== 0) {
    return null;
  }

  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Accept only the public availability contract. Extra fields are rejected so
 * event metadata can never accidentally drift into the rendered calendar.
 */
export function validateAvailabilityPayload(
  value: unknown,
  httpStatus: number,
): value is {
  status: "fresh" | "stale" | "unavailable";
  windowStart: string;
  windowEnd: string;
  updatedAt: string | null;
  busy: CalendarInterval[];
} {
  if (!isRecord(value) || !hasExactKeys(value, ["status", "windowStart", "windowEnd", "updatedAt", "busy"])) {
    return false;
  }

  const { status, windowStart, windowEnd, updatedAt, busy } = value;
  if (status !== "fresh" && status !== "stale" && status !== "unavailable") return false;
  if ((status === "unavailable" && httpStatus !== 503) || (status !== "unavailable" && httpStatus !== 200)) {
    return false;
  }

  const start = parseTimestamp(windowStart);
  const end = parseTimestamp(windowEnd);
  const updated = updatedAt === null ? null : parseTimestamp(updatedAt);
  if (start === null || end === null || end <= start || !Array.isArray(busy)) return false;
  if (updatedAt !== null && updated === null) return false;
  if (status !== "unavailable" && updated === null) return false;

  for (const interval of busy) {
    if (!isRecord(interval) || !hasExactKeys(interval, ["start", "end"])) return false;
    const intervalStart = parseTimestamp(interval.start);
    const intervalEnd = parseTimestamp(interval.end);
    if (
      intervalStart === null ||
      intervalEnd === null ||
      intervalEnd <= intervalStart ||
      intervalStart < start ||
      intervalEnd > end
    ) {
      return false;
    }
  }

  return true;
}

export function toDateKey(timestamp: number, timeZone: string): string {
  let formatter = dateKeyFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateKeyFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function addCalendarDays(dateKey: string, amount: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"), String(date.getUTCDate()).padStart(2, "0")].join(
    "-",
  );
}

/**
 * Find the first instant that belongs to a civil date in a timezone. Searching
 * by the formatted date handles DST days that are 23 or 25 hours long without
 * assuming a fixed UTC offset.
 */
export function startOfDateInZone(dateKey: string, timeZone: string): number {
  const cacheKey = `${timeZone}:${dateKey}`;
  const cached = dayStartCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const [year, month, day] = dateKey.split("-").map(Number);
  const approximate = Date.UTC(year, month - 1, day);
  let low = approximate - 48 * 60 * 60 * 1000;
  let high = approximate + 48 * 60 * 60 * 1000;

  if (toDateKey(low, timeZone) >= dateKey || toDateKey(high, timeZone) < dateKey) {
    throw new RangeError(`Cannot find start of ${dateKey} in ${timeZone}`);
  }

  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (toDateKey(middle, timeZone) < dateKey) low = middle;
    else high = middle;
  }

  dayStartCache.set(cacheKey, high);
  return high;
}

export function mergeIntervals(intervals: readonly CalendarInterval[]): CalendarInterval[] {
  const ordered = intervals
    .map((interval) => ({ start: Date.parse(interval.start), end: Date.parse(interval.end) }))
    .filter((interval) => Number.isFinite(interval.start) && Number.isFinite(interval.end) && interval.end > interval.start)
    .sort((left, right) => left.start - right.start);

  const merged: Array<{ start: number; end: number }> = [];
  for (const interval of ordered) {
    const previous = merged.at(-1);
    if (previous && interval.start <= previous.end) {
      previous.end = Math.max(previous.end, interval.end);
    } else {
      merged.push({ ...interval });
    }
  }

  return merged.map(({ start, end }) => ({ start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
}

export function clipIntervalsToStart(
  intervals: readonly CalendarInterval[],
  earliestStart: number,
): CalendarInterval[] {
  const clipped = intervals.flatMap((interval) => {
    const start = Date.parse(interval.start);
    const end = Date.parse(interval.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= earliestStart || end <= start) return [];
    return [{ start: new Date(Math.max(start, earliestStart)).toISOString(), end: new Date(end).toISOString() }];
  });
  return mergeIntervals(clipped);
}

export function splitIntervalsByDate(
  intervals: readonly CalendarInterval[],
  timeZone: string,
): DaySegments {
  const byDate: DaySegments = new Map();

  for (const interval of mergeIntervals(intervals)) {
    const end = Date.parse(interval.end);
    let cursor = Date.parse(interval.start);

    while (cursor < end) {
      const dateKey = toDateKey(cursor, timeZone);
      const nextDate = addCalendarDays(dateKey, 1);
      const nextDateStart = startOfDateInZone(nextDate, timeZone);
      const segmentEnd = Math.min(end, nextDateStart);
      if (segmentEnd <= cursor) break;

      const segments = byDate.get(dateKey) ?? [];
      segments.push({ start: new Date(cursor).toISOString(), end: new Date(segmentEnd).toISOString() });
      byDate.set(dateKey, segments);
      cursor = segmentEnd;
    }
  }

  return byDate;
}

export function startOfWeekSunday(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return addCalendarDays(dateKey, -weekday);
}

export function weekDates(
  weekStart: string,
  currentSunday: string,
  minimum: string,
  maximum: string,
): WeekDate[] {
  return dateRange(weekStart, 7, currentSunday, minimum, maximum);
}

export function dateRange(
  startDate: string,
  dayCount: number,
  currentSunday: string,
  minimum: string,
  maximum: string,
): WeekDate[] {
  return Array.from({ length: Math.max(0, Math.floor(dayCount)) }, (_, index) => {
    const date = addCalendarDays(startDate, index);
    const state: WeekDateState = date < currentSunday
      ? "past"
      : date < minimum
        ? "uncovered"
        : date > maximum
          ? "outside"
          : "available";
    return { date, state };
  });
}

export function clampCompactStart(dateKey: string, minimum: string, maximum: string): string {
  const latestStart = addCalendarDays(maximum, -2);
  const maximumStart = latestStart < minimum ? minimum : latestStart;
  if (dateKey < minimum) return minimum;
  if (dateKey > maximumStart) return maximumStart;
  return dateKey;
}

export function moveCompactStartWithinRange(
  startDate: string,
  direction: -1 | 1,
  minimum: string,
  maximum: string,
): string {
  return clampCompactStart(addCalendarDays(startDate, direction * 3), minimum, maximum);
}

export function moveWeekWithinRange(
  weekStart: string,
  direction: -1 | 1,
  minimum: string,
  maximum: string,
): string {
  const minimumWeek = startOfWeekSunday(minimum);
  const maximumWeek = startOfWeekSunday(maximum);
  const candidate = addCalendarDays(weekStart, direction * 7);
  if (candidate < minimumWeek) return minimumWeek;
  if (candidate > maximumWeek) return maximumWeek;
  return candidate;
}

function wallTimeFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallTimeFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      fractionalSecondDigits: 3,
      hourCycle: "h23",
    });
    wallTimeFormatters.set(timeZone, formatter);
  }
  return formatter;
}

export function wallClockMarks(): TimeGridMark[] {
  return Array.from({ length: 25 }, (_, hour) => ({
    topMinutes: hour * 60,
    label: hour === 24 ? "12 AM" : `${hour % 12 || 12} ${hour < 12 ? "AM" : "PM"}`,
  }));
}

export function formatWallClockTime(minute: number): string {
  const totalMinutes = Math.max(0, Math.min(1440, Math.round(minute)));
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minutes).padStart(2, "0")} ${hour24 < 12 ? "AM" : "PM"}`;
}

function sourceRangesSpanOffsets(block: TimeGridBlock, timeZone: string): boolean {
  const offsets = new Set<number>();
  let spansOffsetChange = false;
  for (const interval of block.sourceIntervals) {
    const startOffset = offsetMinutesAt(Date.parse(interval.start), timeZone);
    const endOffset = offsetMinutesAt(Date.parse(interval.end), timeZone);
    offsets.add(startOffset);
    offsets.add(endOffset);
    if (startOffset !== endOffset) spansOffsetChange = true;
  }
  return spansOffsetChange || (block.sourceIntervals.length > 1 && offsets.size > 1);
}

function formatSourceTimeGridBlockRanges(block: TimeGridBlock, timeZone: string): string {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return block.sourceIntervals
    .map((interval) => `${formatter.format(Date.parse(interval.start))}–${formatter.format(Date.parse(interval.end))}`)
    .join("; ");
}

export function formatTimeGridBlockLabel(block: TimeGridBlock, timeZone: string): string {
  if (sourceRangesSpanOffsets(block, timeZone)) return formatSourceTimeGridBlockRanges(block, timeZone);

  return `${formatWallClockTime(block.topMinutes)}–${formatWallClockTime(block.topMinutes + block.heightMinutes)}`;
}

function compactWallTime(minute: number): { text: string; period: "a" | "p" } {
  const totalMinutes = Math.max(0, Math.min(1440, Math.round(minute)));
  const hour24 = Math.floor(totalMinutes / 60) % 24;
  const minutes = totalMinutes % 60;
  const hour12 = hour24 % 12 || 12;
  return {
    text: `${hour12}${minutes === 0 ? "" : `:${String(minutes).padStart(2, "0")}`}`,
    period: hour24 < 12 ? "a" : "p",
  };
}

export function formatCompactTimeGridBlockLabel(block: TimeGridBlock, timeZone: string): string {
  if (sourceRangesSpanOffsets(block, timeZone)) return formatSourceTimeGridBlockRanges(block, timeZone);

  const start = compactWallTime(block.topMinutes);
  const end = compactWallTime(block.topMinutes + block.heightMinutes);
  return start.period === end.period
    ? `${start.text}–${end.text}${end.period}`
    : `${start.text}${start.period}–${end.text}${end.period}`;
}

export function wallClockMinuteAt(timestamp: number, timeZone: string): number {
  const values = new Map(wallTimeFormatter(timeZone).formatToParts(timestamp).map((part) => [part.type, Number(part.value)]));
  const hour = values.get("hour") ?? 0;
  const minute = values.get("minute") ?? 0;
  const second = values.get("second") ?? 0;
  const millisecond = values.get("fractionalSecond") ?? 0;
  return hour * 60 + minute + second / 60 + millisecond / 60_000;
}

function firstOffsetChange(
  start: number,
  end: number,
  startOffset: number,
  timeZone: string,
): number {
  let low = start;
  let high = end;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (offsetMinutesAt(middle, timeZone) === startOffset) low = middle;
    else high = middle;
  }
  return high;
}

function projectIntervalThroughOffsets(
  interval: CalendarInterval,
  dayStart: number,
  dayEnd: number,
  timeZone: string,
): TimeGridBlock[] {
  const start = Math.max(dayStart, Date.parse(interval.start));
  const end = Math.min(dayEnd, Date.parse(interval.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];

  const pieces: Array<{ start: number; end: number }> = [];
  let pieceStart = start;
  let searchStart = start;
  let pieceOffset = offsetMinutesAt(pieceStart, timeZone);
  const probeIntervalMs = 6 * 60 * 60_000;

  while (searchStart < end - 1) {
    const probe = Math.min(end - 1, searchStart + probeIntervalMs);
    if (offsetMinutesAt(probe, timeZone) === pieceOffset) {
      if (probe === end - 1) break;
      searchStart = probe;
      continue;
    }

    const transition = firstOffsetChange(searchStart, probe, pieceOffset, timeZone);
    if (transition <= pieceStart || transition >= end) break;
    pieces.push({ start: pieceStart, end: transition });
    pieceStart = transition;
    searchStart = transition;
    pieceOffset = offsetMinutesAt(transition, timeZone);
  }
  pieces.push({ start: pieceStart, end });

  const projections: TimeGridBlock[] = [];
  for (const piece of pieces) {
    const topMinutes = Math.round(Math.max(0, Math.min(1440, wallClockMinuteAt(piece.start, timeZone))) * 1_000_000) / 1_000_000;
    const lastInstantBeforeEnd = Math.max(piece.start, piece.end - 1);
    const wallEnd = wallClockMinuteAt(lastInstantBeforeEnd, timeZone) + 1 / 60_000;
    const endMinutes = Math.round(Math.max(0, Math.min(1440, wallEnd)) * 1_000_000) / 1_000_000;
    const heightMinutes = endMinutes - topMinutes;
    if (heightMinutes <= 0) continue;
    projections.push({
      topMinutes,
      heightMinutes,
      sourceIntervals: [{ start: interval.start, end: interval.end }],
    });
  }
  return projections;
}

export function layoutDayTimeGrid(
  intervals: readonly CalendarInterval[],
  dateKey: string,
  timeZone: string,
): DayTimeGrid {
  const dayStart = startOfDateInZone(dateKey, timeZone);
  const dayEnd = startOfDateInZone(addCalendarDays(dateKey, 1), timeZone);
  const durationMinutes = 24 * 60;
  const dayIntervals = splitIntervalsByDate(intervals, timeZone).get(dateKey) ?? [];
  const projected = dayIntervals.flatMap((interval) => projectIntervalThroughOffsets(interval, dayStart, dayEnd, timeZone));
  projected.sort((left, right) => left.topMinutes - right.topMinutes);

  const blocks: TimeGridBlock[] = [];
  for (const projection of projected) {
    const previous = blocks.at(-1);
    const projectionEnd = projection.topMinutes + projection.heightMinutes;
    const previousEnd = previous ? previous.topMinutes + previous.heightMinutes : -1;
    if (previous && projection.topMinutes <= previousEnd) {
      previous.heightMinutes = Math.max(previousEnd, projectionEnd) - previous.topMinutes;
      for (const source of projection.sourceIntervals) {
        const duplicate = previous.sourceIntervals.some(
          (existing) => existing.start === source.start && existing.end === source.end,
        );
        if (!duplicate) previous.sourceIntervals.push(source);
      }
    } else {
      blocks.push({ ...projection, sourceIntervals: [...projection.sourceIntervals] });
    }
  }

  return { date: dateKey, durationMinutes, blocks };
}

export function offsetMinutesAt(timestamp: number, timeZone: string): number {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    offsetFormatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(timestamp);
  const values = new Map(parts.map((part) => [part.type, Number(part.value)]));
  const localAsUtc = Date.UTC(
    values.get("year") ?? 0,
    (values.get("month") ?? 1) - 1,
    values.get("day") ?? 1,
    values.get("hour") ?? 0,
    values.get("minute") ?? 0,
    values.get("second") ?? 0,
  );
  return Math.round((localAsUtc - Math.floor(timestamp / 1000) * 1000) / 60_000);
}

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "−" : "+";
  const absolute = Math.abs(minutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const remainder = String(absolute % 60).padStart(2, "0");
  return `UTC${sign}${hours}:${remainder}`;
}

export function isWithinRetentionWindow(updatedAt: string | null, now: number, maxAgeMs = UNAVAILABLE_AFTER_MS): boolean {
  if (updatedAt === null) return false;
  const updated = parseTimestamp(updatedAt);
  if (updated === null) return false;
  const age = now - updated;
  return age >= 0 && age < maxAgeMs;
}

export function classifyFreshness(
  status: AvailabilityFreshness,
  updatedAt: string | null,
  now: number,
): AvailabilityFreshness {
  if (status === "unavailable" || updatedAt === null) return "unavailable";
  const updated = parseTimestamp(updatedAt);
  if (updated === null) return "unavailable";
  const age = now - updated;
  if (age < 0 || age >= UNAVAILABLE_AFTER_MS) return "unavailable";
  if (status === "stale" || age >= STALE_AFTER_MS) return "stale";
  return "fresh";
}

export function rangeBounds(
  now: number,
  timeZone: string,
  windowStart: string,
  windowEnd: string,
): { min: string; max: string } {
  const today = toDateKey(now, timeZone);
  const currentSunday = startOfWeekSunday(today);
  const windowStartDate = toDateKey(Date.parse(windowStart), timeZone);
  const min = windowStartDate > currentSunday ? windowStartDate : currentSunday;
  const maximumEndDate = addCalendarDays(toDateKey(Date.parse(windowEnd), timeZone), -1);
  return { min, max: maximumEndDate < min ? min : maximumEndDate };
}

export function moveDateWithinRange(
  dateKey: string,
  amount: number,
  min: string,
  max: string,
): string {
  const next = addCalendarDays(dateKey, amount);
  if (next < min) return min;
  if (next > max) return max;
  return next;
}
