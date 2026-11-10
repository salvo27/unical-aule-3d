// First reader of the parsed page: checks the structure against config/dimes.json and copies only what the map
// needs. Fields of people never get here, they are dropped while parsing.
import { DimesError } from './codes.js';
import { REQUIRED_KEYS, type DimesConfig, type KeySet, type Semester } from './config.js';
import { appId, normKey, text } from './text.js';

export interface DClass {
  course: string | null;
  year: number;
}

export interface DUnit {
  title: string | null;
  classTitles: ReadonlyMap<string, string | null>;
  semester: Semester | null;
  classSemesters: ReadonlyMap<string, Semester>;
  classes: string[];
}

export interface DRoom {
  name: string | null;
  cube: string | null;
  capacity: number | null;
}

export interface DEntry {
  g: number;
  s: number;
  off: number;
  aula: string | null;
  ext: string | null;
}

export interface DReserve extends DEntry {
  cls: string;
  semester: Semester;
}

export interface Dataset {
  days: number;
  slots: number[];
  slotLength: number;
  semester: Semester;
  classes: Map<string, DClass>;
  units: Map<string, DUnit>;
  rooms: Map<string, DRoom>;
  fused: Map<string, string>;
  renamed: Map<string, string>;
  removed: Map<string, string>;
  // normKey of an external room name or alias to the name the app uses for it.
  externalNames: Map<string, string>;
  positions: Map<string, DEntry[]>;
  reserves: DReserve[];
}

export const LIMITS = {
  rooms: 300,
  classes: 500,
  units: 3_000,
  unitClasses: 200,
  states: 20,
  positionedUnits: 3_000,
  hours: 20_000,
  reserves: 2_000,
  renames: 3_000,
  externalRooms: 300,
  aliases: 20,
} as const;

const SLOT = /^(\d{2}):(\d{2})$/;
const CUBE = /^\d{1,2}[A-Z]{1,2}$/;
const COURSE_CODE = /^[A-Z0-9]{4}$/;
const DEGREE_PREFIX = /^(L|LM|LMCU)\s+/;

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function shape(): DimesError {
  return new DimesError('bad_shape');
}

function own(r: Rec, k: string): unknown {
  return Object.hasOwn(r, k) ? r[k] : undefined;
}

function record(v: unknown): Rec {
  if (!isRecord(v)) throw shape();
  return v;
}

// Every key must be known and every key the code reads must be there.
function known(v: unknown, cfg: DimesConfig, set: KeySet): Rec {
  const r = record(v);
  const allowed = cfg.keys[set];
  for (const k of Object.keys(r)) if (!allowed.has(k)) throw new DimesError('unknown_key');
  for (const k of REQUIRED_KEYS[set]) if (!Object.hasOwn(r, k)) throw shape();
  return r;
}

function list(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v)) throw shape();
  if (v.length > max) throw new DimesError('too_many');
  return v;
}

function entries(v: unknown, max: number): [string, unknown][] {
  const r = record(v);
  const out = Object.entries(r);
  if (out.length > max) throw new DimesError('too_many');
  return out;
}

function optionalEntries(v: unknown, max: number): [string, unknown][] {
  return v === undefined || v === null ? [] : entries(v, max);
}

function id(v: unknown): string {
  const out = appId(v);
  if (out === null) throw shape();
  return out;
}

function semester(v: unknown): Semester | null {
  if (v === undefined || v === null) return null;
  if (v === 'I' || v === 'II') return v;
  throw shape();
}

function idMap(v: unknown, max: number): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, value] of optionalEntries(v, max)) out.set(id(k), id(value));
  return out;
}

function slots(v: unknown): number[] {
  const raw = list(v, 16);
  if (raw.length < 1) throw shape();
  const out: number[] = [];
  for (const s of raw) {
    const m = typeof s === 'string' ? SLOT.exec(s) : null;
    const h = Number(m?.[1]);
    const min = Number(m?.[2]);
    if (!m || h > 23 || min > 59) throw shape();
    const at = h * 60 + min;
    if (out.length > 0 && at <= (out[out.length - 1] ?? 0)) throw shape();
    out.push(at);
  }
  return out;
}

function days(v: unknown, cfg: DimesConfig): number {
  const raw = list(v, 7);
  if (raw.length !== cfg.days.length) throw new DimesError('bad_days');
  raw.forEach((d, i) => {
    if (typeof d !== 'string' || d.length > 20 || d.normalize('NFC') !== cfg.days[i]) throw new DimesError('bad_days');
  });
  return raw.length;
}

function intOrNull(v: unknown, min: number, max: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null;
}

// Types are checked here (wrong type: bad_shape); ranges later, where a bad hour is skipped and counted.
function entry(r: Rec): DEntry {
  const g = own(r, 'g');
  const s = own(r, 's');
  const off = own(r, 'off') ?? 0;
  const aula = own(r, 'aula') ?? null;
  const ext = own(r, 'aulaEsterna') ?? null;
  if (typeof g !== 'number' || typeof s !== 'number' || typeof off !== 'number') throw shape();
  if (aula !== null && typeof aula !== 'string') throw shape();
  if (ext !== null && typeof ext !== 'string') throw shape();
  return { g, s, off, aula: aula === null ? null : id(aula), ext: ext === null ? null : ext.slice(0, 400) };
}

function readClass(v: unknown, cfg: DimesConfig): [string, DClass] {
  const r = known(v, cfg, 'class');
  const cds = own(r, 'cds');
  const name = own(r, 'cdsNome');
  const year = intOrNull(own(r, 'anno'), 1, 6);
  if (typeof cds !== 'string' || !COURSE_CODE.test(cds) || typeof name !== 'string' || year === null) throw shape();
  const full = text(name, 210);
  return [id(own(r, 'id')), { course: full ? text(full.replace(DEGREE_PREFIX, ''), 200) : null, year }];
}

function readUnit(v: unknown, cfg: DimesConfig): [string, DUnit] {
  const r = known(v, cfg, 'unit');
  const unitId = id(own(r, 'id'));
  const name = own(r, 'nome');
  if (typeof name !== 'string') throw shape();
  const classes = list(own(r, 'classi'), LIMITS.unitClasses).map(id);
  const classTitles = new Map<string, string | null>();
  for (const [c, t] of optionalEntries(own(r, 'nomiClasse'), LIMITS.unitClasses)) {
    if (typeof t !== 'string') throw shape();
    classTitles.set(id(c), text(t, 300));
  }
  const classSemesters = new Map<string, Semester>();
  for (const [c, s] of optionalEntries(own(r, 'semestriClasse'), LIMITS.unitClasses)) {
    const sem = semester(s);
    if (sem) classSemesters.set(id(c), sem);
  }
  return [unitId, { title: text(name, 300), classTitles, semester: semester(own(r, 'semestre')), classSemesters, classes }];
}

function readRoom(v: unknown, cfg: DimesConfig): [string, DRoom] {
  const r = known(v, cfg, 'room');
  const name = own(r, 'nome');
  const cube = own(r, 'cubo');
  if (typeof name !== 'string' || typeof cube !== 'string') throw shape();
  const upper = cube.trim().toUpperCase();
  return [id(own(r, 'id')), { name: text(name, 100), cube: CUBE.test(upper) ? upper : null, capacity: intOrNull(own(r, 'posti'), 1, 5000) }];
}

export function readDataset(raw: unknown, cfg: DimesConfig): Dataset {
  const top = known(raw, cfg, 'top');
  const meta = known(own(top, 'meta'), cfg, 'meta');

  const year = own(meta, 'annoAccademico');
  if (typeof year !== 'string' || year.length > 20) throw shape();
  if (year !== cfg.academicYear) throw new DimesError('wrong_year');
  const dayCount = days(own(meta, 'giorni'), cfg);
  const slotMinutes = slots(own(meta, 'slot'));
  const slotLength = intOrNull(own(meta, 'durataSlot'), 30, 240);
  if (slotLength === null) throw shape();
  const fused = idMap(own(meta, 'unitaFuse'), LIMITS.renames);
  const renamed = idMap(own(meta, 'auleRinominate'), LIMITS.renames);
  const removed = new Map<string, string>();
  for (const [k, value] of optionalEntries(own(meta, 'auleRimosse'), LIMITS.renames)) {
    if (typeof value !== 'string') throw shape();
    const t = text(value, 100);
    if (t) removed.set(id(k), t);
  }
  const externalNames = new Map<string, string>();
  const external = own(meta, 'auleEsterne');
  for (const e of external === undefined || external === null ? [] : list(external, LIMITS.externalRooms)) {
    const r = known(e, cfg, 'externalRoom');
    const name = own(r, 'nome');
    const alias = own(r, 'alias') ?? [];
    if (typeof name !== 'string') throw shape();
    const names = list(alias, LIMITS.aliases);
    if (names.some((a) => typeof a !== 'string')) throw shape();
    const canonical = text(name, 100);
    if (!canonical) continue;
    for (const n of [name, ...(names as string[])]) {
      const k = normKey(n.slice(0, 200));
      if (k) externalNames.set(k, canonical);
    }
  }

  // First state, the one the app shows read only.
  const states = entries(own(top, 'statiIniziali'), LIMITS.states);
  if (states.length === 0) throw new DimesError('no_state');
  const state = known(states[0]?.[1], cfg, 'state');
  const sem = own(state, 'semestre');
  if (sem !== 'I' && sem !== 'II') throw new DimesError('no_state');
  const custom = own(state, 'personalizzazioni');
  const pers = custom === undefined || custom === null ? {} : known(custom, cfg, 'customizations');

  const rooms = new Map<string, DRoom>();
  for (const v of list(own(top, 'aule'), LIMITS.rooms)) {
    const [k, room] = readRoom(v, cfg);
    if (rooms.has(k)) throw shape();
    rooms.set(k, room);
  }

  const classes = new Map<string, DClass>();
  for (const v of list(own(top, 'classi'), LIMITS.classes)) {
    const [k, c] = readClass(v, cfg);
    if (classes.has(k)) throw shape();
    classes.set(k, c);
  }
  for (const [k, v] of optionalEntries(own(pers, 'classiNuove'), LIMITS.classes)) {
    const [cid, c] = readClass(v, cfg);
    if (cid !== k) throw shape();
    if (!classes.has(cid)) classes.set(cid, c);
  }
  if (classes.size > LIMITS.classes) throw new DimesError('too_many');

  const added = new Map<string, string[]>();
  for (const [k, v] of optionalEntries(own(pers, 'aggiunte'), LIMITS.units)) added.set(id(k), list(v, LIMITS.unitClasses).map(id));
  const dropped = new Map<string, string[]>();
  for (const [k, v] of optionalEntries(own(pers, 'rimosse'), LIMITS.units)) dropped.set(id(k), list(v, LIMITS.unitClasses).map(id));

  const units = new Map<string, DUnit>();
  const rawUnits: [string | null, unknown][] = list(own(top, 'unita'), LIMITS.units).map((v) => [null, v]);
  for (const [k, v] of optionalEntries(own(pers, 'nuove'), LIMITS.units)) rawUnits.push([k, v]);
  if (rawUnits.length > LIMITS.units) throw new DimesError('too_many');
  for (const [key, v] of rawUnits) {
    const [unitId, unit] = readUnit(v, cfg);
    if (key !== null && key !== unitId) throw shape();
    if (units.has(unitId)) {
      if (key === null) throw shape();
      continue;
    }
    const less = new Set(dropped.get(unitId) ?? []);
    unit.classes = [...new Set([...unit.classes, ...(added.get(unitId) ?? [])])].filter((c) => classes.has(c) && !less.has(c));
    units.set(unitId, unit);
  }

  const positions = new Map<string, DEntry[]>();
  let hours = 0;
  const placed = entries(own(state, 'posizioni'), LIMITS.positionedUnits);
  if (placed.length === 0) throw new DimesError('no_state');
  for (const [k, v] of placed) {
    const items = list(v, LIMITS.hours);
    hours += items.length;
    if (hours > LIMITS.hours) throw new DimesError('too_many');
    positions.set(
      id(k),
      items.map((e) => entry(known(e, cfg, 'position'))),
    );
  }

  // A reserve without a semester belongs to the first one, as in the app.
  const reserves: DReserve[] = [];
  const reserved = own(state, 'riserve');
  for (const e of reserved === undefined || reserved === null ? [] : list(reserved, LIMITS.reserves)) {
    const r = known(e, cfg, 'reserve');
    reserves.push({ ...entry(r), cls: id(own(r, 'c')), semester: semester(own(r, 'sem')) ?? 'I' });
  }

  return {
    days: dayCount,
    slots: slotMinutes,
    slotLength,
    semester: sem,
    classes,
    units,
    rooms,
    fused,
    renamed,
    removed,
    externalNames,
    positions,
    reserves,
  };
}
