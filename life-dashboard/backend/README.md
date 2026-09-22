# Life Dashboard — Backend

Current state: **Google Calendar sync + Apple Calendar (CalDAV) sync + merge/dedupe**.
Nothing else is wired up yet — no prioritization engine, no dashboard, no widget.
Those come next, per the agreed build order (calendar sync → other confirmed
integrations → prioritization engine → dashboard → widget).

## What this does right now

`npm run sync:all` pulls upcoming events (next 60 days) from your Google
Calendar and iCloud calendars, stores the raw copies in `raw_events`, then
runs a merge pass that:
- groups events that are almost certainly the same thing shown twice (same
  normalized title, start time within 15 minutes, same all-day-ness),
- picks one canonical version per group (preferring Google, then Apple,
  then Learn.UQ, but keeping any location/description a lower-priority
  duplicate had that the winner was missing),
- writes the result to the `events` table,
- and — importantly — preserves anything you've already done to an event
  (dismissed, snoozed, categorized) across re-syncs, matching it up by
  which raw events it's made of, so re-running sync doesn't reset state.

## Setup

```bash
npm install
cp .env.example .env
```

### 1. Google Calendar

1. Go to https://console.cloud.google.com/apis/credentials (create a project if you don't have one).
2. Enable the "Google Calendar API" for that project (APIs & Services > Library).
3. Create an OAuth client: Credentials > Create Credentials > OAuth client ID > **Desktop app**.
4. Add `http://localhost:8991/oauth2callback` as an authorized redirect URI on that client.
5. Put the client ID and secret into `.env` as `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
6. Run `npm run google:auth` **on a machine with a browser and localhost access** (your laptop, not a headless server). It opens a consent screen, and on approval saves `GOOGLE_REFRESH_TOKEN` into `.env` automatically.

This only reads your calendar (`calendar.readonly` scope) — it can't create, edit, or delete events.

### 2. Apple Calendar (CalDAV)

1. Go to https://account.apple.com/account/manage > Sign-In and Security > App-Specific Passwords.
2. Generate one, label it something like "life-dashboard".
3. Put your Apple ID email and that password into `.env` as `APPLE_ID_EMAIL` / `APPLE_APP_SPECIFIC_PASSWORD`. **Not your normal Apple ID password** — Apple doesn't allow that for third-party apps.

Heads-up: if you ever change your Apple ID password, Apple silently revokes all app-specific passwords. If Apple sync starts failing, that's almost certainly why — generate a new one and update `.env`.

I haven't been able to test the Apple sync against a real iCloud account (no credentials available to me). Run `npm run sync:apple` once you've set this up and tell me what happens — if iCloud's CalDAV server behaves in some way I didn't anticipate, I'll fix it.

### 3. Run it

```bash
npm run sync:all
```

This syncs both calendars and runs the merge. You can also run `npm run sync:google` or `npm run sync:apple` individually. Data lands in `./data/life-dashboard.sqlite` (gitignored — it's your data, not something to commit).

## Known limitations (by design, for now)

- **No scheduling yet.** `sync:all` runs once and exits. Turning this into "runs automatically every N minutes" is a deliberate later step, once we decide where this backend actually lives long-term (your own machine kept on, a small VPS, etc.) — that decision also affects how the eventual widget reaches it over the network, so it's worth deciding deliberately rather than bolting on now.
- **CalDAV is poll-based.** Unlike Google, iCloud has no push notifications for calendar changes — every sync is "ask and see what changed," which is fine for a several-times-a-day refresh but not instant.
- **Recurring event overrides are handled on a best-effort basis.** If iCloud doesn't expand a recurring event server-side, we expand it locally and apply any single-occurrence overrides (a moved meeting, etc.) we can find — but a very unusual recurrence pattern could theoretically slip through. Flag it if you see a duplicate or missing occurrence.
- **Learn.UQ and Reminders aren't connected yet** — that's the next increment, per the agreed build order.
