# Setup

This guide covers local development and the private Google credential used by the availability Worker. The OAuth helper runs on the calendar owner's computer. It is not a public OAuth endpoint, a Google Workspace admin tool, or a way to read event titles and descriptions.

## Local development

Use Node.js 22.18 or newer from WSL, Linux, or macOS. Native Windows is not supported by the helper because it cannot enforce the required POSIX owner-only file permissions.

```sh
npm install
npm run build
npm test
npm run check
npm run db:migrate:local
npm run dev
```

The local Worker uses local D1 state. Local migrations do not change the remote database.

## Create a dedicated Google OAuth client

1. In Google Cloud, select the project that will own this availability integration and enable the Google Calendar API.
2. Configure the OAuth consent screen for the account that owns the calendars. If the account is outside the project's Workspace organization, use an External audience and add the owner as a test user while developing.
3. Create a new OAuth client with application type **Desktop app**, then download its client JSON.
4. Request only these scopes:

   - `https://www.googleapis.com/auth/calendar.calendarlist.readonly`
   - `https://www.googleapis.com/auth/calendar.events.freebusy`

   The first scope lists calendars; the second reads free/busy ranges. Google documents their meanings in its [Calendar API scope list](https://developers.google.com/workspace/calendar/api/auth). The helper also checks Google's token response and stops if the granted scopes are missing or broader than these two.

Use a fresh Desktop OAuth client for this site. You may create it in the same Google Cloud project as another integration, but do not reuse the client or token from cloop or any client that has Calendar write or Google Tasks permissions. The downloaded client JSON contains a client secret; keep it outside the repository.

The helper uses Google's installed-app authorization-code flow with a loopback redirect, unpredictable `state`, PKCE S256, offline access, and a consent prompt. See Google's [installed-app OAuth guide](https://developers.google.com/identity/protocols/oauth2/native-app). It binds only to `127.0.0.1` on an ephemeral port, waits up to five minutes, and does not log callback codes or token responses.

## Create the private credential file

Run the local helper with the downloaded Desktop client JSON:

```sh
npm run google:auth -- --client /path/to/client_secret_desktop.json
```

If the package script is unavailable, run `node scripts/google-auth.mjs --client /path/to/client_secret_desktop.json` directly. The helper prints an authorization URL and attempts to open it in the default browser. If no browser opens, copy the URL into one yourself, approve the two Calendar permissions, and return to the terminal. Press Ctrl-C to cancel.

On success, the helper writes `~/.config/public-availability/google-secrets.json`. It creates the app-specific directory with mode `0700` and the file with mode `0600`. It refuses repository paths, symlinks, unsafe directories, unexpected scopes, and an existing output file. To replace a file deliberately, pass `--force`:

```sh
npm run google:auth -- --client /path/to/client_secret_desktop.json --force
```

The JSON contains exactly the three Worker secrets `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REFRESH_TOKEN`. Keep this file and the downloaded client JSON private. Do not commit, paste, print, or send either file.

For local `wrangler dev`, create the ignored `.dev.vars` file from `.dev.vars.example`, restrict it to mode `0600`, and copy the three values from the private JSON into it with a local editor. Do not commit `.dev.vars`; the repository ignores it.

Google's consent-screen **Testing** status expires test-user authorizations after seven days, including offline refresh tokens for these Calendar scopes. For a continuously running Worker, configure the app for production use and check its verification status in Google Cloud before launch. Do not assume that verification is exempt. See Google's [app audience and publishing status guidance](https://support.google.com/cloud/answer/15549945?hl=en) and [scope verification guidance](https://developers.google.com/identity/protocols/oauth2/scopes).

## Provision and deploy the Worker

Sign in to Cloudflare with Wrangler, then create the D1 database named by the checked-in Wrangler config. An authenticated Cloudflare MCP connection is separate from Wrangler's local CLI login. For the current project setup, the intended name is `public-availability`:

```sh
npx wrangler login
npx wrangler d1 create public-availability
```

Set the returned database ID in the D1 binding in `wrangler.jsonc`, then apply local migrations for development and remote migrations for production. The remote command targets the database name or binding declared in that file:

```sh
npm run db:migrate:local
npx wrangler d1 migrations apply public-availability --remote
```

Upload the private credential file as Worker secrets. Wrangler reads the values from the file; the values do not appear in the command line:

```sh
npx wrangler secret bulk ~/.config/public-availability/google-secrets.json
```

Build and deploy after the D1 binding, migrations, and secrets are ready:

```sh
npm run build
npx wrangler deploy
```

The Worker serves the static site through its `ASSETS` binding and reads availability from D1 and Google Calendar. Do not put the OAuth client JSON, refresh token, or Worker secrets into source files, `wrangler.jsonc`, a public asset directory, or a browser bundle.

The current `wrangler.jsonc` disables Workers.dev URLs and has no public route. `wrangler deploy` uploads the Worker but does not attach a public URL. Once the private setup has been verified and publication is authorized, add this top-level setting to `wrangler.jsonc`, then deploy:

```json
"routes": [{ "pattern": "cal.vuktacic.com", "custom_domain": true }]
```

Cloudflare will provision the custom-domain DNS record and certificate in your existing zone. Check that the hostname is unused first, and verify HTTPS and the public response after it becomes active.

## Check the calendar and public behavior

After OAuth setup, confirm the Worker sees the owner's 12 owned calendars, including hidden owned calendars, and picks up newly owned calendars. Subscribed calendars are excluded. In particular, subscription-only calendars such as Holidays in Canada should not be treated as owned calendars or published as availability sources.

The public view is a plain Sunday–Saturday grid with previous, next, and today controls. It initially shows 8 a.m.–8 p.m., while scrolling up or down reaches the full midnight-to-midnight day. The time ruler stays on the left and day headings stay visible while scrolling. It exposes busy windows only, without event names, descriptions, attendees, or other event details. Past busy times remain visible back to Sunday midnight in Vancouver for the current week, alongside at least the next 30 days and through Saturday of the final week. Older weeks are excluded when Sunday rolls over. The UI checks for updates every 15 seconds; the Worker refresh target is once per minute. Visitors can switch between Vancouver time and their local time.

Before launch, verify these behaviors against the deployed Worker and inspect its CPU usage. The Workers Free plan currently limits both HTTP and scheduled invocations to 10 ms of CPU time; network waiting does not count as CPU time. Measure real usage below that ceiling before relying on free hosting. D1's current Free plan allowance is 100,000 rows written per day, so keep refresh writes below that limit and monitor actual usage. Check [current Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Workers and D1 pricing](https://developers.cloudflare.com/workers/platform/pricing/) before deployment; this budget assumes Free plan service and no paid-plan upgrade.

## Subscribe to busy.ics

Once published, `https://cal.vuktacic.com/busy.ics` serves a standard iCalendar subscription feed from the same stored merged snapshot. Each time block is an anonymous `Busy` event. Serving it requires one snapshot read and formatting; it does not poll Google or add database writes for each subscriber.

Run `npm run benchmark:ics` to measure formatting CPU for a synthetic 100-block feed on your computer. This excludes D1 and other request work, so it is a regression check rather than a Cloudflare CPU guarantee.

Add that URL as a subscription in a calendar app. In Google Calendar on desktop, use **Other calendars → Add → From URL**. A one-time file import does not stay in sync. The feed includes the same current-week history and full final week as the website. Older weeks are removed from the served feed each Sunday; it is not a permanent historical archive.

The server refreshes its source data once a minute, but each subscribing calendar app controls when it refetches the URL. A subscription is therefore not guaranteed to update as quickly as the website. If source data becomes unavailable, the feed returns HTTP 503 rather than a successful empty calendar. Clients can retain their previous copy during an outage.

A Google Calendar iframe displays calendars hosted by Google. Embedding the existing private calendars would require changing their public sharing; preserving a single anonymized merged calendar would instead require a separate public Google calendar and an additional write-sync integration. This implementation keeps the source access read-only and renders the weekly grid directly.
