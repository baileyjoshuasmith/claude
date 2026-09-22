import { syncGoogleCalendar } from './google-calendar.js';
import { syncAppleCalendar } from './apple-caldav.js';
import { runMerge } from './merge.js';

async function trySync(name, fn) {
  try {
    const summary = await fn();
    console.log(`${name}: synced ${summary.totalEvents} events`);
  } catch (err) {
    console.warn(`${name}: skipped (${err.message})`);
  }
}

await trySync('Google Calendar', syncGoogleCalendar);
await trySync('Apple Calendar', syncAppleCalendar);

const mergeSummary = runMerge();
console.log(
  `Merge: ${mergeSummary.rawEventCount} raw events -> ${mergeSummary.clusterCount} canonical events ` +
    `(${mergeSummary.created} new, ${mergeSummary.updated} updated, ${mergeSummary.removed} removed)`
);
