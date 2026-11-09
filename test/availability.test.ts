import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, roomLessons } from '../src/availability/availability.js';
import { emptyConfig, setRoomFloor, linkBuilding } from '../src/domain/admin-config.js';
import { emptySnapshot, type Snapshot } from '../src/store/snapshot-store.js';
import type { Lesson, RoomInfo } from '../src/domain/model.js';
import type { Floor, PlannerId } from '../src/domain/primitives.js';
import type { Override } from '../src/supabase/gateway.js';
import { CAL_1, CAL_2, ROOM_A, ROOM_B } from './fixtures.js';

const H = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-16T10:30:00Z'); // 11:30 in Rome
const KEYS = new Set(['cubo-4d', 'cubo-30b']);
let n = 0;

function room(id: string, overrides: Partial<RoomInfo> = {}): RoomInfo {
  return { id: id as PlannerId, name: 'B6', code: 'AU_1', buildingName: 'Cubo 4D', capacity: 40, effectiveCapacity: 22, services: [], ...overrides };
}

function lesson(roomId: string, startH: number, endH: number, overrides: Partial<Lesson> = {}): Lesson {
  n += 1;
  return {
    id: n.toString(16).padStart(24, 'd') as PlannerId,
    title: 'Analisi',
    start: NOW + startH * H,
    end: NOW + endH * H,
    status: 'active',
    kind: '',
    courses: [],
    year: null,
    teachers: [],
    roomIds: [roomId as PlannerId],
    ...overrides,
  };
}

function snapshotWith(lessons: Lesson[], rooms: RoomInfo[], fetchedAt = NOW - H, calendar = CAL_1): Snapshot {
  const s = emptySnapshot();
  s.calendars[calendar] = { fetchedAt, from: NOW - 7 * 24 * H, to: NOW + 14 * 24 * H, lessons };
  for (const r of rooms) s.rooms[r.id] = r;
  return s;
}

function status(snapshot: Snapshot, config = emptyConfig(), seeds = new Map<string, Floor>()) {
  return computeStatus({ snapshot, config, roomSeeds: seeds, campusKeys: KEYS, now: NOW, staleAfterMs: 30 * H });
}

test('a room with a lesson now is busy until the end of back-to-back lessons', () => {
  const s = snapshotWith([lesson(ROOM_A, -1, 0.5), lesson(ROOM_A, 0.6, 2), lesson(ROOM_A, 3, 4)], [room(ROOM_A)]);
  const r = status(s).rooms[0]!;
  assert.equal(r.state, 'busy');
  assert.equal(r.until, NOW + 2 * H);
  assert.equal(r.current?.title, 'Analisi');
});

test('a free room is free until the next lesson of the same day', () => {
  const s = snapshotWith([lesson(ROOM_A, 1, 2)], [room(ROOM_A)]);
  const r = status(s).rooms[0]!;
  assert.equal(r.state, 'free');
  assert.equal(r.until, NOW + H);
});

test('a lesson tomorrow does not limit today', () => {
  const s = snapshotWith([lesson(ROOM_A, 20, 22)], [room(ROOM_A)]);
  const r = status(s).rooms[0]!;
  assert.equal(r.state, 'free');
  assert.equal(r.until, null);
  assert.equal(r.next?.start, NOW + 20 * H);
});

test('a lesson ending exactly now leaves the room free', () => {
  const s = snapshotWith([lesson(ROOM_A, -2, 0)], [room(ROOM_A)]);
  assert.equal(status(s).rooms[0]!.state, 'free');
});

test('a cancelled lesson does not occupy the room', () => {
  const s = snapshotWith([lesson(ROOM_A, -1, 1, { status: 'cancelled' })], [room(ROOM_A)]);
  assert.equal(status(s).rooms[0]!.state, 'free');
});

test('old data makes the room unknown, never free', () => {
  const lessons = [lesson(ROOM_A, 5, 6)];
  assert.equal(status(snapshotWith(lessons, [room(ROOM_A)])).rooms[0]!.state, 'free', 'control: fresh data is free');
  const out = status(snapshotWith(lessons, [room(ROOM_A)], NOW - 31 * H));
  assert.equal(out.rooms[0]!.state, 'unknown');
  assert.equal(out.staleCalendars, 1);
});

test('data that does not cover today makes the room unknown', () => {
  const s = snapshotWith([lesson(ROOM_A, 5, 6)], [room(ROOM_A)]);
  assert.equal(status(s).rooms[0]!.state, 'free', 'control: covered today');
  s.calendars[CAL_1]!.to = NOW - H;
  assert.equal(status(s).rooms[0]!.state, 'unknown');
});

test('a room shared by a fresh and a stale calendar is unknown', () => {
  const s = snapshotWith([lesson(ROOM_A, 5, 6)], [room(ROOM_A)]);
  s.calendars[CAL_2] = { fetchedAt: NOW - 40 * H, from: NOW - 100 * H, to: NOW + 100 * H, lessons: [lesson(ROOM_A, 7, 8)] };
  assert.equal(status(s).rooms[0]!.state, 'unknown');
});

test('the same lesson in two calendars is counted once', () => {
  const shared = lesson(ROOM_A, 1, 2);
  const s = snapshotWith([shared], [room(ROOM_A)]);
  s.calendars[CAL_2] = { ...s.calendars[CAL_1]!, lessons: [shared] };
  const lessons = roomLessons(s, ROOM_A, NOW - 24 * H, NOW + 24 * H);
  assert.equal(lessons.length, 1);
});

test('floors come from admin first, then from seeds, else unknown', () => {
  const s = snapshotWith([lesson(ROOM_A, 1, 2), lesson(ROOM_B, -1, 1)], [room(ROOM_A), room(ROOM_B, { name: 'Aula MT1', buildingName: 'Cubo 30B' })]);
  const config = setRoomFloor(emptyConfig(), ROOM_A, 3);
  const seeds = new Map<string, Floor>([['cubo-30b|mt1', 0 as Floor]]);
  const out = status(s, config, seeds);
  const a = out.rooms.find((r) => r.id === ROOM_A)!;
  const b = out.rooms.find((r) => r.id === ROOM_B)!;
  assert.equal(a.floor, 3);
  assert.equal(b.floor, 0);
  assert.deepEqual(out.buildings['cubo-4d']!.floors['3'], { free: 1, busy: 0, unknown: 0 });
  assert.deepEqual(out.buildings['cubo-30b']!.floors['0'], { free: 0, busy: 1, unknown: 0 });
});

test('rooms of unknown buildings stay off the map until an admin links them', () => {
  const s = snapshotWith([lesson(ROOM_A, 1, 2)], [room(ROOM_A, { buildingName: 'Polo nuovo' })]);
  assert.equal(status(s).rooms[0]!.buildingKey, null);
  assert.deepEqual(status(s).unmatchedBuildings, ['Polo nuovo']);
  const linked = linkBuilding(emptyConfig(), KEYS, 'Polo nuovo', 'cubo-30b');
  assert.equal(status(s, linked).rooms[0]!.buildingKey, 'cubo-30b');
});

test('every campus building gets a shape, cubes taller by default', () => {
  const out = status(emptySnapshot());
  assert.deepEqual(out.shapes['cubo-4d'], { floors: 5, baseLevel: 0 });
});

function override(
  roomId: string,
  kind: Override['kind'],
  startH: number,
  endH: number,
  source: Override['source'] = 'approved',
  category: Override['category'] = null,
  lessonId: string | null = null,
): Override {
  return { roomId, kind, category, lessonId, start: NOW + startH * H, end: NOW + endH * H, source };
}

function statusWith(snapshot: Snapshot, overrides: Override[]) {
  return computeStatus({ snapshot, config: emptyConfig(), roomSeeds: new Map(), campusKeys: KEYS, now: NOW, staleAfterMs: 30 * H, overrides, reportsAvailable: true });
}

test('an approved "occupied" report makes a free room busy until it ends', () => {
  const s = snapshotWith([lesson(ROOM_A, 20, 22)], [room(ROOM_A)]);
  const r = statusWith(s, [override(ROOM_A, 'room_occupied', -0.5, 0.5)]).rooms[0]!;
  assert.equal(r.state, 'busy');
  assert.equal(r.report, 'occupied');
  assert.equal(r.until, NOW + 0.5 * H);
});

test('enough people agreeing shows the room busy, marked as crowd', () => {
  const s = snapshotWith([lesson(ROOM_A, 20, 22)], [room(ROOM_A)]);
  assert.equal(statusWith(s, [override(ROOM_A, 'room_occupied', -0.2, 0.8, 'crowd')]).rooms[0]!.report, 'crowd');
});

test('a closure later today shortens the free time', () => {
  const s = snapshotWith([lesson(ROOM_A, 5, 6)], [room(ROOM_A)]);
  const r = statusWith(s, [override(ROOM_A, 'room_closed', 2, 4)]).rooms[0]!;
  assert.equal(r.state, 'free');
  assert.equal(r.until, NOW + 2 * H);
});

test('an approved "not held" frees the room, only for that lesson', () => {
  const held = lesson(ROOM_A, -1, 1);
  const s = snapshotWith([held], [room(ROOM_A)]);
  const notHeld = override(ROOM_A, 'lesson_not_held', -1, 1, 'approved', null, held.id);
  assert.equal(statusWith(s, [notHeld]).rooms[0]!.state, 'free');
  assert.equal(statusWith(s, [{ ...notHeld, source: 'crowd' }]).rooms[0]!.state, 'busy', 'not approved, no effect');
  assert.equal(statusWith(s, [{ ...notHeld, lessonId: 'ffffffffffffffffffffffff' }]).rooms[0]!.state, 'busy', 'another lesson id, no effect');
  assert.equal(statusWith(s, [{ ...notHeld, roomId: ROOM_B }]).rooms[0]!.state, 'busy', 'another room, no effect');
  const lessons = roomLessons(s, ROOM_A, NOW - 24 * H, NOW + 24 * H, [notHeld]);
  assert.equal(lessons[0]!.status, 'cancelled');
  assert.equal(lessons[0]!.notHeld, true);
});

test('an overlapping lesson stays busy when another one was not held', () => {
  const first = lesson(ROOM_A, -1, 1);
  const second = lesson(ROOM_A, -0.5, 2);
  const s = snapshotWith([first, second], [room(ROOM_A)]);
  const r = statusWith(s, [override(ROOM_A, 'lesson_not_held', -1, 1, 'approved', null, first.id)]).rooms[0]!;
  assert.equal(r.state, 'busy');
  assert.equal(r.until, NOW + 2 * H);
});

test('busy until covers reports and lessons together', () => {
  const s = snapshotWith([lesson(ROOM_A, 0.5, 2.5)], [room(ROOM_A)]);
  const r = statusWith(s, [override(ROOM_A, 'room_occupied', -0.5, 1)]).rooms[0]!;
  assert.equal(r.state, 'busy');
  assert.equal(r.until, NOW + 2.5 * H, 'the report runs into the lesson');
  assert.equal(r.report, 'occupied');
  const t = snapshotWith([lesson(ROOM_A, -1, 0.5)], [room(ROOM_A)]);
  const closedAfter = statusWith(t, [override(ROOM_A, 'room_closed', 0.6, 3)]).rooms[0]!;
  assert.equal(closedAfter.until, NOW + 3 * H, 'a closure right after the lesson extends it');
  assert.equal(closedAfter.report, null, 'during a lesson the banner shows the lesson');
});

test('issues are listed but do not change availability', () => {
  const s = snapshotWith([lesson(ROOM_A, 20, 22)], [room(ROOM_A)]);
  const r = statusWith(s, [override(ROOM_A, 'issue', -1, 100, 'approved', 'proiettore')]).rooms[0]!;
  assert.equal(r.state, 'free');
  assert.deepEqual(r.issues, [{ category: 'proiettore', until: NOW + 100 * H }]);
});

test('reports never turn stale data into a known state', () => {
  const s = snapshotWith([lesson(ROOM_A, 5, 6)], [room(ROOM_A)], NOW - 40 * H);
  assert.equal(statusWith(s, [override(ROOM_A, 'room_occupied', -0.5, 0.5)]).rooms[0]!.state, 'unknown');
});

test('a "not held" stops applying if the timetable moves the lesson', () => {
  const moved = lesson(ROOM_A, -0.5, 1.5);
  const s = snapshotWith([moved], [room(ROOM_A)]);
  const approvedForOldTimes = override(ROOM_A, 'lesson_not_held', -1, 1, 'approved', null, moved.id);
  assert.equal(statusWith(s, [approvedForOldTimes]).rooms[0]!.state, 'busy');
});

test('reports for other rooms have no effect', () => {
  const s = snapshotWith([lesson(ROOM_A, 20, 22)], [room(ROOM_A)]);
  assert.equal(statusWith(s, [override(ROOM_B, 'room_occupied', -0.5, 0.5)]).rooms[0]!.state, 'free');
});
