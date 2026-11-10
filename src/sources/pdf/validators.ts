// Strict readers of timetable cells: a value that does not fit the closed forms is refused, never guessed.
import type { CellCode } from './codes.js';
import { compact, norm } from './text.js';

export type Slot = readonly [number, number];

const RANGE = /(\d{1,2})(?:[.:](\d{2}))?\s*[-/]\s*(\d{1,2})(?:[.:](\d{2}))?/g;
const EARLIEST = 7 * 60;
const LATEST = 21 * 60;
const LONGEST = 6 * 60;

function minutes(h: string | undefined, m: string | undefined): number | null {
  const hours = Number(h);
  const mins = Number(m ?? '0');
  if (!Number.isInteger(hours) || hours > 23 || mins % 15 !== 0 || mins > 45) return null;
  return hours * 60 + mins;
}

// "9-11", "8.30- 11.00", "14.30/ 17.30", "13-14 / 16-18": quarter hours from 07:00 to 21:00,
// at most 6 hours each, in order and not overlapping; only separators may remain.
export function parseTimes(text: string): Slot[] | null {
  if (text.length > 120) return null;
  const t = norm(text);
  const out: Slot[] = [];
  let rest = '';
  let at = 0;
  for (const m of t.matchAll(RANGE)) {
    const s = minutes(m[1], m[2]);
    const e = minutes(m[3], m[4]);
    if (s === null || e === null || s < EARLIEST || e > LATEST || e <= s || e - s > LONGEST) return null;
    out.push([s, e]);
    rest += t.slice(at, m.index);
    at = m.index + m[0].length;
  }
  rest += t.slice(at);
  if (out.length === 0 || !/^[\s/,;]*$/.test(rest.replace(/\bE\b/g, ' '))) return null;
  for (let i = 1; i < out.length; i += 1) if (out[i]![0] < out[i - 1]![1]) return null;
  return out;
}

export interface RoomPattern<R> {
  room: R;
  // Compiled from the configuration: anchored, upper case letters, digits, '?' and lookaheads only.
  re: RegExp;
  cubes: readonly string[];
  polifunzionale: boolean;
  bareCube: boolean;
}

// Location words that may follow a room name: cube, floor, bridge, the Polifunzionale building.
const LOCATION =
  /^(?:CUBO(\d{1,2})([A-D]{1,2})|(\d{1,2})([A-D])(?=\d?PIANO|PT|$)|PONTECARRABILE|POLIFUNZIONALE|PIANOTERRA|PRIMOPIANO|\dPIANO|\dP(?![A-Z])|PIANO|TERRA|PT)/;
const MAX_ROOMS = 10;

export type RoomResult<R> = { rooms: R[] } | { error: Extract<CellCode, 'unknown_room' | 'room_building_mismatch' | 'cell_too_long'> };

// The compact cell text must be a sequence of known rooms, each followed only by location words that agree with it.
export function parseRooms<R>(text: string, patterns: readonly RoomPattern<R>[]): RoomResult<R> {
  if (text.length > 200) return { error: 'cell_too_long' };
  let c = compact(text);
  const found: R[] = [];
  for (let n = 0; c.length > 0; n += 1) {
    if (n >= MAX_ROOMS) return { error: 'unknown_room' };
    // Longest match wins; two patterns with the same longest match are ambiguous.
    let best: { p: RoomPattern<R>; len: number } | null = null;
    let tie = false;
    for (const p of patterns) {
      const m = p.re.exec(c);
      if (!m || m.index !== 0 || m[0].length === 0) continue;
      if (!best || m[0].length > best.len) {
        best = { p, len: m[0].length };
        tie = false;
      } else if (m[0].length === best.len) tie = true;
    }
    if (!best || tie) return { error: 'unknown_room' };
    c = c.slice(best.len);
    for (let l = LOCATION.exec(c); l && l[0].length > 0; l = LOCATION.exec(c)) {
      const cube = l[1] ? `${Number(l[1])}${l[2]}` : l[3] ? `${Number(l[3])}${l[4]}` : null;
      if (l[3] && !best.p.bareCube) return { error: 'unknown_room' };
      if (cube && !best.p.cubes.includes(cube)) return { error: 'room_building_mismatch' };
      if (l[0] === 'POLIFUNZIONALE' && !best.p.polifunzionale) return { error: 'room_building_mismatch' };
      c = c.slice(l[0].length);
    }
    if (!found.includes(best.p.room)) found.push(best.p.room);
  }
  return found.length > 0 ? { rooms: found } : { error: 'unknown_room' };
}
