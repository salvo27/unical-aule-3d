import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, type CacheLike, type HandlerDeps, type WorkerEnv } from '../src/worker/handler.js';
import { MemoryCache } from '../src/worker/cache.js';
import { securityHeaders } from '../src/http/headers.js';
import { supabaseSettings } from '../src/settings.js';

const LOCAL = 'http://127.0.0.1:3010';
const PROD = 'https://aule.example.workers.dev';
const KEY = 'sb_publishable_testtesttesttest';
const LOCAL_ENV: WorkerEnv = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: KEY };
const PROD_ENV: WorkerEnv = { SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY };
const T0 = Date.UTC(2026, 10, 16, 10, 30); // 11:30 in Rome
const ROOM = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BODY = '{"rooms": [ ],\n  "note":"città \\u00e8"}';
const MB = 1_048_576;

interface Call {
  url: string;
  init: RequestInit;
}

interface Setup {
  env?: WorkerEnv;
  base?: string;
  reply?: (call: Call) => Response | Promise<Response>;
  cache?: CacheLike | null;
  now?: number;
}

function json(body: BodyInit | null, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
}

function setup(options: Setup = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const pending: Promise<unknown>[] = [];
  let now = options.now ?? T0;
  const state = { reply: options.reply ?? (() => json(BODY)) };
  const deps: HandlerDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const call = { url: String(url), init };
      calls.push(call);
      return state.reply(call);
    }) as unknown as typeof fetch,
    cache: options.cache ?? null,
    memory: new MemoryCache(),
    now: () => now,
    waitUntil: (p) => {
      pending.push(p);
    },
    log: (line) => {
      logs.push(line);
    },
  };
  const env = options.env ?? LOCAL_ENV;
  const base = options.base ?? LOCAL;
  return {
    calls,
    logs,
    pending,
    deps,
    state,
    advance(ms: number) {
      now += ms;
    },
    get(path: string, init?: RequestInit) {
      return handle(new Request(base + path, init), env, deps);
    },
  };
}

function assertHeaders(res: Response, production: boolean): void {
  const expected: Record<string, string> = {
    ...securityHeaders(production, null),
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  for (const [name, value] of Object.entries(expected)) assert.equal(res.headers.get(name), value, name);
  assert.equal(res.headers.has('Strict-Transport-Security'), production);
}

async function bytesOf(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

function stream(total: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      const size = Math.min(65_536, total - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(32));
    },
  });
}

function fakeCache() {
  const store = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  const puts: string[] = [];
  let matches = 0;
  const cache: CacheLike = {
    async match(key) {
      matches += 1;
      const entry = store.get(key.url);
      return entry ? new Response(entry.body.slice(), { headers: entry.headers }) : undefined;
    },
    async put(key, response) {
      puts.push(key.url);
      store.set(key.url, { body: new Uint8Array(await response.arrayBuffer()), headers: [...response.headers] });
    },
  };
  return { cache, store, puts, matches: () => matches };
}

test('invalid parameters give 400 with the field and never reach Supabase', async () => {
  const cases: [string, string][] = [
    ['/api/rooms/zzzzzzzzzzzzzzzzzzzzzzzz', 'planner_id'],
    ['/api/rooms/AAAAAAAAAAAAAAAAAAAAAAAA', 'planner_id'],
    [`/api/rooms/${ROOM}?from=2026-12-08`, 'day'],
    [`/api/rooms/${ROOM}?from=2026-10-25`, 'day'],
    [`/api/rooms/${ROOM}?from=2026-02-30`, 'day'],
    [`/api/rooms/${ROOM}?from=`, 'day'],
    [`/api/rooms/${ROOM}?days=99`, 'days'],
    [`/api/rooms/${ROOM}?days=0`, 'days'],
    ['/api/search?q=%01mt1', 'search'],
    [`/api/search?q=${'a'.repeat(81)}`, 'search'],
    ['/api/search?seats=abc', 'seats'],
    ['/api/search?seats=0', 'seats'],
    ['/api/search?hours=13', 'hours'],
    ['/api/search?free=yes', 'free'],
  ];
  const s = setup();
  for (const [path, field] of cases) {
    const res = await s.get(path);
    assert.equal(res.status, 400, path);
    assert.deepEqual(await res.json(), { error: 'invalid', field }, path);
    assertHeaders(res, false);
  }
  assert.equal(s.calls.length, 0);
});

test('the room window accepts its edges and sends validated values only', async () => {
  const s = setup();
  for (const query of ['?from=2026-10-26', '?from=2026-12-07&days=14', '']) {
    assert.equal((await s.get(`/api/rooms/${ROOM}${query}`)).status, 200, query);
  }
  assert.deepEqual(
    s.calls.map((c) => c.init.body),
    [
      `{"p_room_id":"${ROOM}","p_from":"2026-10-26","p_days":1}`,
      `{"p_room_id":"${ROOM}","p_from":"2026-12-07","p_days":14}`,
      `{"p_room_id":"${ROOM}","p_from":"2026-11-16","p_days":1}`,
    ],
  );
});

test('unknown paths give 404 not_found', async () => {
  const s = setup();
  for (const path of ['/api/nope', '/api/rooms/', `/api/rooms/${ROOM}/x`, `/api/rooms/${'a'.repeat(41)}`, '/api/search/', '/api/status/', '/']) {
    const res = await s.get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'not_found' });
    assertHeaders(res, false);
  }
  assert.equal(s.calls.length, 0);
});

test('only GET is allowed: POST, HEAD and others give 405 with Allow: GET', async () => {
  const s = setup();
  const inits: RequestInit[] = [{ method: 'POST', body: '{}' }, { method: 'HEAD' }, { method: 'PUT', body: 'x' }, { method: 'DELETE' }, { method: 'OPTIONS' }];
  for (const init of inits) {
    const res = await s.get('/api/status', init);
    assert.equal(res.status, 405, init.method);
    assert.equal(res.headers.get('Allow'), 'GET');
    assertHeaders(res, false);
  }
  assert.equal(s.calls.length, 0);
});

test('URLs longer than 2048 characters give 414', async () => {
  const s = setup();
  const long = await s.get(`/api/search?q=${'a'.repeat(2100)}`);
  assert.equal(long.status, 414);
  assert.deepEqual(await long.json(), { error: 'uri_too_long' });
  const prefix = `${LOCAL}/api/status?x=`;
  const exact = await s.get(`/api/status?x=${'a'.repeat(2048 - prefix.length)}`);
  assert.equal(exact.status, 200);
  assert.equal(s.calls.length, 1);
});

test('success passes the upstream bytes through with our headers only', async () => {
  const upstream = { 'set-cookie': 'session=x', server: 'postgrest', 'content-range': '0-0/*', 'cf-ray': 'abc', 'x-upstream': '1' };
  for (const [base, env, production] of [
    [LOCAL, LOCAL_ENV, false],
    [PROD, PROD_ENV, true],
  ] as const) {
    const s = setup({ base, env, reply: () => json(BODY, 200, upstream) });
    const res = await s.get('/api/status');
    assert.equal(res.status, 200);
    assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
    assertHeaders(res, production);
    for (const name of Object.keys(upstream)) assert.equal(res.headers.has(name), false, name);
    const allowed = new Set([...Object.keys(securityHeaders(production, null)), 'Content-Type', 'Cache-Control'].map((n) => n.toLowerCase()));
    for (const [name] of res.headers) assert.ok(allowed.has(name), name);
  }
});

test('the upstream call carries only the publishable key and the exact body', async () => {
  const s = setup();
  const client = { Authorization: 'Bearer user-token', Cookie: 'sb=secret-cookie', 'X-Forwarded-For': '10.0.0.1' };
  await s.get('/api/status?x=1', { headers: client });
  await s.get(`/api/rooms/${ROOM}?from=2026-11-17&days=7`, { headers: client });
  await s.get('/api/search?q=%20Aula%20%C3%A8%20%20MT1%20&free=1&hours=2&seats=50', { headers: client });
  await s.get('/api/search?free=0&q=%20%20', { headers: client });
  assert.deepEqual(
    s.calls.map((c) => [c.url, c.init.body]),
    [
      ['http://127.0.0.1:54321/rest/v1/rpc/room_status', '{}'],
      ['http://127.0.0.1:54321/rest/v1/rpc/room_lessons', `{"p_room_id":"${ROOM}","p_from":"2026-11-17","p_days":7}`],
      ['http://127.0.0.1:54321/rest/v1/rpc/search_rooms', '{"p_query":"aula e mt1","p_free":true,"p_hours":2,"p_seats":50}'],
      ['http://127.0.0.1:54321/rest/v1/rpc/search_rooms', '{"p_query":null,"p_free":false,"p_hours":null,"p_seats":null}'],
    ],
  );
  for (const { init } of s.calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'manual');
    assert.ok(init.signal instanceof AbortSignal);
    assert.deepEqual(init.headers, { apikey: KEY, 'Content-Type': 'application/json', Accept: 'application/json' });
    const seen = JSON.stringify(init);
    for (const secret of ['user-token', 'secret-cookie', '10.0.0.1']) assert.equal(seen.includes(secret), false, secret);
  }
});

test('responses are cached for 60 seconds, then fetched again', async () => {
  const s = setup();
  assert.equal((await s.get('/api/status')).status, 200);
  s.advance(30_000);
  assert.deepEqual(await bytesOf(await s.get('/api/status')), Buffer.from(BODY));
  assert.equal(s.calls.length, 1);
  s.advance(31_000);
  assert.equal((await s.get('/api/status')).status, 200);
  assert.equal(s.calls.length, 2);
});

test('parameter order, repeated and unknown parameters share one cache entry', async () => {
  const s = setup();
  await s.get('/api/search?q=MT1&free=1&hours=2&utm_source=x');
  await s.get('/api/search?hours=2&zzz=1&free=1&q=mt1');
  await s.get('/api/search?q=mt1&q=other&free=1&hours=2');
  await s.get('/api/search?q=%20Mt1%20&free=1&hours=2');
  assert.equal(s.calls.length, 1);
  await s.get('/api/status');
  await s.get('/api/status?nocache=1');
  assert.equal(s.calls.length, 2);
  await s.get('/api/search?q=mt1&free=1&hours=3');
  assert.equal(s.calls.length, 3);
});

test('concurrent misses on the same key share one upstream call', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const s = setup({
    reply: async () => {
      await gate;
      return json(BODY);
    },
  });
  const running = [s.get('/api/status'), s.get('/api/status?a=1'), s.get('/api/status')];
  release();
  const results = await Promise.all(running);
  for (const res of results) assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
  assert.equal(s.calls.length, 1);
});

test('upstream failures map to closed codes and closed log lines', async () => {
  const p0001 = (message: string) => json(JSON.stringify({ code: 'P0001', details: null, hint: null, message }), 400);
  const cases: [string, () => Response | Promise<Response>, number, string, string | null][] = [
    ['redirect', () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }), 502, 'upstream_error', 'redirect'],
    ['network', () => Promise.reject(new TypeError('fetch failed')), 503, 'upstream_unavailable', 'network'],
    ['timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError')), 503, 'upstream_unavailable', 'timeout'],
    ['500', () => json('{"message":"boom"}', 500), 503, 'upstream_unavailable', 'status'],
    ['503', () => json(null, 503), 503, 'upstream_unavailable', 'status'],
    ['429', () => json('{}', 429), 503, 'upstream_unavailable', 'status'],
    ['401', () => json('{"code":"PGRST301"}', 401), 503, 'upstream_unavailable', 'status'],
    ['403', () => json('{}', 403), 503, 'upstream_unavailable', 'status'],
    ['content type', () => new Response(BODY, { headers: { 'content-type': 'text/html' } }), 502, 'upstream_error', 'content_type'],
    ['no content type', () => new Response(new Uint8Array([123, 125])), 502, 'upstream_error', 'content_type'],
    ['empty body', () => json(''), 502, 'upstream_error', 'content_type'],
    ['streamed over 1 MB', () => json(stream(MB + 1)), 502, 'upstream_error', 'too_large'],
    ['declared over 1 MB', () => json(BODY, 200, { 'content-length': String(MB + 1) }), 502, 'upstream_error', 'too_large'],
    ['not_found', () => p0001('not_found'), 404, 'not_found', null],
    ['invalid', () => p0001('invalid'), 400, 'invalid', null],
    ['other P0001', () => p0001('payload_value'), 502, 'upstream_error', 'P0001'],
    ['unknown function', () => json('{"code":"PGRST202","message":"Could not find"}', 404), 502, 'upstream_error', 'status'],
    ['huge error body', () => json(stream(10_000), 400), 502, 'upstream_error', 'status'],
  ];
  for (const [name, reply, status, code, logCode] of cases) {
    const s = setup({ reply });
    const res = await s.get('/api/search?q=segreto&free=1');
    assert.equal(res.status, status, name);
    assert.deepEqual(await res.json(), { error: code }, name);
    assertHeaders(res, false);
    if (logCode === null) {
      assert.deepEqual(s.logs, [], name);
      continue;
    }
    assert.equal(s.logs.length, 1, name);
    const line = JSON.parse(s.logs[0]!) as Record<string, unknown>;
    assert.deepEqual(Object.keys(line), ['event', 'fn', 'status', 'code'], name);
    assert.equal(line.event, 'upstream_failed');
    assert.equal(line.fn, 'search_rooms');
    assert.equal(line.code, logCode, name);
    assert.equal(typeof line.status, 'number');
    assert.equal(s.logs[0]!.includes('segreto'), false, name);
  }
});

test('a body of exactly 1 MB streamed without length passes through', async () => {
  const s = setup({ reply: () => json(stream(MB)) });
  const res = await s.get('/api/status');
  assert.equal(res.status, 200);
  assert.equal((await bytesOf(res)).length, MB);
});

test('a missing or invalid configuration gives 503 without calling Supabase', async () => {
  const envs: [string, WorkerEnv][] = [
    [LOCAL, {}],
    [LOCAL, { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '' }],
    [LOCAL, { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln' }],
    [LOCAL, { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_testtesttesttest' }],
    [PROD, LOCAL_ENV],
    [PROD, { SUPABASE_URL: { evil: true } as unknown as string, SUPABASE_PUBLISHABLE_KEY: KEY }],
  ];
  for (const [base, env] of envs) {
    const s = setup({ base, env });
    const res = await s.get('/api/status');
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { error: 'upstream_unavailable' });
    assert.equal(s.calls.length, 0);
    assert.deepEqual(s.logs, ['{"event":"upstream_failed","fn":"room_status","status":0,"code":"config"}']);
  }
});

test('errors are never cached and stale data is never served', async () => {
  const s = setup({ reply: () => json('{}', 500) });
  assert.equal((await s.get('/api/status')).status, 503);
  s.state.reply = () => json(BODY);
  assert.equal((await s.get('/api/status')).status, 200);
  assert.equal((await s.get('/api/status')).status, 200);
  assert.equal(s.calls.length, 2);
  s.advance(61_000);
  s.state.reply = () => Promise.reject(new TypeError('fetch failed'));
  const res = await s.get('/api/status');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'upstream_unavailable' });
});

test('the Cache API is used when given and a hit fills the memory cache', async () => {
  const shared = fakeCache();
  const first = setup({ cache: shared.cache });
  assert.equal((await first.get('/api/search?q=MT1&free=1')).status, 200);
  await Promise.all(first.pending);
  assert.deepEqual(shared.puts, ['https://127.0.0.1/__aule_cache/v1/search/mt1/1//']);
  const stored = new Headers(shared.store.get(shared.puts[0]!)!.headers);
  assert.equal(stored.get('Cache-Control'), 'public, max-age=60');
  assert.equal(stored.get('Content-Type'), 'application/json');

  const second = setup({ cache: shared.cache, now: T0 + 30_000 });
  const res = await second.get('/api/search?free=1&q=mt1');
  assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
  assertHeaders(res, false);
  assert.equal(second.calls.length, 0);
  assert.equal(second.deps.memory.size, 1);
  const matches = shared.matches();
  await second.get('/api/search?free=1&q=mt1');
  assert.equal(shared.matches(), matches);

  const late = setup({ cache: shared.cache, now: T0 + 61_000 });
  assert.equal((await late.get('/api/search?q=mt1&free=1')).status, 200);
  assert.equal(late.calls.length, 1);
});

test('a failing Cache API never fails the request', async () => {
  const broken: CacheLike = {
    match: () => Promise.reject(new Error('cache down')),
    put: () => Promise.reject(new Error('cache down')),
  };
  const s = setup({ cache: broken });
  assert.equal((await s.get('/api/status')).status, 200);
  await Promise.all(s.pending);
  assert.equal(s.calls.length, 1);
});

test('with a no-op cache, as on workers.dev, memory alone keeps one call per 60 s', async () => {
  const noop: CacheLike = { match: async () => undefined, put: async () => undefined };
  const s = setup({ cache: noop });
  for (const step of [0, 30_000, 29_000]) {
    s.advance(step);
    assert.equal((await s.get('/api/status')).status, 200);
  }
  assert.equal(s.calls.length, 1);
  s.advance(2_000);
  await s.get('/api/status');
  s.advance(30_000);
  await s.get('/api/status');
  assert.equal(s.calls.length, 2);
});

test('unexpected exceptions give 500 with a closed log line', async () => {
  const s = setup();
  s.deps.now = () => {
    throw new RangeError('clock');
  };
  const res = await s.get('/api/status');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'server_error' });
  assertHeaders(res, false);
  assert.deepEqual(s.logs, ['{"event":"worker_failed","kind":"RangeError"}']);
});

test('memory cache: at most 64 entries and 4 MB, oldest first, never past the TTL', () => {
  const m = new MemoryCache();
  for (let i = 0; i < 65; i += 1) m.set(`k${i}`, new Uint8Array(10), T0);
  assert.equal(m.size, 64);
  assert.equal(m.get('k0', T0), null);
  assert.ok(m.get('k64', T0));

  const big = new MemoryCache();
  for (let i = 0; i < 5; i += 1) big.set(`b${i}`, new Uint8Array(MB), T0);
  assert.equal(big.size, 4);
  assert.ok(big.totalBytes <= 4 * MB);
  assert.equal(big.get('b0', T0), null);
  big.set('huge', new Uint8Array(4 * MB + 1), T0);
  assert.equal(big.get('huge', T0), null);

  const ttl = new MemoryCache();
  ttl.set('a', new Uint8Array(1), T0);
  assert.ok(ttl.get('a', T0 + 59_999));
  assert.equal(ttl.get('a', T0 + 60_000), null);
  assert.equal(ttl.size, 0);
  ttl.set('b', new Uint8Array(1), T0);
  assert.equal(ttl.get('b', T0 - 1), null);
});

test('wrangler.json: assets only from site/, no secret or binding, no query strings in logs', () => {
  const text = readFileSync(new URL('../../wrangler.json', import.meta.url), 'utf8');
  const config = JSON.parse(text) as Record<string, unknown> & { vars: Record<string, string> };
  const allowed = ['$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls', 'send_metrics', 'assets', 'vars', 'observability', 'routes'];
  for (const key of Object.keys(config)) assert.ok(allowed.includes(key), key);
  assert.equal(config.main, 'src/worker/index.ts');
  assert.equal(config.preview_urls, false);
  assert.equal(config.send_metrics, false);
  assert.deepEqual(config.assets, { directory: './site', run_worker_first: ['/api/*'], html_handling: 'auto-trailing-slash', not_found_handling: 'none' });
  assert.deepEqual(config.observability, { enabled: true, redact_query_string: true, logs: { enabled: true, invocation_logs: false } });
  assert.deepEqual(Object.keys(config.vars).sort(), ['ACCOUNTS_ENABLED', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
  assert.ok(['true', 'false'].includes(config.vars.ACCOUNTS_ENABLED!));
  const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key } = config.vars;
  if (url !== '' || key !== '') supabaseSettings({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key }, { allowLocalHttp: false });
  assert.ok(!text.includes('sb_secret_') && !text.includes('eyJ'));
});
