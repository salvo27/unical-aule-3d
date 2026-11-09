import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseGateway, GatewayError } from '../src/supabase/gateway.js';

const URL_BASE = 'http://127.0.0.1:54321';
const KEY = 'sb_publishable_testtesttesttest';
const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const USER = '10000000-0000-0000-0000-000000000001';

interface Call {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch(handler: (fn: string, body: unknown) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = init.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers, body });
    return handler(url.split('/rpc/')[1] ?? '', body);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('whoami sends the user token and the publishable key', async () => {
  const f = fakeFetch(() => json(200, [{ user_id: USER, role: 'moderator' }]));
  const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: f.impl });
  assert.deepEqual(await gw.whoami(TOKEN), { userId: USER, role: 'moderator' });
  assert.equal(f.calls[0]!.url, `${URL_BASE}/rest/v1/rpc/whoami`);
  assert.equal(f.calls[0]!.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(f.calls[0]!.headers.apikey, KEY);
});

test('whoami: malformed tokens never leave the server, rejected tokens give null', async () => {
  const f = fakeFetch(() => json(401, { code: 'PGRST301', message: 'JWT expired' }));
  const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: f.impl });
  assert.equal(await gw.whoami('not a token'), null);
  assert.equal(await gw.whoami('a.b'), null);
  assert.equal(await gw.whoami('x'.repeat(5000)), null);
  assert.equal(f.calls.length, 0);
  assert.equal(await gw.whoami(TOKEN), null);
});

test('whoami rejects answers that are not ours', async () => {
  const bad = [[], [{ user_id: 'nope', role: 'admin' }], [{ user_id: USER, role: 'root' }]];
  for (const body of bad) {
    const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, body)).impl });
    assert.equal(await gw.whoami(TOKEN), null);
  }
  const shape = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, { user_id: USER })).impl });
  await assert.rejects(shape.whoami(TOKEN), (e: unknown) => e instanceof GatewayError && e.code === 'upstream_error');
});

test('whoami results are cached briefly per token', async () => {
  const f = fakeFetch(() => json(200, [{ user_id: USER, role: 'student' }]));
  let now = 0;
  const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: f.impl, now: () => now });
  await gw.whoami(TOKEN);
  await gw.whoami(TOKEN);
  assert.equal(f.calls.length, 1);
  now += 31_000;
  await gw.whoami(TOKEN);
  assert.equal(f.calls.length, 2);
});

test('database errors become closed codes', async () => {
  const cases: [Response, string, number][] = [
    [json(400, { code: 'P0001', message: 'rate_limited' }), 'rate_limited', 429],
    [json(400, { code: 'P0001', message: 'duplicate' }), 'duplicate', 409],
    [json(400, { code: 'P0001', message: 'window' }), 'window', 400],
    [json(400, { code: 'P0001', message: 'something internal leaked' }), 'request_failed', 400],
    [json(403, { code: '42501', message: 'forbidden' }), 'forbidden', 403],
    [json(401, { code: 'PGRST301', message: 'JWT expired' }), 'unauthorized', 401],
    [json(401, { message: 'Invalid API key' }), 'upstream_error', 502],
    [json(401, { code: 'PGRST300', message: 'Server lacks JWT secret' }), 'upstream_error', 502],
    [json(400, { code: 'P0001', message: 'too_many_pending' }), 'too_many_pending', 429],
    [json(500, { message: 'boom' }), 'upstream_error', 502],
  ];
  for (const [res, code, status] of cases) {
    const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => res.clone()).impl });
    await assert.rejects(
      gw.reviewRequest(TOKEN, USER, 'approved'),
      (e: unknown) => e instanceof GatewayError && e.code === code && e.status === status,
    );
  }
});

test('network failures are reported as unavailable', async () => {
  const impl = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: impl });
  await assert.rejects(gw.overrides(0, 1000), (e: unknown) => e instanceof GatewayError && e.code === 'upstream_unavailable');
});

test('submitRequest sends only whitelisted parameters', async () => {
  const f = fakeFetch(() => json(200, '30000000-0000-0000-0000-000000000009'));
  const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: f.impl });
  const id = await gw.submitRequest(TOKEN, {
    roomId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    kind: 'issue',
    category: 'proiettore',
    lessonId: null,
    start: Date.parse('2026-11-16T09:00:00Z'),
    end: Date.parse('2026-11-23T09:00:00Z'),
  });
  assert.equal(id, '30000000-0000-0000-0000-000000000009');
  assert.deepEqual(f.calls[0]!.body, {
    p_room_id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    p_kind: 'issue',
    p_category: 'proiettore',
    p_starts_at: '2026-11-16T09:00:00.000Z',
    p_ends_at: '2026-11-23T09:00:00.000Z',
    p_lesson_id: null,
  });
});

test('overrides are parsed and malformed rows dropped', async () => {
  const rows = [
    { room_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'room_occupied', category: null, starts_at: '2026-11-16T09:00:00Z', ends_at: '2026-11-16T10:00:00Z', source: 'crowd' },
    { room_id: 'bad', kind: 'room_occupied', category: null, starts_at: '2026-11-16T09:00:00Z', ends_at: '2026-11-16T10:00:00Z', source: 'crowd' },
    { room_id: 'bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'teleport', category: null, starts_at: '2026-11-16T09:00:00Z', ends_at: '2026-11-16T10:00:00Z', source: 'approved' },
    { room_id: 'cccccccccccccccccccccccc', kind: 'lesson_not_held', category: null, lesson_id: null, starts_at: '2026-11-16T09:00:00Z', ends_at: '2026-11-16T10:00:00Z', source: 'approved' },
  ];
  const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, rows)).impl });
  const out = await gw.overrides(0, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.source, 'crowd');
  assert.equal(out[0]!.start, Date.parse('2026-11-16T09:00:00Z'));
});

test('upstream problems are reported with closed values only', async () => {
  const seen: [string, number, string][] = [];
  const gw = createSupabaseGateway({
    url: URL_BASE,
    publishableKey: KEY,
    fetchImpl: fakeFetch(() => json(401, { message: 'Invalid API key' })).impl,
    onUpstreamError: (fn, status, code) => seen.push([fn, status, code]),
  });
  await assert.rejects(gw.listStaff(TOKEN), (e: unknown) => e instanceof GatewayError && e.code === 'upstream_error');
  assert.deepEqual(seen, [['list_staff', 401, 'none']]);
});

test('user lookup and staff list are parsed strictly', async () => {
  const one = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, [{ user_id: USER, email: 'a@unical.it', role: 'moderator' }])).impl });
  assert.deepEqual(await one.findUser(TOKEN, 'a@unical.it'), { userId: USER, email: 'a@unical.it', role: 'moderator', lastSignInAt: null });
  const none = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, [])).impl });
  assert.equal(await none.findUser(TOKEN, 'b@unical.it'), null);
  const bad = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, [{ user_id: USER, email: 'x', role: 'root' }])).impl });
  assert.deepEqual(await bad.listStaff(TOKEN), []);
});

test('a single request is parsed strictly', async () => {
  const row = { id: USER, room_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', kind: 'lesson_not_held', lesson_id: 'dddddddddddddddddddddddd', starts_at: '2026-11-16T08:00:00Z', ends_at: '2026-11-16T10:00:00Z', status: 'pending' };
  const ok = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, [row])).impl });
  assert.equal((await ok.getRequest(TOKEN, USER))?.lessonId, 'dddddddddddddddddddddddd');
  const empty = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, [])).impl });
  assert.equal(await empty.getRequest(TOKEN, USER), null);
  const bad = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: fakeFetch(() => json(200, [{ ...row, status: 'weird' }])).impl });
  assert.equal(await bad.getRequest(TOKEN, USER), null);
});

test('fresh whoami skips the cache', async () => {
  const f = fakeFetch(() => json(200, [{ user_id: USER, role: 'admin' }]));
  const gw = createSupabaseGateway({ url: URL_BASE, publishableKey: KEY, fetchImpl: f.impl, now: () => 0 });
  await gw.whoami(TOKEN);
  await gw.whoami(TOKEN, { fresh: true });
  assert.equal(f.calls.length, 2);
});
