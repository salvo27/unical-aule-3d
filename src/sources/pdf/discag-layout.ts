// DISCAG timetable PDF to a weekly template: one row per teaching, one ORARIO/AULA column pair per day.
// Only the teaching column and the ORARIO/AULA columns are read: the credits, hours and teacher columns never are.
// Fail closed: a changed layout refuses the file, a cell that cannot be placed fails it.
import { addDays } from '../../availability/time.js';
import type { IsoDay } from '../../domain/primitives.js';
import { PdfError, type CellCode, type Finding } from './codes.js';
import type { CalendarConfig, PdfRoom, WeeklyEntry } from './expand.js';
import { bandsOf, cellsOf, lines, textOf, type Band, type Cell, type Page, type Word } from './grid.js';
import { compact, DAY_NAMES, editDistance, italianDay, norm, weekday } from './text.js';
import { parseRooms, parseTimes, type RoomPattern } from './validators.js';

export interface DiscagLayoutFeed {
  ref: string;
  course: string;
  // Course codes of the file and the years each may show.
  codes: ReadonlyMap<string, readonly number[]>;
}

export interface Quirk {
  sha256: string;
  page: number;
  code: 'academic_year_mismatch';
}

export interface DiscagLayoutConfig {
  calendar: CalendarConfig;
  rooms: readonly RoomPattern<PdfRoom>[];
  quirks: readonly Quirk[];
}

export interface DiscagExtract {
  entries: WeeklyEntry[];
  warnings: Finding[];
  unplaced: Finding[];
  updated: IsoDay | null;
  tables: number;
}

const COL_TOL = 3;
const MAX_TITLE = 300;
const MAX_CELL = 200;
export const MAX_ENTRIES = 500;
const HEAD_OK = /^(CFU|CREDITI|CRED|ORE|DOCENTE|DOCENTI|)$/;
const TEACH_HEAD = /^INSEGNAMENT[IO]$/;
const ORDINAL: Readonly<Record<string, number>> = { PRIMO: 1, SECONDO: 2, TERZO: 3, QUARTO: 4, QUINTO: 5 };
const SEMESTER_WORD = { 1: 'PRIMO', 2: 'SECONDO' } as const;
// A title band may name course, code, year, period and curriculum, nothing that looks like schedule data.
const TITLE_FORBIDDEN =
  /SOSPES|RINVI|ANNULL|SPOSTA|INIZIO|RECUPER|\bCUBO\b|\bCONS\b|ZENIT|\bPMI\b|SDIPA|OA\/SG|LUNEDI|MARTEDI|MERCOLEDI|GIOVEDI|VENERDI|SABATO|\d{1,2}[.:]\d{2}|\b\d{1,2} ?[-/] ?\d{1,2}\b/;
const NOTE_KEYWORDS =
  /AULA|CUBO|CONS|ZENIT|OA\/?SG|PMI|\bEP\b|SDIPA|LEZION|ORARI|SOSPES|RINVI|ANNULL|SPOSTA|INIZIO|RECUPER|LUNEDI|MARTEDI|MERCOLEDI|GIOVEDI|VENERDI|SABATO|\d/;
const CONSOLIDATE = compact(
  "Le aule di lezione sono grandi aule sospese (consolidate) che prendono il nome dall'edificio (cubo) in cui sono ubicate",
);
const PERIOD_WORDS = /\bDAL (\d{1,2}) ([A-Z]+) (\d{4}) AL (\d{1,2}) ([A-Z]+) (\d{4})/;
const PERIOD_DIGITS = /\bDAL (\d{2})\/(\d{2})\/(\d{4}) - (\d{2})\/(\d{2})\/(\d{4})/;
// Teacher names sometimes sit in the teaching cell between parentheses: dropped before anything is kept.
const TEACHER_NOTE = /\((?:\s*)(?:PROF|DOTT)[^)]*(?:\)|$)/gi;
// A person's title left after that means a name in the title: the cell fails, the name is never kept.
const PERSON = /\b(?:PROF|PROFSSA|PROFESSOR|PROFESSORE|PROFESSORESSA|DOTT|DOTTSSA|DOTTOR|DOTTORE|DOTTORESSA|DOCENTE|DOCENTI)\b/;

interface Pair {
  time: Cell;
  room: Cell;
  day: number;
}

interface Header {
  teach: Cell;
  teachMax: number;
  firstOrario: number;
  pairs: Pair[];
  trailing: Cell[];
  code: string;
  year: number;
}

interface TitleState {
  code: string | null;
  year: number | null;
  ayOk: boolean;
  semesterOk: boolean;
}

interface Raw {
  code: string;
  year: number;
  title: string;
  key: string;
  day: number;
  startMin: number;
  endMin: number;
  rooms: PdfRoom[];
  from: IsoDay | null;
  until: IsoDay | null;
  where: string;
}

interface StartNote {
  key: string;
  from: IsoDay;
  where: string;
}

function parseHeader(band: Band, at: string): Omit<Header, 'code' | 'year'> | null {
  const cells = cellsOf(band);
  const first = cells[0];
  if (!first || !TEACH_HEAD.test(compact(first.text))) return null;
  const labels = cells.map((c) => compact(c.text));
  if (!labels.includes('ORARIO')) return null;
  let i = 1;
  while (i < labels.length && labels[i] !== 'ORARIO') {
    if (!HEAD_OK.test(labels[i]!)) throw new PdfError('bad_header', at);
    i += 1;
  }
  const pairs: Pair[] = [];
  while (i + 1 < labels.length && labels[i] === 'ORARIO' && labels[i + 1] === 'AULA') {
    pairs.push({ time: cells[i]!, room: cells[i + 1]!, day: -1 });
    i += 2;
  }
  // Unlabeled trailing columns are kept, so that any data in them fails the file.
  const trailing = cells.slice(i);
  if (trailing.some((c) => compact(c.text) !== '')) throw new PdfError('bad_header', at);
  if (pairs.length < 5 || pairs.length > 6) throw new PdfError('bad_header', at);
  // A data row's teaching cell may be a little wider than the header's, never as wide as the next header column.
  const teachMax = labels[1] !== 'ORARIO' ? cells[1]!.right - COL_TOL : pairs[0]!.time.left + COL_TOL;
  return { teach: first, teachMax, firstOrario: pairs[0]!.time.left, pairs, trailing };
}

// Gives each ORARIO/AULA pair the day above it; returns the text left of the days (group or curriculum).
function attachDays(header: Omit<Header, 'code' | 'year'>, dayBand: Band | null, at: string): string {
  if (!dayBand) throw new PdfError('day_headers', at);
  const cells = cellsOf(dayBand);
  const isDay = (c: Cell) => (DAY_NAMES as readonly string[]).includes(compact(c.text));
  const dayCells = cells.filter(isDay);
  if (dayCells.length < 5) throw new PdfError('day_headers', at);
  header.pairs.forEach((p, k) => {
    const cover = cells.filter((c) => c.left <= p.time.left + COL_TOL && c.right >= p.room.right - COL_TOL);
    if (cover.length !== 1) throw new PdfError('day_headers', at);
    if (compact(cover[0]!.text) !== DAY_NAMES[k]) throw new PdfError('day_order', at);
    p.day = k;
  });
  // A day over unlabeled columns (SABATO without ORARIO/AULA) is allowed only if those columns stay empty.
  for (const c of dayCells) {
    const k = (DAY_NAMES as readonly string[]).indexOf(compact(c.text));
    if (k < header.pairs.length) continue;
    if (!header.trailing.some((t) => t.left >= c.left - COL_TOL && t.right <= c.right + COL_TOL)) throw new PdfError('day_headers', at);
  }
  const group = cells.find((c) => c.right <= header.firstOrario + COL_TOL && c.left < header.teach.right);
  return group ? group.text : '';
}

function matchesHeader(band: Band, header: Header | null): header is Header {
  if (!header || band.vs.length < 4) return false;
  const has = (x: number) => band.vs.some((v) => Math.abs(v - x) <= COL_TOL);
  return header.pairs.every((p) => has(p.time.left) && has(p.room.right));
}

interface Row {
  teach: string | null;
  days: { day: number; time: string; room: string }[];
  trailing: string;
}

// Columns of a data band matched to the header: every day boundary must be there (no merged day cells).
function rowCells(band: Band, header: Header, at: string): Row {
  const has = (x: number) => band.vs.some((v) => Math.abs(v - x) <= COL_TOL);
  for (const p of header.pairs) {
    for (const x of [p.time.left, p.time.right, p.room.right]) if (!has(x)) throw new PdfError('column_rules', at);
  }
  for (const t of header.trailing) if (!has(t.right)) throw new PdfError('column_rules', at);
  const after = band.vs.filter((v) => v > header.firstOrario + COL_TOL).length;
  if (after !== header.pairs.length * 2 + header.trailing.length || band.vs.length < 2) throw new PdfError('column_rules', at);
  const lastRight = header.trailing.length > 0 ? header.trailing[header.trailing.length - 1]!.right : header.pairs[header.pairs.length - 1]!.room.right;
  if (band.words.some((w) => w.cx < band.vs[0]! || w.cx > lastRight)) throw new PdfError('stray_words', at);
  // A word centered on a cell boundary would be read by no cell: refused, never dropped.
  const edges = [...band.vs, ...header.pairs.flatMap((p) => [p.time.left, p.time.right, p.room.right]), ...header.trailing.map((t) => t.right)];
  if (band.words.some((w) => edges.some((x) => Math.abs(w.cx - x) < 0.5))) throw new PdfError('word_crosses_column', at);
  const text = (l: number, r: number) => textOf(band.words.filter((w: Word) => w.cx > l && w.cx < r));
  const teachRight = band.vs[1]!;
  return {
    // A teaching cell merged with the next columns is a label row ("Un insegnamento a scelta tra:"): never read.
    teach: teachRight <= header.teachMax ? text(band.vs[0]!, teachRight) : null,
    days: header.pairs.map((p) => ({ day: p.day, time: text(p.time.left, p.time.right), room: text(p.room.left, p.room.right) })),
    trailing: header.trailing.map((t) => text(t.left, t.right)).join(''),
  };
}

export function extractDiscag(pages: readonly Page[], feed: DiscagLayoutFeed, cfg: DiscagLayoutConfig, sha256: string): DiscagExtract {
  if (pages.every((p) => p.words.length === 0)) throw new PdfError('no_text_layer');
  const calendar = cfg.calendar;
  const semester = calendar.semesters[calendar.semester];
  const semesterWord = SEMESTER_WORD[calendar.semester];
  const otherWord = SEMESTER_WORD[calendar.semester === 1 ? 2 : 1];
  const accepted = new Set(cfg.quirks.filter((q) => q.sha256 === sha256).map((q) => `${q.page}:${q.code}`));
  const warnings: Finding[] = [];
  const unplaced: Finding[] = [];
  const raws: Raw[] = [];
  const startNotes: StartNote[] = [];
  let updated: IsoDay | null = null;
  let pendingFrom: IsoDay | null = null;
  const title: TitleState = { code: null, year: null, ayOk: false, semesterOk: false };
  let header: Header | null = null;
  let rowFrom: IsoDay | null = null;
  let tables = 0;

  const unplace = (code: CellCode, at: string): void => {
    unplaced.push({ code, where: at });
  };

  function titleBand(text: string, at: string): void {
    const t = norm(text);
    if (/CORSO DI LAUREA/.test(t)) {
      title.code = null;
      title.year = null;
    }
    const ay = /ANNO ACCADEMICO (\d{4}) ?- ?(\d{4})/.exec(t);
    if (ay) title.ayOk = `${ay[1]}-${ay[2]}` === calendar.academicYear;
    if (/ORARIO LEZIONI/.test(t)) {
      if (!ay) title.ayOk = false;
      if (t.includes(`${otherWord} SEMESTRE`) || !t.includes(`${semesterWord} SEMESTRE`)) throw new PdfError('wrong_semester', at);
      title.semesterOk = true;
    }
    for (const m of t.matchAll(/\((\d{4})\)/g)) {
      if (!feed.codes.has(m[1]!)) throw new PdfError('course_mismatch', at);
      title.code = m[1]!;
    }
    const yr = /\b(\d)\s*° ?ANNO\b/.exec(t) ?? /\b(PRIMO|SECONDO|TERZO|QUARTO|QUINTO) ANNO\b(?! ACCADEMICO)/.exec(t);
    if (yr) title.year = /^\d$/.test(yr[1]!) ? Number(yr[1]) : ORDINAL[yr[1]!]!;
    const per = PERIOD_WORDS.exec(t) ?? PERIOD_DIGITS.exec(t);
    if (per) {
      const from = italianDay(per[1]!, per[2]!, per[3]!);
      const to = italianDay(per[4]!, per[5]!, per[6]!);
      if (from !== semester.first || (to !== semester.last && to !== addDays(semester.last, -1))) warnings.push({ code: 'period_text_mismatch', where: at });
    }
    const rest = t
      .replace(/CORSO DI LAUREA[A-Z' ,.]*?\(\d{4}\)/g, ' ')
      .replace(/-? ?ORARIO LEZIONI (?:PRIMO|SECONDO) SEMESTRE ANNO ACCADEMICO \d{4} ?- ?\d{4}/g, ' ')
      .replace(new RegExp(PERIOD_WORDS.source, 'g'), ' ')
      .replace(new RegExp(PERIOD_DIGITS.source, 'g'), ' ')
      .replace(/\b(?:\d ?° ?|PRIMO |SECONDO |TERZO |QUARTO |QUINTO )ANNO\b/g, ' ')
      .replace(/\(AULA \d\)/g, ' ');
    if (TITLE_FORBIDDEN.test(rest)) throw new PdfError('unexpected_band', at);
  }

  function note(text: string, at: string): void {
    const t = norm(text);
    let m = /^(?:AGGIORNATO AL|ULTIMO AGGIORNAMENTO) (\d{1,2})-(\d{1,2})-(\d{2}|\d{4})$/.exec(t);
    if (m) {
      const d = italianDay(m[1]!, m[2]!, m[3]!);
      if (d && (!updated || d > updated)) updated = d;
      return;
    }
    if (compact(t) === CONSOLIDATE) return;
    m = /^A FAR DATA DAL (\d{1,2}) ([A-Z]+) (\d{4}) I SEGUENTI INSEGNAMENTI VERRANNO EROGATI SECONDO IL SEGUENTE ORARIO$/.exec(t);
    if (m) {
      const d = italianDay(m[1]!, m[2]!, m[3]!);
      // Outside the semester the old rows would end too early or the new ones never start.
      if (!d || d < semester.first || d > semester.last) throw new PdfError('unbound_note', at);
      pendingFrom = d;
      return;
    }
    // The parenthesis with the teacher's name is matched and dropped, never kept.
    m = /^IL CORSO DI (.+?)(?: \((?:PROF|DOTT)[^)]*\))? AVRA INIZIO (LUNEDI|MARTEDI|MERCOLEDI|GIOVEDI|VENERDI|SABATO) (\d{1,2}) ([A-Z]+) (\d{4})$/.exec(t);
    if (m) {
      const d = italianDay(m[3]!, m[4]!, m[5]!);
      if (!d || weekday(d) !== (DAY_NAMES as readonly string[]).indexOf(m[2]!)) throw new PdfError('unbound_note', at);
      startNotes.push({ key: compact(m[1]!), from: d, where: at });
      return;
    }
    if (t.split(' ').length <= 3 && !NOTE_KEYWORDS.test(t)) {
      warnings.push({ code: 'stray_text', where: at });
      return;
    }
    throw new PdfError('unbound_note', at);
  }

  function dataRow(band: Band, at: string, h: Header): void {
    if (pendingFrom) {
      rowFrom = pendingFrom;
      pendingFrom = null;
    }
    const row = rowCells(band, h, at);
    if (row.trailing) unplace('unlabeled_column', at);
    if (!row.days.some((d) => d.time || d.room)) return;
    if (row.teach === null) throw new PdfError('column_rules', at);
    const teach = row.teach.replace(TEACHER_NOTE, ' ').replace(/\s+/g, ' ').trim();
    if (!teach) return unplace('no_teaching', at);
    if (teach.length > MAX_TITLE) return unplace('cell_too_long', at);
    if (PERSON.test(norm(teach).replace(/[^A-Z0-9]+/g, ' '))) return unplace('person_in_title', at);
    const key = compact(teach);
    if (!key) return unplace('no_teaching', at);
    for (const d of row.days) {
      const w = `${at}d${d.day}`;
      if (!d.time && !d.room) continue;
      if (!d.time || !d.room) {
        unplace(d.time ? 'time_without_room' : 'room_without_time', w);
        continue;
      }
      if (d.time.length > MAX_CELL || d.room.length > MAX_CELL) {
        unplace('cell_too_long', w);
        continue;
      }
      const times = parseTimes(d.time);
      if (!times) {
        unplace('bad_time', w);
        continue;
      }
      const rooms = parseRooms(d.room, cfg.rooms);
      if ('error' in rooms) {
        unplace(rooms.error, w);
        continue;
      }
      for (const [s, e] of times) {
        raws.push({ code: h.code, year: h.year, title: teach, key, day: d.day, startMin: s, endMin: e, rooms: rooms.rooms, from: rowFrom, until: null, where: w });
      }
    }
    if (raws.length > MAX_ENTRIES) throw new PdfError('too_many_entries');
  }

  for (const [pi, page] of pages.entries()) {
    const p = pi + 1;
    const bands = bandsOf(page);
    const inTable = new Set<Word>();
    for (const band of bands) {
      if (band.vs.length < 2) continue;
      const left = band.vs[0]!;
      const right = band.vs[band.vs.length - 1]!;
      band.words = band.words.filter((w) => w.cx > left && w.cx < right);
      for (const w of band.words) inTable.add(w);
    }
    // Bands and free text lines in reading order, so a note applies to the table below it.
    const free = lines(page.words.filter((w) => !inTable.has(w)));
    const events = [
      ...bands.map((band, bi) => ({ y: band.top, band, at: `p${p}b${bi}` })),
      ...free.map((line, li) => ({ y: line.cy, text: line.text, at: `p${p}n${li}` })),
    ].sort((a, b) => a.y - b.y);
    let dayBand: Band | null = null;
    for (const ev of events) {
      if (!('band' in ev)) {
        note(ev.text, ev.at);
        continue;
      }
      const band = ev.band;
      if (band.vs.length < 2) continue;
      const h = parseHeader(band, ev.at);
      if (h) {
        const group = attachDays(h, dayBand, ev.at);
        if (group) titleBand(group, ev.at);
        if (!title.code || !title.year) throw new PdfError('page_header', ev.at);
        if (!feed.codes.get(title.code)?.includes(title.year)) throw new PdfError('year_mismatch', ev.at);
        if (!title.semesterOk) throw new PdfError('page_header', ev.at);
        if (!title.ayOk) {
          if (!accepted.has(`${p}:academic_year_mismatch`)) throw new PdfError('academic_year_mismatch', ev.at);
          warnings.push({ code: 'academic_year_mismatch_accepted', where: ev.at });
        }
        header = { ...h, code: title.code, year: title.year };
        rowFrom = null;
        tables += 1;
        dayBand = null;
        continue;
      }
      const cells = cellsOf(band);
      if (cells.filter((c) => (DAY_NAMES as readonly string[]).includes(compact(c.text))).length >= 5) {
        dayBand = band;
        continue;
      }
      if (matchesHeader(band, header)) {
        dataRow(band, ev.at, header);
        continue;
      }
      // Any other band with cells is title text (course, code, year, curriculum); it ends the current table.
      header = null;
      const text = cells.map((c) => c.text).join(' ').trim();
      if (!text || norm(text) === 'INSEGNAMENTI A SCELTA DELLO STUDENTE') continue;
      titleBand(text, ev.at);
    }
    if (pendingFrom) throw new PdfError('unbound_note', `p${p}`);
  }
  if (tables === 0) throw new PdfError('no_table');

  // "A far data dal" rows replace the earlier rows of the same teaching from that day.
  for (const e of raws.filter((x) => x.from)) {
    for (const o of raws) if (!o.from && o.key === e.key && o.code === e.code && o.year === e.year) o.until = addDays(e.from!, -1);
  }
  // "Il corso di X avra inizio ...": exactly one teaching must match, else the note is ignored and the
  // lessons stay, so the rooms stay busy (the safe side).
  const keys = [...new Set(raws.map((e) => e.key))];
  for (const n of startNotes) {
    // A start after the semester would remove every lesson of the teaching.
    if (n.from > semester.last) {
      warnings.push({ code: 'start_note_unbound', where: n.where });
      continue;
    }
    let hits = keys.filter((k) => k === n.key || k.startsWith(n.key) || n.key.startsWith(k));
    if (hits.length === 0) hits = keys.filter((k) => editDistance(k, n.key) <= 2);
    if (hits.length !== 1) {
      warnings.push({ code: 'start_note_unbound', where: n.where });
      continue;
    }
    if (hits[0] !== n.key) warnings.push({ code: 'start_note_fuzzy', where: n.where });
    for (const e of raws) if (e.key === hits[0] && (!e.from || e.from < n.from)) e.from = n.from;
  }
  const roomsKey = (e: Raw) => e.rooms.map((r) => r.syntheticId).sort().join(',');
  const slot = (e: Raw) => [e.code, e.year, e.day, e.startMin, e.endMin, roomsKey(e), e.from, e.until].join('|');
  // The same lesson on several curriculum pages: one entry.
  const seen = new Map<string, Raw>();
  for (const e of raws) {
    const k = `${slot(e)}|${e.key}`;
    if (!seen.has(k)) seen.set(k, e);
  }
  // The same lesson under a shorter and a longer title on two curriculum pages (shared teaching): the longer stays.
  const weekly: Raw[] = [];
  for (const e of [...seen.values()].sort((a, b) => b.key.length - a.key.length)) {
    const twin = weekly.find((o) => slot(o) === slot(e) && o.key.startsWith(e.key));
    if (twin) warnings.push({ code: 'shared_title_merged', where: `${twin.where}/${e.where}` });
    else weekly.push(e);
  }
  // Two teachings in the same room at the same time: both kept (the room is busy either way), reported.
  for (const a of weekly) {
    for (const b of weekly) {
      if (a === b || a.key >= b.key || a.day !== b.day || !(a.startMin < b.endMin && b.startMin < a.endMin)) continue;
      if (!a.rooms.some((r) => b.rooms.includes(r))) continue;
      if ((a.until && b.from && a.until < b.from) || (b.until && a.from && b.until < a.from)) continue;
      warnings.push({ code: 'room_conflict', where: `${a.where}/${b.where}` });
    }
  }
  const entries: WeeklyEntry[] = weekly.map((e) => ({
    day: e.day,
    startMin: e.startMin,
    endMin: e.endMin,
    title: e.title,
    courses: [feed.course],
    year: e.year,
    rooms: e.rooms,
    from: e.from,
    until: e.until,
    keyHead: [feed.ref, String(e.year)],
    keyTail: [String(e.startMin), String(e.endMin), e.key, roomsKey(e)],
  }));
  return { entries, warnings, unplaced, updated, tables };
}
