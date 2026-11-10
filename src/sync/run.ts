// One sync run: Planner feeds first, then the other sources, everything written through a SyncTarget.
import type { Logger } from '../log.js';
import type { CalendarId, PlannerId } from '../domain/primitives.js';
import { SOURCE_KINDS, SourceError, type Feed, type FetchContext, type SourceAdapter, type SourceFailure, type SourceKind } from '../sources/types.js';
import { buildPayload, type CalendarPayload } from './payload.js';
import { TargetError } from './pg-target.js';

export { TargetError };

export type SyncTrigger = 'schedule' | 'poll' | 'manual';
export type CalendarFailure = Exclude<SourceFailure, 'client_id'> | 'rejected' | 'unsupported';
export type AbortFailure = 'client_id' | 'network' | 'timeout' | 'http_status' | 'too_large' | 'bad_json' | 'bad_shape' | 'unexpected';

export interface DirectoryRoom {
  id: PlannerId;
  buildingKey: string;
  roomKey: string;
}

export interface SyncStart {
  run: number;
  from: number;
  to: number;
  calendars: Feed[];
  rooms: DirectoryRoom[];
}

export interface SyncSummary {
  run: number;
  state: 'finished' | 'aborted';
  failure: 'implausible' | null;
  ok: number;
  failed: number;
  rooms: number | null;
  lessons: number | null;
}

export interface SyncTarget {
  begin(trigger: SyncTrigger): Promise<SyncStart | { skipped: 'run_open' | 'too_soon' }>;
  put(run: number, calendar: CalendarId, payload: CalendarPayload): Promise<void>;
  fail(run: number, calendar: CalendarId, failure: CalendarFailure): Promise<void>;
  finish(run: number): Promise<SyncSummary>;
  abort(run: number, failure: AbortFailure): Promise<void>;
}

export type SyncResult =
  | { kind: 'skipped'; reason: 'run_open' | 'too_soon' }
  | { kind: 'aborted'; run: number; failure: AbortFailure | 'implausible' }
  | { kind: 'finished'; summary: SyncSummary };

interface Deps {
  adapters: Partial<Record<SourceKind, SourceAdapter>>;
  target: SyncTarget;
  log: Logger;
  pauseMs?: number;
}

const CONCURRENCY = 3;
const ABORT_CODES: ReadonlySet<string> = new Set<AbortFailure>([
  'client_id',
  'network',
  'timeout',
  'http_status',
  'too_large',
  'bad_json',
  'bad_shape',
  'unexpected',
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function calendarFailure(err: unknown): CalendarFailure {
  if (!(err instanceof SourceError) || err.code === 'client_id') return 'unexpected';
  return err.code;
}

function abortFailure(err: unknown): AbortFailure {
  return err instanceof SourceError && ABORT_CODES.has(err.code) ? (err.code as AbortFailure) : 'unexpected';
}

// A key seen with two different ids is ambiguous: the other source gets a synthetic room instead of a wrong merge.
class RoomDirectory {
  private readonly ids = new Map<string, PlannerId | null>();

  add(buildingKey: string, roomKey: string, id: PlannerId): void {
    if (!buildingKey || !roomKey) return;
    const key = `${buildingKey}|${roomKey}`;
    const known = this.ids.get(key);
    if (known === undefined) this.ids.set(key, id);
    else if (known !== id) this.ids.set(key, null);
  }

  resolved(): ReadonlyMap<string, PlannerId> {
    const out = new Map<string, PlannerId>();
    for (const [key, id] of this.ids) if (id !== null) out.set(key, id);
    return out;
  }
}

export async function runSync(deps: Deps, trigger: SyncTrigger): Promise<SyncResult> {
  const { adapters, target, log } = deps;
  const pauseMs = deps.pauseMs ?? 300;

  const start = await target.begin(trigger);
  if ('skipped' in start) {
    log.info('sync_skipped', { reason: start.skipped });
    return { kind: 'skipped', reason: start.skipped };
  }
  const { run } = start;
  log.info('sync_started', { run, trigger, calendars: start.calendars.length });

  let fatal: { error: unknown } | null = null;

  const failFeed = async (feed: Feed, failure: CalendarFailure) => {
    log.warn('calendar_failed', { calendar: feed.id, failure });
    await target.fail(run, feed.id, failure);
  };

  const syncFeed = async (adapter: SourceAdapter, feed: Feed, ctx: FetchContext): Promise<CalendarPayload | null> => {
    let payload: CalendarPayload;
    try {
      const data = await adapter.fetch(feed, ctx);
      payload = buildPayload(data.parsed, data.from, data.to);
    } catch (err) {
      await failFeed(feed, calendarFailure(err));
      return null;
    }
    if (payload.skipped > 0) log.warn('calendar_entries_skipped', { calendar: feed.id, skipped: payload.skipped });
    try {
      await target.put(run, feed.id, payload);
    } catch (err) {
      if (!(err instanceof TargetError) || !err.code.startsWith('payload_')) throw err;
      log.warn('calendar_rejected', { calendar: feed.id, code: err.code });
      await target.fail(run, feed.id, 'rejected');
      return null;
    }
    return payload;
  };

  // Up to 3 feeds in flight; a target error stops every worker before its next feed.
  const syncAll = async (adapter: SourceAdapter, feeds: readonly Feed[], ctx: FetchContext, onPut?: (p: CalendarPayload) => void) => {
    const queue = [...feeds];
    const worker = async () => {
      for (let feed = queue.shift(); feed && !fatal; feed = queue.shift()) {
        try {
          const payload = await syncFeed(adapter, feed, ctx);
          if (payload && onPut) onPut(payload);
        } catch (error) {
          fatal ??= { error };
          return;
        }
        if (pauseMs > 0) await sleep(pauseMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, feeds.length) }, worker));
    if (fatal) throw fatal.error;
  };

  const directory = new RoomDirectory();
  for (const room of start.rooms) directory.add(room.buildingKey, room.roomKey, room.id);

  const plannerFeeds = start.calendars.filter((f) => f.source === 'planner');
  const planner = adapters.planner;
  if (plannerFeeds.length > 0 && !planner) {
    for (const feed of plannerFeeds) await failFeed(feed, 'unsupported');
  } else if (plannerFeeds.length > 0 && planner) {
    try {
      await planner.prepare();
    } catch (err) {
      const failure = abortFailure(err);
      await target.abort(run, failure);
      log.error('sync_aborted', { run, failure });
      return { kind: 'aborted', run, failure };
    }
    const ctx: FetchContext = { from: start.from, to: start.to, plannerRooms: new Map() };
    await syncAll(planner, plannerFeeds, ctx, (payload) => {
      for (const room of payload.rooms) {
        if (room.buildingKeyGuess) directory.add(room.buildingKeyGuess, room.roomKey, room.id as PlannerId);
      }
    });
  }

  const ctx: FetchContext = { from: start.from, to: start.to, plannerRooms: directory.resolved() };
  for (const kind of SOURCE_KINDS) {
    if (kind === 'planner') continue;
    const feeds = start.calendars.filter((f) => f.source === kind);
    if (feeds.length === 0) continue;
    const adapter = adapters[kind];
    if (!adapter) {
      for (const feed of feeds) await failFeed(feed, 'unsupported');
      continue;
    }
    try {
      await adapter.prepare();
    } catch (err) {
      const failure = calendarFailure(err);
      for (const feed of feeds) await failFeed(feed, failure);
      continue;
    }
    await syncAll(adapter, feeds, ctx);
  }

  const summary = await target.finish(run);
  if (summary.state === 'aborted') {
    log.error('sync_aborted', { run, failure: 'implausible' });
    return { kind: 'aborted', run, failure: 'implausible' };
  }
  log.info('sync_finished', { run, ok: summary.ok, failed: summary.failed, rooms: summary.rooms, lessons: summary.lessons });
  return { kind: 'finished', summary };
}
