import { test } from 'node:test';
import assert from 'node:assert/strict';
import { search } from '../src/availability/search.js';
import type { RoomStatus } from '../src/availability/availability.js';
import type { Lesson } from '../src/domain/model.js';
import { searchText, type PlannerId } from '../src/domain/primitives.js';

const H = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-16T10:30:00Z');
const NONE = { freeNow: false, minHours: null, minSeats: null };

function room(id: string, name: string, overrides: Partial<RoomStatus> = {}): RoomStatus {
  return {
    id,
    name,
    code: '',
    buildingName: 'Cubo 30B',
    buildingKey: 'cubo-30b',
    floor: 0,
    state: 'free',
    until: null,
    current: null,
    next: null,
    capacity: 50,
    effectiveCapacity: 30,
    services: [],
    report: null,
    issues: [],
    ...overrides,
  };
}

function lesson(id: string, title: string, roomId: string, startH: number, teachers: string[] = []): Lesson {
  return {
    id: id as PlannerId,
    title,
    start: NOW + startH * H,
    end: NOW + (startH + 2) * H,
    status: 'active',
    kind: '',
    courses: [],
    year: null,
    teachers,
    roomIds: [roomId as PlannerId],
  };
}

const ROOMS = [
  room('r1', 'MT1', { capacity: 110 }),
  room('r2', 'MT13', { state: 'busy', until: NOW + H }),
  room('r3', 'B6', { buildingName: 'Cubo 4D', buildingKey: 'cubo-4d', until: NOW + 0.5 * H, capacity: 40 }),
  room('r4', 'Aula Magna', { state: 'unknown', buildingKey: 'aula-magna', buildingName: 'Aula Magna' }),
];

test('room name search puts the exact match first and ignores the "aula" word', () => {
  const out = search(searchText('aula mt1'), NONE, ROOMS, [], NOW);
  assert.deepEqual(out.rooms.map((r) => r.id), ['r1', 'r2']);
});

test('a cube code finds all its rooms', () => {
  const out = search(searchText('30b'), NONE, ROOMS, [], NOW);
  assert.deepEqual(out.rooms.map((r) => r.id).sort(), ['r1', 'r2']);
});

test('course and teacher search return the next lesson per course and room', () => {
  const lessons = [
    lesson('l1', 'ANALISI MATEMATICA I', 'r1', 1, ['Anna Bianchi']),
    lesson('l2', 'ANALISI MATEMATICA I', 'r1', 25, ['Anna Bianchi']),
    lesson('l3', 'ANALISI MATEMATICA I', 'r3', -5, ['Anna Bianchi']),
    lesson('l4', 'FISICA', 'r2', 2, ['Carlo Verdi']),
  ];
  const byCourse = search(searchText('analisi'), NONE, ROOMS, lessons, NOW);
  assert.deepEqual(byCourse.lessons.map((l) => l.lessonId), ['l1']);
  assert.equal(byCourse.lessons[0]!.roomName, 'MT1');
  const byTeacher = search(searchText('verdi'), NONE, ROOMS, lessons, NOW);
  assert.deepEqual(byTeacher.lessons.map((l) => l.lessonId), ['l4']);
});

test('lessons matching the title come before those matching only the degree course', () => {
  const byCourse = { ...lesson('c1', 'SOCIOLOGIA', 'r1', 1), courses: ['SCIENZE POLITICHE'] };
  const byTitle = lesson('c2', 'TEORIE POLITICHE', 'r2', 5);
  const out = search(searchText('politiche'), NONE, ROOMS, [byCourse, byTitle], NOW);
  assert.deepEqual(out.lessons.map((l) => l.lessonId), ['c2', 'c1']);
  assert.equal('rank' in out.lessons[0]!, false);
});

test('filters: free now, free for at least N hours, minimum seats', () => {
  assert.deepEqual(search(null, { ...NONE, freeNow: true }, ROOMS, [], NOW).rooms.map((r) => r.id), ['r1', 'r3']);
  assert.deepEqual(search(null, { ...NONE, minHours: 1 }, ROOMS, [], NOW).rooms.map((r) => r.id), ['r1']);
  assert.deepEqual(search(null, { ...NONE, freeNow: true, minSeats: 100 }, ROOMS, [], NOW).rooms.map((r) => r.id), ['r1']);
});

test('unknown rooms never match the free filters', () => {
  const out = search(searchText('magna'), { ...NONE, freeNow: true }, ROOMS, [], NOW);
  assert.equal(out.rooms.length, 0);
});

test('no query and no filter returns nothing', () => {
  assert.deepEqual(search(null, NONE, ROOMS, [], NOW), { rooms: [], lessons: [] });
});

test('results are capped', () => {
  const many = Array.from({ length: 200 }, (_, i) => room(`m${i}`, `Aula ${i}`));
  assert.equal(search(null, { ...NONE, freeNow: true }, many, [], NOW).rooms.length, 50);
});

test('lessons confirmed as not held are not proposed', () => {
  const lessons = [lesson('l1', 'ANALISI', 'r1', 1), lesson('l2', 'ANALISI', 'r1', 25)];
  const l1 = lessons[0]!;
  const out = search(searchText('analisi'), NONE, ROOMS, lessons, NOW, new Set([`l1|r1|${l1.start}|${l1.end}`]));
  assert.deepEqual(out.lessons.map((l) => l.lessonId), ['l2']);
});
