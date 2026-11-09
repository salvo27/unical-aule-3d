// Domain primitives: a value of these types exists only if it is valid.
// Checks follow the course order: size, lexical content, syntax, semantics.
import { ValidationError } from './errors.js';
import { normalizeText } from './text.js';

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type CalendarId = Brand<string, 'CalendarId'>;
export type PlannerId = Brand<string, 'PlannerId'>;
export type Floor = Brand<number, 'Floor'>;
export type FloorCount = Brand<number, 'FloorCount'>;
export type BaseLevel = Brand<number, 'BaseLevel'>;
export type IsoDay = Brand<string, 'IsoDay'>;
export type SearchText = Brand<string, 'SearchText'>;
export type SourceUrl = Brand<string, 'SourceUrl'>;
export type Label = Brand<string, 'Label'>;

export const PLANNER_HOST = 'unical.prod.up.cineca.it';

const HEX24 = /^[0-9a-f]{24}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function hex24(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length !== 24 || !HEX24.test(value)) {
    throw new ValidationError(code);
  }
  return value;
}

export function calendarId(value: unknown): CalendarId {
  return hex24(value, 'calendar_id') as CalendarId;
}

export function plannerId(value: unknown): PlannerId {
  return hex24(value, 'planner_id') as PlannerId;
}

const CALENDAR_PATH = /^\/calendarioPubblico\/linkCalendarioId=([0-9a-f]{24})\/?$/;

// Accepts a bare id or a public Planner link, as pasted by an admin.
export function calendarReference(value: unknown): CalendarId {
  const code = 'calendar_ref';
  if (typeof value !== 'string' || value.length > 500) throw new ValidationError(code);
  const trimmed = value.trim();
  if (trimmed.length === 24 && HEX24.test(trimmed)) return trimmed as CalendarId;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ValidationError(code);
  }
  if (url.protocol !== 'https:' || url.hostname !== PLANNER_HOST || url.port !== '' || url.username || url.password) {
    throw new ValidationError(code);
  }
  const match = CALENDAR_PATH.exec(url.pathname);
  if (!match || !match[1]) throw new ValidationError(code);
  return match[1] as CalendarId;
}

function integerInRange(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ValidationError(code);
  }
  return value;
}

// Unical cubes have at most 8 floors above the ground; -2 covers basements.
export function floor(value: unknown): Floor {
  return integerInRange(value, -2, 12, 'floor') as Floor;
}

export function floorCount(value: unknown): FloorCount {
  return integerInRange(value, 1, 15, 'floor_count') as FloorCount;
}

// How many floors the ground floor sits above the lowest point, because of the slope.
export function baseLevel(value: unknown): BaseLevel {
  return integerInRange(value, 0, 12, 'base_level') as BaseLevel;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isoDay(value: unknown): IsoDay {
  const code = 'day';
  if (typeof value !== 'string' || value.length !== 10) throw new ValidationError(code);
  const match = DAY.exec(value);
  if (!match) throw new ValidationError(code);
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new ValidationError(code);
  }
  if (y < 2020 || y > 2099) throw new ValidationError(code);
  return value as IsoDay;
}

export function searchText(value: unknown): SearchText {
  const code = 'search';
  if (typeof value !== 'string' || value.length > 80) throw new ValidationError(code);
  if (CONTROL.test(value)) throw new ValidationError(code);
  const normalized = normalizeText(value);
  if (normalized.length < 1 || normalized.length > 60) throw new ValidationError(code);
  return normalized as SearchText;
}

// Pages scanned for timetable links: only Unical sites over https.
export function sourceUrl(value: unknown): SourceUrl {
  const code = 'source_url';
  if (typeof value !== 'string' || value.length > 500) throw new ValidationError(code);
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ValidationError(code);
  }
  const host = url.hostname;
  const allowedHost = host === 'unical.it' || host.endsWith('.unical.it');
  if (url.protocol !== 'https:' || !allowedHost || url.port !== '' || url.username || url.password) {
    throw new ValidationError(code);
  }
  url.hash = '';
  return url.href as SourceUrl;
}

export function label(value: unknown): Label {
  const code = 'label';
  if (typeof value !== 'string' || value.length > 300) throw new ValidationError(code);
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 160 || CONTROL.test(trimmed)) throw new ValidationError(code);
  return trimmed as Label;
}

function queryInteger(value: unknown, min: number, max: number, code: string): number {
  if (typeof value !== 'string' || value.length < 1 || value.length > 4 || !/^\d+$/.test(value)) {
    throw new ValidationError(code);
  }
  return integerInRange(Number(value), min, max, code);
}

export function minSeats(value: unknown): number {
  return queryInteger(value, 1, 2000, 'seats');
}

export function minFreeHours(value: unknown): number {
  return queryInteger(value, 1, 12, 'hours');
}

export function dayCount(value: unknown): number {
  return queryInteger(value, 1, 14, 'days');
}
