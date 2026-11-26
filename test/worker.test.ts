import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handle, serve, type AssetsLike, type CacheLike, type HandlerDeps, type WorkerEnv } from '../src/worker/handler.js';
import { MemoryCache } from '../src/worker/cache.js';
import { securityHeaders } from '../src/http/headers.js';
import { supabaseSettings } from '../src/settings.js';

const LOCAL = 'http://127.0.0.1:3010';
const PROD = 'https://aule.example.pages.dev';
const KEY = 'sb_publishable_testtesttesttest';
const LOCAL_ENV: WorkerEnv = { SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: KEY };
const PROD_ENV: WorkerEnv = { SUPABASE_URL: 'https://abcdefghijklmnop.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY };
const T0 = Date.UTC(2026, 10, 16, 10, 30); // 11:30 in Rome
const ROOM = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const BODY = '{"rooms": [ ],\n  "note":"città \\u00e8"}';
const KEY_A = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const KEY_B = 'ffffffffffffffffffffffffffffffff';
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
  assets?: AssetsLike;
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
    // The Pages entry, with the static assets binding when given.
    serve(path: string, init?: RequestInit) {
      return serve(new Request(base + path, init), options.assets ? { ...env, ASSETS: options.assets } : env, deps);
    },
  };
}

function fakeAssets(reply: (request: Request) => Response | Promise<Response> = () => new Response('static', { status: 200 })) {
  const seen: Request[] = [];
  const assets: AssetsLike = {
    async fetch(request) {
      seen.push(request);
      return reply(request);
    },
  };
  return { assets, seen };
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

// normalize: how the cache may rewrite a key URL before storing it (the identity by default).
function fakeCache(normalize: (url: string) => string = (url) => url) {
  const store = new Map<string, { body: Uint8Array; headers: [string, string][] }>();
  const puts: string[] = [];
  let matches = 0;
  const cache: CacheLike = {
    async match(key) {
      matches += 1;
      const entry = store.get(normalize(key.url));
      return entry ? new Response(entry.body.slice(), { headers: entry.headers }) : undefined;
    },
    async put(key, response) {
      puts.push(key.url);
      store.set(normalize(key.url), { body: new Uint8Array(await response.arrayBuffer()), headers: [...response.headers] });
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

// Pages never runs the function for these paths (_routes.json); without the assets binding they are a 404.
test('the admin page and the client configs are never Worker routes', async () => {
  for (const [base, env, production] of [
    [LOCAL, LOCAL_ENV, false],
    [PROD, PROD_ENV, true],
  ] as const) {
    const s = setup({ base, env });
    for (const path of ['/admin', '/admin/', '/admin.html', '/admin.js', '/admin-config.json', '/client-config.json', '/api/admin', '/api/admin_overview']) {
      for (const res of [await s.get(path), await s.serve(path)]) {
        assert.equal(res.status, 404, path);
        assert.deepEqual(await res.json(), { error: 'not_found' }, path);
        assertHeaders(res, production);
      }
    }
    assert.equal(s.calls.length, 0);
  }
});

test('Pages entry: /api/* is answered here, every other request goes to the static assets untouched', async () => {
  for (const [base, env] of [
    [LOCAL, LOCAL_ENV],
    [PROD, PROD_ENV],
  ] as const) {
    const { assets, seen } = fakeAssets();
    const s = setup({ base, env, assets });
    const res = await s.serve('/api/status');
    assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
    assertHeaders(res, base === PROD);
    assert.equal((await s.serve('/api/nope')).status, 404);
    assert.equal((await s.serve('/api/status', { method: 'POST', body: '{}' })).status, 405);
    assert.equal(seen.length, 0);

    const paths = ['/', '/index.html', '/admin', '/admin-config.json', '/vendor/supabase.js', '/api', '/apifoo/status', '/API/status', '/x/api/status'];
    for (const path of paths) {
      const passed = await s.serve(path);
      assert.equal(passed.status, 200, path);
      assert.equal(await passed.text(), 'static', path);
      // Asset responses keep the headers of _headers only.
      assert.equal(passed.headers.has('Content-Security-Policy'), false, path);
    }
    await s.serve('/index.html', { method: 'HEAD' });
    assert.deepEqual(seen.map((r) => new URL(r.url).pathname), [...paths, '/index.html']);
    assert.equal(seen.at(-1)!.method, 'HEAD');
    assert.equal(s.calls.length, 1);
    assert.deepEqual(s.logs, []);
  }
});

test('Pages entry: a failing assets binding gives 500 with a closed log line', async () => {
  const { assets } = fakeAssets(() => Promise.reject(new TypeError('assets down')));
  const s = setup({ base: PROD, env: PROD_ENV, assets });
  const res = await s.serve('/index.html');
  assert.equal(res.status, 500);
  assert.deepEqual(await res.json(), { error: 'server_error' });
  assertHeaders(res, true);
  assert.deepEqual(s.logs, ['{"event":"worker_failed","kind":"TypeError"}']);
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
  assert.deepEqual(shared.puts, ['https://127.0.0.1/__aule_cache/v1/search?free=1&q=mt1']);
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

test('search cache keys name every parameter, so different searches never share an entry', async () => {
  // Some caches merge repeated slashes in a URL path; named parameters leave nothing to merge.
  const merging = fakeCache((url) => url.replace(/([^:])\/{2,}/g, '$1/'));
  const paths = [
    '/api/search?q=1&free=1',
    '/api/search?free=1&hours=1',
    '/api/search?free=1&seats=1',
    '/api/search?q=1&seats=1',
    '/api/search?hours=1&seats=1',
    '/api/search?q=1',
    '/api/search?free=1',
    '/api/search',
    '/api/search?q=free%3D1',
    '/api/search?q=1%26free%3D1',
  ];
  const bodies: string[] = [];
  for (const [i, path] of paths.entries()) {
    const s = setup({ cache: merging.cache, reply: () => json(`{"n":${i}}`) });
    const res = await s.get(path);
    await Promise.all(s.pending);
    assert.equal(s.calls.length, 1, path);
    bodies.push(await res.text());
  }
  assert.deepEqual(bodies, paths.map((_, i) => `{"n":${i}}`));
  assert.equal(new Set(merging.puts).size, paths.length);
  assert.deepEqual(merging.puts.slice(0, 3), [
    'https://127.0.0.1/__aule_cache/v1/search?free=1&q=1',
    'https://127.0.0.1/__aule_cache/v1/search?free=1&hours=1',
    'https://127.0.0.1/__aule_cache/v1/search?free=1&seats=1',
  ]);

  const memory = setup();
  await memory.get('/api/search?q=1&free=1');
  await memory.get('/api/search?free=1&hours=1');
  assert.equal(memory.calls.length, 2);
});

test('a failing Cache API never fails the request', async () => {
  const broken: CacheLike = {
    match: () => Promise.reject(new Error('cache down')),
    put: () => Promise.reject(new Error('cache down')),
  };
  // As where the Cache API is missing: both calls throw at once instead of rejecting.
  const throwing: CacheLike = {
    match: () => {
      throw new TypeError('no cache');
    },
    put: () => {
      throw new TypeError('no cache');
    },
  };
  for (const cache of [broken, throwing]) {
    const s = setup({ cache });
    const res = await s.get('/api/status');
    assert.equal(res.status, 200);
    assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
    await Promise.all(s.pending);
    assert.equal(s.calls.length, 1);
    assert.deepEqual(s.logs, []);
  }
});

test('with a no-op cache, as on pages.dev, memory alone keeps one call per 60 s', async () => {
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

test('.dev.vars.example matches the launch accounts mode and holds no key', () => {
  const lines = readFileSync(new URL('../../.dev.vars.example', import.meta.url), 'utf8').trim().split('\n');
  assert.deepEqual(lines, ['SUPABASE_URL=http://127.0.0.1:54321', 'SUPABASE_PUBLISHABLE_KEY=', 'ACCOUNTS=admin']);
});

test('wrangler.json: a Pages config, public values only, previews without production data', () => {
  const text = readFileSync(new URL('../../wrangler.json', import.meta.url), 'utf8');
  const config = JSON.parse(text) as Record<string, unknown> & { vars: Record<string, string> };
  // Pages refuses Worker keys (main, assets, routes, workers_dev, observability): none may come back.
  assert.deepEqual(Object.keys(config).sort(), ['$schema', 'compatibility_date', 'env', 'name', 'pages_build_output_dir', 'send_metrics', 'vars']);
  assert.equal(config.name, 'aule-unical');
  assert.equal(config.pages_build_output_dir, './site');
  assert.equal(config.send_metrics, false);
  assert.match(String(config.compatibility_date), /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(Object.keys(config.vars).sort(), ['ACCOUNTS', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL']);
  // Launch value: only the admin signs in, on /admin.
  assert.equal(config.vars.ACCOUNTS, 'admin');
  const { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key } = config.vars;
  if (url !== '' || key !== '') supabaseSettings({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key }, { allowLocalHttp: false });
  // A deployment of any branch other than main gets no Supabase values: its /api answers 503.
  assert.deepEqual(config.env, { preview: { vars: { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ACCOUNTS: 'off' } } });
  assert.ok(!text.includes('sb_secret_') && !text.includes('eyJ'));
});

test('package scripts deploy only main to the Pages project and serve the same site locally', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
  const { scripts } = pkg;
  assert.equal(scripts.deploy, 'npm run build:site && wrangler pages deploy site --project-name aule-unical --branch main');
  assert.equal(scripts['build:site'], 'npm run build && node dist/scripts/build-site.js --mode production');
  assert.equal(scripts.dev, 'npm run build && node --env-file=.dev.vars dist/scripts/build-site.js --mode local && wrangler pages dev site --port 3010');
  assert.equal(scripts['dev:site'], 'node --env-file=.dev.vars dist/scripts/build-site.js --mode local');
  for (const [name, command] of Object.entries(scripts)) {
    assert.ok(!/wrangler (deploy|dev|login)\b/.test(command), name);
  }
});

test('courses: a missing or invalid query gives 400 and never reaches Supabase', async () => {
  const s = setup();
  for (const path of ['/api/courses', '/api/courses?q=', '/api/courses?q=%20%20', '/api/courses?q=%01analisi', '/api/courses?Q=analisi',
    `/api/courses?q=${'a'.repeat(81)}`, `/api/courses?q=${'a'.repeat(61)}`, '/api/courses?q=a%0Ab']) {
    const res = await s.get(path);
    assert.equal(res.status, 400, path);
    assert.deepEqual(await res.json(), { error: 'invalid', field: 'search' }, path);
    assertHeaders(res, false);
  }
  assert.equal(s.calls.length, 0);
});

test('courses: the normalized query is the only argument and the cache key', async () => {
  const shared = fakeCache();
  const s = setup({ cache: shared.cache });
  const res = await s.get('/api/courses?q=%20Analisi%20%20Matem%C3%A0tica%20&x=1&free=1');
  assert.equal(res.status, 200);
  assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
  assertHeaders(res, false);
  assert.equal(res.headers.has('Access-Control-Allow-Origin'), false);
  await s.get('/api/courses?q=analisi%20matematica');
  await s.get('/api/courses?q=ANALISI+MATEMATICA&q=other');
  await s.get(`/api/courses?q=${'a'.repeat(60)}`);
  await s.get('/api/courses?q=%25_');
  await Promise.all(s.pending);
  assert.deepEqual(
    s.calls.map((c) => [c.url, c.init.body]),
    [
      ['http://127.0.0.1:54321/rest/v1/rpc/search_courses', '{"p_query":"analisi matematica"}'],
      ['http://127.0.0.1:54321/rest/v1/rpc/search_courses', `{"p_query":"${'a'.repeat(60)}"}`],
      ['http://127.0.0.1:54321/rest/v1/rpc/search_courses', '{"p_query":"%_"}'],
    ],
  );
  assert.deepEqual(shared.puts, [
    'https://127.0.0.1/__aule_cache/v1/courses?q=analisi+matematica',
    `https://127.0.0.1/__aule_cache/v1/courses?q=${'a'.repeat(60)}`,
    'https://127.0.0.1/__aule_cache/v1/courses?q=%25_',
  ]);
  // A room search with the same text is another entry.
  await s.get('/api/search?q=analisi%20matematica');
  assert.equal(s.calls.length, 4);
});

test('timetable: invalid keys, days and window give 400 with the field and never reach Supabase', async () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => i.toString(16).repeat(32)).join(',');
  const cases: [string, string][] = [
    ['/api/timetable', 'course_keys'],
    ['/api/timetable?keys=', 'course_keys'],
    ['/api/timetable?from=2026-11-16&days=7', 'course_keys'],
    [`/api/timetable?KEYS=${KEY_A}`, 'course_keys'],
    [`/api/timetable?keys=${thirteen}`, 'course_keys'],
    [`/api/timetable?keys=${Array<string>(13).fill(KEY_A).join(',')}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A.toUpperCase()}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A.slice(1)}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A}0`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A},`, 'course_keys'],
    [`/api/timetable?keys=,${KEY_A}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A},,${KEY_B}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A};${KEY_B}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A}%20${KEY_B}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A}+${KEY_B}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A}%7C${KEY_B}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A}%2C%20${KEY_B}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A}%0A`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A.slice(1)}%25`, 'course_keys'],
    [`/api/timetable?keys=${'g'.repeat(32)}`, 'course_keys'],
    [`/api/timetable?keys=${KEY_A}&from=2027-01-16`, 'day'],
    [`/api/timetable?keys=${KEY_A}&from=2026-10-25`, 'day'],
    [`/api/timetable?keys=${KEY_A}&from=2026-02-30`, 'day'],
    [`/api/timetable?keys=${KEY_A}&from=16-11-2026`, 'day'],
    [`/api/timetable?keys=${KEY_A}&from=`, 'day'],
    [`/api/timetable?keys=${KEY_A}&days=0`, 'days'],
    [`/api/timetable?keys=${KEY_A}&days=15`, 'days'],
    [`/api/timetable?keys=${KEY_A}&days=-1`, 'days'],
    [`/api/timetable?keys=${KEY_A}&days=7.0`, 'days'],
    [`/api/timetable?keys=${KEY_A}&days=`, 'days'],
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

test('timetable: defaults, edges and sorted keys without duplicates reach Supabase', async () => {
  const twelve = Array.from({ length: 12 }, (_, i) => i.toString(16).repeat(32));
  const s = setup();
  const paths = [
    `/api/timetable?keys=${KEY_A}`,
    `/api/timetable?keys=${KEY_B},${KEY_A},${KEY_B}&from=2026-10-26&days=1`,
    `/api/timetable?keys=${[...twelve].reverse().join('%2C')}&from=2026-12-07&days=14`,
    // A course timetable may start up to 60 days ahead, further than the 21 days of a room.
    `/api/timetable?keys=${KEY_A}&from=2026-12-08&days=14`,
    `/api/timetable?keys=${KEY_A}&from=2027-01-15&days=14`,
  ];
  for (const path of paths) {
    const res = await s.get(path);
    assert.equal(res.status, 200, path);
    assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
    assertHeaders(res, false);
  }
  assert.deepEqual(
    s.calls.map((c) => [c.url, c.init.body]),
    [
      ['http://127.0.0.1:54321/rest/v1/rpc/course_timetable', `{"p_keys":["${KEY_A}"],"p_from":"2026-11-16","p_days":7}`],
      ['http://127.0.0.1:54321/rest/v1/rpc/course_timetable', `{"p_keys":["${KEY_A}","${KEY_B}"],"p_from":"2026-10-26","p_days":1}`],
      ['http://127.0.0.1:54321/rest/v1/rpc/course_timetable', `{"p_keys":${JSON.stringify(twelve)},"p_from":"2026-12-07","p_days":14}`],
      ['http://127.0.0.1:54321/rest/v1/rpc/course_timetable', `{"p_keys":["${KEY_A}"],"p_from":"2026-12-08","p_days":14}`],
      ['http://127.0.0.1:54321/rest/v1/rpc/course_timetable', `{"p_keys":["${KEY_A}"],"p_from":"2027-01-15","p_days":14}`],
    ],
  );
  for (const { init } of s.calls) {
    assert.deepEqual(init.headers, { apikey: KEY, 'Content-Type': 'application/json', Accept: 'application/json' });
  }
});

test('timetable: key order, duplicates, defaults and unknown parameters share one cache entry', async () => {
  const shared = fakeCache();
  const s = setup({ cache: shared.cache });
  await s.get(`/api/timetable?keys=${KEY_A},${KEY_B}`);
  await s.get(`/api/timetable?keys=${KEY_B},${KEY_A}`);
  await s.get(`/api/timetable?keys=${KEY_B},${KEY_A},${KEY_A}&days=7&from=2026-11-16&teachers=1`);
  await s.get(`/api/timetable?from=2026-11-16&keys=${KEY_A}%2C${KEY_B}&keys=${KEY_B}`);
  await Promise.all(s.pending);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(shared.puts, [`https://127.0.0.1/__aule_cache/v1/timetable?days=7&from=2026-11-16&keys=${KEY_A}%2C${KEY_B}`]);
  await s.get(`/api/timetable?keys=${KEY_A}`);
  await s.get(`/api/timetable?keys=${KEY_A},${KEY_B}&days=8`);
  await s.get(`/api/timetable?keys=${KEY_A},${KEY_B}&from=2026-11-17`);
  assert.equal(s.calls.length, 4);
  // The default day follows the clock in Rome: after midnight it is another entry.
  s.advance(13 * 3_600_000);
  await s.get(`/api/timetable?keys=${KEY_A},${KEY_B}`);
  assert.equal(s.calls.length, 5);
  assert.equal(s.calls[4]!.init.body, `{"p_keys":["${KEY_A}","${KEY_B}"],"p_from":"2026-11-17","p_days":7}`);
});

test('courses and timetable: only GET, exact paths, upstream errors mapped like the other routes', async () => {
  const p0001 = (message: string) => json(JSON.stringify({ code: 'P0001', details: null, hint: null, message }), 400);
  const s = setup();
  for (const path of ['/api/courses/', '/api/timetable/', `/api/timetable/${KEY_A}`, '/api/courses/analisi', '/api/Courses?q=a']) {
    const res = await s.get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'not_found' }, path);
  }
  for (const path of ['/api/courses?q=analisi', `/api/timetable?keys=${KEY_A}`]) {
    const res = await s.get(path, { method: 'POST', body: '{}' });
    assert.equal(res.status, 405, path);
    assert.equal(res.headers.get('Allow'), 'GET');
  }
  assert.equal(s.calls.length, 0);

  // Reply, answer status and code, then the logged upstream status and code (null: nothing logged).
  const cases: [() => Response | Promise<Response>, number, string, [number, string] | null][] = [
    [() => p0001('invalid'), 400, 'invalid', null],
    [() => p0001('internal'), 502, 'upstream_error', [400, 'P0001']],
    [() => json('{}', 500), 503, 'upstream_unavailable', [500, 'status']],
    [() => Promise.reject(new TypeError('fetch failed')), 503, 'upstream_unavailable', [0, 'network']],
  ];
  for (const [path, fn] of [['/api/courses?q=segreto', 'search_courses'], [`/api/timetable?keys=${KEY_A}`, 'course_timetable']] as const) {
    for (const [reply, status, code, logged] of cases) {
      const failing = setup({ reply });
      const res = await failing.get(path);
      assert.equal(res.status, status, `${path} ${code}`);
      assert.deepEqual(await res.json(), { error: code });
      assertHeaders(res, false);
      assert.deepEqual(failing.logs, logged === null ? [] : [JSON.stringify({ event: 'upstream_failed', fn, status: logged[0], code: logged[1] })]);
      // Errors are never cached.
      failing.state.reply = () => json(BODY);
      assert.equal((await failing.get(path)).status, 200);
    }
  }
});

test('menu: an invalid window gives 400 with the field and never reaches Supabase', async () => {
  const cases: [string, string][] = [
    ['/api/menu?from=2027-01-16', 'day'],
    ['/api/menu?from=2026-10-25', 'day'],
    ['/api/menu?from=2026-02-30', 'day'],
    ['/api/menu?from=16-11-2026', 'day'],
    ['/api/menu?from=', 'day'],
    ['/api/menu?days=0', 'days'],
    ['/api/menu?days=15', 'days'],
    ['/api/menu?days=-1', 'days'],
    ['/api/menu?days=7.0', 'days'],
    ['/api/menu?days=', 'days'],
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

test('menu: defaults and edges reach Supabase with validated values only', async () => {
  const s = setup();
  // 21 days back and up to 60 days ahead, as a course timetable.
  for (const query of ['', '?from=2026-10-26&days=1', '?from=2027-01-15&days=14', '?days=14&lang=it']) {
    const res = await s.get(`/api/menu${query}`);
    assert.equal(res.status, 200, query);
    assert.deepEqual(await bytesOf(res), Buffer.from(BODY));
    assertHeaders(res, false);
  }
  assert.deepEqual(
    s.calls.map((c) => [c.url, c.init.body]),
    [
      ['http://127.0.0.1:54321/rest/v1/rpc/canteen_menu', '{"p_from":"2026-11-16","p_days":7}'],
      ['http://127.0.0.1:54321/rest/v1/rpc/canteen_menu', '{"p_from":"2026-10-26","p_days":1}'],
      ['http://127.0.0.1:54321/rest/v1/rpc/canteen_menu', '{"p_from":"2027-01-15","p_days":14}'],
      ['http://127.0.0.1:54321/rest/v1/rpc/canteen_menu', '{"p_from":"2026-11-16","p_days":14}'],
    ],
  );
  for (const { init } of s.calls) {
    assert.deepEqual(init.headers, { apikey: KEY, 'Content-Type': 'application/json', Accept: 'application/json' });
  }
});

test('menu: one cache entry per window for 60 seconds, never in the slow cache of other sites', async () => {
  const shared = fakeCache();
  const s = setup({ cache: shared.cache });
  const slow = new MemoryCache({ ttlMs: 60 * 60_000, maxEntries: 4 });
  s.deps.slow = slow;
  await s.get('/api/menu');
  await s.get('/api/menu?days=7&from=2026-11-16');
  await s.get('/api/menu?from=2026-11-16&from=2026-11-20&lang=it');
  await Promise.all(s.pending);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(shared.puts, ['https://127.0.0.1/__aule_cache/v1/menu/2026-11-16/7']);
  await s.get('/api/menu?days=8');
  await s.get('/api/menu?from=2026-11-17');
  assert.equal(s.calls.length, 3);
  assert.equal(slow.size, 0);
  s.advance(59_000);
  await s.get('/api/menu');
  assert.equal(s.calls.length, 3);
  s.advance(2_000);
  await s.get('/api/menu');
  assert.equal(s.calls.length, 4);
  // The default day follows the clock in Rome: after midnight it is another entry.
  s.advance(13 * 3_600_000);
  await s.get('/api/menu');
  assert.equal(s.calls.length, 5);
  assert.equal(s.calls[4]!.init.body, '{"p_from":"2026-11-17","p_days":7}');
});

test('menu: only GET, exact path, upstream errors mapped like the other routes', async () => {
  const p0001 = (message: string) => json(JSON.stringify({ code: 'P0001', details: null, hint: null, message }), 400);
  const s = setup();
  for (const path of ['/api/menu/', '/api/menu/2026-11-16', '/api/Menu', '/api/menus']) {
    const res = await s.get(path);
    assert.equal(res.status, 404, path);
    assert.deepEqual(await res.json(), { error: 'not_found' }, path);
  }
  const post = await s.get('/api/menu', { method: 'POST', body: '{}' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('Allow'), 'GET');
  assert.equal(s.calls.length, 0);

  // Reply, answer status and code, then the logged upstream status and code (null: nothing logged).
  const cases: [() => Response | Promise<Response>, number, string, [number, string] | null][] = [
    [() => p0001('invalid'), 400, 'invalid', null],
    [() => p0001('internal'), 502, 'upstream_error', [400, 'P0001']],
    [() => json('{}', 500), 503, 'upstream_unavailable', [500, 'status']],
    [() => Promise.reject(new TypeError('fetch failed')), 503, 'upstream_unavailable', [0, 'network']],
  ];
  for (const [reply, status, code, logged] of cases) {
    const failing = setup({ reply });
    const res = await failing.get('/api/menu');
    assert.equal(res.status, status, code);
    assert.deepEqual(await res.json(), { error: code });
    assertHeaders(res, false);
    assert.deepEqual(
      failing.logs,
      logged === null ? [] : [JSON.stringify({ event: 'upstream_failed', fn: 'canteen_menu', status: logged[0], code: logged[1] })],
    );
    // Errors are never cached.
    failing.state.reply = () => json(BODY);
    assert.equal((await failing.get('/api/menu')).status, 200);
  }
});

const CINEMA_PAGE = 'https://cosenzacinema.it/programmazione-sale-unical/';
const CINEMA_TIMES = 'https://cosenzacinema.it/wp-admin/admin-ajax.php';
const CINEMA_HTML = `<div class="amy-movie-item row"> <div class="amy-movie-item-poster"> <a href="https://cosenzacinema.it/movie/film-di-prova/"> <img src="https://cosenzacinema.it/wp-content/uploads/2026/11/prova.jpg"> </a> </div>
  <h3 class="amy-movie-field-title"><a href="https://cosenzacinema.it/movie/film-di-prova/">Film di Prova</a></h3>
  <select name="timelist" class="timelist" data-movie="7"> <option value="2026-11-15">15/11/2026</option> <option value="2026-11-16">16/11/2026</option> <option value="2026-11-17">17/11/2026</option> </select> </div>`;
const TIMES: Readonly<Record<string, string>> = {
  '2026-11-16': JSON.stringify('<span class="intro-time">20:30</span>'),
  '2026-11-17': JSON.stringify('<span class="intro-time">17:15</span>\n<span class="intro-time">21:45</span>'),
};

function html(body: string, status = 200, type = 'text/html; charset=utf-8'): Response {
  return new Response(body, { status, headers: { 'content-type': type } });
}

// The cinema's site: the page, then the times of the asked day
function cinema(call: Call, page: () => Response = () => html(CINEMA_HTML)): Response {
  if (call.url === CINEMA_PAGE) return page();
  const day = new URLSearchParams(String(call.init.body)).get('date') ?? '';
  return html(TIMES[day] ?? JSON.stringify(''), 200, 'text/html; charset=UTF-8');
}

test('/api/cinema reads the page and the times from today on, with our user agent only, and returns the programme', async () => {
  const s = setup({ reply: (call) => cinema(call) });
  const res = await s.get('/api/cinema', { headers: { Cookie: 'sb=secret', Authorization: 'Bearer x' } });
  assert.equal(res.status, 200);
  assertHeaders(res, false);
  assert.deepEqual(await res.json(), {
    source: CINEMA_PAGE,
    tickets: 'https://unical.cosenzacinema.18tickets.it/',
    checkedAt: T0,
    films: [
      {
        title: 'Film di Prova',
        url: 'https://cosenzacinema.it/movie/film-di-prova/',
        poster: 'https://cosenzacinema.it/wp-content/uploads/2026/11/prova.jpg',
        shows: [
          { at: Date.UTC(2026, 10, 16, 19, 30), room: null, url: null },
          { at: Date.UTC(2026, 10, 17, 16, 15), room: null, url: null },
          { at: Date.UTC(2026, 10, 17, 20, 45), room: null, url: null },
        ],
      },
    ],
  });
  // The day already gone is not asked for
  assert.deepEqual(
    s.calls.map((c) => [c.init.method, c.url, c.init.body ?? null]),
    [
      ['GET', CINEMA_PAGE, null],
      ['POST', CINEMA_TIMES, 'action=amy_movie_ajax_shortcode_showtime_layout_4&movie_id=7&date=2026-11-16'],
      ['POST', CINEMA_TIMES, 'action=amy_movie_ajax_shortcode_showtime_layout_4&movie_id=7&date=2026-11-17'],
    ],
  );
  for (const call of s.calls) {
    const sent = [...new Headers(call.init.headers).keys()].sort();
    assert.ok(sent.every((h) => ['accept', 'content-type', 'user-agent'].includes(h)), sent.join());
    assert.equal(call.init.redirect, 'manual');
  }
});

test('/api/cinema with the slow cache reads the cinema at most once an hour', async () => {
  const s = setup({ reply: (call) => cinema(call) });
  s.deps.slow = new MemoryCache({ ttlMs: 60 * 60_000 });
  for (const step of [0, 20 * 60_000, 39 * 60_000]) {
    s.advance(step);
    assert.equal((await s.get('/api/cinema')).status, 200);
  }
  assert.equal(s.calls.filter((c) => c.url === CINEMA_PAGE).length, 1);
  s.advance(2 * 60_000);
  await s.get('/api/cinema');
  assert.equal(s.calls.filter((c) => c.url === CINEMA_PAGE).length, 2);
});

test('/api/cinema: a page that fails, redirects or is not HTML gives 502 or 503 with the reason and a closed log line', async () => {
  const cases: [Response, number, string, string][] = [
    [html('', 503), 503, 'status_503', '{"event":"upstream_failed","fn":"cinema_page","status":503,"code":"status"}'],
    [html('', 202), 502, 'status_202', '{"event":"upstream_failed","fn":"cinema_page","status":202,"code":"status"}'],
    [html('', 302), 502, 'redirect_302', '{"event":"upstream_failed","fn":"cinema_page","status":302,"code":"redirect"}'],
    [html('{}', 200, 'application/json'), 502, 'content_type', '{"event":"upstream_failed","fn":"cinema_page","status":200,"code":"content_type"}'],
  ];
  for (const [reply, status, detail, log] of cases) {
    const s = setup({ reply: (call) => cinema(call, () => reply) });
    const res = await s.get('/api/cinema');
    assert.equal(res.status, status);
    assert.deepEqual(await res.json(), { error: status === 503 ? 'upstream_unavailable' : 'upstream_error', detail });
    assert.deepEqual(s.logs, [log]);
  }
});

test('/api/cinema: a day whose times fail is left out; if every day fails it is an outage', async () => {
  const one = setup({ reply: (call) => (String(call.init.body).endsWith('2026-11-17') ? html('', 500) : cinema(call)) });
  const res = await one.get('/api/cinema');
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await res.json()).films[0].shows.map((x: { at: number }) => x.at),
    [Date.UTC(2026, 10, 16, 19, 30)],
  );
  const all = setup({ reply: (call) => (call.url === CINEMA_TIMES ? html('', 500) : cinema(call)) });
  const down = await all.get('/api/cinema');
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: 'upstream_unavailable', detail: 'times' });
});

test('/api/cinema logs when films are on the page but none can be read', async () => {
  const s = setup({ reply: () => html(`<div class="new-layout"><select class="timelist" data-movie="7"></select></div>`) });
  const res = await s.get('/api/cinema');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).films, []);
  assert.deepEqual(s.logs, ['{"event":"cinema_unreadable"}']);
});

const THEATRES = 'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/';
const SEASON_NEXT = 'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/stagione-teatrale-2027-28/';
const SEASON_KNOWN = 'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/stagione-teatrale-2026-27/';
const PTU = 'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/ptu/';
const showBlock = (title: string, place: string, day: string) =>
  `<div class="row mb-4"><img src="/media/medias/2026/Prova.webp"/><h4>${title}</h4><p>${place}<br/>${day}<br/>ore 21:00</p></div>`;

function theatres(call: Call, broken: string[] = []): Response {
  if (broken.includes(call.url)) return html('', 503);
  if (call.url === THEATRES) return html(`<a href="https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/stagione-teatrale-2027-28/">Stagione</a>`);
  if (call.url === SEASON_NEXT || call.url === SEASON_KNOWN) return html(showBlock('CONCERTO DI PROVA', 'TAU - Teatro Auditorium Unical', 'Martedì 17 novembre 2026'));
  if (call.url === PTU) return html(showBlock('PROVA AL PTU', 'PTU - Piccolo Teatro Unical', 'Lunedì 16 novembre 2026'));
  return html('', 404);
}

test('/api/teatri reads the season linked from the theatres page and the PTU page, and returns the shows in order', async () => {
  const s = setup({ reply: (call) => theatres(call) });
  const res = await s.get('/api/teatri', { headers: { Cookie: 'sb=secret' } });
  assert.equal(res.status, 200);
  assertHeaders(res, false);
  const body = await res.json();
  assert.deepEqual(body.sources, [SEASON_NEXT, PTU]);
  assert.deepEqual(
    body.shows.map((x: { title: string; theatre: string; dates: { at: number }[] }) => [x.title, x.theatre, x.dates[0]?.at]),
    [
      ['PROVA AL PTU', 'ptu', Date.UTC(2026, 10, 16, 20, 0)],
      ['CONCERTO DI PROVA', 'tau', Date.UTC(2026, 10, 17, 20, 0)],
    ],
  );
  assert.deepEqual(
    s.calls.map((c) => c.url),
    [THEATRES, SEASON_NEXT, PTU],
  );
  for (const call of s.calls) assert.deepEqual([...new Headers(call.init.headers).keys()].sort(), ['accept', 'user-agent']);
});

test('/api/teatri: without the theatres page it uses the known season; one page down leaves the other theatre', async () => {
  const s = setup({ reply: (call) => theatres(call, [THEATRES, PTU]) });
  const res = await s.get('/api/teatri');
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await res.json()).shows.map((x: { title: string }) => x.title),
    ['CONCERTO DI PROVA'],
  );
  assert.ok(s.calls.some((c) => c.url === SEASON_KNOWN));
  assert.equal(s.logs.length, 2);
});

test('/api/teatri: with both theatres pages down it is an outage, not "no shows"', async () => {
  const s = setup({ reply: (call) => theatres(call, [SEASON_NEXT, PTU]) });
  const res = await s.get('/api/teatri');
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'upstream_unavailable', detail: 'pages' });
});

const NEWS = 'https://www.unical.it/api/news/by-context/1';
const newsItem = (id: number, title: string, start: string, category: number) => ({
  id: id + 1000,
  date_start: start,
  path: `/contents/news/view/${id}-prova/`,
  publication: { id, title, subheading: null, image: null, category_data: [{ id: category, name: 'x' }] },
});

function news(call: Call, broken: number[] = []): Response {
  if (!call.url.startsWith(`${NEWS}?`)) return html('', 404);
  const category = Number(new URL(call.url).searchParams.get('category'));
  if (broken.includes(category)) return json('', 503);
  const items: Record<number, object[]> = {
    8: [newsItem(1, 'AVVISO DI PROVA', '2026-11-16T09:00:00+01:00', 8)],
    1: [],
    9: [newsItem(2, 'NOTIZIA DI PROVA', '2026-11-15T09:00:00+01:00', 9)],
    12: [],
  };
  return json(JSON.stringify({ count: 1, results: items[category] ?? [] }));
}

test('/api/notizie reads one list per category, sends nothing of the caller, and returns the items newest first', async () => {
  const s = setup({ reply: (call) => news(call) });
  const res = await s.get('/api/notizie', { headers: { Cookie: 'sb=secret' } });
  assert.equal(res.status, 200);
  assertHeaders(res, false);
  const body = await res.json();
  assert.deepEqual(
    body.items.map((x: { title: string; kinds: string[] }) => [x.title, x.kinds]),
    [
      ['AVVISO DI PROVA', ['notice']],
      ['NOTIZIA DI PROVA', ['news']],
    ],
  );
  assert.deepEqual(
    s.calls.map((c) => new URL(c.url).searchParams.get('category')),
    ['8', '1', '9', '12'],
  );
  for (const call of s.calls) assert.deepEqual([...new Headers(call.init.headers).keys()].sort(), ['accept', 'user-agent']);
});

test('/api/notizie: a category down leaves the others; all down is an outage; a changed answer is logged', async () => {
  const one = setup({ reply: (call) => news(call, [8]) });
  const res = await one.get('/api/notizie');
  assert.equal(res.status, 200);
  assert.deepEqual(
    (await res.json()).items.map((x: { title: string }) => x.title),
    ['NOTIZIA DI PROVA'],
  );
  const all = setup({ reply: (call) => news(call, [8, 1, 9, 12]) });
  const down = await all.get('/api/notizie');
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), { error: 'upstream_unavailable', detail: 'news' });
  const changed = setup({ reply: () => json('{"detail":"altro"}') });
  assert.equal((await changed.get('/api/notizie')).status, 503);
  assert.equal(changed.logs.filter((l) => l === '{"event":"news_unreadable"}').length, 4);
});
