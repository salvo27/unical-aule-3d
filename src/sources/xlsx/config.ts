// config/diam.json: page, academic calendar, expected sheets and the hand reviewed room table.
import { readFile, stat } from 'node:fs/promises';
import { buildingKey, roomNameKey } from '../../domain/building.js';
import { feedId, roomMatchKey, syntheticRoomId } from '../../domain/ids.js';
import { isoDay, label, sourceUrl, type CalendarId, type IsoDay, type Label, type PlannerId, type SourceUrl } from '../../domain/primitives.js';
import { classLevel, courseWithLevel, type DegreeLevel } from '../level.js';
import { FILE_KINDS, norm, roomAlias, sheetKey, sheetRole, type DiamFileKind } from './text.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type RoomAlias = Brand<string, 'RoomAlias'>;
export type AcademicYearLabel = Brand<string, 'AcademicYearLabel'>;
export type SlotMinutes = Brand<number, 'SlotMinutes'>;

export class DiamConfigError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(field);
    this.name = 'DiamConfigError';
    this.field = field;
  }
}

export interface DiamSheet {
  file: DiamFileKind;
  name: string;
  key: string;
  ref: string;
  id: CalendarId;
  year: number;
  // Course name of the sheet header, and the course stored on every lesson, with the degree level.
  course: string;
  lessonCourse: string;
  label: Label;
}

export interface DiamRoom {
  alias: RoomAlias;
  name: string;
  building: string;
  capacity: number | null;
  // Planner directory key and the synthetic id used when no Planner room matches.
  matchKey: string;
  syntheticId: PlannerId;
}

export interface Semester {
  first: IsoDay;
  last: IsoDay;
}

export interface DiamConfig {
  pageUrl: SourceUrl;
  academicYear: AcademicYearLabel;
  semesters: Readonly<Record<1 | 2, Semester>>;
  closedDays: ReadonlySet<IsoDay>;
  sheets: readonly DiamSheet[];
  rooms: ReadonlyMap<RoomAlias, DiamRoom>;
}

const MAX_FILE_BYTES = 100_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const CAMPUS_KEY = /^[a-z0-9-]{1,80}$/;
const ROOM_KEY = /^[a-z0-9]{1,100}$/;
const DAY_MS = 86_400_000;
const FILE_LEVEL: Readonly<Record<DiamFileKind, DegreeLevel>> = { LT: 'triennale', LM: 'magistrale' };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function check<T>(field: string, fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new DiamConfigError(field);
  }
}

// Size, then content, then syntax: a value that trim() would change is refused.
function plain(v: unknown, max: number, field: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || CONTROL.test(v) || v.trim() !== v) {
    throw new DiamConfigError(field);
  }
  return v;
}

function keysOnly(v: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new DiamConfigError(field);
}

export function roomAliasOf(value: unknown): RoomAlias {
  if (typeof value !== 'string' || value.length > 40 || !/^[A-Z0-9]{1,40}$/.test(value)) throw new DiamConfigError('room_alias');
  return value as RoomAlias;
}

export function academicYearLabel(value: unknown): AcademicYearLabel {
  if (typeof value !== 'string' || value.length !== 9) throw new DiamConfigError('academic_year');
  const m = /^(\d{4})-(\d{4})$/.exec(value);
  if (!m || Number(m[2]) !== Number(m[1]) + 1 || Number(m[1]) < 2020 || Number(m[1]) > 2098) throw new DiamConfigError('academic_year');
  return value as AcademicYearLabel;
}

// Start of a timetable row, 07:00 to 21:00.
export function slotMinutes(value: unknown): SlotMinutes {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 420 || value > 1260) throw new DiamConfigError('slot');
  return value as SlotMinutes;
}

function day(value: unknown, field: string): IsoDay {
  return check(field, () => isoDay(value));
}

function dayMs(d: IsoDay): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function semester(value: unknown, field: string): Semester {
  if (!isRecord(value)) throw new DiamConfigError(field);
  keysOnly(value, ['first', 'last'], field);
  const first = day(value.first, field);
  const last = day(value.last, field);
  const span = (dayMs(last) - dayMs(first)) / DAY_MS;
  if (span < 0 || span > 200) throw new DiamConfigError(field);
  return { first, last };
}

function sheetOf(value: unknown): DiamSheet {
  if (!isRecord(value)) throw new DiamConfigError('sheet');
  keysOnly(value, ['file', 'sheet', 'year', 'course', 'class', 'label'], 'sheet');
  const file = FILE_KINDS.find((k) => k === value.file);
  if (!file) throw new DiamConfigError('sheet_file');
  const name = plain(value.sheet, 60, 'sheet_name');
  const role = sheetRole(file, name);
  if (!role || role.kind !== 'grid' || sheetKey(name) !== norm(name)) throw new DiamConfigError('sheet_name');
  if (value.year !== role.year) throw new DiamConfigError('sheet_year');
  const course = plain(value.course, 200, 'sheet_course');
  if (norm(course) !== course) throw new DiamConfigError('sheet_course');
  // Degree class of the course list, of the level of its file.
  if (classLevel(value.class) !== FILE_LEVEL[file]) throw new DiamConfigError('sheet_class');
  const lessonCourse = courseWithLevel(course, FILE_LEVEL[file]);
  if (lessonCourse === null) throw new DiamConfigError('sheet_course');
  const ref = `${file}|${name}`;
  return {
    file,
    name,
    key: `${file}|${sheetKey(name)}`,
    ref,
    id: feedId('xlsx', ref),
    year: role.year,
    course,
    lessonCourse,
    label: check('sheet_label', () => label(plain(value.label, 160, 'sheet_label'))),
  };
}

function roomOf(value: unknown): DiamRoom {
  if (!isRecord(value)) throw new DiamConfigError('room');
  keysOnly(value, ['alias', 'name', 'building', 'capacity'], 'room');
  const alias = roomAliasOf(value.alias);
  const name = plain(value.name, 100, 'room_name');
  const building = plain(value.building, 100, 'room_building');
  const bKey = buildingKey(building);
  const rKey = roomNameKey(name);
  if (!bKey || !CAMPUS_KEY.test(bKey)) throw new DiamConfigError('room_building');
  if (!ROOM_KEY.test(rKey) || roomAlias(name) !== alias) throw new DiamConfigError('room_name');
  const capacity = value.capacity;
  if (capacity !== null && (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > 5000)) {
    throw new DiamConfigError('room_capacity');
  }
  const matchKey = roomMatchKey(building, name);
  if (!matchKey) throw new DiamConfigError('room_building');
  return { alias, name, building, capacity, matchKey, syntheticId: syntheticRoomId(bKey, rKey) };
}

export function parseDiamConfig(raw: unknown): DiamConfig {
  if (!isRecord(raw) || raw.version !== 1) throw new DiamConfigError('version');
  keysOnly(raw, ['version', 'pageUrl', 'academicYear', 'semesters', 'closedDays', 'sheets', 'rooms'], 'config');
  const pageUrl = check('page_url', () => sourceUrl(raw.pageUrl));
  // robots.txt of the unical.it hosts disallows *gAAAAAB*.
  if (pageUrl !== raw.pageUrl || pageUrl.includes('gAAAAAB')) throw new DiamConfigError('page_url');
  const academicYear = academicYearLabel(raw.academicYear);

  if (!isRecord(raw.semesters)) throw new DiamConfigError('semesters');
  keysOnly(raw.semesters, ['1', '2'], 'semesters');
  const first = semester(raw.semesters['1'], 'semester_1');
  const second = semester(raw.semesters['2'], 'semester_2');
  if (dayMs(first.last) >= dayMs(second.first)) throw new DiamConfigError('semesters');

  if (!Array.isArray(raw.closedDays) || raw.closedDays.length > 100) throw new DiamConfigError('closed_days');
  const closedDays = new Set(raw.closedDays.map((d) => day(d, 'closed_days')));

  if (!Array.isArray(raw.sheets) || raw.sheets.length < 1 || raw.sheets.length > 12) throw new DiamConfigError('sheets');
  const sheets = raw.sheets.map(sheetOf);
  if (new Set(sheets.map((s) => s.key)).size !== sheets.length) throw new DiamConfigError('sheet_duplicate');

  if (!Array.isArray(raw.rooms) || raw.rooms.length < 1 || raw.rooms.length > 60) throw new DiamConfigError('rooms');
  const rooms = new Map<RoomAlias, DiamRoom>();
  for (const room of raw.rooms.map(roomOf)) {
    if (rooms.has(room.alias)) throw new DiamConfigError('room_duplicate');
    rooms.set(room.alias, room);
  }
  return { pageUrl, academicYear, semesters: { 1: first, 2: second }, closedDays, sheets, rooms };
}

export const DIAM_CONFIG_PATH = new URL('../../../../config/diam.json', import.meta.url);

export async function loadDiamConfig(path: string | URL = DIAM_CONFIG_PATH): Promise<DiamConfig> {
  let raw: unknown;
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('size');
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new DiamConfigError('file');
  }
  return parseDiamConfig(raw);
}
