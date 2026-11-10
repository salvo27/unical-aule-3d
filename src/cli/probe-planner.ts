// Does the Planner answer from here? Reads 3 seed calendars, no database, no secrets.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { consoleLogger as log } from '../log.js';
import { calendarId, type CalendarId } from '../domain/primitives.js';
import { createPlannerApi } from '../planner/client.js';
import { parseLessons, PlannerError } from '../planner/parse.js';
import { romeDay, romeMidnight, addDays } from '../availability/time.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROBED = 3;

function seedCalendars(): CalendarId[] {
  const seed = JSON.parse(readFileSync(join(ROOT, 'config', 'seed.json'), 'utf8')) as unknown;
  const list = typeof seed === 'object' && seed !== null ? (seed as { calendars?: unknown }).calendars : undefined;
  if (!Array.isArray(list) || list.length === 0) throw new Error('seed');
  return list.slice(0, PROBED).map((c: unknown) => calendarId((c as { id?: unknown } | null)?.id));
}

const failureOf = (err: unknown) => (err instanceof PlannerError ? err.code : 'unexpected');

async function main(): Promise<number> {
  for (const field of ['NODE_OPTIONS', 'NODE_PATH']) {
    if (process.env[field]) {
      log.error('config_invalid', { field });
      return 2;
    }
  }
  let ids: CalendarId[];
  try {
    ids = seedCalendars();
  } catch {
    log.error('config_invalid', { field: 'seed' });
    return 2;
  }
  const today = romeDay(Date.now());
  const from = romeMidnight(addDays(today, -7));
  const to = romeMidnight(addDays(today, 15));
  const api = createPlannerApi();
  let clientId: string;
  try {
    clientId = await api.clientId();
  } catch (err) {
    for (const calendar of ids) log.error('probe_failed', { calendar, failure: failureOf(err) });
    return 1;
  }
  let ok = 0;
  for (const calendar of ids) {
    try {
      const parsed = parseLessons(await api.calendarEvents(calendar, clientId, from, to));
      log.info('probe_calendar', { calendar, lessons: parsed.lessons.length });
      ok += 1;
    } catch (err) {
      log.error('probe_failed', { calendar, failure: failureOf(err) });
    }
  }
  return ok > 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log.error('probe_cli_failed', { kind: err instanceof Error ? err.name : 'unknown' });
    process.exitCode = 1;
  },
);
