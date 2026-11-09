import type { PlannerApi } from '../planner/client.js';
import { parseCalendarTitle } from '../planner/parse.js';
import type { CalendarId } from '../domain/primitives.js';

// Official titles from the Planner, used to name calendars. A failure just leaves the old name.
export async function plannerTitles(api: PlannerApi, ids: readonly CalendarId[]): Promise<Map<CalendarId, string>> {
  const titles = new Map<CalendarId, string>();
  if (ids.length === 0) return titles;
  let clientId: string;
  try {
    clientId = await api.clientId();
  } catch {
    return titles;
  }
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.shift(); id; id = queue.shift()) {
      try {
        const title = parseCalendarTitle(await api.calendarInfo(id, clientId));
        if (title) titles.set(id, title);
      } catch {
        // keep the scraped label
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, ids.length) }, worker));
  return titles;
}
