// Text rules shared by the PDF layouts: normalization, Italian dates and small helpers.
import { isoDay, type IsoDay } from '../../domain/primitives.js';

// Ordinal signs unified, accents removed, typographic quotes and dashes folded, spaces collapsed, upper case.
export function norm(s: string): string {
  return s
    .replace(/[\u00ba\u00b0]/g, '\u00b0')
    .replace(/[\u2018\u2019`\u00b4]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

export function compact(s: string): string {
  return norm(s).replace(/[^A-Z0-9]/g, '');
}

const MONTHS: Readonly<Record<string, number>> = {
  GENNAIO: 1,
  FEBBRAIO: 2,
  MARZO: 3,
  APRILE: 4,
  MAGGIO: 5,
  GIUGNO: 6,
  LUGLIO: 7,
  AGOSTO: 8,
  SETTEMBRE: 9,
  OTTOBRE: 10,
  NOVEMBRE: 11,
  DICEMBRE: 12,
};

// Day, month (number or Italian name) and year (2 or 4 digits) to an IsoDay, or null.
export function italianDay(d: string, m: string, y: string): IsoDay | null {
  const month = /^\d{1,2}$/.test(m) ? Number(m) : MONTHS[norm(m)];
  if (!month || !/^\d{1,2}$/.test(d) || !/^(\d{2}|\d{4})$/.test(y)) return null;
  const year = y.length === 2 ? 2000 + Number(y) : Number(y);
  const pad = (n: number) => String(n).padStart(2, '0');
  try {
    return isoDay(`${year}-${pad(month)}-${pad(Number(d))}`);
  } catch {
    return null;
  }
}

export const DAY_NAMES = ['LUNEDI', 'MARTEDI', 'MERCOLEDI', 'GIOVEDI', 'VENERDI', 'SABATO'] as const;

// 0 Monday ... 6 Sunday.
export function weekday(day: IsoDay): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// Levenshtein distance, cut at 3: only "at most 2" matters.
export function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2 || a.length > 400 || b.length > 400) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return Math.min(prev[b.length]!, 3);
}
