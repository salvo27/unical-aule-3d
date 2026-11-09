import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SyncService } from '../src/sync/sync.js';
import { SnapshotStore } from '../src/store/snapshot-store.js';
import { ConfigStore } from '../src/store/config-store.js';
import { setCalendarActive } from '../src/domain/admin-config.js';
import { PlannerError } from '../src/planner/parse.js';
import type { PlannerApi } from '../src/planner/client.js';
import { silentLogger } from '../src/log.js';
import { fakeEvent, CAL_1, CAL_2, ROOM_A, ROOM_B } from './fixtures.js';

const NOW = Date.parse('2026-11-16T09:00:00Z');
const CLIENT = '5de6319d4414ab02f80b613a';

async function setup(api: PlannerApi) {
  const dir = await mkdtemp(join(tmpdir(), 'aule-sync-'));
  const config = await ConfigStore.open(join(dir, 'admin.json'), {
    calendars: [
      { id: CAL_1, label: 'One' },
      { id: CAL_2, label: 'Two' },
    ],
    sources: [],
    roomSeeds: [],
  });
  const snapshots = await SnapshotStore.open(join(dir, 'snapshot.json'), silentLogger);
  const sync = new SyncService({ api, config, snapshots, log: silentLogger, now: () => NOW, pauseMs: 0 });
  return { dir, config, snapshots, sync };
}

function apiWith(byCalendar: Record<string, () => unknown>): PlannerApi {
  return {
    clientId: async () => CLIENT,
    calendarInfo: async () => ({}),
    calendarEvents: async (cal) => {
      const make = byCalendar[cal];
      if (!make) throw new PlannerError('http_status');
      return make();
    },
  };
}

const lessonIn = (room: string) => [
  fakeEvent({ start: '2026-11-16T08:00:00Z', end: '2026-11-16T10:00:00Z', room }),
];

test('a successful run stores lessons, rooms and a summary', async () => {
  const { snapshots, sync } = await setup(apiWith({ [CAL_1]: () => lessonIn(ROOM_A), [CAL_2]: () => lessonIn(ROOM_B) }));
  const summary = await sync.run('admin');
  assert.ok(summary);
  assert.equal(summary.ok, 2);
  assert.equal(summary.failed, 0);
  assert.equal(summary.outcome, 'completed');
  assert.deepEqual(Object.keys(snapshots.current.rooms).sort(), [ROOM_A, ROOM_B]);
  assert.equal(snapshots.current.calendars[CAL_1]!.fetchedAt, NOW);
});

test('a failed calendar keeps its previous good data', async () => {
  let failSecond = false;
  const api = apiWith({
    [CAL_1]: () => lessonIn(ROOM_A),
    [CAL_2]: () => {
      if (failSecond) throw new PlannerError('timeout');
      return lessonIn(ROOM_B);
    },
  });
  const { snapshots, sync } = await setup(api);
  await sync.run('admin');
  const before = snapshots.current.calendars[CAL_2];
  failSecond = true;
  const summary = await sync.run('schedule');
  assert.equal(summary!.failed, 1);
  assert.deepEqual(snapshots.current.calendars[CAL_2], before);
  assert.equal(snapshots.current.runs[CAL_2]!.outcome, 'failed');
  assert.equal(snapshots.current.runs[CAL_2]!.failure, 'timeout');
  assert.ok(snapshots.current.rooms[ROOM_B], 'room of the failed calendar is still known');
});

test('a malformed response counts as a failure, not as an empty calendar', async () => {
  const { snapshots, sync } = await setup(apiWith({ [CAL_1]: () => ({ unexpected: true }), [CAL_2]: () => lessonIn(ROOM_B) }));
  await sync.run('admin');
  assert.equal(snapshots.current.runs[CAL_1]!.failure, 'bad_shape');
  assert.equal(snapshots.current.calendars[CAL_1], undefined);
});

test('if the Planner is unreachable nothing is replaced', async () => {
  const good = apiWith({ [CAL_1]: () => lessonIn(ROOM_A), [CAL_2]: () => lessonIn(ROOM_B) });
  const { snapshots, sync } = await setup(good);
  await sync.run('admin');
  const before = snapshots.current.calendars;
  good.clientId = async () => {
    throw new PlannerError('network');
  };
  const summary = await sync.run('schedule');
  assert.equal(summary!.outcome, 'failed');
  assert.equal(summary!.failure, 'network');
  assert.deepEqual(snapshots.current.calendars, before);
});

test('only one run at a time', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const api = apiWith({
    [CAL_1]: async () => {
      await gate;
      return lessonIn(ROOM_A);
    },
    [CAL_2]: () => lessonIn(ROOM_B),
  });
  const { sync } = await setup(api);
  const first = sync.run('admin');
  assert.equal(sync.running, true);
  assert.equal(await sync.run('admin'), null);
  release();
  assert.ok(await first);
  assert.equal(sync.running, false);
});

test('deactivated calendars and their rooms disappear', async () => {
  const { config, snapshots, sync } = await setup(apiWith({ [CAL_1]: () => lessonIn(ROOM_A), [CAL_2]: () => lessonIn(ROOM_B) }));
  await sync.run('admin');
  await config.update((c) => setCalendarActive(c, CAL_2, false));
  await sync.run('admin');
  assert.equal(snapshots.current.calendars[CAL_2], undefined);
  assert.equal(snapshots.current.rooms[ROOM_B], undefined);
});

test('a corrupt snapshot is backed up and replaced by an empty one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aule-snap-'));
  const path = join(dir, 'snapshot.json');
  await writeFile(path, '{"version":1,');
  const store = await SnapshotStore.open(path, silentLogger);
  assert.deepEqual(store.current.calendars, {});
  const files = await readdir(dir);
  assert.ok(files.some((f) => f.startsWith('snapshot.json.corrupt-')));
});

test('a snapshot with wrong shapes drops only the bad lessons', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aule-snap-'));
  const path = join(dir, 'snapshot.json');
  const lesson = { id: ROOM_A, title: 'T', start: 1, end: 2, status: 'active', kind: '', courses: [], year: null, teachers: [], roomIds: [ROOM_A] };
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      rooms: {},
      runs: {},
      lastRun: null,
      calendars: { [CAL_1]: { fetchedAt: 1, from: 0, to: 10, lessons: [lesson, { ...lesson, start: 'x' }] } },
    }),
  );
  const store = await SnapshotStore.open(path, silentLogger);
  assert.equal(store.current.calendars[CAL_1]!.lessons.length, 1);
});
