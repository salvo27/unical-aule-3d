// Requests from users about a room. The browser says what happened; the server decides the time window.
import { ValidationError } from './errors.js';
import { plannerId, type PlannerId } from './primitives.js';
import type { Lesson } from './model.js';
import { REQUEST_KINDS, ISSUE_CATEGORIES, type RequestKind, type IssueCategory } from './vocab.js';
import { romeDay, romeMidnight, addDays } from '../availability/time.js';

export interface RequestInput {
  roomId: PlannerId;
  kind: RequestKind;
  category: IssueCategory | null;
  lessonId: PlannerId | null;
}

const H = 3_600_000;
const ALLOWED_KEYS = new Set(['roomId', 'kind', 'category', 'lessonId']);

export function parseRequestInput(body: unknown): RequestInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new ValidationError('request');
  const b = body as Record<string, unknown>;
  if (Object.keys(b).some((k) => !ALLOWED_KEYS.has(k))) throw new ValidationError('request');
  const roomId = plannerId(b.roomId);
  if (typeof b.kind !== 'string' || !(REQUEST_KINDS as readonly string[]).includes(b.kind)) throw new ValidationError('kind');
  const kind = b.kind as RequestKind;
  let category: IssueCategory | null = null;
  if (kind === 'issue') {
    if (typeof b.category !== 'string' || !(ISSUE_CATEGORIES as readonly string[]).includes(b.category)) throw new ValidationError('category');
    category = b.category as IssueCategory;
  } else if (b.category !== undefined && b.category !== null) {
    throw new ValidationError('category');
  }
  let lessonId: PlannerId | null = null;
  if (kind === 'lesson_not_held') {
    if (b.lessonId === undefined || b.lessonId === null) throw new ValidationError('lesson');
    lessonId = plannerId(b.lessonId);
  } else if (b.lessonId !== undefined && b.lessonId !== null) {
    throw new ValidationError('lesson');
  }
  return { roomId, kind, category, lessonId };
}

export function requestWindow(input: RequestInput, now: number, lesson: Lesson | null): { start: number; end: number } {
  switch (input.kind) {
    case 'room_occupied':
      return { start: now, end: now + H };
    case 'room_closed':
      return { start: now, end: Math.min(now + 12 * H, romeMidnight(addDays(romeDay(now), 1))) };
    case 'issue':
      return { start: now, end: now + 7 * 24 * H };
    case 'lesson_not_held': {
      const valid =
        lesson !== null &&
        lesson.id === input.lessonId &&
        lesson.status === 'active' &&
        lesson.roomIds.includes(input.roomId) &&
        lesson.start <= now + 15 * 60_000 &&
        lesson.end >= now - 12 * H &&
        lesson.end - lesson.start <= 12 * H;
      if (!valid || !lesson) throw new ValidationError('lesson');
      return { start: lesson.start, end: lesson.end };
    }
  }
}
