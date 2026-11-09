import { atomicWriteJson, readJsonFile, backupCorrupt } from './files.js';
import type { Lesson, RoomInfo } from '../domain/model.js';
import type { Logger } from '../log.js';

export type SyncTrigger = 'startup' | 'schedule' | 'admin';

export interface CalendarData {
  fetchedAt: number;
  from: number;
  to: number;
  lessons: Lesson[];
}

export interface CalendarRun {
  at: number;
  outcome: 'ok' | 'failed';
  failure: string | null;
  lessons: number;
}

export interface RunSummary {
  trigger: SyncTrigger;
  startedAt: number;
  finishedAt: number;
  outcome: 'completed' | 'failed';
  failure: string | null;
  ok: number;
  failed: number;
}

export interface Snapshot {
  version: 1;
  rooms: Record<string, RoomInfo>;
  calendars: Record<string, CalendarData>;
  runs: Record<string, CalendarRun>;
  lastRun: RunSummary | null;
}

export function emptySnapshot(): Snapshot {
  return { version: 1, rooms: {}, calendars: {}, runs: {}, lastRun: null };
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

function isLesson(v: unknown): v is Lesson {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.title === 'string' &&
    isNum(v.start) &&
    isNum(v.end) &&
    (v.status === 'active' || v.status === 'cancelled') &&
    typeof v.kind === 'string' &&
    isStrArray(v.courses) &&
    (v.year === null || isNum(v.year)) &&
    isStrArray(v.teachers) &&
    isStrArray(v.roomIds)
  );
}

function isRoom(v: unknown): v is RoomInfo {
  return (
    isRecord(v) &&
    typeof v.id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.code === 'string' &&
    typeof v.buildingName === 'string' &&
    (v.capacity === null || isNum(v.capacity)) &&
    (v.effectiveCapacity === null || isNum(v.effectiveCapacity)) &&
    isStrArray(v.services)
  );
}

// Derived data that we can always download again: keep what is well formed, drop the rest.
function revive(value: unknown): Snapshot | null {
  if (!isRecord(value) || value.version !== 1) return null;
  if (!isRecord(value.rooms) || !isRecord(value.calendars) || !isRecord(value.runs)) return null;
  const out = emptySnapshot();
  for (const [id, room] of Object.entries(value.rooms)) if (isRoom(room) && room.id === id) out.rooms[id] = room;
  for (const [id, cal] of Object.entries(value.calendars)) {
    if (!isRecord(cal) || !isNum(cal.fetchedAt) || !isNum(cal.from) || !isNum(cal.to) || !Array.isArray(cal.lessons)) continue;
    out.calendars[id] = { fetchedAt: cal.fetchedAt, from: cal.from, to: cal.to, lessons: cal.lessons.filter(isLesson) };
  }
  for (const [id, run] of Object.entries(value.runs)) {
    if (!isRecord(run) || !isNum(run.at) || !isNum(run.lessons)) continue;
    if (run.outcome !== 'ok' && run.outcome !== 'failed') continue;
    out.runs[id] = { at: run.at, outcome: run.outcome, failure: typeof run.failure === 'string' ? run.failure : null, lessons: run.lessons };
  }
  const last = value.lastRun;
  if (isRecord(last) && isNum(last.startedAt) && isNum(last.finishedAt) && isNum(last.ok) && isNum(last.failed)) {
    out.lastRun = {
      trigger: last.trigger === 'startup' || last.trigger === 'schedule' ? last.trigger : 'admin',
      startedAt: last.startedAt,
      finishedAt: last.finishedAt,
      outcome: last.outcome === 'completed' ? 'completed' : 'failed',
      failure: typeof last.failure === 'string' ? last.failure : null,
      ok: last.ok,
      failed: last.failed,
    };
  }
  return out;
}

export class SnapshotStore {
  private snapshot: Snapshot;

  private constructor(private readonly path: string, snapshot: Snapshot) {
    this.snapshot = snapshot;
  }

  static async open(path: string, log: Logger): Promise<SnapshotStore> {
    const read = await readJsonFile(path);
    if (read.kind === 'missing') return new SnapshotStore(path, emptySnapshot());
    const revived = read.kind === 'ok' ? revive(read.value) : null;
    if (revived) return new SnapshotStore(path, revived);
    await backupCorrupt(path);
    log.error('snapshot_corrupt_reset');
    return new SnapshotStore(path, emptySnapshot());
  }

  get current(): Snapshot {
    return this.snapshot;
  }

  async save(next: Snapshot): Promise<void> {
    await atomicWriteJson(this.path, next);
    this.snapshot = next;
  }
}
