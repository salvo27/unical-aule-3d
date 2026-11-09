// Turns the untrusted Planner response into our own model, keeping only the fields we show.
import { plannerId, type PlannerId } from '../domain/primitives.js';
import type { Lesson, RoomInfo } from '../domain/model.js';

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
}

const MAX_EVENTS = 20_000;
const MAX_LESSON_MS = 12 * 60 * 60 * 1000;
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

export function parseLessons(raw: unknown): ParsedCalendar {
  if (!Array.isArray(raw)) throw new PlannerError('bad_shape');
  if (raw.length > MAX_EVENTS) throw new PlannerError('too_many');
  const lessons: Lesson[] = [];
  const rooms = new Map<string, RoomInfo>();
  let skipped = 0;
  for (const item of raw) {
    if (!isRecord(item)) {
      skipped += 1;
      continue;
    }
    const id = idOrNull(item.id);
    const start = time(item.dataInizio);
    const end = time(item.dataFine);
    const title = text(item.nome, 300);
    if (!id || start === null || end === null || end <= start || end - start > MAX_LESSON_MS || !title) {
      skipped += 1;
      continue;
    }
    const lessonRooms = list(item.risorse, 10, (r) => (isRecord(r) ? parseRoom(r.aula) : null));
    if (lessonRooms.length === 0) continue;
    for (const room of lessonRooms) rooms.set(room.id, room);
    lessons.push({
      id,
      title,
      start,
      end,
      status: typeof item.stato === 'string' && CANCELLED_STATES.has(item.stato) ? 'cancelled' : 'active',
      kind: isRecord(item.tipoEvento) ? (text(item.tipoEvento.descrizione, 100) ?? '') : '',
      courses: list(item.corsi, 10, (c) => (isRecord(c) ? text(c.descrizione, 200) : null)),
      year: intIn(item.annoCorso, 1, 6),
      teachers: list(item.docenti, 10, parseTeacher),
      roomIds: lessonRooms.map((r) => r.id),
    });
  }
  return { lessons, rooms: [...rooms.values()], skipped };
}
