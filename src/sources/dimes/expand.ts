// Weekly plan to dated lessons in Europe/Rome, inside the semester of the state and outside the days without lessons.
import { addDays, romeDay, romeMidnight } from '../../availability/time.js';
import { syntheticLessonId, syntheticRoomId } from '../../domain/ids.js';
import type { Lesson, RoomInfo } from '../../domain/model.js';
import type { IsoDay, PlannerId } from '../../domain/primitives.js';
import type { FetchContext, SourceData } from '../types.js';
import { DimesError } from './codes.js';
import { SEMESTERS, type DimesConfig, type Semester } from './config.js';
import type { WeeklyPlan } from './plan.js';

// Same kind as the Planner lessons, so every reader treats them as lessons.
export const LESSON_KIND = "ATTIVITA' DIDATTICA";
const MAX_LESSONS = 20_000;
const MAX_DAYS = 400;
const MINUTE_MS = 60_000;

export interface RoomCounts {
  planner: number;
  synthetic: number;
  unplaced: number;
}

export interface Expansion {
  data: SourceData;
  rooms: RoomCounts;
}

// 0 Monday ... 6 Sunday.
function weekday(day: IsoDay): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function semesterOn(day: IsoDay, cfg: DimesConfig): Semester | null {
  return SEMESTERS.find((s) => cfg.semesters[s].first <= day && day <= cfg.semesters[s].last) ?? null;
}

// A state covers its semester and the break after it: the first one up to the start of the second, the second
// up to the end of the academic year. Outside, the rooms turn grey instead of looking free.
export function coverage(semester: Semester, cfg: DimesConfig, ctx: Pick<FetchContext, 'from' | 'to'>): { from: number; to: number } {
  const start = semester === 'I' ? cfg.semesters.I.first : addDays(cfg.semesters.I.last, 1);
  const end = semester === 'I' ? cfg.semesters.II.first : addDays(cfg.yearEnd, 1);
  const from = Math.max(ctx.from, romeMidnight(start));
  const to = Math.min(ctx.to, romeMidnight(end));
  if (!(from < to)) throw new DimesError('outside_semester');
  return { from, to };
}

// Lessons are on weekdays between 07:00 and 21:00 and the clock changes on Sunday night, so midnight plus minutes
// is the local time.
export function expandPlan(plan: WeeklyPlan, cfg: DimesConfig, ctx: FetchContext, today: IsoDay): Expansion {
  const current = semesterOn(today, cfg);
  if (current !== null && current !== plan.semester) throw new DimesError('semester_mismatch');
  const { from, to } = coverage(plan.semester, cfg, ctx);
  const semester = cfg.semesters[plan.semester];

  const rooms = new Map<string, RoomInfo>();
  const planner = new Set<string>();
  const unplaced = new Set<string>();
  const lessons: Lesson[] = [];
  let skipped = plan.skipped;
  let day = romeDay(from);
  for (let n = 0; n < MAX_DAYS && romeMidnight(day) < to; n++, day = addDays(day, 1)) {
    if (day < semester.first || day > semester.last || cfg.noLessonDays.has(day)) continue;
    const wd = weekday(day);
    if (wd >= plan.days) continue;
    const midnight = romeMidnight(day);
    for (const b of plan.blocks) {
      if (b.weekday !== wd) continue;
      const start = midnight + b.startMin * MINUTE_MS;
      const end = midnight + b.endMin * MINUTE_MS;
      if (end <= from || start >= to) continue;
      const matchKey = b.room.matchKey;
      if (matchKey === null) {
        unplaced.add(b.room.name);
        skipped += 1;
        continue;
      }
      // A room the Planner knows keeps its Planner id and its Planner details.
      let id: PlannerId | undefined = ctx.plannerRooms.get(matchKey);
      if (id) {
        planner.add(id);
      } else {
        const [bKey = '', rKey = ''] = matchKey.split('|');
        id = syntheticRoomId(bKey, rKey);
        if (!rooms.has(id)) {
          rooms.set(id, {
            id,
            name: b.room.name,
            code: '',
            buildingName: b.room.building,
            capacity: b.room.capacity,
            effectiveCapacity: null,
            services: [],
          });
        }
      }
      if (lessons.length >= MAX_LESSONS) throw new DimesError('too_many');
      lessons.push({
        id: syntheticLessonId('dimes', `${b.key}|${day}|${b.startMin}|${matchKey}`),
        title: b.title,
        start,
        end,
        status: 'active',
        kind: LESSON_KIND,
        courses: [...b.courses],
        year: b.year,
        // Never read from this source.
        teachers: [],
        roomIds: [id],
      });
    }
  }
  return {
    data: { parsed: { lessons, rooms: [...rooms.values()], skipped }, from, to },
    rooms: { planner: planner.size, synthetic: rooms.size, unplaced: unplaced.size },
  };
}
