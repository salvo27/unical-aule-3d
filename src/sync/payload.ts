// One calendar as sent to aule_sync.sync_put_calendar, with the columns SQL never recomputes.
import type { ParsedCalendar } from '../planner/parse.js';
import type { Lesson, RoomInfo } from '../domain/model.js';
import { buildingKey, roomNameKey } from '../domain/building.js';
import { normalizeText } from '../domain/text.js';
import { MAX_COURSE_CHARS } from '../sources/level.js';

export interface PayloadRoom {
  id: string;
  name: string;
  code: string;
  buildingName: string;
  capacity: number | null;
  effectiveCapacity: number | null;
  services: string[];
  buildingKeyGuess: string | null;
  roomKey: string;
  nameCompact: string;
  searchText: string;
}

export interface PayloadLesson {
  id: string;
  title: string;
  start: number;
  end: number;
  status: 'active' | 'cancelled';
  kind: string;
  courses: string[];
  year: number | null;
  teachers: string[];
  roomIds: string[];
  titleText: string;
  directText: string;
  courseText: string;
}

export interface CalendarPayload {
  from: number;
  to: number;
  skipped: number;
  rooms: PayloadRoom[];
  lessons: PayloadLesson[];
}

// While false, teacher names never reach the database: every payload sends [] and no search text holds them.
export const INCLUDE_TEACHERS: boolean = false;

const CAMPUS_KEY = /^[a-z0-9-]{1,80}$/;
const MAX_COURSES = 10;
const LONE_SURROGATE = /\p{Cs}/u;

export function roomColumns(room: RoomInfo): Pick<PayloadRoom, 'buildingKeyGuess' | 'roomKey' | 'nameCompact' | 'searchText'> {
  const guess = buildingKey(room.buildingName);
  return {
    buildingKeyGuess: guess !== null && CAMPUS_KEY.test(guess) ? guess : null,
    roomKey: roomNameKey(room.name),
    nameCompact: normalizeText(room.name).replace(/^aula /, '').replace(/\s+/g, ''),
    searchText: normalizeText(`${room.name} ${room.code} ${room.buildingName}`),
  };
}

const teachersOf = (lesson: Lesson): readonly string[] => (INCLUDE_TEACHERS ? lesson.teachers : []);

export function lessonColumns(lesson: Lesson): Pick<PayloadLesson, 'titleText' | 'directText' | 'courseText'> {
  const directText = normalizeText([lesson.title, ...teachersOf(lesson)].join(' '));
  return {
    titleText: normalizeText(lesson.title),
    directText,
    courseText: normalizeText(`${directText} ${lesson.courses.join(' ')}`),
  };
}

// Strings Postgres can store and computed texts within the limits of the SQL checks.
const wellFormed = (values: readonly string[]) => values.every((v) => !LONE_SURROGATE.test(v));
const within = (v: string, min: number, max: number) => [...v].length >= min && [...v].length <= max;

function payloadRoom(room: RoomInfo): PayloadRoom | null {
  const columns = roomColumns(room);
  if (!wellFormed([room.name, room.code, room.buildingName, ...room.services])) return null;
  if (!within(columns.nameCompact, 1, 100) || !within(columns.searchText, 1, 400) || columns.roomKey.length > 100) return null;
  return {
    id: room.id,
    name: room.name,
    code: room.code,
    buildingName: room.buildingName,
    capacity: room.capacity,
    effectiveCapacity: room.effectiveCapacity,
    services: [...room.services],
    ...columns,
  };
}

function payloadLesson(lesson: Lesson, roomIds: string[]): PayloadLesson | null {
  // A course outside the limits of the SQL check is dropped, never the lesson, so its rooms stay busy.
  const courses = lesson.courses.filter((c) => within(c, 1, MAX_COURSE_CHARS)).slice(0, MAX_COURSES);
  const columns = lessonColumns({ ...lesson, courses });
  if (!wellFormed([lesson.title, lesson.kind, ...courses, ...teachersOf(lesson)])) return null;
  if (!within(columns.titleText, 1, 300) || !within(columns.directText, 1, 2000) || !within(columns.courseText, 1, 5000)) return null;
  return {
    id: lesson.id,
    title: lesson.title,
    start: lesson.start,
    end: lesson.end,
    status: lesson.status,
    kind: lesson.kind,
    courses,
    year: lesson.year,
    teachers: [...teachersOf(lesson)],
    roomIds,
    ...columns,
  };
}

// Too many unreadable items would make the calendar look emptier than it is: above max(10, 20%) it fails closed.
// The parts of one split event count as one item, so they never water down the threshold.
export function tooManySkipped(payload: Pick<CalendarPayload, 'skipped' | 'lessons'>, pieces = 0): boolean {
  const items = Math.max(0, payload.lessons.length - pieces) + payload.skipped;
  return payload.skipped > 10 && payload.skipped * 5 > items;
}

// Invalid items are skipped and counted, so one bad entry never rejects the whole calendar.
export function buildPayload(parsed: ParsedCalendar, from: number, to: number): CalendarPayload {
  let skipped = parsed.skipped;
  const rooms = new Map<string, PayloadRoom>();
  const badRooms = new Set<string>();
  for (const room of parsed.rooms) {
    const row = payloadRoom(room);
    if (row) rooms.set(room.id, row);
    else badRooms.add(room.id);
  }
  const lessons: PayloadLesson[] = [];
  const seen = new Set<string>();
  for (const lesson of parsed.lessons) {
    if (lesson.end <= from || lesson.start >= to || seen.has(lesson.id)) {
      skipped += 1;
      continue;
    }
    const roomIds = lesson.roomIds.filter((id) => !badRooms.has(id));
    const row = roomIds.length > 0 ? payloadLesson(lesson, roomIds) : null;
    if (!row) {
      skipped += 1;
      continue;
    }
    seen.add(lesson.id);
    lessons.push(row);
  }
  const used = new Set(lessons.flatMap((l) => l.roomIds));
  return { from, to, skipped, rooms: [...rooms.values()].filter((r) => used.has(r.id)), lessons };
}
