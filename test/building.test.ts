import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildingKey, buildingDisplayName, buildingDepartment, roomNameKey } from '../src/domain/building.js';

test('Planner and campus map names of the same cube get the same key', () => {
  assert.equal(buildingKey('Cubo 4D'), 'cubo-4d');
  assert.equal(buildingKey('Cubo 4D - DiBEST'), 'cubo-4d');
  assert.equal(buildingKey('CUBO 30/B'), 'cubo-30b');
  assert.equal(buildingKey('cubo 0B - DISPeS'), 'cubo-0b');
  assert.equal(buildingKey('Cubo 42A  - DIAm'), 'cubo-42a');
  assert.equal(buildingKey('Cubo 38CDE - DINCI'), 'cubo-38cde');
});

test('other buildings fall back to a slug without the department suffix', () => {
  assert.equal(buildingKey('Aula Magna'), 'aula-magna');
  assert.equal(buildingKey('Polifunzionale - DFSSN'), 'polifunzionale');
  assert.equal(buildingKey('Cubi 7-11B Uffici Amministrazione'), 'cubi-7-11b-uffici-amministrazione');
  assert.equal(buildingKey("<![CDATA[CLA - Centro Linguistico d'Ateneo]]>"), 'cla');
});

test('empty or symbol-only names have no key', () => {
  assert.equal(buildingKey(''), null);
  assert.equal(buildingKey(' - '), null);
  assert.equal(buildingKey('x'.repeat(300)), null);
});

test('display name drops department suffix and odd spaces', () => {
  assert.equal(buildingDisplayName('Cubo 4D - DiBEST'), 'Cubo 4D');
  assert.equal(buildingDisplayName('Cubo 1A -DISPeS'), 'Cubo 1A');
  assert.equal(buildingDisplayName('Cubi 7-11B Uffici'), 'Cubi 7-11B Uffici');
  assert.equal(buildingDisplayName('Aula Magna'), 'Aula Magna');
  assert.equal(buildingDepartment('Cubo 1A -DISPeS'), 'DISPeS');
  assert.equal(buildingKey('Polifunzionale -DFSSN'), 'polifunzionale');
});

test('room name key ignores the "aula" prefix, case and spaces', () => {
  assert.equal(roomNameKey('Aula MT1'), 'mt1');
  assert.equal(roomNameKey('MT 1'), 'mt1');
  assert.equal(roomNameKey('mt1'), 'mt1');
  assert.equal(roomNameKey('Aula A'), 'a');
});
