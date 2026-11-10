// DiSU timetable PDFs (Excel exports) to a weekly template: Monday to Friday grids per year or curriculum, a legend
// of the teachings and, in some files, a lettorato table. Cells read "TITLE - TEACHER (Aula X)": only the legend
// title, closed qualifiers and the room are kept; the teacher column of the legend is never read.
// Fail closed: a changed layout refuses the file, a cell that cannot be placed fails it.
import { addDays } from '../../availability/time.js';
import { isoDay, type IsoDay } from '../../domain/primitives.js';
import { courseWithLevel, type DegreeLevel } from '../level.js';
import { PdfError, type CellCode, type Finding, type PdfWarning } from './codes.js';
import type { PdfRoom, Semester, WeeklyEntry } from './expand.js';
import { cluster, lines, type HRule, type Page, type Rules, type VRule, type Word } from './grid.js';
import { norm } from './text.js';

// ---------- rules ----------

const NUM = '(-?\\d{1,6}(?:\\.\\d{1,12})?)';
const COEF = '(-?\\d{1,6}(?:\\.\\d{1,30})?(?:e-?\\d{1,3})?)';
const RECT = new RegExp(`^M ${NUM} ${NUM} L ${NUM} ${NUM} L ${NUM} ${NUM} L ${NUM} ${NUM} Z ?`);
const MOVE = new RegExp(`^M ${NUM} ${NUM} ?$`);
const LINE = new RegExp(`^M ${NUM} ${NUM} L ${NUM} ${NUM}$`);
const MATRIX = new RegExp(`^matrix\\(${COEF}, ?${COEF}, ?${COEF}, ?${COEF}, ?${COEF}, ?${COEF}\\)$`);
const D_ATTR = /\sd="([^"]{0,20000})"/;
const TRANSFORM_ATTR = /\stransform="([^"]{0,300})"/;
const STROKED = /\sstroke="(?!none")[^"]{1,60}"/;
const GROUP_TRANSFORM = /<g\b[^>]*\stransform=/;

function axisAligned(xs: number[], ys: number[]): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    if (!close(xs[i]!, xs[j]!) && !close(ys[i]!, ys[j]!)) return false;
  }
  return true;
}

// Thin filled rectangles (A4 files) and stroked two point lines (the A3 file). A transform is accepted only as
// matrix(a, 0, 0, d, e, f), scale, flip and shift, and applied to the points; any other one refuses the file.
export function disuRules(svg: string, maxRules = 20_000): Rules {
  const cut = svg.indexOf('</defs>');
  const body = cut >= 0 ? svg.slice(cut + 7) : svg;
  if (GROUP_TRANSFORM.test(body)) throw new PdfError('rules_transformed');
  const h: HRule[] = [];
  const v: VRule[] = [];
  const add = (x0: number, y0: number, x1: number, y1: number, thin: number) => {
    const [ax, bx, ay, by] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
    if (by - ay <= thin && bx - ax >= 2) h.push({ y: (ay + by) / 2, x0: ax, x1: bx });
    else if (bx - ax <= thin && by - ay >= 2) v.push({ x: (ax + bx) / 2, y0: ay, y1: by });
    if (h.length + v.length > maxRules) throw new PdfError('too_many_rules');
  };
  let paths = 0;
  for (const pm of body.matchAll(/<path\b([^>]{0,20500})>/g)) {
    if (++paths > maxRules * 4) throw new PdfError('too_many_rules');
    const attrs = pm[1] ?? '';
    const d = D_ATTR.exec(attrs)?.[1]?.trim();
    if (!d) continue;
    let [a, e, dd, f] = [1, 0, 1, 0];
    const tr = TRANSFORM_ATTR.exec(attrs);
    if (tr) {
      const m = MATRIX.exec((tr[1] ?? '').trim());
      const k = m ? m.slice(1, 7).map(Number) : [];
      if (!m || !k.every(Number.isFinite) || Math.abs(k[1]!) > 1e-9 || Math.abs(k[2]!) > 1e-9) throw new PdfError('rules_transformed');
      [a, e, dd, f] = [k[0]!, k[4]!, k[3]!, k[5]!];
      if (Math.abs(a) < 0.01 || Math.abs(dd) < 0.01) throw new PdfError('rules_transformed');
    }
    const X = (x: number) => a * x + e;
    const Y = (y: number) => dd * y + f;
    const line = LINE.exec(d);
    if (line) {
      if (!STROKED.test(attrs)) continue;
      const [x0, y0, x1, y1] = line.slice(1, 5).map(Number) as [number, number, number, number];
      add(X(x0), Y(y0), X(x1), Y(y1), 0.5);
      continue;
    }
    let rest = d;
    const rects: number[][] = [];
    for (let m = RECT.exec(rest); m; m = RECT.exec(rest)) {
      rects.push(m.slice(1, 9).map(Number));
      rest = rest.slice(m[0].length);
    }
    if (rects.length === 0 || (rest !== '' && !MOVE.test(rest))) continue;
    for (const r of rects) {
      const xs = [r[0]!, r[2]!, r[4]!, r[6]!].map(X);
      const ys = [r[1]!, r[3]!, r[5]!, r[7]!].map(Y);
      if (!axisAligned(xs, ys)) continue;
      add(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), 1.5);
    }
  }
  return { h, v };
}

// ---------- types ----------

export interface DisuGridSpec {
  year: number;
  // As configured; null for a grid named by its year only.
  curriculum: string | null;
}

export interface DisuLayoutFeed {
  header: string;
  duration: number;
  course: string;
  degree: DegreeLevel;
  grids: readonly DisuGridSpec[];
}

// Room alias (upper case letters and digits, without "Aula", "Lab" or "Laboratorio") to its room.
export type DisuRooms = ReadonlyMap<string, PdfRoom>;

export interface Candidate {
  key: string;
  title: string;
  // The title before its " - " specification.
  short: string | null;
  year: number | null;
  start: IsoDay | null;
  lettorato: boolean;
}

interface Done {
  title: string;
  from: IsoDay | null;
  rooms: PdfRoom[];
  warns: PdfWarning[];
}

// A segment whose title is not in the tables of its own file waits for the tables of the other files.
interface Pending {
  seg: string;
  rooms: PdfRoom[];
}

export interface DisuCell {
  grid: number;
  day: number;
  startMin: number;
  endMin: number;
  where: string;
  problems: CellCode[];
  lessons: (Done | Pending)[];
}

export interface DisuGridInfo {
  index: number;
  year: number;
  course: string;
}

// What the source keeps of a file between runs: no header, no free text of the cells but the pending segments.
export interface DisuFile {
  grids: DisuGridInfo[];
  cells: DisuCell[];
  candidates: Candidate[];
  warnings: Finding[];
}

// ---------- text ----------

const MAX_CELL_CHARS = 1_200;
const MAX_LEGEND_ROWS = 300;
export const MAX_ENTRIES = 1_500;
const DAY_KEYS = ['LUNEDI', 'MARTEDI', 'MERCOLEDI', 'GIOVEDI', 'VENERDI'] as const;
const WEEKEND = new Set(['SABATO', 'DOMENICA']);
const TIME_LABEL = /^(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})$/;
const YEAR_LINE = /^(PRIMO|SECONDO|TERZO)\s+ANNO(?:\s*-\s*(.{1,140}))?$/;
const YEARS: Readonly<Record<string, number>> = { PRIMO: 1, SECONDO: 2, TERZO: 3 };
const LEGEND_HEAD = 'ANNO INSEGNAMENTO DOCENTE DATA INIZIO CORSI';
const LETTORATO_HEAD = 'INSEGNAMENTO DATA INIZIO LEZIONI';
const LEGEND_DATE = /^Inizio lezioni (?:(\d{2})\/(\d{2})\/(\d{4})|(da definire))$/i;
const LETTORATO_TITLE = /^(.{3,160}?)\s*\(\s*lettorato[^()]{0,30}\)$/i;
// A person's title in a teaching title means that the columns moved.
const PERSON = /\b(?:PROF|PROFSSA|DOTT|DOTTSSA|DOCENTE|DOCENTI)\b/;

// Upper case ASCII words: accents, apostrophes and punctuation become spaces.
export function key(s: string): string {
  return norm(s).replace(/[^A-Z0-9]+/g, ' ').trim();
}

function cleanTitle(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/\s+([,.])/g, '$1').trim();
}

function dayOf(w: Word): string {
  return norm(w.t).replace(/'$/, '');
}

function clock(h: string | undefined, m: string | undefined): number | null {
  const hours = Number(h);
  const mins = Number(m);
  return hours <= 23 && mins <= 59 ? hours * 60 + mins : null;
}

function legendDate(text: string): IsoDay | null | undefined {
  const m = LEGEND_DATE.exec(text);
  if (!m) return undefined;
  if (m[4]) return null;
  try {
    return isoDay(`${m[3]}-${m[2]}-${m[1]}`);
  } catch {
    return undefined;
  }
}

function textOf(words: readonly Word[], tol = 2.5): string {
  return lines(words, tol)
    .map((l) => l.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------- geometry ----------

interface Column {
  left: number;
  right: number;
}

interface Row {
  top: number;
  bottom: number;
  start: number;
  end: number;
}

interface CellBox {
  page: number;
  day: number;
  top: number;
  bottom: number;
  start: number;
  end: number;
  words: Word[];
  text: string;
}

interface Grid {
  page: number;
  index: number;
  year: number;
  curriculum: string | null;
  days: Column[];
  time: Column;
  rows: Row[];
  cells: CellBox[];
}

interface DayHeader {
  y: number;
  words: Word[];
}

function below(xs: readonly number[], v: number): number | null {
  let best: number | null = null;
  for (const x of xs) if (x < v && (best === null || x > best)) best = x;
  return best;
}

function above(xs: readonly number[], v: number): number | null {
  let best: number | null = null;
  for (const x of xs) if (x > v && (best === null || x < best)) best = x;
  return best;
}

function hLines(page: Page, x0: number, x1: number): number[] {
  return cluster(page.rules.h.filter((r) => r.x0 <= x0 + 2 && r.x1 >= x1 - 2).map((r) => r.y));
}

function vAt(page: Page, y: number): number[] {
  return cluster(page.rules.v.filter((r) => r.y0 <= y + 1 && r.y1 >= y - 1).map((r) => r.x));
}

function closedBy(rules: readonly VRule[], x: number, y0: number, y1: number): boolean {
  return rules.some((r) => Math.abs(r.x - x) <= 1.5 && r.y0 <= y0 + 1 && r.y1 >= y1 - 1);
}

function same(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((x, k) => Math.abs(x - b[k]!) <= 1.5);
}

// Every "Lunedì" opens a row of the five weekdays, in order, with no weekend day.
function dayHeaders(page: Page, p: number): DayHeader[] {
  const out: DayHeader[] = [];
  for (const mon of page.words.filter((w) => dayOf(w) === 'LUNEDI')) {
    const near = page.words.filter((w) => Math.abs(w.cy - mon.cy) <= 3);
    const row = DAY_KEYS.map((k) => near.filter((w) => dayOf(w) === k));
    if (row.some((r) => r.length !== 1) || near.some((w) => WEEKEND.has(dayOf(w)))) throw new PdfError('day_headers', `p${p}`);
    const ws = row.map((r) => r[0]!);
    for (let i = 1; i < ws.length; i += 1) if (ws[i]!.cx <= ws[i - 1]!.cx) throw new PdfError('day_order', `p${p}`);
    out.push({ y: mon.cy, words: ws });
  }
  return out.sort((a, b) => a.y - b.y);
}

function dayColumns(page: Page, head: DayHeader, at: string): Column[] {
  const vx = vAt(page, head.y);
  const days = head.words.map((w) => {
    const left = below(vx, w.x0);
    const right = above(vx, w.x1);
    if (left === null || right === null) throw new PdfError('column_rules', at);
    return { left, right };
  });
  for (let i = 1; i < days.length; i += 1) if (Math.abs(days[i]!.left - days[i - 1]!.right) > 2) throw new PdfError('column_gap', at);
  if (days.some((c) => c.right - c.left < 60)) throw new PdfError('column_width', at);
  return days;
}

interface Rows {
  bottom: number;
  time: Column;
  rows: Row[];
  cells: CellBox[];
  used: Word[];
}

// Time rows of one grid between yFrom and yTo, from the first label down to the first line that is not a label.
// Without a header row (a grid going on after a page break) the columns of the previous page must be confirmed by
// this page's rules. Returns null when there is no label.
function rowsOf(page: Page, p: number, days: readonly Column[], timeLeft: number | null, yFrom: number, yTo: number, at: string): Rows | null {
  const { rules, words } = page;
  const first = days[0]!;
  const lefts = lines(words.filter((w) => w.cx < first.left && w.cx > first.left - 150 && w.cy > yFrom && w.cy < yTo));
  const labels: { cy: number; start: number; end: number }[] = [];
  for (const l of lefts) {
    const m = TIME_LABEL.exec(l.text);
    if (!m) break;
    const start = clock(m[1], m[2]);
    const end = clock(m[3], m[4]);
    if (start === null || end === null) throw new PdfError('time_step', at);
    labels.push({ cy: l.cy, start, end });
  }
  if (labels.length === 0) return null;
  labels.forEach((l, i) => {
    if (l.end - l.start < 30 || l.end - l.start > 120) throw new PdfError('time_step', at);
    if (i > 0 && labels[i - 1]!.end !== l.start) throw new PdfError('time_step', at);
  });
  // The cell above the time column has no rules: the left rule is read on the first time row.
  const vt = cluster(rules.v.filter((r) => r.y0 <= labels[0]!.cy && r.y1 >= labels[0]!.cy).map((r) => r.x));
  const timeLeft0 = below(vt, first.left - 2);
  if (timeLeft0 === null || first.left - timeLeft0 < 25) throw new PdfError('column_rules', at);
  const time = { left: timeLeft0, right: first.left };
  if (timeLeft !== null && Math.abs(time.left - timeLeft) > 1.5) throw new PdfError('continuation_columns', at);
  for (const c of days) {
    for (const x of [c.left, c.right]) if (!vt.some((v) => Math.abs(v - x) <= 1.5)) throw new PdfError('column_rules', at);
  }
  for (const l of lefts.slice(0, labels.length)) if (l.x0 < time.left - 1) throw new PdfError('stray_words', at);

  const hys = cluster(rules.h.filter((r) => r.x0 <= time.left + 2 && r.x1 >= time.right - 2 && r.y > yFrom - 12).map((r) => r.y));
  const rows = labels.map((l) => {
    const top = below(hys, l.cy);
    const bottom = above(hys, l.cy);
    if (top === null || bottom === null) throw new PdfError('row_rules', at);
    return { top, bottom, start: l.start, end: l.end };
  });
  for (let i = 1; i < rows.length; i += 1) if (Math.abs(rows[i]!.top - rows[i - 1]!.bottom) > 1.5) throw new PdfError('row_gap', at);
  const box = { top: rows[0]!.top, bottom: rows[rows.length - 1]!.bottom, left: time.left, right: days[days.length - 1]!.right };

  // A day column without a horizontal rule between two rows is one cell over both hours.
  const ruled = (y: number, c: Column) => {
    const a = c.left + (c.right - c.left) / 4;
    const b = c.right - (c.right - c.left) / 4;
    return rules.h.some((r) => Math.abs(r.y - y) <= 1.5 && r.x0 <= a && r.x1 >= b);
  };
  const cells: CellBox[] = [];
  days.forEach((c, d) => {
    for (let i = 0; i < rows.length; ) {
      let j = i;
      while (j + 1 < rows.length && !ruled(rows[j]!.bottom, c)) j += 1;
      cells.push({ page: p, day: d, top: rows[i]!.top, bottom: rows[j]!.bottom, start: rows[i]!.start, end: rows[j]!.end, words: [], text: '' });
      i = j + 1;
    }
  });

  // Every word in the grid sits whole inside one day cell or is a time label.
  const used: Word[] = [];
  for (const w of words) {
    if (!(w.cy > box.top && w.cy < box.bottom && w.cx > box.left && w.cx < box.right)) continue;
    used.push(w);
    if (w.cx < time.right) {
      if (!labels.some((l) => Math.abs(l.cy - w.cy) <= 2.5)) throw new PdfError('stray_words', at);
      continue;
    }
    const d = days.findIndex((c) => w.cx > c.left && w.cx < c.right);
    const col = days[d];
    if (!col) throw new PdfError('stray_words', at);
    if (w.x0 < col.left - 1 || w.x1 > col.right + 1) throw new PdfError('word_crosses_column', at);
    const cell = cells.find((c) => c.day === d && w.cy > c.top && w.cy < c.bottom);
    if (!cell) throw new PdfError('stray_words', at);
    if (w.y0 < cell.top - 1 || w.y1 > cell.bottom + 1) throw new PdfError('word_crosses_row', at);
    cell.words.push(w);
  }
  for (const c of cells) {
    c.text = textOf(c.words, 2);
    c.words = [];
    if (c.text.length > MAX_CELL_CHARS) throw new PdfError('cell_too_long', at);
  }
  return { bottom: box.bottom, time, rows, cells: cells.filter((c) => c.text !== ''), used };
}

interface LegendRow {
  year: number;
  title: string;
  key: string;
  start: IsoDay | null;
}

// Rows from the rules under top, while each row has its own vertical rules. The teacher column is never read.
function legendRows(page: Page, cols: readonly number[], top: number, at: string): { rows: LegendRow[]; bottom: number } {
  const ys = hLines(page, cols[0]!, cols[4]!).filter((y) => y >= top - 1);
  const rows: LegendRow[] = [];
  let bottom = top;
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y0 = ys[i]!;
    const y1 = ys[i + 1]!;
    if (!cols.slice(1).every((x) => closedBy(page.rules.v, x, y0, y1))) break;
    bottom = y1;
    const inRow = page.words.filter((w) => w.cy > y0 && w.cy < y1 && w.cx > cols[0]! && w.cx < cols[4]!);
    if (inRow.length === 0) continue;
    const col = (k: number) => textOf(inRow.filter((w) => w.cx > cols[k]! && w.cx < cols[k + 1]!));
    const year = col(0);
    const title = col(1);
    const start = legendDate(col(3));
    if (!/^[1-5]$/.test(year) || title.length < 3 || title.length > 200 || PERSON.test(key(title)) || start === undefined) {
      throw new PdfError('legend_row', at);
    }
    rows.push({ year: Number(year), title: cleanTitle(title), key: key(title), start });
  }
  return { rows, bottom };
}

interface LettoratoRow {
  key: string;
  title: string;
  start: IsoDay | null;
}

// "Insegnamento | Data inizio lezioni"; "X I e II (lettorato)" stands for X I and X II.
function lettoratoRows(page: Page, cols: readonly number[], top: number, at: string): { rows: LettoratoRow[]; bottom: number } {
  const ys = hLines(page, cols[0]!, cols[2]!).filter((y) => y >= top - 1);
  const rows: LettoratoRow[] = [];
  let bottom = top;
  for (let i = 0; i + 1 < ys.length; i += 1) {
    const y0 = ys[i]!;
    const y1 = ys[i + 1]!;
    if (!cols.every((x) => closedBy(page.rules.v, x, y0, y1))) break;
    bottom = y1;
    const inRow = page.words.filter((w) => w.cy > y0 && w.cy < y1 && w.cx > cols[0]! && w.cx < cols[2]!);
    if (inRow.length === 0) continue;
    const t = LETTORATO_TITLE.exec(textOf(inRow.filter((w) => w.cx < cols[1]!)));
    const start = legendDate(textOf(inRow.filter((w) => w.cx > cols[1]!)));
    if (!t || start === undefined || PERSON.test(key(t[1]!))) throw new PdfError('lettorato_table', at);
    const base = key(t[1]!);
    const two = /^(.*) (I|II|III) E (I|II|III)$/.exec(base);
    const titles = two ? [`${two[1]} ${two[2]}`, `${two[1]} ${two[3]}`] : [cleanTitle(t[1]!)];
    for (const title of titles) rows.push({ key: key(title), title, start });
  }
  return { rows, bottom };
}

interface Layout {
  header: string;
  grids: Grid[];
  legend: LegendRow[];
  lettorato: LettoratoRow[];
}

// Pages top to bottom: course header, then per grid its year line, the day row and the time rows; a grid may go
// on at the top of the next page; after the last grid the legend and the lettorato table. Nothing else.
function layoutOf(pages: readonly Page[]): Layout {
  if (pages.length === 0) throw new PdfError('page_count');
  if (pages.every((pg) => pg.words.length === 0)) throw new PdfError('no_text_layer');
  const grids: Grid[] = [];
  const legend: LegendRow[] = [];
  const lettorato: LettoratoRow[] = [];
  let legendCols: number[] | null = null;
  let sideCols: number[] | null = null;
  let header: string | null = null;
  let open: Grid | null = null;
  let pendingYear: string | null = null;

  for (let pi = 0; pi < pages.length; pi += 1) {
    const p = pi + 1;
    const page = pages[pi]!;
    const used = new Set<Word>();
    const mark = (ws: Iterable<Word>) => {
      for (const w of ws) used.add(w);
    };
    const heads = dayHeaders(page, p);
    if (legendCols && heads.length > 0) throw new PdfError('legend_position', `p${p}`);
    let cursor = 0;
    const prev = open as Grid | null;
    if (prev) {
      const at = `p${p}g${prev.index}`;
      const frag = rowsOf(page, p, prev.days, prev.time.left, 0, (heads[0]?.y ?? page.height) - 8, at);
      if (frag) {
        if (frag.rows[0]!.start !== prev.rows[prev.rows.length - 1]!.end) throw new PdfError('time_step', at);
        prev.rows.push(...frag.rows);
        prev.cells.push(...frag.cells);
        mark(frag.used);
        cursor = frag.bottom + 1;
      }
    }
    open = null;

    for (let g = 0; g < heads.length; g += 1) {
      const head = heads[g]!;
      const index = grids.length + 1;
      const at = `p${p}g${index}`;
      const regionBottom = g + 1 < heads.length ? heads[g + 1]!.y - 8 : page.height;
      const titleWords = page.words.filter((w) => !used.has(w) && w.cy > cursor && w.cy < head.y - 3);
      const tl = lines(titleWords);
      let yearText: string;
      if (tl.length === 0 && pendingYear !== null) yearText = pendingYear;
      else if (tl.length > 0 && pendingYear === null) yearText = tl[tl.length - 1]!.text;
      else throw new PdfError('year_line', at);
      pendingYear = null;
      const yl = YEAR_LINE.exec(norm(yearText));
      if (!yl) throw new PdfError('year_line', at);
      const before = tl
        .slice(0, -1)
        .map((l) => l.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (before) {
        if (header !== null || pi !== 0 || g !== 0) throw new PdfError('unexpected_text', at);
        header = before;
      }
      mark(titleWords);
      const days = dayColumns(page, head, at);
      const rows = rowsOf(page, p, days, null, head.y + 3, regionBottom, at);
      if (!rows) throw new PdfError('time_labels', at);
      mark(rows.used);
      mark(head.words);
      const top = rows.rows[0]!.top;
      if (page.words.some((w) => !used.has(w) && w.cy > head.y - 3 && w.cy < top)) throw new PdfError('unexpected_text', at);
      const grid: Grid = { page: p, index, year: YEARS[yl[1]!]!, curriculum: yl[2]?.trim() ?? null, days, time: rows.time, rows: rows.rows, cells: rows.cells };
      grids.push(grid);
      open = grid;
      cursor = rows.bottom + 1;
    }

    // Under the grids: a year line whose grid starts on the next page, or the tables, nothing else.
    const rest = page.words.filter((w) => !used.has(w) && w.cy > cursor);
    const restLines = lines(rest);
    if (restLines.length === 1 && YEAR_LINE.test(norm(restLines[0]!.text)) && legendCols === null) {
      pendingYear = restLines[0]!.text;
      mark(rest);
      open = null;
    } else if (rest.length > 0) {
      open = null;
      const at = `p${p}`;
      let y = cursor;
      for (let guard = 0; guard < 6; guard += 1) {
        const left = page.words.filter((w) => !used.has(w) && w.cy > y);
        if (left.length === 0) break;
        const first = left.reduce((a, b) => (b.cy < a.cy ? b : a));
        const line = left.filter((w) => Math.abs(w.cy - first.cy) <= 3).sort((a, b) => a.x0 - b.x0);
        const text = key(line.map((w) => w.t).join(' '));
        const vx = vAt(page, first.cy);
        const lc = legendCols as number[] | null;
        const sc = sideCols as number[] | null;
        if (text === LEGEND_HEAD) {
          if (lc) throw new PdfError('legend_header', at);
          // The "Anno" column has no left rule: its left edge is where the row rules start.
          const under = page.rules.h.filter((r) => r.y > first.cy && r.y < first.cy + 25 && vx.length > 0 && r.x1 >= vx[vx.length - 1]! - 2);
          const leftX = under.length > 0 ? Math.min(...under.map((r) => r.x0)) : null;
          const cols = vx.length === 4 && leftX !== null && leftX < vx[0]! - 20 ? [leftX, ...vx] : vx;
          if (cols.length !== 5) throw new PdfError('legend_columns', at);
          const named = ['ANNO', 'INSEGNAMENTO', 'DOCENTE', 'DATA'].map((t) => line.find((w) => key(w.t) === t));
          if (named.some((w, k) => !w || w.cx < cols[k]! || w.cx > cols[k + 1]!)) throw new PdfError('legend_columns', at);
          legendCols = cols;
          mark(line);
          const top = above(hLines(page, cols[0]!, cols[4]!), first.cy);
          if (top === null) throw new PdfError('legend_columns', at);
          const t = legendRows(page, cols, top, at);
          legend.push(...t.rows);
          mark(page.words.filter((w) => w.cy > top && w.cy < t.bottom && w.cx > cols[0]! && w.cx < cols[4]!));
          y = t.bottom;
        } else if (lc && !sc && (same(vx, lc) || same(vx, lc.slice(1)))) {
          // The legend goes on at the top of the next page, without its header.
          const top = below(hLines(page, lc[0]!, lc[4]!), first.cy);
          if (top === null) throw new PdfError('legend_row', at);
          const t = legendRows(page, lc, top, at);
          if (t.rows.length === 0) throw new PdfError('legend_row', at);
          legend.push(...t.rows);
          mark(page.words.filter((w) => w.cy > top && w.cy < t.bottom && w.cx > lc[0]! && w.cx < lc[4]!));
          y = t.bottom;
        } else if (lc && vx.length === 3 && (!sc || same(vx, sc))) {
          const cols = sc ?? vx;
          sideCols = cols;
          let top: number | null;
          if (text === LETTORATO_HEAD) {
            const ins = line.find((w) => key(w.t) === 'INSEGNAMENTO');
            const dat = line.find((w) => key(w.t) === 'DATA');
            if (!ins || !dat || !(ins.cx > cols[0]! && ins.cx < cols[1]! && dat.cx > cols[1]! && dat.cx < cols[2]!)) {
              throw new PdfError('lettorato_table', at);
            }
            mark(line);
            top = above(hLines(page, cols[0]!, cols[2]!), first.cy);
          } else top = below(hLines(page, cols[0]!, cols[2]!), first.cy);
          if (top === null) throw new PdfError('lettorato_table', at);
          const t = lettoratoRows(page, cols, top, at);
          if (t.rows.length === 0) throw new PdfError('lettorato_table', at);
          lettorato.push(...t.rows);
          const from = top;
          mark(page.words.filter((w) => w.cy > from && w.cy < t.bottom && w.cx > cols[0]! && w.cx < cols[2]!));
          y = t.bottom;
        } else throw new PdfError('unexpected_text', at);
      }
    }
    if (page.words.some((w) => !used.has(w))) throw new PdfError('unexpected_text', `p${p}`);
  }
  if (pendingYear !== null) throw new PdfError('year_line', `p${pages.length}`);
  for (const g of grids) {
    const at = `p${g.page}g${g.index}`;
    if (g.rows.length < 4 || g.rows.length > 16) throw new PdfError('time_labels', at);
    if (g.rows[0]!.start < 7 * 60 || g.rows[g.rows.length - 1]!.end > 21 * 60) throw new PdfError('time_range', at);
  }
  if (grids.length === 0) throw new PdfError('no_grid');
  if (legend.length === 0) throw new PdfError('no_legend');
  if (header === null) throw new PdfError('course_header');
  if (legend.length + lettorato.length > MAX_LEGEND_ROWS) throw new PdfError('too_many_entries');
  return { header, grids, legend, lettorato };
}

// ---------- cells ----------

interface Match {
  title: string;
  from: IsoDay | null;
  rest: string;
  warns: PdfWarning[];
}

type Matched = Match | 'ambiguous' | null;

// One edit (insert, delete, substitute or swap) between two words of at least 5 letters: a typo, not a new word.
function oneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  if (a.length === b.length) {
    if (a.slice(i + 1) === b.slice(i + 1)) return true;
    return a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  }
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

function fuzzyPrefix(n: string, k: string): boolean {
  const nt = n.split(' ');
  const kt = k.split(' ');
  if (nt.length < kt.length) return false;
  let edits = 0;
  for (let i = 0; i < kt.length; i += 1) {
    if (nt[i] === kt[i]) continue;
    if (!oneEdit(nt[i]!, kt[i]!)) return false;
    edits += 1;
  }
  return edits === 1;
}

const MODULE = /^\s*([^()]{2,100}?)\s*\(([^()]{3,200})\)/;

interface Tier {
  hits: Candidate[];
  rest: string;
  module: string | null;
  fuzzy: boolean;
}

// Tiers, the first with a hit wins: module "X (TITLE)" with every word of X in TITLE (so X is never a name),
// title, title before its " - " specification, one typo. Inside a tier the longest title wins.
function matchTiers(seg: string, candidates: readonly Candidate[], year: number): Matched {
  const n = key(seg);
  const tiers: Tier[] = [];
  const mod = MODULE.exec(seg);
  if (mod) {
    const parent = key(mod[2]!);
    const words = new Set(parent.split(' '));
    const hits = candidates.filter((c) => c.key === parent);
    const own = key(mod[1]!).split(' ').filter(Boolean);
    if (hits.length > 0 && own.length > 0 && own.every((w) => words.has(w))) {
      tiers.push({ hits, rest: key(seg.slice(mod[0].length)), module: cleanTitle(mod[1]!), fuzzy: false });
    }
  }
  for (const field of ['key', 'short'] as const) {
    const hits = candidates.filter((c) => {
      const k = c[field];
      return k !== null && k !== '' && (n === k || n.startsWith(`${k} `));
    });
    if (hits.length > 0) {
      const len = Math.max(...hits.map((h) => h[field]!.length));
      tiers.push({ hits: hits.filter((h) => h[field]!.length === len), rest: n.slice(len).trim(), module: null, fuzzy: false });
    }
  }
  const fz = candidates.filter((c) => fuzzyPrefix(n, c.key));
  if (fz.length > 0) {
    const len = Math.max(...fz.map((h) => h.key.length));
    const best = fz.filter((h) => h.key.length === len);
    tiers.push({ hits: best, rest: n.split(' ').slice(best[0]!.key.split(' ').length).join(' '), module: null, fuzzy: true });
  }
  const t = tiers[0];
  if (!t) return null;
  const warns: PdfWarning[] = [];
  let hits = t.hits;
  const sameYear = hits.filter((h) => h.year === year || h.year === null);
  if (sameYear.length > 0) hits = sameYear;
  else warns.push('legend_other_year');
  if (t.fuzzy) warns.push('title_typo');
  if (new Set(hits.map((h) => h.key)).size !== 1) return 'ambiguous';
  const starts = hits.map((h) => h.start);
  if (new Set(starts).size > 1) warns.push('legend_duplicate');
  // The earliest start: an earlier date only adds lessons, so a room is never shown free by mistake.
  const from = starts.includes(null) ? null : [...starts].sort()[0]!;
  const title = t.module ? `${t.module} (${hits[0]!.title})` : hits[0]!.title;
  return { title, from, rest: t.rest, warns };
}

// A lettorato cell looks first in the lettorato table, any other cell first in the legend.
function matchTitle(seg: string, candidates: readonly Candidate[], year: number): Matched {
  const lett = /\bLETTORATO\b/.test(key(seg));
  const first = matchTiers(seg, candidates.filter((c) => c.lettorato === lett), year);
  if (first) return first;
  const second = matchTiers(seg, candidates.filter((c) => c.lettorato !== lett), year);
  if (second && second !== 'ambiguous') second.warns.push(lett ? 'lettorato_unmatched' : 'title_from_lettorato');
  return second;
}

// Closed list: the rest of the segment, where the teachers are, is dropped.
function qualifiers(rest: string): string[] {
  const q: string[] = [];
  const lett = /\bLETTORATO(?: ([A-Z]) ([A-Z])\b)?/.exec(rest);
  if (lett) q.push(lett[1] ? `Lettorato ${lett[1]}-${lett[2]}` : 'Lettorato');
  const grp = /\bGRUPPO ([A-Z0-9]{1,2})\b/.exec(rest);
  if (grp) q.push(`Gruppo ${grp[1]}`);
  if (/\bESERCITAZION[EI]\b/.test(rest)) q.push('Esercitazioni');
  return q;
}

function sortRooms(rooms: readonly PdfRoom[]): PdfRoom[] {
  return [...rooms].sort((a, b) => (a.syntheticId < b.syntheticId ? -1 : a.syntheticId > b.syntheticId ? 1 : 0));
}

function finish(m: Match, rooms: readonly PdfRoom[], otherPdf: boolean): Done | CellCode {
  if (/\bAULA\b/.test(m.rest)) return 'room_outside_parentheses';
  const warns = [...m.warns];
  if (/\d/.test(m.rest.replace(/\bGRUPPO [A-Z0-9]{1,2}\b/g, ''))) warns.push('cell_note');
  if (otherPdf) warns.push('title_other_pdf');
  // A title over the 300 characters of a lesson would be skipped later, its room shown free: the cell fails now.
  const title = [m.title, ...qualifiers(m.rest)].join(' - ');
  if (title.length > 300) return 'cell_too_long';
  // A title found in another file keeps no start date: the teaching starts with the semester.
  return { title, from: otherPdf ? null : m.from, rooms: sortRooms(rooms), warns };
}

const ROOM_PAREN = /\(\s*([^()]{1,60}?)\s*(?:\)|$)/g;
const ROOM_PREFIX = /^(?:aula|lab\.?|laboratorio)\s*\.?\s+(.+)$/i;
const SEPARATORS = /^[\s\-\u2013\u2014/+,;e]*$/i;

export function roomAlias(s: string): string {
  return key(s)
    .replace(/^(?:AULA|LAB|LABORATORIO) /, '')
    .replace(/ /g, '');
}

// The text between two rooms is one lesson; an empty segment adds the room to the lesson before.
function splitCell(text: string, candidates: readonly Candidate[], year: number, rooms: DisuRooms): { lessons: (Done | Pending)[]; problems: CellCode[] } {
  const refs: { at: number; end: number; room: PdfRoom | null }[] = [];
  for (const m of text.matchAll(ROOM_PAREN)) {
    const inner = m[1] ?? '';
    const pre = ROOM_PREFIX.exec(inner);
    const room = rooms.get(roomAlias(pre ? (pre[1] ?? '') : inner)) ?? null;
    if (pre || room) refs.push({ at: m.index ?? 0, end: (m.index ?? 0) + m[0].length, room });
  }
  const parts: { seg: string; rooms: PdfRoom[] }[] = [];
  const problems: CellCode[] = [];
  let prev = 0;
  for (const r of refs) {
    const seg = text.slice(prev, r.at);
    prev = r.end;
    if (!r.room) problems.push('unknown_room');
    const last = parts[parts.length - 1];
    if (last && SEPARATORS.test(seg)) {
      if (r.room && !last.rooms.includes(r.room)) last.rooms.push(r.room);
      continue;
    }
    parts.push({ seg, rooms: r.room ? [r.room] : [] });
  }
  if (!SEPARATORS.test(text.slice(prev))) problems.push('text_without_room');
  const lessons: (Done | Pending)[] = [];
  for (const part of parts) {
    const m = matchTitle(part.seg, candidates, year);
    if (m === 'ambiguous') problems.push('ambiguous_title');
    else if (m === null) lessons.push({ seg: part.seg, rooms: part.rooms });
    else {
      const done = finish(m, part.rooms, false);
      if (typeof done === 'string') problems.push(done);
      else if (done.rooms.length > 0) lessons.push(done);
    }
  }
  return { lessons, problems };
}

function gridKey(year: number, curriculum: string | null): string {
  return curriculum ? `${year}|${key(curriculum)}` : String(year);
}

// First phase, one file alone: layout, legend and the cells matched on the file's own tables.
export function readDisuFile(pages: readonly Page[], feed: DisuLayoutFeed, rooms: DisuRooms): DisuFile {
  const layout = layoutOf(pages);
  if (key(layout.header) !== key(feed.header)) throw new PdfError('header_mismatch');
  for (const g of layout.grids) if (g.year > feed.duration) throw new PdfError('year_range', `p${g.page}g${g.index}`);
  if (layout.legend.some((r) => r.year > feed.duration)) throw new PdfError('legend_row');
  const expected = new Map(feed.grids.map((s) => [gridKey(s.year, s.curriculum), s]));
  const found = layout.grids.map((g) => gridKey(g.year, g.curriculum));
  for (const k of expected.keys()) if (!found.includes(k)) throw new PdfError('grid_missing');
  if (new Set(found).size !== found.length) throw new PdfError('grid_duplicate');
  const warnings: Finding[] = [];
  const grids: DisuGridInfo[] = layout.grids.map((g, i) => {
    const spec = expected.get(found[i]!);
    if (!spec) warnings.push({ code: 'grid_extra', where: `p${g.page}g${g.index}` });
    // Course, curriculum and level come from the configuration, never from the text of the file.
    const course = spec?.curriculum ? `${feed.course} - ${spec.curriculum}` : feed.course;
    return { index: g.index, year: g.year, course: courseWithLevel(course, feed.degree) ?? course };
  });
  const shortOf = (title: string) => {
    const k = key(title.split(/\s+[\u2013-]\s+/)[0] ?? '');
    return k !== key(title) ? k : null;
  };
  const candidates: Candidate[] = [
    ...layout.legend.map((r) => ({ key: r.key, title: r.title, short: shortOf(r.title), year: r.year, start: r.start, lettorato: false })),
    ...layout.lettorato.map((r) => ({ key: r.key, title: r.title, short: null, year: null, start: r.start, lettorato: true })),
  ];
  const cells: DisuCell[] = [];
  for (const g of layout.grids) {
    for (const c of g.cells) {
      const { lessons, problems } = splitCell(c.text, candidates, g.year, rooms);
      cells.push({ grid: g.index, day: c.day, startMin: c.start, endMin: c.end, where: `p${c.page}g${g.index}d${c.day}h${Math.floor(c.start / 60)}`, problems, lessons });
    }
  }
  return { grids, cells, candidates, warnings };
}

// ---------- weekly template ----------

export interface Suspension {
  first: IsoDay;
  last: IsoDay;
  level: string;
  years: readonly number[];
}

export interface DisuTemplateOptions {
  feedId: string;
  level: string;
  semester: Semester;
  suspensions: readonly Suspension[];
}

export interface DisuTemplate {
  entries: WeeklyEntry[];
  warnings: Finding[];
  unplaced: Finding[];
}

interface Slot {
  grid: number;
  day: number;
  start: number;
  end: number;
  title: string;
  rooms: PdfRoom[];
  roomsKey: string;
  from: IsoDay | null;
}

interface Member {
  grid: DisuGridInfo;
  from: IsoDay | null;
}

interface Period {
  from: IsoDay | null;
  until: IsoDay | null;
  courses: string[];
  year: number | null;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function earliest(a: IsoDay | null, b: IsoDay | null): IsoDay | null {
  return a === null || b === null ? null : a < b ? a : b;
}

// The same lesson of several grids is one lesson; its courses and year change where a grid starts later or is
// suspended (December, by level and year), so the semester is cut at those days.
function periods(members: readonly Member[], opts: DisuTemplateOptions): Period[] {
  const { first, last } = opts.semester;
  const holes = members.map((m) => opts.suspensions.filter((s) => s.level === opts.level && s.years.includes(m.grid.year)));
  const starts = members.map((m) => (m.from !== null && m.from > first ? m.from : first));
  const cuts = new Set<IsoDay>([first, ...starts]);
  for (const hs of holes) {
    for (const h of hs) {
      cuts.add(h.first);
      cuts.add(addDays(h.last, 1));
    }
  }
  const points = [...cuts].filter((d) => d >= first && d <= last).sort();
  const out: Period[] = [];
  let prevSig: string | null = null;
  points.forEach((at, i) => {
    const until = i + 1 < points.length ? addDays(points[i + 1]!, -1) : null;
    const active = members.map((_, k) => k).filter((k) => starts[k]! <= at && !holes[k]!.some((h) => at >= h.first && at <= h.last));
    const sig = active.join(',');
    const lastPart = out[out.length - 1];
    if (active.length === 0) {
      prevSig = null;
      return;
    }
    if (lastPart && prevSig === sig) {
      lastPart.until = until;
      return;
    }
    const years = new Set(active.map((k) => members[k]!.grid.year));
    out.push({
      from: at === first ? null : at,
      until,
      courses: [...new Set(active.map((k) => members[k]!.grid.course))],
      year: years.size === 1 ? [...years][0]! : null,
    });
    prevSig = sig;
  });
  return out;
}

// Second phase: titles missing from a file come from the tables of the other files; then the weekly entries.
export function disuTemplate(file: DisuFile, others: readonly Candidate[], opts: DisuTemplateOptions): DisuTemplate {
  const foreign = others.map((c) => ({ ...c, year: null }));
  const warnings: Finding[] = [...file.warnings];
  const unplaced: Finding[] = [];
  const grids = new Map(file.grids.map((g) => [g.index, g]));
  const slots: Slot[] = [];
  for (const cell of file.cells) {
    const grid = grids.get(cell.grid);
    if (!grid) throw new PdfError('unexpected_text');
    const problems = [...cell.problems];
    const done: Done[] = [];
    for (const l of cell.lessons) {
      if (!('seg' in l)) {
        done.push(l);
        continue;
      }
      const m = foreign.length > 0 ? matchTitle(l.seg, foreign, grid.year) : null;
      if (m === null) problems.push('unknown_title');
      else if (m === 'ambiguous') problems.push('ambiguous_title');
      else {
        const d = finish(m, l.rooms, true);
        if (typeof d === 'string') problems.push(d);
        else if (d.rooms.length > 0) done.push(d);
      }
    }
    // A start after the semester would remove every lesson of the teaching: the cell fails instead.
    if (done.some((d) => d.from !== null && d.from > opts.semester.last)) problems.push('start_outside_semester');
    if (problems.length > 0) {
      for (const code of new Set(problems)) unplaced.push({ code, where: cell.where });
      continue;
    }
    for (const d of done) {
      for (const code of d.warns) warnings.push({ code, where: cell.where });
      const roomsKey = d.rooms.map((r) => r.syntheticId).join(',');
      slots.push({ grid: grid.index, day: cell.day, start: cell.startMin, end: cell.endMin, title: d.title, rooms: d.rooms, roomsKey, from: d.from });
    }
  }

  // Consecutive hours of the same lesson in the same grid are one lesson.
  slots.sort((a, b) => a.grid - b.grid || a.day - b.day || cmp(a.title, b.title) || cmp(a.roomsKey, b.roomsKey) || a.start - b.start);
  const weekly: Slot[] = [];
  for (const s of slots) {
    const last = weekly[weekly.length - 1];
    if (last && last.grid === s.grid && last.day === s.day && last.title === s.title && last.roomsKey === s.roomsKey && last.end === s.start) {
      last.end = s.end;
      last.from = earliest(last.from, s.from);
    } else weekly.push({ ...s });
  }

  const groups = new Map<string, { slot: Slot; members: Member[] }>();
  for (const s of weekly) {
    const k = [s.day, s.start, s.end, s.title, s.roomsKey].join('\u001f');
    const member = { grid: grids.get(s.grid)!, from: s.from };
    const g = groups.get(k);
    if (g) g.members.push(member);
    else groups.set(k, { slot: s, members: [member] });
  }
  const entries: WeeklyEntry[] = [];
  for (const { slot, members } of groups.values()) {
    for (const part of periods(members, opts)) {
      if (entries.length >= MAX_ENTRIES) throw new PdfError('too_many_entries');
      entries.push({
        day: slot.day,
        startMin: slot.start,
        endMin: slot.end,
        title: slot.title,
        courses: part.courses,
        year: part.year,
        rooms: slot.rooms,
        from: part.from,
        until: part.until,
        keyHead: [opts.feedId],
        keyTail: [String(slot.start), String(slot.end), key(slot.title), slot.roomsKey],
      });
    }
  }
  return { entries, warnings, unplaced };
}
