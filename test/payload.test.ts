import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPayload, INCLUDE_TEACHERS, lessonColumns, roomColumns, tooManySkipped } from '../src/sync/payload.js';
import { parseLessons, type ParsedCalendar } from '../src/planner/parse.js';
import type { Lesson, RoomInfo } from '../src/domain/model.js';
import type { PlannerId } from '../src/domain/primitives.js';
import { fakeEvent, ROOM_A, ROOM_B } from './fixtures.js';

const FROM = Date.parse('2026-11-08T23:00:00Z');
const TO = Date.parse('2026-11-30T23:00:00Z');
const HOUR = 3_600_000;
const DIRECTORY_ROOM = 'dddddddddddddddddddddddd' as PlannerId;

const room = (id: string, o: Partial<RoomInfo> = {}): RoomInfo => ({
  id: id as PlannerId,
  name: 'B6',
  code: 'AU_0001',
  buildingName: 'Cubo 4D',
  capacity: 40,
  effectiveCapacity: 22,
  services: [],
  ...o,
});

let next = 0;
const lesson = (o: Partial<Lesson> = {}): Lesson => {
  next += 1;
  return {
    id: next.toString(16).padStart(24, 'e') as PlannerId,
    title: 'FISICA',
    start: FROM + HOUR,
    end: FROM + 2 * HOUR,
    status: 'active',
    kind: '',
    courses: [],
    year: null,
    teachers: [],
    roomIds: [ROOM_A as PlannerId],
    ...o,
  };
};

test('precomputed columns for a fake event', () => {
  const parsed = parseLessons([fakeEvent({ start: '2026-11-16T08:00:00Z', end: '2026-11-16T10:00:00Z', title: 'Analisi Matematica  I' })]);
  const payload = buildPayload(parsed, FROM, TO);
  assert.equal(payload.lessons.length, 1);
  const r = payload.rooms[0]!;
  assert.deepEqual(
    { buildingKeyGuess: r.buildingKeyGuess, roomKey: r.roomKey, nameCompact: r.nameCompact, searchText: r.searchText },
    { buildingKeyGuess: 'cubo-4d', roomKey: 'b6', nameCompact: 'b6', searchText: 'b6 au_0001 cubo 4d' },
  );
  const l = payload.lessons[0]!;
  assert.equal(l.titleText, 'analisi matematica i');
  assert.equal(l.directText, 'analisi matematica i');
  assert.equal(l.courseText, 'analisi matematica i corso di laurea di prova');
  assert.deepEqual(Object.keys(payload).sort(), ['from', 'lessons', 'rooms', 'skipped', 'to']);
  assert.deepEqual(Object.keys(r).sort(), [
    'buildingKeyGuess', 'buildingName', 'capacity', 'code', 'effectiveCapacity', 'id', 'name', 'nameCompact', 'roomKey', 'searchText', 'services',
  ]);
  assert.deepEqual(Object.keys(l).sort(), [
    'courseText', 'courses', 'directText', 'end', 'id', 'kind', 'roomIds', 'start', 'status', 'teachers', 'title', 'titleText', 'year',
  ]);
});

test('room columns: the "aula" prefix and spaces leave the compact name', () => {
  const c = roomColumns(room(ROOM_A, { name: 'Aula Magna  Caldora', code: '', buildingName: 'Polifunzionale' }));
  assert.equal(c.nameCompact, 'magnacaldora');
  assert.equal(c.roomKey, 'magnacaldora');
  assert.equal(c.buildingKeyGuess, 'polifunzionale');
  assert.equal(c.searchText, 'aula magna caldora polifunzionale');
  assert.deepEqual(lessonColumns(lesson({ title: 'Àrte', teachers: ['Ugo Neri'], courses: ['Corso'] })), {
    titleText: 'arte',
    directText: 'arte',
    courseText: 'arte corso',
  });
});

test('no teacher name reaches the payload or its search texts', () => {
  assert.equal(INCLUDE_TEACHERS, false);
  const parsed: ParsedCalendar = {
    rooms: [room(ROOM_A)],
    lessons: [
      lesson({ title: 'Fisica', teachers: ['Ugo Neri', 'Anna Bianchi'], courses: ['Corso di prova'] }),
      lesson({ title: 'Chimica', teachers: ['X\uD800'] }),
    ],
    skipped: 0,
  };
  const payload = buildPayload(parsed, FROM, TO);
  assert.equal(payload.lessons.length, 2, 'a name SQL could not store no longer drops a lesson');
  for (const l of payload.lessons) {
    assert.deepEqual(l.teachers, []);
    assert.equal(l.directText, l.titleText);
  }
  assert.equal(payload.lessons[0]!.courseText, 'fisica corso di prova');
  const planner = buildPayload(parseLessons([fakeEvent({ start: '2026-11-16T08:00:00Z', end: '2026-11-16T10:00:00Z' })]), FROM, TO);
  assert.equal(planner.lessons.length, 1);
  assert.equal(/neri|bianchi|rossi|mario/i.test(JSON.stringify([payload, planner])), false);
});

test('lessons outside the coverage are dropped and counted, unused rooms are dropped', () => {
  const parsed: ParsedCalendar = {
    rooms: [room(ROOM_A), room(ROOM_B, { name: 'B7' })],
    lessons: [
      lesson({ start: FROM - 2 * HOUR, end: FROM, roomIds: [ROOM_B as PlannerId] }),
      lesson({ start: TO, end: TO + HOUR, roomIds: [ROOM_B as PlannerId] }),
      lesson({ start: FROM - HOUR, end: FROM + HOUR }),
      lesson({ start: TO - HOUR, end: TO + HOUR }),
    ],
    skipped: 3,
  };
  const payload = buildPayload(parsed, FROM, TO);
  assert.equal(payload.lessons.length, 2);
  assert.equal(payload.skipped, 5);
  assert.deepEqual(payload.rooms.map((r) => r.id), [ROOM_A]);
  assert.equal(payload.from, FROM);
  assert.equal(payload.to, TO);
});

test('room ids of directory rooms are kept, order of the source is kept', () => {
  const a = lesson({ roomIds: [DIRECTORY_ROOM, ROOM_A as PlannerId] });
  const b = lesson({ roomIds: [DIRECTORY_ROOM] });
  const payload = buildPayload({ rooms: [room(ROOM_A)], lessons: [a, b], skipped: 0 }, FROM, TO);
  assert.deepEqual(payload.lessons.map((l) => l.id), [a.id, b.id]);
  assert.deepEqual(payload.lessons[0]!.roomIds, [DIRECTORY_ROOM, ROOM_A]);
  assert.deepEqual(payload.lessons[1]!.roomIds, [DIRECTORY_ROOM]);
  assert.deepEqual(payload.rooms.map((r) => r.id), [ROOM_A]);
});

test('buildingKeyGuess is null without a key or with a key longer than 80', () => {
  assert.equal(roomColumns(room(ROOM_A, { buildingName: '' })).buildingKeyGuess, null);
  assert.equal(roomColumns(room(ROOM_A, { buildingName: '---' })).buildingKeyGuess, null);
  assert.equal(roomColumns(room(ROOM_A, { buildingName: 'x'.repeat(81) })).buildingKeyGuess, null);
  assert.equal(roomColumns(room(ROOM_A, { buildingName: 'x'.repeat(80) })).buildingKeyGuess, 'x'.repeat(80));
});

test('duplicate lesson ids and items SQL could not store are skipped, not sent', () => {
  const dup = lesson();
  const parsed: ParsedCalendar = {
    rooms: [room(ROOM_A), room(ROOM_B, { name: '́' })],
    lessons: [
      dup,
      { ...dup },
      lesson({ title: '́̂' }),
      lesson({ title: 'X\uD800' }),
      lesson({ roomIds: [ROOM_B as PlannerId] }),
      lesson({ roomIds: [ROOM_B as PlannerId, ROOM_A as PlannerId] }),
    ],
    skipped: 0,
  };
  const payload = buildPayload(parsed, FROM, TO);
  assert.equal(payload.lessons.length, 2);
  assert.equal(payload.skipped, 4);
  assert.deepEqual(payload.lessons[1]!.roomIds, [ROOM_A]);
  assert.deepEqual(payload.rooms.map((r) => r.id), [ROOM_A]);
});

test('a maximum size lesson serializes and its texts respect the SQL limits', () => {
  const ids = Array.from({ length: 10 }, (_, i) => (i + 1).toString(16).padStart(24, 'a') as PlannerId);
  const rooms = ids.map((id, i) =>
    room(id, {
      name: `${'N'.repeat(99)}${i}`,
      code: 'C'.repeat(50),
      buildingName: 'B'.repeat(100),
      capacity: 5000,
      effectiveCapacity: 5000,
      services: Array.from({ length: 15 }, (_, j) => `${'S'.repeat(59)}${j % 10}`),
    }),
  );
  const big = lesson({
    title: 'T'.repeat(300),
    kind: 'K'.repeat(100),
    courses: Array.from({ length: 10 }, (_, i) => `${'C'.repeat(199)}${i}`),
    teachers: Array.from({ length: 10 }, (_, i) => `${'P'.repeat(60)} ${'Q'.repeat(59)}${i}`),
    year: 6,
    start: FROM,
    end: FROM + 12 * HOUR,
    roomIds: ids,
  });
  const payload = buildPayload({ rooms, lessons: [big], skipped: 0 }, FROM, TO);
  assert.equal(payload.lessons.length, 1);
  assert.equal(payload.rooms.length, 10);
  const back = JSON.parse(JSON.stringify(payload)) as typeof payload;
  const l = back.lessons[0]!;
  assert.deepEqual(l.teachers, []);
  assert.ok(l.titleText.length === 300);
  assert.ok(l.directText.length >= 1 && l.directText.length <= 2000);
  assert.ok(l.courseText.length >= 1 && l.courseText.length <= 5000);
  for (const r of back.rooms) {
    assert.ok(r.nameCompact.length <= 100 && !/\s/.test(r.nameCompact));
    assert.ok(r.searchText.length <= 400);
    assert.match(r.roomKey, /^[a-z0-9]{0,100}$/);
    assert.equal(r.buildingKeyGuess, null);
  }
});

test('too many skipped items: more than 10 and more than 20 percent of all items', () => {
  const of = (lessons: number, skipped: number) => tooManySkipped({ lessons: new Array(lessons).fill(null), skipped });
  assert.equal(of(0, 10), false, '10 skipped never fail a calendar');
  assert.equal(of(0, 11), true);
  assert.equal(of(44, 11), false, 'exactly 20 percent is still accepted');
  assert.equal(of(43, 11), true);
  assert.equal(of(400, 100), false);
  assert.equal(of(399, 101), true);
  assert.equal(of(1000, 0), false);
});

test('the pieces of a split long event count as one item for the skipped threshold', () => {
  const of = (lessons: number, skipped: number, pieces?: number) =>
    tooManySkipped({ lessons: new Array(lessons).fill(null), skipped }, pieces);
  assert.equal(of(56, 11), false, 'without the count, 45 pieces of one event hide 11 skipped items out of 23');
  assert.equal(of(56, 11, 44), true);
  assert.equal(of(100, 11, 44), false, '56 events and 11 skipped stay under 20 percent');
  assert.equal(of(5, 11, 99), true, 'never fewer than zero lessons');
});
