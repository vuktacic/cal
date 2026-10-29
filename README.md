# cal

A shareable calendar for `cal.vuktacic.com`. It merges busy times from every
Google calendar you own, including hidden calendars and ones you create later.
Visitors see anonymous **Busy** blocks from Sunday of the current week through
at least the next 30 days, extended through Saturday of the final week. The
week boundaries use Vancouver time. Event names,
descriptions, locations, attendees, calendar names, and source identifiers are
never part of the public response.

The page shows three days at a time on screens up to 1050px wide, starting with
today and the next two days; larger screens show a week. Previous and Next move
by three days on smaller screens and by a week on larger screens. Today returns
to today's view and scrolls to 8 a.m. The calendar covers midnight through
midnight, with a sticky day header and shared time ruler, and highlights today
and the current time. The default time zone is Vancouver, with its current UTC
time zone selected initially and a toggle to the visitor's local time zone. Add to calendar
opens the `/busy.ics` feed, which can be subscribed to in a calendar app.
The Worker refreshes once a minute; visible browser tabs check every 15 seconds.
An unsuccessful refresh preserves the last complete snapshot briefly, marks it
stale, and hides availability after five minutes without a successful refresh.

## Local development

Requires Node.js 22.18+ and npm. No production JavaScript dependencies are needed.

```sh
npm ci
npm run check
npm test
npm run db:migrate:local
npm run dev
```

Without Google secrets, the page correctly reports that availability is
unavailable. See [setup instructions](docs/setup.md) for interactive Google
authorization and eventual Cloudflare setup. Build and validation commands do
not deploy the site or modify Google calendars.

```sh
npm run build
npm run dry-run
```

## Architecture

- `web/`: dependency-free browser calendar, built to static assets.
- `src/worker/`: scheduled Google availability reads and the public API.
- `src/shared/`: the minimal public response contract.
- `migrations/`: local and production D1 schema.
- `scripts/google-auth.mjs`: local consent helper for a separate limited OAuth client.

`GET /api/availability` returns `status`, `windowStart`, `windowEnd`, `updatedAt`,
and `busy: [{ start, end }]`, with timestamps in UTC. Fresh and stale snapshots
return HTTP 200; unavailable snapshots return HTTP 503. The API is not cached.
`GET /busy.ics` exposes the same merged availability as a subscribable iCalendar
feed. Every block is named `Busy`, with no original event or calendar metadata.
Use the feed URL as a calendar subscription; downloading and importing it once
does not keep the imported events updated. Calendar apps choose their own fetch
schedule, independently of the Worker's one-minute refresh.

The feed returns HTTP 503 when availability cannot be confirmed, rather than
publishing an empty calendar that might falsely imply free time. It offers no
calendar editing, booking, or original event details.

The static website, Worker, and small D1 snapshot are designed for Cloudflare's
free allowances. The initial setup requires measuring actual Worker CPU usage
and checking account quotas; $0 hosting is an expectation, not a billing guarantee.
No paid services are enabled by the repository tooling.

## Appearance

The calendar uses the Raw Web visual style by default. Legacy `?prototype=`
query parameters are ignored and display the same appearance.
