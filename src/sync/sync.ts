import { parseLessons, PlannerError } from '../planner/parse.js';
import type { PlannerApi } from '../planner/client.js';
import type { ConfigStore } from '../store/config-store.js';
import type { SnapshotStore, Snapshot, CalendarData, CalendarRun, RunSummary, SyncTrigger } from '../store/snapshot-store.js';
import type { RoomInfo } from '../domain/model.js';
import type { CalendarId } from '../domain/primitives.js';
import { romeDay, romeMidnight, addDays } from '../availability/time.js';
import type { Logger } from '../log.js';

export const WINDOW_DAYS_BACK = 7;
export const WINDOW_DAYS_AHEAD = 15;
const CONCURRENCY = 3;

interface Deps {
  api: PlannerApi;
  config: ConfigStore;
  snapshots: SnapshotStore;
  log: Logger;
  now?: () => number;
  pauseMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function failureCode(err: unknown): string {
  return err instanceof PlannerError ? err.code : 'unexpected';
}

export class SyncService {
  private state: 'idle' | 'running' = 'idle';
  private readonly now: () => number;
  private readonly pauseMs: number;

  constructor(private readonly deps: Deps) {
    this.now = deps.now ?? Date.now;
    this.pauseMs = deps.pauseMs ?? 300;
  }

  get running(): boolean {
    return this.state === 'running';
  }

  // Returns null when a run is already in progress.
  async run(trigger: SyncTrigger): Promise<RunSummary | null> {
    if (this.state === 'running') return null;
    this.state = 'running';
    try {
      return await this.execute(trigger);
    } finally {
      this.state = 'idle';
    }
  }

  private async execute(trigger: SyncTrigger): Promise<RunSummary> {
    const { api, config, snapshots, log } = this.deps;
    const startedAt = this.now();
    const previous = snapshots.current;
    const today = romeDay(startedAt);
    const from = romeMidnight(addDays(today, -WINDOW_DAYS_BACK));
    const to = romeMidnight(addDays(today, WINDOW_DAYS_AHEAD));
    const active = config.current.calendars.filter((c) => c.active).map((c) => c.id);
    log.info('sync_started', { trigger, calendars: active.length });

    let clientId: string;
    try {
      clientId = await api.clientId();
    } catch (err) {
      const summary = this.summary(trigger, startedAt, 'failed', failureCode(err), 0, active.length);
      await this.persist({ ...previous, lastRun: summary });
      log.error('sync_failed', { failure: summary.failure });
      return summary;
    }

    const calendars: Record<string, CalendarData> = {};
    const runs: Record<string, CalendarRun> = {};
    const rooms: Record<string, RoomInfo> = { ...previous.rooms };
    let ok = 0;
    let failed = 0;

    const fetchOne = async (id: CalendarId) => {
      try {
        const parsed = parseLessons(await api.calendarEvents(id, clientId, from, to));
        calendars[id] = { fetchedAt: this.now(), from, to, lessons: parsed.lessons };
        for (const room of parsed.rooms) rooms[room.id] = room;
        runs[id] = { at: this.now(), outcome: 'ok', failure: null, lessons: parsed.lessons.length };
        ok += 1;
        if (parsed.skipped > 0) log.warn('calendar_entries_skipped', { calendar: id, skipped: parsed.skipped });
      } catch (err) {
        const kept = previous.calendars[id];
        if (kept) calendars[id] = kept;
        runs[id] = { at: this.now(), outcome: 'failed', failure: failureCode(err), lessons: kept?.lessons.length ?? 0 };
        failed += 1;
        log.warn('calendar_sync_failed', { calendar: id, failure: failureCode(err) });
      }
    };

    const queue = [...active];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        await fetchOne(id);
        if (this.pauseMs > 0) await sleep(this.pauseMs);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, active.length) }, worker));

    const referenced = new Set<string>();
    for (const cal of Object.values(calendars)) for (const l of cal.lessons) for (const r of l.roomIds) referenced.add(r);
    const keptRooms = Object.fromEntries(Object.entries(rooms).filter(([id]) => referenced.has(id)));

    const summary = this.summary(trigger, startedAt, 'completed', null, ok, failed);
    const saved = await this.persist({ version: 1, rooms: keptRooms, calendars, runs, lastRun: summary });
    if (!saved) return { ...summary, outcome: 'failed', failure: 'write_failed' };
    log.info('sync_finished', { trigger, ok, failed, rooms: Object.keys(keptRooms).length });
    return summary;
  }

  private summary(
    trigger: SyncTrigger,
    startedAt: number,
    outcome: RunSummary['outcome'],
    failure: string | null,
    ok: number,
    failed: number,
  ): RunSummary {
    return { trigger, startedAt, finishedAt: this.now(), outcome, failure, ok, failed };
  }

  private async persist(next: Snapshot): Promise<boolean> {
    try {
      await this.deps.snapshots.save(next);
      return true;
    } catch {
      this.deps.log.error('snapshot_write_failed');
      return false;
    }
  }
}
