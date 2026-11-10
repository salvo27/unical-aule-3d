import type { PlannerApi } from '../planner/client.js';
import { parseCalendarTitle } from '../planner/parse.js';
import type { CalendarId } from '../domain/primitives.js';

export interface TitleOptions {
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Official titles from the Planner, used to name calendars. A failure just leaves the old name.
// Up to 3 requests in flight, each worker pauses between its requests.
export async function plannerTitles(api: PlannerApi, ids: readonly CalendarId[], options: TitleOptions = {}): Promise<Map<CalendarId, string>> {
  const pauseMs = options.pauseMs ?? 300;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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
    for (let id = queue.shift(), first = true; id; id = queue.shift(), first = false) {
      if (!first && pauseMs > 0) await sleep(pauseMs);
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
