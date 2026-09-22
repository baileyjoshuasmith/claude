import { createDAVClient } from 'tsdav';
import ical from 'node-ical';
import { DateTime } from 'luxon';
import { config } from '../lib/config.js';
import { db } from '../lib/db.js';

const upsertRawEvent = db.prepare(`
  INSERT INTO raw_events
    (source, source_calendar, source_uid, title, description, location, start_at, end_at, all_day, raw_json, fetched_at)
  VALUES
    ('apple', @source_calendar, @source_uid, @title, @description, @location, @start_at, @end_at, @all_day, @raw_json, @fetched_at)
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

async function buildClient() {
  if (!config.apple.email || !config.apple.appSpecificPassword) {
    throw new Error(
      'Apple Calendar is not configured yet. Set APPLE_ID_EMAIL and APPLE_APP_SPECIFIC_PASSWORD ' +
        'in .env (generate the app-specific password at https://account.apple.com/account/manage ' +
        '> Sign-In and Security > App-Specific Passwords).'
    );
  }

  return createDAVClient({
    serverUrl: 'https://caldav.icloud.com',
    credentials: {
      username: config.apple.email,
      password: config.apple.appSpecificPassword,
    },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  });
}

/**
 * Pulls events from every iCloud calendar for the next `daysAhead` days and
 * upserts them into raw_events. Asks the server to expand recurring events
 * (iCloud supports CalDAV's expand); for the rare case a calendar object
 * still comes back as a bare recurrence rule, we expand it ourselves.
 */
export async function syncAppleCalendar({ daysAhead = 30 } = {}) {
  const client = await buildClient();
  const calendars = await client.fetchCalendars();

  const rangeStart = DateTime.now().startOf('day');
  const rangeEnd = rangeStart.plus({ days: daysAhead });
  const fetchedAt = DateTime.now().toISO();

  let totalEvents = 0;
  const perCalendar = [];

  for (const cal of calendars) {
    if (cal.components && !cal.components.includes('VEVENT')) continue;

    const objects = await client.fetchCalendarObjects({
      calendar: cal,
      expand: true,
      timeRange: { start: rangeStart.toUTC().toISO(), end: rangeEnd.toUTC().toISO() },
    });

    let countForCalendar = 0;

    for (const obj of objects) {
      if (!obj.data) continue;

      const parsed = ical.parseICS(obj.data);

      for (const component of Object.values(parsed)) {
        if (component.type !== 'VEVENT') continue;

        for (const instance of expandInstances(component, rangeStart, rangeEnd)) {
          upsertRawEvent.run({
            source_calendar: cal.url,
            source_uid: instance.uid,
            title: instance.title || '(untitled)',
            description: instance.description,
            location: instance.location,
            start_at: instance.start,
            end_at: instance.end,
            all_day: instance.allDay ? 1 : 0,
            raw_json: JSON.stringify({ url: obj.url, etag: obj.etag }),
            fetched_at: fetchedAt,
          });
          countForCalendar += 1;
        }
      }
    }

    totalEvents += countForCalendar;
    perCalendar.push({ calendar: cal.displayName || cal.url, count: countForCalendar });
  }

  return { totalEvents, perCalendar };
}

function expandInstances(component, rangeStart, rangeEnd) {
  const allDay = component.datetype === 'date';

  if (!component.rrule) {
    return [toInstance(component, allDay)];
  }

  const durationMs =
    component.end && component.start ? component.end.getTime() - component.start.getTime() : 0;
  const exceptionDates = new Set(
    Object.values(component.exdate || {}).map((d) => d.toISOString())
  );
  const recurrences = component.recurrences || {};

  const occurrenceStarts = component.rrule.between(rangeStart.toJSDate(), rangeEnd.toJSDate(), true);

  return occurrenceStarts
    .filter((date) => !exceptionDates.has(date.toISOString()))
    .map((date) => {
      // An override (time/title changed for this one occurrence) takes
      // priority over the computed recurrence.
      const override = recurrences[date.toISOString().slice(0, 10)];
      if (override) return toInstance(override, override.datetype === 'date', date);

      return {
        uid: `${component.uid}-${date.toISOString()}`,
        title: component.summary,
        description: component.description || null,
        location: component.location || null,
        start: date.toISOString(),
        end: new Date(date.getTime() + durationMs).toISOString(),
        allDay,
      };
    });
}

function toInstance(component, allDay, fallbackDate) {
  const start = component.start || fallbackDate;
  return {
    uid: component.uid + (component.recurrenceid ? `-${component.recurrenceid.toISOString()}` : ''),
    title: component.summary,
    description: component.description || null,
    location: component.location || null,
    start: start.toISOString(),
    end: component.end ? component.end.toISOString() : null,
    allDay,
  };
}
