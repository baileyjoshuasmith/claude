import { google } from 'googleapis';
import { DateTime } from 'luxon';
import { config } from '../lib/config.js';
import { db } from '../lib/db.js';

const upsertRawEvent = db.prepare(`
  INSERT INTO raw_events
    (source, source_calendar, source_uid, title, description, location, start_at, end_at, all_day, raw_json, fetched_at)
  VALUES
    ('google', @source_calendar, @source_uid, @title, @description, @location, @start_at, @end_at, @all_day, @raw_json, @fetched_at)
  ON CONFLICT(source, source_calendar, source_uid) DO UPDATE SET
    title = excluded.title,
    description = excluded.description,
    location = excluded.location,
    start_at = excluded.start_at,
    end_at = excluded.end_at,
    all_day = excluded.all_day,
    raw_json = excluded.raw_json,
    fetched_at = excluded.fetched_at
`);

function buildClient() {
  if (!config.google.clientId || !config.google.clientSecret || !config.google.refreshToken) {
    throw new Error(
      'Google Calendar is not configured yet. Set GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env, ' +
        'then run `npm run google:auth` to obtain GOOGLE_REFRESH_TOKEN.'
    );
  }

  const client = new google.auth.OAuth2(config.google.clientId, config.google.clientSecret);
  client.setCredentials({ refresh_token: config.google.refreshToken });
  return client;
}

/**
 * Pulls events from every calendar the user has visible ("selected") in
 * their Google Calendar UI, for the next `daysAhead` days, and upserts
 * them into raw_events. Returns a summary of what was synced.
 */
export async function syncGoogleCalendar({ daysAhead = 30 } = {}) {
  const auth = buildClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const calendarList = await calendar.calendarList.list();
  const calendars = (calendarList.data.items || []).filter((cal) => cal.selected !== false);

  const timeMin = DateTime.now().toISO();
  const timeMax = DateTime.now().plus({ days: daysAhead }).toISO();
  const fetchedAt = DateTime.now().toISO();

  let totalEvents = 0;
  const perCalendar = [];

  for (const cal of calendars) {
    const events = await calendar.events.list({
      calendarId: cal.id,
      timeMin,
      timeMax,
      singleEvents: true, // expands recurring events into individual instances
      orderBy: 'startTime',
      maxResults: 2500,
    });

    const items = events.data.items || [];

    for (const event of items) {
      if (event.status === 'cancelled') continue;

      const isAllDay = Boolean(event.start?.date && !event.start?.dateTime);
      const startAt = event.start?.dateTime || event.start?.date;
      const endAt = event.end?.dateTime || event.end?.date || null;

      if (!startAt) continue; // skip malformed events with no start

      upsertRawEvent.run({
        source_calendar: cal.id,
        source_uid: event.id,
        title: event.summary || '(untitled)',
        description: event.description || null,
        location: event.location || null,
        start_at: startAt,
        end_at: endAt,
        all_day: isAllDay ? 1 : 0,
        raw_json: JSON.stringify(event),
        fetched_at: fetchedAt,
      });
    }

    totalEvents += items.length;
    perCalendar.push({ calendar: cal.summary, count: items.length });
  }

  return { totalEvents, perCalendar };
}
