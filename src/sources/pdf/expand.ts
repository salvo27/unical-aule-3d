// Weekly templates of a PDF to dated lessons in Europe/Rome, inside the semester and outside closed days.
import { addDays, romeDay, romeMidnight } from '../../availability/time.js';
import { syntheticLessonId } from '../../domain/ids.js';
import type { Lesson, RoomInfo } from '../../domain/model.js';
import type { IsoDay, PlannerId } from '../../domain/primitives.js';
import type { FetchContext, SourceData } from '../types.js';
import { LESSON_KIND, romeTime } from '../xlsx/expand.js';
import { PdfError } from './codes.js';
import { weekday } from './text.js';

export interface PdfRoom {
  name: string;
  building: string;
  // Planner directory key and the synthetic id used when no Planner room matches.
  matchKey: string;
  syntheticId: PlannerId;
}

export interface WeeklyEntry {
  // 0 Monday ... 5 Saturday.
  day: number;
  startMin: number;
  endMin: number;
  title: string;
  courses: readonly string[];
  year: number | null;
  rooms: readonly PdfRoom[];
  // Validity from notes of the file, both days included.
  from: IsoDay | null;
  until: IsoDay | null;
  // Lesson key = [...keyHead, ISO day, ...keyTail], stable across syncs while the slot does not change.
  keyHead: readonly string[];
  keyTail: readonly string[];
}

export interface Template {
  entries: readonly WeeklyEntry[];
}

export interface Semester {
  first: IsoDay;
  last: IsoDay;
}

export interface CalendarConfig {
  academicYear: string;
  semester: 1 | 2;
  semesters: Readonly<Record<1 | 2, Semester>>;
  closedDays: ReadonlySet<IsoDay>;
}

export const MAX_WINDOW_LESSONS = 5_000;
const MAX_DAYS = 400;
const MAX_ROOMS = 10;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function title(v: string): string | null {
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length === 0 || t.length > 300 || CONTROL.test(t) ? null : t;
}

// Coverage is the run window inside the semester of the file plus the break between the two semesters, which has
// no lessons, so in the break the rooms follow the other sources. Any other date means a stale file: the rooms turn
// grey. A second semester file while the window still holds first semester days is early and refused too.
export function expandTemplate(template: Template, calendar: CalendarConfig, ctx: FetchContext): SourceData {
  const semester = calendar.semesters[calendar.semester];
  const semesterFrom = romeMidnight(semester.first);
  const semesterTo = romeMidnight(addDays(semester.last, 1));
  const breakFrom = romeMidnight(addDays(calendar.semesters[1].last, 1));
  const breakTo = romeMidnight(calendar.semesters[2].first);
  if (calendar.semester === 2 && ctx.from < breakFrom) throw new PdfError('outside_semester');
  const from = Math.max(ctx.from, calendar.semester === 1 ? semesterFrom : breakFrom);
  const to = Math.min(ctx.to, calendar.semester === 1 ? breakTo : semesterTo);
  if (!(from < to)) throw new PdfError('outside_semester');
  const lessonsTo = Math.min(to, semesterTo);

  const rooms = new Map<string, RoomInfo>();
  const lessons: Lesson[] = [];
  const ids = new Set<string>();
  let skipped = 0;
  let day = romeDay(Math.max(from, semesterFrom));
  for (let n = 0; n < MAX_DAYS && romeMidnight(day) < lessonsTo; n++, day = addDays(day, 1)) {
    const wd = weekday(day);
    if (wd > 5 || calendar.closedDays.has(day)) continue;
    for (const e of template.entries) {
      if (e.day !== wd || (e.from !== null && day < e.from) || (e.until !== null && day > e.until)) continue;
      const id = syntheticLessonId('pdf', [...e.keyHead, day, ...e.keyTail].join('\u001f'));
      if (ids.has(id)) continue;
      ids.add(id);
      const roomIds: PlannerId[] = [];
      for (const room of e.rooms) {
        // A room the Planner knows keeps its Planner id and its Planner details.
        const rid = ctx.plannerRooms.get(room.matchKey) ?? room.syntheticId;
        if (!roomIds.includes(rid)) roomIds.push(rid);
        if (rid === room.syntheticId && !rooms.has(rid)) {
          rooms.set(rid, { id: rid, name: room.name, code: '', buildingName: room.building, capacity: null, effectiveCapacity: null, services: [] });
        }
      }
      const t = title(e.title);
      const start = romeTime(day, e.startMin);
      const end = romeTime(day, e.endMin);
      if (!t || roomIds.length === 0 || roomIds.length > MAX_ROOMS || !(end > start)) {
        skipped += 1;
        continue;
      }
      if (lessons.length >= MAX_WINDOW_LESSONS) throw new PdfError('too_many_lessons');
      lessons.push({
        id,
        title: t,
        start,
        end,
        status: 'active',
        kind: LESSON_KIND,
        courses: [...e.courses],
        year: e.year,
        teachers: [],
        roomIds,
      });
    }
  }
  const used = new Set(lessons.flatMap((l) => l.roomIds));
  return { parsed: { lessons, rooms: [...rooms.values()].filter((r) => used.has(r.id)), skipped }, from, to };
}
