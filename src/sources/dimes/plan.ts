// Weekly plan of the published state: one block per teaching, weekday, room and run of contiguous hours.
import { DimesError } from './codes.js';
import type { DimesConfig, Semester } from './config.js';
import type { DEntry, DUnit, Dataset } from './dataset.js';
import { RoomResolver, type ResolvedRoom } from './rooms.js';
import { normKey } from './text.js';

export interface WeeklyBlock {
  // Teaching (or reserve) identity inside the app, hashed into the lesson ids and never stored.
  key: string;
  title: string;
  courses: string[];
  year: number | null;
  weekday: number;
  startMin: number;
  endMin: number;
  room: ResolvedRoom;
}

export interface WeeklyPlan {
  semester: Semester;
  days: number;
  blocks: WeeklyBlock[];
  hours: number;
  skipped: number;
  ignored: number;
  fallbackRooms: number;
}

export const RESERVED_TITLE = 'Ore riservate';
const MAX_BLOCKS = 5_000;
const MAX_FUSE_STEPS = 5;
const MAX_BLOCK_MIN = 12 * 60;
const EARLIEST = 7 * 60;
const LATEST = 21 * 60;
const MAX_COURSES = 10;

interface Info {
  title: string;
  courses: string[];
  year: number | null;
}

interface Hour {
  info: Info;
  weekday: number;
  startMin: number;
  endMin: number;
  room: ResolvedRoom;
  roomKey: string;
}

function classInfo(ds: Dataset, classes: readonly string[]): Pick<Info, 'courses' | 'year'> {
  const courses: string[] = [];
  const years = new Set<number>();
  for (const c of classes) {
    const cls = ds.classes.get(c);
    if (!cls) continue;
    years.add(cls.year);
    if (cls.course && !courses.includes(cls.course) && courses.length < MAX_COURSES) courses.push(cls.course);
  }
  return { courses, year: years.size === 1 ? ([...years][0] ?? null) : null };
}

// Classes that follow the unit in this semester; null when the whole unit belongs to the other one.
function semesterClasses(unit: DUnit, semester: Semester): string[] | null {
  if (unit.classes.length === 0) return unit.semester === null || unit.semester === semester ? [] : null;
  const out = unit.classes.filter((c) => {
    const s = unit.classSemesters.get(c) ?? unit.semester;
    return s === null || s === semester;
  });
  return out.length > 0 ? out : null;
}

// The title the Planner uses for every class of the block, otherwise the name of the teaching.
function unitTitle(unit: DUnit, classes: readonly string[]): string | null {
  const titles = new Set(classes.map((c) => (unit.classTitles.has(c) ? unit.classTitles.get(c) : unit.title)));
  const [only] = [...titles];
  return titles.size === 1 && only ? only : unit.title;
}

export function buildPlan(ds: Dataset, cfg: DimesConfig): WeeklyPlan {
  const rooms = new RoomResolver(ds, cfg);
  const infos = new Map<string, Info | null>();
  const hours = new Map<string, Hour[]>();
  const seen = new Set<string>();
  let total = 0;
  let skipped = 0;
  let ignored = 0;
  const fallback = new Set<string>();

  const place = (key: string, info: Info, e: DEntry): boolean => {
    const slot = ds.slots[e.s];
    if (!Number.isInteger(e.g) || e.g < 0 || e.g >= ds.days || !Number.isInteger(e.s) || slot === undefined) return false;
    if (!Number.isInteger(e.off) || e.off < 0 || e.off > 2) return false;
    const room = rooms.resolve(e.aula, e.ext);
    if (!room) return false;
    if (room.fallback) fallback.add(`${room.building}|${room.name}`);
    const startMin = slot + 30 * e.off;
    const roomKey = room.matchKey ?? `unplaced|${normKey(room.name)}`;
    const hourKey = `${key}|${e.g}|${startMin}|${roomKey}`;
    if (seen.has(hourKey)) return true;
    seen.add(hourKey);
    const list = hours.get(key) ?? [];
    list.push({ info, weekday: e.g, startMin, endMin: startMin + ds.slotLength, room, roomKey });
    hours.set(key, list);
    return true;
  };

  for (const [key, entries] of ds.positions) {
    let unitId = key;
    for (let i = 0; i < MAX_FUSE_STEPS && !ds.units.has(unitId); i++) unitId = ds.fused.get(unitId) ?? unitId;
    const unit = ds.units.get(unitId);
    const classes = unit ? semesterClasses(unit, ds.semester) : null;
    if (unit && classes === null) {
      ignored += entries.length;
      continue;
    }
    total += entries.length;
    let info = infos.get(unitId);
    if (info === undefined && unit && classes) {
      const title = unitTitle(unit, classes);
      info = title ? { title, ...classInfo(ds, classes) } : null;
      infos.set(unitId, info);
    }
    for (const e of entries) if (!info || !place(unitId, info, e)) skipped += 1;
  }

  for (const r of ds.reserves) {
    if (r.semester !== ds.semester) continue;
    total += 1;
    const info: Info | null = ds.classes.has(r.cls) ? { title: RESERVED_TITLE, ...classInfo(ds, [r.cls]) } : null;
    if (!info || !place(`reserve|${r.cls}`, info, r)) skipped += 1;
  }

  const blocks: WeeklyBlock[] = [];
  for (const [key, list] of hours) {
    list.sort((a, b) => a.weekday - b.weekday || (a.roomKey < b.roomKey ? -1 : a.roomKey > b.roomKey ? 1 : 0) || a.startMin - b.startMin);
    let run: { first: Hour; endMin: number; count: number } | null = null;
    const close = () => {
      if (!run) return;
      const { first, endMin, count } = run;
      if (first.startMin < EARLIEST || endMin > LATEST || endMin - first.startMin > MAX_BLOCK_MIN) {
        skipped += count;
      } else {
        blocks.push({ key, ...first.info, weekday: first.weekday, startMin: first.startMin, endMin, room: first.room });
      }
      run = null;
    };
    for (const h of list) {
      if (run && run.first.weekday === h.weekday && run.first.roomKey === h.roomKey && h.startMin <= run.endMin) {
        run.endMin = Math.max(run.endMin, h.endMin);
        run.count += 1;
      } else {
        close();
        run = { first: h, endMin: h.endMin, count: 1 };
      }
    }
    close();
    if (blocks.length > MAX_BLOCKS) throw new DimesError('too_many');
  }

  // Nothing to show, or too many unreadable hours, would make the rooms look freer than they are.
  if (total - skipped <= 0) throw new DimesError('no_state');
  if (skipped * 10 > total) throw new DimesError('too_many_skipped');
  return { semester: ds.semester, days: ds.days, blocks, hours: total, skipped, ignored, fallbackRooms: fallback.size };
}
