import assert from "node:assert/strict";
import test from "node:test";
import type { SnapshotStore } from "../src/worker/storage.ts";
import type { StoredSnapshot } from "../src/worker/model.ts";
import { foldIcalLine } from "../src/worker/ical.ts";
import { handleRequest } from "../src/worker/index.ts";

const NOW = Date.parse("2030-01-01T12:00:00.900Z");
const WINDOW_START = "2029-12-30T08:00:00.000Z";
const WINDOW_END = "2030-02-03T08:00:00.000Z";

const BASE_BUSY = [
  { start: "2029-12-30T09:00:00.000Z", end: "2029-12-30T10:00:00.000Z" },
  { start: "2029-12-31T19:00:00.000Z", end: "2029-12-31T20:00:00.000Z" },
  { start: "2030-01-01T11:00:00.000Z", end: "2030-01-01T12:05:00.300Z" },
  { start: "2030-01-02T12:00:00.500Z", end: "2030-01-02T13:00:00.001Z" },
];

class TestStore implements SnapshotStore {
  snapshot: StoredSnapshot | null;
  error: Error | null;
  writes = 0;

  constructor(snapshot: StoredSnapshot | null, error: Error | null = null) {
    this.snapshot = snapshot;
    this.error = error;
  }

  async beginAttempt(): Promise<string | null> {
    this.writes += 1;
    throw new Error("ICS request must not begin refresh attempts");
  }

  async load(): Promise<StoredSnapshot | null> {
    if (this.error) throw this.error;
    return this.snapshot;
  }

  async saveSuccess(): Promise<boolean> {
    this.writes += 1;
    return false;
  }

  async saveFailure(): Promise<boolean> {
    this.writes += 1;
    return false;
  }
}

function makeSnapshot(overrides: Partial<StoredSnapshot> = {}): StoredSnapshot {
  return {
    status: "fresh",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    updatedAt: "2030-01-01T11:59:00.500Z",
    lastAttemptAt: "2030-01-01T11:59:00.500Z",
    busyJson: JSON.stringify(BASE_BUSY),
    ...overrides,
  };
}

function dependencies(store: SnapshotStore, now: () => number = () => NOW) {
  return {
    store,
    assets: { fetch: async (): Promise<Response> => new Response("asset") },
    now,
  };
}

async function requestIcal(
  store: SnapshotStore,
  method = "GET",
  now: () => number = () => NOW,
): Promise<Response> {
  return handleRequest(
    new Request("https://availability.example/busy.ics", { method }),
    dependencies(store, now),
  );
}

function unfoldAndSplit(text: string): string[] {
  assert.equal(text.endsWith("\r\n"), true);
  assert.equal(text.replaceAll("\r\n", "").includes("\n"), false);
  assert.equal(text.replaceAll("\r\n", "").includes("\r"), false);
  return text.replaceAll("\r\n ", "").split("\r\n").filter(Boolean);
}

function eventLines(lines: readonly string[]): string[][] {
  const events: string[][] = [];
  let active: string[] | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      assert.equal(active, null);
      active = [];
    } else if (line === "END:VEVENT") {
      assert.notEqual(active, null);
      events.push(active);
      active = null;
    } else if (active !== null) {
      active.push(line);
    }
  }
  assert.equal(active, null);
  return events;
}

function property(lines: readonly string[], name: string): string {
  const matches = lines.filter((line) => line.startsWith(`${name}:`));
  assert.equal(matches.length, 1, `Expected one ${name} property`);
  return matches[0].slice(name.length + 1);
}

test("GET preserves Sunday and Monday history in opaque VEVENTs with stable end-based UIDs", async () => {
  const store = new TestStore(makeSnapshot());
  const response = await requestIcal(store);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/calendar;charset=utf-8");
  assert.equal(response.headers.get("content-disposition"), 'inline; filename="busy.ics"');
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-availability-status"), "fresh");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");

  const text = await response.text();
  const lines = unfoldAndSplit(text);
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.equal(lines[1], "VERSION:2.0");
  assert.equal(lines.at(-1), "END:VCALENDAR");

  const events = eventLines(lines);
  assert.equal(events.length, 4);
  assert.deepEqual(
    events.map((event) => property(event, "UID")),
    BASE_BUSY.map(
      ({ end }) => `busy-${Date.parse(end).toString(36)}@cal.vuktacic.com`,
    ),
  );
  assert.equal(property(events[0], "DTSTAMP"), "20300101T115900Z");
  assert.equal(property(events[0], "DTSTART"), "20291230T090000Z");
  assert.equal(property(events[0], "DTEND"), "20291230T100000Z");
  assert.equal(property(events[1], "DTSTART"), "20291231T190000Z");
  assert.equal(property(events[1], "DTEND"), "20291231T200000Z");
  assert.equal(property(events[2], "DTSTART"), "20300101T110000Z");
  assert.equal(property(events[2], "DTEND"), "20300101T120501Z");
  assert.equal(property(events[3], "DTSTART"), "20300102T120000Z");
  assert.equal(property(events[3], "DTEND"), "20300102T130001Z");

  for (const event of events) {
    assert.equal(property(event, "SUMMARY"), "Busy");
    assert.equal(property(event, "STATUS"), "CONFIRMED");
    assert.equal(property(event, "TRANSP"), "OPAQUE");
    assert.equal(event.some((line) => line.startsWith("DTSTART:") && line.endsWith("Z")), true);
    assert.equal(event.some((line) => line.startsWith("DTEND:") && line.endsWith("Z")), true);
  }

  assert.equal(text.includes("calendar-id"), false);
  assert.equal(text.includes("Secret meeting title"), false);
  assert.equal(text.includes("DESCRIPTION:"), false);
  assert.equal(store.writes, 0);
});

test("request time advances without dropping current-week history", async () => {
  const store = new TestStore(makeSnapshot());
  const first = await requestIcal(store, "GET", () => NOW);
  const later = await requestIcal(store, "GET", () => NOW + 250);
  const firstLines = unfoldAndSplit(await first.text());
  const laterLines = unfoldAndSplit(await later.text());
  const firstEvents = eventLines(firstLines);
  const laterEvents = eventLines(laterLines);

  assert.equal(property(firstEvents[2], "UID"), property(laterEvents[2], "UID"));
  assert.equal(property(firstEvents[2], "DTSTART"), property(laterEvents[2], "DTSTART"));
  assert.equal(property(laterEvents[2], "DTSTART"), "20300101T110000Z");
  assert.equal(property(laterEvents[2], "DTSTAMP"), "20300101T115900Z");
});

test("Sunday rollover clips ICS history to the new current week", async () => {
  const response = await requestIcal(
    new TestStore(
      makeSnapshot({
        windowEnd: "2030-02-10T08:00:00.000Z",
        updatedAt: "2030-01-06T07:59:00.000Z",
        busyJson: JSON.stringify([
          { start: "2030-01-01T10:00:00.000Z", end: "2030-01-01T11:00:00.000Z" },
          { start: "2030-01-06T07:00:00.000Z", end: "2030-01-06T08:30:00.000Z" },
        ]),
      }),
    ),
    "GET",
    () => Date.parse("2030-01-06T08:00:59.000Z"),
  );

  assert.equal(response.status, 200);
  const events = eventLines(unfoldAndSplit(await response.text()));
  assert.equal(events.length, 1);
  assert.equal(property(events[0], "DTSTART"), "20300106T080000Z");
  assert.equal(property(events[0], "DTEND"), "20300106T083000Z");
});

test("stale snapshots are served with an explicit status header", async () => {
  const store = new TestStore(
    makeSnapshot({
      windowEnd: "2030-02-03T08:00:00.000Z",
      updatedAt: "2030-01-01T11:58:00.500Z",
    }),
  );
  const response = await requestIcal(store);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-availability-status"), "stale");
  assert.equal((await response.text()).includes("BEGIN:VEVENT"), true);
  assert.equal(store.writes, 0);
});

test("a fresh snapshot with no busy spans is a valid empty calendar", async () => {
  const response = await requestIcal(
    new TestStore(makeSnapshot({ busyJson: "[]" })),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-availability-status"), "fresh");
  assert.deepEqual(unfoldAndSplit(await response.text()), [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//cal.vuktacic.com//Busy Calendar//EN",
    "CALSCALE:GREGORIAN",
    "END:VCALENDAR",
  ]);
});

test("HEAD has GET status and headers without a body", async () => {
  const store = new TestStore(makeSnapshot());
  const get = await requestIcal(store);
  const head = await requestIcal(store, "HEAD");
  const getBody = await get.text();

  assert.equal(head.status, get.status);
  assert.deepEqual([...head.headers.entries()], [...get.headers.entries()]);
  assert.equal(head.headers.get("content-length"), String(new TextEncoder().encode(getBody).byteLength));
  assert.equal(await head.text(), "");
  assert.equal(store.writes, 0);

  const getUnavailable = await requestIcal(new TestStore(null));
  const headUnavailable = await requestIcal(new TestStore(null), "HEAD");
  assert.equal(headUnavailable.status, getUnavailable.status);
  assert.deepEqual([...headUnavailable.headers.entries()], [...getUnavailable.headers.entries()]);
  assert.equal(await headUnavailable.text(), "");
});

test("unavailable snapshots and storage failures return a retryable plaintext 503", async (t) => {
  await t.test("no snapshot", async () => {
    const response = await requestIcal(new TestStore(null));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal(response.headers.get("x-availability-status"), "unavailable");
    assert.equal((await response.text()).includes("BEGIN:VCALENDAR"), false);
  });

  await t.test("D1 read failure", async () => {
    const response = await requestIcal(new TestStore(null, new Error("sensitive database detail")));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "60");
    assert.equal((await response.text()).includes("sensitive database detail"), false);
  });

  await t.test("too-old snapshot", async () => {
    const response = await requestIcal(
      new TestStore(
        makeSnapshot({
          windowEnd: "2030-01-31T11:54:59.900Z",
          updatedAt: "2030-01-01T11:54:59.900Z",
        }),
      ),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes("BEGIN:VCALENDAR"), false);
  });
});

test("unsupported methods return 405 with the correct Allow header", async () => {
  const response = await requestIcal(new TestStore(makeSnapshot()), "POST");

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("content line folding respects the 75-octet limit and preserves UTF-8 text", () => {
  const line = `X-NOTE:${"a".repeat(65)}${"é".repeat(12)}`;
  const folded = foldIcalLine(line);
  const physicalLines = folded.split("\r\n");

  assert.equal(folded.replaceAll("\r\n ", ""), line);
  assert.equal(physicalLines.length > 1, true);
  for (const physicalLine of physicalLines) {
    assert.equal(new TextEncoder().encode(physicalLine).byteLength <= 75, true);
  }
  assert.equal(physicalLines.slice(1).every((linePart) => linePart.startsWith(" ")), true);
});
