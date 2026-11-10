// Scans the source pages for new Planner calendars and stores them as proposals an admin confirms.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { consoleLogger as log } from '../log.js';
import { dbSettings, EnvError, type DbSettings } from '../settings.js';
import { caReader, openDb, TargetError, type Db } from '../sync/pg-target.js';
import { calendarId, label, sourceUrl, type CalendarId, type SourceUrl } from '../domain/primitives.js';
import { discover } from '../sync/discover.js';
import { plannerTitles } from '../sync/titles.js';
import { createPlannerApi } from '../planner/client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAX_SOURCES = 60;
const MAX_ITEMS = 600;
const LONE_SURROGATE = /\p{Cs}/u;

function config(): DbSettings | null {
  for (const field of ['NODE_OPTIONS', 'NODE_PATH']) {
    if (process.env[field]) {
      log.error('config_invalid', { field });
      return null;
    }
  }
  try {
    return dbSettings(process.env, caReader(ROOT));
  } catch (err) {
    log.error('config_invalid', { field: err instanceof EnvError ? err.message : 'unknown' });
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

// Only canonical source URLs: put_proposals accepts sources already stored, byte for byte.
function parseBegin(v: unknown): { sources: SourceUrl[]; dropped: number; known: Set<CalendarId> } {
  if (!isRecord(v) || !Array.isArray(v.sources) || v.sources.length > MAX_SOURCES || !Array.isArray(v.known)) {
    throw new TargetError('bad_response');
  }
  const sources: SourceUrl[] = [];
  let dropped = 0;
  for (const raw of v.sources) {
    try {
      const url = sourceUrl(raw);
      if (url !== raw || sources.includes(url)) throw new Error('not canonical');
      sources.push(url);
    } catch {
      dropped += 1;
    }
  }
  const known = new Set<CalendarId>();
  for (const raw of v.known) {
    try {
      known.add(calendarId(raw));
    } catch {
      throw new TargetError('bad_response');
    }
  }
  return { sources, dropped, known };
}

function safeLabel(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const l = label(value);
    return LONE_SURROGATE.test(l) ? null : l;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const settings = config();
  if (!settings) return 2;
  let db: Db;
  try {
    db = await openDb(settings);
  } catch (err) {
    log.error('db_failed', { code: err instanceof TargetError ? err.code : 'unknown' });
    return 4;
  }
  try {
    let begin: unknown;
    try {
      begin = await db.call('discover_begin');
    } catch (err) {
      if (err instanceof TargetError && err.code === 'too_soon') {
        log.info('discover_skipped', { reason: 'too_soon' });
        return 0;
      }
      throw err;
    }
    const { sources, dropped, known } = parseBegin(begin);
    if (dropped > 0) log.warn('discover_sources_dropped', { dropped });
    log.info('discover_started', { sources: sources.length });

    const result = await discover(sources);
    const fresh = result.found.filter((f) => !known.has(f.id)).slice(0, MAX_ITEMS);
    const titles = await plannerTitles(createPlannerApi(), fresh.map((f) => f.id));
    const items = fresh.map((f) => ({
      id: f.id,
      label: safeLabel(titles.get(f.id)) ?? safeLabel(f.label) ?? `Calendario ${f.id}`,
      source: f.source,
    }));
    const failures = result.failures.map((f) => ({ source: f.source, failure: f.failure }));
    for (const f of failures) log.warn('discover_page_failed', { failure: f.failure });

    const answer = await db.call('put_proposals', [{ items, failures }]);
    const found = isRecord(answer) && Number.isSafeInteger(answer.found) ? (answer.found as number) : null;
    if (found === null) throw new TargetError('bad_response');
    log.info('discover_finished', { found, failures: failures.length });
    return 0;
  } catch (err) {
    if (err instanceof TargetError) {
      log.error('db_failed', { code: err.code });
      return 4;
    }
    log.error('discover_cli_failed', { kind: err instanceof Error ? err.name : 'unknown' });
    return 1;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log.error('discover_cli_failed', { kind: err instanceof Error ? err.name : 'unknown' });
    process.exitCode = 1;
  },
);
