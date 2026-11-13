import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  calendarId,
  calendarReference,
  plannerId,
  floor,
  floorCount,
  baseLevel,
  isoDay,
  searchText,
  sourceUrl,
  label,
  minSeats,
  minFreeHours,
  dayCount,
  courseKey,
  courseKeys,
} from '../src/domain/primitives.js';
import { ValidationError } from '../src/domain/errors.js';

const ID = '6878c95c4c1e05001fd31126';
const KEY_A = '0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const KEY_B = 'ffffffffffffffffffffffffffffffff';

function rejects(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => err instanceof ValidationError && err.code === code);
}

test('calendarId accepts 24 lowercase hex chars', () => {
  assert.equal(calendarId(ID), ID);
});

test('calendarId rejects wrong type, size, characters', () => {
  rejects(() => calendarId(42), 'calendar_id');
  rejects(() => calendarId(''), 'calendar_id');
  rejects(() => calendarId(ID + '0'), 'calendar_id');
  rejects(() => calendarId(ID.slice(1)), 'calendar_id');
  rejects(() => calendarId(ID.toUpperCase()), 'calendar_id');
  rejects(() => calendarId('6878c95c4c1e05001fd3112g'), 'calendar_id');
  rejects(() => calendarId('x'.repeat(10_000)), 'calendar_id');
});

test('calendarReference extracts the id from a Planner link or a bare id', () => {
  assert.equal(calendarReference(ID), ID);
  assert.equal(calendarReference(`https://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=${ID}`), ID);
  assert.equal(calendarReference(`https://unical.prod.up.cineca.it:443/calendarioPubblico/linkCalendarioId=${ID}`), ID);
  assert.equal(calendarReference(`  https://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=${ID}/  `), ID);
});

test('calendarReference rejects other hosts, schemes and paths', () => {
  rejects(() => calendarReference(`https://evil.example/calendarioPubblico/linkCalendarioId=${ID}`), 'calendar_ref');
  rejects(() => calendarReference(`http://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=${ID}`), 'calendar_ref');
  rejects(() => calendarReference(`https://unical.prod.up.cineca.it/other/linkCalendarioId=${ID}`), 'calendar_ref');
  rejects(() => calendarReference(`https://user:pw@unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=${ID}`), 'calendar_ref');
  rejects(() => calendarReference('a'.repeat(501)), 'calendar_ref');
  rejects(() => calendarReference(null), 'calendar_ref');
});

test('plannerId has its own error code', () => {
  assert.equal(plannerId(ID), ID);
  rejects(() => plannerId('nope'), 'planner_id');
});

test('floor accepts integers in range, rejects the rest', () => {
  assert.equal(floor(0), 0);
  assert.equal(floor(-2), -2);
  assert.equal(floor(12), 12);
  rejects(() => floor(-3), 'floor');
  rejects(() => floor(13), 'floor');
  rejects(() => floor(1.5), 'floor');
  rejects(() => floor('1'), 'floor');
  rejects(() => floor(Number.NaN), 'floor');
  rejects(() => floor(Number.POSITIVE_INFINITY), 'floor');
});

test('floorCount and baseLevel bounds', () => {
  assert.equal(floorCount(1), 1);
  assert.equal(floorCount(15), 15);
  rejects(() => floorCount(0), 'floor_count');
  rejects(() => floorCount(16), 'floor_count');
  assert.equal(baseLevel(0), 0);
  assert.equal(baseLevel(12), 12);
  rejects(() => baseLevel(-1), 'base_level');
  rejects(() => baseLevel(13), 'base_level');
});

test('isoDay accepts real dates only', () => {
  assert.equal(isoDay('2026-11-09'), '2026-11-09');
  assert.equal(isoDay('2028-02-29'), '2028-02-29');
  rejects(() => isoDay('2026-02-29'), 'day');
  rejects(() => isoDay('2026-13-01'), 'day');
  rejects(() => isoDay('2026-1-01'), 'day');
  rejects(() => isoDay('2019-12-31'), 'day');
  rejects(() => isoDay('2026-11-09T00:00'), 'day');
  rejects(() => isoDay(20261109), 'day');
});

test('searchText normalizes case, accents and spaces', () => {
  assert.equal(searchText('  Aula   MT1 '), 'aula mt1');
  assert.equal(searchText('Università'), 'universita');
  assert.equal(searchText('Cubo 30B'), 'cubo 30b');
});

test('searchText rejects empty, too long and control characters', () => {
  rejects(() => searchText('   '), 'search');
  rejects(() => searchText('a'.repeat(81)), 'search');
  rejects(() => searchText('ab\u0000c'), 'search');
  rejects(() => searchText('ab\nc'), 'search');
  rejects(() => searchText(['a']), 'search');
  assert.equal(searchText('a'.repeat(60)), 'a'.repeat(60));
});

test('sourceUrl allows only https pages on unical.it', () => {
  assert.equal(sourceUrl('https://dispes.unical.it/didattica/x'), 'https://dispes.unical.it/didattica/x');
  assert.equal(sourceUrl('https://unical.it/a#frag'), 'https://unical.it/a');
  rejects(() => sourceUrl('http://dispes.unical.it/'), 'source_url');
  rejects(() => sourceUrl('https://unical.it.evil.com/'), 'source_url');
  rejects(() => sourceUrl('https://evilunical.it/'), 'source_url');
  rejects(() => sourceUrl('https://dispes.unical.it:8443/'), 'source_url');
  rejects(() => sourceUrl('https://a:b@dispes.unical.it/'), 'source_url');
  rejects(() => sourceUrl('https://127.0.0.1/'), 'source_url');
  rejects(() => sourceUrl('file:///etc/passwd'), 'source_url');
  rejects(() => sourceUrl('https://x.unical.it/' + 'a'.repeat(500)), 'source_url');
});

test('label trims and rejects control chars or bad sizes', () => {
  assert.equal(label('  Scienze Politiche L-36 '), 'Scienze Politiche L-36');
  rejects(() => label(''), 'label');
  rejects(() => label('a'.repeat(161)), 'label');
  rejects(() => label('a\u0007b'), 'label');
});

test('query numbers: seats, hours, days', () => {
  assert.equal(minSeats('50'), 50);
  rejects(() => minSeats('0'), 'seats');
  rejects(() => minSeats('2001'), 'seats');
  rejects(() => minSeats('5e1'), 'seats');
  rejects(() => minSeats('-5'), 'seats');
  assert.equal(minFreeHours('2'), 2);
  rejects(() => minFreeHours('13'), 'hours');
  assert.equal(dayCount('7'), 7);
  rejects(() => dayCount('15'), 'days');
  rejects(() => dayCount(''), 'days');
});

test('courseKey accepts 32 lowercase hex chars only', () => {
  assert.equal(courseKey(KEY_A), KEY_A);
  rejects(() => courseKey(''), 'course_key');
  rejects(() => courseKey(KEY_A.slice(1)), 'course_key');
  rejects(() => courseKey(KEY_A + '0'), 'course_key');
  rejects(() => courseKey(KEY_A.toUpperCase()), 'course_key');
  rejects(() => courseKey('g' + KEY_A.slice(1)), 'course_key');
  rejects(() => courseKey(KEY_A.slice(1) + '\n'), 'course_key');
  rejects(() => courseKey(null), 'course_key');
  rejects(() => courseKey([KEY_A]), 'course_key');
  rejects(() => courseKey('a'.repeat(100_000)), 'course_key');
});

test('courseKeys splits on commas, drops duplicates and sorts', () => {
  assert.deepEqual(courseKeys(KEY_A), [KEY_A]);
  assert.deepEqual(courseKeys(`${KEY_B},${KEY_A}`), [KEY_A, KEY_B]);
  assert.deepEqual(courseKeys(`${KEY_B},${KEY_A},${KEY_B},${KEY_A}`), [KEY_A, KEY_B]);
  const twelve = Array.from({ length: 12 }, (_, i) => i.toString(16).repeat(32));
  assert.deepEqual(courseKeys([...twelve].reverse().join(',')), twelve);
  assert.deepEqual(courseKeys(Array<string>(12).fill(KEY_A).join(',')), [KEY_A]);
});

test('courseKeys rejects empty, too many, malformed keys and other separators', () => {
  const code = 'course_keys';
  rejects(() => courseKeys(null), code);
  rejects(() => courseKeys(undefined), code);
  rejects(() => courseKeys([KEY_A]), code);
  rejects(() => courseKeys(''), code);
  rejects(() => courseKeys(','), code);
  rejects(() => courseKeys(Array.from({ length: 13 }, (_, i) => i.toString(16).repeat(32)).join(',')), code);
  rejects(() => courseKeys(Array<string>(13).fill(KEY_A).join(',')), code);
  rejects(() => courseKeys(KEY_A.toUpperCase()), code);
  rejects(() => courseKeys(KEY_A.slice(1)), code);
  rejects(() => courseKeys(KEY_A + '0'), code);
  rejects(() => courseKeys(`${KEY_A},${KEY_B.slice(1)}`), code);
  rejects(() => courseKeys(`${KEY_A},`), code);
  rejects(() => courseKeys(`,${KEY_A}`), code);
  rejects(() => courseKeys(`${KEY_A},,${KEY_B}`), code);
  rejects(() => courseKeys(`${KEY_A}, ${KEY_B}`), code);
  rejects(() => courseKeys(` ${KEY_A}`), code);
  rejects(() => courseKeys(`${KEY_A};${KEY_B}`), code);
  rejects(() => courseKeys(`${KEY_A} ${KEY_B}`), code);
  rejects(() => courseKeys(`${KEY_A}|${KEY_B}`), code);
  rejects(() => courseKeys(`${KEY_A}\n`), code);
  rejects(() => courseKeys(`${KEY_A.slice(2)}%2`), code);
  rejects(() => courseKeys(`${KEY_A},`.repeat(100_000)), code);
});
