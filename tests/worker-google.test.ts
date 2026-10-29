import assert from "node:assert/strict";
import test from "node:test";
import { fetchGoogleBusyIntervals } from "../src/worker/google-calendar.ts";

const WINDOW_START = "2030-01-01T00:00:00.000Z";
const WINDOW_END = "2030-01-31T00:00:00.000Z";
const CREDENTIALS = {
  clientId: "client-id",
  clientSecret: "client-secret",
  refreshToken: "refresh-token",
};

function tokenResponse(): Response {
  return Response.json({ access_token: "access-token", token_type: "Bearer", expires_in: 3600 });
}

function tokenRequestBody(init: RequestInit | undefined): URLSearchParams {
  assert.equal(init?.method, "POST");
  return new URLSearchParams(String(init?.body ?? ""));
}

test("refresh lists hidden calendars, filters to owners, batches freebusy, and merges intervals", async () => {
  const calls: Array<{ url: URL; init: RequestInit | undefined }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });

    if (url.hostname === "oauth2.googleapis.com") {
      const body = tokenRequestBody(init);
      assert.equal(body.get("client_id"), CREDENTIALS.clientId);
      assert.equal(body.get("client_secret"), CREDENTIALS.clientSecret);
      assert.equal(body.get("refresh_token"), CREDENTIALS.refreshToken);
      assert.equal(body.get("grant_type"), "refresh_token");
      return tokenResponse();
    }

    if (url.pathname.endsWith("/calendarList")) {
      assert.equal(url.searchParams.get("maxResults"), "250");
      assert.equal(url.searchParams.get("showHidden"), "true");
      assert.equal(url.searchParams.get("fields"), "items(id,accessRole),nextPageToken");
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer access-token");
      if (url.searchParams.get("pageToken") === null) {
        return Response.json({
          items: [
            { id: "primary@example.com", accessRole: "owner" },
            { id: "shared@example.com", accessRole: "reader" },
            { id: "freebusy@example.com", accessRole: "freeBusyReader" },
          ],
          nextPageToken: "next-page",
        });
      }
      assert.equal(url.searchParams.get("pageToken"), "next-page");
      return Response.json({ items: [{ id: "hidden-owned@example.com", accessRole: "owner" }] });
    }

    assert.equal(url.pathname, "/calendar/v3/freeBusy");
    const requestBody = JSON.parse(String(init?.body)) as {
      timeMin: string;
      timeMax: string;
      timeZone: string;
      calendarExpansionMax: number;
      items: Array<{ id: string }>;
    };
    assert.deepEqual(requestBody.items.map(({ id }) => id), [
      "primary@example.com",
      "hidden-owned@example.com",
    ]);
    assert.equal(requestBody.timeMin, WINDOW_START);
    assert.equal(requestBody.timeMax, WINDOW_END);
    assert.equal(requestBody.timeZone, "UTC");
    assert.equal(requestBody.calendarExpansionMax, 50);
    assert.equal(requestBody.items.length <= 50, true);

    return Response.json({
      timeMin: WINDOW_START,
      timeMax: WINDOW_END,
      calendars: {
        "primary@example.com": {
          busy: [{ start: "2029-12-31T23:30:00.000Z", end: "2030-01-01T00:30:00.000Z" }],
        },
        "hidden-owned@example.com": {
          busy: [{ start: "2030-01-01T00:30:00.000Z", end: "2030-01-01T01:00:00.000Z" }],
        },
      },
    });
  };

  const busy = await fetchGoogleBusyIntervals(CREDENTIALS, WINDOW_START, WINDOW_END, { fetcher });

  assert.deepEqual(busy, [
    { start: WINDOW_START, end: "2030-01-01T01:00:00.000Z" },
  ]);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/calendarList")).length, 2);
  assert.equal(calls.filter(({ url }) => url.pathname.endsWith("/freeBusy")).length, 1);
});

test("more than fifty owned calendars are split into freebusy requests of at most fifty", async () => {
  const batchSizes: number[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return tokenResponse();
    if (url.pathname.endsWith("/calendarList")) {
      return Response.json({
        items: Array.from({ length: 51 }, (_, index) => ({
          id: `calendar-${index}`,
          accessRole: "owner",
        })),
      });
    }

    const body = JSON.parse(String(init?.body)) as {
      timeMin: string;
      timeMax: string;
      items: Array<{ id: string }>;
    };
    batchSizes.push(body.items.length);
    return Response.json({
      timeMin: body.timeMin,
      timeMax: body.timeMax,
      calendars: Object.fromEntries(body.items.map(({ id }) => [id, { busy: [] }])),
    });
  };

  const busy = await fetchGoogleBusyIntervals(CREDENTIALS, WINDOW_START, WINDOW_END, { fetcher });

  assert.deepEqual(busy, []);
  assert.deepEqual(batchSizes.sort((left, right) => left - right), [1, 50]);
});

test("empty owned-calendar discovery rejects the refresh", async () => {
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return tokenResponse();
    if (url.pathname.endsWith("/calendarList")) return Response.json({ items: [] });
    throw new Error("Freebusy must not run without owned calendars");
  };

  await assert.rejects(
    fetchGoogleBusyIntervals(CREDENTIALS, WINDOW_START, WINDOW_END, { fetcher }),
    /No owned calendars were found/,
  );
});

test("missing or errored calendar results reject the whole snapshot", async (t) => {
  await t.test("missing result", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return tokenResponse();
      if (url.pathname.endsWith("/calendarList")) {
        return Response.json({ items: [{ id: "owned", accessRole: "owner" }] });
      }
      return Response.json({ timeMin: WINDOW_START, timeMax: WINDOW_END, calendars: {} });
    };

    await assert.rejects(
      fetchGoogleBusyIntervals(CREDENTIALS, WINDOW_START, WINDOW_END, { fetcher }),
      /Google freebusy request failed/,
    );
  });

  await t.test("calendar-level error", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.hostname === "oauth2.googleapis.com") return tokenResponse();
      if (url.pathname.endsWith("/calendarList")) {
        return Response.json({ items: [{ id: "owned", accessRole: "owner" }] });
      }
      return Response.json({
        timeMin: WINDOW_START,
        timeMax: WINDOW_END,
        calendars: { owned: { errors: [{ domain: "calendar", reason: "notFound" }], busy: [] } },
      });
    };

    await assert.rejects(
      fetchGoogleBusyIntervals(CREDENTIALS, WINDOW_START, WINDOW_END, { fetcher }),
      /Google freebusy request failed/,
    );
  });
});

test("an oversized Google body is rejected before JSON parsing", async () => {
  const oversized = new Uint8Array(1_048_577);
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com") return tokenResponse();
    if (url.pathname.endsWith("/calendarList")) return new Response(oversized);
    throw new Error("Unexpected request");
  };

  await assert.rejects(
    fetchGoogleBusyIntervals(CREDENTIALS, WINDOW_START, WINDOW_END, { fetcher }),
    /Google request failed/,
  );
});
