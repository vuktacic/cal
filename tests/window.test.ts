import assert from "node:assert/strict";
import test from "node:test";
import { availabilityWindow, startOfCurrentWeek } from "../src/shared/window.ts";

test("the public window includes Sunday history and the full final week", () => {
  const now = Date.parse("2026-10-27T20:00:00.000Z");
  const window = availabilityWindow(now);
  assert.equal(window.startMs, Date.parse("2026-10-25T07:00:00.000Z"));
  const endParts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Vancouver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(window.endMs).map(({ type, value }) => [type, value]));
  assert.deepEqual(
    { year: endParts.year, month: endParts.month, day: endParts.day, hour: endParts.hour, minute: endParts.minute },
    { year: "2026", month: "11", day: "29", hour: "00", minute: "00" },
  );
});

test("the final-week boundary follows historical Vancouver DST", () => {
  assert.deepEqual(availabilityWindow(Date.parse("2025-02-20T20:00:00.000Z")), {
    startMs: Date.parse("2025-02-16T08:00:00.000Z"),
    endMs: Date.parse("2025-03-23T07:00:00.000Z"),
  });
  assert.deepEqual(availabilityWindow(Date.parse("2025-10-09T19:00:00.000Z")), {
    startMs: Date.parse("2025-10-05T07:00:00.000Z"),
    endMs: Date.parse("2025-11-09T08:00:00.000Z"),
  });
});

test("the Sunday boundary uses Vancouver midnight across historical DST changes", () => {
  const cases = [
    ["2025-11-02T06:59:59.999Z", "2025-10-26T07:00:00.000Z"],
    ["2025-11-02T07:00:00.000Z", "2025-11-02T07:00:00.000Z"],
    ["2025-11-02T10:30:00.000Z", "2025-11-02T07:00:00.000Z"],
    ["2025-11-09T12:00:00.000Z", "2025-11-09T08:00:00.000Z"],
    ["2025-03-09T09:30:00.000Z", "2025-03-09T08:00:00.000Z"],
    ["2025-03-09T11:30:00.000Z", "2025-03-09T08:00:00.000Z"],
    ["2025-01-01T12:00:00.000Z", "2024-12-29T08:00:00.000Z"],
  ];
  for (const [now, expected] of cases) {
    assert.equal(new Date(startOfCurrentWeek(Date.parse(now))).toISOString(), expected);
  }
});
