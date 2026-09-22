import { syncGoogleCalendar } from './google-calendar.js';

const summary = await syncGoogleCalendar();
console.log(`Synced ${summary.totalEvents} events from Google Calendar:`);
for (const cal of summary.perCalendar) {
  console.log(`  - ${cal.calendar}: ${cal.count}`);
}
