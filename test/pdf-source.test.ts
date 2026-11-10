import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfAdapter, type PdfAdapterOptions } from '../src/sources/pdf.js';
import { createAdapters } from '../src/sources/registry.js';
import { SourceError, type Feed, type FetchContext, type SourceData } from '../src/sources/types.js';
import { anchorsOf } from '../src/sources/pdf/client.js';
import { PdfError, sourceFailure, where, type PdfCode } from '../src/sources/pdf/codes.js';
import { loadPdfConfig, parsePdfConfig, PdfConfigError } from '../src/sources/pdf/config.js';
import { discagProfile, findAttachments, parseDiscagConfig, type DiscagConfig, type DiscagFeed } from '../src/sources/pdf/discag.js';
import { extractDiscag, type DiscagExtract } from '../src/sources/pdf/discag-layout.js';
import { disuProfile, findFiles, findNews, parseDisuConfig, type DisuConfig, type DisuFeed } from '../src/sources/pdf/disu.js';
import { disuRules, disuTemplate, readDisuFile, type Candidate, type DisuFile, type DisuTemplate } from '../src/sources/pdf/disu-layout.js';
import { expandTemplate, type CalendarConfig, type PdfRoom, type WeeklyEntry } from '../src/sources/pdf/expand.js';
import { parseBbox, rectRules, type HRule, type Page, type VRule, type Word } from '../src/sources/pdf/grid.js';
import { MAX_PDF_BYTES, popplerBin, readPdf, type ReadPdfOptions } from '../src/sources/pdf/poppler.js';
import { PROFILES } from '../src/sources/pdf/profiles.js';
import { compact } from '../src/sources/pdf/text.js';
import { parseRooms, parseTimes } from '../src/sources/pdf/validators.js';
import { addedAtOf, checkBuildings, renderPdfFeeds } from '../scripts/gen-pdf-feeds-sql.js';
import { feedId, roomMatchKey, syntheticLessonId, syntheticRoomId } from '../src/domain/ids.js';
import { isoDay, plannerId, sourceUrl, type IsoDay } from '../src/domain/primitives.js';
import { romeMidnight } from '../src/availability/time.js';
import { buildPayload } from '../src/sync/payload.js';
import { loadCampus } from '../src/campus.js';
import { USER_AGENT } from '../src/user-agent.js';
import type { LogFields, Logger } from '../src/log.js';

const ROOT = new URL('../../', import.meta.url);

// Invented section in the shape of config/pdf.json "discag"; course codes and labels do not exist.
const RAW = {
  pageUrl: 'https://discag.unical.it/contents/news/view/9999-orario-di-prova/',
  pageTitle: 'Orario di prova del 1°semestre a.a. 2026/27',
  academicYear: '2026-2027',
  semester: 1,
  semesters: { '1': { first: '2026-09-21', last: '2026-12-19' }, '2': { first: '2027-02-22', last: '2027-06-05' } },
  closedDays: ['2026-11-01', '2026-12-08', '2026-12-21'],
  feeds: [
    {
      ref: 'discag:0999',
      anchor: 'LTPR',
      codes: { '0999': [1, 2], '0998': [3] },
      course: 'STUDI DI PROVA',
      class: 'L-18 R',
      label: 'DISCAG · Orario Studi di Prova (L) 2026/2027 1S (PDF)',
    },
    {
      ref: 'discag:0997',
      anchor: 'LMPR - PROVA',
      codes: { '0997': [1, 2] },
      course: 'PROVA MAGISTRALE',
      class: 'LM-77 R',
      label: 'DISCAG · Orario Prova Magistrale (LM) 2026/2027 1S (PDF)',
    },
  ],
  rooms: [
    { pattern: 'CONS2B', name: 'CONSOLIDATA 2B', building: 'Cubo 2B', cubes: ['2B'] },
    { pattern: 'OASG1', name: 'OA/SG1', building: 'Cubo 3A', cubes: ['3A'] },
    { pattern: 'AULA1(?=CUBO11)', name: 'Aula 1', building: 'Cubo 11D', cubes: ['11D', '11CD'] },
    { pattern: 'LABGEOC?', name: 'Laboratorio di Geografia', building: 'Cubo 28D', cubes: ['28D'], bareCube: true },
    { pattern: 'AULAH3(?=POLIFUNZIONALE)', name: 'H3', building: 'Polifunzionale', cubes: [] },
  ],
  acceptedQuirks: [] as unknown[],
};
const CFG: DiscagConfig = parseDiscagConfig(RAW);
const [FEED, FEED2] = CFG.feeds as [DiscagFeed, DiscagFeed];
const LAYOUT = { calendar: CFG.calendar, rooms: CFG.rooms, quirks: CFG.quirks };
const SHA = 'a'.repeat(64);
const day = (d: string): IsoDay => isoDay(d);

// Invented section in the shape of config/pdf.json "disu": courses, teachings and people do not exist.
const DISU_RAW = {
  indexUrl: 'https://disu.unical.it/didattica/offerta-formativa/orario-lezioni/',
  newsTitle: 'Orario I semestre - a.a. 2026/2027 - DISU',
  newsSlug: 'orario-i-semestre-aa-20262027-disu',
  filePrefix: 'Orario_2026_2027_I_semestre_',
  academicYear: '2026-2027',
  semester: 1,
  semesters: { '1': { first: '2026-09-21', last: '2027-01-16' }, '2': { first: '2027-02-22', last: '2027-06-05' } },
  closedDays: ['2026-11-01', '2026-12-08', '2026-12-21', '2026-12-22'],
  suspensions: [
    { first: '2026-12-11', last: '2026-12-19', level: 'LT', years: [2, 3] },
    { first: '2026-12-11', last: '2026-12-19', level: 'LM', years: [2] },
  ],
  feeds: [
    {
      ref: 'disu:prova-l1',
      stem: 'PROVA_L1',
      level: 'LT',
      duration: 3,
      header: 'CORSO DI LAUREA IN STUDI DI PROVA - CLASSE L-1',
      course: 'STUDI DI PROVA (L-1)',
      grids: ['1', '2'],
      label: 'DiSU · Orario Studi di Prova L-1 2026/2027 1S (PDF)',
    },
    {
      ref: 'disu:prova-lm',
      stem: 'PROVA_LM',
      level: 'LM',
      duration: 2,
      header: 'CORSO DI LAUREA MAGISTRALE IN PROVE MODERNE',
      course: 'PROVE MODERNE',
      grids: ['1|CURRICULUM A', '2|CURRICULUM B'],
      label: 'DiSU · Orario Prove Moderne 2026/2027 1S (PDF)',
    },
  ],
  rooms: [
    { aliases: ['STORIA1', 'BURGARELLA'], name: 'Stor 1', building: 'Cubo 28C' },
    { aliases: ['STORIA2A'], name: 'Stor 2A', building: 'Cubo 28C' },
    { aliases: ['CSDIM'], name: 'Aula Informatica CSDIM', building: 'Cubo 28A' },
    { aliases: ['N'], name: 'Aula N', building: 'Cubo 18C' },
    { aliases: ['DIONISO'], name: 'Aula Dioniso', building: 'Cubo 17B' },
    { aliases: ['IANA'], name: 'Aula Iana', building: 'Cubo 19B' },
  ],
};
const DCFG: DisuConfig = parseDisuConfig(DISU_RAW);
const [DF1, DF2] = DCFG.feeds as [DisuFeed, DisuFeed];

// ---------- page fixtures: synthetic pdftotext bbox XML and pdftocairo SVG strings ----------

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: string;
}
type Rect = [number, number, number, number];
interface Sheet {
  words: Box[];
  rects: Rect[];
}
type Cells = ([string, string] | null)[];
type RowSpec =
  | { title: string }
  | { days: string[]; group?: string }
  | { header: string[] }
  | { teach: string; teacher?: string; cfu?: string; cells: Cells; dropV?: number[]; extraV?: number[] }
  | { label: string; cells?: Cells }
  | { gap: number; note?: string };

const X0 = 57;
const DOC = 335;
const ROW_H = 28;
const DAYS5 = ['LUNEDI', 'MARTEDI', 'MERCOLEDI', 'GIOVEDI', 'VENERDI'];
const PAIRS = (n: number) => Array.from({ length: n }, () => ['ORARIO', 'AULA']).flat();
const HEAD5 = ['INSEGNAMENTI', 'CFU', 'Ore', 'Docente', ...PAIRS(5)];
const TITLE = 'CORSO DI LAUREA IN STUDI DI PROVA (0999) - ORARIO LEZIONI PRIMO SEMESTRE ANNO ACCADEMICO 2026– 2027';

function geometry(cols: number) {
  const w = cols === 6 ? 75 : 90;
  const split = cols === 6 ? 30 : 38;
  const pairs = Array.from({ length: cols }, (_, k) => [DOC + k * w, DOC + k * w + split, DOC + (k + 1) * w] as const);
  return { right: DOC + cols * w, pairs, all: [X0, 180, 212, 233, DOC, ...pairs.flatMap((p) => [p[1], p[2]])] };
}

function place(out: Box[], text: string, left: number, right: number, cy0: number): void {
  const rows = text.split('\n');
  rows.forEach((line, i) => {
    const cy = cy0 + (i - (rows.length - 1) / 2) * 10;
    let x = left + 2;
    for (const t of line.split(' ').filter(Boolean)) {
      const w = 4.5 * t.length;
      if (x + w > right - 0.5) throw new Error(`fixture text too wide: ${line}`);
      out.push({ x0: x, y0: cy - 4.5, x1: x + w, y1: cy + 4.5, t });
      x += w + 2.5;
    }
  });
}

function sheet(rows: RowSpec[], opts: { cols?: number; top?: number; extra?: Box[] } = {}): Sheet {
  const g = geometry(opts.cols ?? 5);
  const words: Box[] = [...(opts.extra ?? [])];
  const rects: Rect[] = [];
  let y = opts.top ?? 40;
  for (const row of rows) {
    if ('gap' in row) {
      if (row.note) place(words, row.note, 60, 800, y + row.gap / 2);
      y += row.gap;
      continue;
    }
    const top = y;
    const bottom = y + ROW_H;
    const cy = top + ROW_H / 2;
    let vs: number[];
    const cells: [number, number, string][] = [];
    if ('title' in row) {
      vs = [X0, g.right];
      cells.push([X0, g.right, row.title]);
    } else if ('days' in row) {
      vs = [X0, DOC, ...g.pairs.map((p) => p[2])];
      if (row.group) cells.push([X0, DOC, row.group]);
      row.days.forEach((d, k) => cells.push([g.pairs[k]![0], g.pairs[k]![2], d]));
    } else if ('header' in row) {
      vs = g.all;
      row.header.forEach((label, k) => cells.push([vs[k]!, vs[k + 1]!, label]));
    } else if ('label' in row) {
      vs = [X0, DOC, ...g.pairs.flatMap((p) => [p[1], p[2]])];
      cells.push([X0, DOC, row.label]);
      (row.cells ?? []).forEach((c, k) => {
        const p = g.pairs[k]!;
        if (c?.[0]) cells.push([p[0], p[1], c[0]]);
        if (c?.[1]) cells.push([p[1], p[2], c[1]]);
      });
    } else {
      vs = g.all.filter((x) => !(row.dropV ?? []).includes(x)).concat(row.extraV ?? []);
      cells.push([X0, 180, row.teach]);
      if (row.cfu) cells.push([180, 212, row.cfu]);
      if (row.teacher) cells.push([233, DOC, row.teacher]);
      row.cells.forEach((c, k) => {
        const p = g.pairs[k]!;
        if (c?.[0]) cells.push([p[0], p[1], c[0]]);
        if (c?.[1]) cells.push([p[1], p[2], c[1]]);
      });
    }
    for (const [l, r, text] of cells) place(words, text, l, r, cy);
    rects.push([X0, top - 0.24, g.right, top + 0.24], [X0, bottom - 0.24, g.right, bottom + 0.24]);
    for (const x of vs) rects.push([x - 0.24, top, x + 0.24, bottom]);
    y = bottom;
  }
  return { words, rects };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function bboxXml(sheets: Sheet[]): string {
  const pages = sheets.map(
    (s) =>
      '<page width="841.920000" height="595.320000"><flow><block><line>' +
      s.words.map((w) => `<word xMin="${w.x0.toFixed(6)}" yMin="${w.y0.toFixed(6)}" xMax="${w.x1.toFixed(6)}" yMax="${w.y1.toFixed(6)}">${esc(w.t)}</word>`).join('\n') +
      '</line></block></flow></page>',
  );
  // The head carries the file metadata, which may name people: it is never read.
  return `<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title></title><meta name="Author" content="Mario Rossi"/></head><body><doc>${pages.join('\n')}</doc></body></html>`;
}

function svgOf(s: Sheet): string {
  const paths = s.rects.map(
    ([x0, y0, x1, y1]) => `<path fill-rule="evenodd" fill="rgb(0%, 0%, 0%)" fill-opacity="1" d="M ${x0} ${y1} L ${x1} ${y1} L ${x1} ${y0} L ${x0} ${y0} Z M ${x0} ${y1} "/>`,
  );
  return `<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg" width="841.92pt" height="595.32pt"><defs><g><symbol id="glyph-0-0"><path d="M 0 0 C 1 1 2 2 3 3 Z"/></symbol></g></defs><g fill="rgb(0%, 0%, 0%)"><use xlink:href="#glyph-0-0" x="60" y="60"/></g>${paths.join('\n')}</svg>`;
}

function pagesOf(sheets: Sheet[]): Page[] {
  const text = parseBbox(bboxXml(sheets), { maxPages: 16, maxWords: 6000 });
  return text.map((p, i) => ({ ...p, rules: rectRules(svgOf(sheets[i]!)) }));
}

function baseRows(): RowSpec[] {
  return [
    { title: TITLE },
    { title: 'Dal 21 settembre 2026 al 18 dicembre 2026' },
    { title: 'CURRICULUM DI PROVA / 1° ANNO' },
    { days: DAYS5, group: 'STUDENTI A - L' },
    { header: HEAD5 },
    { teach: 'DIRITTO DI PROVA', teacher: 'Mario Rossi', cfu: '6', cells: [['9-11', 'Cons 2B'], null, ['11-13', 'OA/SG 1\n(cubo 3A)'], null, null] },
    {
      teach: 'ECONOMIA DI PROVA\n(prof. Mario Rossi)',
      teacher: 'Mario Rossi',
      cfu: '9',
      cells: [null, ['8.30-\n11.00', 'Aula 1\ncubo 11D'], null, ['13-14 /\n16-18', 'Cons 2B'], null],
    },
    { teach: 'STORIA DI PROVA', teacher: 'Mario Rossi', cfu: '6', cells: [null, null, null, null, null] },
    { gap: 30, note: 'Aggiornato al 06-11-2026' },
  ];
}

function extract(sheets: Sheet[], feed: DiscagFeed = FEED, sha = SHA, layout = LAYOUT): DiscagExtract {
  return extractDiscag(pagesOf(sheets), feed, layout, sha);
}

function refusedWith(code: PdfCode, fn: () => unknown): void {
  assert.throws(fn, (err: unknown) => err instanceof PdfError && err.code === code, code);
}

const slots = (r: DiscagExtract) =>
  r.entries.map((e) => `${e.title}|${e.day}|${e.startMin}-${e.endMin}|${e.rooms.map((x) => x.name).join('+')}|${e.from ?? ''}|${e.until ?? ''}`);

// ---------- cell validators ----------

test('times: closed forms accepted, anything else refused', () => {
  assert.deepEqual(parseTimes('9-11'), [[540, 660]]);
  assert.deepEqual(parseTimes('16-19'), [[960, 1140]]);
  assert.deepEqual(parseTimes('8.30- 11.00'), [[510, 660]]);
  assert.deepEqual(parseTimes('14.30/ 17.30'), [[870, 1050]]);
  assert.deepEqual(parseTimes('13-14 / 16-18'), [[780, 840], [960, 1080]]);
  assert.deepEqual(parseTimes('9-11 e 14-16'), [[540, 660], [840, 960]]);
  for (const bad of ['9-11/10-12', '5-7', '11-10', '9:10-11', 'ore 9', '9-17', '9.75-11', '20-22', '9-11 aula', '', '9-11-13']) {
    assert.equal(parseTimes(bad), null, bad);
  }
});

test('rooms: every form of the real table is read, wrong cubes and unknown rooms are refused', () => {
  const rooms = parseDiscagConfig(JSON.parse(readFileSync(fileURLToPath(new URL('config/pdf.json', ROOT)), 'utf8')).discag).rooms;
  const names = (text: string) => {
    const r = parseRooms(text, rooms);
    return 'rooms' in r ? r.rooms.map((x) => x.name) : r.error;
  };
  assert.deepEqual(names('Cons 13C'), ['Consolidata 13C']);
  assert.deepEqual(names('OA/SG 4 (cubo 3A)'), ['OA/SG4']);
  assert.deepEqual(names('PMI 2 / Cubo 3B / Piano terra'), ['PMI 2']);
  assert.deepEqual(names('Zenit 2 / Cubo 13C / ponte carrabile'), ['Zenit 2']);
  assert.deepEqual(names('Aula 2 cubo 11C-D p.t'), ['Aula 2']);
  assert.deepEqual(names('Ex Sdipa / cubo 3D / primo piano'), ['Ex Sdipa']);
  assert.deepEqual(names('Ex Sdipa Cubo 3D 1° piano'), ['Ex Sdipa']);
  assert.deepEqual(names('Aula L2 polifunzion ale'), ['L2']);
  assert.deepEqual(names('Lab Geo C 28D 1 piano'), ['Laboratorio di Geografia']);
  assert.deepEqual(names('Aula Storia 3 cubo 28C'), ['Stor 3']);
  assert.deepEqual(names('EP1 / EP2'), ['EP1', 'EP2']);
  assert.equal(names('Aula 99'), 'unknown_room');
  assert.equal(names('OA/SG 1 Cubo 5B'), 'room_building_mismatch');
  assert.equal(names('Cons 2B polifunzionale'), 'room_building_mismatch');
  assert.equal(names('Aula 1'), 'unknown_room');
  assert.equal(names('Aula H3 cubo 3A'), 'unknown_room');
  assert.equal(names('Cons 2B 28D'), 'unknown_room');
  assert.equal(names('x'.repeat(201)), 'cell_too_long');
});

// ---------- text layer and rules ----------

test('text layer: the head is never read and anything malformed refuses the file', () => {
  const fixture = sheet(baseRows());
  const xml = bboxXml([fixture]);
  const [page] = parseBbox(xml, { maxPages: 16, maxWords: 6000 });
  assert.equal(page?.words.length, fixture.words.length, 'the metadata in the head is not a word');
  refusedWith('bad_text_layer', () => parseBbox('<html></html>', { maxPages: 16, maxWords: 6000 }));
  refusedWith('bad_text_layer', () => parseBbox(xml.replace('<word xMin="', '<word xMin="-x'), { maxPages: 16, maxWords: 6000 }));
  refusedWith('bad_text_layer', () => parseBbox(xml.replace(/xMax="[\d.]+"/, 'xMax="9999.0"'), { maxPages: 16, maxWords: 6000 }));
  refusedWith('page_count', () => parseBbox(bboxXml([sheet([]), sheet([])]), { maxPages: 1, maxWords: 6000 }));
  refusedWith('too_many_words', () => parseBbox(xml, { maxPages: 16, maxWords: 5 }));
  refusedWith('bad_text_layer', () => parseBbox(xml.replace(/>DIRITTO</, `>${'X'.repeat(201)}<`), { maxPages: 16, maxWords: 6000 }));
});

test('rules: thin rectangles are rules, other shapes are not, transforms are refused', () => {
  const rect = (d: string, extra = '') => `<path fill="rgb(0%, 0%, 0%)" d="${d}"${extra}/>`;
  const svg = (body: string) => `<svg><defs><path d="M 0 0 L 1 0 L 1 0.2 L 0 0.2 Z"/></defs>${body}</svg>`;
  const rules = rectRules(
    svg(
      rect('M 10 20 L 200 20 L 200 19.5 L 10 19.5 Z M 10 20 ') +
        rect('M 50 100 L 50.5 100 L 50.5 20 L 50 20 Z') +
        rect('M 10 10 L 200 10 L 200 50 L 10 50 Z') +
        rect('M 1 1 C 2 2 3 3 4 4') +
        rect('M 10 10 L 20 20 L 30 10 L 20 0 Z') +
        rect('M 5 5 C 6 6 7 7 8 8', ' transform="matrix(1, 0, 0, -1, 0, 595)"'),
    ),
  );
  assert.equal(rules.h.length, 1);
  assert.equal(rules.v.length, 1);
  assert.deepEqual(rules.h[0], { y: 19.75, x0: 10, x1: 200 });
  refusedWith('rules_transformed', () => rectRules(svg(rect('M 10 20 L 200 20 L 200 19.5 L 10 19.5 Z', ' transform="matrix(1, 0, 0, 1, 5, 5)"'))));
  refusedWith('rules_transformed', () => rectRules(svg(`<g transform="matrix(1, 0, 0, 1, 5, 5)">${rect('M 10 20 L 200 20 L 200 19.5 L 10 19.5 Z')}</g>`)));
  refusedWith('too_many_rules', () => rectRules(svg(rect('M 10 20 L 200 20 L 200 19.5 L 10 19.5 Z').repeat(3)), 2));
});

// ---------- layout ----------

test('layout: a 5 day table gives one entry per day cell and slot, never a teacher', () => {
  const r = extract([sheet(baseRows())]);
  assert.equal(r.tables, 1);
  assert.deepEqual(r.unplaced, []);
  assert.equal(r.updated, '2026-11-06');
  assert.deepEqual(slots(r).sort(), [
    'DIRITTO DI PROVA|0|540-660|CONSOLIDATA 2B||',
    'DIRITTO DI PROVA|2|660-780|OA/SG1||',
    'ECONOMIA DI PROVA|1|510-660|Aula 1||',
    'ECONOMIA DI PROVA|3|780-840|CONSOLIDATA 2B||',
    'ECONOMIA DI PROVA|3|960-1080|CONSOLIDATA 2B||',
  ]);
  assert.ok(r.entries.every((e) => e.year === 1 && e.courses.join() === 'STUDI DI PROVA (triennale)'));
  assert.ok(!JSON.stringify(r).includes('Rossi'));
});

test('layout: 6 days, SABATO without labels, split labels, groups, label rows and rows without times', () => {
  const six = baseRows();
  six[3] = { days: [...DAYS5, 'SABATO'] };
  six[4] = { header: ['INSEGNAMENTI', 'Credit\ni', 'Or\ne', 'Doce\nnte', ...PAIRS(6)] };
  six[5] = { teach: 'DIRITTO DI PROVA', cells: [null, null, null, null, null, ['9-11', 'Cons 2B']] };
  six[6] = { label: 'Un insegnamento a scelta tra:' };
  const r6 = extract([sheet(six, { cols: 6 })]);
  assert.deepEqual(slots(r6), ['DIRITTO DI PROVA|5|540-660|CONSOLIDATA 2B||']);

  const unlabeled = baseRows();
  unlabeled[3] = { days: [...DAYS5, 'SABATO'], group: 'STUDENTI M - Z - (AULA 2)' };
  unlabeled[4] = { header: ['INSEGNAMENTI', 'CFU', 'Ore', 'Docente', 'ORARI\nO', 'AULA', ...PAIRS(4), '', ''] };
  unlabeled[5] = { teach: 'DIRITTO DI PROVA', cells: [['9-11', 'Cons 2B'], null, null, null, null, null] };
  unlabeled[6] = { teach: 'ECONOMIA DI PROVA', cells: [null, null, null, null, null, null] };
  assert.deepEqual(slots(extract([sheet(unlabeled, { cols: 6 })])), ['DIRITTO DI PROVA|0|540-660|CONSOLIDATA 2B||']);

  const data = structuredClone(unlabeled);
  data[6] = { teach: 'ECONOMIA DI PROVA', cells: [null, null, null, null, null, ['9-11', 'Cons 2B']] };
  assert.deepEqual(extract([sheet(data, { cols: 6 })]).unplaced.map((u) => u.code), ['unlabeled_column']);

  const merged = baseRows();
  merged.splice(6, 0, { label: 'Un insegnamento a scelta tra:' });
  assert.equal(extract([sheet(merged)]).entries.length, 5);
});

test('layout: a table goes on after a page break and after an "a far data dal" note', () => {
  const rows = baseRows().slice(0, 7);
  const next: RowSpec[] = [{ teach: 'STORIA DI PROVA', cells: [null, null, null, null, ['14-16', 'Cons 2B']] }];
  const r = extract([sheet(rows), sheet(next)]);
  assert.ok(slots(r).includes('STORIA DI PROVA|4|840-960|CONSOLIDATA 2B||'));

  const change: RowSpec[] = [
    ...baseRows().slice(0, 7),
    { gap: 30, note: 'A FAR DATA DAL 4 NOVEMBRE 2026 I SEGUENTI INSEGNAMENTI VERRANNO EROGATI SECONDO IL SEGUENTE ORARIO' },
    { teach: 'DIRITTO DI PROVA', cells: [null, null, null, null, ['9-11', 'Cons 2B']] },
  ];
  const c = extract([sheet(change)]);
  assert.deepEqual(slots(c).filter((s) => s.startsWith('DIRITTO')), [
    'DIRITTO DI PROVA|0|540-660|CONSOLIDATA 2B||2026-11-03',
    'DIRITTO DI PROVA|2|660-780|OA/SG1||2026-11-03',
    'DIRITTO DI PROVA|4|540-660|CONSOLIDATA 2B|2026-11-04|',
  ]);
});

test('layout: start notes bind to one teaching, the teacher in the note is never kept', () => {
  const rows = baseRows();
  rows.push({ gap: 20, note: 'Il corso di ECONOMIA DI PROVA (prof. Mario Rossi) avrà inizio giovedì 19 novembre 2026' });
  const r = extract([sheet(rows)]);
  assert.ok(r.entries.filter((e) => e.title === 'ECONOMIA DI PROVA').every((e) => e.from === '2026-11-19'));
  assert.ok(r.entries.filter((e) => e.title === 'DIRITTO DI PROVA').every((e) => e.from === null));
  assert.ok(!JSON.stringify(r).includes('ROSSI') && !JSON.stringify(r).includes('Rossi'));

  const typo = baseRows();
  typo.push({ gap: 20, note: 'Il corso di ECONOMA DI PROVA avrà inizio giovedì 19 novembre 2026' });
  assert.deepEqual(extract([sheet(typo)]).warnings.map((w) => w.code), ['start_note_fuzzy']);

  const unbound = baseRows();
  unbound.push({ gap: 20, note: 'Il corso di GEOGRAFIA avrà inizio giovedì 19 novembre 2026' });
  const u = extract([sheet(unbound)]);
  assert.deepEqual(u.warnings.map((w) => w.code), ['start_note_unbound']);
  assert.ok(u.entries.every((e) => e.from === null), 'unbound note: lessons stay, rooms stay busy');

  const wrongDay = baseRows();
  wrongDay.push({ gap: 20, note: 'Il corso di ECONOMIA DI PROVA avrà inizio venerdì 19 novembre 2026' });
  refusedWith('unbound_note', () => extract([sheet(wrongDay)]));

  // A start after the end of the semester would remove every lesson: the note is ignored instead.
  const late = baseRows();
  late.push({ gap: 20, note: 'Il corso di ECONOMIA DI PROVA avrà inizio lunedì 11 gennaio 2027' });
  const l = extract([sheet(late)]);
  assert.deepEqual(l.warnings.map((w) => w.code), ['start_note_unbound']);
  assert.ok(l.entries.every((e) => e.from === null), 'late note: lessons stay, rooms stay busy');
});

test('layout: a person in the teaching cell or a word on a column rule fails the file', () => {
  for (const teach of ['DIRITTO DI PROVA\nProf. Mario Rossi', 'DIRITTO DI PROVA\nProf.ssa Maria Bianchi', 'DIRITTO DI PROVA\nDocente: Mario Rossi']) {
    const r = extract([sheet(withRow(baseRows(), 5, { teach, cells: [['9-11', 'Cons 2B'], null, null, null, null] }))]);
    assert.deepEqual(r.unplaced.map((u) => u.code), ['person_in_title'], teach);
    assert.ok(!JSON.stringify(r).includes('Rossi') && !JSON.stringify(r).includes('Bianchi'), teach);
  }
  const plain = extract([sheet(withRow(baseRows(), 5, { teach: 'TECNICA PROFESSIONALE', cells: [['9-11', 'Cons 2B'], null, null, null, null] }))]);
  assert.deepEqual(plain.unplaced, []);
  assert.ok(slots(plain).includes('TECNICA PROFESSIONALE|0|540-660|CONSOLIDATA 2B||'));

  // A word centered on the rule between two cells belongs to neither: never dropped in silence.
  const edge = geometry(5).pairs[0]![2];
  const cy = 40 + 5 * ROW_H + ROW_H / 2;
  const onRule = sheet(baseRows(), { extra: [{ x0: edge - 7, y0: cy - 4.5, x1: edge + 7, y1: cy + 4.5, t: 'EP2' }] });
  refusedWith('word_crosses_column', () => extract([onRule]));
});

test('layout: the same lesson on two curriculum pages is kept once, the longer title wins', () => {
  const second: RowSpec[] = [
    { title: TITLE },
    { title: 'ALTRO CURRICULUM / 1° ANNO' },
    { days: DAYS5 },
    { header: HEAD5 },
    { teach: 'DIRITTO DI PROVA', cells: [['9-11', 'Cons 2B'], null, null, null, null] },
    { teach: 'ECONOMIA DI PROVA\nAVANZATA', cells: [null, ['8.30-\n11.00', 'Aula 1\ncubo 11D'], null, null, null] },
  ];
  const r = extract([sheet(baseRows()), sheet(second)]);
  assert.equal(r.entries.filter((e) => e.title.startsWith('DIRITTO') && e.day === 0).length, 1);
  assert.ok(slots(r).includes('ECONOMIA DI PROVA AVANZATA|1|510-660|Aula 1||'));
  assert.ok(!slots(r).includes('ECONOMIA DI PROVA|1|510-660|Aula 1||'));
  assert.deepEqual(r.warnings.map((w) => w.code), ['shared_title_merged']);
  assert.ok(r.warnings.every((w) => /^[pbnd0-9/]+$/.test(w.where)));
});

// Fail closed, as bin/mutate.mjs of the spec: each mutation refuses the file or leaves a cell unplaced.
const MUTATIONS: [string, (rows: RowSpec[]) => RowSpec[], { refused: PdfCode } | { unplaced: string }][] = [
  ['unknown room', (r) => withCell(r, 5, 0, ['9-11', 'Cons 9Z']), { unplaced: 'unknown_room' }],
  ['room renamed', (r) => withCell(r, 5, 0, ['9-11', 'Conz 2B']), { unplaced: 'unknown_room' }],
  ['room in another cube', (r) => withCell(r, 5, 0, ['9-11', 'OA/SG 1\nCubo 5B']), { unplaced: 'room_building_mismatch' }],
  ['time garbled', (r) => withCell(r, 5, 0, ['ore9', 'Cons 2B']), { unplaced: 'bad_time' }],
  ['times overlap', (r) => withCell(r, 5, 0, ['9-11/\n10-12', 'Cons 2B']), { unplaced: 'bad_time' }],
  ['time out of range', (r) => withCell(r, 5, 0, ['5-7', 'Cons 2B']), { unplaced: 'bad_time' }],
  ['room removed', (r) => withCell(r, 5, 0, ['9-11', '']), { unplaced: 'time_without_room' }],
  ['time removed', (r) => withCell(r, 5, 0, ['', 'Cons 2B']), { unplaced: 'room_without_time' }],
  ['teaching removed', (r) => withRow(r, 5, { teach: '', cells: [['9-11', 'Cons 2B'], null, null, null, null] }), { unplaced: 'no_teaching' }],
  // A row without a day boundary no longer matches the table: read as a title, its times refuse the file.
  ['merged day cells', (r) => withRow(r, 5, { ...(r[5] as DataRow), dropV: [geometry(5).pairs[0]![2]] }), { refused: 'unexpected_band' }],
  [
    'merged day cells in the last row, a time with a slash',
    (r) => withRow(r, 7, { teach: 'STORIA DI PROVA', cells: [['9/11', 'Lab Geo\nC 28D'], null, null, null, null], dropV: [geometry(5).pairs[0]![2]] }),
    { refused: 'unexpected_band' },
  ],
  ['merged time and room cells', (r) => withRow(r, 5, { ...(r[5] as DataRow), dropV: [geometry(5).pairs[1]![1]] }), { refused: 'column_rules' }],
  ['extra column rule', (r) => withRow(r, 5, { ...(r[5] as DataRow), extraV: [380] }), { refused: 'column_rules' }],
  ['label row with data', (r) => withRow(r, 6, { label: 'Un insegnamento a scelta tra:', cells: [['9-11', 'Cons 2B']] }), { refused: 'column_rules' }],
  ['days swapped', (r) => withRow(r, 3, { days: ['LUNEDI', 'MERCOLEDI', 'MARTEDI', 'GIOVEDI', 'VENERDI'] }), { refused: 'day_order' }],
  ['day missing', (r) => withRow(r, 3, { days: ['LUNEDI', '', 'MERCOLEDI', 'GIOVEDI', 'VENERDI'] }), { refused: 'unexpected_band' }],
  ['no day row', (r) => r.filter((_, i) => i !== 3), { refused: 'day_headers' }],
  ['ORARIO label changed', (r) => withRow(r, 4, { header: ['INSEGNAMENTI', 'CFU', 'Ore', 'Docente', 'ORA', 'AULA', ...PAIRS(4)] }), { refused: 'bad_header' }],
  ['unknown header label', (r) => withRow(r, 4, { header: ['INSEGNAMENTI', 'CFU', 'Ore', 'Note', ...PAIRS(5)] }), { refused: 'bad_header' }],
  ['academic year changed', (r) => withRow(r, 0, { title: TITLE.replace('2026– 2027', '2027– 2028') }), { refused: 'academic_year_mismatch' }],
  ['stale academic year', (r) => withRow(r, 0, { title: TITLE.replace('2026– 2027', '2025– 2026') }), { refused: 'academic_year_mismatch' }],
  ['course code changed', (r) => withRow(r, 0, { title: TITLE.replace('(0999)', '(0997)') }), { refused: 'course_mismatch' }],
  ['second semester', (r) => withRow(r, 0, { title: TITLE.replace('PRIMO SEMESTRE', 'SECONDO SEMESTRE') }), { refused: 'wrong_semester' }],
  ['year outside the course', (r) => withRow(r, 2, { title: 'CURRICULUM DI PROVA / 4° ANNO' }), { refused: 'year_mismatch' }],
  ['no year', (r) => withRow(r, 2, { title: 'CURRICULUM DI PROVA' }), { refused: 'page_header' }],
  ['unknown note', (r) => [...r, { gap: 20, note: 'LEZIONI SOSPESE 12/11' }], { refused: 'unbound_note' }],
  ['note with a room', (r) => [...r, { gap: 20, note: 'Aula cambiata' }], { refused: 'unbound_note' }],
  ['time in a title row', (r) => withRow(r, 2, { title: 'CURRICULUM DI PROVA / 1° ANNO 9-11' }), { refused: 'unexpected_band' }],
  ['cancelled lessons in a title row', (r) => withRow(r, 2, { title: 'CURRICULUM DI PROVA / 1° ANNO LEZIONI SOSPESE' }), { refused: 'unexpected_band' }],
  ['effective date without table', (r) => [...r, { gap: 20, note: 'A FAR DATA DAL 4 NOVEMBRE 2026 I SEGUENTI INSEGNAMENTI VERRANNO EROGATI SECONDO IL SEGUENTE ORARIO' }], { refused: 'unbound_note' }],
  // Outside the semester the note would end the old rows or never start the new ones: rooms shown free.
  ...(['4 NOVEMBRE 2027', '4 SETTEMBRE 2026'] as const).map(
    (date): [string, (rows: RowSpec[]) => RowSpec[], { refused: PdfCode }] => [
      `effective date ${date} outside the semester`,
      (r) => [
        ...r.slice(0, 7),
        { gap: 30, note: `A FAR DATA DAL ${date} I SEGUENTI INSEGNAMENTI VERRANNO EROGATI SECONDO IL SEGUENTE ORARIO` },
        { teach: 'DIRITTO DI PROVA', cells: [null, null, null, null, ['9-11', 'Cons 2B']] },
      ],
      { refused: 'unbound_note' },
    ],
  ),
];

type DataRow = Extract<RowSpec, { teach: string }>;

function withRow(rows: RowSpec[], i: number, row: RowSpec): RowSpec[] {
  const out = structuredClone(rows);
  out[i] = row;
  return out;
}

function withCell(rows: RowSpec[], i: number, k: number, cell: [string, string]): RowSpec[] {
  const out = structuredClone(rows);
  const row = out[i] as DataRow;
  row.cells[k] = cell;
  return out;
}

test('layout: every mutation of the layout or of a cell fails the file', () => {
  for (const [name, mutate, expected] of MUTATIONS) {
    const rows = mutate(baseRows());
    if ('refused' in expected) {
      refusedWith(expected.refused, () => extract([sheet(rows)]));
    } else {
      const r = extract([sheet(rows)]);
      assert.deepEqual(r.unplaced.map((u) => u.code), [expected.unplaced], name);
      assert.ok(r.unplaced.every((u) => /^p\d+b\d+(d\d)?$/.test(u.where)), name);
    }
  }
});

test('layout: words outside the table, scans and stray text', () => {
  const right = sheet(baseRows(), { extra: [{ x0: 800, y0: 40 + 5 * ROW_H + 9.5, x1: 820, y1: 40 + 5 * ROW_H + 18.5, t: 'Aula' }] });
  refusedWith('unbound_note', () => extract([right]));
  const empty = sheet(baseRows());
  empty.words = [];
  refusedWith('no_text_layer', () => extract([empty]));
  refusedWith('no_table', () => extract([sheet([{ title: TITLE }, { gap: 20, note: 'Benvenuti' }])]));
  const stray = baseRows();
  stray.push({ gap: 20, note: 'ebEN VENU ITO' });
  assert.deepEqual(extract([sheet(stray)]).warnings.map((w) => w.code), ['stray_text']);
});

test('layout: a stale header passes only with a quirk for that page and that file', () => {
  const rows = withRow(baseRows(), 0, { title: TITLE.replace('2026– 2027', '2025– 2026') });
  const quirk = (sha: string, page: number) => ({ ...LAYOUT, quirks: [{ sha256: sha, page, code: 'academic_year_mismatch' as const }] });
  const ok = extract([sheet(rows)], FEED, SHA, quirk(SHA, 1));
  assert.equal(ok.entries.length, 5);
  assert.deepEqual(ok.warnings.map((w) => w.code), ['academic_year_mismatch_accepted']);
  refusedWith('academic_year_mismatch', () => extract([sheet(rows)], FEED, 'b'.repeat(64), quirk(SHA, 1)));
  refusedWith('academic_year_mismatch', () => extract([sheet(rows)], FEED, SHA, quirk(SHA, 2)));
});

// ---------- expansion ----------

const CAL: CalendarConfig = CFG.calendar;
const ROOM_2B: PdfRoom = CFG.rooms[0]!.room;

function entry(over: Partial<WeeklyEntry>): WeeklyEntry {
  return {
    day: 0,
    startMin: 540,
    endMin: 660,
    title: 'DIRITTO DI PROVA',
    courses: ['STUDI DI PROVA'],
    year: 1,
    rooms: [ROOM_2B],
    from: null,
    until: null,
    keyHead: ['discag:0999', '1'],
    keyTail: ['540', '660', 'DIRITTODIPROVA', ROOM_2B.syntheticId],
    ...over,
  };
}

const ctx = (from: string, to: string, planner: [string, string][] = []): FetchContext => ({
  from: romeMidnight(day(from)),
  to: romeMidnight(day(to)),
  plannerRooms: new Map(planner.map(([k, v]) => [k, plannerId(v)])),
});

test('expansion: Rome time across the clock change, closed days, Saturday, validity of notes', () => {
  const tpl = {
    entries: [
      entry({}),
      entry({ day: 4, keyTail: ['540', '660', 'X', ROOM_2B.syntheticId] }),
      entry({ day: 1, keyTail: ['540', '660', 'Y', ROOM_2B.syntheticId] }),
      entry({ day: 5, keyTail: ['540', '660', 'Z', ROOM_2B.syntheticId] }),
    ],
  };
  const oct = expandTemplate(tpl, CAL, ctx('2026-10-19', '2026-10-28')).parsed.lessons;
  const at = (d: string) => oct.find((l) => l.start >= romeMidnight(day(d)) && l.start < romeMidnight(day(d)) + 86_400_000);
  assert.equal(at('2026-10-23')?.start, Date.UTC(2026, 9, 23, 7, 0));
  assert.equal(at('2026-10-26')?.start, Date.UTC(2026, 9, 26, 8, 0));
  assert.equal(at('2026-10-26')?.end, Date.UTC(2026, 9, 26, 10, 0));

  const dec = expandTemplate(tpl, CAL, ctx('2026-12-07', '2026-12-28'));
  const days = dec.parsed.lessons.map((l) => new Date(l.start).toISOString().slice(0, 10));
  assert.ok(!days.includes('2026-12-08'), 'closed day');
  assert.ok(days.includes('2026-12-19'), 'Saturday 19 December is in the semester');
  assert.ok(!days.some((d) => d > '2026-12-19'), 'nothing after the semester');
  assert.equal(dec.to, romeMidnight(day('2026-12-28')), 'the break is covered: no lessons, rooms follow the other sources');

  const bounded = { entries: [entry({ from: day('2026-11-10'), until: day('2026-11-20') })] };
  const nov = expandTemplate(bounded, CAL, ctx('2026-11-02', '2026-11-30')).parsed.lessons;
  assert.deepEqual(nov.map((l) => new Date(l.start).toISOString().slice(0, 10)), ['2026-11-16']);
  assert.ok(nov.every((l) => l.teachers.length === 0 && l.kind === "ATTIVITA' DIDATTICA" && l.status === 'active'));
});

test('expansion: coverage stays inside the semester and the break, later windows are refused', () => {
  const tpl = { entries: [entry({})] };
  const jan = expandTemplate(tpl, CAL, ctx('2027-01-11', '2027-01-25'));
  assert.equal(jan.parsed.lessons.length, 0);
  assert.equal(jan.from, romeMidnight(day('2027-01-11')));
  const sep = expandTemplate(tpl, CAL, ctx('2026-09-14', '2026-09-29'));
  assert.equal(sep.from, romeMidnight(day('2026-09-21')), 'before the semester the rooms are not covered');
  refusedWith('outside_semester', () => expandTemplate(tpl, CAL, ctx('2027-02-22', '2027-03-08')));
  refusedWith('outside_semester', () => expandTemplate(tpl, { ...CAL, semester: 2 }, ctx('2026-12-01', '2026-12-15')));
});

test('expansion: a Planner room keeps its id, other rooms get the synthetic one', () => {
  const tpl = { entries: [entry({}), entry({ day: 2, rooms: [CFG.rooms[1]!.room], keyTail: ['540', '660', 'W', CFG.rooms[1]!.room.syntheticId] })] };
  const out = expandTemplate(tpl, CAL, ctx('2026-11-09', '2026-11-14', [[ROOM_2B.matchKey, 'aaaaaaaaaaaaaaaaaaaaaaaa']]));
  assert.deepEqual(out.parsed.lessons.map((l) => l.roomIds), [['aaaaaaaaaaaaaaaaaaaaaaaa'], [CFG.rooms[1]!.room.syntheticId]]);
  assert.deepEqual(out.parsed.rooms.map((r) => r.name), ['OA/SG1']);
  assert.deepEqual(out.parsed.rooms[0], {
    id: syntheticRoomId('cubo-3a', 'oasg1'),
    name: 'OA/SG1',
    code: '',
    buildingName: 'Cubo 3A',
    capacity: null,
    effectiveCapacity: null,
    services: [],
  });
  assert.equal(ROOM_2B.matchKey, roomMatchKey('Cubo 2B', 'CONSOLIDATA 2B'));
});

// ---------- ids ----------

test('ids: feed and lesson ids follow the shared vectors and stay stable', () => {
  assert.equal(feedId('pdf', 'discag:0881'), 'fffdbb5f2dc57f2a783e969d');
  assert.equal(feedId('pdf', 'discag:0880'), 'fffddbaa031332cc90979e94');
  // Lesson vector of the spec (EA, Tuesday 10 November 2026, 11:00-13:00, Ex Sdipa).
  const title = 'ECONOMIA DELLE AZIENDE PUBBLICHE - CRISI E RISANAMENTO FINANZIARIO';
  const exSdipa = syntheticRoomId('cubo-3d', 'exsdipa');
  assert.equal(exSdipa, 'ffffe27eb6a08c1ad906b33e');
  const vector = entry({ day: 1, startMin: 660, endMin: 780, title, year: 3, keyHead: ['discag:0881', '3'], keyTail: ['660', '780', compact(title), exSdipa] });
  const [lesson] = expandTemplate({ entries: [vector] }, CAL, ctx('2026-11-10', '2026-11-11')).parsed.lessons;
  assert.equal(lesson?.id, 'fffe23fea49c7a9e3e5cb11a');
  assert.equal(lesson?.start, 1794304800000);
  assert.equal(syntheticLessonId('pdf', ['discag:0881', '3', '2026-11-10', '660', '780', compact(title), exSdipa].join('\u001f')), lesson?.id);

  const once = extract([sheet(baseRows())]);
  const twice = extract([sheet(baseRows())]);
  const ids = (r: DiscagExtract) => expandTemplate({ entries: r.entries }, CAL, ctx('2026-11-02', '2026-11-30')).parsed.lessons.map((l) => l.id);
  assert.deepEqual(ids(once), ids(twice));
  assert.equal(new Set(ids(once)).size, ids(once).length, 'no duplicate id in the window');
  const moved = extract([sheet(withCell(baseRows(), 5, 0, ['10-12', 'Cons 2B']))]);
  const otherRoom = extract([sheet(withCell(baseRows(), 5, 0, ['9-11', 'OA/SG 1']))]);
  assert.notDeepEqual(ids(moved), ids(once));
  assert.notDeepEqual(ids(otherRoom), ids(once));
});

// ---------- discovery ----------

const ATT = '/media/publications_attachments/9999/';

function indexHtml(title: string, links: [string, string][]): string {
  return (
    `<html><head><title>x</title></head><body><h1 class="mb-4 lighter">${title}</h1>` +
    `<ul class="mb-0 ps-0 list-unstyled">${links.map(([h, t]) => `<li><a class="no-color" href="${h}"><b>- ${t}</b></a></li>`).join('')}</ul></body></html>`
  );
}

const LINKS: [string, string][] = [
  [`${ATT}PROVA_LT_2.pdf`, 'LTPR.pdf'],
  [`${ATT}PROVA_LM_xyzABC1.pdf`, 'LMPR - PROVA.pdf'],
  [`${ATT}Link_ai_team.pdf`, 'LINK AI TEAM'],
];

test('discovery: exactly one link per course by its label; unknown labels are counted, never followed', () => {
  const ok = findAttachments(indexHtml('Orario  di prova del 1&deg;semestre a.a. 2026/27', LINKS), CFG);
  assert.deepEqual(Object.fromEntries(ok.links), {
    'discag:0999': { url: `https://discag.unical.it${ATT}PROVA_LT_2.pdf` },
    'discag:0997': { url: `https://discag.unical.it${ATT}PROVA_LM_xyzABC1.pdf` },
  });
  assert.equal(ok.unknown, 1);
  refusedWith('wrong_page_title', () => findAttachments(indexHtml('Orario del 2°semestre a.a. 2026/27', LINKS), CFG));
  refusedWith('bad_html', () => findAttachments(indexHtml('Orario di prova del 1°semestre a.a. 2026/27', LINKS) + '<h1>altro</h1>', CFG));
  refusedWith('bad_html', () => findAttachments('<html><body>niente</body></html>', CFG));
  const missing = findAttachments(indexHtml('Orario di prova del 1°semestre a.a. 2026/27', [LINKS[0]!]), CFG);
  assert.deepEqual(missing.links.get('discag:0997'), { code: 'discovery_missing' });
  const twice = findAttachments(indexHtml('Orario di prova del 1°semestre a.a. 2026/27', [...LINKS, [`${ATT}PROVA_LT_3.pdf`, 'LTPR.pdf']]), CFG);
  assert.deepEqual(twice.links.get('discag:0999'), { code: 'discovery_ambiguous' });
  assert.ok('url' in (twice.links.get('discag:0997') ?? {}), 'the other feed goes on');
  const elsewhere = findAttachments(
    indexHtml('Orario di prova del 1°semestre a.a. 2026/27', [
      ['https://example.com/media/publications_attachments/9999/PROVA_LT.pdf', 'LTPR.pdf'],
      ['/media/publications_attachments/1234/PROVA_LT.pdf', 'LTPR.pdf'],
      [`${ATT}gAAAAABx.pdf`, 'LTPR.pdf'],
      [`${ATT}PROVA_LT.xlsx`, 'LTPR.pdf'],
      LINKS[1]!,
    ]),
    CFG,
  );
  assert.deepEqual(elsewhere.links.get('discag:0999'), { code: 'discovery_missing' });
  assert.equal(anchorsOf('<a href="/x">a &amp; b</a><a name="y">z</a>').length, 1);
});

// ---------- adapter ----------

interface Call {
  url: string;
  init: RequestInit;
}

function recorder(): Logger & { lines: string[] } {
  const lines: string[] = [];
  const push = (level: string) => (event: string, fields: LogFields = {}) => lines.push(JSON.stringify({ level, event, ...fields }));
  return { lines, info: push('info'), warn: push('warn'), error: push('error') };
}

const PDF_BYTES = (name: string) => new TextEncoder().encode(`%PDF-1.7 fixture ${name}`);
const PDF_HEADERS = { 'content-type': 'application/pdf', etag: '"v1"', 'last-modified': 'Fri, 06 Nov 2026 14:06:07 GMT' };
// The second course of the fixture has its own code in the title.
const FEED2_PAGES = () => pagesOf([sheet(withRow(baseRows(), 0, { title: TITLE.replace('(0999)', '(0997)') }))]);

function setup(over: { html?: string; pdf?: (url: string, init: RequestInit) => Response; pages?: Page[] } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const log = recorder();
  let reads = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    if (url === CFG.pageUrl) {
      return new Response(over.html ?? indexHtml('Orario di prova del 1°semestre a.a. 2026/27', LINKS), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }
    if (over.pdf) return over.pdf(url, init ?? {});
    return new Response(PDF_BYTES(url.includes('_LM_') ? 'LM' : 'LT'), { headers: PDF_HEADERS });
  }) as typeof fetch;
  const options: PdfAdapterOptions = {
    fetchImpl,
    log,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    config: async () => [discagProfile.parse(RAW)],
    readPdf: async (bytes) => {
      reads += 1;
      if (over.pages) return structuredClone(over.pages);
      return new TextDecoder().decode(bytes).endsWith('LM') ? FEED2_PAGES() : pagesOf([sheet(baseRows())]);
    },
  };
  return { adapter: pdfAdapter(options), calls, sleeps, log, reads: () => reads };
}

const FEED_OF = (f: DiscagFeed): Feed => ({ id: f.id, source: 'pdf', ref: f.ref });
const WINDOW = ctx('2026-11-09', '2026-11-23');

async function failureOf(p: Promise<SourceData>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return err instanceof SourceError ? err.code : 'other';
  }
}

test('adapter: polite sequence, conditional GET, the Teams list never requested', async () => {
  const s = setup();
  await s.adapter.prepare();
  const data = await s.adapter.fetch(FEED_OF(FEED), WINDOW);
  assert.equal(data.parsed.lessons.length, 10);
  assert.deepEqual(s.calls.map((c) => c.url), [CFG.pageUrl, `https://discag.unical.it${ATT}PROVA_LT_2.pdf`, `https://discag.unical.it${ATT}PROVA_LM_xyzABC1.pdf`]);
  assert.deepEqual(s.sleeps, [2000, 2000]);
  for (const c of s.calls) {
    assert.equal((c.init.headers as Record<string, string>)['User-Agent'], USER_AGENT);
    assert.equal(c.init.redirect, 'error');
  }
  assert.ok(!s.calls.some((c) => /Link_ai_team/i.test(c.url)));

  const second = setup({
    pdf: (_url, init) => {
      const h = init.headers as Record<string, string>;
      return h['If-None-Match'] === '"v1"' && h['If-Modified-Since']
        ? new Response(null, { status: 304 })
        : new Response(PDF_BYTES(_url.includes('_LM_') ? 'LM' : 'LT'), { headers: PDF_HEADERS });
    },
  });
  await second.adapter.prepare();
  await second.adapter.prepare();
  assert.equal(second.reads(), 2, 'one read per file: the second run reuses the templates');
  assert.equal((await second.adapter.fetch(FEED_OF(FEED), WINDOW)).parsed.lessons.length, 10);
  assert.equal((await second.adapter.fetch(FEED_OF(FEED2), WINDOW)).parsed.lessons.length, 10);
  assert.ok(second.log.lines.some((l) => l.includes('"status":304')));
});

test('adapter: failures are closed codes per feed', async () => {
  const cases: [string, Parameters<typeof setup>[0], string, string][] = [
    ['html instead of pdf', { pdf: () => new Response('<html>', { headers: { 'content-type': 'application/pdf' } }) }, 'bad_shape', 'bad_shape'],
    ['wrong content type', { pdf: () => new Response(PDF_BYTES('LT'), { headers: { 'content-type': 'text/html' } }) }, 'bad_shape', 'bad_shape'],
    ['http status', { pdf: () => new Response('no', { status: 404 }) }, 'http_status', 'http_status'],
    ['too large', { pdf: () => new Response(new Uint8Array(MAX_PDF_BYTES + 1), { headers: { 'content-type': 'application/pdf' } }) }, 'too_large', 'too_large'],
    ['redirect refused', { pdf: () => { throw new TypeError('fetch failed'); } }, 'network', 'network'],
    ['page title changed', { html: indexHtml('Orario del 2°semestre a.a. 2026/27', LINKS) }, 'wrong_period', 'wrong_period'],
    ['label twice', { html: indexHtml('Orario di prova del 1°semestre a.a. 2026/27', [...LINKS, [`${ATT}OTHER.pdf`, 'LTPR.pdf']]) }, 'bad_html', 'ok'],
    ['stale header', { pages: pagesOf([sheet(withRow(baseRows(), 0, { title: TITLE.replace('2026– 2027', '2025– 2026') }))]) }, 'wrong_period', 'bad_shape'],
    ['unplaced cell', { pages: pagesOf([sheet(withCell(baseRows(), 5, 0, ['9-11', 'Cons 9Z']))]) }, 'bad_shape', 'bad_shape'],
  ];
  for (const [name, over, first, second] of cases) {
    const s = setup(over);
    await s.adapter.prepare();
    assert.equal(await failureOf(s.adapter.fetch(FEED_OF(FEED), WINDOW)), first, name);
    assert.equal(await failureOf(s.adapter.fetch(FEED_OF(FEED2), WINDOW)), second, name);
    assert.ok(s.log.lines.every((l) => !l.includes('https:') && !l.includes('PROVA') && !l.includes('Rossi')), `${name}: no URL or text in logs`);
  }
  const s = setup();
  await s.adapter.prepare();
  assert.equal(await failureOf(s.adapter.fetch({ id: feedId('pdf', 'discag:0001'), source: 'pdf', ref: 'discag:0001' }, WINDOW)), 'unexpected');
  assert.equal(await failureOf(s.adapter.fetch({ ...FEED_OF(FEED), id: FEED2.id }, WINDOW)), 'unexpected');
  assert.equal(await failureOf(s.adapter.fetch(FEED_OF(FEED), ctx('2027-03-01', '2027-03-15'))), 'wrong_period');
  assert.equal(await failureOf(pdfAdapter({ config: async () => [] }).fetch(FEED_OF(FEED), WINDOW)), 'unexpected', 'fetch before prepare');
});

test('least data: teacher names in the file never reach the payload or the logs', async () => {
  const rows = baseRows();
  rows.push({ gap: 20, note: 'Il corso di STORIA DI PROVA (prof. Mario Rossi) avrà inizio giovedì 19 novembre 2026' });
  rows.splice(7, 0, { teach: 'GEOGRAFIA DI PROVA\n(Dott.ssa Maria\nBianchi', teacher: 'Maria Bianchi', cells: [null, null, null, null, ['14-16', 'Cons 2B']] });
  const s = setup({ pages: pagesOf([sheet(rows)]) });
  await s.adapter.prepare();
  const data = await s.adapter.fetch(FEED_OF(FEED), WINDOW);
  const payload = buildPayload(data.parsed, data.from, data.to);
  assert.ok(payload.lessons.length > 0);
  assert.ok(payload.lessons.some((l) => l.title === 'GEOGRAFIA DI PROVA'));
  const all = JSON.stringify({ payload, data, logs: s.log.lines }).toUpperCase();
  for (const name of ['ROSSI', 'MARIO', 'BIANCHI', 'MARIA', '(PROF', 'DOTT']) assert.ok(!all.includes(name), name);
  assert.ok(payload.lessons.every((l) => l.teachers.length === 0));
});

// ---------- configuration, generator, registry ----------

test('config: the real file loads, invalid sections are refused', async () => {
  const [discag] = await loadPdfConfig(PROFILES);
  assert.deepEqual(
    discag?.feeds.map((f) => [f.ref, f.id]),
    [
      ['discag:0881', 'fffdbb5f2dc57f2a783e969d'],
      ['discag:0884', 'fffd1e708ad8fd149250da22'],
      ['discag:0882', 'fffdd314dd400c2b2c00305d'],
      ['discag:0883', 'fffdac7d8285cbbadcab44c7'],
      ['discag:0885', 'fffd4b778f293ca60ebaef61'],
      ['discag:0880', 'fffddbaa031332cc90979e94'],
    ],
  );
  const campus = await loadCampus(fileURLToPath(new URL('public/data/campus.geojson', ROOT)));
  assert.doesNotThrow(() => checkBuildings(discag!, campus.keys));
  assert.throws(() => checkBuildings({ ...discag!, buildings: ['Cubo 99Z'] }, campus.keys), PdfConfigError);

  const bad = (mutate: (raw: typeof RAW & Record<string, unknown>) => void, field: string) => {
    const raw = structuredClone(RAW) as typeof RAW & Record<string, unknown>;
    mutate(raw);
    assert.throws(() => parseDiscagConfig(raw), (e: unknown) => e instanceof PdfConfigError && e.field === field, field);
  };
  bad((r) => (r.extra = 1), 'discag');
  bad((r) => (r.pageUrl = 'https://www.unical.it/contents/news/view/9999-orario/'), 'page_url');
  bad((r) => (r.semester = 3), 'semester');
  bad((r) => (r.rooms[0]!.pattern = '.*'), 'room_pattern');
  bad((r) => (r.rooms[0]!.pattern = 'A+'), 'room_pattern');
  bad((r) => (r.rooms[0]!.cubes = ['2Z']), 'room_cubes');
  bad((r) => (r.rooms[1]!.pattern = 'CONS2B'), 'room_duplicate');
  bad((r) => (r.feeds[0]!.ref = 'disu:0999'), 'feed_ref');
  bad((r) => (r.feeds[1]!.anchor = 'ltpr'), 'feed_duplicate');
  bad((r) => (r.feeds[0]!.codes = { '99': [1] } as unknown as typeof r.feeds[0]['codes']), 'feed_codes');
  bad((r) => (r.acceptedQuirks = [{ sha256: 'x', page: 1, code: 'academic_year_mismatch', note: 'n' }]), 'sha256');
  bad((r) => (r.acceptedQuirks = [{ sha256: SHA, page: 1, code: 'course_mismatch', note: 'n' }]), 'quirk_code');
  bad((r) => delete (r.feeds[0] as Record<string, unknown>).class, 'feed_class');
  bad((r) => (r.feeds[0]!.class = 'L-18 c.u.'), 'feed_class');
  bad((r) => (r.feeds[0]!.class = 'Laurea'), 'feed_class');
  bad((r) => (r.feeds[0]!.course = 'S'.repeat(189)), 'feed_course');
  const levelOf = (cls: string) => parseDiscagConfig({ ...RAW, feeds: [{ ...RAW.feeds[0]!, class: cls }] }).feeds[0]!.course;
  assert.equal(levelOf('LMG/01 R'), 'STUDI DI PROVA (ciclo unico)');
  assert.equal(levelOf('LM-41 R'), 'STUDI DI PROVA (ciclo unico)');
  assert.equal(levelOf('LM-77'), 'STUDI DI PROVA (magistrale)');
  const real = JSON.parse(readFileSync(fileURLToPath(new URL('config/pdf.json', ROOT)), 'utf8')) as { discag: unknown };
  assert.deepEqual(
    parseDiscagConfig(real.discag).feeds.map((f) => /\((triennale|magistrale|ciclo unico)\)$/.exec(f.course)?.[1]),
    ['triennale', 'magistrale', 'triennale', 'magistrale', 'triennale', 'ciclo unico'],
  );
  assert.throws(() => parsePdfConfig({ version: 1 }, PROFILES), (e: unknown) => e instanceof PdfConfigError && e.field === 'profile_missing');
  assert.throws(() => parsePdfConfig({ version: 1, discag: RAW }, PROFILES), (e: unknown) => e instanceof PdfConfigError && e.field === 'profile_missing');
  assert.throws(() => parsePdfConfig({ version: 1, discag: RAW, disu: DISU_RAW, other: {} }, PROFILES), (e: unknown) => e instanceof PdfConfigError && e.field === 'config');
  assert.throws(() => parsePdfConfig({ version: 1, discag: RAW, disu: [] }, PROFILES), (e: unknown) => e instanceof PdfConfigError && e.field === 'disu');
  assert.throws(() => parsePdfConfig({ version: 2, discag: RAW }, PROFILES), (e: unknown) => e instanceof PdfConfigError && e.field === 'version');
});

test('generator: the migration is the output of the generator and the output is stable', async () => {
  const profiles = await loadPdfConfig(PROFILES);
  const file = '20261110091000_pdf_feeds.sql';
  const migration = readFileSync(fileURLToPath(new URL(`supabase/migrations/${file}`, ROOT)), 'utf8');
  assert.deepEqual(profiles.map((p) => p.key), ['discag', 'disu']);
  const render = () => renderPdfFeeds(profiles, { addedAt: addedAtOf(file), refCheck: true });
  assert.equal(migration, render());
  assert.equal(render(), render());
  assert.equal((migration.match(/\('fffd[0-9a-f]{20}', 'pdf', 'discag:\d{4}'/g) ?? []).length, 6);
  assert.equal((migration.match(/\('fffd[0-9a-f]{20}', 'pdf', 'disu:[a-z0-9-]{1,40}'/g) ?? []).length, 18);
  assert.ok(migration.includes('add constraint calendars_pdf_ref'));
  assert.ok(!renderPdfFeeds([profiles[0]!], { addedAt: addedAtOf(file), refCheck: false }).includes('alter table'));
  assert.ok(!migration.includes('\u2014'));
  assert.throws(() => addedAtOf('pdf.sql'), PdfConfigError);

  const dir = mkdtempSync(join(tmpdir(), 'aule-gen-pdf-'));
  try {
    const script = fileURLToPath(new URL('../scripts/gen-pdf-feeds-sql.js', import.meta.url));
    const run = (args: string[]) => {
      const r = spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30_000 });
      return { status: r.status, stderr: r.stderr.trim() };
    };
    assert.deepEqual(run([]), { status: 1, stderr: 'usage' });
    assert.deepEqual(run([join(dir, file), 'nope']), { status: 1, stderr: 'usage' });
    assert.deepEqual(run([join(dir, file), 'discag', '--other']), { status: 1, stderr: 'usage' });
    assert.deepEqual(run([join(dir, file), 'discag,discag']), { status: 1, stderr: 'usage' });
    assert.deepEqual(run([join(dir, file), 'discag,nope']), { status: 1, stderr: 'usage' });
    assert.deepEqual(run([join(dir, file), 'discag,disu', '--ref-check']), { status: 0, stderr: '' });
    assert.equal(readFileSync(join(dir, file), 'utf8'), migration);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codes: closed mapping towards the database, positions only in where', () => {
  assert.equal(sourceFailure('academic_year_mismatch'), 'wrong_period');
  assert.equal(sourceFailure('wrong_page_title'), 'wrong_period');
  assert.equal(sourceFailure('column_rules'), 'bad_shape');
  assert.equal(sourceFailure('unplaced_cells'), 'bad_shape');
  assert.equal(sourceFailure('not_pdf'), 'bad_shape');
  assert.equal(sourceFailure('discovery_ambiguous'), 'bad_html');
  assert.equal(sourceFailure('poppler_timeout'), 'timeout');
  assert.equal(sourceFailure('poppler_missing'), 'unexpected');
  assert.equal(sourceFailure('too_many_entries'), 'too_many');
  assert.equal(where('p3b7d2'), 'p3b7d2');
  assert.equal(where('p4b4d0/p3b6d0'), 'p4b4d0/p3b6d0');
  assert.equal(where('Mario Rossi'), '');
  assert.equal(new PdfError('bad_header', 'label DOCENTI').where, '');
  assert.equal(where('p2g1d0h9'), 'p2g1d0h9');
  assert.equal(sourceFailure('header_mismatch'), 'bad_shape');
  assert.equal(sourceFailure('grid_missing'), 'bad_shape');
  assert.equal(sourceFailure('legend_row'), 'bad_shape');
});

test('the registry exposes the pdf adapter', () => {
  const adapters = createAdapters();
  assert.equal(adapters.pdf?.kind, 'pdf');
  assert.equal(adapters.planner?.kind, 'planner');
});

// ---------- poppler, on a PDF written by the test (skipped where poppler is not installed) ----------

function tinyPdf(streams: string[]): Uint8Array {
  const objs: string[] = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[2] = `<< /Type /Pages /Kids [${streams.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${streams.length} >>`;
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  streams.forEach((s, i) => {
    objs[4 + 2 * i] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
    objs[5 + 2 * i] = `<< /Length ${Buffer.byteLength(s, 'latin1')} >>\nstream\n${s}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let i = 1; i < objs.length; i += 1) {
    offsets[i] = Buffer.byteLength(out, 'latin1');
    out += `${i} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n${offsets.slice(1).map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

const POPPLER = await popplerBin();

test('poppler: words and rules of a real PDF, limits before anything runs', { skip: POPPLER ? false : 'poppler not installed' }, async () => {
  const page = '0 0 0 rg 100 495 200 0.5 re f 100 470 0.5 25.5 re f BT /F1 10 Tf 110 480 Td (LUNEDI) Tj ET';
  const [p] = await readPdf(tinyPdf([page]));
  assert.ok(p);
  assert.deepEqual(p.words.map((w) => w.t), ['LUNEDI']);
  assert.equal(p.rules.h.length, 1);
  assert.equal(p.rules.v.length, 1);
  assert.ok(Math.abs(p.rules.h[0]!.y - 99.75) < 0.01);
  await assert.rejects(readPdf(tinyPdf([page, page]), { maxPages: 1 }), (e: unknown) => e instanceof PdfError && e.code === 'page_count');
  await assert.rejects(readPdf(new TextEncoder().encode('<html></html>')), (e: unknown) => e instanceof PdfError && e.code === 'not_pdf');
  await assert.rejects(readPdf(new Uint8Array(MAX_PDF_BYTES + 1)), (e: unknown) => e instanceof PdfError && e.code === 'too_large');
  await assert.rejects(readPdf(new TextEncoder().encode('%PDF-1.4 broken')), (e: unknown) => e instanceof PdfError);
  await assert.rejects(readPdf(tinyPdf([page]), { bin: async () => null }), (e: unknown) => e instanceof PdfError && e.code === 'poppler_missing');
});

test('poppler: the DiSU reader keeps stroked rules drawn with a scale and a flip, never a rotation', { skip: POPPLER ? false : 'poppler not installed' }, async () => {
  const scaled = '0 0 0 rg 100 495 200 0.5 re f q 0.5 0 0 0.5 0 0 cm 0.2 w 0 0 0 RG 100 300 m 400 300 l S 150 250 m 150 350 l S Q';
  const [p] = await readPdf(tinyPdf([scaled]), { parseRules: disuRules });
  assert.ok(p);
  assert.deepEqual(p.rules.h.map((r) => [Math.round(r.y * 100) / 100, r.x0, r.x1]).sort((a, b) => a[0]! - b[0]!), [[99.75, 100, 300], [445, 50, 200]]);
  assert.deepEqual(p.rules.v.map((r) => [r.x, r.y0, r.y1]), [[75, 420, 470]]);
  const [core] = await readPdf(tinyPdf([scaled]));
  assert.equal(core?.rules.h.length, 1, 'the DISCAG reader takes rectangles only');
  const rotated = '0 0 0 rg 100 495 200 0.5 re f q 0 0.5 -0.5 0 595 0 cm 0.2 w 0 0 0 RG 100 300 m 400 300 l S Q';
  await assert.rejects(readPdf(tinyPdf([rotated]), { parseRules: disuRules }), (e: unknown) => e instanceof PdfError && e.code === 'rules_transformed');
});

test('poppler: an endless SVG is cut at its limit while it is written, the temporary folder goes away', { skip: POPPLER ? false : 'poppler not installed' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdf-fake-'));
  const ours = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('aule-pdf-')));
  try {
    // Writes without end to standard output; asked to write a file instead, it fails at once.
    const fake = join(dir, 'pdftocairo');
    writeFileSync(fake, '#!/bin/sh\nfor a in "$@"; do last=$a; done\n[ "$last" = "-" ] || exit 1\nexec /bin/cat /dev/zero\n', { mode: 0o755 });
    const before = ours();
    const page = '0 0 0 rg 100 495 200 0.5 re f BT /F1 10 Tf 110 480 Td (LUNEDI) Tj ET';
    const started = Date.now();
    await assert.rejects(
      readPdf(tinyPdf([page]), { bin: async () => ({ pdftotext: POPPLER!.pdftotext, pdftocairo: fake }) }),
      (e: unknown) => e instanceof PdfError && e.code === 'output_too_large',
    );
    assert.ok(Date.now() - started < 15_000);
    assert.deepEqual([...ours()].filter((n) => !before.has(n)), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- DiSU: page fixtures in the geometry of the real files (time column 40-110, day columns of 140 pt) ----------

const TL = 40;
const D0 = 110;
const DCW = 140;
const DR = D0 + 5 * DCW;
const WEEKDAYS = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì'];

function dw(t: string, x: number, cy: number): Word {
  const x1 = x + t.length * 3.6 + 1;
  return { x0: x, y0: cy - 3.5, x1, y1: cy + 3.5, cx: (x + x1) / 2, cy, t };
}

// Words of a text from x, in lines no wider than width and 7.5 pt apart.
function flow(text: string, x: number, width: number, cy: number): Word[] {
  const out: Word[] = [];
  let at = x;
  let y = cy;
  for (const t of text.split(/\s+/).filter(Boolean)) {
    const len = t.length * 3.6 + 1;
    if (at > x && at + len > x + width) {
      at = x;
      y += 7.5;
    }
    out.push(dw(t, at, y));
    at += len + 2.5;
  }
  return out;
}

interface DGrid {
  from: number;
  rowH?: number;
  rows?: number;
  head?: boolean;
  // "<row><day>" to the cell text.
  cells?: Record<string, string>;
  // "<row><day>" cells with no rule under them.
  merged?: string[];
}
type DItem = { text: string } | { grid: DGrid } | { legend: string[][]; head?: boolean } | { lettorato: string[][]; head?: boolean };

function disuPage(items: DItem[]): Page {
  const words: Word[] = [];
  const h: HRule[] = [];
  const v: VRule[] = [];
  let y = 30;
  for (const it of items) {
    if ('text' in it) {
      words.push(...flow(it.text, 200, 600, y + 4));
      y += 14;
    } else if ('grid' in it) {
      const g = it.grid;
      const rowH = g.rowH ?? 24;
      const n = g.rows ?? 4;
      let top = y;
      if (g.head !== false) {
        WEEKDAYS.forEach((t, i) => words.push(dw(t, D0 + i * DCW + 50, y + 8)));
        h.push({ y, x0: D0, x1: DR });
        top = y + 16;
      }
      const bottom = top + n * rowH;
      for (let i = 0; i <= 5; i += 1) v.push({ x: D0 + i * DCW, y0: y, y1: bottom });
      v.push({ x: TL, y0: top, y1: bottom });
      h.push({ y: top, x0: TL, x1: DR });
      for (let r = 0; r < n; r += 1) {
        const rt = top + r * rowH;
        words.push(...flow(`${g.from + r}:00 - ${g.from + r + 1}:00`, TL + 4, 66, rt + rowH / 2));
        h.push({ y: rt + rowH, x0: TL, x1: D0 });
        for (let d = 0; d < 5; d += 1) {
          if (!g.merged?.includes(`${r}${d}`)) h.push({ y: rt + rowH, x0: D0 + d * DCW, x1: D0 + (d + 1) * DCW });
        }
      }
      for (const [rd, text] of Object.entries(g.cells ?? {})) {
        words.push(...flow(text, D0 + Number(rd[1]) * DCW + 4, DCW - 8, top + Number(rd[0]) * rowH + 6));
      }
      y = bottom + 8;
    } else {
      const legend = 'legend' in it;
      const cols = legend ? [TL, 70, 380, 560, DR] : [70, 380, 560];
      const rows = legend ? it.legend : it.lettorato;
      const [x0, x1] = [cols[0]!, cols[cols.length - 1]!];
      let top = y;
      if (it.head !== false) {
        if (legend) words.push(dw('Anno', 42, y + 8), dw('Insegnamento', 75, y + 8), dw('Docente', 385, y + 8), ...flow('Data inizio corsi', 565, 200, y + 8));
        else words.push(dw('Insegnamento', 75, y + 8), ...flow('Data inizio lezioni', 385, 170, y + 8));
        h.push({ y, x0, x1 });
        top = y + 16;
      }
      h.push({ y: top, x0, x1 });
      rows.forEach((row, i) => {
        row.forEach((t, k) => words.push(...flow(t, cols[k]! + 4, cols[k + 1]! - cols[k]! - 8, top + i * 14 + 7)));
        h.push({ y: top + (i + 1) * 14, x0, x1 });
      });
      const bottom = top + rows.length * 14;
      // The "Anno" column has no left rule, as in the real legend.
      for (const x of legend ? cols.slice(1) : cols) v.push({ x, y0: y, y1: bottom });
      y = bottom + 8;
    }
  }
  return { width: 842, height: 595, words, rules: { h, v } };
}

const disuPages = (spec: DItem[][]): Page[] => spec.map(disuPage);

const D_HEADER = 'CORSO DI LAUREA IN STUDI DI PROVA - CLASSE L-1';
const G1: Record<string, string> = {
  '00': 'STORIA DI PROVA - Mario Rossi (Aula Storia 1)',
  '10': 'STORIA DI PROVA - Mario Rossi (Aula Storia 1)',
  '01': 'STORIA DI PROVA - Mario Rossi (Aula Burgarella)',
  '02':
    'LINGUA DI PROVA I (lettorato A-L) (Aula Dioniso) LINGUA DI PROVA I (LETTORATO Gruppo B (Aula N) ' +
    'STORIA DI PROVA - Maria Bianchi (Storia 2A) LINGUA DI PROVA I - Esercitazioni (Laboratorio CSDIM)',
  '23': 'RETORICA E PRATICHE DI PROVA (METRICA, RETORICA E PRATICHE DI PROVA) - Mario Rossi (Aula Iana',
  '34': 'LINGUA DI PROVA I - Mario Rossi (Aula Storia 2A) - (Aula Dioniso)',
};
const G2: Record<string, string> = {
  '00': 'FILOLOGIA DI PROVA - Maria Bianchi (Aula Iana)',
  '10': 'LINGUA E TRADUZIONE DI PROVA III - Mario Rossi (Aula Iana)',
  '21': 'LABORATORIO DI GRUPPI DI PROVA - Maria Bianchi (Aula Storia 1)',
  '32': 'STORIA DI PROVA - Mario Rossi (Aula Dioniso)',
};
const LEGEND1 = [
  ['1', 'STORIA DI PROVA', 'Mario Rossi', 'Inizio lezioni 21/09/2026'],
  ['1', 'LINGUA DI PROVA I', 'Maria Bianchi', 'Inizio lezioni 05/10/2026'],
  ['1', 'METRICA, RETORICA E PRATICHE DI PROVA', 'Mario Rossi', 'Inizio lezioni 21/09/2026'],
  ['2', 'FILOLOGIA DI PROVA', 'Maria Bianchi', 'Inizio lezioni da definire'],
  ['2', 'LINGUA E TRADUZIONE DI PROVA III – PRIMA LINGUA', 'Mario Rossi', 'Inizio lezioni 12/10/2026'],
  ['2', 'LABORATORIO DI GRUPPO DI PROVA', 'Maria Bianchi', 'Inizio lezioni 21/09/2026'],
];
const LETTORATO1 = [['LINGUA DI PROVA I e II (lettorato)', 'Inizio lezioni 02/11/2026']];

function disuSpec1(over: { g1?: Record<string, string>; g2?: Record<string, string>; legend?: string[][] } = {}): DItem[][] {
  return [
    [
      { text: D_HEADER },
      { text: 'PRIMO ANNO' },
      { grid: { from: 9, rowH: 66, cells: over.g1 ?? G1 } },
      { text: 'SECONDO ANNO' },
      { grid: { from: 14, cells: over.g2 ?? G2 } },
    ],
    [{ legend: over.legend ?? LEGEND1 }, { lettorato: LETTORATO1 }],
  ];
}

// The second file: one lesson shared by two curricula of different years, one title only in the first file.
function disuSpec2(): DItem[][] {
  return [
    [
      { text: 'CORSO DI LAUREA MAGISTRALE IN PROVE MODERNE' },
      { text: 'PRIMO ANNO - Curriculum A' },
      { grid: { from: 9, cells: { '00': 'ARCHIVISTICA DI PROVA - Mario Rossi (Aula Dioniso)' } } },
      { text: 'SECONDO ANNO - CURRICULUM B' },
      {
        grid: {
          from: 9,
          cells: { '00': 'ARCHIVISTICA DI PROVA - Mario Rossi (Aula Dioniso)', '11': 'STORIA DI PROVA - Maria Bianchi (Aula Storia 1)' },
        },
      },
      { legend: [['1', 'ARCHIVISTICA DI PROVA', 'Mario Rossi', 'Inizio lezioni 21/09/2026']] },
    ],
  ];
}

const DSEM = DCFG.calendar.semesters[1];
const readD = (pages: Page[], feed: DisuFeed = DF1): DisuFile => readDisuFile(pages, feed, DCFG.rooms);
function templateD(file: DisuFile, feed: DisuFeed = DF1, others: readonly Candidate[] = []): DisuTemplate {
  return disuTemplate(file, others, { feedId: feed.id, level: feed.level, semester: DSEM, suspensions: DCFG.suspensions });
}

const D_NAMES = new Map<string, string>([...DCFG.rooms.values()].map((r) => [r.syntheticId as string, r.name]));
const ROME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Rome',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
function romeText(ms: number): string {
  const p = Object.fromEntries(ROME.formatToParts(ms).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// One line per lesson: Rome day and times, title and room names, sorted.
function linesOf(entries: readonly WeeklyEntry[], from: string, to: string, planner: [string, string][] = []): string[] {
  const data = expandTemplate({ entries }, DCFG.calendar, ctx(from, to, planner));
  return data.parsed.lessons
    .map((l) => `${romeText(l.start)}-${romeText(l.end).slice(11)} ${l.title} [${l.roomIds.map((id) => D_NAMES.get(id) ?? `planner ${id}`).sort().join(',')}]`)
    .sort();
}

const WEEK1 = [
  '2026-11-09 09:00-11:00 STORIA DI PROVA [Stor 1]',
  '2026-11-09 14:00-15:00 FILOLOGIA DI PROVA [Aula Iana]',
  '2026-11-09 15:00-16:00 LINGUA E TRADUZIONE DI PROVA III – PRIMA LINGUA [Aula Iana]',
  '2026-11-10 09:00-10:00 STORIA DI PROVA [Stor 1]',
  '2026-11-10 16:00-17:00 LABORATORIO DI GRUPPO DI PROVA [Stor 1]',
  '2026-11-11 09:00-10:00 LINGUA DI PROVA I - Esercitazioni [Aula Informatica CSDIM]',
  '2026-11-11 09:00-10:00 LINGUA DI PROVA I - Lettorato - Gruppo B [Aula N]',
  '2026-11-11 09:00-10:00 LINGUA DI PROVA I - Lettorato A-L [Aula Dioniso]',
  '2026-11-11 09:00-10:00 STORIA DI PROVA [Stor 2A]',
  '2026-11-11 17:00-18:00 STORIA DI PROVA [Aula Dioniso]',
  '2026-11-12 11:00-12:00 RETORICA E PRATICHE DI PROVA (METRICA, RETORICA E PRATICHE DI PROVA) [Aula Iana]',
  '2026-11-13 12:00-13:00 LINGUA DI PROVA I [Aula Dioniso,Stor 2A]',
].sort();

test('disu layout: two grids, legend and lettorato table; every cell form of the real files', () => {
  const file = readD(disuPages(disuSpec1()));
  assert.deepEqual(file.grids, [
    { index: 1, year: 1, course: 'STUDI DI PROVA (L-1) (triennale)' },
    { index: 2, year: 2, course: 'STUDI DI PROVA (L-1) (triennale)' },
  ]);
  const t = templateD(file);
  assert.deepEqual(t.unplaced, []);
  assert.deepEqual(linesOf(t.entries, '2026-11-09', '2026-11-14'), WEEK1);
  assert.deepEqual(
    t.warnings.map((w) => `${w.code} ${w.where}`).sort(),
    ['legend_other_year p1g2d2h17', 'title_typo p1g2d1h16'],
  );
  const monday = t.entries.find((e) => e.day === 0 && e.startMin === 540)!;
  assert.deepEqual([monday.endMin, monday.courses, monday.year, monday.from], [660, ['STUDI DI PROVA (L-1) (triennale)'], 1, null]);
  // "Storia 1" and "Burgarella" are one room.
  const storia1 = t.entries.filter((e) => e.title === 'STORIA DI PROVA' && e.rooms[0]?.name === 'Stor 1');
  assert.equal(new Set(storia1.map((e) => e.rooms[0]!.syntheticId)).size, 1);
  assert.equal(storia1.length, 2);
});

test('disu layout: page breaks inside a grid, after a year line and inside the legend; merged cells and the 19-20 row', () => {
  const [p1, p2] = disuSpec1() as [DItem[], DItem[]];
  const g2Rows = (shift: number, rows: string[]) =>
    Object.fromEntries(Object.entries(G2).filter(([k]) => rows.includes(k[0]!)).map(([k, t]) => [`${Number(k[0]) - shift}${k[1]}`, t]));
  const split: DItem[][] = [
    [...p1.slice(0, 4), { grid: { from: 14, rows: 1, cells: g2Rows(0, ['0']) } }],
    [{ grid: { from: 15, rows: 3, head: false, cells: g2Rows(1, ['1', '2', '3']) } }, ...p2],
  ];
  const yearAlone: DItem[][] = [p1.slice(0, 4), [p1[4]!, ...p2]];
  const legendSplit: DItem[][] = [
    [...p1, { legend: LEGEND1.slice(0, 3) }],
    [{ legend: LEGEND1.slice(3), head: false }, { lettorato: LETTORATO1 }],
  ];
  for (const [name, spec] of [['grid', split], ['year line', yearAlone], ['legend', legendSplit]] as const) {
    const t = templateD(readD(disuPages(spec)));
    assert.deepEqual(t.unplaced, [], name);
    assert.deepEqual(linesOf(t.entries, '2026-11-09', '2026-11-14'), WEEK1, name);
  }

  const late = disuSpec1({
    g2: { '00': 'FILOLOGIA DI PROVA - Maria Bianchi (Aula Iana)', '34': 'FILOLOGIA DI PROVA - Maria Bianchi (Aula Iana)' },
  });
  (late[0]![4] as { grid: DGrid }).grid = { from: 16, merged: ['00'], cells: (late[0]![4] as { grid: DGrid }).grid.cells! };
  const lines2 = linesOf(templateD(readD(disuPages(late))).entries, '2026-11-09', '2026-11-14');
  assert.ok(lines2.includes('2026-11-09 16:00-18:00 FILOLOGIA DI PROVA [Aula Iana]'), 'a merged cell is one lesson of two hours');
  assert.ok(lines2.includes('2026-11-13 19:00-20:00 FILOLOGIA DI PROVA [Aula Iana]'));
});

test('disu dates: teaching and lettorato starts, closed days, December suspension by level and year, clock change', () => {
  const e = templateD(readD(disuPages(disuSpec1()))).entries;
  const count = (from: string, to: string) => linesOf(e, from, to).length;
  assert.equal(count('2026-09-28', '2026-10-03'), 7, 'before the starts of 05/10, 12/10 and 02/11');
  assert.equal(count('2026-10-26', '2026-10-31'), 10, 'the lettorato starts on 02/11');
  assert.equal(count('2026-12-07', '2026-12-12'), 10, '08/12 is closed');
  assert.equal(count('2026-12-14', '2026-12-19'), 8, 'the second year is suspended, the first is not');
  assert.equal(count('2026-12-21', '2026-12-23'), 0);
  assert.ok(linesOf(e, '2026-09-21', '2026-09-22').includes('2026-09-21 14:00-15:00 FILOLOGIA DI PROVA [Aula Iana]'), 'da definire: from the semester start');
  const at = (from: string, to: string) =>
    expandTemplate({ entries: e }, DCFG.calendar, ctx(from, to)).parsed.lessons.filter((l) => l.title === 'STORIA DI PROVA' && l.end - l.start === 7_200_000);
  assert.equal(new Date(at('2026-10-19', '2026-10-20')[0]!.start).toISOString(), '2026-10-19T07:00:00.000Z');
  assert.equal(new Date(at('2026-10-26', '2026-10-27')[0]!.start).toISOString(), '2026-10-26T08:00:00.000Z');
  assert.throws(() => expandTemplate({ entries: e }, DCFG.calendar, ctx('2027-03-01', '2027-03-15')), (x: unknown) => x instanceof PdfError && x.code === 'outside_semester');
  const brk = expandTemplate({ entries: e }, DCFG.calendar, ctx('2027-01-25', '2027-02-01'));
  assert.equal(brk.parsed.lessons.length, 0, 'the break between the semesters has no lessons and is covered');
});

test('disu dates: a start after the end of the semester fails its cells, its lessons never vanish', () => {
  const legend = LEGEND1.map((r) => (r[1] === 'STORIA DI PROVA' ? [r[0]!, r[1]!, r[2]!, 'Inizio lezioni 21/09/2027'] : r));
  const t = templateD(readD(disuPages(disuSpec1({ legend }))));
  assert.ok(t.unplaced.length > 0);
  assert.ok(t.unplaced.every((u) => u.code === 'start_outside_semester' && /^p\d+g\d+d\dh\d+$/.test(u.where)));
  const early = LEGEND1.map((r) => (r[1] === 'STORIA DI PROVA' ? [r[0]!, r[1]!, r[2]!, 'Inizio lezioni 21/09/2025'] : r));
  assert.deepEqual(templateD(readD(disuPages(disuSpec1({ legend: early })))).unplaced, [], 'an earlier start only adds lessons');
});

test('disu titles: a title of another file, the same lesson in two curricula of different years', () => {
  const f1 = readD(disuPages(disuSpec1()));
  const f2 = readD(disuPages(disuSpec2()), DF2);
  assert.deepEqual(
    templateD(f2, DF2).unplaced.map((u) => `${u.code} ${u.where}`),
    ['unknown_title p1g2d1h10'],
    'alone, the second file cannot place the title of the first',
  );
  const t = templateD(f2, DF2, f1.candidates);
  assert.deepEqual(t.unplaced, []);
  assert.ok(t.warnings.some((w) => w.code === 'title_other_pdf' && w.where === 'p1g2d1h10'));
  const data = expandTemplate({ entries: t.entries }, DCFG.calendar, ctx('2026-11-09', '2026-11-14'));
  assert.deepEqual(
    data.parsed.lessons.map((l) => [romeText(l.start), l.title, l.courses, l.year]),
    [
      ['2026-11-09 09:00', 'ARCHIVISTICA DI PROVA', ['PROVE MODERNE - CURRICULUM A (magistrale)', 'PROVE MODERNE - CURRICULUM B (magistrale)'], null],
      ['2026-11-10 10:00', 'STORIA DI PROVA', ['PROVE MODERNE - CURRICULUM B (magistrale)'], 2],
    ],
  );
  const december = expandTemplate({ entries: t.entries }, DCFG.calendar, ctx('2026-12-14', '2026-12-19'));
  assert.deepEqual(
    december.parsed.lessons.map((l) => [romeText(l.start), l.courses, l.year]),
    [['2026-12-14 09:00', ['PROVE MODERNE - CURRICULUM A (magistrale)'], 1]],
    'only the second year of a master course is suspended',
  );
  assert.equal(new Set([...linesOf(t.entries, '2026-11-09', '2026-11-14')]).size, 2);
});

const firstCy = (p: Page, t: string) => Math.min(...p.words.filter((w) => w.t === t).map((w) => w.cy));

const D_MUTATIONS: [string, () => Page[], PdfCode][] = [
  ['day renamed', () => mutate((p) => p.words.filter((w) => w.t === 'Martedì').forEach((w) => (w.t = 'Marte'))), 'day_headers'],
  ['saturday', () => mutate((p) => p.words.push(dw('Sabato', 800, firstCy(p, 'Lunedì')))), 'day_headers'],
  [
    'days swapped',
    () =>
      mutate((p) => {
        const cy = firstCy(p, 'Lunedì');
        const a = p.words.find((w) => w.t === 'Martedì' && w.cy === cy)!;
        const b = p.words.find((w) => w.t === 'Mercoledì' && w.cy === cy)!;
        [a.t, b.t] = [b.t, a.t];
      }),
    'day_order',
  ],
  ['label moved to 11:30', () => mutate((p) => (p.words.find((w) => w.t === '11:00' && w.cy === firstCy(p, '11:00'))!.t = '11:30')), 'time_step'],
  [
    'row rule removed',
    () =>
      mutate((p) => {
        const y = [...new Set(p.rules.h.filter((r) => r.x0 === TL && r.x1 === D0).map((r) => r.y))].sort((a, b) => a - b)[1]!;
        p.rules.h = p.rules.h.filter((r) => !(r.y === y && r.x0 === TL && r.x1 === D0));
      }),
    'row_gap',
  ],
  ['word across two columns', () => mutate((p) => p.words.push(dw('XXXXXXXX', D0 + DCW - 5, firstCy(p, '9:00')))), 'word_crosses_column'],
  ['word across two rows', () => mutate((p) => p.words.push(dw('PROVA', D0 + 10, firstCy(p, '9:00') + 33 + 2))), 'word_crosses_row'],
  ['label left of the time column', () => mutate((p) => p.words.filter((w) => w.cy === firstCy(p, '9:00') && w.x1 < D0).forEach((w) => ((w.x0 -= 10), (w.x1 -= 10), (w.cx -= 10)))), 'stray_words'],
  ['day column rule removed', () => mutate((p) => (p.rules.v = p.rules.v.filter((r) => r.x !== D0 + DCW))), 'column_gap'],
  ['note after the tables', () => disuPages([disuSpec1()[0]!, [...disuSpec1()[1]!, { text: 'Avviso: lezioni sospese' }]]), 'unexpected_text'],
  ['note between grids', () => disuPages([[...disuSpec1()[0]!.slice(0, 3), { text: 'Avviso' }, ...disuSpec1()[0]!.slice(3)], disuSpec1()[1]!]), 'unexpected_text'],
  ['header changed', () => withItem(0, 0, { text: 'CORSO DI LAUREA IN ALTRI STUDI - CLASSE L-1' }), 'header_mismatch'],
  ['no header', () => disuPages([disuSpec1()[0]!.slice(1), disuSpec1()[1]!]), 'course_header'],
  ['year renamed', () => withItem(0, 3, { text: 'QUARTO ANNO' }), 'year_line'],
  ['grid missing', () => disuPages([disuSpec1()[0]!.slice(0, 3), disuSpec1()[1]!]), 'grid_missing'],
  ['grid twice', () => disuPages([disuSpec1()[0]!, [{ text: 'PRIMO ANNO' }, { grid: { from: 9, cells: {} } }, ...disuSpec1()[1]!]]), 'grid_duplicate'],
  ['legend before a grid', () => disuPages([[...disuSpec1()[0]!.slice(0, 3), { legend: LEGEND1 }], [...disuSpec1()[0]!.slice(3)]]), 'legend_position'],
  ['no legend', () => disuPages([disuSpec1()[0]!]), 'no_legend'],
  ['legend twice', () => disuPages([disuSpec1()[0]!, [{ legend: LEGEND1 }, { legend: LEGEND1 }]]), 'legend_header'],
  ['legend date in words', () => disuPages(disuSpec1({ legend: [...LEGEND1.slice(1), ['1', 'STORIA DI PROVA', 'Mario Rossi', 'Inizio lezioni ventuno settembre']] })), 'legend_row'],
  ['teacher in the title column', () => disuPages(disuSpec1({ legend: [...LEGEND1, ['1', 'Prof. Mario Rossi', 'STORIA', 'Inizio lezioni 21/09/2026']] })), 'legend_row'],
  ['lettorato row without date', () => withItem(1, 1, { lettorato: [['LINGUA DI PROVA I (lettorato)', 'presto']] }), 'lettorato_table'],
  ['grid until 22:00', () => withItem(0, 4, { grid: { from: 18, cells: {} } }), 'time_range'],
  ['grid of three rows', () => withItem(0, 4, { grid: { from: 14, rows: 3, cells: {} } }), 'time_labels'],
  ['no text', () => disuPages([[], []]), 'no_text_layer'],
];

function mutate(fn: (p: Page) => void): Page[] {
  const pages = disuPages(disuSpec1());
  fn(pages[0]!);
  return pages;
}

function withItem(page: number, i: number, item: DItem): Page[] {
  const spec = disuSpec1();
  spec[page]![i] = item;
  return disuPages(spec);
}

test('disu layout: every change of the layout refuses the whole file with its code', () => {
  for (const [name, pages, code] of D_MUTATIONS) {
    assert.throws(() => readD(pages()), (e: unknown) => e instanceof PdfError && e.code === code, name);
  }
  const lm = disuSpec2();
  lm[0]!.splice(3, 0, { text: 'TERZO ANNO' }, { grid: { from: 14, cells: {} } });
  assert.throws(() => readD(disuPages(lm), DF2), (e: unknown) => e instanceof PdfError && e.code === 'year_range');
  const extra = disuSpec1();
  extra[0]!.push({ text: 'TERZO ANNO' }, { grid: { from: 9, cells: { '00': 'STORIA DI PROVA (Aula Iana)' } } });
  const kept = readD(disuPages(extra));
  assert.deepEqual(kept.warnings, [{ code: 'grid_extra', where: 'p1g3' }], 'an extra grid is kept and reported');
  assert.equal(kept.grids[2]!.course, 'STUDI DI PROVA (L-1) (triennale)');
});

test('disu cells: a cell that cannot be placed fails the file and is reported by position only', () => {
  const cases: [string, string, string[]][] = [
    ['unknown title', 'ARCHEOLOGIA DI PROVA - Mario Rossi (Aula Storia 1)', ['unknown_title']],
    ['unknown room', 'STORIA DI PROVA - Mario Rossi (Aula Marte)', ['unknown_room']],
    ['text after the room', 'STORIA DI PROVA (Aula Storia 1) Mario Rossi', ['text_without_room']],
    ['room without parentheses', 'STORIA DI PROVA - Mario Rossi Aula Storia 1', ['text_without_room']],
    ['room outside parentheses', 'STORIA DI PROVA - Aula Rossi (Aula Storia 1)', ['room_outside_parentheses']],
    ['two titles at one typo', 'STORIA DI PROVE - Mario Rossi (Aula Storia 1)', ['ambiguous_title']],
  ];
  const legend = [...LEGEND1, ['1', 'STORIA DI PROVO', 'Maria Bianchi', 'Inizio lezioni 21/09/2026']];
  for (const [name, text, codes] of cases) {
    const t = templateD(readD(disuPages(disuSpec1({ g1: { ...G1, '01': text }, legend }))));
    assert.deepEqual(t.unplaced.map((u) => u.code).sort(), [...codes].sort(), name);
    assert.ok(t.unplaced.every((u) => u.where === 'p1g1d1h9'), name);
  }
});

test('disu cells: a title over 300 characters fails its cell, never a lesson skipped later', () => {
  const parent = Array.from({ length: 50 }, () => 'ABC').join(' ');
  const module = Array.from({ length: 25 }, () => 'ABC').join(' ');
  const file: DisuFile = {
    grids: [{ index: 1, year: 1, course: 'STUDI DI PROVA (L-1)' }],
    cells: [
      {
        grid: 1,
        day: 0,
        startMin: 540,
        endMin: 600,
        where: 'p1g1d0h9',
        problems: [],
        lessons: [{ seg: `${module} (${parent}) - Mario Rossi `, rooms: [DCFG.rooms.get('IANA')!] }],
      },
    ],
    candidates: [],
    warnings: [],
  };
  const others: Candidate[] = [{ key: parent, title: parent, short: null, year: 1, start: null, lettorato: false }];
  const t = templateD(file, DF1, others);
  assert.deepEqual(t.unplaced, [{ code: 'cell_too_long', where: 'p1g1d0h9' }]);
  assert.deepEqual(t.entries, []);
});

test('disu rules: rectangles and stroked lines, scale and flip applied, rotation refused', () => {
  const svg = (body: string) => `<svg><defs><path d="M 0 0 L 1 0 L 1 0.5 L 0 0.5 Z"/></defs>${body}</svg>`;
  const rules = disuRules(
    svg(
      '<path fill="rgb(0%, 0%, 0%)" d="M 99.77 313.32 L 100.49 313.32 L 100.49 99.84 L 99.77 99.84 Z M 10 20 L 210 20 L 210 20.7 L 10 20.7 Z M 99.77 313.32 "/>' +
        '<path fill="none" stroke-width="0.17" stroke="rgb(0%, 0%, 0%)" d="M 115.5 729.6 L 115.5 444.3 " transform="matrix(0.999286, 0, 0, -0.999286, -0.000000000000026257, 840.934902)"/>' +
        '<path fill="none" stroke-width="0.17" stroke="rgb(0%, 0%, 0%)" d="M 100 500 L 300 500 "/>' +
        '<path fill="none" stroke="none" d="M 100 600 L 300 600 "/>' +
        '<path d="M 0 0 C 1 1 2 2 3 3"/>',
    ),
  );
  assert.equal(rules.v.length, 2);
  assert.equal(rules.h.length, 2);
  const flipped = rules.v.find((r) => r.x > 115)!;
  assert.ok(Math.abs(flipped.x - 115.5 * 0.999286) < 0.001);
  assert.ok(Math.abs(flipped.y0 - (840.934902 - 729.6 * 0.999286)) < 0.001);
  const refused = (body: string) => assert.throws(() => disuRules(svg(body)), (e: unknown) => e instanceof PdfError && e.code === 'rules_transformed', body);
  refused('<path stroke="rgb(0%, 0%, 0%)" d="M 1 1 L 1 200" transform="matrix(0, -0.5, -0.5, 0, 595, 595)"/>');
  refused('<path stroke="rgb(0%, 0%, 0%)" d="M 1 1 L 1 200" transform="rotate(90)"/>');
  refused('<g transform="matrix(1, 0, 0, 1, 5, 5)"><path d="M 1 1 L 3 1 L 3 1.5 L 1 1.5 Z"/></g>');
});

test('disu config: the real section, its rooms shared with DISCAG and the Planner; invalid sections refused', async () => {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('config/pdf.json', ROOT)), 'utf8')) as { discag: unknown; disu: unknown };
  const real = parseDisuConfig(raw.disu);
  assert.equal(real.feeds.length, 18);
  assert.ok(real.feeds.every((f) => /^disu:[a-z0-9-]{1,40}$/.test(f.ref) && f.id === feedId('pdf', f.ref)));
  assert.equal(real.feeds.find((f) => f.ref === 'disu:cd-l3')?.id, feedId('pdf', 'disu:cd-l3'));
  assert.ok(real.feeds.every((f) => f.degree === (f.level === 'LT' ? 'triennale' : 'magistrale')));
  const campus = await loadCampus(fileURLToPath(new URL('public/data/campus.geojson', ROOT)));
  assert.doesNotThrow(() => checkBuildings(disuProfile.parse(raw.disu), campus.keys));
  // The same room seen by two sources has one id: Planner key where the Planner has it, the DISCAG name otherwise.
  const discag = parseDiscagConfig(raw.discag);
  const discagRoom = (name: string) => discag.rooms.find((r) => r.room.name === name)!.room;
  assert.equal(real.rooms.get('STORIA1')!.syntheticId, discagRoom('Stor 1').syntheticId);
  assert.equal(real.rooms.get('BURGARELLA'), real.rooms.get('STORIA1'));
  assert.equal(real.rooms.get('STORIA3')!.matchKey, discagRoom('Stor 3').matchKey);
  assert.equal(real.rooms.get('CONSOLIDATA2B')!.matchKey, discagRoom('CONSOLIDATA 2B').matchKey);
  assert.equal(real.rooms.get('N')!.matchKey, roomMatchKey('Cubo 18C', 'N'));
  assert.equal(real.rooms.get('IRIS')!.matchKey, roomMatchKey('Cubo 29C', 'Consolidata 29C1-Iris'));

  const bad = (mutate: (r: Record<string, unknown> & typeof DISU_RAW) => void, field: string) => {
    const r = structuredClone(DISU_RAW) as Record<string, unknown> & typeof DISU_RAW;
    mutate(r);
    assert.throws(() => parseDisuConfig(r), (e: unknown) => e instanceof PdfConfigError && e.field === field, field);
  };
  bad((r) => (r.extra = 1), 'disu');
  bad((r) => (r.indexUrl = 'https://www.unical.it/orario-lezioni/'), 'index_url');
  bad((r) => (r.newsSlug = 'orario.*'), 'news_slug');
  bad((r) => (r.filePrefix = 'Orario(.*)_'), 'file_prefix');
  bad((r) => (r.suspensions[0]!.years = [7]), 'suspension');
  bad((r) => (r.suspensions[0]!.first = '2026-08-01'), 'suspension');
  bad((r) => (r.feeds[0]!.ref = 'discag:prova'), 'feed_ref');
  bad((r) => (r.feeds[0]!.ref = 'disu:Prova_L1'), 'feed_ref');
  bad((r) => (r.feeds[0]!.stem = 'PROVA.*'), 'feed_stem');
  bad((r) => (r.feeds[1]!.stem = 'PROVA_L1_X'), 'feed_stem');
  bad((r) => (r.feeds[1]!.grids = ['3']), 'feed_grids');
  bad((r) => (r.feeds[1]!.grids = ['1|A', '1|a']), 'feed_grids');
  bad((r) => {
    r.feeds[1]!.course = 'P'.repeat(100);
    r.feeds[1]!.grids = [`1|${'A'.repeat(100)}`, '2|CURRICULUM B'];
  }, 'feed_grids');
  bad((r) => (r.feeds[0]!.level = 'LMCU'), 'feed_level');
  bad((r) => (r.feeds[0]!.course = 'Studi di prova'), 'feed_course');
  bad((r) => (r.feeds[0]!.course = 'S'.repeat(189)), 'feed_course');
  bad((r) => {
    r.feeds[1]!.course = 'P'.repeat(100);
    r.feeds[1]!.grids = [`1|${'A'.repeat(85)}`, '2|CURRICULUM B'];
  }, 'feed_grids');
  const fits = structuredClone(DISU_RAW);
  fits.feeds[1]!.course = 'P'.repeat(100);
  fits.feeds[1]!.grids = [`1|${'A'.repeat(84)}`, '2|CURRICULUM B'];
  assert.equal(parseDisuConfig(fits).feeds[1]!.degree, 'magistrale', 'a label of exactly 200 characters fits');
  bad((r) => (r.rooms[1]!.aliases = ['STORIA1']), 'room_duplicate');
  bad((r) => (r.rooms[1]!.aliases = ['storia 2a']), 'room_aliases');
  bad((r) => (r.rooms[1]!.name = 'Stor 1'), 'room_duplicate');
  bad((r) => (r.rooms[0]!.building = '?'), 'room_building');
});

// ---------- DiSU discovery and adapter ----------

const NEWS_PATH = '/didattica/offerta-formativa/orario-lezioni/contents/news/view/99999-orario-i-semestre-aa-20262027-disu/';
const NEWS_URL = sourceUrl(`https://disu.unical.it${NEWS_PATH}`);
const MEDIA = 'https://www.unical.it/media/medias/2026/Orario_2026_2027_I_semestre_';
const D_FILES = [`${MEDIA}PROVA_L1_Ab3XyZ9.pdf`, `${MEDIA}PROVA_LM.pdf`, `${MEDIA}NUOVO_CORSO_x1.pdf`];

function disuIndex(links: [string, string][]): string {
  return `<html><body><h1>Orario delle lezioni</h1>${links.map(([h, t]) => `<a class="no-color" href="${h}" title="${t}">${t}</a>`).join('')}</body></html>`;
}

function disuNews(title: string, files: string[]): string {
  return `<html><body><h1 class="mb-4 lighter">${title}</h1><p>Corsi di Laurea</p>${files.map((f) => `<p><a href="${f}">Corso</a></p>`).join('')}</body></html>`;
}

const D_TITLE = 'Orario I semestre - a.a. 2026/2027 - DISU';
const D_INDEX = disuIndex([
  [NEWS_PATH, D_TITLE],
  [NEWS_PATH, D_TITLE],
  ['/didattica/offerta-formativa/orario-lezioni/contents/news/view/88888-orario-i-semestre-aa-20252026-disu/', 'Orario I semestre - a.a. 2025/2026 - DISU'],
]);

test('disu discovery: one news by path and text, one file per feed by name, extra files only counted', () => {
  assert.equal(findNews(D_INDEX, DCFG), NEWS_URL);
  assert.equal(findNews(disuIndex([[NEWS_PATH, 'Orario I  semestre&nbsp;- a.a. 2026/2027 - DISU']]), DCFG), NEWS_URL);
  const refused = (code: PdfCode, html: string) => refusedWith(code, () => findNews(html, DCFG));
  refused('discovery_ambiguous', disuIndex([[NEWS_PATH, D_TITLE], [NEWS_PATH.replace('99999', '99998'), D_TITLE]]));
  refused('discovery_missing', disuIndex([[NEWS_PATH, 'Orario II semestre - a.a. 2026/2027 - DISU']]));
  refused('discovery_missing', disuIndex([[`https://www.unical.it${NEWS_PATH}`, D_TITLE]]));
  refused('discovery_missing', disuIndex([[`${NEWS_PATH}?x=1`, D_TITLE]]));
  refused('discovery_missing', disuIndex([[NEWS_PATH.replace('99999-', 'gAAAAAB-'), D_TITLE]]));

  const ok = findFiles(disuNews(D_TITLE, [...D_FILES, D_FILES[0]!]), NEWS_URL, DCFG);
  assert.deepEqual(Object.fromEntries(ok.links), { 'disu:prova-l1': { url: D_FILES[0] }, 'disu:prova-lm': { url: D_FILES[1] } });
  assert.equal(ok.extra, 1);
  refusedWith('wrong_page_title', () => findFiles(disuNews('Orario II semestre - a.a. 2026/2027 - DISU', D_FILES), NEWS_URL, DCFG));
  refusedWith('bad_html', () => findFiles(disuNews(D_TITLE, D_FILES) + '<h1>altro</h1>', NEWS_URL, DCFG));
  const missing = findFiles(
    disuNews(D_TITLE, [
      D_FILES[0]!,
      'https://example.com/media/medias/2026/Orario_2026_2027_I_semestre_PROVA_LM.pdf',
      'http://www.unical.it/media/medias/2026/Orario_2026_2027_I_semestre_PROVA_LM.pdf',
      `${MEDIA}PROVA_LM_gAAAAAB.pdf`,
      `${MEDIA}PROVA_LM.xlsx`,
    ]),
    NEWS_URL,
    DCFG,
  );
  assert.deepEqual(missing.links.get('disu:prova-lm'), { code: 'discovery_missing' });
  const twice = findFiles(disuNews(D_TITLE, [...D_FILES, `${MEDIA}PROVA_L1.pdf`]), NEWS_URL, DCFG);
  assert.deepEqual(twice.links.get('disu:prova-l1'), { code: 'discovery_ambiguous' });
  assert.ok('url' in (twice.links.get('disu:prova-lm') ?? {}), 'the other feed goes on');
});

function disuSetup(over: { index?: string; news?: string; pdf?: (url: string, init: RequestInit) => Response; pages?: { L1?: Page[]; LM?: Page[] } } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const readOptions: (ReadPdfOptions | undefined)[] = [];
  const log = recorder();
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const html = { headers: { 'content-type': 'text/html; charset=utf-8' } };
    if (url === DCFG.indexUrl) return new Response(over.index ?? D_INDEX, html);
    if (url === NEWS_URL) return new Response(over.news ?? disuNews(D_TITLE, D_FILES), html);
    if (over.pdf) return over.pdf(url, init ?? {});
    return new Response(PDF_BYTES(url.includes('PROVA_LM') ? 'LM' : 'L1'), { headers: PDF_HEADERS });
  }) as typeof fetch;
  const options: PdfAdapterOptions = {
    fetchImpl,
    log,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    config: async () => [disuProfile.parse(DISU_RAW)],
    readPdf: async (bytes, read) => {
      readOptions.push(read);
      const lm = new TextDecoder().decode(bytes).endsWith('LM');
      return (lm ? over.pages?.LM : over.pages?.L1) ?? disuPages(lm ? disuSpec2() : disuSpec1());
    },
  };
  return { adapter: pdfAdapter(options), calls, sleeps, log, readOptions };
}

const D_FEED = (f: DisuFeed): Feed => ({ id: f.id, source: 'pdf', ref: f.ref });

test('disu adapter: polite sequence, two phases, conditional GET, extra files never requested', async () => {
  const s = disuSetup();
  await s.adapter.prepare();
  assert.deepEqual(s.calls.map((c) => c.url), [DCFG.indexUrl, NEWS_URL, D_FILES[0], D_FILES[1]]);
  assert.deepEqual(s.sleeps, [2000, 2000, 2000]);
  for (const c of s.calls) {
    assert.equal((c.init.headers as Record<string, string>)['User-Agent'], USER_AGENT);
    assert.equal(c.init.redirect, 'error');
  }
  assert.ok(s.readOptions.length === 2 && s.readOptions.every((o) => typeof o?.parseRules === 'function'), 'the DiSU rule reader');
  const week = ctx('2026-11-09', '2026-11-14');
  assert.equal((await s.adapter.fetch(D_FEED(DF1), week)).parsed.lessons.length, 12);
  const lm = await s.adapter.fetch(D_FEED(DF2), week);
  assert.deepEqual(lm.parsed.lessons.map((l) => l.title), ['ARCHIVISTICA DI PROVA', 'STORIA DI PROVA']);
  assert.ok(s.log.lines.some((l) => l.includes('"code":"discovery_extra"') && l.includes('"count":1')));
  assert.ok(s.log.lines.some((l) => l.includes('"code":"title_other_pdf"')));

  const second = disuSetup({
    pdf: (url, init) => {
      const h = init.headers as Record<string, string>;
      return h['If-None-Match'] === '"v1"'
        ? new Response(null, { status: 304 })
        : new Response(PDF_BYTES(url.includes('PROVA_LM') ? 'LM' : 'L1'), { headers: PDF_HEADERS });
    },
  });
  await second.adapter.prepare();
  await second.adapter.prepare();
  assert.equal(second.readOptions.length, 2, 'the second run reuses what the first one read');
  assert.equal((await second.adapter.fetch(D_FEED(DF2), week)).parsed.lessons.length, 2, 'titles of the other file still lent');
});

test('disu adapter: failures are closed codes, a missing file fails the cells that need its titles', async () => {
  const week = ctx('2026-11-09', '2026-11-14');
  const unplaced = disuPages(disuSpec1({ g1: { ...G1, '01': 'STORIA DI PROVA - Mario Rossi (Aula Marte)' } }));
  const cases: [string, Parameters<typeof disuSetup>[0], string, string][] = [
    ['index missing', { index: '<html><body></body></html>' }, 'bad_html', 'bad_html'],
    ['news of another semester', { news: disuNews('Orario II semestre - a.a. 2026/2027 - DISU', D_FILES) }, 'wrong_period', 'wrong_period'],
    ['file missing from the news', { news: disuNews(D_TITLE, [D_FILES[1]!]) }, 'bad_html', 'bad_shape'],
    ['first file gone', { pdf: (url) => (url.includes('PROVA_L1') ? new Response('no', { status: 404 }) : new Response(PDF_BYTES('LM'), { headers: PDF_HEADERS })) }, 'http_status', 'bad_shape'],
    ['html instead of pdf', { pdf: () => new Response('<html>', { headers: { 'content-type': 'application/pdf' } }) }, 'bad_shape', 'bad_shape'],
    ['redirect refused', { pdf: () => { throw new TypeError('fetch failed'); } }, 'network', 'network'],
    ['unplaced cell', { pages: { L1: unplaced } }, 'bad_shape', 'ok'],
    ['header of another course', { pages: { L1: disuPages(disuSpec2()) } }, 'bad_shape', 'bad_shape'],
  ];
  for (const [name, over, first, second] of cases) {
    const s = disuSetup(over);
    await s.adapter.prepare();
    assert.equal(await failureOf(s.adapter.fetch(D_FEED(DF1), week)), first, name);
    assert.equal(await failureOf(s.adapter.fetch(D_FEED(DF2), week)), second, name);
    assert.ok(s.log.lines.every((l) => !l.includes('https:') && !l.includes('PROVA') && !l.includes('Rossi')), `${name}: no URL or text in logs`);
  }
  const s = disuSetup();
  await s.adapter.prepare();
  assert.equal(await failureOf(s.adapter.fetch(D_FEED(DF1), ctx('2027-03-01', '2027-03-15'))), 'wrong_period');
  assert.equal(await failureOf(s.adapter.fetch({ ...D_FEED(DF1), ref: 'disu:altro' }, week)), 'unexpected');
});

test('disu least data: teacher names never reach the payload, the logs or the parsed data', async () => {
  const s = disuSetup();
  await s.adapter.prepare();
  const all: unknown[] = [s.log.lines];
  for (const f of [DF1, DF2]) {
    const data = await s.adapter.fetch(D_FEED(f), ctx('2026-11-02', '2026-11-16'));
    assert.ok(data.parsed.lessons.length > 0 && data.parsed.lessons.every((l) => l.teachers.length === 0));
    all.push(data, buildPayload(data.parsed, data.from, data.to));
  }
  const text = JSON.stringify(all).toUpperCase();
  for (const name of ['ROSSI', 'MARIO', 'BIANCHI', 'MARIA', 'DOCENTE']) assert.ok(!text.includes(name), name);
});

test('disu ids: feed ids from the ref, lesson ids stable and independent of the Planner rooms', () => {
  assert.equal(DF1.id, feedId('pdf', 'disu:prova-l1'));
  assert.notEqual(DF1.id, feedId('pdf', 'disu|prova-l1'));
  const once = templateD(readD(disuPages(disuSpec1()))).entries;
  const again = templateD(readD(disuPages(disuSpec1()))).entries;
  const n = DCFG.rooms.get('N')!;
  const plain = expandTemplate({ entries: once }, DCFG.calendar, ctx('2026-11-09', '2026-11-14'));
  const planner = expandTemplate({ entries: again }, DCFG.calendar, ctx('2026-11-09', '2026-11-14', [[n.matchKey, 'bbbbbbbbbbbbbbbbbbbbbbbb']]));
  assert.deepEqual(plain.parsed.lessons.map((l) => l.id), planner.parsed.lessons.map((l) => l.id));
  const inN = planner.parsed.lessons.find((l) => l.title.includes('Gruppo B'))!;
  assert.deepEqual(inN.roomIds, ['bbbbbbbbbbbbbbbbbbbbbbbb']);
  assert.ok(!planner.parsed.rooms.some((r) => r.id === n.syntheticId), 'a Planner room is not sent again');
  assert.equal(new Set(plain.parsed.lessons.map((l) => l.id)).size, plain.parsed.lessons.length);
  assert.ok(plain.parsed.lessons.every((l) => /^fffe[0-9a-f]{20}$/.test(l.id)));
});
