import { test } from 'node:test';
import assert from 'node:assert/strict';
import { romeDay, romeMidnight, addDays, mondayOf } from '../src/availability/time.js';
import { isoDay } from '../src/domain/primitives.js';

test('Rome midnight in winter and summer time', () => {
  assert.equal(new Date(romeMidnight(isoDay('2026-11-09'))).toISOString(), '2026-11-08T23:00:00.000Z');
  assert.equal(new Date(romeMidnight(isoDay('2026-07-01'))).toISOString(), '2026-06-30T22:00:00.000Z');
});

test('Rome midnight on the days the clock changes', () => {
  assert.equal(new Date(romeMidnight(isoDay('2026-03-29'))).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(new Date(romeMidnight(isoDay('2026-03-30'))).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(new Date(romeMidnight(isoDay('2026-10-25'))).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(new Date(romeMidnight(isoDay('2026-10-26'))).toISOString(), '2026-10-25T23:00:00.000Z');
});

test('Rome day of an instant near midnight', () => {
  assert.equal(romeDay(Date.parse('2026-11-08T23:30:00Z')), '2026-11-09');
  assert.equal(romeDay(Date.parse('2026-11-08T22:59:59Z')), '2026-11-08');
});

test('day arithmetic crosses months and years', () => {
  assert.equal(addDays(isoDay('2026-12-31'), 1), '2027-01-01');
  assert.equal(addDays(isoDay('2026-03-01'), -1), '2026-02-28');
  assert.equal(mondayOf(isoDay('2026-11-15')), '2026-11-09');
  assert.equal(mondayOf(isoDay('2026-11-09')), '2026-11-09');
});
