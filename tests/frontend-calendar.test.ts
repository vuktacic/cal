import assert from "node:assert/strict";
import test from "node:test";
import {
  addCalendarDays,
  classifyFreshness,
  clampCompactStart,
  clipIntervalsToStart,
  dateRange,
  formatCompactTimeGridBlockLabel,
  formatTimeGridBlockLabel,
  formatWallClockTime,
  formatUtcOffset,
  isWithinRetentionWindow,
  layoutDayTimeGrid,
  mergeIntervals,
  moveCompactStartWithinRange,
  moveWeekWithinRange,
  moveDateWithinRange,
  offsetMinutesAt,
  rangeBounds,
  splitIntervalsByDate,
  startOfDateInZone,
  startOfWeekSunday,
  toDateKey,
  validateAvailabilityPayload,
  wallClockMinuteAt,
  wallClockMarks,
  weekDates,
} from "../web/calendar.ts";

const VANCOUVER = "America/Vancouver";

test("local date boundaries account for 23-hour and 25-hour DST days", () => {
  const springStart = startOfDateInZone("2025-03-09", VANCOUVER);
  const springEnd = startOfDateInZone("2025-03-10", VANCOUVER);
  const fallStart = startOfDateInZone("2025-11-02", VANCOUVER);
  const fallEnd = startOfDateInZone("2025-11-03", VANCOUVER);

  assert.equal(springEnd - springStart, 23 * 60 * 60 * 1000);
  assert.equal(fallEnd - fallStart, 25 * 60 * 60 * 1000);
  assert.equal(toDateKey(springStart, VANCOUVER), "2025-03-09");
  assert.equal(formatUtcOffset(offsetMinutesAt(Date.parse("2025-03-09T09:30:00Z"), VANCOUVER)), "UTC−08:00");
  assert.equal(formatUtcOffset(offsetMinutesAt(Date.parse("2025-03-09T10:30:00Z"), VANCOUVER)), "UTC−07:00");
});

test("splits a busy interval at local midnight and preserves both partial days", () => {
  const split = splitIntervalsByDate(
    [{ start: "2026-01-02T07:45:00Z", end: "2026-01-02T08:15:00Z" }],
    VANCOUVER,
  );

  assert.deepEqual([...split.keys()], ["2026-01-01", "2026-01-02"]);
  assert.deepEqual(split.get("2026-01-01"), [
    { start: "2026-01-02T07:45:00.000Z", end: "2026-01-02T08:00:00.000Z" },
  ]);
  assert.deepEqual(split.get("2026-01-02"), [
    { start: "2026-01-02T08:00:00.000Z", end: "2026-01-02T08:15:00.000Z" },
  ]);

  const firstDay = layoutDayTimeGrid(
    [{ start: "2026-01-02T07:45:00Z", end: "2026-01-02T08:15:00Z" }],
    "2026-01-01",
    VANCOUVER,
  );
  const secondDay = layoutDayTimeGrid(
    [{ start: "2026-01-02T07:45:00Z", end: "2026-01-02T08:15:00Z" }],
    "2026-01-02",
    VANCOUVER,
  );
  assert.deepEqual(firstDay.blocks.map(({ topMinutes, heightMinutes }) => ({ topMinutes, heightMinutes })), [
    { topMinutes: 1425, heightMinutes: 15 },
  ]);
  assert.equal(formatWallClockTime(firstDay.blocks[0].topMinutes + firstDay.blocks[0].heightMinutes), "12:00 AM");
  assert.equal(formatTimeGridBlockLabel(firstDay.blocks[0], VANCOUVER), "11:45 PM–12:00 AM");
  assert.equal(formatCompactTimeGridBlockLabel(firstDay.blocks[0], VANCOUVER), "11:45p–12a");
  assert.deepEqual(secondDay.blocks.map(({ topMinutes, heightMinutes }) => ({ topMinutes, heightMinutes })), [
    { topMinutes: 0, heightMinutes: 15 },
  ]);
});

test("merges unsorted overlapping and adjacent busy intervals", () => {
  const merged = mergeIntervals([
    { start: "2026-05-11T16:30:00Z", end: "2026-05-11T17:00:00Z" },
    { start: "2026-05-11T15:30:00Z", end: "2026-05-11T16:30:00Z" },
    { start: "2026-05-11T15:00:00Z", end: "2026-05-11T16:00:00Z" },
    { start: "2026-05-11T18:00:00Z", end: "2026-05-11T18:30:00Z" },
  ]);

  assert.deepEqual(merged, [
    { start: "2026-05-11T15:00:00.000Z", end: "2026-05-11T17:00:00.000Z" },
    { start: "2026-05-11T18:00:00.000Z", end: "2026-05-11T18:30:00.000Z" },
  ]);
});

test("date navigation starts Sunday and uses the complete API window", () => {
  const now = Date.parse("2026-03-07T20:00:00Z");
  const bounds = rangeBounds(
    now,
    VANCOUVER,
    "2026-02-28T08:00:00Z",
    "2026-04-10T08:00:00Z",
  );

  assert.deepEqual(bounds, { min: "2026-03-01", max: "2026-04-09" });
  assert.equal(startOfWeekSunday("2026-03-07"), bounds.min);
  assert.equal(moveDateWithinRange(bounds.min, -7, bounds.min, bounds.max), bounds.min);
  assert.equal(moveDateWithinRange("2026-04-05", 7, bounds.min, bounds.max), bounds.max);

  const laterApiStart = rangeBounds(
    now,
    VANCOUVER,
    "2026-03-03T08:00:00Z",
    "2026-04-10T08:00:00Z",
  );
  assert.equal(laterApiStart.min, "2026-03-03");
  assert.deepEqual(
    weekDates("2026-03-01", "2026-03-01", laterApiStart.min, laterApiStart.max).map(({ state }) => state),
    ["uncovered", "uncovered", "available", "available", "available", "available", "available"],
  );
});

test("a Vancouver Sunday mapped to Saturday keeps the local Sunday navigation boundary", () => {
  const zone = "Pacific/Pago_Pago";
  const now = Date.parse("2026-03-08T08:30:00Z");
  const windowStart = "2026-03-08T08:00:00Z";
  assert.equal(toDateKey(Date.parse(windowStart), zone), "2026-03-07");

  const bounds = rangeBounds(now, zone, windowStart, "2026-04-07T08:00:00Z");
  const currentSunday = startOfWeekSunday(toDateKey(now, zone));
  assert.equal(currentSunday, "2026-03-01");
  assert.equal(bounds.min, "2026-03-07");
  assert.equal(moveWeekWithinRange(currentSunday, -1, bounds.min, bounds.max), currentSunday);
  assert.deepEqual(
    weekDates(currentSunday, currentSunday, bounds.min, bounds.max).map(({ state }) => state),
    ["uncovered", "uncovered", "uncovered", "uncovered", "uncovered", "uncovered", "available"],
  );
});

test("weeks start Sunday, keep current-week history, and clamp navigation to the horizon", () => {
  const today = "2026-10-28";
  const maximum = "2026-11-28";
  const currentWeek = startOfWeekSunday(today);
  const lastWeek = startOfWeekSunday(maximum);

  assert.equal(currentWeek, "2026-10-25");
  assert.equal(moveWeekWithinRange(currentWeek, -1, currentWeek, maximum), currentWeek);
  assert.equal(moveWeekWithinRange("2026-11-23", 1, today, maximum), lastWeek);
  assert.deepEqual(weekDates("2026-11-22", currentWeek, currentWeek, maximum).map(({ state }) => state), [
    "available",
    "available",
    "available",
    "available",
    "available",
    "available",
    "available",
  ]);
  assert.deepEqual(weekDates(currentWeek, currentWeek, currentWeek, maximum).map(({ state }) => state), [
    "available",
    "available",
    "available",
    "available",
    "available",
    "available",
    "available",
  ]);
  assert.deepEqual(weekDates("2026-10-18", currentWeek, currentWeek, maximum).map(({ state }) => state), [
    "past",
    "past",
    "past",
    "past",
    "past",
    "past",
    "past",
  ]);
});

test("compact navigation clamps three-day starts and preserves outside date state", () => {
  const minimum = "2026-10-27";
  const maximum = "2026-11-02";
  assert.equal(clampCompactStart("2026-10-25", minimum, maximum), minimum);
  assert.equal(clampCompactStart("2026-11-02", minimum, maximum), "2026-10-31");
  assert.equal(moveCompactStartWithinRange("2026-10-29", 1, minimum, maximum), "2026-10-31");
  assert.equal(moveCompactStartWithinRange("2026-10-31", -1, minimum, maximum), "2026-10-28");
  assert.equal(clampCompactStart(minimum, minimum, "2026-10-28"), minimum);

  assert.deepEqual(
    dateRange("2026-10-31", 3, "2026-10-25", minimum, maximum).map(({ date, state }) => ({ date, state })),
    [
      { date: "2026-10-31", state: "available" },
      { date: "2026-11-01", state: "available" },
      { date: "2026-11-02", state: "available" },
    ],
  );
  assert.deepEqual(
    dateRange("2026-11-02", 3, "2026-10-25", minimum, maximum).map(({ state }) => state),
    ["available", "outside", "outside"],
  );
});

test("busy intervals retain current-week history and clip before a rolled week", () => {
  const currentSunday = Date.parse("2026-11-01T07:00:00Z");
  assert.deepEqual(
    clipIntervalsToStart(
      [
        { start: "2026-10-31T23:00:00Z", end: "2026-11-01T08:00:00Z" },
        { start: "2026-11-01T09:00:00Z", end: "2026-11-01T10:00:00Z" },
      ],
      currentSunday,
    ),
    [
      { start: "2026-11-01T07:00:00.000Z", end: "2026-11-01T08:00:00.000Z" },
      { start: "2026-11-01T09:00:00.000Z", end: "2026-11-01T10:00:00.000Z" },
    ],
  );
});

test("time grid projects fall-back intervals onto the shared wall-clock ruler", () => {
  const layout = layoutDayTimeGrid(
    [{ start: "2025-11-02T08:30:00Z", end: "2025-11-02T09:30:00Z" }],
    "2025-11-02",
    VANCOUVER,
  );

  assert.equal(layout.durationMinutes, 24 * 60);
  assert.equal(wallClockMarks().length, 25);
  assert.deepEqual(wallClockMarks().slice(0, 4).map(({ topMinutes }) => topMinutes), [0, 60, 120, 180]);
  assert.equal(wallClockMarks().at(-1)?.topMinutes, 1440);
  assert.equal(layout.blocks.length, 1);
  assert.equal(layout.blocks[0].topMinutes, 60);
  assert.equal(layout.blocks[0].heightMinutes, 60);
  assert.equal(formatTimeGridBlockLabel(layout.blocks[0], VANCOUVER), "1:30 AM PDT–1:30 AM PST");
  assert.equal(formatCompactTimeGridBlockLabel(layout.blocks[0], VANCOUVER), "1:30 AM PDT–1:30 AM PST");
  assert.equal(formatWallClockTime(layout.blocks[0].topMinutes), "1:00 AM");
  assert.equal(formatWallClockTime(layout.blocks[0].topMinutes + layout.blocks[0].heightMinutes), "2:00 AM");
  assert.deepEqual(layout.blocks[0].sourceIntervals, [
    { start: "2025-11-02T08:30:00.000Z", end: "2025-11-02T09:30:00.000Z" },
  ]);
  assert.equal(formatUtcOffset(offsetMinutesAt(Date.parse(layout.blocks[0].sourceIntervals[0].start), VANCOUVER)), "UTC−07:00");
  assert.equal(formatUtcOffset(offsetMinutesAt(Date.parse(layout.blocks[0].sourceIntervals[0].end), VANCOUVER)), "UTC−08:00");
});

test("compact busy labels omit redundant periods while retaining minute and boundary detail", () => {
  const samePeriod = layoutDayTimeGrid(
    [{ start: "2026-01-02T19:00:00Z", end: "2026-01-02T19:25:00Z" }],
    "2026-01-02",
    VANCOUVER,
  ).blocks[0];
  assert.equal(formatCompactTimeGridBlockLabel(samePeriod, VANCOUVER), "11–11:25a");

  const differentPeriods = layoutDayTimeGrid(
    [{ start: "2026-01-02T19:00:00Z", end: "2026-01-02T21:00:00Z" }],
    "2026-01-02",
    VANCOUVER,
  ).blocks[0];
  assert.equal(formatCompactTimeGridBlockLabel(differentPeriods, VANCOUVER), "11a–1p");
});

test("current wall-clock minute follows both DST transitions in Vancouver", () => {
  assert.equal(wallClockMinuteAt(Date.parse("2025-03-09T09:59:00Z"), VANCOUVER), 119);
  assert.equal(wallClockMinuteAt(Date.parse("2025-03-09T10:00:00Z"), VANCOUVER), 180);
  assert.equal(wallClockMinuteAt(Date.parse("2025-11-02T08:30:00Z"), VANCOUVER), 90);
  assert.equal(wallClockMinuteAt(Date.parse("2025-11-02T09:30:00Z"), VANCOUVER), 90);
  assert.equal(toDateKey(Date.parse("2025-03-09T07:59:00Z"), VANCOUVER), "2025-03-08");
  assert.equal(wallClockMinuteAt(Date.parse("2025-03-09T07:59:00Z"), VANCOUVER), 1439);
  assert.equal(toDateKey(Date.parse("2025-03-09T08:00:00Z"), VANCOUVER), "2025-03-09");
  assert.equal(wallClockMinuteAt(Date.parse("2025-03-09T08:00:00Z"), VANCOUVER), 0);
});

test("spring-forward busy spans leave the missing wall-clock hour empty", () => {
  const layout = layoutDayTimeGrid(
    [{ start: "2025-03-09T09:30:00Z", end: "2025-03-09T10:30:00Z" }],
    "2025-03-09",
    VANCOUVER,
  );

  assert.equal(layout.durationMinutes, 24 * 60);
  assert.equal(wallClockMarks().length, 25);
  assert.ok(wallClockMarks().some((mark) => mark.label === "2 AM"));
  assert.deepEqual(layout.blocks.map(({ topMinutes, heightMinutes }) => ({ topMinutes, heightMinutes })), [
    { topMinutes: 90, heightMinutes: 30 },
    { topMinutes: 180, heightMinutes: 30 },
  ]);
  for (const block of layout.blocks) {
    assert.ok(block.topMinutes >= 0);
    assert.ok(block.heightMinutes > 0);
    assert.ok(block.topMinutes + block.heightMinutes <= layout.durationMinutes);
  }
});

test("busy spans on ordinary, spring-forward, and fall-back days align to the same 8 AM row", () => {
  const examples = [
    { date: "2025-02-02", start: "2025-02-02T16:30:00Z", end: "2025-02-02T17:00:00Z" },
    { date: "2025-03-09", start: "2025-03-09T15:30:00Z", end: "2025-03-09T16:00:00Z" },
    { date: "2025-11-02", start: "2025-11-02T16:30:00Z", end: "2025-11-02T17:00:00Z" },
  ];

  for (const example of examples) {
    const layout = layoutDayTimeGrid([{ start: example.start, end: example.end }], example.date, VANCOUVER);
    assert.equal(layout.blocks[0].topMinutes, 8 * 60 + 30);
  }
});

test("overlapping repeated-hour projections merge into one anonymous busy block", () => {
  const layout = layoutDayTimeGrid(
    [
      { start: "2025-11-02T08:10:00Z", end: "2025-11-02T08:20:00Z" },
      { start: "2025-11-02T09:15:00Z", end: "2025-11-02T09:30:00Z" },
    ],
    "2025-11-02",
    VANCOUVER,
  );

  assert.equal(layout.blocks.length, 1);
  assert.equal(layout.blocks[0].topMinutes, 70);
  assert.equal(layout.blocks[0].heightMinutes, 20);
  assert.equal(layout.blocks[0].sourceIntervals.length, 2);
  assert.equal(
    formatTimeGridBlockLabel(layout.blocks[0], VANCOUVER),
    "1:10 AM PDT–1:20 AM PDT; 1:15 AM PST–1:30 AM PST",
  );
  assert.equal(
    formatCompactTimeGridBlockLabel(layout.blocks[0], VANCOUVER),
    "1:10 AM PDT–1:20 AM PDT; 1:15 AM PST–1:30 AM PST",
  );
});

test("validates only the exact public availability shape and matching HTTP status", () => {
  const valid = {
    status: "fresh",
    windowStart: "2026-10-27T00:00:00.000Z",
    windowEnd: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-10-27T12:00:00.000Z",
    busy: [{ start: "2026-10-28T15:00:00.000Z", end: "2026-10-28T16:00:00.000Z" }],
  };

  assert.equal(validateAvailabilityPayload(valid, 200), true);
  assert.equal(validateAvailabilityPayload({ ...valid, source: "private" }, 200), false);
  assert.equal(
    validateAvailabilityPayload({ ...valid, busy: [{ ...valid.busy[0], title: "private" }] }, 200),
    false,
  );
  assert.equal(validateAvailabilityPayload({ ...valid, status: "unavailable" }, 200), false);
  assert.equal(
    validateAvailabilityPayload({ ...valid, busy: [{ start: "2026-02-30T12:00:00Z", end: "2026-03-01T12:00:00Z" }] }, 200),
    false,
  );
});

test("retains a known snapshot for at most five minutes after an update", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");

  assert.equal(isWithinRetentionWindow("2026-10-27T11:55:01Z", now), true);
  assert.equal(isWithinRetentionWindow("2026-10-27T11:55:00Z", now), false);
  assert.equal(isWithinRetentionWindow("2026-10-27T11:54:59Z", now), false);
  assert.equal(isWithinRetentionWindow("2026-10-27T12:00:01Z", now), false);
  assert.equal(isWithinRetentionWindow(null, now), false);
});

test("freshness transitions at two and five minutes regardless of reported freshness", () => {
  const updatedAt = "2026-10-27T12:00:00.000Z";
  const updated = Date.parse(updatedAt);

  assert.equal(classifyFreshness("fresh", updatedAt, updated + 119_999), "fresh");
  assert.equal(classifyFreshness("fresh", updatedAt, updated + 120_000), "stale");
  assert.equal(classifyFreshness("fresh", updatedAt, updated + 299_999), "stale");
  assert.equal(classifyFreshness("stale", updatedAt, updated + 60_000), "stale");
  assert.equal(classifyFreshness("stale", updatedAt, updated + 300_000), "unavailable");
  assert.equal(classifyFreshness("fresh", null, updated), "unavailable");
});
