import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLessons, parseCalendarTitle, PlannerError } from '../src/planner/parse.js';
import { syntheticId } from '../src/domain/ids.js';
import { fakeEvent, ROOM_A } from './fixtures.js';

const START = '2026-11-16T08:00:00.000Z';
const END = '2026-11-16T10:00:00.000Z';

test('a normal event becomes a lesson and a room', () => {
  const out = parseLessons([fakeEvent({ start: START, end: END, title: 'ANALISI MATEMATICA I' })]);
  assert.equal(out.lessons.length, 1);
  assert.equal(out.skipped, 0);
  const lesson = out.lessons[0]!;
  assert.equal(lesson.title, 'ANALISI MATEMATICA I');
  assert.equal(lesson.start, Date.parse(START));
  assert.equal(lesson.end, Date.parse(END));
  assert.equal(lesson.status, 'active');
  assert.deepEqual(lesson.teachers, [], 'teacher names are dropped while parsing');
  assert.deepEqual(lesson.courses, ['CORSO DI LAUREA DI PROVA']);
  assert.equal(lesson.year, 2);
  assert.deepEqual(lesson.roomIds, [ROOM_A]);
  const room = out.rooms[0]!;
  assert.equal(room.name, 'B6');
  assert.equal(room.buildingName, 'Cubo 4D');
  assert.equal(room.capacity, 40);
  assert.equal(room.effectiveCapacity, 22);
  assert.deepEqual(room.services, ['Rete', 'Proiettore']);
});

test('cancelled and suspended states free the room, unknown states do not', () => {
  const out = parseLessons([
    fakeEvent({ start: START, end: END, stato: 'A' }),
    fakeEvent({ start: START, end: END, stato: 'S' }),
    fakeEvent({ start: START, end: END, stato: 'Z' }),
  ]);
  assert.deepEqual(out.lessons.map((l) => l.status), ['cancelled', 'cancelled', 'active']);
});

test('events without a room are ignored, malformed ones are counted as skipped', () => {
  const out = parseLessons([
    fakeEvent({ start: START, end: END, room: null }),
    fakeEvent({ start: END, end: START }),
    fakeEvent({ start: 'not a date', end: END }),
    fakeEvent({ id: 'bad-id', start: START, end: END }),
    fakeEvent({ start: START, end: END, title: '' }),
    fakeEvent({ start: START, end: END, title: 'x'.repeat(301) }),
    'not an object',
    null,
  ]);
  assert.equal(out.lessons.length, 0);
  assert.equal(out.skipped, 7);
});

test('room fields out of range are dropped, not trusted', () => {
  const out = parseLessons([fakeEvent({ start: START, end: END, capacity: -3 })]);
  assert.equal(out.rooms[0]!.capacity, null);
});

test('a room with an invalid id drops only that room', () => {
  const event = fakeEvent({ start: START, end: END, room: 'zz' });
  const out = parseLessons([event]);
  assert.equal(out.lessons.length, 0);
});

test('the response must be an array of bounded size', () => {
  assert.throws(() => parseLessons({}), (e: unknown) => e instanceof PlannerError && e.code === 'bad_shape');
  assert.throws(() => parseLessons(null), (e: unknown) => e instanceof PlannerError && e.code === 'bad_shape');
  const many = new Array(20_001).fill(null);
  assert.throws(() => parseLessons(many), (e: unknown) => e instanceof PlannerError && e.code === 'too_many');
});

test('the same room in many events is returned once', () => {
  const out = parseLessons([
    fakeEvent({ start: START, end: END }),
    fakeEvent({ start: '2026-11-17T08:00:00.000Z', end: '2026-11-17T10:00:00.000Z' }),
  ]);
  assert.equal(out.lessons.length, 2);
  assert.equal(out.rooms.length, 1);
});

test('calendar title combines department code and title', () => {
  const raw = { id: 'x', payload: { titolo: 'LM Mathematics 2° anno - 1° Semestre 2026/2027', contesto: { codice: 'DEMACS' } } };
  assert.equal(parseCalendarTitle(raw), 'DEMACS · LM Mathematics 2° anno - 1° Semestre 2026/2027');
  assert.equal(parseCalendarTitle({ payload: { titolo: 'Solo titolo' } }), 'Solo titolo');
  assert.equal(parseCalendarTitle({ payload: { titolo: 'T', contesto: { codice: 'bad code!' } } }), 'T');
});

test('calendar title is null when missing, too long or with control characters', () => {
  assert.equal(parseCalendarTitle(null), null);
  assert.equal(parseCalendarTitle({}), null);
  assert.equal(parseCalendarTitle({ payload: { titolo: '' } }), null);
  assert.equal(parseCalendarTitle({ payload: { titolo: 'x'.repeat(200) } }), null);
  assert.equal(parseCalendarTitle({ payload: { titolo: 'a\u0007b' } }), null);
});

const HOUR = 3_600_000;
const LONG_ID = 'cccccccccccccccccccc0a01';
const piece = (n: number) => syntheticId('fffe', `split|${LONG_ID}|${n}`);

test('an event longer than 12 hours becomes consecutive pieces of at most 12 hours with stable ids', () => {
  const start = Date.parse('2026-11-16T06:00:00.000Z');
  const out = parseLessons([
    { ...fakeEvent({ id: LONG_ID, start: '2026-11-16T06:00:00.000Z', end: '2026-11-17T12:00:00.000Z', title: 'CHIUSURA' }), stato: 'A' },
  ]);
  assert.equal(out.skipped, 0);
  assert.equal(out.pieces, 2, 'pieces beyond the first are counted');
  assert.deepEqual(
    out.lessons.map((l) => [l.id, l.start - start, l.end - start]),
    [
      [piece(0), 0, 12 * HOUR],
      [piece(1), 12 * HOUR, 24 * HOUR],
      [piece(2), 24 * HOUR, 30 * HOUR],
    ],
  );
  assert.ok(out.lessons.every((l) => /^fffe[0-9a-f]{20}$/.test(l.id)));
  for (const l of out.lessons) {
    assert.equal(l.title, 'CHIUSURA');
    assert.equal(l.status, 'cancelled');
    assert.equal(l.kind, "ATTIVITA' DIDATTICA");
    assert.deepEqual(l.roomIds, [ROOM_A]);
    assert.deepEqual(l.teachers, []);
  }
  assert.equal(out.rooms.length, 1);
});

test('an event of exactly 12 hours keeps its Planner id', () => {
  const out = parseLessons([fakeEvent({ id: LONG_ID, start: '2026-11-16T06:00:00.000Z', end: '2026-11-16T18:00:00.000Z' })]);
  assert.deepEqual(out.lessons.map((l) => l.id), [LONG_ID]);
  assert.equal(out.pieces, 0);
});

test('with a window only the pieces touching it are built, numbered from the event start', () => {
  const event = fakeEvent({ id: LONG_ID, start: '2026-11-01T00:00:00.000Z', end: '2027-01-01T00:00:00.000Z' });
  const from = Date.parse('2026-11-08T23:00:00.000Z');
  const to = Date.parse('2026-11-30T23:00:00.000Z');
  const out = parseLessons([event], { from, to });
  const first = out.lessons[0]!;
  const last = out.lessons.at(-1)!;
  assert.equal(first.id, piece(15));
  assert.equal(first.start, Date.parse('2026-11-08T12:00:00.000Z'));
  assert.ok(first.start <= from && first.end > from);
  assert.ok(last.start < to && last.end >= to);
  assert.equal(out.lessons.length, 45);
  assert.equal(out.pieces, 44);
  for (let i = 1; i < out.lessons.length; i++) assert.equal(out.lessons[i]!.start, out.lessons[i - 1]!.end, 'no hole between pieces');
  const later = parseLessons([event], { from: from + 24 * HOUR, to });
  assert.equal(later.lessons[0]!.id, piece(17), 'the same piece keeps its id in another window');
  assert.deepEqual(later.lessons.map((l) => l.id), out.lessons.slice(2).map((l) => l.id));
});

test('a long event outside the window adds nothing, an endless one fails the calendar without a window', () => {
  const from = Date.parse('2026-11-08T23:00:00.000Z');
  const outside = parseLessons([fakeEvent({ start: '2026-10-01T00:00:00.000Z', end: '2026-11-08T23:00:00.000Z' })], { from, to: from + 24 * HOUR });
  assert.deepEqual(outside, { lessons: [], rooms: [], skipped: 0, pieces: 0 });
  const endless = fakeEvent({ start: '2000-01-01T00:00:00.000Z', end: '2099-01-01T00:00:00.000Z' });
  assert.throws(() => parseLessons([endless]), (e: unknown) => e instanceof PlannerError && e.code === 'too_many');
  assert.equal(parseLessons([endless], { from, to: from + 24 * HOUR }).lessons.length, 3);
});

test('rooms listed after many teachers are kept, an event with more than 10 rooms becomes one lesson per 10 rooms', () => {
  const base = fakeEvent({ id: LONG_ID, start: START, end: END });
  const room = (base.risorse as Record<string, unknown>[])[0]!;
  const aula = room.aula as Record<string, unknown>;
  const teachersFirst = { ...base, risorse: [...Array.from({ length: 30 }, (_v, i) => ({ docenteId: `d${i}` })), room] };
  const kept = parseLessons([teachersFirst]);
  assert.deepEqual([kept.lessons.length, kept.skipped, kept.lessons[0]?.roomIds], [1, 0, [ROOM_A]]);

  const ids = Array.from({ length: 23 }, (_v, i) => (0xa0 + i).toString(16).padStart(24, 'b'));
  const many = { ...base, risorse: [...ids, ids[0]].map((id, i) => ({ aula: { ...aula, id, descrizione: `Aula ${i}` } })) };
  const out = parseLessons([many]);
  assert.deepEqual(out.lessons.map((l) => l.roomIds.length), [10, 10, 3]);
  assert.deepEqual(out.lessons.flatMap((l) => l.roomIds), ids, 'every room once, in order');
  assert.deepEqual(out.lessons.map((l) => l.id), [LONG_ID, syntheticId('fffe', `rooms|${LONG_ID}|1`), syntheticId('fffe', `rooms|${LONG_ID}|2`)]);
  assert.deepEqual([out.rooms.length, out.pieces, out.skipped], [23, 2, 0]);
  assert.ok(out.lessons.every((l) => l.title === 'CORSO DI PROVA' && l.start === Date.parse(START) && l.end === Date.parse(END)));
  const reversed = parseLessons([{ ...many, risorse: [...(many.risorse as unknown[])].reverse() }]);
  assert.deepEqual(reversed.lessons.map((l) => [l.id, l.roomIds]), out.lessons.map((l) => [l.id, l.roomIds]), 'same parts in any order');

  const longMany = parseLessons([{ ...many, dataFine: '2026-11-17T08:00:00.000Z' }]);
  assert.equal(longMany.lessons.length, 6);
  assert.equal(new Set(longMany.lessons.map((l) => l.id)).size, 6);
  assert.equal(longMany.pieces, 5);

  const fifty = Array.from({ length: 51 }, (_v, i) => (0x100 + i).toString(16).padStart(24, 'c'));
  const cut = parseLessons([{ ...base, risorse: fifty.map((id) => ({ aula: { ...aula, id } })) }]);
  assert.deepEqual([cut.lessons.flatMap((l) => l.roomIds).length, cut.skipped], [50, 1], 'past 50 rooms the event also counts as skipped');
});
