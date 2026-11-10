// config/dimes.json: app URL, academic calendar, expected structure of the embedded data and the room table.
import { readFile, stat } from 'node:fs/promises';
import { buildingKey, roomNameKey } from '../../domain/building.js';
import { feedId, roomMatchKey } from '../../domain/ids.js';
import { isoDay, label, sourceUrl, type CalendarId, type IsoDay, type Label, type SourceUrl } from '../../domain/primitives.js';
import { classLevel, type DegreeLevel } from '../level.js';
import { normKey } from './text.js';

export class DimesConfigError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(field);
    this.name = 'DimesConfigError';
    this.field = field;
  }
}

export type Semester = 'I' | 'II';
export const SEMESTERS: readonly Semester[] = ['I', 'II'];

export interface DayRange {
  first: IsoDay;
  last: IsoDay;
}

export interface CanonicalRoom {
  name: string;
  building: string;
  matchKey: string;
}

export const KEY_SETS = [
  'top',
  'meta',
  'externalRoom',
  'class',
  'unit',
  'room',
  'state',
  'customizations',
  'position',
  'reserve',
] as const;
export type KeySet = (typeof KEY_SETS)[number];

// Keys the code reads: each must also be in the allowed list of the configuration. Allowed lists describe the data
// after parsing, when the personal fields are already gone.
export const REQUIRED_KEYS: Readonly<Record<KeySet, readonly string[]>> = {
  top: ['meta', 'classi', 'unita', 'aule', 'statiIniziali'],
  meta: ['annoAccademico', 'giorni', 'slot', 'durataSlot'],
  externalRoom: ['nome'],
  class: ['id', 'cds', 'anno', 'cdsNome'],
  unit: ['id', 'nome', 'classi'],
  room: ['id', 'nome', 'cubo'],
  state: ['semestre', 'posizioni'],
  customizations: [],
  position: ['g', 's'],
  reserve: ['c', 'g', 's'],
};

export interface DimesConfig {
  url: SourceUrl;
  feedId: CalendarId;
  label: Label;
  academicYear: string;
  semesters: Readonly<Record<Semester, DayRange>>;
  yearEnd: IsoDay;
  noLessonDays: ReadonlySet<IsoDay>;
  days: readonly string[];
  keys: Readonly<Record<KeySet, ReadonlySet<string>>>;
  // App room id and normalized external room text to the names the Planner uses.
  rooms: ReadonlyMap<string, CanonicalRoom>;
  externalRooms: ReadonlyMap<string, CanonicalRoom>;
  // Buildings not on the map yet, with the campus key of the building link the owner has to add.
  offMapBuildings: ReadonlyMap<string, string>;
  // Course code (cds of a class) to the level of its degree class; other codes show no level.
  levels: ReadonlyMap<string, DegreeLevel>;
}

const MAX_FILE_BYTES = 100_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CAMPUS_KEY = /^[a-z0-9-]{1,80}$/;
const ROOM_KEY = /^[a-z0-9]{1,100}$/;
const DATA_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const APP_ROOM = /^[A-Z0-9_]{1,60}$/;
const COURSE_CODE = /^[A-Z0-9]{4}$/;
const DAY_MS = 86_400_000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function check<T>(field: string, fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new DimesConfigError(field);
  }
}

function keysOnly(v: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new DimesConfigError(field);
}

// Size, then content, then syntax: a value that trim() would change is refused.
function plain(v: unknown, max: number, field: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || CONTROL.test(v) || v.trim() !== v) {
    throw new DimesConfigError(field);
  }
  return v;
}

function day(value: unknown, field: string): IsoDay {
  return check(field, () => isoDay(value));
}

function dayMs(d: IsoDay): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function range(value: unknown, field: string): DayRange {
  if (!isRecord(value)) throw new DimesConfigError(field);
  keysOnly(value, ['first', 'last'], field);
  const first = day(value.first, field);
  const last = day(value.last, field);
  const span = (dayMs(last) - dayMs(first)) / DAY_MS;
  if (span < 0 || span > 200) throw new DimesConfigError(field);
  return { first, last };
}

export function academicYear(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 9) throw new DimesConfigError('academic_year');
  const m = /^(\d{4})\/(\d{4})$/.exec(value);
  if (!m || Number(m[2]) !== Number(m[1]) + 1 || Number(m[1]) < 2020 || Number(m[1]) > 2098) throw new DimesConfigError('academic_year');
  return value;
}

function canonical(value: Record<string, unknown>, field: string): CanonicalRoom {
  const name = plain(value.name, 100, `${field}_name`);
  const building = plain(value.building, 100, `${field}_building`);
  const bKey = buildingKey(building);
  if (!bKey || !CAMPUS_KEY.test(bKey)) throw new DimesConfigError(`${field}_building`);
  if (!ROOM_KEY.test(roomNameKey(name))) throw new DimesConfigError(`${field}_name`);
  const matchKey = roomMatchKey(building, name);
  if (!matchKey) throw new DimesConfigError(`${field}_building`);
  return { name, building, matchKey };
}

function keySets(value: unknown): Record<KeySet, ReadonlySet<string>> {
  if (!isRecord(value)) throw new DimesConfigError('expected_keys');
  keysOnly(value, KEY_SETS, 'expected_keys');
  const out = {} as Record<KeySet, ReadonlySet<string>>;
  for (const set of KEY_SETS) {
    const list = value[set];
    if (!Array.isArray(list) || list.length > 60) throw new DimesConfigError('expected_keys');
    const keys = new Set<string>();
    for (const k of list) {
      if (typeof k !== 'string' || !DATA_KEY.test(k) || keys.has(k)) throw new DimesConfigError('expected_keys');
      keys.add(k);
    }
    if (REQUIRED_KEYS[set].some((k) => !keys.has(k))) throw new DimesConfigError('expected_keys');
    out[set] = keys;
  }
  return out;
}

export function parseDimesConfig(raw: unknown): DimesConfig {
  if (!isRecord(raw) || raw.version !== 1) throw new DimesConfigError('version');
  keysOnly(
    raw,
    [
      'version',
      'url',
      'label',
      'academicYear',
      'semesters',
      'yearEnd',
      'noLessonDays',
      'expected',
      'rooms',
      'externalRooms',
      'offMapBuildings',
      'degreeClasses',
    ],
    'config',
  );
  const url = check('url', () => sourceUrl(raw.url));
  // One page, no query, never a gAAAAAB link.
  if (url !== raw.url || url.includes('?') || url.includes('gAAAAAB')) throw new DimesConfigError('url');
  const name = check('label', () => label(plain(raw.label, 160, 'label')));
  const year = academicYear(raw.academicYear);

  if (!isRecord(raw.semesters)) throw new DimesConfigError('semesters');
  keysOnly(raw.semesters, SEMESTERS, 'semesters');
  const first = range(raw.semesters.I, 'semester_I');
  const second = range(raw.semesters.II, 'semester_II');
  if (dayMs(first.last) >= dayMs(second.first)) throw new DimesConfigError('semesters');
  const yearEnd = day(raw.yearEnd, 'year_end');
  if (dayMs(yearEnd) < dayMs(second.last) || dayMs(yearEnd) - dayMs(first.first) > 400 * DAY_MS) throw new DimesConfigError('year_end');

  if (!Array.isArray(raw.noLessonDays) || raw.noLessonDays.length > 100) throw new DimesConfigError('no_lesson_days');
  const noLessonDays = new Set(raw.noLessonDays.map((d) => day(d, 'no_lesson_days')));

  if (!isRecord(raw.expected)) throw new DimesConfigError('expected');
  keysOnly(raw.expected, ['days', 'keys'], 'expected');
  const days = raw.expected.days;
  if (!Array.isArray(days) || days.length < 5 || days.length > 6) throw new DimesConfigError('expected_days');
  const dayNames = days.map((d) => plain(d, 20, 'expected_days').normalize('NFC'));
  if (new Set(dayNames).size !== dayNames.length) throw new DimesConfigError('expected_days');
  const keys = keySets(raw.expected.keys);

  if (!Array.isArray(raw.rooms) || raw.rooms.length < 1 || raw.rooms.length > 300) throw new DimesConfigError('rooms');
  const rooms = new Map<string, CanonicalRoom>();
  for (const value of raw.rooms) {
    if (!isRecord(value)) throw new DimesConfigError('room');
    keysOnly(value, ['app', 'name', 'building'], 'room');
    const app = value.app;
    if (typeof app !== 'string' || !APP_ROOM.test(app)) throw new DimesConfigError('room_app');
    if (rooms.has(app)) throw new DimesConfigError('room_duplicate');
    rooms.set(app, canonical(value, 'room'));
  }

  if (!Array.isArray(raw.externalRooms) || raw.externalRooms.length > 100) throw new DimesConfigError('external_rooms');
  const externalRooms = new Map<string, CanonicalRoom>();
  for (const value of raw.externalRooms) {
    if (!isRecord(value)) throw new DimesConfigError('external_room');
    keysOnly(value, ['texts', 'name', 'building'], 'external_room');
    const room = canonical(value, 'external_room');
    const texts = value.texts;
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 10) throw new DimesConfigError('external_room_texts');
    for (const t of texts) {
      const key = normKey(plain(t, 100, 'external_room_texts'));
      if (key.length === 0 || externalRooms.has(key)) throw new DimesConfigError('external_room_texts');
      externalRooms.set(key, room);
    }
  }

  if (!isRecord(raw.offMapBuildings) || Object.keys(raw.offMapBuildings).length > 20) throw new DimesConfigError('off_map_buildings');
  const offMapBuildings = new Map<string, string>();
  for (const [building, key] of Object.entries(raw.offMapBuildings)) {
    plain(building, 100, 'off_map_buildings');
    if (typeof key !== 'string' || !CAMPUS_KEY.test(key)) throw new DimesConfigError('off_map_buildings');
    offMapBuildings.set(building, key);
  }

  if (!isRecord(raw.degreeClasses) || Object.keys(raw.degreeClasses).length > 60) throw new DimesConfigError('degree_classes');
  const levels = new Map<string, DegreeLevel>();
  for (const [code, cls] of Object.entries(raw.degreeClasses)) {
    const level = classLevel(cls);
    if (!COURSE_CODE.test(code) || level === null) throw new DimesConfigError('degree_classes');
    levels.set(code, level);
  }

  return {
    url,
    feedId: feedId('dimes', url),
    label: name,
    academicYear: year,
    semesters: { I: first, II: second },
    yearEnd,
    noLessonDays,
    days: dayNames,
    keys,
    rooms,
    externalRooms,
    offMapBuildings,
    levels,
  };
}

export const DIMES_CONFIG_PATH = new URL('../../../../config/dimes.json', import.meta.url);

export async function loadDimesConfig(path: string | URL = DIMES_CONFIG_PATH): Promise<DimesConfig> {
  let raw: unknown;
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('size');
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new DimesConfigError('file');
  }
  return parseDimesConfig(raw);
}
