import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  emptyConfig,
  parseConfig,
  addCalendar,
  removeCalendar,
  setCalendarActive,
  setSources,
  setRoomFloor,
  setBuildingShape,
  linkBuilding,
  renameCalendar,
  DomainError,
  type AdminConfig,
} from '../src/domain/admin-config.js';
import { ConfigStore, ConfigError } from '../src/store/config-store.js';
import { CAL_1, CAL_2, ROOM_A } from './fixtures.js';

const KEYS = new Set(['cubo-4d', 'cubo-30b']);

function domainError(code: string) {
  return (e: unknown) => e instanceof DomainError && e.code === code;
}

test('add, toggle and remove a calendar', () => {
  let c = addCalendar(emptyConfig(), CAL_1, 'Scienze Politiche L-36', 1000);
  assert.equal(c.calendars.length, 1);
  assert.equal(c.calendars[0]!.active, true);
  c = setCalendarActive(c, CAL_1, false);
  assert.equal(c.calendars[0]!.active, false);
  c = removeCalendar(c, CAL_1);
  assert.equal(c.calendars.length, 0);
});

test('calendar mutations validate input and never change the original', () => {
  const base = emptyConfig();
  assert.throws(() => addCalendar(base, 'nope', 'x', 1), (e: unknown) => e instanceof Error);
  const one = addCalendar(base, CAL_1, 'A', 1);
  assert.throws(() => addCalendar(one, `https://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=${CAL_1}`, 'B', 2), domainError('calendar_exists'));
  assert.throws(() => removeCalendar(one, CAL_2), domainError('calendar_missing'));
  assert.equal(base.calendars.length, 0);
});

test('sources accept only unical pages, deduplicated and bounded', () => {
  const c = setSources(emptyConfig(), ['https://dispes.unical.it/a', 'https://dispes.unical.it/a#x']);
  assert.deepEqual(c.sources, ['https://dispes.unical.it/a']);
  assert.throws(() => setSources(emptyConfig(), ['https://example.com/']), (e: unknown) => e instanceof Error);
  assert.throws(() => setSources(emptyConfig(), new Array(61).fill(0).map((_, i) => `https://unical.it/${i}`)), domainError('too_many_sources'));
});

test('room floor can be set and cleared', () => {
  let c = setRoomFloor(emptyConfig(), ROOM_A, 2);
  assert.deepEqual(c.rooms[ROOM_A], { floor: 2 });
  c = setRoomFloor(c, ROOM_A, null);
  assert.equal(c.rooms[ROOM_A], undefined);
  assert.throws(() => setRoomFloor(emptyConfig(), ROOM_A, 99), (e: unknown) => e instanceof Error);
});

test('building shape and links only for known campus buildings', () => {
  const c = setBuildingShape(emptyConfig(), KEYS, 'cubo-4d', 6, 1);
  assert.deepEqual(c.buildings['cubo-4d'], { floors: 6, baseLevel: 1 });
  assert.throws(() => setBuildingShape(emptyConfig(), KEYS, 'cubo-99z', 6, 1), domainError('unknown_building'));
  const linked = linkBuilding(emptyConfig(), KEYS, 'Polo didattico', 'cubo-30b');
  assert.equal(linked.buildingLinks['Polo didattico'], 'cubo-30b');
  assert.throws(() => linkBuilding(emptyConfig(), KEYS, 'X', 'missing'), domainError('unknown_building'));
  assert.equal(linkBuilding(linked, KEYS, 'Polo didattico', null).buildingLinks['Polo didattico'], undefined);
});

test('parseConfig refuses anything not written by us', () => {
  const good: AdminConfig = addCalendar(emptyConfig(), CAL_1, 'A', 1);
  assert.deepEqual(parseConfig(JSON.parse(JSON.stringify(good))), good);
  assert.throws(() => parseConfig({ ...good, version: 2 }), ConfigError);
  assert.throws(() => parseConfig({ ...good, calendars: [{ id: 'bad', label: 'x', active: true, addedAt: 1 }] }), ConfigError);
  assert.throws(() => parseConfig({ ...good, rooms: { [ROOM_A]: { floor: 'two' } } }), ConfigError);
  assert.throws(() => parseConfig(null), ConfigError);
});

test('store seeds a missing file, persists updates atomically and refuses corrupt files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aule-config-'));
  const path = join(dir, 'admin.json');
  const seed = { calendars: [{ id: CAL_1, label: 'Seed' }], sources: ['https://dispes.unical.it/x'], roomSeeds: [] };
  const store = await ConfigStore.open(path, seed);
  assert.equal(store.current.calendars.length, 1);
  await store.update((c) => addCalendar(c, CAL_2, 'Second', 5));
  const onDisk = JSON.parse(await readFile(path, 'utf8')) as AdminConfig;
  assert.equal(onDisk.calendars.length, 2);

  await assert.rejects(store.update(() => { throw new DomainError('calendar_exists'); }), DomainError);
  assert.equal(store.current.calendars.length, 2);

  await writeFile(path, '{ not json');
  await assert.rejects(ConfigStore.open(path, seed), ConfigError);
});

test('concurrent updates are applied one after the other', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aule-config-'));
  const store = await ConfigStore.open(join(dir, 'admin.json'), { calendars: [], sources: [], roomSeeds: [] });
  await Promise.all([
    store.update((c) => addCalendar(c, CAL_1, 'One', 1)),
    store.update((c) => addCalendar(c, CAL_2, 'Two', 2)),
  ]);
  assert.equal(store.current.calendars.length, 2);
});

test('a calendar can be renamed, with the same label rules', () => {
  const c = renameCalendar(addCalendar(emptyConfig(), CAL_1, 'Old', 1), CAL_1, '  New name ');
  assert.equal(c.calendars[0]!.label, 'New name');
  assert.throws(() => renameCalendar(c, CAL_2, 'x'), domainError('calendar_missing'));
  assert.throws(() => renameCalendar(c, CAL_1, ''), (e: unknown) => e instanceof Error);
});
