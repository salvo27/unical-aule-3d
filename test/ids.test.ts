import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedId, isSyntheticId, roomMatchKey, syntheticId, syntheticLessonId, syntheticRoomId } from '../src/domain/ids.js';
import { calendarId, plannerId } from '../src/domain/primitives.js';

test('the vector shared with SQL', () => {
  assert.equal(feedId('portal', '0880'), 'fffd0fb7c092ebc04936d5c8');
  assert.equal(syntheticId('fffd', 'portal|0880'), 'fffd0fb7c092ebc04936d5c8');
});

test('prefixes per kind, 24 hex characters, valid ids', () => {
  const feed = feedId('xlsx', 'LT|I ANNO - Ambiente');
  const lesson = syntheticLessonId('xlsx', 'k1');
  const room = syntheticRoomId('cubo-2b', 'consolidata2b');
  assert.match(feed, /^fffd[0-9a-f]{20}$/);
  assert.match(lesson, /^fffe[0-9a-f]{20}$/);
  assert.match(room, /^ffff[0-9a-f]{20}$/);
  assert.equal(calendarId(feed), feed);
  assert.equal(plannerId(lesson), lesson);
  assert.equal(plannerId(room), room);
  assert.ok([feed, lesson, room].every(isSyntheticId));
  assert.equal(isSyntheticId('aaaaaaaaaaaaaaaaaaaaaaaa'), false);
  assert.equal(isSyntheticId('fffaaaaaaaaaaaaaaaaaaaaa'), false);
});

test('ids are stable and depend on source and key', () => {
  assert.equal(syntheticLessonId('portal', 'a'), syntheticLessonId('portal', 'a'));
  assert.notEqual(syntheticLessonId('portal', 'a'), syntheticLessonId('xlsx', 'a'));
  assert.notEqual(syntheticLessonId('portal', 'a'), syntheticLessonId('portal', 'b'));
  assert.notEqual(feedId('portal', '0880'), feedId('portal', '0881'));
  assert.equal(syntheticRoomId('cubo-2b', 'b6'), syntheticRoomId('cubo-2b', 'b6'));
  assert.notEqual(syntheticRoomId('cubo-2b', 'b6'), syntheticRoomId('cubo-2c', 'b6'));
});

test('room match keys ignore case and the "aula" prefix, need a building key', () => {
  assert.equal(roomMatchKey('Cubo 2B', 'CONSOLIDATA 2B'), roomMatchKey('Cubo 2B', 'Aula Consolidata 2B'));
  assert.equal(roomMatchKey('Cubo 2B', 'CONSOLIDATA 2B'), 'cubo-2b|consolidata2b');
  assert.equal(roomMatchKey('Cubo 4D - DiBEST', 'B6'), 'cubo-4d|b6');
  assert.equal(roomMatchKey('', 'B6'), null);
  assert.equal(roomMatchKey('Cubo 4D', '   '), null);
});
