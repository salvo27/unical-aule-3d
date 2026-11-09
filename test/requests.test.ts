import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRequestInput, requestWindow } from '../src/domain/requests.js';
import { ValidationError } from '../src/domain/errors.js';
import type { Lesson } from '../src/domain/model.js';
import type { PlannerId } from '../src/domain/primitives.js';

const ROOM = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const LESSON = 'dddddddddddddddddddddddd';
const H = 3_600_000;
const NOW = Date.parse('2026-11-16T10:30:00Z'); // 11:30 in Rome

function rejects(fn: () => unknown, code: string): void {
  assert.throws(fn, (e: unknown) => e instanceof ValidationError && e.code === code);
}

function lesson(overrides: Partial<Lesson> = {}): Lesson {
  return {
    id: LESSON as PlannerId,
    title: 'Analisi',
    start: NOW - H,
    end: NOW + H,
    status: 'active',
    kind: '',
    courses: [],
    year: null,
    teachers: [],
    roomIds: [ROOM as PlannerId],
    ...overrides,
  };
}

test('valid inputs per kind', () => {
  assert.deepEqual(parseRequestInput({ roomId: ROOM, kind: 'room_occupied' }), { roomId: ROOM, kind: 'room_occupied', category: null, lessonId: null });
  assert.deepEqual(parseRequestInput({ roomId: ROOM, kind: 'issue', category: 'proiettore' }), { roomId: ROOM, kind: 'issue', category: 'proiettore', lessonId: null });
  assert.equal(parseRequestInput({ roomId: ROOM, kind: 'lesson_not_held', lessonId: LESSON }).lessonId, LESSON);
});

test('invalid inputs are refused, not repaired', () => {
  rejects(() => parseRequestInput(null), 'request');
  rejects(() => parseRequestInput([]), 'request');
  rejects(() => parseRequestInput({ roomId: 'x', kind: 'room_occupied' }), 'planner_id');
  rejects(() => parseRequestInput({ roomId: ROOM, kind: 'teleport' }), 'kind');
  rejects(() => parseRequestInput({ roomId: ROOM, kind: 'issue' }), 'category');
  rejects(() => parseRequestInput({ roomId: ROOM, kind: 'issue', category: 'droni' }), 'category');
  rejects(() => parseRequestInput({ roomId: ROOM, kind: 'room_closed', category: 'bagni' }), 'category');
  rejects(() => parseRequestInput({ roomId: ROOM, kind: 'lesson_not_held' }), 'lesson');
  rejects(() => parseRequestInput({ roomId: ROOM, kind: 'room_occupied', lessonId: LESSON }), 'lesson');
  rejects(() => parseRequestInput({ roomId: ROOM, kind: 'room_occupied', extra: 1 }), 'request');
});

test('windows are decided by the server', () => {
  const occupied = requestWindow({ roomId: ROOM as PlannerId, kind: 'room_occupied', category: null, lessonId: null }, NOW, null);
  assert.deepEqual(occupied, { start: NOW, end: NOW + H });
  const issue = requestWindow({ roomId: ROOM as PlannerId, kind: 'issue', category: 'bagni', lessonId: null }, NOW, null);
  assert.equal(issue.end - issue.start, 7 * 24 * H);
  const closed = requestWindow({ roomId: ROOM as PlannerId, kind: 'room_closed', category: null, lessonId: null }, NOW, null);
  assert.equal(new Date(closed.end).toISOString(), '2026-11-16T22:30:00.000Z', 'closed for at most 12 hours');
  const late = Date.parse('2026-11-16T20:00:00Z'); // 21:00 in Rome
  const lateClosed = requestWindow({ roomId: ROOM as PlannerId, kind: 'room_closed', category: null, lessonId: null }, late, null);
  assert.equal(new Date(lateClosed.end).toISOString(), '2026-11-16T23:00:00.000Z', 'and not past midnight');
});

test('lesson not held uses the lesson times and checks the lesson', () => {
  const input = { roomId: ROOM as PlannerId, kind: 'lesson_not_held' as const, category: null, lessonId: LESSON as PlannerId };
  assert.deepEqual(requestWindow(input, NOW, lesson()), { start: NOW - H, end: NOW + H });
  rejects(() => requestWindow(input, NOW, null), 'lesson');
  rejects(() => requestWindow(input, NOW, lesson({ roomIds: ['bbbbbbbbbbbbbbbbbbbbbbbb' as PlannerId] })), 'lesson');
  rejects(() => requestWindow(input, NOW, lesson({ status: 'cancelled' })), 'lesson');
  rejects(() => requestWindow(input, NOW, lesson({ start: NOW + 2 * H, end: NOW + 3 * H })), 'lesson');
  rejects(() => requestWindow(input, NOW, lesson({ start: NOW - 20 * H, end: NOW - 18 * H })), 'lesson');
});
