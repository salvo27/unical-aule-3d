// Weekly templates to dated lessons in Europe/Rome, inside the semester and outside closed days.
import { addDays, romeDay, romeMidnight, TIME_ZONE } from '../../availability/time.js';
import { syntheticLessonId } from '../../domain/ids.js';
import type { Lesson, RoomInfo } from '../../domain/model.js';
import type { IsoDay, PlannerId } from '../../domain/primitives.js';
import type { ParsedCalendar } from '../../planner/parse.js';
import type { FetchContext } from '../types.js';
import { XlsxError } from './codes.js';
import type { DiamConfig, DiamSheet } from './config.js';
import type { Template } from './layout.js';
import { norm } from './text.js';

// Same kind as the Planner lessons, so every reader treats them as lessons.
export const LESSON_KIND = "ATTIVITA' DIDATTICA";
const MAX_LESSON_MS = 12 * 60 * 60 * 1000;
const MAX_DAYS = 400;
const MAX_ROOMS = 10;
const MAX_TEACHERS = 10;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function offsetMs(ms: number): number {
  const p: Record<string, number> = {};
  for (const x of formatter.formatToParts(ms)) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

// Local wall clock time in Rome to epoch ms, with the same two step correction as romeMidnight.
export function romeTime(day: IsoDay, minutes: number): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, Math.floor(minutes / 60), minutes % 60);
  let t = wall - offsetMs(wall);
  const corrected = offsetMs(t);
  if (wall - corrected !== t) t = wall - corrected;
  return t;
}

// 0 Monday ... 6 Sunday.
function weekday(day: IsoDay): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function text(v: string, max: number): string | null {
  if (v.length > max * 2) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length === 0 || t.length > max || CONTROL.test(t) ? null : t;
}

export interface Expanded {
  parsed: ParsedCalendar;
  from: number;
  to: number;
}

// Coverage is the run window inside the semester of the file plus the configured break between the two
// semesters, which has no lessons, so in the break the rooms follow the other sources. Any other date is a
// stale file: outside_semester, and the rooms turn grey. A second semester file while the window still holds
// first semester days is early: an ok run would drop the first semester lessons and free their rooms.
export function expandTemplate(template: Template, sheet: DiamSheet, config: DiamConfig, ctx: FetchContext): Expanded {
  const semester = config.semesters[template.semester];
  const semesterFrom = romeMidnight(semester.first);
  const semesterTo = romeMidnight(addDays(semester.last, 1));
  const breakFrom = romeMidnight(addDays(config.semesters[1].last, 1));
  const breakTo = romeMidnight(config.semesters[2].first);
  if (template.semester === 2 && ctx.from < breakFrom) throw new XlsxError('outside_semester');
  const from = Math.max(ctx.from, template.semester === 1 ? semesterFrom : breakFrom);
  const to = Math.min(ctx.to, template.semester === 1 ? breakTo : semesterTo);
  if (!(from < to)) throw new XlsxError('outside_semester');
  const lessonsTo = Math.min(to, semesterTo);

  const rooms = new Map<string, RoomInfo>();
  const lessons: Lesson[] = [];
  let skipped = 0;
  let day = romeDay(Math.max(from, semesterFrom));
  for (let n = 0; n < MAX_DAYS && romeMidnight(day) < lessonsTo; n++, day = addDays(day, 1)) {
    const wd = weekday(day);
    if (wd > 5 || config.closedDays.has(day)) continue;
    for (const l of template.lessons) {
      if (l.day !== wd) continue;
      const roomIds: PlannerId[] = [];
      const stable: string[] = [];
      for (const alias of l.rooms) {
        const room = config.rooms.get(alias);
        if (!room) continue;
        stable.push(room.syntheticId);
        // A room the Planner knows keeps its Planner id and its Planner details.
        const id = ctx.plannerRooms.get(room.matchKey) ?? room.syntheticId;
        if (!roomIds.includes(id)) roomIds.push(id);
        if (id === room.syntheticId && !rooms.has(id)) {
          rooms.set(id, { id, name: room.name, code: '', buildingName: room.building, capacity: room.capacity, effectiveCapacity: null, services: [] });
        }
      }
      const title = text(l.title, 300);
      const start = romeTime(day, l.startMin);
      const end = romeTime(day, l.endMin);
      if (!title || roomIds.length === 0 || roomIds.length > MAX_ROOMS || !(end > start) || end - start > MAX_LESSON_MS) {
        skipped += 1;
        continue;
      }
      const teachers: string[] = [];
      for (const t of l.teachers) {
        const name = text(t, 121);
        if (name && !teachers.includes(name) && teachers.length < MAX_TEACHERS) teachers.push(name);
      }
      const key = [sheet.id, day, String(l.startMin), String(l.endMin), norm(title), stable.join(',')].join('\u001f');
      lessons.push({
        id: syntheticLessonId('xlsx', key),
        title,
        start,
        end,
        status: 'active',
        kind: LESSON_KIND,
        courses: [sheet.course],
        year: sheet.year,
        teachers,
        roomIds,
      });
    }
  }
  return { parsed: { lessons, rooms: [...rooms.values()], skipped }, from, to };
}
