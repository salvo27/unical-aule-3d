// Planner source: public calendars, the run window as coverage.
import type { PlannerApi } from '../planner/client.js';
import { parseLessons, PlannerError, type ParsedCalendar } from '../planner/parse.js';
import type { Lesson } from '../domain/model.js';
import { normalizeText } from '../domain/text.js';
import { SourceError, type SourceAdapter } from './types.js';

export type PlannerEventKind = 'lesson' | 'exam' | 'booking' | 'other';

// Only these labels are stored for events that are not lessons: their free text may name people.
export const NON_LESSON_TITLES: Readonly<Record<Exclude<PlannerEventKind, 'lesson'>, string>> = {
  exam: 'Esame',
  booking: 'Prenotazione',
  other: 'Altro impegno',
};

// From the Planner type description. Unknown types are "other" and keep the room busy.
export function plannerEventKind(kind: string): PlannerEventKind {
  const k = normalizeText(kind.replace(/['’`]/g, ' '));
  if (k === 'attivita didattica') return 'lesson';
  if (/(^|\s)esam[ei](\s|$)/.test(k)) return 'exam';
  if (/(^|\s)prenotazion[ei](\s|$)/.test(k)) return 'booking';
  return 'other';
}

export function redactNonLesson(lesson: Lesson): Lesson {
  const kind = plannerEventKind(lesson.kind);
  if (kind === 'lesson') return lesson;
  return { ...lesson, title: NON_LESSON_TITLES[kind], courses: [], teachers: [] };
}

function redact(parsed: ParsedCalendar): ParsedCalendar {
  return { ...parsed, lessons: parsed.lessons.map(redactNonLesson) };
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

// Same reading of the type as parseLessons, so both agree on what a lesson is.
function rawKind(item: Record<string, unknown>): string {
  const t = item.tipoEvento;
  const v = typeof t === 'object' && t !== null ? (t as Record<string, unknown>).descrizione : undefined;
  if (typeof v !== 'string' || v.length > 200) return '';
  const s = v.replace(/\s+/g, ' ').trim();
  return s.length > 100 || CONTROL.test(s) ? '' : s;
}

// Non lesson events get their label before parsing: their free text never enters the model,
// and an empty or overlong name can no longer drop a busy slot.
function redactRaw(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((item: unknown) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return item;
    const rec = item as Record<string, unknown>;
    const kind = plannerEventKind(rawKind(rec));
    return kind === 'lesson' ? rec : { ...rec, nome: NON_LESSON_TITLES[kind], docenti: [], corsi: [] };
  });
}

function sourceError(err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  return new SourceError(err instanceof PlannerError ? err.code : 'unexpected');
}

export function plannerAdapter(api: PlannerApi): SourceAdapter {
  let clientId: string | null = null;
  return {
    kind: 'planner',
    async prepare() {
      try {
        clientId = await api.clientId();
      } catch (err) {
        throw sourceError(err);
      }
    },
    async fetch(feed, ctx) {
      if (feed.source !== 'planner') throw new SourceError('unexpected');
      if (clientId === null) throw new SourceError('client_id');
      try {
        const parsed = parseLessons(redactRaw(await api.calendarEvents(feed.id, clientId, ctx.from, ctx.to)));
        return { parsed: redact(parsed), from: ctx.from, to: ctx.to };
      } catch (err) {
        throw sourceError(err);
      }
    },
  };
}
