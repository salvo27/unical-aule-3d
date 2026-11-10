// config/pdf.json: one section per department layout (profile), validated at start; anything unknown is refused.
import { readFile, stat } from 'node:fs/promises';
import { isoDay, label, type IsoDay, type Label } from '../../domain/primitives.js';
import type { CalendarConfig, Semester } from './expand.js';
import type { ParsedProfile, PdfProfile } from './runner.js';

export class PdfConfigError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(field);
    this.name = 'PdfConfigError';
    this.field = field;
  }
}

const MAX_FILE_BYTES = 200_000;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const DAY_MS = 86_400_000;
// "<profile>:<key>", for example discag:0881.
const PDF_REF = /^([a-z]{2,10}):[A-Za-z0-9_-]{1,60}$/;

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function check<T>(field: string, fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new PdfConfigError(field);
  }
}

// Size, then content, then syntax: a value that trim() would change is refused.
export function plain(v: unknown, max: number, field: string): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > max || CONTROL.test(v) || v.trim() !== v) {
    throw new PdfConfigError(field);
  }
  return v;
}

export function keysOnly(v: Record<string, unknown>, keys: readonly string[], field: string): void {
  if (Object.keys(v).some((k) => !keys.includes(k))) throw new PdfConfigError(field);
}

export function pdfRef(value: unknown, profile: string): string {
  if (typeof value !== 'string' || value.length > 71) throw new PdfConfigError('feed_ref');
  const m = PDF_REF.exec(value);
  if (!m || m[1] !== profile) throw new PdfConfigError('feed_ref');
  return value;
}

export function feedLabel(value: unknown): Label {
  return check('feed_label', () => label(plain(value, 160, 'feed_label')));
}

export function sha256Hex(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 64 || !/^[0-9a-f]{64}$/.test(value)) throw new PdfConfigError('sha256');
  return value;
}

function academicYear(value: unknown): string {
  if (typeof value !== 'string' || value.length !== 9) throw new PdfConfigError('academic_year');
  const m = /^(\d{4})-(\d{4})$/.exec(value);
  if (!m || Number(m[2]) !== Number(m[1]) + 1 || Number(m[1]) < 2020 || Number(m[1]) > 2098) throw new PdfConfigError('academic_year');
  return value;
}

function day(value: unknown, field: string): IsoDay {
  return check(field, () => isoDay(value));
}

function dayMs(d: IsoDay): number {
  return Date.parse(`${d}T00:00:00Z`);
}

function semester(value: unknown, field: string): Semester {
  if (!isRecord(value)) throw new PdfConfigError(field);
  keysOnly(value, ['first', 'last'], field);
  const first = day(value.first, field);
  const last = day(value.last, field);
  const span = (dayMs(last) - dayMs(first)) / DAY_MS;
  if (span < 0 || span > 200) throw new PdfConfigError(field);
  return { first, last };
}

// academicYear, semester, semesters and closedDays of a profile section.
export function calendarOf(section: Record<string, unknown>): CalendarConfig {
  const year = academicYear(section.academicYear);
  if (section.semester !== 1 && section.semester !== 2) throw new PdfConfigError('semester');
  if (!isRecord(section.semesters)) throw new PdfConfigError('semesters');
  keysOnly(section.semesters, ['1', '2'], 'semesters');
  const first = semester(section.semesters['1'], 'semester_1');
  const second = semester(section.semesters['2'], 'semester_2');
  if (dayMs(first.last) >= dayMs(second.first)) throw new PdfConfigError('semesters');
  const start = Number(year.slice(0, 4));
  if (Number(first.first.slice(0, 4)) !== start || Number(second.last.slice(0, 4)) !== start + 1) throw new PdfConfigError('semesters');
  if (!Array.isArray(section.closedDays) || section.closedDays.length > 120) throw new PdfConfigError('closed_days');
  const closedDays = new Set(section.closedDays.map((d) => day(d, 'closed_days')));
  return { academicYear: year, semester: section.semester, semesters: { 1: first, 2: second }, closedDays };
}

// Every key but version must be a known profile and every known profile must have its section.
export function parsePdfConfig(raw: unknown, profiles: readonly PdfProfile[]): ParsedProfile[] {
  if (!isRecord(raw) || raw.version !== 1) throw new PdfConfigError('version');
  keysOnly(raw, ['version', ...profiles.map((p) => p.key)], 'config');
  const out = profiles.map((p) => {
    if (!(p.key in raw)) throw new PdfConfigError('profile_missing');
    const parsed = p.parse(raw[p.key]);
    if (parsed.key !== p.key || parsed.feeds.some((f) => !f.ref.startsWith(`${p.key}:`))) throw new PdfConfigError('feed_ref');
    return parsed;
  });
  const feeds = out.flatMap((p) => p.feeds);
  if (new Set(feeds.map((f) => f.ref)).size !== feeds.length || new Set(feeds.map((f) => f.id)).size !== feeds.length) {
    throw new PdfConfigError('feed_duplicate');
  }
  if (feeds.length > 100) throw new PdfConfigError('feeds');
  return out;
}

export const PDF_CONFIG_PATH = new URL('../../../../config/pdf.json', import.meta.url);

export async function loadPdfConfig(profiles: readonly PdfProfile[], path: string | URL = PDF_CONFIG_PATH): Promise<ParsedProfile[]> {
  let raw: unknown;
  try {
    if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error('size');
    raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    throw new PdfConfigError('file');
  }
  return parsePdfConfig(raw, profiles);
}
