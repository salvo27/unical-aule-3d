// Turns the untrusted Planner response into our own model, keeping only the fields we show.
import { plannerId, type PlannerId } from '../domain/primitives.js';
import type { Lesson, RoomInfo } from '../domain/model.js';
import { syntheticId } from '../domain/ids.js';
import { INCLUDE_TEACHERS } from '../sync/payload.js';

export type PlannerFailure =
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'too_large'
  | 'bad_json'
  | 'bad_shape'
  | 'too_many'
  | 'client_id';

export class PlannerError extends Error {
  readonly code: PlannerFailure;
  constructor(code: PlannerFailure) {
    super(code);
    this.name = 'PlannerError';
    this.code = code;
  }
}

export interface ParsedCalendar {
  lessons: Lesson[];
  rooms: RoomInfo[];
  skipped: number;
  // Lessons added by splitting long events or events with many rooms: one event stays one item for the threshold.
  pieces?: number;
}

const MAX_EVENTS = 20_000;
// Same cap as aule_sync.sync_put_calendar, which would refuse more.
const MAX_LESSONS = 20_000;
const MAX_LESSON_MS = 12 * 60 * 60 * 1000;
// Rooms of one stored lesson, as in the SQL check; an event with more becomes one lesson per 10 rooms.
const LESSON_ROOMS = 10;
const MAX_EVENT_ROOMS = 50;
const MAX_RESOURCES = 200;
// "Annullato" and "Sospeso": every other state keeps the room busy (fail closed).
const CANCELLED_STATES = new Set(['A', 'S']);
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length > max * 2) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  if (t.length === 0 || t.length > max || CONTROL.test(t)) return null;
  return t;
}

function intIn(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

function idOrNull(v: unknown): PlannerId | null {
  try {
    return plannerId(v);
  } catch {
    return null;
  }
}

function time(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

function list<T>(v: unknown, max: number, pick: (item: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const item of v.slice(0, max * 2)) {
    const value = pick(item);
    if (value !== null && !out.includes(value)) out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function parseRoom(aula: unknown): RoomInfo | null {
  if (!isRecord(aula)) return null;
  const id = idOrNull(aula.id);
  const name = text(aula.descrizione, 100);
  if (!id || !name) return null;
  const building = isRecord(aula.edificio) ? text(aula.edificio.descrizione, 100) : null;
  return {
    id,
    name,
    code: text(aula.codice, 50) ?? '',
    buildingName: building ?? '',
    capacity: intIn(aula.capienza, 1, 5000),
    effectiveCapacity: intIn(aula.capienzaEffettiva, 1, 5000),
    services: list(aula.serviziAula, 15, (s) => (isRecord(s) ? text(s.descrizione, 60) : null)),
  };
}

// Rooms and teachers share the resource list in any order, so the rooms are picked before any limit.
function eventRooms(v: unknown): { rooms: RoomInfo[]; cut: boolean } {
  if (!Array.isArray(v)) return { rooms: [], cut: false };
  const out = new Map<string, RoomInfo>();
  let cut = v.length > MAX_RESOURCES;
  for (const r of v.slice(0, MAX_RESOURCES)) {
    const room = isRecord(r) ? parseRoom(r.aula) : null;
    if (!room || out.has(room.id)) continue;
    if (out.size === MAX_EVENT_ROOMS) {
      cut = true;
      break;
    }
    out.set(room.id, room);
  }
  return { rooms: [...out.values()], cut };
}

function parseTeacher(d: unknown): string | null {
  if (!isRecord(d)) return null;
  const first = text(d.nome, 60);
  const last = text(d.cognome, 60);
  if (!last) return null;
  return titleCase(first ? `${first} ${last}` : last);
}

// Title of a public calendar, e.g. "DEMACS · LM Mathematics 2° anno - 1° Semestre 2026/2027".
export function parseCalendarTitle(raw: unknown): string | null {
  if (!isRecord(raw) || !isRecord(raw.payload)) return null;
  const title = text(raw.payload.titolo, 140);
  if (!title) return null;
  const code = isRecord(raw.payload.contesto) ? raw.payload.contesto.codice : null;
  return typeof code === 'string' && /^[A-Za-z]{2,12}$/.test(code) ? `${code} · ${title}` : title;
}

export interface ParseWindow {
  from: number;
  to: number;
}

// A longer event (multi day unavailability) keeps the room busy as pieces of at most 12 hours, numbered from
// its start so every piece keeps its id across runs. With a window only the pieces touching it are built.
export function splitLongEvent(lesson: Lesson, window: ParseWindow | null, max: number): Lesson[] {
  if (lesson.end - lesson.start <= MAX_LESSON_MS) return [lesson];
  if (window && (lesson.end <= window.from || lesson.start >= window.to)) return [];
  const stop = window ? Math.min(lesson.end, window.to) : lesson.end;
  const out: Lesson[] = [];
  let n = window && window.from > lesson.start ? Math.floor((window.from - lesson.start) / MAX_LESSON_MS) : 0;
  for (let start = lesson.start + n * MAX_LESSON_MS; start < stop && out.length < max; n++, start += MAX_LESSON_MS) {
    out.push({
      ...lesson,
      id: plannerId(syntheticId('fffe', `split|${lesson.id}|${n}`)),
      start,
      end: Math.min(lesson.end, start + MAX_LESSON_MS),
    });
  }
  return out;
}

export function parseLessons(raw: unknown, window: ParseWindow | null = null): ParsedCalendar {
  if (!Array.isArray(raw)) throw new PlannerError('bad_shape');
  if (raw.length > MAX_EVENTS) throw new PlannerError('too_many');
  const lessons: Lesson[] = [];
  const rooms = new Map<string, RoomInfo>();
  let skipped = 0;
  let pieces = 0;
  for (const item of raw) {
    if (!isRecord(item)) {
      skipped += 1;
      continue;
    }
    const id = idOrNull(item.id);
    const start = time(item.dataInizio);
    const end = time(item.dataFine);
    const title = text(item.nome, 300);
    if (!id || start === null || end === null || end <= start || !title) {
      skipped += 1;
      continue;
    }
    const { rooms: eventRoomList, cut } = eventRooms(item.risorse);
    if (cut) skipped += 1;
    if (eventRoomList.length === 0) continue;
    const event: Lesson = {
      id,
      title,
      start,
      end,
      status: typeof item.stato === 'string' && CANCELLED_STATES.has(item.stato) ? 'cancelled' : 'active',
      kind: isRecord(item.tipoEvento) ? (text(item.tipoEvento.descrizione, 100) ?? '') : '',
      courses: list(item.corsi, 10, (c) => (isRecord(c) ? text(c.descrizione, 200) : null)),
      year: intIn(item.annoCorso, 1, 6),
      teachers: INCLUDE_TEACHERS ? list(item.docenti, 10, parseTeacher) : [],
      roomIds: [],
    };
    // Sorted when split, so each part keeps its rooms and its id whatever order the Planner sends.
    const ordered = eventRoomList.length > LESSON_ROOMS ? [...eventRoomList].sort((a, b) => (a.id < b.id ? -1 : 1)) : eventRoomList;
    let added = 0;
    for (let k = 0; k * LESSON_ROOMS < ordered.length; k++) {
      const part = ordered.slice(k * LESSON_ROOMS, (k + 1) * LESSON_ROOMS);
      const lesson: Lesson = {
        ...event,
        id: k === 0 ? id : plannerId(syntheticId('fffe', `rooms|${id}|${k}`)),
        roomIds: part.map((r) => r.id),
      };
      const parts = splitLongEvent(lesson, window, MAX_LESSONS + 1 - lessons.length);
      if (parts.length === 0) continue;
      for (const room of part) rooms.set(room.id, room);
      lessons.push(...parts);
      added += parts.length;
      if (lessons.length > MAX_LESSONS) throw new PlannerError('too_many');
    }
    if (added > 1) pieces += added - 1;
  }
  return { lessons, rooms: [...rooms.values()], skipped, pieces };
}
