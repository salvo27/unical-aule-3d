// Public read API: GET /api/status, /api/rooms/:id, /api/search. Validates, caches for 60 s, calls one Supabase RPC.
import { ValidationError } from '../domain/errors.js';
import { plannerId, isoDay, dayCount, searchText, minFreeHours, minSeats } from '../domain/primitives.js';
import { romeDay, addDays } from '../availability/time.js';
import { securityHeaders } from '../http/headers.js';
import type { Bytes, MemoryCache } from './cache.js';
import { BODY_CAP, JSON_TYPE, UpstreamError, callRpc, readCapped, type RpcFn } from './rpc.js';

export interface CacheLike {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

export interface WorkerEnv {
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
}

export interface HandlerDeps {
  fetch: typeof fetch;
  cache: CacheLike | null;
  memory: MemoryCache;
  now: () => number;
  waitUntil: (p: Promise<unknown>) => void;
  log: (line: string) => void;
}

const MAX_URL = 2048;
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);
const ROOM_PATH = /^\/api\/rooms\/([^/]{1,40})$/;
const CACHE_PATH = '/__aule_cache/v1/';
const STORED_AT = 'X-Aule-Stored-At';

const ERRORS = {
  invalid: 400,
  not_found: 404,
  method_not_allowed: 405,
  uri_too_long: 414,
  server_error: 500,
  upstream_error: 502,
  upstream_unavailable: 503,
} as const;
type ErrorCode = keyof typeof ERRORS;

interface Call {
  fn: RpcFn;
  args: Record<string, unknown>;
  key: string;
}

function respond(status: number, body: Bytes | string, local: boolean, extra: Record<string, string> = {}): Response {
  const headers = new Headers(securityHeaders(!local, null));
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(body, { status, headers });
}

function failure(code: ErrorCode, local: boolean, extra?: Record<string, string>): Response {
  return respond(ERRORS[code], JSON.stringify({ error: code }), local, extra);
}

function errorKind(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return /^[A-Za-z]{1,40}$/.test(name) ? name : 'unknown';
}

// Unknown parameters are ignored; the cache key holds only validated values.
function route(url: URL, now: number): Call | null {
  const path = url.pathname;
  const q = url.searchParams;
  if (path === '/api/status') return { fn: 'room_status', args: {}, key: 'status' };

  const room = ROOM_PATH.exec(path);
  if (room) {
    const id = plannerId(room[1]);
    const today = romeDay(now);
    const fromRaw = q.get('from');
    const from = fromRaw === null ? today : isoDay(fromRaw);
    if (from < addDays(today, -21) || from > addDays(today, 21)) throw new ValidationError('day');
    const daysRaw = q.get('days');
    const days = daysRaw === null ? 1 : dayCount(daysRaw);
    return { fn: 'room_lessons', args: { p_room_id: id, p_from: from, p_days: days }, key: `rooms/${id}/${from}/${days}` };
  }

  if (path === '/api/search') {
    const raw = q.get('q') ?? '';
    const query = raw.trim() === '' ? null : searchText(raw);
    const free = q.get('free');
    if (free !== null && free !== '0' && free !== '1') throw new ValidationError('free');
    const hoursRaw = q.get('hours');
    const hours = hoursRaw === null ? null : minFreeHours(hoursRaw);
    const seatsRaw = q.get('seats');
    const seats = seatsRaw === null ? null : minSeats(seatsRaw);
    return {
      fn: 'search_rooms',
      args: { p_query: query, p_free: free === '1', p_hours: hours, p_seats: seats },
      key: `search/${encodeURIComponent(query ?? '')}/${free === '1' ? 1 : 0}/${hours ?? ''}/${seats ?? ''}`,
    };
  }
  return null;
}

async function fromCacheApi(cache: CacheLike, key: Request, deps: HandlerDeps): Promise<{ body: Bytes; storedAt: number } | null> {
  try {
    const res = await cache.match(key);
    if (!res) return null;
    const stamp = res.headers.get(STORED_AT) ?? '';
    const storedAt = /^\d{1,15}$/.test(stamp) ? Number(stamp) : NaN;
    if (res.status !== 200 || !JSON_TYPE.test(res.headers.get('content-type') ?? '') || !deps.memory.fresh(storedAt, deps.now())) {
      await res.body?.cancel();
      return null;
    }
    const body = await readCapped(res, BODY_CAP);
    return body && body.byteLength > 0 ? { body, storedAt } : null;
  } catch {
    return null;
  }
}

async function load(call: Call, url: URL, env: WorkerEnv, local: boolean, deps: HandlerDeps): Promise<Bytes> {
  const hit = deps.memory.get(call.key, deps.now());
  if (hit) return hit;
  return deps.memory.shared(call.key, async () => {
    const cache = deps.cache;
    const cacheKey = cache ? new Request(`https://${url.hostname}${CACHE_PATH}${call.key}`, { method: 'GET' }) : null;
    if (cache && cacheKey) {
      const stored = await fromCacheApi(cache, cacheKey, deps);
      if (stored) {
        deps.memory.set(call.key, stored.body, stored.storedAt);
        return stored.body;
      }
    }
    const startedAt = deps.now();
    const body = await callRpc(env, local, call.fn, call.args, deps);
    deps.memory.set(call.key, body, startedAt);
    if (cache && cacheKey) {
      const copy = new Response(body, {
        status: 200,
        headers: { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'application/json', [STORED_AT]: String(startedAt) },
      });
      deps.waitUntil(cache.put(cacheKey, copy).catch(() => undefined));
    }
    return body;
  });
}

export async function handle(request: Request, env: WorkerEnv, deps: HandlerDeps): Promise<Response> {
  let local = false;
  try {
    const url = new URL(request.url);
    local = LOCAL_HOSTS.has(url.hostname);
    if (request.url.length > MAX_URL) return failure('uri_too_long', local);
    if (request.method !== 'GET') return failure('method_not_allowed', local, { Allow: 'GET' });
    const call = route(url, deps.now());
    if (!call) return failure('not_found', local);
    return respond(200, await load(call, url, env, local, deps), local);
  } catch (err) {
    if (err instanceof ValidationError) return respond(400, JSON.stringify({ error: 'invalid', field: err.code }), local);
    if (err instanceof UpstreamError) return failure(err.code, local);
    deps.log(JSON.stringify({ event: 'worker_failed', kind: errorKind(err) }));
    return failure('server_error', local);
  }
}
