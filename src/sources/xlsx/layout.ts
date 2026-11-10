// Strict layout check of the DIAm workbooks: each timetable sheet becomes a weekly template.
// Anything that does not match the known layout fails the sheet, or the whole file.
import { buildingKey } from '../../domain/building.js';
import { XlsxError, type Finding, type XlsxCode } from './codes.js';
import type { DiamConfig, DiamSheet, RoomAlias } from './config.js';
import { cellKey, type Cell, type Range, type Sheet } from './reader.js';
import { norm, roomAlias, sheetKey, sheetRole, type DiamFileKind } from './text.js';

export interface TemplateLesson {
  day: number; // 0 Monday ... 5 Saturday
  startMin: number;
  endMin: number;
  title: string;
  rooms: RoomAlias[];
  teachers: string[];
}

export interface Template {
  semester: 1 | 2;
  lessons: TemplateLesson[];
}

export type SheetOutcome = { template: Template; warnings: Finding[] } | { failure: XlsxCode };

export interface ParsedWorkbook {
  sheets: Map<string, SheetOutcome>; // by feed ref
  semester: 1 | 2 | null;
  warnings: Finding[];
}

const DAYS = ['LUNEDI', 'MARTEDI', 'MERCOLEDI', 'GIOVEDI', 'VENERDI', 'SABATO'];
const HEADER = ['ORARIO', ...DAYS.flatMap((d) => [d, 'AULA'])];
const BASE_CODES = ['PT', 'SA', 'TAR', 'SMG', 'SC'];
const MAX_GRID_TEXT = 300;
const NOTE_TIME = /\(\s*(\d{1,2})[:.](\d{2})\s*\)/g;
const UNKNOWN_SHARE = 0.2;
const MAX_TEACHERS = 10;

// What a person sees: a merged range shows its top left value in every covered cell.
class View {
  private readonly cover = new Map<string, string>();
  private readonly rows = new Map<number, Cell[]>();
  readonly hidden: string[] = [];
  readonly maxRow: number;

  constructor(private readonly sheet: Sheet) {
    let max = 0;
    for (const c of sheet.cells.values()) {
      max = Math.max(max, c.row);
      const list = this.rows.get(c.row);
      if (list) list.push(c);
      else this.rows.set(c.row, [c]);
    }
    this.maxRow = max;
    for (const m of sheet.merges) {
      const master = sheet.cells.get(cellKey(m.r1, m.c1))?.text ?? '';
      for (let r = m.r1; r <= m.r2; r++) {
        for (let c = m.c1; c <= m.c2; c++) {
          if (r === m.r1 && c === m.c1) continue;
          if (sheet.cells.has(cellKey(r, c))) this.hidden.push(`R${r}C${c}`);
          this.cover.set(cellKey(r, c), master);
        }
      }
    }
  }

  text(r: number, c: number): string {
    const k = cellKey(r, c);
    const v = this.cover.get(k) ?? this.sheet.cells.get(k)?.text ?? '';
    return v.replace(/\s+/g, ' ').trim();
  }

  raw(r: number, c: number): Cell | undefined {
    const k = cellKey(r, c);
    return this.cover.has(k) ? undefined : this.sheet.cells.get(k);
  }

  mergeAt(r: number, c: number): Range | undefined {
    return this.sheet.merges.find((m) => r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2);
  }

  row(r: number): readonly Cell[] {
    return this.rows.get(r) ?? [];
  }
}

function parseTime(cell: Cell | undefined, text: string): number | null {
  if (cell && cell.type === 'n') {
    const v = Number(cell.text);
    if (Number.isFinite(v) && v > 0 && v < 1) return Math.round(v * 1440);
  }
  const m = /^(\d{1,2})[:.](\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : h * 60 + min;
}

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

interface Part {
  prefix: string | null;
  text: string;
}

function splitPrefixed(text: string, codes: readonly string[]): Part[] {
  const re = new RegExp(`(?:^|\\s)(${codes.join('|')})\\s*:\\s*`, 'g');
  const hits: { at: number; end: number; code: string }[] = [];
  for (let m = re.exec(text); m; m = re.exec(text)) hits.push({ at: m.index, end: re.lastIndex, code: m[1] ?? '' });
  if (hits.length === 0) return text ? [{ prefix: null, text }] : [];
  const out: Part[] = [];
  const lead = text.slice(0, hits[0]?.at ?? 0).trim();
  if (lead) out.push({ prefix: null, text: lead });
  hits.forEach((h, i) => {
    const body = text.slice(h.end, hits[i + 1]?.at ?? text.length).trim();
    if (body) out.push({ prefix: h.code, text: body });
  });
  return out;
}

function splitRooms(text: string): string[] {
  return text
    .split(/\s*[/+,;]\s*/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

const HONORIFIC = /^(prof\.?\s*(?:ssa)?\.?|ing\.|dott\.?\s*(?:ssa)?\.?)\s+/i;

function teacherName(piece: string): string | null {
  if (!HONORIFIC.test(piece)) return null;
  const name = titleCase(piece.replace(HONORIFIC, '').replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
  return name.length >= 3 && name.length <= 121 ? name : null;
}

// Legend lines "TITLE - 9 CFU - Prof. Name": only teacher names are taken from it.
function legendTeachers(lines: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of lines) {
    const pieces = line.split(/\s+-\s+/).map((s) => s.trim());
    const first = pieces[0];
    if (!first || pieces.length < 2) continue;
    const teachers: string[] = [];
    for (const piece of pieces.slice(1)) {
      const name = teacherName(piece);
      if (name && !teachers.includes(name) && teachers.length < MAX_TEACHERS) teachers.push(name);
    }
    map.set(norm(first), teachers);
    const module = pieces.find((s) => /^MODULO\s+/i.test(s));
    if (module) map.set(norm(module.replace(/^MODULO\s+/i, '')), teachers);
  }
  return map;
}

function teachersFor(title: string, legend: ReadonlyMap<string, string[]>): string[] {
  const t = norm(title);
  const exact = legend.get(t);
  if (exact) return exact;
  for (const [k, v] of legend) {
    if (Math.min(k.length, t.length) >= 12 && (k.startsWith(t) || t.startsWith(k))) return v;
  }
  return [];
}

interface Pair {
  title: Part;
  rooms: Part[];
}

// Title and room parts of one cell pair, matched by curriculum prefix (spec 5.5).
function pairParts(titles: Part[], rooms: Part[], where: string, warnings: Finding[]): Pair[] {
  const pairs: Pair[] = [];
  const used = new Set<Part>();
  const unmatched: Part[] = [];
  const shared = rooms.length === 1 && rooms[0]?.prefix === null ? rooms[0] : null;
  for (const t of titles) {
    if (shared) {
      pairs.push({ title: t, rooms: [shared] });
      used.add(shared);
      continue;
    }
    const same = rooms.filter((p) => p.prefix !== null && p.prefix === t.prefix);
    if (same.length > 0) {
      pairs.push({ title: t, rooms: same });
      same.forEach((p) => used.add(p));
    } else unmatched.push(t);
  }
  const left = rooms.filter((p) => !used.has(p));
  if (unmatched.length > 0) {
    if (left.length === 0) warnings.push({ code: 'no_room', where });
    else {
      // Better one room marked busy too many than one marked free by mistake.
      warnings.push({ code: unmatched.length === 1 && left.length === 1 ? 'prefix_mismatch' : 'ambiguous_rooms', where });
      for (const t of unmatched) pairs.push({ title: t, rooms: left });
      left.forEach((p) => used.add(p));
    }
  }
  for (const p of rooms) {
    if (used.has(p)) continue;
    warnings.push({ code: 'room_without_title', where });
    pairs.push({ title: { prefix: p.prefix, text: 'Lezione' }, rooms: [p] });
  }
  return pairs;
}

function parseGrid(sheet: Sheet, spec: DiamSheet, config: DiamConfig): { template: Template; warnings: Finding[] } {
  const v = new View(sheet);
  const warnings: Finding[] = v.hidden.map((where) => ({ code: 'hidden_value', where }));

  let header = 0;
  for (let r = 1; r <= 12 && header === 0; r++) if (norm(v.text(r, 1)) === 'ORARIO') header = r;
  if (header === 0) throw new XlsxError('no_header');
  HEADER.forEach((want, i) => {
    if (norm(v.text(header, i + 1)).replace(/'$/, '') !== want) throw new XlsxError('bad_header');
  });

  // Rows above the header: course, academic year, "N° anno - I semestre", curricula.
  let course = '';
  let academicYear = '';
  let year = 0;
  let semester: 0 | 1 | 2 = 0;
  const codes = new Set(BASE_CODES);
  for (let r = 1; r < header; r++) {
    for (const c of v.row(r)) if (c.col !== 1 && !v.mergeAt(r, c.col)) throw new XlsxError('unexpected_cell');
    const t = norm(v.text(r, 1));
    if (!t) continue;
    let m: RegExpExecArray | null;
    if ((m = /^CORSO DI LAUREA (?:MAGISTRALE )?IN (.+)$/.exec(t))) course = m[1] ?? '';
    else if ((m = /^A\.A\. (\d{4})-(\d{4})$/.exec(t))) academicYear = `${m[1]}-${m[2]}`;
    else if ((m = /^(\d)\u00b0 ANNO - (I|II) SEMESTRE$/.exec(t))) {
      year = Number(m[1]);
      semester = m[2] === 'I' ? 1 : 2;
    } else if (/^INDIRIZZI\b/.test(t)) {
      for (const k of t.matchAll(/\b([A-Z]{2,6})\s*\(/g)) if (k[1]) codes.add(k[1]);
    } else if ((m = /^([A-Z]{2,6}) - \S/.exec(t))) {
      if (m[1]) codes.add(m[1]);
    } else throw new XlsxError('unexpected_title_row');
  }
  if (course !== spec.course) throw new XlsxError('course_mismatch');
  if (academicYear !== config.academicYear) throw new XlsxError('academic_year_mismatch');
  if (semester === 0) throw new XlsxError('no_semester');
  if (year !== spec.year) throw new XlsxError('year_mismatch');

  // Time rows: strictly increasing, 07:00 to 21:00, 6 to 16 rows.
  const rows: { r: number; start: number }[] = [];
  for (let r = header + 1; r <= header + 17; r++) {
    const t = parseTime(v.raw(r, 1), v.text(r, 1));
    if (t === null) break;
    const last = rows[rows.length - 1];
    if (t < 420 || t > 1260 || (last && t <= last.start)) throw new XlsxError('bad_times');
    rows.push({ r, start: t });
  }
  if (rows.length < 6 || rows.length > 16) throw new XlsxError('bad_times');
  const lastRow = rows[rows.length - 1]?.r ?? header;
  for (let r = header; r <= lastRow; r++) {
    if (v.row(r).some((c) => c.col > 13)) throw new XlsxError('unexpected_column');
  }

  // A time below the grid, or lesson cells right below its last row, mean a broken grid: never drop those lessons.
  if (v.row(lastRow + 1).some((c) => c.col > 1 && c.col <= 13 && v.raw(c.row, c.col))) throw new XlsxError('bad_times');
  const legendLines: string[] = [];
  for (let r = lastRow + 1; r <= v.maxRow; r++) {
    if (parseTime(v.raw(r, 1), v.text(r, 1)) !== null) throw new XlsxError('bad_times');
    const t = v.text(r, 1);
    if (t) legendLines.push(t);
    for (const c of v.row(r)) if (c.col !== 1) warnings.push({ code: 'legend_extra', where: `R${r}C${c.col}` });
  }
  const legend = legendTeachers(legendLines);
  const codeList = [...codes].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));

  const raw: TemplateLesson[] = [];
  let pairsSeen = 0;
  let pairsUnknown = 0;
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    const slotEnd = Math.min(next ? next.start : row.start + 60, row.start + 60);
    for (let d = 0; d < DAYS.length; d++) {
      const tc = 2 + 2 * d;
      const titleText = v.text(row.r, tc);
      const roomText = v.text(row.r, tc + 1);
      if (!titleText && !roomText) continue;
      const pause = /\bPAUSA\b/.test(norm(titleText));
      for (const m of [v.mergeAt(row.r, tc), v.mergeAt(row.r, tc + 1)]) {
        if (m && m.c2 > m.c1 && !pause) throw new XlsxError('grid_merge');
      }
      if (pause) continue;
      if (titleText.length > MAX_GRID_TEXT || roomText.length > MAX_GRID_TEXT) throw new XlsxError('cell_too_long');

      const where = `R${row.r}C${tc}`;
      const pairs = pairParts(splitPrefixed(titleText, codeList), splitPrefixed(roomText, codeList), where, warnings);
      for (const pair of pairs) {
        let start = row.start;
        let end = slotEnd;
        for (const n of pair.title.text.matchAll(NOTE_TIME)) {
          const t = Number(n[1]) * 60 + Number(n[2]);
          if (t < 420 || t > 1260) continue;
          start = Math.min(start, t);
          end = Math.max(end, t);
          warnings.push({ code: 'time_note', where });
        }
        const title = pair.title.text.replace(NOTE_TIME, ' ').replace(/\s+/g, ' ').trim();
        if (!title) continue;
        const aliases = [...new Set(pair.rooms.flatMap((p) => splitRooms(p.text)).map(roomAlias))].filter((k) => k.length > 0).sort();
        if (aliases.length === 0) continue;
        pairsSeen += 1;
        const known = aliases.filter((a): a is RoomAlias => config.rooms.has(a as RoomAlias));
        if (known.length < aliases.length) {
          pairsUnknown += 1;
          warnings.push({ code: 'unknown_room', where });
        }
        if (known.length === 0) continue;
        raw.push({ day: d, startMin: start, endMin: end, title, rooms: known, teachers: teachersFor(title, legend) });
      }
    }
  });
  if (pairsSeen > 0 && pairsUnknown / pairsSeen > UNKNOWN_SHARE) throw new XlsxError('unknown_rooms');

  // Back to back slots of the same lesson in the same rooms become one lesson.
  const groups = new Map<string, TemplateLesson[]>();
  for (const l of raw) {
    const g = `${l.day}|${norm(l.title)}|${l.rooms.join(',')}`;
    const list = groups.get(g);
    if (list) list.push(l);
    else groups.set(g, [l]);
  }
  const lessons: TemplateLesson[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => a.startMin - b.startMin);
    let cur: TemplateLesson | null = null;
    for (const l of list) {
      if (cur && l.startMin <= cur.endMin) cur.endMin = Math.max(cur.endMin, l.endMin);
      else {
        if (cur) lessons.push(cur);
        cur = { ...l };
      }
    }
    if (cur) lessons.push(cur);
  }
  lessons.sort((a, b) => a.day - b.day || a.startMin - b.startMin || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return { template: { semester, lessons }, warnings };
}

// Consistency of the rooms sheet with the configured table: warnings only, never blocking.
function checkRoomsSheet(sheet: Sheet, config: DiamConfig): Finding[] {
  const v = new View(sheet);
  if ([1, 2, 3, 4, 5].map((c) => norm(v.text(1, c))).join('|') !== 'DIP.|AULA|CUBO|PIANO|POSTI') {
    return [{ code: 'rooms_sheet_invalid', where: 'R1' }];
  }
  const rows = new Map<string, { cube: string; seats: number | null; r: number }>();
  for (let r = 2; r <= v.maxRow; r++) {
    const name = v.text(r, 2);
    if (!name) continue;
    const cube = norm(v.text(r, 3)).replace(/\s+/g, '');
    if (!/^\d{1,2}[A-Z]{1,3}$/.test(cube)) return [{ code: 'rooms_sheet_invalid', where: `R${r}C3` }];
    const seats = v.text(r, 5);
    rows.set(roomAlias(name), { cube, seats: /^\d{1,4}$/.test(seats) ? Number(seats) : null, r });
  }
  if (rows.size < 1 || rows.size > 60) return [{ code: 'rooms_sheet_invalid', where: '' }];
  const out: Finding[] = [];
  for (const room of config.rooms.values()) {
    const row = rows.get(room.alias);
    if (!row) out.push({ code: 'room_table_drift', where: '' });
    else if (buildingKey(`Cubo ${row.cube}`) !== buildingKey(room.building) || row.seats !== room.capacity) {
      out.push({ code: 'room_table_drift', where: `R${row.r}C2` });
    }
  }
  return out;
}

export function parseWorkbook(file: DiamFileKind, sheets: readonly Sheet[], config: DiamConfig): ParsedWorkbook {
  const expected = config.sheets.filter((s) => s.file === file);
  const byKey = new Map(expected.map((s) => [s.key, s]));
  const seen = new Set<string>();
  const plan = sheets.map((sheet) => {
    const role = sheetRole(file, sheet.name);
    if (!role) throw new XlsxError('unexpected_sheet');
    const key = `${file}|${sheetKey(sheet.name)}`;
    if (seen.has(key)) throw new XlsxError('duplicate_sheet');
    seen.add(key);
    if (role.kind === 'rooms') return { sheet, spec: null };
    const spec = byKey.get(key);
    if (!spec) throw new XlsxError('unexpected_sheet');
    return { sheet, spec };
  });

  const out = new Map<string, SheetOutcome>();
  const warnings: Finding[] = [];
  for (const { sheet, spec } of plan) {
    if (!spec) {
      if (sheet.state === 'visible') warnings.push(...checkRoomsSheet(sheet, config));
      continue;
    }
    if (sheet.state !== 'visible') {
      out.set(spec.ref, { failure: 'hidden_sheet' });
      continue;
    }
    try {
      out.set(spec.ref, parseGrid(sheet, spec, config));
    } catch (err) {
      if (!(err instanceof XlsxError)) throw err;
      out.set(spec.ref, { failure: err.code });
    }
  }
  for (const spec of expected) if (!out.has(spec.ref)) out.set(spec.ref, { failure: 'sheet_missing' });

  const semesters = new Set<1 | 2>();
  for (const o of out.values()) if ('template' in o) semesters.add(o.template.semester);
  if (semesters.size > 1) throw new XlsxError('mixed_semester');
  return { sheets: out, semester: [...semesters][0] ?? null, warnings };
}
