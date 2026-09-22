import { DateTime } from 'luxon';
import { db } from '../lib/db.js';

// When the same event exists in more than one calendar source, prefer the
// source higher in this list as the canonical record.
const SOURCE_PRIORITY = ['google', 'apple', 'learnuq'];
const DUPLICATE_WINDOW_MINUTES = 15;
const SYNC_WINDOW_DAYS_PAST = 1;
const SYNC_WINDOW_DAYS_FUTURE = 60;

const getEventByRawIds = db.prepare(`SELECT * FROM events`);
const insertEvent = db.prepare(`
  INSERT INTO events
    (title, description, location, start_at, end_at, all_day, primary_raw_event_id,
     merged_raw_event_ids, category, status, snoozed_until, dismiss_count, last_interacted_at,
     created_at, updated_at)
  VALUES
    (@title, @description, @location, @start_at, @end_at, @all_day, @primary_raw_event_id,
     @merged_raw_event_ids, NULL, 'active', NULL, 0, NULL,
     @now, @now)
`);
const updateEvent = db.prepare(`
  UPDATE events SET
    title = @title,
    description = @description,
    location = @location,
    start_at = @start_at,
    end_at = @end_at,
    all_day = @all_day,
    primary_raw_event_id = @primary_raw_event_id,
    merged_raw_event_ids = @merged_raw_event_ids,
    updated_at = @now
  WHERE id = @id
`);
const deleteEvent = db.prepare(`DELETE FROM events WHERE id = ?`);

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a, b) {
  if (a === b) return 1;
  const wordsA = new Set(a.split(' ').filter(Boolean));
  const wordsB = new Set(b.split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  const intersection = [...wordsA].filter((w) => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return intersection / union;
}

function isLikelyDuplicate(a, b) {
  if (a.all_day !== b.all_day) return false;
  const startDiffMinutes =
    Math.abs(DateTime.fromISO(a.start_at).diff(DateTime.fromISO(b.start_at), 'minutes').minutes) || 0;
  if (startDiffMinutes > DUPLICATE_WINDOW_MINUTES) return false;
  return titleSimilarity(normalizeTitle(a.title), normalizeTitle(b.title)) >= 0.7;
}

function firstNonEmpty(cluster, field) {
  const withValue = cluster.find((e) => e[field]);
  return withValue ? withValue[field] : null;
}

function pickPrimary(cluster) {
  const withCompleteness = cluster.map((e) => ({
    event: e,
    priority: SOURCE_PRIORITY.indexOf(e.source),
    completeness: (e.location ? 1 : 0) + (e.description ? 1 : 0),
  }));

  withCompleteness.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.completeness - a.completeness;
  });

  return withCompleteness[0].event;
}

function clusterRawEvents(rawEvents) {
  const clusters = [];

  for (const raw of rawEvents) {
    const existing = clusters.find((cluster) =>
      cluster.some((member) => isLikelyDuplicate(member, raw))
    );
    if (existing) {
      existing.push(raw);
    } else {
      clusters.push([raw]);
    }
  }

  return clusters;
}

/**
 * Rebuilds the canonical `events` table from the current `raw_events`
 * snapshot: groups likely-duplicate events across sources, picks a primary
 * record per group, and preserves any existing user state (category,
 * status, snooze, dismiss count) for groups that already had a matching
 * canonical event.
 */
export function runMerge() {
  const windowStart = DateTime.now().minus({ days: SYNC_WINDOW_DAYS_PAST }).toISO();
  const windowEnd = DateTime.now().plus({ days: SYNC_WINDOW_DAYS_FUTURE }).toISO();

  const rawEvents = db
    .prepare(`SELECT * FROM raw_events WHERE start_at >= ? AND start_at <= ? ORDER BY start_at`)
    .all(windowStart, windowEnd);

  const clusters = clusterRawEvents(rawEvents);
  const existingEvents = getEventByRawIds.all();
  const now = DateTime.now().toISO();

  const seenEventIds = new Set();
  let created = 0;
  let updated = 0;

  for (const cluster of clusters) {
    const primary = pickPrimary(cluster);
    const mergedRawIds = cluster.map((e) => e.id).sort((a, b) => a - b);
    const mergedRawIdsJson = JSON.stringify(mergedRawIds);

    const match = existingEvents.find((existing) => {
      const existingIds = JSON.parse(existing.merged_raw_event_ids);
      return existingIds.some((id) => mergedRawIds.includes(id));
    });

    // Take title/time from the primary source, but don't lose detail a
    // lower-priority duplicate had that the primary didn't (e.g. Apple
    // copy has a location, Google copy of the same event doesn't).
    const payload = {
      title: primary.title,
      description: firstNonEmpty(cluster, 'description'),
      location: firstNonEmpty(cluster, 'location'),
      start_at: primary.start_at,
      end_at: primary.end_at,
      all_day: primary.all_day,
      primary_raw_event_id: primary.id,
      merged_raw_event_ids: mergedRawIdsJson,
      now,
    };

    if (match) {
      updateEvent.run({ ...payload, id: match.id });
      seenEventIds.add(match.id);
      updated += 1;
    } else {
      const result = insertEvent.run(payload);
      seenEventIds.add(Number(result.lastInsertRowid));
      created += 1;
    }
  }

  // Drop canonical events whose underlying raw events all disappeared
  // (deleted from the source, or fell out of the sync window).
  let removed = 0;
  for (const existing of existingEvents) {
    if (!seenEventIds.has(existing.id)) {
      deleteEvent.run(existing.id);
      removed += 1;
    }
  }

  return {
    rawEventCount: rawEvents.length,
    clusterCount: clusters.length,
    created,
    updated,
    removed,
  };
}
