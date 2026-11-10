// Synthetic 24 hex ids for feeds, lessons and rooms of sources without Planner ids.
// The fff prefix would be a Planner timestamp after 2100, so it never collides with a real id.
import { createHash } from 'node:crypto';
import { calendarId, plannerId, type CalendarId, type PlannerId } from './primitives.js';
import { buildingKey, roomNameKey } from './building.js';
import type { SourceKind } from '../sources/types.js';

type OtherSource = Exclude<SourceKind, 'planner'>;

export function syntheticId(prefix: 'fffd' | 'fffe' | 'ffff', key: string): string {
  return prefix + createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 20);
}

export function feedId(source: OtherSource, ref: string): CalendarId {
  return calendarId(syntheticId('fffd', `${source}|${ref}`));
}

export function syntheticLessonId(source: OtherSource, key: string): PlannerId {
  return plannerId(syntheticId('fffe', `${source}|${key}`));
}

export function syntheticRoomId(buildingKey: string, roomKey: string): PlannerId {
  return plannerId(syntheticId('ffff', `room|${buildingKey}|${roomKey}`));
}

export function roomMatchKey(buildingName: string, roomName: string): string | null {
  const building = buildingKey(buildingName);
  const room = roomNameKey(roomName);
  return building && room ? `${building}|${room}` : null;
}

export function isSyntheticId(id: string): boolean {
  return /^fff[def]/.test(id);
}
