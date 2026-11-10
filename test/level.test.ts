import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classLevel, courseWithLevel, MAX_COURSE_CHARS, plannerLevel } from '../src/sources/level.js';

test('Planner course types: L, LM, LM5 and LM6 have a level, every other type has none', () => {
  assert.equal(plannerLevel('L'), 'triennale');
  assert.equal(plannerLevel('LM'), 'magistrale');
  assert.equal(plannerLevel('LM5'), 'ciclo unico');
  assert.equal(plannerLevel('LM6'), 'ciclo unico');
  for (const other of ['M1-270', 'M2-270', 'FI', 'RSS684', 'SU', 'l', 'lm', ' L', 'L ', 'LM7', '', 'L'.repeat(11), null, undefined, 5, {}, ['L']]) {
    assert.equal(plannerLevel(other), null, String(other));
  }
});

test('degree classes: L triennale, LM magistrale, the single cycle classes ciclo unico, anything else refused', () => {
  const cases: [string, string][] = [
    ['L-8', 'triennale'],
    ['L-18 R', 'triennale'],
    ['L-13', 'triennale'],
    ['LM-32', 'magistrale'],
    ['LM-35 R', 'magistrale'],
    ['LM-4', 'magistrale'],
    ['LM-85', 'magistrale'],
    ['LMG/01', 'ciclo unico'],
    ['LMG/01 R', 'ciclo unico'],
    ['LMR/02', 'ciclo unico'],
    ['LM-4 c.u.', 'ciclo unico'],
    ['LM-4 c.u R', 'ciclo unico'],
    ['LM-13', 'ciclo unico'],
    ['LM-13 R', 'ciclo unico'],
    ['LM-41', 'ciclo unico'],
    ['LM-41 R', 'ciclo unico'],
    ['LM-42', 'ciclo unico'],
    ['LM-46', 'ciclo unico'],
    ['LM-85 bis', 'ciclo unico'],
  ];
  for (const [value, level] of cases) assert.equal(classLevel(value), level, value);
  const refused = ['L-8 c.u.', 'L-4 c.u.', 'LM-41 c.u.', 'LMG/02', 'LM-123', 'L-', 'l-8', 'L-8 ', ' L-8', 'L-8\n', 'LM-32 r', 'LM-13.'];
  for (const bad of [...refused, 'Laurea', 'LMCU', '', 'LM-1'.padEnd(21, '0'), null, 8]) {
    assert.equal(classLevel(bad), null, String(bad));
  }
});

test('the level ends the course label only while it fits 200 characters; no level keeps the name', () => {
  assert.equal(MAX_COURSE_CHARS, 200);
  assert.equal(courseWithLevel('FISICA', 'triennale'), 'FISICA (triennale)');
  assert.equal(courseWithLevel('FISICA', 'ciclo unico'), 'FISICA (ciclo unico)');
  assert.equal(courseWithLevel('FISICA', null), 'FISICA');
  assert.equal(courseWithLevel('A'.repeat(187), 'magistrale'), `${'A'.repeat(187)} (magistrale)`);
  assert.equal(courseWithLevel('A'.repeat(188), 'magistrale'), null);
  assert.equal(courseWithLevel('A'.repeat(200), null), 'A'.repeat(200));
  assert.equal(courseWithLevel('A'.repeat(201), null), null);
  assert.equal(courseWithLevel('\u{1F600}'.repeat(187), 'magistrale')?.length, 374 + 13, 'characters, not UTF-16 units, as in SQL');
});
