import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  clientConfig,
  createDb,
  PgSyncTarget,
  TargetError,
  translatePgError,
  type Db,
  type QueryClient,
} from '../src/sync/pg-target.js';
import { CAL_1, ROOM_A } from './fixtures.js';

const pgError = (code: string, message = 'x') => Object.assign(new Error(message), { code });

test('database and network errors become closed codes', () => {
  const table: [unknown, string][] = [
    [pgError('P0001', 'run_open'), 'run_open'],
    [pgError('P0001', 'payload_value'), 'payload_value'],
    [pgError('P0001', 'too_many_runs'), 'too_many_runs'],
    [pgError('P0001', 'internal'), 'internal'],
    [pgError('P0001', 'secret detail of row 42'), 'db_rejected'],
    [pgError('28P01'), 'auth'],
    [pgError('28000'), 'auth'],
    [pgError('57014'), 'timeout'],
    [pgError('42501'), 'forbidden'],
    [pgError('53300'), 'connections'],
    [pgError('08006'), 'connect'],
    [pgError('08P01'), 'connect'],
    [pgError('ECONNREFUSED'), 'connect'],
    [pgError('ENOTFOUND'), 'connect'],
    [pgError('EAI_AGAIN'), 'connect'],
    [pgError('ETIMEDOUT'), 'connect'],
    [pgError('ECONNRESET'), 'connect'],
    [pgError('EHOSTUNREACH'), 'connect'],
    [pgError('SELF_SIGNED_CERT_IN_CHAIN'), 'tls'],
    [pgError('UNABLE_TO_VERIFY_LEAF_SIGNATURE'), 'tls'],
    [pgError('DEPTH_ZERO_SELF_SIGNED_CERT'), 'tls'],
    [pgError('CERT_HAS_EXPIRED'), 'tls'],
    [pgError('ERR_TLS_CERT_ALTNAME_INVALID'), 'tls'],
    [pgError('UNABLE_TO_GET_ISSUER_CERT_LOCALLY'), 'tls'],
    [pgError('23505', 'duplicate key value violates unique constraint'), 'unknown'],
    [new Error('Connection terminated'), 'unknown'],
    ['a string', 'unknown'],
    [null, 'unknown'],
  ];
  for (const [err, code] of table) assert.equal(translatePgError(err), code);
});

function fakeClient(answer: (text: string, values: unknown[]) => unknown) {
  const queries: [string, unknown[]][] = [];
  const client: QueryClient & { ended: boolean } = {
    ended: false,
    async query(text, values) {
      queries.push([text, values]);
      return { rows: [{ r: answer(text, values) }] };
    },
    async end() {
      client.ended = true;
    },
  };
  return { client, queries };
}

test('Db.call builds one fixed statement per function and refuses anything else', async () => {
  const { client, queries } = fakeClient(() => 'ok');
  const db = createDb(client);
  assert.equal(await db.call('ping'), 'ok');
  await db.call('sync_put_calendar', [3, CAL_1, { from: 1, to: 2, skipped: 0, rooms: [], lessons: [] }]);
  await db.call('sync_fail_calendar', [3, CAL_1, 'timeout']);
  assert.deepEqual(queries, [
    ['select aule_sync.ping() as r', []],
    ['select aule_sync.sync_put_calendar($1::bigint, $2::text, $3::jsonb) as r', ['3', CAL_1, '{"from":1,"to":2,"skipped":0,"rooms":[],"lessons":[]}']],
    ['select aule_sync.sync_fail_calendar($1::bigint, $2::text, $3::text) as r', ['3', CAL_1, 'timeout']],
  ]);
  const bad = (fn: string, args: unknown[] = []) =>
    assert.rejects(db.call(fn as never, args), (err) => err instanceof TargetError && err.code === 'bad_call');
  await bad('room_status');
  await bad('ping; drop table x');
  await bad('toString');
  await bad('sync_begin', []);
  await bad('sync_finish', ['1']);
  await bad('sync_finish', [1.5]);
  await bad('put_proposals', ['{}']);
  assert.equal(queries.length, 3);
  await db.close();
  assert.equal(client.ended, true);
});

test('Db.call turns driver errors into TargetError with a closed code', async () => {
  const client: QueryClient = {
    async query() {
      throw pgError('P0001', 'calendar_done');
    },
    async end() {},
  };
  await assert.rejects(createDb(client).call('sync_finish', [1]), (err) => err instanceof TargetError && err.code === 'calendar_done');
  const leaky: QueryClient = {
    async query() {
      throw pgError('23514', 'new row for relation "lessons" violates check constraint, Mario Rossi');
    },
    async end() {},
  };
  await assert.rejects(createDb(leaky).call('sync_finish', [1]), (err) => {
    assert.ok(err instanceof TargetError);
    assert.equal(err.code, 'unknown');
    assert.equal(err.message, 'unknown');
    return true;
  });
});

test('concurrent Db.call never overlap on the one client, a failure does not block the next', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const order: string[] = [];
  let ended = false;
  const client: QueryClient = {
    async query(_text, values) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const tag = String(values[1] ?? values[0] ?? 'ping');
      order.push(`start ${tag}`);
      await new Promise((r) => setTimeout(r, tag === 'b' ? 1 : 15));
      order.push(`end ${tag}`);
      inFlight -= 1;
      if (tag === 'b') throw pgError('P0001', 'calendar_done');
      return { rows: [{ r: tag }] };
    },
    async end() {
      assert.equal(inFlight, 0);
      ended = true;
    },
  };
  const db = createDb(client);
  const a = db.call('sync_fail_calendar', [1, 'a', 'timeout']);
  const b = db.call('sync_fail_calendar', [1, 'b', 'timeout']);
  const c = db.call('sync_fail_calendar', [1, 'c', 'timeout']);
  const closed = db.close();
  assert.equal(await a, 'a');
  await assert.rejects(b, (err) => err instanceof TargetError && err.code === 'calendar_done');
  assert.equal(await c, 'c');
  await closed;
  assert.equal(maxInFlight, 1);
  assert.deepEqual(order, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(ended, true);
});

function dbAnswering(answer: unknown | (() => never)): Db & { calls: [string, readonly unknown[]][] } {
  const calls: [string, readonly unknown[]][] = [];
  return {
    calls,
    async call(fn, args = []) {
      calls.push([fn, args]);
      if (typeof answer === 'function') return (answer as () => never)();
      return answer;
    },
    async close() {},
  };
}

const START = {
  run: 42,
  from: 1794178800000,
  to: 1796079600000,
  calendars: [
    { id: CAL_1, source: 'planner', ref: null },
    { id: 'fffd0fb7c092ebc04936d5c8', source: 'portal', ref: '0880' },
  ],
  rooms: [{ id: ROOM_A, buildingKey: 'cubo-4d', roomKey: 'b6' }],
};

test('begin maps run_open and too_soon to skipped and returns a validated start', async () => {
  for (const code of ['run_open', 'too_soon'] as const) {
    const target = new PgSyncTarget(
      dbAnswering(() => {
        throw new TargetError(code);
      }),
    );
    assert.deepEqual(await target.begin('poll'), { skipped: code });
  }
  const tooMany = new PgSyncTarget(
    dbAnswering(() => {
      throw new TargetError('too_many_runs');
    }),
  );
  await assert.rejects(tooMany.begin('poll'), (err) => err instanceof TargetError && err.code === 'too_many_runs');
  const db = dbAnswering(START);
  assert.deepEqual(await new PgSyncTarget(db).begin('schedule'), START);
  assert.deepEqual(db.calls, [['sync_begin', ['schedule']]]);
});

test('begin refuses a malformed answer with bad_response', async () => {
  const variants: unknown[] = [
    null,
    [],
    { ...START, run: 0 },
    { ...START, run: '42' },
    { ...START, from: START.to },
    { ...START, to: Number.POSITIVE_INFINITY },
    { ...START, calendars: 'x' },
    { ...START, calendars: Array.from({ length: 601 }, () => START.calendars[0]) },
    { ...START, calendars: [{ id: CAL_1, source: 'web', ref: null }] },
    { ...START, calendars: [{ id: CAL_1, source: 'planner', ref: 'x' }] },
    { ...START, calendars: [{ id: 'fffd0fb7c092ebc04936d5c8', source: 'portal', ref: null }] },
    { ...START, calendars: [{ id: 'fffd0fb7c092ebc04936d5c8', source: 'portal', ref: 'x'.repeat(501) }] },
    { ...START, calendars: [{ id: 'XYZ', source: 'planner', ref: null }] },
    { ...START, rooms: [{ id: ROOM_A, buildingKey: 'Cubo 4D', roomKey: 'b6' }] },
    { ...START, rooms: [{ id: ROOM_A, buildingKey: 'cubo-4d', roomKey: 'b-6' }] },
    { ...START, rooms: [{ id: ROOM_A, buildingKey: 'cubo-4d', roomKey: '' }] },
    { ...START, rooms: [{ id: 'nope', buildingKey: 'cubo-4d', roomKey: 'b6' }] },
    { ...START, rooms: Array.from({ length: 3001 }, () => START.rooms[0]) },
  ];
  for (const answer of variants) {
    await assert.rejects(new PgSyncTarget(dbAnswering(answer)).begin('manual'), (err) => err instanceof TargetError && err.code === 'bad_response');
  }
});

test('finish validates the summary', async () => {
  const good = { run: 42, state: 'finished', failure: null, ok: 186, failed: 2, rooms: 186, lessons: 5546 };
  assert.deepEqual(await new PgSyncTarget(dbAnswering(good)).finish(42), good);
  const implausible = { run: 42, state: 'aborted', failure: 'implausible', ok: 10, failed: 0, rooms: null, lessons: null };
  assert.deepEqual(await new PgSyncTarget(dbAnswering(implausible)).finish(42), implausible);
  for (const answer of [
    { ...good, run: 41 },
    { ...good, state: 'open' },
    { ...good, failure: 'implausible' },
    { ...implausible, failure: null },
    { ...good, ok: -1 },
    { ...good, lessons: '5546' },
  ]) {
    await assert.rejects(new PgSyncTarget(dbAnswering(answer)).finish(42), (err) => err instanceof TargetError && err.code === 'bad_response');
  }
});

test('put, fail and abort call their functions with the run and calendar', async () => {
  const db = dbAnswering('');
  const target = new PgSyncTarget(db);
  const payload = { from: 1, to: 2, skipped: 0, rooms: [], lessons: [] };
  await target.put(42, CAL_1 as never, payload);
  await target.fail(42, CAL_1 as never, 'unsupported');
  await target.abort(42, 'client_id');
  assert.deepEqual(db.calls, [
    ['sync_put_calendar', [42, CAL_1, payload]],
    ['sync_fail_calendar', [42, CAL_1, 'unsupported']],
    ['sync_abort', [42, 'client_id']],
  ]);
});

test('TLS verifies chain and host name; only local hosts go without it', () => {
  const remote = clientConfig({
    host: 'db.example.com',
    port: 5432,
    user: 'aule_sync.abc',
    password: 'not-a-real-password',
    database: 'postgres',
    tls: { ca: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----' },
  });
  assert.deepEqual(remote.ssl, {
    ca: '-----BEGIN CERTIFICATE-----\nAA==\n-----END CERTIFICATE-----',
    rejectUnauthorized: true,
    servername: 'db.example.com',
  });
  assert.equal(remote.connectionString, undefined);
  assert.equal(remote.application_name, 'aule-sync');
  assert.equal(remote.connectionTimeoutMillis, 15000);
  assert.equal(remote.query_timeout, 70000);
  const local = clientConfig({ host: '127.0.0.1', port: 54322, user: 'aule_sync', password: 'not-a-real-password', database: 'postgres', tls: null });
  assert.equal(local.ssl, false);
});

const cli = (name: string) => fileURLToPath(new URL(`../src/cli/${name}.js`, import.meta.url));

function runCli(name: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [cli(name)], { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 20000 });
}

test('the CLIs refuse NODE_OPTIONS and NODE_PATH with exit 2', () => {
  for (const name of ['sync-db', 'discover-db', 'probe-planner']) {
    const out = runCli(name, { NODE_OPTIONS: '--trace-warnings' });
    assert.equal(out.status, 2, name);
    const lines = out.stderr.trim().split('\n');
    assert.equal(lines.length, 1, name);
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(line.event, 'config_invalid');
    assert.equal(line.field, 'NODE_OPTIONS');
  }
  const out = runCli('sync-db', { NODE_PATH: '/tmp/x' });
  assert.equal(out.status, 2);
  assert.match(out.stderr, /"field":"NODE_PATH"/);
});

test('sync-db refuses missing settings and remote hosts without CA, never echoing the password', () => {
  const none = runCli('sync-db', {});
  assert.equal(none.status, 2);
  assert.match(none.stderr, /"event":"config_invalid"/);
  const remote = runCli('sync-db', {
    SYNC_DB_HOST: 'db.example.com',
    SYNC_DB_USER: 'aule_sync',
    SYNC_DB_PASSWORD: 'pw-for-test-only',
    SYNC_DB_CA: 'config/missing-ca.crt',
  });
  assert.equal(remote.status, 2);
  assert.match(remote.stderr, /"field":"SYNC_DB_CA"/);
  assert.equal((remote.stdout + remote.stderr).includes('pw-for-test-only'), false);
  const trigger = runCli('sync-db', { SYNC_DB_HOST: '127.0.0.1', SYNC_DB_USER: 'aule_sync', SYNC_DB_PASSWORD: 'pw-for-test-only', SYNC_TRIGGER: 'admin' });
  assert.equal(trigger.status, 2);
  assert.match(trigger.stderr, /"field":"SYNC_TRIGGER"/);
});
