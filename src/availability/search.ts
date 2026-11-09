import type { RoomStatus } from './availability.js';
import type { Lesson } from '../domain/model.js';
import type { SearchText } from '../domain/primitives.js';
import { normalizeText } from '../domain/text.js';
import { notHeldKey } from './availability.js';

export interface SearchFilters {
  freeNow: boolean;
  minHours: number | null;
  minSeats: number | null;
}

export interface LessonHit {
  lessonId: string;
  title: string;
  start: number;
  end: number;
  teachers: string[];
  roomId: string;
  roomName: string;
  buildingName: string;
  buildingKey: string | null;
  floor: number | null;
}

export interface SearchResult {
  rooms: RoomStatus[];
  lessons: LessonHit[];
}

const MAX_ROOMS = 50;
const MAX_LESSONS = 20;
const STOP_WORDS = new Set(['aula', 'cubo', 'prof', 'prof.', 'professore', 'professoressa', 'docente', 'lezione', 'corso', 'di']);
const H = 60 * 60 * 1000;

function tokensOf(query: SearchText): string[] {
  const all = query.split(' ');
  const meaningful = all.filter((t) => !STOP_WORDS.has(t));
  return meaningful.length > 0 ? meaningful : all;
}

function matchesAll(haystack: string, tokens: string[]): boolean {
  const compact = haystack.replace(/\s+/g, '');
  return tokens.every((t) => haystack.includes(t) || compact.includes(t));
}

function passesFilters(r: RoomStatus, f: SearchFilters, now: number): boolean {
  if ((f.freeNow || f.minHours !== null) && r.state !== 'free') return false;
  if (f.minHours !== null && r.until !== null && r.until - now < f.minHours * H) return false;
  if (f.minSeats !== null && (r.capacity ?? 0) < f.minSeats) return false;
  return true;
}

function freeFor(r: RoomStatus, now: number): number {
  return r.until === null ? Number.MAX_SAFE_INTEGER : r.until - now;
}

export function search(
  query: SearchText | null,
  filters: SearchFilters,
  rooms: readonly RoomStatus[],
  lessons: Iterable<Lesson>,
  now: number,
  notHeld: ReadonlySet<string> = new Set(),
): SearchResult {
  const anyFilter = filters.freeNow || filters.minHours !== null || filters.minSeats !== null;
  if (!query && !anyFilter) return { rooms: [], lessons: [] };
  const roomById = new Map(rooms.map((r) => [r.id, r]));

  if (!query) {
    const hits = rooms.filter((r) => passesFilters(r, filters, now)).sort((a, b) => freeFor(b, now) - freeFor(a, now));
    return { rooms: hits.slice(0, MAX_ROOMS), lessons: [] };
  }

  const tokens = tokensOf(query);
  const joined = tokens.join('');
  const scored: { room: RoomStatus; score: number }[] = [];
  for (const r of rooms) {
    if (!passesFilters(r, filters, now)) continue;
    const name = normalizeText(r.name).replace(/^aula /, '');
    const haystack = normalizeText(`${r.name} ${r.code} ${r.buildingName} ${(r.buildingKey ?? '').replace(/^cubo-/, '')}`);
    if (!matchesAll(haystack, tokens)) continue;
    const compactName = name.replace(/\s+/g, '');
    const score = compactName === joined ? 3 : compactName.startsWith(joined) ? 2 : 1;
    scored.push({ room: r, score });
  }
  scored.sort((a, b) => b.score - a.score || a.room.name.localeCompare(b.room.name, 'it', { numeric: true }));

  // Title or teacher matches come first; a match only on the degree course name comes after.
  const nextByKey = new Map<string, LessonHit & { rank: number }>();
  for (const l of lessons) {
    if (l.status !== 'active' || l.end <= now) continue;
    const direct = normalizeText(`${l.title} ${l.teachers.join(' ')}`);
    const rank = matchesAll(direct, tokens) ? 0 : matchesAll(normalizeText(`${direct} ${l.courses.join(' ')}`), tokens) ? 1 : -1;
    if (rank < 0) continue;
    for (const roomId of l.roomIds) {
      const room = roomById.get(roomId);
      if (!room || notHeld.has(notHeldKey(l.id, roomId, l.start, l.end))) continue;
      const key = `${normalizeText(l.title)}|${roomId}`;
      const existing = nextByKey.get(key);
      if (existing && existing.start <= l.start) continue;
      nextByKey.set(key, {
        lessonId: l.id,
        title: l.title,
        start: l.start,
        end: l.end,
        teachers: l.teachers,
        roomId,
        roomName: room.name,
        buildingName: room.buildingName,
        buildingKey: room.buildingKey,
        floor: room.floor,
        rank,
      });
    }
  }
  const lessonHits = [...nextByKey.values()]
    .sort((a, b) => a.rank - b.rank || a.start - b.start)
    .slice(0, MAX_LESSONS)
    .map(({ rank: _rank, ...hit }) => hit);
  return { rooms: scored.slice(0, MAX_ROOMS).map((s) => s.room), lessons: lessonHits };
}
