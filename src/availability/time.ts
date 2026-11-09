import { isoDay, type IsoDay } from '../domain/primitives.js';

export const TIME_ZONE = 'Europe/Rome';
const DAY_MS = 24 * 60 * 60 * 1000;

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

function parts(ms: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of formatter.formatToParts(ms)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value);
  }
  return out;
}

function offsetMs(ms: number): number {
  const p = parts(ms);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

export function romeDay(ms: number): IsoDay {
  const p = parts(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return isoDay(`${p.year}-${pad(p.month!)}-${pad(p.day!)}`);
}

export function romeHour(ms: number): number {
  return parts(ms).hour!;
}

export function romeMidnight(day: IsoDay): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  let t = utcMidnight - offsetMs(utcMidnight);
  const corrected = offsetMs(t);
  if (utcMidnight - corrected !== t) t = utcMidnight - corrected;
  return t;
}

export function addDays(day: IsoDay, n: number): IsoDay {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return isoDay(new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10));
}

export function mondayOf(day: IsoDay): IsoDay {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(day, -((weekday + 6) % 7));
}
