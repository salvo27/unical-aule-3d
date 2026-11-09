import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLessons, parseCalendarTitle, PlannerError } from '../src/planner/parse.js';
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
  assert.deepEqual(lesson.teachers, ['Mario Rossi']);
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
    fakeEvent({ start: '2026-11-16T06:00:00.000Z', end: '2026-11-16T21:00:00.000Z' }),
    fakeEvent({ id: 'bad-id', start: START, end: END }),
    fakeEvent({ start: START, end: END, title: '' }),
    fakeEvent({ start: START, end: END, title: 'x'.repeat(301) }),
    'not an object',
    null,
  ]);
  assert.equal(out.lessons.length, 0);
  assert.equal(out.skipped, 8);
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
