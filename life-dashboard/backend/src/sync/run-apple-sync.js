import { syncAppleCalendar } from './apple-caldav.js';

const summary = await syncAppleCalendar();
console.log(`Synced ${summary.totalEvents} events from Apple Calendar:`);
for (const cal of summary.perCalendar) {
  console.log(`  - ${cal.calendar}: ${cal.count}`);
}
