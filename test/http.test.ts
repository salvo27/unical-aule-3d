import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createHandler } from '../src/http/app.js';
import { ConfigStore } from '../src/store/config-store.js';
import { SnapshotStore } from '../src/store/snapshot-store.js';
import { SyncService } from '../src/sync/sync.js';
import { OverridesService } from '../src/availability/overrides.js';
import { silentLogger } from '../src/log.js';
import { GatewayError, type SupabaseGateway, type Identity, type NewRequest } from '../src/supabase/gateway.js';
import type { StaticFile } from '../src/http/static.js';
import type { PlannerApi } from '../src/planner/client.js';
import { fakeEvent, CAL_1, ROOM_A } from './fixtures.js';

const NOW = Date.parse('2026-11-16T09:30:00Z');
const LESSON_ID = 'ffffffffffffffffffffff01';
const TOKENS: Record<string, Identity> = {
  'tok.student.x': { userId: '10000000-0000-0000-0000-000000000001', role: 'student' },
  'tok.moderator.x': { userId: '10000000-0000-0000-0000-000000000002', role: 'moderator' },
  'tok.admin.x': { userId: '10000000-0000-0000-0000-000000000003', role: 'admin' },
};
const submitted: NewRequest[] = [];
let server: Server;
let base: string;

const gateway: SupabaseGateway = {
  whoami: async (token) => TOKENS[token] ?? null,
  submitRequest: async (_token, input) => {
    submitted.push(input);
    return '30000000-0000-0000-0000-000000000001';
  },
  myRequests: async () => [],
  pendingRequests: async () => [
    {
      id: '30000000-0000-0000-0000-000000000001',
      roomId: ROOM_A,
      kind: 'room_occupied',
      category: null,
      lessonId: null,
      start: NOW,
      end: NOW + 3_600_000,
      createdAt: NOW,
      supporters: 1,
      reporterApproved: 0,
      reporterRejected: 0,
    },
    {
      id: '30000000-0000-0000-0000-000000000002',
      roomId: ROOM_A,
      kind: 'lesson_not_held',
      category: null,
      lessonId: LESSON_ID,
      start: Date.parse('2026-11-16T07:00:00Z'),
      end: NOW + 3_600_000,
      createdAt: NOW,
      supporters: 1,
      reporterApproved: 0,
      reporterRejected: 0,
    },
  ],
  getRequest: async (_token, id) => {
    if (id === '30000000-0000-0000-0000-000000000002') {
      return { id, roomId: ROOM_A, kind: 'lesson_not_held', lessonId: LESSON_ID, start: Date.parse('2026-11-16T07:00:00Z'), end: Date.parse('2026-11-16T10:00:00Z'), status: 'pending' };
    }
    if (id === '30000000-0000-0000-0000-000000000001' || id === '30000000-0000-0000-0000-000000000099') {
      return { id, roomId: ROOM_A, kind: 'room_occupied', lessonId: null, start: NOW, end: NOW + 3_600_000, status: 'pending' };
    }
    return null;
  },
  reviewRequest: async (_token, id) => {
    if (id === '30000000-0000-0000-0000-000000000099') throw new GatewayError('not_pending', 409);
  },
  findUser: async (_token, email) => (email === 'mod@unical.it' ? { userId: '10000000-0000-0000-0000-000000000002', email, role: 'moderator', lastSignInAt: null } : null),
  listStaff: async () => [],
  setUserRole: async () => undefined,
  overrides: async () => [],
};

before(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aule-http-'));
  const config = await ConfigStore.open(join(dir, 'admin.json'), { calendars: [{ id: CAL_1, label: 'One' }], sources: [], roomSeeds: [] });
  const snapshots = await SnapshotStore.open(join(dir, 'snapshot.json'), silentLogger);
  const api: PlannerApi = {
    clientId: async () => '5de6319d4414ab02f80b613a',
    calendarInfo: async () => ({}),
    calendarEvents: async () => [
      fakeEvent({ id: LESSON_ID, start: '2026-11-16T08:00:00Z', end: '2026-11-16T10:00:00Z', title: 'ANALISI', room: ROOM_A }),
    ],
  };
  const sync = new SyncService({ api, config, snapshots, log: silentLogger, now: () => NOW, pauseMs: 0 });
  await sync.run('admin');
  const staticFiles = new Map<string, StaticFile>([['/', { body: Buffer.from('<!doctype html>'), type: 'text/html; charset=utf-8', cache: 'no-cache' }]]);
  server = createServer(
    createHandler({
      config,
      snapshots,
      sync,
      campus: { keys: new Set(['cubo-4d']), names: new Map([['cubo-4d', 'Cubo 4D']]) },
      staticFiles,
      discover: async () => ({ found: [], failures: [] }),
      supabase: { url: 'http://127.0.0.1:54321', origin: 'http://127.0.0.1:54321', publishableKey: 'sb_publishable_testtesttest' },
      gateway,
      overrides: new OverridesService(gateway, silentLogger, () => NOW),
      log: silentLogger,
      now: () => NOW,
      staleAfterMs: 30 * 60 * 60 * 1000,
      production: false,
    }),
  );
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => new Promise<void>((r) => server.close(() => r())));

const as = (token: string, extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${token}`, ...extra });
const write = (token: string) => as(token, { Origin: base, 'Content-Type': 'application/json' });

test('every response carries the security headers, CSP allows only our Supabase', async () => {
  for (const path of ['/', '/api/status', '/nope']) {
    const res = await fetch(base + path);
    const policy = res.headers.get('content-security-policy') ?? '';
    assert.match(policy, /default-src 'self'/);
    assert.match(policy, /connect-src 'self' https:\/\/tiles\.openfreemap\.org http:\/\/127\.0\.0\.1:54321/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(self), payment=()');
  }
});

test('status shows the room busy during the lesson', async () => {
  const body = (await (await fetch(`${base}/api/status`)).json()) as { rooms: { id: string; state: string }[]; reportsAvailable: boolean };
  assert.equal(body.rooms[0]!.state, 'busy');
});

test('client config exposes only the public Supabase values', async () => {
  assert.deepEqual(await (await fetch(`${base}/api/client-config`)).json(), {
    accounts: true,
    supabaseUrl: 'http://127.0.0.1:54321',
    publishableKey: 'sb_publishable_testtesttest',
  });
});

test('room detail validates the id and the date range', async () => {
  assert.equal((await fetch(`${base}/api/rooms/${ROOM_A}`)).status, 200);
  assert.equal((await fetch(`${base}/api/rooms/not-an-id`)).status, 400);
  assert.equal((await fetch(`${base}/api/rooms/${'f'.repeat(24)}`)).status, 404);
  assert.equal((await fetch(`${base}/api/rooms/${ROOM_A}?from=2030-01-01`)).status, 400);
  assert.equal((await fetch(`${base}/api/rooms/${ROOM_A}?days=99`)).status, 400);
});

test('search validates its parameters', async () => {
  const ok = (await (await fetch(`${base}/api/search?q=analisi`)).json()) as { lessons: unknown[] };
  assert.equal(ok.lessons.length, 1, 'a lesson in progress is still a result');
  assert.equal((await fetch(`${base}/api/search?q=${encodeURIComponent('a\u0000b')}`)).status, 400);
  assert.equal((await fetch(`${base}/api/search?seats=abc`)).status, 400);
  assert.equal((await fetch(`${base}/api/search?free=yes`)).status, 400);
});

test('static files: only known paths, no traversal, only allowed methods', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);
  assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${base}/api/status`, { method: 'DELETE' })).status, 405);
});

test('requests need a valid session and a same-origin call', async () => {
  const body = JSON.stringify({ roomId: ROOM_A, kind: 'room_occupied' });
  assert.equal((await fetch(`${base}/api/requests`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body })).status, 401);
  assert.equal((await fetch(`${base}/api/requests`, { method: 'POST', headers: write('tok.unknown.x'), body })).status, 401);
  assert.equal(
    (await fetch(`${base}/api/requests`, { method: 'POST', headers: as('tok.student.x', { 'Content-Type': 'application/json' }), body })).status,
    403,
  );
  assert.equal((await fetch(`${base}/api/requests`, { method: 'POST', headers: write('tok.student.x'), body })).status, 201);
  assert.deepEqual(submitted.at(-1), { roomId: ROOM_A, kind: 'room_occupied', category: null, lessonId: null, start: NOW, end: NOW + 3_600_000 });
});

test('requests are validated and the window comes from the server', async () => {
  const post = (b: unknown) => fetch(`${base}/api/requests`, { method: 'POST', headers: write('tok.student.x'), body: JSON.stringify(b) });
  assert.equal((await post({ roomId: 'bbbbbbbbbbbbbbbbbbbbbbbb', kind: 'room_occupied' })).status, 404);
  assert.equal((await post({ roomId: ROOM_A, kind: 'room_occupied', start: 0 })).status, 400);
  assert.equal((await post({ roomId: ROOM_A, kind: 'issue' })).status, 400);
  assert.equal((await post({ roomId: ROOM_A, kind: 'lesson_not_held', lessonId: 'eeeeeeeeeeeeeeeeeeeeeeee' })).status, 400);
  assert.equal((await post({ roomId: ROOM_A, kind: 'lesson_not_held', lessonId: LESSON_ID })).status, 201);
  assert.deepEqual(submitted.at(-1), {
    roomId: ROOM_A,
    kind: 'lesson_not_held',
    category: null,
    lessonId: LESSON_ID,
    start: Date.parse('2026-11-16T08:00:00Z'),
    end: Date.parse('2026-11-16T10:00:00Z'),
  });
});

test('the review queue is for moderators and admins only', async () => {
  assert.equal((await fetch(`${base}/admin/api/requests`)).status, 401);
  assert.equal((await fetch(`${base}/admin/api/requests`, { headers: as('tok.student.x') })).status, 403);
  const res = await fetch(`${base}/admin/api/requests`, { headers: as('tok.moderator.x') });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { requests: { roomName: string; buildingKey: string }[] };
  assert.equal(body.requests[0]!.roomName, 'B6');
  assert.equal(body.requests[0]!.buildingKey, 'cubo-4d');
});

test('reviews validate id and decision, database errors keep their closed code', async () => {
  const review = (id: string, decision: unknown) =>
    fetch(`${base}/admin/api/requests/${id}/review`, { method: 'POST', headers: write('tok.moderator.x'), body: JSON.stringify({ decision }) });
  assert.equal((await review('30000000-0000-0000-0000-000000000001', 'approved')).status, 200);
  assert.equal((await review('not-a-uuid', 'approved')).status, 400);
  assert.equal((await review('30000000-0000-0000-0000-000000000001', 'maybe')).status, 400);
  const conflict = await review('30000000-0000-0000-0000-000000000099', 'rejected');
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'not_pending' });
});

test('configuration and roles are for admins only', async () => {
  assert.equal((await fetch(`${base}/admin/api/overview`, { headers: as('tok.moderator.x') })).status, 403);
  assert.equal((await fetch(`${base}/admin/api/staff`, { headers: as('tok.moderator.x') })).status, 403);
  assert.equal(
    (await fetch(`${base}/admin/api/users/lookup`, { method: 'POST', headers: write('tok.moderator.x'), body: JSON.stringify({ email: 'mod@unical.it' }) })).status,
    403,
  );
  assert.equal((await fetch(`${base}/admin/api/overview`, { headers: as('tok.admin.x') })).status, 200);
  const role = (id: string, r: unknown) =>
    fetch(`${base}/admin/api/users/${id}/role`, { method: 'PUT', headers: write('tok.admin.x'), body: JSON.stringify({ role: r }) });
  assert.equal((await role('10000000-0000-0000-0000-000000000001', 'moderator')).status, 200);
  assert.equal((await role('10000000-0000-0000-0000-000000000001', 'root')).status, 400);
  assert.equal((await role('nope', 'moderator')).status, 400);
});

test('admin changes need a same-origin request', async () => {
  const put = (headers: Record<string, string>) =>
    fetch(`${base}/admin/api/sources`, { method: 'PUT', headers: { ...as('tok.admin.x'), 'Content-Type': 'application/json', ...headers }, body: '{"urls":[]}' });
  assert.equal((await put({})).status, 403);
  assert.equal((await put({ Origin: 'https://evil.example' })).status, 403);
  assert.equal((await put({ Origin: base })).status, 200);
});

test('admin can place a room on a floor, invalid values are refused', async () => {
  const put = (body: unknown) => fetch(`${base}/admin/api/rooms/${ROOM_A}`, { method: 'PUT', headers: write('tok.admin.x'), body: JSON.stringify(body) });
  assert.equal((await put({ floor: 2 })).status, 200);
  assert.equal((await put({ floor: 99 })).status, 400);
  assert.equal((await put({ floor: '2' })).status, 400);
});

test('body limits and content type are enforced', async () => {
  const big = await fetch(`${base}/admin/api/sources`, { method: 'PUT', headers: write('tok.admin.x'), body: JSON.stringify({ urls: ['x'.repeat(20_000)] }) });
  assert.equal(big.status, 413);
  const text = await fetch(`${base}/admin/api/sources`, { method: 'PUT', headers: as('tok.admin.x', { Origin: base, 'Content-Type': 'text/plain' }), body: 'urls' });
  assert.equal(text.status, 415);
});

test('session tells the page the role, without failing for visitors', async () => {
  assert.deepEqual(await (await fetch(`${base}/admin/api/session`)).json(), { accounts: true, role: null });
  assert.deepEqual(await (await fetch(`${base}/admin/api/session`, { headers: as('tok.moderator.x') })).json(), { accounts: true, role: 'moderator' });
});

test('a "not held" is approved only if the lesson still matches the timetable', async () => {
  const res = await fetch(`${base}/admin/api/requests/30000000-0000-0000-0000-000000000002/review`, {
    method: 'POST',
    headers: write('tok.moderator.x'),
    body: JSON.stringify({ decision: 'approved' }),
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), { error: 'no_lesson' });
});

test('admins look users up by exact email in the body, never in the URL', async () => {
  const lookup = (email: unknown) =>
    fetch(`${base}/admin/api/users/lookup`, { method: 'POST', headers: write('tok.admin.x'), body: JSON.stringify({ email }) });
  assert.deepEqual(((await (await lookup('MOD@unical.it')).json()) as { user: { role: string } }).user.role, 'moderator');
  assert.deepEqual(await (await lookup('nobody@unical.it')).json(), { user: null });
  assert.equal((await lookup('x')).status, 400);
  assert.equal((await lookup(42)).status, 400);
  assert.equal((await fetch(`${base}/admin/api/users?email=mod@unical.it`, { headers: as('tok.admin.x') })).status, 404);
});

test('approving a request that cannot be read fails closed', async () => {
  const res = await fetch(`${base}/admin/api/requests/30000000-0000-0000-0000-000000000077/review`, {
    method: 'POST',
    headers: write('tok.moderator.x'),
    body: JSON.stringify({ decision: 'approved' }),
  });
  assert.equal(res.status, 404);
});
