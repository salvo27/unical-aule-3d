// The canteen menu of the university, from its PDF as pdftotext -layout writes it.
// Every page is one week and one meal: a header "MENÙ ORDINARIO - Dal 16 Novembre al 22 Novembre", the meal with the
// column titles (PRIMI PIATTI, SECONDI PIATTI, CONTORNI), then seven days of five rows. Each row has, per column, the
// code of the line (C, V, M, PF, NML) and the dish. The weekday is written on the middle row of its five.
// A long dish name wraps: half above its row, half below, and the row keeps only the code. So the text is read by
// columns, and every piece of text without a code goes to the nearest row whose cell in that column is empty.
// Anything that does not fit this shape is refused: no menu is better than a wrong one.
import { addDays, mondayOf } from '../availability/time.js';
import { isoDay, type IsoDay } from '../domain/primitives.js';

export type MenuLine = 'C' | 'V' | 'M' | 'PF' | 'NML';
export interface Dish {
  line: MenuLine;
  name: string;
  frozen: boolean;
}
export interface Meal {
  first: Dish[];
  second: Dish[];
  side: Dish[];
}
export interface MenuDay {
  day: IsoDay;
  lunch: Meal | null;
  dinner: Meal | null;
}
export interface Period {
  startsOn: IsoDay;
  endsOn: IsoDay;
}

export type MenuCode =
  | 'no_pages'
  | 'bad_header'
  | 'bad_week'
  | 'no_meal'
  | 'no_columns'
  | 'bad_row'
  | 'stray_text'
  | 'row_count'
  | 'bad_day'
  | 'bad_dish'
  | 'outside_period'
  | 'duplicate_meal';

export class MenuError extends Error {
  readonly code: MenuCode;
  constructor(code: MenuCode) {
    super(code);
    this.name = 'MenuError';
    this.code = code;
  }
}

const LINES: ReadonlySet<string> = new Set<MenuLine>(['C', 'V', 'M', 'PF', 'NML']);
const WEEKDAYS = ['LUNEDI', 'MARTEDI', 'MERCOLEDI', 'GIOVEDI', 'VENERDI', 'SABATO', 'DOMENICA'];
export const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const ROWS_PER_DAY = 5;
const MAX_NAME = 120;
// How far, in characters, a code may sit from the column it belongs to: pdftotext moves text by a few characters.
const SLACK = 6;

const HEADER = /MEN[ÙU]\s+ORDINARIO\s*-\s*Dal\s+(\d{1,2})\s+(\p{L}+)(?:\s+(\d{4}))?\s+al\s+(\d{1,2})\s+(\p{L}+)(?:\s+(\d{4}))?/iu;
const MEAL = /^\s*(PRANZO|CENA)\b/;
// The legend under the table, written from the left edge: the first line of it ends the rows. A row starts with
// spaces, so a dish called "Minestra di patate" after its code M is not the legend "M Minestra".
const END = /^(\*\s*prodotto|(C|V|M|PF|NML) (Linea \p{L}+|Minestra|Piatto Freddo)\s*$|Tutti i men)/iu;
const CODE = /(?<=^|\s)(NML|PF|C|V|M)(?=\s|$)/g;

const plain = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase();

// The month of a date written in Italian. A misspelt one ("settmbre") still starts like the right month and is
// about as long: the first three letters tell the twelve months apart.
export function monthIndex(word: string): number {
  const w = plain(word).toLowerCase();
  const exact = MONTHS.indexOf(w);
  if (exact >= 0) return exact;
  const near = MONTHS.filter((m) => m.slice(0, 3) === w.slice(0, 3) && Math.abs(m.length - w.length) <= 2);
  return near.length === 1 ? MONTHS.indexOf(near[0]!) : -1;
}

function day(y: number, m: number, d: number): IsoDay | null {
  try {
    return isoDay(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  } catch {
    return null;
  }
}

// The Monday the week of a header starts from. The header may lack the year: it is the one that puts the week in
// the period. The days are written by hand and sometimes wrong ("Dal 3 febbraio al 8 febbraio", "Dal 1 marzo al
// 8 marzo"): a week always ends on Sunday, so a Sunday at the end fixes a first day that is not a Monday.
function weekStart(header: RegExpExecArray, period: Period): IsoDay {
  const [m1, m2] = [monthIndex(header[2] ?? ''), monthIndex(header[5] ?? '')];
  if (m1 < 0 || m2 < 0) throw new MenuError('bad_header');
  const turn = m2 < m1 ? 1 : 0;
  const periodYears = [Number(period.startsOn.slice(0, 4)), Number(period.endsOn.slice(0, 4))];
  // "Dal 29 Dicembre al 4 Gennaio 2026": a year written at the end is the one of the last day
  const startYears = header[3] ? [Number(header[3])] : header[6] ? [Number(header[6]) - turn] : periodYears;
  const endYears = header[6] ? [Number(header[6])] : header[3] ? [Number(header[3]) + turn] : periodYears;
  const near = (d: IsoDay | null): d is IsoDay => d !== null && d >= addDays(period.startsOn, -6) && d <= addDays(period.endsOn, 6);
  const start = startYears.map((y) => day(y, m1, Number(header[1]))).find(near) ?? null;
  const end = endYears.map((y) => day(y, m2, Number(header[4]))).find(near) ?? null;
  const isMonday = start !== null && mondayOf(start) === start;
  const isSunday = end !== null && addDays(mondayOf(end), 6) === end;
  if (isMonday && (!end || end === addDays(start, 6))) return start;
  if (isSunday) return addDays(end, -6);
  if (isMonday) return start;
  throw new MenuError(start === null && end === null ? 'outside_period' : 'bad_week');
}

function dish(code: string, text: string): Dish {
  const frozen = text.includes('*');
  const name = text
    .replace(/\*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:])/g, '$1')
    .trim();
  if (!LINES.has(code) || name.length === 0 || name.length > MAX_NAME) throw new MenuError('bad_dish');
  // Some dishes are typed without the capital letter ("orzo con curcuma"): every name starts with one
  return { line: code as MenuLine, name: name.charAt(0).toUpperCase() + name.slice(1), frozen };
}

interface Row {
  at: number;
  codes: [string, string, string];
  cells: [string[], string[], string[]];
  weekday: number | null;
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

// Where the three columns start: the code positions of the rows that have the three codes and a dish after each.
function columns(lines: readonly string[]): [number, number, number] {
  const found: [number[], number[], number[]] = [[], [], []];
  for (const line of lines) {
    const codes = [...line.matchAll(CODE)];
    if (codes.length !== 3) continue;
    for (let k = 0; k < 3; k += 1) found[k]!.push(codes[k]!.index);
  }
  if (found[0].length < ROWS_PER_DAY) throw new MenuError('no_columns');
  const at: [number, number, number] = [median(found[0]), median(found[1]), median(found[2])];
  if (!(at[0] < at[1] && at[1] < at[2])) throw new MenuError('no_columns');
  return at;
}

// One page: the meal and its days, each with five dishes per course.
function parsePage(page: string, period: Period): { meal: 'lunch' | 'dinner'; days: { day: IsoDay; meal: Meal }[] } | null {
  const lines = page.split('\n');
  const headerAt = lines.findIndex((l) => HEADER.test(l));
  if (headerAt < 0) {
    if (page.trim() === '') return null;
    throw new MenuError('bad_header');
  }
  const start = weekStart(HEADER.exec(lines[headerAt]!)!, period);
  const mealAt = lines.findIndex((l, i) => i > headerAt && MEAL.test(l));
  if (mealAt < 0) throw new MenuError('no_meal');
  const meal = MEAL.exec(lines[mealAt]!)![1] === 'PRANZO' ? 'lunch' : 'dinner';
  let endAt = lines.findIndex((l, i) => i > mealAt && END.test(l));
  if (endAt < 0) endAt = lines.length;
  const body = lines.slice(mealAt + 1, endAt);
  const at = columns(body);
  // A column runs from its code to a little before the next one
  const bounds = (k: number): [number, number] => [at[k]! - SLACK, k < 2 ? at[k + 1]! - SLACK : Infinity];

  const rows: Row[] = [];
  const pieces: { at: number; column: number; text: string }[] = [];
  const weekdays: { at: number; weekday: number }[] = [];
  body.forEach((line, i) => {
    if (line.trim() === '') return;
    // The weekday stands left of the first column
    const left = line.slice(0, Math.max(0, at[0] - SLACK)).trim();
    if (left !== '') {
      const w = WEEKDAYS.indexOf(plain(left));
      if (w < 0) throw new MenuError('stray_text');
      weekdays.push({ at: i, weekday: w });
    }
    const codes = [...line.matchAll(CODE)].filter((m) => at.some((x) => Math.abs(m.index - x) <= SLACK));
    if (codes.length > 0) {
      if (codes.length !== 3 || codes.some((m, k) => Math.abs(m.index - at[k]!) > SLACK)) throw new MenuError('bad_row');
      const cell = (k: number) => {
        const from = codes[k]!.index + codes[k]![0].length;
        const to = k < 2 ? codes[k + 1]!.index : line.length;
        return line.slice(from, to).trim();
      };
      rows.push({
        at: i,
        codes: [codes[0]![0], codes[1]![0], codes[2]![0]],
        cells: [[cell(0)].filter(Boolean), [cell(1)].filter(Boolean), [cell(2)].filter(Boolean)],
        weekday: null,
      });
      return;
    }
    for (let k = 0; k < 3; k += 1) {
      const [from, to] = bounds(k);
      const text = line.slice(Math.max(0, from), to === Infinity ? undefined : to).trim();
      if (text !== '') pieces.push({ at: i, column: k, text });
    }
  });

  // Every loose piece of a name goes to the nearest row with that cell empty, the one above on a tie
  const wrapped = new Set<string>();
  for (const k of [0, 1, 2]) {
    for (const r of rows) if (r.cells[k]!.length === 0) wrapped.add(`${r.at}/${k}`);
  }
  const extra = new Map<string, { at: number; text: string }[]>();
  for (const p of pieces) {
    const candidates = rows.filter((r) => wrapped.has(`${r.at}/${p.column}`) && Math.abs(r.at - p.at) <= 2);
    if (candidates.length === 0) throw new MenuError('stray_text');
    candidates.sort((a, b) => Math.abs(a.at - p.at) - Math.abs(b.at - p.at) || a.at - b.at);
    const key = `${candidates[0]!.at}/${p.column}`;
    extra.set(key, [...(extra.get(key) ?? []), { at: p.at, text: p.text }]);
  }
  for (const r of rows) {
    for (const k of [0, 1, 2]) {
      const parts = extra.get(`${r.at}/${k}`);
      if (parts) r.cells[k] = parts.sort((a, b) => a.at - b.at).map((x) => x.text);
    }
  }

  for (const w of weekdays) {
    const row = rows.find((r) => r.at === w.at) ?? rows.filter((r) => Math.abs(r.at - w.at) <= 1)[0];
    if (!row || row.weekday !== null) throw new MenuError('bad_day');
    row.weekday = w.weekday;
  }
  if (rows.length === 0 || rows.length % ROWS_PER_DAY !== 0 || rows.length / ROWS_PER_DAY > 7) throw new MenuError('row_count');

  const days: { day: IsoDay; meal: Meal }[] = [];
  for (let d = 0; d < rows.length / ROWS_PER_DAY; d += 1) {
    const block = rows.slice(d * ROWS_PER_DAY, (d + 1) * ROWS_PER_DAY);
    const named = block.filter((r) => r.weekday !== null);
    // One weekday per five rows, in the order of the week
    if (named.length !== 1 || named[0]!.weekday !== d) throw new MenuError('bad_day');
    const course = (k: number) => block.map((r) => dish(r.codes[k]!, r.cells[k]!.join(' ')));
    days.push({ day: addDays(start, d), meal: { first: course(0), second: course(1), side: course(2) } });
  }
  return { meal, days };
}

// The whole file: every day of the period that the file covers, with lunch and dinner when it has them.
export function parseMenu(text: string, period: Period): MenuDay[] {
  const byDay = new Map<IsoDay, MenuDay>();
  for (const page of text.split('\f')) {
    const parsed = parsePage(page, period);
    if (!parsed) continue;
    for (const { day: d, meal } of parsed.days) {
      // Days of the first and last week outside the period are not part of this menu
      if (d < period.startsOn || d > period.endsOn) continue;
      const entry = byDay.get(d) ?? { day: d, lunch: null, dinner: null };
      if (entry[parsed.meal] !== null) throw new MenuError('duplicate_meal');
      entry[parsed.meal] = meal;
      byDay.set(d, entry);
    }
  }
  if (byDay.size === 0) throw new MenuError('no_pages');
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
