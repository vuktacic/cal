import assert from "node:assert/strict";
import test from "node:test";
import type { BusyInterval } from "../src/shared/availability.ts";
import type { SnapshotToSave, StoredSnapshot } from "../src/worker/model.ts";
import { refreshAvailability } from "../src/worker/refresh.ts";
import type { SnapshotStore } from "../src/worker/storage.ts";

class TestStore implements SnapshotStore {
  snapshot: StoredSnapshot;
  attempt = "2030-01-01T12:00:00.000Z";
  saved: SnapshotToSave | null = null;
  failureCalls: Array<{ attemptAt: string; failedAtMs: number }> = [];

  constructor(snapshot: StoredSnapshot) {
    this.snapshot = snapshot;
  }

  async beginAttempt(): Promise<string | null> {
    return this.attempt;
  }

  async load(): Promise<StoredSnapshot> {
    return this.snapshot;
  }

  async saveSuccess(snapshot: SnapshotToSave): Promise<boolean> {
    if (snapshot.attemptAt !== this.attempt) return false;
    this.saved = snapshot;
    this.snapshot = {
      status: "fresh",
      windowStart: snapshot.windowStart,
      windowEnd: snapshot.windowEnd,
      updatedAt: snapshot.updatedAt,
      lastAttemptAt: snapshot.attemptAt,
      busyJson: JSON.stringify(snapshot.busy),
    };
    return true;
  }

  async saveFailure(attemptAt: string, failedAtMs: number): Promise<boolean> {
    this.failureCalls.push({ attemptAt, failedAtMs });
    if (attemptAt !== this.attempt) return false;
    this.snapshot = { ...this.snapshot, status: "stale" };
    return true;
  }
}

function lastGoodSnapshot(): StoredSnapshot {
  return {
    status: "fresh",
    windowStart: "2029-12-30T08:00:00.000Z",
    windowEnd: "2030-02-03T08:00:00.000Z",
    updatedAt: "2030-01-01T11:00:00.000Z",
    lastAttemptAt: "2030-01-01T11:59:00.000Z",
    busyJson: JSON.stringify([
      { start: "2030-01-02T12:00:00.000Z", end: "2030-01-02T13:00:00.000Z" },
    ] satisfies BusyInterval[]),
  };
}

test("refresh queries DST-adjusted Vancouver Sunday and timestamps success at refresh time", async () => {
  const store = new TestStore(lastGoodSnapshot());
  let requestedWindow: { timeMin: string; timeMax: string } | null = null;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname.endsWith("/calendarList")) {
      return Response.json({ items: [{ id: "owned", accessRole: "owner" }] });
    }

    const body = JSON.parse(String(init?.body)) as { timeMin: string; timeMax: string };
    requestedWindow = { timeMin: body.timeMin, timeMax: body.timeMax };
    return Response.json({
      ...requestedWindow,
      calendars: {
        owned: {
          busy: [
            { start: "2030-03-17T08:00:00.000Z", end: "2030-03-17T09:00:00.000Z" },
          ],
        },
      },
    });
  };

  const nowMs = Date.parse("2030-03-17T12:00:00.000Z");
  assert.equal(
    await refreshAvailability(
      { clientId: "id", clientSecret: "secret", refreshToken: "refresh" },
      store,
      { now: () => nowMs, fetcher },
    ),
    true,
  );

  assert.deepEqual(requestedWindow, {
    timeMin: "2030-03-17T07:00:00.000Z",
    timeMax: "2030-04-21T07:00:00.000Z",
  });
  assert.deepEqual(store.saved, {
    attemptAt: store.attempt,
    windowStart: "2030-03-17T07:00:00.000Z",
    windowEnd: "2030-04-21T07:00:00.000Z",
    updatedAt: "2030-03-17T12:00:00.000Z",
    busy: [
      { start: "2030-03-17T08:00:00.000Z", end: "2030-03-17T09:00:00.000Z" },
    ],
  });
});

test("failed refresh preserves the last complete snapshot and marks it stale", async () => {
  const oldSnapshot = lastGoodSnapshot();
  const store = new TestStore(oldSnapshot);
  const failures: string[] = [];
  const result = await refreshAvailability({}, store, {
    now: () => Date.parse("2030-01-01T12:00:00.000Z"),
    onFailure: () => failures.push("failed"),
  });

  assert.equal(result, false);
  assert.deepEqual(store.failureCalls, [
    { attemptAt: store.attempt, failedAtMs: Date.parse("2030-01-01T12:00:00.000Z") },
  ]);
  assert.equal(store.snapshot.status, "stale");
  assert.equal(store.snapshot.windowStart, oldSnapshot.windowStart);
  assert.equal(store.snapshot.windowEnd, oldSnapshot.windowEnd);
  assert.equal(store.snapshot.updatedAt, oldSnapshot.updatedAt);
  assert.equal(store.snapshot.busyJson, oldSnapshot.busyJson);
  assert.deepEqual(failures, ["failed"]);
});

test("a late refresh cannot replace a newer attempt's snapshot", async () => {
  const store = new TestStore(lastGoodSnapshot());
  let releaseFetch!: (response: Response) => void;
  const delayedResponse = new Promise<Response>((resolve) => {
    releaseFetch = resolve;
  });
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") {
      return Response.json({ access_token: "token", token_type: "Bearer", expires_in: 3600 });
    }
    if (url.pathname.endsWith("/calendarList")) {
      return Response.json({ items: [{ id: "owned", accessRole: "owner" }] });
    }
    return delayedResponse;
  };

  const pending = refreshAvailability(
    {
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "refresh",
    },
    store,
    { now: () => Date.parse("2030-01-01T12:00:00.000Z"), fetcher },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  store.attempt = "2030-01-01T12:00:01.000Z";
  releaseFetch(
    Response.json({
      timeMin: "2029-12-30T08:00:00.000Z",
      timeMax: "2030-02-03T08:00:00.000Z",
      calendars: { owned: { busy: [] } },
    }),
  );

  assert.equal(await pending, false);
  assert.equal(store.saved, null);
  assert.equal(store.snapshot.updatedAt, "2030-01-01T11:00:00.000Z");
});
