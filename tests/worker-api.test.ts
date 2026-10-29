import assert from "node:assert/strict";
import test from "node:test";
import type { Availability } from "../src/shared/availability.ts";
import { handleRequest } from "../src/worker/index.ts";
import type { SnapshotStore } from "../src/worker/storage.ts";
import type { StoredSnapshot } from "../src/worker/model.ts";

const NOW = Date.parse("2030-01-01T12:00:00.000Z");
const WINDOW_START = "2029-12-30T08:00:00.000Z";
const UPDATED_AT = "2030-01-01T11:59:00.000Z";
const WINDOW_END = "2030-02-03T08:00:00.000Z";

class TestStore implements SnapshotStore {
  snapshot: StoredSnapshot | null;

  constructor(snapshot: StoredSnapshot | null) {
    this.snapshot = snapshot;
  }
  async beginAttempt(): Promise<string | null> {
    return "attempt";
  }
  async load(): Promise<StoredSnapshot | null> {
    return this.snapshot;
  }
  async saveSuccess(): Promise<boolean> {
    return true;
  }
  async saveFailure(): Promise<boolean> {
    return true;
  }
}

function snapshot(
  overrides: Partial<StoredSnapshot> = {},
  intervals = [
    { start: "2029-12-30T07:00:00.000Z", end: "2029-12-30T07:30:00.000Z" },
    { start: "2029-12-30T07:30:00.000Z", end: "2029-12-30T08:30:00.000Z" },
    { start: "2029-12-30T09:00:00.000Z", end: "2029-12-30T10:00:00.000Z" },
    { start: "2029-12-31T19:00:00.000Z", end: "2029-12-31T20:00:00.000Z" },
    { start: "2030-01-01T10:00:00.000Z", end: "2030-01-01T11:30:00.000Z" },
    { start: "2030-01-01T11:30:00.000Z", end: "2030-01-01T12:30:00.000Z" },
    { start: "2030-01-02T00:00:00.000Z", end: "2030-03-04T00:00:00.000Z" },
  ],
): StoredSnapshot {
  return {
    status: "fresh",
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    updatedAt: UPDATED_AT,
    lastAttemptAt: UPDATED_AT,
    busyJson: JSON.stringify(intervals),
    ...overrides,
  };
}

function dependencies(store: SnapshotStore, assetsCalls: string[] = []) {
  return {
    store,
    assets: {
      async fetch(request: Request): Promise<Response> {
        assetsCalls.push(new URL(request.url).pathname);
        return new Response("asset-body", { headers: { "Content-Type": "text/plain" } });
      },
    },
    now: () => NOW,
  };
}

test("availability keeps Sunday history and clips events to the published window", async () => {
  const response = await handleRequest(
    new Request("https://availability.example/api/availability"),
    dependencies(new TestStore(snapshot())),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
  const body = (await response.json()) as Availability;
  assert.deepEqual(Object.keys(body).sort(), ["busy", "status", "updatedAt", "windowEnd", "windowStart"]);
  assert.equal(body.status, "fresh");
  assert.equal(body.windowStart, WINDOW_START);
  assert.equal(body.windowEnd, WINDOW_END);
  assert.deepEqual(body.busy, [
    { start: WINDOW_START, end: "2029-12-30T08:30:00.000Z" },
    { start: "2029-12-30T09:00:00.000Z", end: "2029-12-30T10:00:00.000Z" },
    { start: "2029-12-31T19:00:00.000Z", end: "2029-12-31T20:00:00.000Z" },
    { start: "2030-01-01T10:00:00.000Z", end: "2030-01-01T12:30:00.000Z" },
    { start: "2030-01-02T00:00:00.000Z", end: WINDOW_END },
  ]);
});

test("Sunday rollover drops the previous week even while its snapshot is fresh", async () => {
  const rolloverNow = Date.parse("2030-01-06T08:00:59.000Z");
  const response = await handleRequest(
    new Request("https://availability.example/api/availability"),
    {
      ...dependencies(
        new TestStore(
          snapshot(
            {
              updatedAt: "2030-01-06T07:59:00.000Z",
              lastAttemptAt: "2030-01-06T07:59:00.000Z",
              windowEnd: "2030-02-10T08:00:00.000Z",
            },
            [
              { start: "2030-01-01T10:00:00.000Z", end: "2030-01-01T11:00:00.000Z" },
              { start: "2030-01-06T07:00:00.000Z", end: "2030-01-06T08:30:00.000Z" },
            ],
          ),
        ),
      ),
      now: () => rolloverNow,
    },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "fresh",
    windowStart: "2030-01-06T08:00:00.000Z",
    windowEnd: "2030-02-10T08:00:00.000Z",
    updatedAt: "2030-01-06T07:59:00.000Z",
    busy: [{ start: "2030-01-06T08:00:00.000Z", end: "2030-01-06T08:30:00.000Z" }],
  });
});

test("availability status ages from the last successful snapshot", async () => {
  const store = new TestStore(snapshot());
  const request = new Request("https://availability.example/api/availability");

  let response = await handleRequest(request, { ...dependencies(store), now: () => NOW + 120_000 });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "stale");

  response = await handleRequest(request, { ...dependencies(store), now: () => NOW + 300_000 });
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.deepEqual(body, {
    status: "unavailable",
    windowStart: WINDOW_START,
    windowEnd: "2030-02-03T08:00:00.000Z",
    updatedAt: null,
    busy: [],
  });
});

test("future-dated or malformed stored snapshots fail closed", async (t) => {
  await t.test("future updatedAt", async () => {
    const response = await handleRequest(
      new Request("https://availability.example/api/availability"),
      dependencies(
        new TestStore(snapshot({ updatedAt: "2030-01-01T12:01:00.000Z" })),
      ),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).updatedAt, null);
  });

  await t.test("excessive window", async () => {
    const response = await handleRequest(
      new Request("https://availability.example/api/availability"),
      dependencies(
        new TestStore(
          snapshot({ windowEnd: "2030-03-01T12:00:00.000Z" }),
        ),
      ),
    );
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).busy, []);
  });

  await t.test("malformed window", async () => {
    const response = await handleRequest(
      new Request("https://availability.example/api/availability"),
      dependencies(new TestStore(snapshot({ windowEnd: "not-a-timestamp" }))),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).updatedAt, null);
  });

  await t.test("legacy window without Sunday coverage", async () => {
    const response = await handleRequest(
      new Request("https://availability.example/api/availability"),
      dependencies(
        new TestStore(snapshot({ windowStart: UPDATED_AT })),
      ),
    );
    assert.equal(response.status, 503);
    assert.equal((await response.json()).updatedAt, null);
  });
});

test("no snapshot produces the exact unavailable response", async () => {
  const response = await handleRequest(
    new Request("https://availability.example/api/availability"),
    dependencies(new TestStore(null)),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "unavailable",
    windowStart: WINDOW_START,
    windowEnd: "2030-02-03T08:00:00.000Z",
    updatedAt: null,
    busy: [],
  });
});

test("API methods and paths are constrained without falling through to assets", async () => {
  const assetCalls: string[] = [];
  const deps = dependencies(new TestStore(null), assetCalls);

  const methodResponse = await handleRequest(
    new Request("https://availability.example/api/availability", { method: "POST" }),
    deps,
  );
  assert.equal(methodResponse.status, 405);
  assert.equal(methodResponse.headers.get("allow"), "GET");
  assert.deepEqual(await methodResponse.json(), { error: "method_not_allowed" });

  const missingResponse = await handleRequest(
    new Request("https://availability.example/api/private"),
    deps,
  );
  assert.equal(missingResponse.status, 404);
  assert.deepEqual(await missingResponse.json(), { error: "not_found" });
  assert.deepEqual(assetCalls, []);
});

test("static assets keep streaming bodies and receive restrictive security headers", async () => {
  const response = await handleRequest(
    new Request("https://availability.example/"),
    dependencies(new TestStore(null)),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "asset-body");
  assert.equal(response.headers.get("content-security-policy")?.includes("script-src 'self'"), true);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
});
