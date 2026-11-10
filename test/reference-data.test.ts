import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadCampus, type Campus } from '../src/campus.js';
import {
  configFromAdmin,
  configFromSeed,
  renderCampusBlock,
  renderConfigBlock,
  ReferenceDataError,
  type RoomSeed,
} from '../scripts/gen-reference-sql.js';

const ROOT = new URL('../../', import.meta.url);
const MIGRATIONS = fileURLToPath(new URL('supabase/migrations/', ROOT));

function campusBlockOf(text: string): string | null {
  const begin = text.indexOf('-- campus:begin\n');
  const end = text.indexOf('-- campus:end\n');
  if (begin < 0 || end < begin) return null;
  return text.slice(begin, end + '-- campus:end\n'.length);
}

const campus: Campus = {
  keys: new Set(['cubo-30b', 'cubo-4d', 'polifunzionale']),
  names: new Map([
    ['cubo-4d', 'Cubo 4D - DiBEST'],
    ['cubo-30b', "Cubo 30B - Dell'Ingegneria"],
    ['polifunzionale', 'Polifunzionale'],
  ]),
};
const seeds: RoomSeed[] = [
  { building: 'Cubo 4D', room: 'B6', floor: 1 },
  { building: 'Cubo 30B', room: 'Aula MT4', floor: 0 },
];

test('the newest campus block in the migrations equals the generator output', async () => {
  const names = readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort().reverse();
  let found: string | null = null;
  for (const name of names) {
    found = campusBlockOf(readFileSync(MIGRATIONS + name, 'utf8'));
    if (found !== null) break;
  }
  assert.ok(found, 'a migration with a campus block exists');
  const current = await loadCampus(fileURLToPath(new URL('public/data/campus.geojson', ROOT)));
  const seed = JSON.parse(readFileSync(fileURLToPath(new URL('config/seed.json', ROOT)), 'utf8')) as { roomSeeds: RoomSeed[] };
  assert.equal(found, renderCampusBlock(current, seed.roomSeeds));
});

test('campus block is sorted, escaped and deterministic', () => {
  const block = renderCampusBlock(campus, seeds);
  assert.equal(block, renderCampusBlock(campus, [...seeds].reverse()));
  assert.ok(block.startsWith('-- campus:begin\n') && block.endsWith('-- campus:end\n'));
  assert.ok(block.includes("('cubo-30b', 'Cubo 30B - Dell''Ingegneria')"));
  assert.ok(block.indexOf("'cubo-30b'") < block.indexOf("'cubo-4d'"));
  assert.ok(block.includes("('cubo-30b', 'mt4', 0)"));
  assert.ok(block.includes("('cubo-4d', 'b6', 1)"));
});

test('invalid seeds fail with the field name', () => {
  const fails = (s: RoomSeed[], field: string) =>
    assert.throws(() => renderCampusBlock(campus, s), (err: unknown) => err instanceof ReferenceDataError && err.field === field);
  fails([{ building: 'Cubo 99Z', room: 'A', floor: 0 }], 'room_seed_building');
  fails([{ building: 'Cubo 4D', room: '---', floor: 0 }], 'room_seed_room');
  fails([{ building: 'Cubo 4D', room: 'B6', floor: 99 }], 'room_seed_floor');
  fails([seeds[0]!, { building: 'Cubo 4D', room: 'Aula B6', floor: 2 }], 'room_seed_duplicate');
});

test('seed configuration keeps the order and the canonical values', () => {
  const config = configFromSeed(
    {
      calendars: [
        { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', label: "Corso dell'anno 1" },
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', label: '  Corso 2  ' },
      ],
      sources: ['https://www.unical.it/didattica/#orari', 'https://www.unical.it/didattica/'],
      buildingLinks: { 'Polo nuovo': 'cubo-4d' },
    },
    campus.keys,
  );
  assert.deepEqual(config.sources, ['https://www.unical.it/didattica/']);
  const block = renderConfigBlock(config);
  assert.ok(block.includes("('bbbbbbbbbbbbbbbbbbbbbbbb', 'planner', 'Corso dell''anno 1', true, timestamptz '2026-11-10 09:00:00+00' + 0 * interval '1 millisecond')"));
  assert.ok(block.includes("('aaaaaaaaaaaaaaaaaaaaaaaa', 'planner', 'Corso 2', true, timestamptz '2026-11-10 09:00:00+00' + 1 * interval '1 millisecond')"));
  assert.ok(block.includes("(1, 'https://www.unical.it/didattica/')"));
  assert.ok(block.includes("('Polo nuovo', 'cubo-4d')"));
  assert.ok(!block.includes('room_floors') && !block.includes('building_shapes'));
});

test('admin configuration brings floors, shapes and the original times', () => {
  const config = configFromAdmin(
    {
      version: 1,
      calendars: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', label: 'Corso', active: false, addedAt: 1794251741014 }],
      sources: [],
      rooms: { cccccccccccccccccccccccc: { floor: 3 } },
      buildings: { 'cubo-4d': { floors: 6, baseLevel: 1 } },
      buildingLinks: {},
    },
    campus.keys,
  );
  const block = renderConfigBlock(config);
  assert.ok(block.includes("('aaaaaaaaaaaaaaaaaaaaaaaa', 'planner', 'Corso', false, aule.from_ms(1794251741014))"));
  assert.ok(block.includes("('cccccccccccccccccccccccc', 3)"));
  assert.ok(block.includes("('cubo-4d', 6, 1)"));
  assert.ok(!block.includes('aule.sources'));
});

test('invalid configuration values fail with the field name', () => {
  const fails = (fn: () => unknown, field: string) =>
    assert.throws(fn, (err: unknown) => err instanceof ReferenceDataError && err.field === field);
  const seed = (extra: Record<string, unknown>) => ({ calendars: [], sources: [], ...extra });
  fails(() => configFromSeed(seed({ calendars: [{ id: 'https://example.com', label: 'x' }] }), campus.keys), 'calendar_id');
  fails(() => configFromSeed(seed({ calendars: [{ id: 'fff000000000000000000000', label: 'x' }] }), campus.keys), 'calendar_id');
  fails(
    () => configFromSeed(seed({ calendars: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', label: 'x' }, { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', label: 'y' }] }), campus.keys),
    'calendar_duplicate',
  );
  fails(() => configFromSeed(seed({ calendars: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', label: 'a\u0000b' }] }), campus.keys), 'calendar_label');
  fails(() => configFromSeed(seed({ sources: ['http://www.unical.it/'] }), campus.keys), 'source_url');
  fails(() => configFromSeed(seed({ sources: Array.from({ length: 61 }, (_, i) => `https://www.unical.it/${i}`) }), campus.keys), 'sources');
  fails(() => configFromSeed(seed({ buildingLinks: { 'Polo nuovo': 'cubo-99z' } }), campus.keys), 'building_link');
  fails(() => configFromSeed(seed({ buildingLinks: { ['x'.repeat(101)]: 'cubo-4d' } }), campus.keys), 'building_name');
  const admin = (extra: Record<string, unknown>) => ({ version: 1, calendars: [], sources: [], rooms: {}, buildings: {}, buildingLinks: {}, ...extra });
  fails(() => configFromAdmin({ ...admin({}), version: 2 }, campus.keys), 'admin_version');
  fails(() => configFromAdmin(admin({ rooms: { 'not-a-room': { floor: 1 } } }), campus.keys), 'room_id');
  fails(() => configFromAdmin(admin({ buildings: { 'cubo-99z': { floors: 3, baseLevel: 0 } } }), campus.keys), 'building_key');
  fails(() => configFromAdmin(admin({ buildings: { 'cubo-4d': { floors: 0, baseLevel: 0 } } }), campus.keys), 'floor_count');
  fails(
    () => configFromAdmin(admin({ calendars: [{ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', label: 'x', active: true, addedAt: 1.5 }] }), campus.keys),
    'calendar_added_at',
  );
});
