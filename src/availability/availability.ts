import type { Snapshot } from '../store/snapshot-store.js';
import type { AdminConfig } from '../domain/admin-config.js';
import type { Lesson } from '../domain/model.js';
import type { Floor, PlannerId } from '../domain/primitives.js';
import type { Override } from '../supabase/gateway.js';
import { buildingKey, seedKey } from '../domain/building.js';
import { romeDay } from './time.js';

export type RoomState = 'free' | 'busy' | 'unknown';

export interface RoomStatus {
  id: string;
  name: string;
  code: string;
  buildingName: string;
  buildingKey: string | null;
  floor: number | null;
  state: RoomState;
  until: number | null;
  current: { title: string; end: number } | null;
  next: { title: string; start: number } | null;
  capacity: number | null;
  effectiveCapacity: number | null;
  services: string[];
  report: 'occupied' | 'closed' | 'crowd' | null;
  issues: { category: string; until: number }[];
}

export interface Counts {
  free: number;
  busy: number;
  unknown: number;
}

export interface BuildingStatus {
  floors: Record<string, Counts>;
  unplaced: Counts;
  total: Counts;
}

export interface Shape {
  floors: number;
  baseLevel: number;
}

export interface StatusResult {
  now: number;
  lastRunAt: number | null;
  calendars: number;
  staleCalendars: number;
  rooms: RoomStatus[];
  buildings: Record<string, BuildingStatus>;
  shapes: Record<string, Shape>;
  unmatchedBuildings: string[];
  reportsAvailable: boolean;
}

interface Input {
  snapshot: Snapshot;
  config: AdminConfig;
  roomSeeds: ReadonlyMap<string, Floor>;
  campusKeys: ReadonlySet<string>;
  now: number;
  staleAfterMs: number;
  overrides?: readonly Override[];
  reportsAvailable?: boolean;
}

// Back-to-back lessons with a short break count as one busy block.
const CHAIN_GAP_MS = 15 * 60 * 1000;

const zero = (): Counts => ({ free: 0, busy: 0, unknown: 0 });

export function defaultShape(key: string): Shape {
  return key.startsWith('cubo-') ? { floors: 5, baseLevel: 0 } : { floors: 2, baseLevel: 0 };
}

function uniqueLessons(snapshot: Snapshot): Map<string, { lesson: Lesson; calendars: Set<string> }> {
  const out = new Map<string, { lesson: Lesson; calendars: Set<string> }>();
  for (const [calId, cal] of Object.entries(snapshot.calendars)) {
    for (const lesson of cal.lessons) {
      const entry = out.get(lesson.id);
      if (entry) entry.calendars.add(calId);
      else out.set(lesson.id, { lesson, calendars: new Set([calId]) });
    }
  }
  return out;
}

export function allLessons(snapshot: Snapshot): Lesson[] {
  return [...uniqueLessons(snapshot).values()].map((e) => e.lesson);
}

export type ShownLesson = Lesson & { notHeld?: boolean };

// Keys of lessons a moderator confirmed as not held: same lesson, same room, same times.
// If the timetable moves the lesson, the report no longer applies (the room shows busy again).
export function notHeldKey(lessonId: string, roomId: string, start: number, end: number): string {
  return `${lessonId}|${roomId}|${start}|${end}`;
}

export function notHeldKeys(overrides: readonly Override[]): Set<string> {
  const keys = new Set<string>();
  for (const o of overrides) {
    if (o.kind === 'lesson_not_held' && o.source === 'approved' && o.lessonId) keys.add(notHeldKey(o.lessonId, o.roomId, o.start, o.end));
  }
  return keys;
}

// Cancels exactly the reported lesson in the reported room; a report that matches no lesson changes nothing.
export function markNotHeld(lessons: Lesson[], overrides: readonly Override[], roomId: string): ShownLesson[] {
  const keys = notHeldKeys(overrides);
  if (keys.size === 0) return lessons;
  return lessons.map((l) =>
    l.status === 'active' && keys.has(notHeldKey(l.id, roomId, l.start, l.end)) ? { ...l, status: 'cancelled', notHeld: true } : l,
  );
}

export function roomLessons(snapshot: Snapshot, roomId: string, from: number, to: number, overrides: readonly Override[] = []): ShownLesson[] {
  const out: Lesson[] = [];
  for (const { lesson } of uniqueLessons(snapshot).values()) {
    if (lesson.roomIds.includes(roomId as Lesson['roomIds'][number]) && lesson.end > from && lesson.start < to) out.push(lesson);
  }
  return markNotHeld(
    out.sort((a, b) => a.start - b.start),
    overrides.filter((o) => o.roomId === roomId),
    roomId,
  );
}

export function resolveBuildingKey(name: string, config: AdminConfig, campusKeys: ReadonlySet<string>): string | null {
  const linked = config.buildingLinks[name];
  if (linked && campusKeys.has(linked)) return linked;
  const key = buildingKey(name);
  return key && campusKeys.has(key) ? key : null;
}

type Computed = Pick<RoomStatus, 'state' | 'until' | 'current' | 'next' | 'report' | 'issues'>;

interface Block {
  start: number;
  end: number;
  title: string;
  kind: 'lesson' | 'occupied' | 'crowd' | 'closed';
}

// Lessons and "occupied"/"closed" reports form one set of blocks. Reports can only add blocks;
// making a room free needs an approved "not held", applied before this (markNotHeld).
function stateOf(lessons: Lesson[], overrides: readonly Override[], now: number): Computed {
  const active = lessons.filter((l) => l.status === 'active');
  const blocks: Block[] = active.map((l) => ({ start: l.start, end: l.end, title: l.title, kind: 'lesson' }));
  for (const o of overrides) {
    if (o.kind === 'room_closed') blocks.push({ start: o.start, end: o.end, title: 'Aula chiusa', kind: 'closed' });
    if (o.kind === 'room_occupied') {
      blocks.push({ start: o.start, end: o.end, title: 'Segnalata occupata', kind: o.source === 'approved' ? 'occupied' : 'crowd' });
    }
  }
  blocks.sort((a, b) => a.start - b.start);
  const issues = overrides
    .filter((o) => o.kind === 'issue' && o.source === 'approved' && o.start <= now && now < o.end)
    .map((o) => ({ category: o.category ?? 'altro', until: o.end }));
  const upcoming = active.filter((l) => l.start > now).sort((a, b) => a.start - b.start)[0];
  const next = upcoming ? { title: upcoming.title, start: upcoming.start } : null;

  const current = blocks.filter((b) => b.start <= now && now < b.end);
  if (current.length > 0) {
    let end = Math.max(...current.map((b) => b.end));
    for (const b of blocks) {
      if (b.start > end + CHAIN_GAP_MS) break;
      if (b.end > end) end = b.end;
    }
    const lesson = current.find((b) => b.kind === 'lesson');
    const report = lesson
      ? null
      : current.some((b) => b.kind === 'closed')
        ? 'closed'
        : current.some((b) => b.kind === 'occupied')
          ? 'occupied'
          : 'crowd';
    const shown = lesson ?? current[0]!;
    return { state: 'busy', until: end, current: { title: shown.title, end: shown.end }, next, report, issues };
  }
  const today = romeDay(now);
  const later = blocks.find((b) => b.start > now);
  const until = later && romeDay(later.start) === today ? later.start : null;
  return { state: 'free', until, current: null, next, report: null, issues };
}

export function computeStatus(input: Input): StatusResult {
  const { snapshot, config, roomSeeds, campusKeys, now, staleAfterMs } = input;
  const overridesByRoom = new Map<string, Override[]>();
  for (const o of input.overrides ?? []) {
    const list = overridesByRoom.get(o.roomId) ?? [];
    list.push(o);
    overridesByRoom.set(o.roomId, list);
  }
  const staleCals = new Set<string>();
  for (const [id, cal] of Object.entries(snapshot.calendars)) {
    if (now - cal.fetchedAt > staleAfterMs || now < cal.from || now >= cal.to) staleCals.add(id);
  }

  const byRoom = new Map<string, { lessons: Lesson[]; stale: boolean }>();
  for (const { lesson, calendars } of uniqueLessons(snapshot).values()) {
    const stale = [...calendars].some((c) => staleCals.has(c));
    for (const roomId of lesson.roomIds) {
      const entry = byRoom.get(roomId) ?? { lessons: [], stale: false };
      entry.lessons.push(lesson);
      entry.stale ||= stale;
      byRoom.set(roomId, entry);
    }
  }

  const rooms: RoomStatus[] = [];
  const buildings: Record<string, BuildingStatus> = {};
  const unmatched = new Set<string>();
  for (const room of Object.values(snapshot.rooms)) {
    const entry = byRoom.get(room.id) ?? { lessons: [], stale: true };
    const key = resolveBuildingKey(room.buildingName, config, campusKeys);
    if (!key && room.buildingName) unmatched.add(room.buildingName);
    const floor = config.rooms[room.id]?.floor ?? (key ? roomSeeds.get(seedKey(key, room.name)) : undefined) ?? null;
    const roomOverrides = overridesByRoom.get(room.id) ?? [];
    const computed = stateOf(markNotHeld(entry.lessons, roomOverrides, room.id), roomOverrides, now);
    const state = entry.stale ? 'unknown' : computed.state;
    rooms.push({
      id: room.id,
      name: room.name,
      code: room.code,
      buildingName: room.buildingName,
      buildingKey: key,
      floor,
      ...computed,
      state,
      until: entry.stale ? null : computed.until,
      capacity: room.capacity,
      effectiveCapacity: room.effectiveCapacity,
      services: room.services,
    });
    if (key) {
      const b = (buildings[key] ??= { floors: {}, unplaced: zero(), total: zero() });
      const bucket = floor === null ? b.unplaced : (b.floors[String(floor)] ??= zero());
      bucket[state] += 1;
      b.total[state] += 1;
    }
  }

  const shapes: Record<string, Shape> = {};
  for (const key of campusKeys) shapes[key] = config.buildings[key] ?? defaultShape(key);

  rooms.sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }));
  return {
    now,
    lastRunAt: snapshot.lastRun?.finishedAt ?? null,
    calendars: Object.keys(snapshot.calendars).length,
    staleCalendars: staleCals.size,
    rooms,
    buildings,
    shapes,
    unmatchedBuildings: [...unmatched].sort(),
    reportsAvailable: input.reportsAvailable ?? false,
  };
}
