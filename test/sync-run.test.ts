import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSync, TargetError, type SyncStart, type SyncSummary, type SyncTarget } from '../src/sync/run.js';
import type { CalendarPayload } from '../src/sync/payload.js';
import { SourceError, type Feed, type FetchContext, type SourceAdapter, type SourceData, type SourceKind } from '../src/sources/types.js';
import { parseLessons } from '../src/planner/parse.js';
import { feedId } from '../src/domain/ids.js';
import { calendarId, type PlannerId } from '../src/domain/primitives.js';
import type { PlannerApi } from '../src/planner/client.js';
import { plannerAdapter } from '../src/sources/planner.js';
import { silentLogger } from '../src/log.js';
import { fakeEvent, ROOM_A, ROOM_B, CAL_1, CAL_2 } from './fixtures.js';

const FROM = Date.parse('2026-11-08T23:00:00Z');
const TO = Date.parse('2026-11-30T23:00:00Z');
const CAL_3 = calendarId('333333333333333333333333');
const XLSX_1 = feedId('xlsx', 'LT|I ANNO - Ambiente');
const XLSX_2 = feedId('xlsx', 'LT|II ANNO - Ambiente');
const PORTAL_1 = feedId('portal', '0880');
const planner = (id: string): Feed => ({ id: calendarId(id), source: 'planner', ref: null });

type Call = [string, ...unknown[]];

class FakeTarget implements SyncTarget {
  calls: Call[] = [];
  start: SyncStart | { skipped: 'run_open' | 'too_soon' };
  putError: (calendar: string) => Error | null = () => null;
  summary: Partial<SyncSummary> = {};

  constructor(calendars: Feed[], rooms: SyncStart['rooms'] = []) {
    this.start = { run: 7, from: FROM, to: TO, calendars, rooms };
  }
  async begin(trigger: string) {
    this.calls.push(['begin', trigger]);
    return this.start;
  }
  async put(run: number, calendar: string, payload: CalendarPayload) {
    this.calls.push(['put', run, calendar, payload]);
    const err = this.putError(calendar);
    if (err) throw err;
  }
  async fail(run: number, calendar: string, failure: string) {
    this.calls.push(['fail', run, calendar, failure]);
  }
  async finish(run: number): Promise<SyncSummary> {
    this.calls.push(['finish', run]);
    const ok = this.calls.filter((c) => c[0] === 'put').length;
    return { run, state: 'finished', failure: null, ok, failed: 0, rooms: 1, lessons: ok, ...this.summary };
  }
  async abort(run: number, failure: string) {
    this.calls.push(['abort', run, failure]);
  }
  kinds(): string[] {
    return this.calls.map((c) => c[0]);
  }
  of(kind: string): Call[] {
    return this.calls.filter((c) => c[0] === kind);
  }
}

const lessonsIn = (room: string, roomName = 'B6', building = 'Cubo 4D') =>
  parseLessons([fakeEvent({ start: '2026-11-16T08:00:00Z', end: '2026-11-16T10:00:00Z', room, roomName, building })]);

function adapter(
  kind: SourceKind,
  fetch: (feed: Feed, ctx: FetchContext) => Promise<SourceData> | SourceData,
  prepare: () => Promise<void> = async () => undefined,
): SourceAdapter & { seen: FetchContext[] } {
  const seen: FetchContext[] = [];
  return {
    kind,
    seen,
    prepare,
    async fetch(feed, ctx) {
      seen.push(ctx);
      return fetch(feed, ctx);
    },
  };
}

const ok = (room = ROOM_A) => (_f: Feed, ctx: FetchContext): SourceData => ({ parsed: lessonsIn(room), from: ctx.from, to: ctx.to });

test('a successful run puts every feed and finishes', async () => {
  const target = new FakeTarget([planner(CAL_1), planner(CAL_2)]);
  const result = await runSync({ adapters: { planner: adapter('planner', ok()) }, target, log: silentLogger, pauseMs: 0 }, 'schedule');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.of('begin'), [['begin', 'schedule']]);
  assert.deepEqual(target.of('put').map((c) => c[2]).sort(), [CAL_1, CAL_2]);
  assert.equal(target.kinds().at(-1), 'finish');
  const payload = target.of('put')[0]![3] as CalendarPayload;
  assert.equal(payload.from, FROM);
  assert.equal(payload.to, TO);
  assert.equal(payload.lessons.length, 1);
});

test('one source error fails only that feed', async () => {
  const fetch = (feed: Feed, ctx: FetchContext) => {
    if (feed.id === CAL_2) throw new SourceError('timeout');
    return ok()(feed, ctx);
  };
  const target = new FakeTarget([planner(CAL_1), planner(CAL_2), planner(CAL_3)]);
  const result = await runSync({ adapters: { planner: adapter('planner', fetch) }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.of('fail'), [['fail', 7, CAL_2, 'timeout']]);
  assert.deepEqual(target.of('put').map((c) => c[2]).sort(), [CAL_1, CAL_3]);
});

test('a malformed response fails with bad_shape, any other exception with unexpected', async () => {
  const api: PlannerApi = {
    clientId: async () => '5de6319d4414ab02f80b613a',
    calendarInfo: async () => ({}),
    calendarEvents: async () => ({ unexpected: true }),
  };
  const target = new FakeTarget([planner(CAL_1)]);
  await runSync({ adapters: { planner: plannerAdapter(api) }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.deepEqual(target.of('fail'), [['fail', 7, CAL_1, 'bad_shape']]);

  const broken = adapter('planner', () => {
    throw new TypeError('boom');
  });
  const second = new FakeTarget([planner(CAL_2)]);
  await runSync({ adapters: { planner: broken }, target: second, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.deepEqual(second.of('fail'), [['fail', 7, CAL_2, 'unexpected']]);
});

test('Planner prepare failing aborts the run with nothing put, failed or finished', async () => {
  const target = new FakeTarget([planner(CAL_1), { id: XLSX_1, source: 'xlsx', ref: 'x' }]);
  const failingPlanner = adapter('planner', ok(), async () => {
    throw new SourceError('network');
  });
  const result = await runSync({ adapters: { planner: failingPlanner }, target, log: silentLogger, pauseMs: 0 }, 'poll');
  assert.deepEqual(result, { kind: 'aborted', run: 7, failure: 'network' });
  assert.deepEqual(target.kinds(), ['begin', 'abort']);
  assert.deepEqual(target.of('abort'), [['abort', 7, 'network']]);
  assert.equal(failingPlanner.seen.length, 0);
});

test('a non closed prepare error aborts as unexpected', async () => {
  const target = new FakeTarget([planner(CAL_1)]);
  const failing = adapter('planner', ok(), async () => {
    throw new Error('x');
  });
  const result = await runSync({ adapters: { planner: failing }, target, log: silentLogger, pauseMs: 0 }, 'poll');
  assert.deepEqual(result, { kind: 'aborted', run: 7, failure: 'unexpected' });
});

test('a skipped begin calls no source', async () => {
  const target = new FakeTarget([planner(CAL_1)]);
  target.start = { skipped: 'too_soon' };
  const source = adapter('planner', ok());
  const result = await runSync({ adapters: { planner: source }, target, log: silentLogger, pauseMs: 0 }, 'poll');
  assert.deepEqual(result, { kind: 'skipped', reason: 'too_soon' });
  assert.deepEqual(target.kinds(), ['begin']);
  assert.equal(source.seen.length, 0);
});

test('a payload rejected by the database fails that feed as rejected', async () => {
  const target = new FakeTarget([planner(CAL_1), planner(CAL_2)]);
  target.putError = (calendar) => (calendar === CAL_1 ? new TargetError('payload_value') : null);
  const result = await runSync({ adapters: { planner: adapter('planner', ok()) }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.of('fail'), [['fail', 7, CAL_1, 'rejected']]);
});

test('a database error stops every worker and rejects the run without finish', async () => {
  const feeds = Array.from({ length: 9 }, (_, i) => planner(String(i + 1).repeat(24)));
  const target = new FakeTarget(feeds);
  target.putError = (calendar) => (calendar === feeds[1]!.id ? new TargetError('connect') : null);
  const source = adapter('planner', async (feed, ctx) => {
    await new Promise((r) => setTimeout(r, feed.id === feeds[1]!.id ? 1 : 20));
    return ok()(feed, ctx);
  });
  await assert.rejects(
    runSync({ adapters: { planner: source }, target, log: silentLogger, pauseMs: 0 }, 'manual'),
    (err) => err instanceof TargetError && err.code === 'connect',
  );
  assert.equal(source.seen.length, 3, 'no feed starts after the error');
  assert.equal(target.of('finish').length, 0);
});

test('never more than 3 fetches in flight, the window from begin reaches every fetch', async () => {
  const feeds = Array.from({ length: 8 }, (_, i) => planner(String(i + 1).repeat(24)));
  const target = new FakeTarget(feeds);
  let inFlight = 0;
  let max = 0;
  const source = adapter('planner', async (feed, ctx) => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return ok()(feed, ctx);
  });
  await runSync({ adapters: { planner: source }, target, log: silentLogger, pauseMs: 1 }, 'manual');
  assert.equal(max, 3);
  assert.equal(source.seen.length, 8);
  assert.ok(source.seen.every((ctx) => ctx.from === FROM && ctx.to === TO));
  assert.equal(target.of('put').length, 8);
});

test('Planner feeds run first and their new rooms enter the directory', async () => {
  const order: string[] = [];
  const plannerSource = adapter('planner', (feed, ctx) => {
    order.push(`planner:${feed.id}`);
    return { parsed: lessonsIn(ROOM_B, 'CONSOLIDATA 2B', 'Cubo 2B'), from: ctx.from, to: ctx.to };
  });
  const xlsxSource = adapter('xlsx', (feed, ctx) => {
    order.push(`xlsx:${feed.id}`);
    return { parsed: { lessons: [], rooms: [], skipped: 0 }, from: ctx.from, to: ctx.to };
  });
  const target = new FakeTarget(
    [{ id: XLSX_1, source: 'xlsx', ref: 'a' }, planner(CAL_1)],
    [{ id: ROOM_A as PlannerId, buildingKey: 'cubo-4d', roomKey: 'b6' }],
  );
  await runSync({ adapters: { planner: plannerSource, xlsx: xlsxSource }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.deepEqual(order, [`planner:${CAL_1}`, `xlsx:${XLSX_1}`]);
  const rooms = xlsxSource.seen[0]!.plannerRooms;
  assert.equal(rooms.get('cubo-2b|consolidata2b'), ROOM_B);
  assert.equal(rooms.get('cubo-4d|b6'), ROOM_A);
  assert.equal(plannerSource.seen[0]!.plannerRooms.size, 0);
});

test('a directory key seen with two ids is removed', async () => {
  const plannerSource = adapter('planner', (_feed, ctx) => ({ parsed: lessonsIn(ROOM_B, 'B6', 'Cubo 4D'), from: ctx.from, to: ctx.to }));
  const xlsxSource = adapter('xlsx', (_feed, ctx) => ({ parsed: { lessons: [], rooms: [], skipped: 0 }, from: ctx.from, to: ctx.to }));
  const target = new FakeTarget(
    [planner(CAL_1), { id: XLSX_1, source: 'xlsx', ref: 'a' }],
    [
      { id: ROOM_A as PlannerId, buildingKey: 'cubo-4d', roomKey: 'b6' },
      { id: 'cccccccccccccccccccccccc' as PlannerId, buildingKey: 'cubo-1a', roomKey: 'a1' },
    ],
  );
  await runSync({ adapters: { planner: plannerSource, xlsx: xlsxSource }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  const rooms = xlsxSource.seen[0]!.plannerRooms;
  assert.equal(rooms.has('cubo-4d|b6'), false);
  assert.equal(rooms.get('cubo-1a|a1'), 'cccccccccccccccccccccccc');
});

test('a source without adapter gives unsupported for each of its feeds', async () => {
  const target = new FakeTarget([planner(CAL_1), { id: PORTAL_1, source: 'portal', ref: '0880' }, { id: XLSX_1, source: 'xlsx', ref: 'a' }]);
  const result = await runSync({ adapters: { planner: adapter('planner', ok()) }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.of('fail'), [
    ['fail', 7, PORTAL_1, 'unsupported'],
    ['fail', 7, XLSX_1, 'unsupported'],
  ]);
});

test('a non Planner prepare failure fails only its feeds', async () => {
  const xlsx = adapter('xlsx', ok(), async () => {
    throw new SourceError('http_status');
  });
  const portal = adapter('portal', (_f, ctx) => ({ parsed: { lessons: [], rooms: [], skipped: 0 }, from: ctx.from, to: ctx.to }), async () => {
    throw new SourceError('client_id');
  });
  const target = new FakeTarget([
    planner(CAL_1),
    { id: PORTAL_1, source: 'portal', ref: '0880' },
    { id: XLSX_1, source: 'xlsx', ref: 'a' },
    { id: XLSX_2, source: 'xlsx', ref: 'b' },
  ]);
  const result = await runSync({ adapters: { planner: adapter('planner', ok()), xlsx, portal }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.of('put').map((c) => c[2]), [CAL_1]);
  assert.deepEqual(target.of('fail'), [
    ['fail', 7, PORTAL_1, 'unexpected'],
    ['fail', 7, XLSX_1, 'http_status'],
    ['fail', 7, XLSX_2, 'http_status'],
  ]);
  assert.equal(xlsx.seen.length, 0);
});

test('finish answering implausible gives an aborted result', async () => {
  const target = new FakeTarget([planner(CAL_1)]);
  target.summary = { state: 'aborted', failure: 'implausible', rooms: null, lessons: null };
  const result = await runSync({ adapters: { planner: adapter('planner', ok()) }, target, log: silentLogger, pauseMs: 0 }, 'schedule');
  assert.deepEqual(result, { kind: 'aborted', run: 7, failure: 'implausible' });
});

test('no calendars: nothing fetched, the run still finishes', async () => {
  const target = new FakeTarget([]);
  const source = adapter('planner', ok(), async () => {
    throw new SourceError('network');
  });
  const result = await runSync({ adapters: { planner: source }, target, log: silentLogger, pauseMs: 0 }, 'schedule');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.kinds(), ['begin', 'finish']);
});

test('skipped entries are logged with the feed id and count only', async () => {
  const lines: [string, Record<string, unknown> | undefined][] = [];
  const log = {
    info: (e: string, f?: Record<string, unknown>) => lines.push([e, f]),
    warn: (e: string, f?: Record<string, unknown>) => lines.push([e, f]),
    error: (e: string, f?: Record<string, unknown>) => lines.push([e, f]),
  };
  const withSkipped = (_f: Feed, ctx: FetchContext): SourceData => ({ parsed: { ...lessonsIn(ROOM_A), skipped: 2 }, from: ctx.from, to: ctx.to });
  const target = new FakeTarget([planner(CAL_1)]);
  await runSync({ adapters: { planner: adapter('planner', withSkipped) }, target, log, pauseMs: 0 }, 'manual');
  assert.deepEqual(
    lines.map(([e]) => e),
    ['sync_started', 'calendar_entries_skipped', 'sync_finished'],
  );
  assert.deepEqual(lines[1]![1], { calendar: CAL_1, skipped: 2 });
  assert.equal(JSON.stringify(lines).includes('Rossi'), false);
});

test('a feed with too many skipped items fails with bad_shape before any put', async () => {
  const lines: [string, Record<string, unknown> | undefined][] = [];
  const at = (e: string, f?: Record<string, unknown>) => void lines.push([e, f]);
  const log = { info: at, warn: at, error: at };
  const skipping = (skipped: number) => (_f: Feed, ctx: FetchContext): SourceData => ({ parsed: { ...lessonsIn(ROOM_A), skipped }, from: ctx.from, to: ctx.to });
  const fetch = (feed: Feed, ctx: FetchContext) => (feed.id === CAL_1 ? skipping(11)(feed, ctx) : skipping(10)(feed, ctx));
  const target = new FakeTarget([planner(CAL_1), planner(CAL_2)]);
  const result = await runSync({ adapters: { planner: adapter('planner', fetch) }, target, log, pauseMs: 0 }, 'manual');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.of('fail'), [['fail', 7, CAL_1, 'bad_shape']]);
  assert.deepEqual(target.of('put').map((c) => c[2]), [CAL_2]);
  assert.deepEqual(
    lines.filter(([e]) => e === 'calendar_too_many_skipped'),
    [['calendar_too_many_skipped', { calendar: CAL_1, skipped: 11, lessons: 1 }]],
  );
});

test('a split long event counts once against the skipped threshold', async () => {
  const long = parseLessons([fakeEvent({ start: '2026-11-08T23:00:00Z', end: '2026-11-30T23:00:00Z' })], { from: FROM, to: TO });
  assert.deepEqual([long.lessons.length, long.pieces], [44, 43]);
  const target = new FakeTarget([planner(CAL_1)]);
  const source = adapter('planner', (_f, ctx) => ({ parsed: { ...long, skipped: 11 }, from: ctx.from, to: ctx.to }));
  const result = await runSync({ adapters: { planner: source }, target, log: silentLogger, pauseMs: 0 }, 'manual');
  assert.equal(result.kind, 'finished');
  assert.deepEqual(target.of('fail'), [['fail', 7, CAL_1, 'bad_shape']]);
  assert.deepEqual(target.of('put'), []);
});
