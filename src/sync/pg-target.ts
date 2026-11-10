// Postgres side of the sync: only the 8 aule_sync functions, closed error codes, TLS verify-full.
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import type { DbSettings } from '../settings.js';
import { calendarId, plannerId, type CalendarId, type PlannerId } from '../domain/primitives.js';
import { SOURCE_KINDS, type Feed, type SourceKind } from '../sources/types.js';
import type { CalendarPayload } from './payload.js';
import type {
  AbortFailure,
  CalendarFailure,
  DirectoryRoom,
  SyncStart,
  SyncSummary,
  SyncTarget,
  SyncTrigger,
} from './run.js';

export class TargetError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'TargetError';
    this.code = code;
  }
}

const SYNC_CODES = new Set([
  'invalid',
  'run_open',
  'run_missing',
  'run_closed',
  'calendar_unknown',
  'calendar_done',
  'payload_size',
  'payload_shape',
  'payload_value',
  'payload_window',
  'too_soon',
  'too_many_runs',
  'internal',
]);
const SQLSTATE_CODES: Record<string, string> = {
  '28P01': 'auth',
  '28000': 'auth',
  '57014': 'timeout',
  '42501': 'forbidden',
  '53300': 'connections',
};
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', 'EHOSTUNREACH']);
const TLS_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

// The message is read only to compare it with the closed list, never logged.
export function translatePgError(err: unknown): string {
  if (err instanceof TargetError) return err.code;
  if (typeof err !== 'object' || err === null) return 'unknown';
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'string') return 'unknown';
  if (code === 'P0001') {
    const message = (err as { message?: unknown }).message;
    return typeof message === 'string' && SYNC_CODES.has(message) ? message : 'db_rejected';
  }
  const mapped = SQLSTATE_CODES[code];
  if (mapped) return mapped;
  if (/^08[0-9A-Z]{3}$/.test(code) || CONNECT_CODES.has(code)) return 'connect';
  if (TLS_CODES.has(code)) return 'tls';
  return 'unknown';
}

// Fixed casts per function: nothing else can be called.
const CALLS = {
  ping: [],
  sync_begin: ['text'],
  sync_put_calendar: ['bigint', 'text', 'jsonb'],
  sync_fail_calendar: ['bigint', 'text', 'text'],
  sync_finish: ['bigint'],
  sync_abort: ['bigint', 'text'],
  discover_begin: [],
  put_proposals: ['jsonb'],
} as const satisfies Record<string, readonly ('text' | 'bigint' | 'jsonb')[]>;

export type DbFunction = keyof typeof CALLS;

export interface QueryClient {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  end(): Promise<void>;
}

export interface Db {
  call(fn: DbFunction, args?: readonly unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

function argument(type: 'text' | 'bigint' | 'jsonb', value: unknown): string {
  if (type === 'text' && typeof value === 'string') return value;
  if (type === 'bigint' && Number.isSafeInteger(value)) return String(value);
  if (type === 'jsonb' && typeof value === 'object' && value !== null) return JSON.stringify(value);
  throw new TargetError('bad_call');
}

export function createDb(client: QueryClient): Db {
  // One pg.Client runs one query at a time: every call waits for the previous one to settle.
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const next = tail.then(task, task);
    tail = next.catch(() => undefined);
    return next;
  };
  return {
    async call(fn, args = []) {
      if (typeof fn !== 'string' || !Object.hasOwn(CALLS, fn)) throw new TargetError('bad_call');
      const types: readonly ('text' | 'bigint' | 'jsonb')[] = CALLS[fn];
      if (args.length !== types.length) throw new TargetError('bad_call');
      const values = types.map((type, i) => argument(type, args[i]));
      const casts = types.map((type, i) => `$${i + 1}::${type}`).join(', ');
      let rows: Record<string, unknown>[];
      try {
        ({ rows } = await serial(() => client.query(`select aule_sync.${fn}(${casts}) as r`, values)));
      } catch (err) {
        throw new TargetError(translatePgError(err));
      }
      if (rows.length !== 1) throw new TargetError('bad_response');
      return rows[0]!.r;
    },
    async close() {
      await tail;
      await client.end().catch(() => undefined);
    },
  };
}

// Separate fields, never a connection string; TLS verifies chain and host name unless the host is local.
export function clientConfig(settings: DbSettings): pg.ClientConfig {
  return {
    host: settings.host,
    port: settings.port,
    user: settings.user,
    password: settings.password,
    database: settings.database,
    ssl: settings.tls ? { ca: settings.tls.ca, rejectUnauthorized: true, servername: settings.host } : false,
    application_name: 'aule-sync',
    connectionTimeoutMillis: 15000,
    query_timeout: 70000,
  };
}

export async function openDb(settings: DbSettings): Promise<Db> {
  const client = new pg.Client(clientConfig(settings));
  client.on('error', () => undefined);
  try {
    await client.connect();
  } catch (err) {
    await client.end().catch(() => undefined);
    throw new TargetError(translatePgError(err));
  }
  return createDb(client);
}

// The CA file holds public root certificates only; anything unusual counts as missing.
export function caReader(root: string): (path: string) => string | null {
  return (path) => {
    try {
      const full = resolve(root, path);
      const stat = statSync(full);
      if (!stat.isFile() || stat.size > 20000) return null;
      return readFileSync(full, 'utf8');
    } catch {
      return null;
    }
  };
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const BUILDING_KEY = /^[a-z0-9-]{1,80}$/;
const ROOM_KEY = /^[a-z0-9]{1,100}$/;

function bad(): never {
  throw new TargetError('bad_response');
}

function feed(v: unknown): Feed {
  if (!isRecord(v)) bad();
  let id: CalendarId;
  try {
    id = calendarId(v.id);
  } catch {
    bad();
  }
  const source = v.source;
  if (typeof source !== 'string' || !SOURCE_KINDS.includes(source as SourceKind)) bad();
  const ref = v.ref;
  if (source === 'planner' ? ref !== null : typeof ref !== 'string' || ref.length < 1 || ref.length > 500) bad();
  return { id, source: source as SourceKind, ref: ref as string | null };
}

function directoryRoom(v: unknown): DirectoryRoom {
  if (!isRecord(v)) bad();
  let id: PlannerId;
  try {
    id = plannerId(v.id);
  } catch {
    bad();
  }
  const { buildingKey, roomKey } = v;
  if (typeof buildingKey !== 'string' || !BUILDING_KEY.test(buildingKey)) bad();
  if (typeof roomKey !== 'string' || !ROOM_KEY.test(roomKey)) bad();
  return { id, buildingKey, roomKey };
}

export function parseStart(v: unknown): SyncStart {
  if (!isRecord(v)) bad();
  const { run, from, to, calendars, rooms } = v;
  if (!Number.isSafeInteger(run) || (run as number) < 1) bad();
  if (typeof from !== 'number' || typeof to !== 'number' || !Number.isFinite(from) || !Number.isFinite(to) || from >= to) bad();
  if (!Array.isArray(calendars) || calendars.length > 600) bad();
  if (!Array.isArray(rooms) || rooms.length > 3000) bad();
  return { run: run as number, from, to, calendars: calendars.map(feed), rooms: rooms.map(directoryRoom) };
}

export function parseSummary(v: unknown, run: number): SyncSummary {
  if (!isRecord(v)) bad();
  const { state, failure, ok, failed, rooms, lessons } = v;
  if (v.run !== run) bad();
  if (!isCount(ok) || !isCount(failed)) bad();
  const nullableCount = (x: unknown): x is number | null => x === null || isCount(x);
  if (!nullableCount(rooms) || !nullableCount(lessons)) bad();
  if (state === 'finished' && failure === null) return { run, state, failure: null, ok, failed, rooms, lessons };
  if (state === 'aborted' && failure === 'implausible') return { run, state, failure, ok, failed, rooms, lessons };
  bad();
}

export class PgSyncTarget implements SyncTarget {
  constructor(private readonly db: Db) {}

  async begin(trigger: SyncTrigger): Promise<SyncStart | { skipped: 'run_open' | 'too_soon' }> {
    let answer: unknown;
    try {
      answer = await this.db.call('sync_begin', [trigger]);
    } catch (err) {
      if (err instanceof TargetError && (err.code === 'run_open' || err.code === 'too_soon')) return { skipped: err.code };
      throw err;
    }
    return parseStart(answer);
  }

  async put(run: number, calendar: CalendarId, payload: CalendarPayload): Promise<void> {
    await this.db.call('sync_put_calendar', [run, calendar, payload]);
  }

  async fail(run: number, calendar: CalendarId, failure: CalendarFailure): Promise<void> {
    await this.db.call('sync_fail_calendar', [run, calendar, failure]);
  }

  async finish(run: number): Promise<SyncSummary> {
    return parseSummary(await this.db.call('sync_finish', [run]), run);
  }

  async abort(run: number, failure: AbortFailure): Promise<void> {
    await this.db.call('sync_abort', [run, failure]);
  }
}
