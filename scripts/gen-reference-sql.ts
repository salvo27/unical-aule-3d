// Generates the reference data migration: campus buildings, room seeds and the first configuration.
// Usage: node dist/scripts/gen-reference-sql.js <out.sql> [--admin <admin.json>] [--campus-only]
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCampus, type Campus } from '../src/campus.js';
import { buildingKey, roomNameKey } from '../src/domain/building.js';
import {
  baseLevel,
  calendarId,
  floor,
  floorCount,
  label,
  plannerId,
  sourceUrl,
  type BaseLevel,
  type CalendarId,
  type Floor,
  type FloorCount,
  type Label,
  type PlannerId,
  type SourceUrl,
} from '../src/domain/primitives.js';

export interface RoomSeed {
  building: string;
  room: string;
  floor: number;
}

export interface ReferenceCalendar {
  id: CalendarId;
  label: Label;
  active: boolean;
  // Milliseconds from admin.json, or null for seed calendars (ordered by their position).
  addedAt: number | null;
}

export interface ReferenceConfig {
  calendars: ReferenceCalendar[];
  sources: SourceUrl[];
  links: { name: string; key: string }[];
  floors: { roomId: PlannerId; floor: Floor }[];
  shapes: { key: string; floors: FloorCount; baseLevel: BaseLevel }[];
}

export class ReferenceDataError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(field);
    this.name = 'ReferenceDataError';
    this.field = field;
  }
}

export const LIMITS = { calendars: 600, sources: 60, rooms: 3000, buildings: 300, links: 300 } as const;
const MAX_FILE_BYTES = 2_000_000;
const CAMPUS_KEY = /^[a-z0-9-]{1,80}$/;
const ROOM_KEY = /^[a-z0-9]{1,100}$/;
const SEED_EPOCH = "timestamptz '2026-11-10 09:00:00+00'";

function check<T>(field: string, fn: () => T): T {
  let value: T;
  try {
    value = fn();
  } catch {
    throw new ReferenceDataError(field);
  }
  return value;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Same rule as aule.plain(v, 1, max): the canonical label, at most max characters.
function name(value: unknown, max: number, field: string): string {
  const out = check(field, () => label(value));
  if (out.length > max) throw new ReferenceDataError(field);
  return out;
}

function campusKey(value: unknown, keys: ReadonlySet<string>, field: string): string {
  if (typeof value !== 'string' || !CAMPUS_KEY.test(value) || !keys.has(value)) throw new ReferenceDataError(field);
  return value;
}

function sql(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function codeOrder(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rows(lines: string[]): string {
  return lines.map((l, i) => `  ${l}${i < lines.length - 1 ? ',' : ''}`).join('\n');
}

export function renderCampusBlock(campus: Campus, seeds: RoomSeed[]): string {
  const keys = [...campus.names.keys()].sort(codeOrder);
  if (keys.length === 0) throw new ReferenceDataError('campus');
  const buildings = keys.map((key) => {
    if (!CAMPUS_KEY.test(key)) throw new ReferenceDataError('campus_key');
    return `(${sql(key)}, ${sql(name(campus.names.get(key), 100, 'campus_name'))})`;
  });

  const seen = new Set<string>();
  const seedRows = seeds.map((s) => {
    if (!isRecord(s)) throw new ReferenceDataError('room_seed');
    const key = campusKey(check('room_seed_building', () => buildingKey(s.building)), campus.keys, 'room_seed_building');
    const room = check('room_seed_room', () => roomNameKey(s.room));
    if (!ROOM_KEY.test(room)) throw new ReferenceDataError('room_seed_room');
    const level = check('room_seed_floor', () => floor(s.floor));
    if (seen.has(`${key}|${room}`)) throw new ReferenceDataError('room_seed_duplicate');
    seen.add(`${key}|${room}`);
    return { key, room, level };
  });
  seedRows.sort((a, b) => codeOrder(a.key, b.key) || codeOrder(a.room, b.room));

  const out = [
    '-- campus:begin',
    'insert into aule.campus_buildings (key, name) values',
    rows(buildings),
    'on conflict (key) do update set name = excluded.name;',
    'delete from aule.campus_buildings where key not in (',
    rows(keys.map(sql)),
    ');',
  ];
  if (seedRows.length > 0) {
    out.push(
      'insert into aule.room_seeds (building_key, room_key, floor) values',
      rows(seedRows.map((s) => `(${sql(s.key)}, ${sql(s.room)}, ${s.level})`)),
      'on conflict (building_key, room_key) do update set floor = excluded.floor;',
      'delete from aule.room_seeds where (building_key, room_key) not in (',
      rows(seedRows.map((s) => `(${sql(s.key)}, ${sql(s.room)})`)),
      ');',
    );
  } else {
    out.push('delete from aule.room_seeds;');
  }
  out.push('-- campus:end', '');
  return out.join('\n');
}

export function renderConfigBlock(config: ReferenceConfig): string {
  const out: string[] = [];
  if (config.calendars.length > 0) {
    const values = config.calendars.map((c, i) => {
      const addedAt = c.addedAt === null ? `${SEED_EPOCH} + ${i} * interval '1 millisecond'` : `aule.from_ms(${c.addedAt})`;
      return `(${sql(c.id)}, 'planner', ${sql(c.label)}, ${c.active}, ${addedAt})`;
    });
    out.push('insert into aule.calendars (id, source, label, active, added_at) values', rows(values), 'on conflict do nothing;');
  }
  if (config.sources.length > 0) {
    out.push(
      'insert into aule.sources (position, url) values',
      rows(config.sources.map((url, i) => `(${i + 1}, ${sql(url)})`)),
      'on conflict do nothing;',
    );
  }
  if (config.links.length > 0) {
    out.push(
      'insert into aule.building_links (planner_name, campus_key) values',
      rows(config.links.map((l) => `(${sql(l.name)}, ${sql(l.key)})`)),
      'on conflict do nothing;',
    );
  }
  if (config.floors.length > 0) {
    out.push(
      'insert into aule.room_floors (room_id, floor) values',
      rows(config.floors.map((f) => `(${sql(f.roomId)}, ${f.floor})`)),
      'on conflict do nothing;',
    );
  }
  if (config.shapes.length > 0) {
    out.push(
      'insert into aule.building_shapes (key, floors, base_level) values',
      rows(config.shapes.map((s) => `(${sql(s.key)}, ${s.floors}, ${s.baseLevel})`)),
      'on conflict do nothing;',
    );
  }
  return out.length > 0 ? `${out.join('\n')}\n` : '';
}

function calendars(value: unknown, fromAdmin: boolean): ReferenceCalendar[] {
  if (!Array.isArray(value) || value.length > LIMITS.calendars) throw new ReferenceDataError('calendars');
  const seen = new Set<string>();
  return value.map((c): ReferenceCalendar => {
    if (!isRecord(c)) throw new ReferenceDataError('calendar');
    const id = check('calendar_id', () => calendarId(c.id));
    if (id.startsWith('fff')) throw new ReferenceDataError('calendar_id');
    if (seen.has(id)) throw new ReferenceDataError('calendar_duplicate');
    seen.add(id);
    const entryLabel = check('calendar_label', () => label(c.label));
    if (!fromAdmin) return { id, label: entryLabel, active: true, addedAt: null };
    if (typeof c.active !== 'boolean') throw new ReferenceDataError('calendar_active');
    if (typeof c.addedAt !== 'number' || !Number.isSafeInteger(c.addedAt) || c.addedAt < 0) {
      throw new ReferenceDataError('calendar_added_at');
    }
    return { id, label: entryLabel, active: c.active, addedAt: c.addedAt };
  });
}

function sources(value: unknown): SourceUrl[] {
  if (!Array.isArray(value) || value.length > LIMITS.sources) throw new ReferenceDataError('sources');
  return [...new Set(value.map((s) => check('source_url', () => sourceUrl(s))))];
}

function links(value: unknown, keys: ReadonlySet<string>): ReferenceConfig['links'] {
  if (value === undefined) return [];
  if (!isRecord(value) || Object.keys(value).length > LIMITS.links) throw new ReferenceDataError('building_links');
  return Object.entries(value)
    .map(([plannerName, key]) => ({ name: name(plannerName, 100, 'building_name'), key: campusKey(key, keys, 'building_link') }))
    .sort((a, b) => codeOrder(a.name, b.name));
}

export function configFromSeed(seed: unknown, keys: ReadonlySet<string>): ReferenceConfig {
  if (!isRecord(seed)) throw new ReferenceDataError('seed');
  return {
    calendars: calendars(seed.calendars, false),
    sources: sources(seed.sources),
    links: links(seed.buildingLinks, keys),
    floors: [],
    shapes: [],
  };
}

export function configFromAdmin(admin: unknown, keys: ReadonlySet<string>): ReferenceConfig {
  if (!isRecord(admin) || admin.version !== 1) throw new ReferenceDataError('admin_version');
  const { rooms, buildings } = admin;
  if (!isRecord(rooms) || Object.keys(rooms).length > LIMITS.rooms) throw new ReferenceDataError('rooms');
  if (!isRecord(buildings) || Object.keys(buildings).length > LIMITS.buildings) throw new ReferenceDataError('buildings');
  const floors = Object.entries(rooms)
    .map(([id, r]) => {
      if (!isRecord(r)) throw new ReferenceDataError('room');
      return { roomId: check('room_id', () => plannerId(id)), floor: check('room_floor', () => floor(r.floor)) };
    })
    .sort((a, b) => codeOrder(a.roomId, b.roomId));
  const shapes = Object.entries(buildings)
    .map(([key, b]) => {
      if (!isRecord(b)) throw new ReferenceDataError('building');
      return {
        key: campusKey(key, keys, 'building_key'),
        floors: check('floor_count', () => floorCount(b.floors)),
        baseLevel: check('base_level', () => baseLevel(b.baseLevel)),
      };
    })
    .sort((a, b) => codeOrder(a.key, b.key));
  return {
    calendars: calendars(admin.calendars, true),
    sources: sources(admin.sources),
    links: links(admin.buildingLinks, keys),
    floors,
    shapes,
  };
}

export function renderMigration(campusBlock: string, configBlock: string | null): string {
  const header = [
    '-- Generated by scripts/gen-reference-sql.ts. Do not edit: write a new migration with the generator instead.',
    '-- Campus buildings and room seeds are reference data; the configuration rows are only the first configuration.',
    '',
  ].join('\n');
  return `${header}${campusBlock}${configBlock ?? ''}`;
}

async function readJson(path: string, field: string): Promise<unknown> {
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('size');
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new ReferenceDataError(field);
  }
}

interface Args {
  out: string;
  admin: string | null;
  campusOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { out: '', admin: null, campusOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--campus-only') args.campusOnly = true;
    else if (a === '--admin' && args.admin === null && argv[i + 1] !== undefined) args.admin = argv[++i] ?? null;
    else if (a !== undefined && !a.startsWith('--') && args.out === '') args.out = a;
    else throw new ReferenceDataError('usage');
  }
  if (args.out.length < 5 || args.out.length > 500 || !args.out.endsWith('.sql')) throw new ReferenceDataError('usage');
  if (args.admin !== null && args.campusOnly) throw new ReferenceDataError('usage');
  return args;
}

const ROOT = new URL('../../', import.meta.url);

async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  const campus = await loadCampus(fileURLToPath(new URL('public/data/campus.geojson', ROOT))).catch(() => {
    throw new ReferenceDataError('campus');
  });
  const seed = await readJson(fileURLToPath(new URL('config/seed.json', ROOT)), 'seed_file');
  if (!isRecord(seed) || !Array.isArray(seed.roomSeeds)) throw new ReferenceDataError('room_seeds');
  const campusBlock = renderCampusBlock(campus, seed.roomSeeds as RoomSeed[]);
  let configBlock: string | null = null;
  if (!args.campusOnly) {
    const config = args.admin === null
      ? configFromSeed(seed, campus.keys)
      : configFromAdmin(await readJson(args.admin, 'admin_file'), campus.keys);
    configBlock = renderConfigBlock(config);
  }
  const tmp = `${args.out}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, renderMigration(campusBlock, configBlock), { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, args.out);
  } catch {
    await rm(tmp, { force: true });
    throw new ReferenceDataError('out_file');
  }
  console.log(`reference data written: ${campus.keys.size} buildings, ${seed.roomSeeds.length} room seeds`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof ReferenceDataError ? err.field : 'unexpected'}\n`);
    process.exitCode = 1;
  });
}
