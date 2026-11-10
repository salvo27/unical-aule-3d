// Source adapter port: every timetable source produces the same validated calendar.
import type { CalendarId, PlannerId } from '../domain/primitives.js';
import type { ParsedCalendar } from '../planner/parse.js';

export type SourceKind = 'planner' | 'portal' | 'dimes' | 'xlsx' | 'pdf';
export const SOURCE_KINDS: readonly SourceKind[] = ['planner', 'portal', 'dimes', 'xlsx', 'pdf'];

export type SourceFailure =
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'too_large'
  | 'bad_json'
  | 'bad_shape'
  | 'bad_html'
  | 'too_many'
  | 'wrong_period'
  | 'client_id'
  | 'unexpected';

export class SourceError extends Error {
  readonly code: SourceFailure;
  constructor(code: SourceFailure) {
    super(code);
    this.name = 'SourceError';
    this.code = code;
  }
}

export interface Feed {
  id: CalendarId;
  source: SourceKind;
  ref: string | null;
}

export interface FetchContext {
  from: number;
  to: number;
  plannerRooms: ReadonlyMap<string, PlannerId>;
}

// from/to: the coverage the source really has, within the run window.
export interface SourceData {
  parsed: ParsedCalendar;
  from: number;
  to: number;
}

export interface SourceAdapter {
  readonly kind: SourceKind;
  prepare(): Promise<void>;
  fetch(feed: Feed, ctx: FetchContext): Promise<SourceData>;
}
