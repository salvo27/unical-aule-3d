import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { xlsxAdapter, type XlsxAdapterOptions } from '../src/sources/xlsx.js';
import { createAdapters } from '../src/sources/registry.js';
import { SourceError, type Feed, type FetchContext, type SourceAdapter, type SourceData } from '../src/sources/types.js';
import { findFileLinks, FILE_MAX_BYTES, XLSX_TYPE } from '../src/sources/xlsx/client.js';
import { sourceFailure, XlsxError, type XlsxCode } from '../src/sources/xlsx/codes.js';
import { DiamConfigError, loadDiamConfig, parseDiamConfig, type DiamConfig, type DiamSheet } from '../src/sources/xlsx/config.js';
import { romeTime } from '../src/sources/xlsx/expand.js';
import { parseWorkbook } from '../src/sources/xlsx/layout.js';
import { DEFAULT_LIMITS, readXlsx } from '../src/sources/xlsx/reader.js';
import { norm, roomAlias, sheetRole } from '../src/sources/xlsx/text.js';
import { checkBuildings, renderXlsxFeeds } from '../scripts/gen-xlsx-feeds-sql.js';
import { feedId, roomMatchKey, syntheticRoomId } from '../src/domain/ids.js';
import { isoDay, sourceUrl, type PlannerId } from '../src/domain/primitives.js';
import { buildPayload } from '../src/sync/payload.js';
import { loadCampus } from '../src/campus.js';
import { USER_AGENT } from '../src/user-agent.js';
import type { LogFields, Logger } from '../src/log.js';

const ROOT = new URL('../../', import.meta.url);
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

// Invented configuration in the shape of config/diam.json.
const RAW_CONFIG = {
  version: 1,
  pageUrl: 'https://example.unical.it/orario/',
  academicYear: '2026-2027',
  semesters: { '1': { first: '2026-09-21', last: '2026-12-19' }, '2': { first: '2027-02-22', last: '2027-06-05' } },
  closedDays: ['2026-12-08', '2027-03-29', '2027-03-30'],
  sheets: [
    { file: 'LT', sheet: 'I ANNO - Ambiente', year: 1, course: 'INGEGNERIA DI PROVA', label: 'Prova · 1° anno LT' },
    { file: 'LT', sheet: 'II ANNO - Mare', year: 2, course: 'NAVIGAZIONE DI PROVA', label: 'Prova · 2° anno LT' },
    { file: 'LM', sheet: '1° LM Ambiente', year: 1, course: 'AMBIENTE DI PROVA', label: 'Prova · 1° anno LM' },
  ],
  rooms: [
    { alias: 'B', name: 'DIAM B', building: 'Cubo 42B', capacity: 135 },
    { alias: 'C', name: 'DIAM C', building: 'Cubo 42B', capacity: 54 },
    { alias: 'F', name: 'DIAM F', building: 'Cubo 39C', capacity: 62 },
    { alias: 'SEMINARI', name: 'Aula Seminari', building: 'Cubo 45A', capacity: 23 },
  ],
};
const CONFIG = parseDiamConfig(RAW_CONFIG);
const [LT1, LT2, LM1] = CONFIG.sheets as [DiamSheet, DiamSheet, DiamSheet];

const day = (d: string) => isoDay(d);
const rome = (d: string, hhmm: string) => romeTime(day(d), Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)));
const FROM = rome('2026-11-09', '00:00');
const TO = rome('2026-11-23', '00:00');
const CTX: FetchContext = { from: FROM, to: TO, plannerRooms: new Map() };
const feedOf = (s: DiamSheet): Feed => ({ id: s.id, source: 'xlsx', ref: s.ref });

// ---------- workbook fixtures ----------

interface FixtureSheet {
  name: string;
  state?: string;
  cells: Record<string, string | number>;
  merges?: string[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COLS = 'ABCDEFGHIJKLMNOP';

function refOrder(a: string, b: string): number {
  const [, ca = '', ra = ''] = /^([A-Z]+)(\d+)$/.exec(a) ?? [];
  const [, cb = '', rb = ''] = /^([A-Z]+)(\d+)$/.exec(b) ?? [];
  return Number(ra) - Number(rb) || ca.length - cb.length || (ca < cb ? -1 : ca > cb ? 1 : 0);
}

function workbook(sheets: FixtureSheet[], options: { extra?: Record<string, Uint8Array>; patch?: (path: string, xml: string) => string } = {}): Uint8Array {
  const shared: string[] = [];
  const index = new Map<string, number>();
  const parts: Record<string, string> = {};
  sheets.forEach((s, i) => {
    const rows = new Map<number, string[]>();
    for (const ref of Object.keys(s.cells).sort(refOrder)) {
      const v = s.cells[ref]!;
      const row = Number(/\d+$/.exec(ref)?.[0]);
      let xml: string;
      if (typeof v === 'number') xml = `<c r="${ref}"><v>${v}</v></c>`;
      else {
        let k = index.get(v);
        if (k === undefined) {
          k = shared.length;
          shared.push(v);
          index.set(v, k);
        }
        xml = `<c r="${ref}" t="s"><v>${k}</v></c>`;
      }
      rows.set(row, [...(rows.get(row) ?? []), xml]);
    }
    const data = [...rows.entries()].map(([r, cells]) => `<row r="${r}">${cells.join('')}</row>`).join('');
    const merges = s.merges?.length ? `<mergeCells count="${s.merges.length}">${s.merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : '';
    parts[`xl/worksheets/sheet${i + 1}.xml`] =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN}"><dimension ref="A1:M1000"/><sheetData>${data}</sheetData>${merges}</worksheet>`;
  });
  parts['[Content_Types].xml'] = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
  parts['xl/workbook.xml'] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
    sheets.map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}"${s.state ? ` state="${s.state}"` : ''} r:id="rId${i + 1}"/>`).join('') +
    '</sheets></workbook>';
  parts['xl/_rels/workbook.xml.rels'] =
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${PKG}">` +
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    '</Relationships>';
  parts['xl/sharedStrings.xml'] =
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN}" count="${shared.length}" uniqueCount="${shared.length}">` +
    shared.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('') +
    '</sst>';
  const files: Record<string, Uint8Array> = {};
  for (const [path, xml] of Object.entries(parts)) files[path] = strToU8(options.patch ? options.patch(path, xml) : xml);
  return zipSync({ ...files, ...(options.extra ?? {}) });
}

const HEADER = ['ORARIO', "LUNEDI'", 'Aula', "MARTEDI'", 'Aula', "MERCOLEDI'", 'Aula', "GIOVEDI'", 'Aula', "VENERDI'", 'Aula', 'SABATO', 'Aula'];
const TIMES = ['08:30', '09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:00', '16:00', '17:00'];

interface GridLesson {
  day: number;
  slot: number;
  title?: string;
  room?: string;
}

interface GridOptions {
  courseRow?: string;
  academicYear?: string;
  yearRow?: string | null;
  titleRows?: string[];
  header?: string[];
  times?: (string | number)[];
  lessons?: GridLesson[];
  legend?: string[];
  cells?: Record<string, string | number>;
  merges?: string[];
  state?: string;
}

// Title rows from row 1, then the header, then the time rows (slot 0 is the row after the header).
function grid(name: string, o: GridOptions = {}): FixtureSheet {
  const cells: Record<string, string | number> = {};
  const titles = [
    o.courseRow ?? 'CORSO DI LAUREA IN INGEGNERIA DI PROVA',
    `A.A. ${o.academicYear ?? '2026-2027'}`,
    ...(o.yearRow === null ? [] : [o.yearRow ?? '1° anno - I semestre']),
    ...(o.titleRows ?? []),
  ];
  titles.forEach((t, i) => (cells[`A${i + 1}`] = t));
  const header = titles.length + 1;
  (o.header ?? HEADER).forEach((t, i) => (cells[`${COLS[i]}${header}`] = t));
  const times = o.times ?? TIMES;
  times.forEach((t, i) => (cells[`A${header + 1 + i}`] = t));
  for (const l of o.lessons ?? []) {
    if (l.title !== undefined) cells[`${COLS[1 + 2 * l.day]}${header + 1 + l.slot}`] = l.title;
    if (l.room !== undefined) cells[`${COLS[2 + 2 * l.day]}${header + 1 + l.slot}`] = l.room;
  }
  (o.legend ?? []).forEach((t, i) => (cells[`A${header + times.length + 2 + i}`] = t));
  Object.assign(cells, o.cells ?? {});
  return { name, state: o.state, cells, merges: [...titles.map((_, i) => `A${i + 1}:M${i + 1}`), ...(o.merges ?? [])] };
}

const lt1 = (o: GridOptions = {}) =>
  grid('I ANNO - Ambiente', {
    lessons: [
      { day: 0, slot: 0, title: 'ANALISI DI PROVA', room: 'Aula B' },
      { day: 0, slot: 1, title: 'Analisi di prova', room: 'AULA B' },
      { day: 1, slot: 4, title: 'FISICA DI PROVA', room: 'Aula C' },
      { day: 2, slot: 6, title: 'CHIMICA DI PROVA', room: 'Aula Seminari' },
    ],
    legend: ['LEGENDA CORSI', 'ANALISI DI PROVA - 9 CFU - Prof. MARIO ROSSI (DIAm)', 'FISICA DI PROVA - 6 CFU'],
    ...o,
  });
const lt2 = (o: GridOptions = {}) =>
  grid('II ANNO - Mare', {
    courseRow: 'CORSO DI LAUREA IN NAVIGAZIONE DI PROVA',
    yearRow: '2° anno - I semestre',
    lessons: [{ day: 3, slot: 2, title: 'NAVIGAZIONE DI PROVA', room: 'Aula F' }],
    ...o,
  });
const lm1 = (o: GridOptions = {}) =>
  grid('1° LM Ambiente-OK', {
    courseRow: 'CORSO DI LAUREA MAGISTRALE IN AMBIENTE DI PROVA',
    lessons: [{ day: 4, slot: 7, title: 'IDRAULICA DI PROVA', room: 'Aula F' }],
    ...o,
  });
const roomsSheet = (capacityB = 135): FixtureSheet => ({
  name: 'AULE-UBICAZIONE-OK',
  cells: {
    A1: 'DIP.', B1: 'AULA', C1: 'CUBO', D1: 'PIANO', E1: 'Posti',
    A2: 'DIAM', B2: 'DIAM B', C2: '42B', D2: 2, E2: capacityB,
    A3: 'DIAM', B3: 'DIAM C', C3: '42B', D3: 2, E3: 54,
    A4: 'DIAM', B4: 'DIAM F', C4: '39C ', D4: 2, E4: 62,
    A5: 'DIAM', B5: 'Aula Seminari', C5: '45A', D5: 'TERRA', E5: 23,
  },
});

const LT_BYTES = () => workbook([lt1(), lt2()]);
const LM_BYTES = () => workbook([roomsSheet(), lm1()]);

// ---------- fake server ----------

const PAGE_URL = 'https://example.unical.it/orario/';
const LT_URL = 'https://www.unical.it/media/medias/2026/Orario_Lauree_triennali_prova.xlsx';
const LM_URL = 'https://www.unical.it/media/medias/2026/Orario_Laurea_Magistrale_prova.xlsx';
const PAGE =
  '<html><body><h3>Orario delle lezioni</h3><p>Orario delle Lezioni, Corsi di Laurea I&deg; SEMESTRE 2026-2027</p><ul>' +
  `<li><a href="${LT_URL}"><strong>Orario lezioni LT</strong></a></li>` +
  '<li><a class="x" href="//www.unical.it/media/medias/2026/Orario_Laurea_Magistrale_prova.xlsx"><strong>Orario lezioni LM</strong>&nbsp;</a></li>' +
  '<li><a href="https://www.unical.it/media/medias/2026/Regolamento.pdf">Regolamento</a></li>' +
  '<li><a href="http://www.unical.it/media/medias/2026/Vecchio_LT.xlsx">Vecchio LT</a></li>' +
  '<li><a href="https://www.unical.it/media/medias/2026/Altro_LT.xlsx?v=2">Altro LT</a></li>' +
  '<li><a href="https://example.com/media/medias/2026/Esterno_LM.xlsx">Esterno LM</a></li>' +
  '</ul></body></html>';

interface Served {
  status?: number;
  body?: string | Uint8Array | null;
  headers?: Record<string, string>;
}
type Route = Served | (() => Served) | Error;

const page = (html = PAGE): Served => ({ body: html, headers: { 'content-type': 'text/html; charset=utf-8' } });
const file = (bytes: Uint8Array, headers: Record<string, string> = {}): Served => ({
  body: bytes,
  headers: { 'content-type': XLSX_TYPE, etag: '"v1"', 'last-modified': 'Fri, 02 Oct 2026 12:59:29 GMT', ...headers },
});

function setup(routes: Record<string, Route>, options: Partial<XlsxAdapterOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: { level: string; event: string; fields: LogFields }[] = [];
  const pauses: number[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const route = routes[url];
    if (route === undefined) return new Response('', { status: 404 });
    if (route instanceof Error) throw route;
    const s = typeof route === 'function' ? route() : route;
    return new Response((s.body ?? null) as BodyInit | null, { status: s.status ?? 200, headers: s.headers ?? {} });
  }) as typeof fetch;
  const at = (level: string) => (event: string, fields: LogFields = {}) => void logs.push({ level, event, fields });
  const log: Logger = { info: at('info'), warn: at('warn'), error: at('error') };
  const adapter = xlsxAdapter({
    fetchImpl,
    log,
    config: async () => CONFIG,
    sleep: async (ms) => void pauses.push(ms),
    ...options,
  });
  return { adapter, calls, logs, pauses };
}

const standard = (lt: Route = file(LT_BYTES()), lm: Route = file(LM_BYTES())) => ({ [PAGE_URL]: page(), [LT_URL]: lt, [LM_URL]: lm });

async function outcome(adapter: SourceAdapter, sheet: DiamSheet, ctx: FetchContext = CTX): Promise<SourceData | string> {
  try {
    return await adapter.fetch(feedOf(sheet), ctx);
  } catch (err) {
    if (err instanceof SourceError) return err.code;
    throw err;
  }
}

async function outcomes(lt: Route, lm: Route): Promise<{ lt1: SourceData | string; lt2: SourceData | string; lm1: SourceData | string; logs: { event: string; fields: LogFields }[] }> {
  const { adapter, logs } = setup(standard(lt, lm));
  await adapter.prepare();
  return { lt1: await outcome(adapter, LT1), lt2: await outcome(adapter, LT2), lm1: await outcome(adapter, LM1), logs };
}

function data(v: SourceData | string): SourceData {
  assert.equal(typeof v, 'object', `expected data, got ${String(v)}`);
  return v as SourceData;
}

// Sheet level outcome of one grid, read directly through the layout check.
function sheetCode(sheet: FixtureSheet, extra: FixtureSheet[] = [lt2()]): XlsxCode | 'ok' {
  const parsed = parseWorkbook('LT', readXlsx(workbook([sheet, ...extra])), CONFIG);
  const o = parsed.sheets.get(LT1.ref);
  assert.ok(o);
  return 'failure' in o ? o.failure : 'ok';
}

function fileCode(bytes: Uint8Array, kind: 'LT' | 'LM' = 'LT'): XlsxCode | 'ok' {
  try {
    parseWorkbook(kind, readXlsx(bytes), CONFIG);
    return 'ok';
  } catch (err) {
    if (err instanceof XlsxError) return err.code;
    throw err;
  }
}

// ---------- tests ----------

test('a weekly sheet becomes dated lessons in Rome time with synthetic ids', async () => {
  const { adapter } = setup(standard());
  assert.equal(adapter.kind, 'xlsx');
  await adapter.prepare();
  const d = data(await outcome(adapter, LT1));
  assert.equal(d.from, FROM);
  assert.equal(d.to, TO);
  const lessons = d.parsed.lessons;
  assert.equal(lessons.length, 6);
  const first = lessons[0]!;
  assert.equal(first.title, 'ANALISI DI PROVA');
  assert.equal(first.start, rome('2026-11-09', '08:30'));
  assert.equal(first.end, rome('2026-11-09', '10:30'), 'back to back slots of the same lesson are joined');
  assert.equal(first.start, Date.parse('2026-11-09T07:30:00Z'));
  assert.deepEqual(first.teachers, [], 'teacher names of the legend are not kept');
  assert.equal(JSON.stringify(d.parsed).toLowerCase().includes('rossi'), false);
  assert.deepEqual(first.courses, ['INGEGNERIA DI PROVA']);
  assert.equal(first.year, 1);
  assert.equal(first.kind, "ATTIVITA' DIDATTICA");
  assert.equal(first.status, 'active');
  const physics = lessons.find((l) => l.title === 'FISICA DI PROVA')!;
  assert.equal(physics.end - physics.start, 60 * 60_000, 'the 12:30 row lasts until 13:30');
  assert.deepEqual(physics.teachers, []);
  const chemistry = lessons.find((l) => l.title === 'CHIMICA DI PROVA')!;
  assert.equal(chemistry.end - chemistry.start, 30 * 60_000, 'the 14:30 row ends at the next row, 15:00');
  for (const l of lessons) {
    assert.match(l.id, /^fffe[0-9a-f]{20}$/);
    for (const r of l.roomIds) assert.match(r, /^ffff[0-9a-f]{20}$/);
  }
  assert.equal(new Set(lessons.map((l) => l.id)).size, 6);
  const b = d.parsed.rooms.find((r) => r.name === 'DIAM B')!;
  assert.equal(b.id, syntheticRoomId('cubo-42b', 'diamb'));
  assert.deepEqual(
    { buildingName: b.buildingName, capacity: b.capacity, code: b.code, services: b.services, effectiveCapacity: b.effectiveCapacity },
    { buildingName: 'Cubo 42B', capacity: 135, code: '', services: [], effectiveCapacity: null },
  );
  const payload = buildPayload(d.parsed, d.from, d.to);
  assert.equal(payload.skipped, 0);
  assert.equal(payload.lessons.length, 6);
  assert.equal(payload.rooms.length, 3);
  assert.equal(payload.rooms.find((r) => r.id === b.id)?.buildingKeyGuess, 'cubo-42b');

  const again = setup(standard());
  await again.adapter.prepare();
  assert.deepEqual(data(await outcome(again.adapter, LT1)).parsed.lessons.map((l) => l.id), lessons.map((l) => l.id), 'ids are stable across runs');
  assert.equal(data(await outcome(adapter, LT2)).parsed.lessons.length, 2);
  assert.equal(data(await outcome(adapter, LM1)).parsed.lessons.length, 2);
});

test('a room the Planner knows keeps its Planner id and is not repeated, lesson ids do not change', async () => {
  const planner = 'aaaaaaaaaaaaaaaaaaaaaaaa' as PlannerId;
  const key = roomMatchKey('Cubo 42B', 'DIAM B')!;
  const { adapter } = setup(standard());
  await adapter.prepare();
  const plain = data(await outcome(adapter, LT1));
  const matched = data(await outcome(adapter, LT1, { ...CTX, plannerRooms: new Map([[key, planner]]) }));
  const analysis = matched.parsed.lessons.filter((l) => l.title === 'ANALISI DI PROVA');
  assert.ok(analysis.length > 0);
  for (const l of analysis) assert.deepEqual(l.roomIds, [planner]);
  assert.ok(!matched.parsed.rooms.some((r) => r.name === 'DIAM B'));
  assert.ok(matched.parsed.rooms.some((r) => r.name === 'DIAM C'));
  assert.deepEqual(matched.parsed.lessons.map((l) => l.id), plain.parsed.lessons.map((l) => l.id));
  const payload = buildPayload(matched.parsed, matched.from, matched.to);
  assert.ok(payload.lessons.some((l) => l.roomIds[0] === planner), 'directory room ids survive the payload');
});

const win = (from: string, to: string): FetchContext => ({ from: rome(from, '00:00'), to: rome(to, '00:00'), plannerRooms: new Map() });

test('lessons stop at the semester end, coverage goes on through the break, closed days have no lessons', async () => {
  const { adapter } = setup(standard());
  await adapter.prepare();
  const end = data(await outcome(adapter, LT1, win('2026-12-07', '2026-12-28')));
  assert.equal(end.from, rome('2026-12-07', '00:00'));
  assert.equal(end.to, rome('2026-12-28', '00:00'));
  const days = new Set(end.parsed.lessons.map((l) => new Date(l.start).toISOString().slice(0, 10)));
  assert.ok(days.has('2026-12-07') && days.has('2026-12-14') && days.has('2026-12-15'));
  assert.ok(!days.has('2026-12-08'), 'the closed day has no lesson');
  assert.ok(![...days].some((d) => d > '2026-12-19'));
  const start = data(await outcome(adapter, LT1, win('2026-09-14', '2026-10-05')));
  assert.equal(start.from, rome('2026-09-21', '00:00'));
});

test('in the break between the semesters a sheet is ok with no lessons, coverage is the window clipped to the break', async () => {
  const { adapter } = setup(standard());
  await adapter.prepare();
  const inside = data(await outcome(adapter, LT1, win('2026-12-28', '2027-01-18')));
  assert.deepEqual(inside, { parsed: { lessons: [], rooms: [], skipped: 0 }, from: rome('2026-12-28', '00:00'), to: rome('2027-01-18', '00:00') });
  const payload = buildPayload(inside.parsed, inside.from, inside.to);
  assert.deepEqual([payload.lessons.length, payload.rooms.length, payload.skipped], [0, 0, 0]);
  const edge = data(await outcome(adapter, LT1, win('2027-02-15', '2027-03-01')));
  assert.deepEqual([edge.from, edge.to, edge.parsed.lessons.length], [rome('2027-02-15', '00:00'), rome('2027-02-22', '00:00'), 0]);

  const second = setup(standard(file(workbook([lt1({ yearRow: '1° anno - II semestre' }), lt2({ yearRow: '2° anno - II semestre' })]))));
  await second.adapter.prepare();
  const before = data(await outcome(second.adapter, LT1, win('2027-02-08', '2027-02-22')));
  assert.deepEqual([before.from, before.to, before.parsed.lessons.length], [rome('2027-02-08', '00:00'), rome('2027-02-22', '00:00'), 0]);
  const across = data(await outcome(second.adapter, LT1, win('2026-12-20', '2027-03-01')));
  assert.equal(across.from, rome('2026-12-20', '00:00'));
  assert.equal(across.to, rome('2027-03-01', '00:00'));
  assert.ok(across.parsed.lessons.length > 0);
  assert.ok(across.parsed.lessons.every((l) => l.start >= rome('2027-02-22', '00:00')), 'no lesson before the semester starts');
});

test('a second semester file published while the window still holds first semester days fails, never frees those rooms', async () => {
  const second = setup(standard(file(workbook([lt1({ yearRow: '1° anno - II semestre' }), lt2({ yearRow: '2° anno - II semestre' })]))));
  await second.adapter.prepare();
  assert.equal(await outcome(second.adapter, LT1, win('2026-12-07', '2026-12-29')), 'wrong_period', 'last week of the first semester');
  assert.equal(await outcome(second.adapter, LT1, win('2026-12-19', '2027-01-10')), 'wrong_period', 'one first semester day left');
  assert.ok(second.logs.some((l) => l.event === 'xlsx_sheet_failed' && l.fields.code === 'outside_semester'));
  const ok = data(await outcome(second.adapter, LT1, win('2026-12-20', '2027-01-11')));
  assert.deepEqual([ok.from, ok.to, ok.parsed.lessons.length], [rome('2026-12-20', '00:00'), rome('2027-01-11', '00:00'), 0]);
});

test('outside the semester and its break a sheet still fails with wrong_period', async () => {
  const { adapter, logs } = setup(standard());
  await adapter.prepare();
  assert.equal(await outcome(adapter, LT1, win('2027-03-01', '2027-03-15')), 'wrong_period', 'a first semester file in the second semester');
  assert.equal(await outcome(adapter, LT1, win('2026-08-01', '2026-08-15')), 'wrong_period');
  assert.ok(logs.some((l) => l.event === 'xlsx_sheet_failed' && l.fields.code === 'outside_semester'));
  const second = setup(standard(file(workbook([lt1({ yearRow: '1° anno - II semestre' }), lt2({ yearRow: '2° anno - II semestre' })]))));
  await second.adapter.prepare();
  assert.equal(await outcome(second.adapter, LT1, win('2027-06-14', '2027-06-28')), 'wrong_period', 'the summer is not a configured break');
  assert.equal(await outcome(second.adapter, LT1, win('2026-11-30', '2026-12-14')), 'wrong_period');
});

test('a second semester file is expanded on the second semester dates', async () => {
  const second = (o: GridOptions = {}) => lt1({ yearRow: '1° anno - II semestre', ...o });
  const { adapter } = setup(standard(file(workbook([second(), lt2({ yearRow: '2° anno - II semestre' })]))));
  await adapter.prepare();
  assert.equal(await outcome(adapter, LT1), 'wrong_period');
  const d = data(await outcome(adapter, LT1, { from: rome('2027-03-22', '00:00'), to: rome('2027-04-05', '00:00'), plannerRooms: new Map() }));
  const days = new Set(d.parsed.lessons.map((l) => new Date(l.start + 3_600_000).toISOString().slice(0, 10)));
  assert.ok(days.has('2027-03-22') && days.has('2027-03-24'));
  assert.ok(!days.has('2027-03-29') && !days.has('2027-03-30'), 'the closed days of the configuration are skipped');
  const monday = d.parsed.lessons.find((l) => l.start >= rome('2027-03-22', '00:00'))!;
  assert.equal(monday.start, Date.parse('2027-03-22T07:30:00Z'));
});

test('Rome wall clock times are right on both daylight saving days', () => {
  assert.equal(rome('2027-03-28', '06:17'), Date.parse('2027-03-28T04:17:00Z'));
  assert.equal(rome('2026-10-25', '06:17'), Date.parse('2026-10-25T05:17:00Z'));
  assert.equal(rome('2026-10-25', '00:30'), Date.parse('2026-10-24T22:30:00Z'));
  assert.equal(rome('2027-03-28', '00:00'), Date.parse('2027-03-27T23:00:00Z'));
  assert.equal(rome('2026-11-16', '08:30'), Date.parse('2026-11-16T07:30:00Z'));
  assert.equal(rome('2027-05-10', '08:30'), Date.parse('2027-05-10T06:30:00Z'));
});

test('curriculum prefixes, time notes, hidden cells and missing rooms follow the spec', async () => {
  const sheet = grid('I ANNO - Ambiente', {
    titleRows: ['INDIRIZZI: PT (Protezione di prova) - SA (Sostenibilità di prova)', 'TAR \u2013 Risorse di prova'],
    lessons: [
      { day: 0, slot: 0, title: 'PT: IDRAULICA DI PROVA          TAR: GESTIONE DI PROVA', room: 'PT: Aula B TAR: Aula C' },
      { day: 1, slot: 0, title: 'SC: SCELTA DI PROVA', room: 'TAR: Aula F' },
      { day: 2, slot: 0, title: 'SA: PROCESSI DI PROVA\nPT: OPERE DI PROVA', room: 'AULA C' },
      { day: 3, slot: 0, room: 'Aula Seminari' },
      { day: 4, slot: 0, title: 'MATERIA SENZA AULA' },
      { day: 2, slot: 7, title: 'TECNICA DI PROVA (14:30)', room: 'Aula F' },
      { day: 2, slot: 8, title: 'TECNICA DI PROVA (16:30)', room: 'Aula F' },
      { day: 5, slot: 2, title: 'LABORATORIO DI PROVA', room: 'Aula B / Aula C' },
    ],
    // The 14:30 row (slot 6, row 13) is merged over the grid and hides a value under it.
    cells: { F13: 'TECNICA DI PROVA', G13: 'Aula F', B13: 'PAUSA' },
    merges: ['B13:M13'],
  });
  const { adapter, logs } = setup(standard(file(workbook([sheet, lt2()]))));
  await adapter.prepare();
  const lessons = data(await outcome(adapter, LT1)).parsed.lessons.filter((l) => l.start < rome('2026-11-16', '00:00'));
  const rooms = (title: string) =>
    lessons.filter((l) => l.title === title).map((l) => l.roomIds.map((id) => [...CONFIG.rooms.values()].find((r) => r.syntheticId === id)?.alias).join(','));
  assert.deepEqual(rooms('IDRAULICA DI PROVA'), ['B']);
  assert.deepEqual(rooms('GESTIONE DI PROVA'), ['C']);
  assert.deepEqual(rooms('SCELTA DI PROVA'), ['F'], 'one title and one room with different prefixes are paired');
  assert.deepEqual(rooms('PROCESSI DI PROVA'), ['C'], 'one room without prefix serves every title');
  assert.deepEqual(rooms('OPERE DI PROVA'), ['C']);
  assert.deepEqual(rooms('Lezione'), ['SEMINARI'], 'a room without title is busy with a generic title');
  assert.deepEqual(rooms('MATERIA SENZA AULA'), [], 'a title without room is dropped');
  assert.deepEqual(rooms('LABORATORIO DI PROVA'), ['B,C']);
  const technique = lessons.filter((l) => l.title === 'TECNICA DI PROVA');
  assert.equal(technique.length, 1);
  assert.equal(technique[0]!.start, rome('2026-11-11', '14:30'));
  assert.equal(technique[0]!.end, rome('2026-11-11', '17:00'), 'time notes widen the interval in the safe direction');
  const codes = logs.filter((l) => l.event === 'xlsx_warning').map((l) => `${String(l.fields.code)} ${String(l.fields.where)}`);
  // Two extra title rows: the header is row 6, slot 0 is row 7.
  for (const want of ['prefix_mismatch R7C4', 'room_without_title R7C8', 'no_room R7C10', 'time_note R14C6', 'time_note R15C6', 'hidden_value R13C6', 'hidden_value R13C7']) {
    assert.ok(codes.includes(want), want);
  }
});

test('logs carry only events, ids, counts and codes', async () => {
  const sheet = lt1({ cells: { E3: 'Nota di Mario Rossi' } });
  const { adapter, logs } = setup(standard(file(workbook([sheet, lt2({ lessons: [{ day: 0, slot: 0, title: 'X (14:30)', room: 'Aula B' }] })]))));
  await adapter.prepare();
  await outcome(adapter, LT1);
  await outcome(adapter, LT2);
  const text = JSON.stringify(logs);
  for (const secret of ['PROVA', 'Rossi', 'ROSSI', 'Aula', 'unical.it', 'Nota']) assert.ok(!text.includes(secret), secret);
  for (const l of logs) for (const v of Object.values(l.fields)) assert.ok(v === null || ['number', 'boolean'].includes(typeof v) || /^[A-Za-z0-9_]{0,40}$/.test(String(v)), String(v));
});

test('one broken sheet fails only its own feed', () => {
  assert.equal(sheetCode(lt1()), 'ok');
  assert.equal(sheetCode(lt1({ titleRows: ['INDIRIZZI: PT (Prova)', 'PT - Indirizzo di prova'] })), 'ok', 'the header may move down');
  assert.equal(sheetCode(lt1({ times: [0.3541666666666667, 0.3958333333333333, '10.30', '11:30', '12:30', '13:30', '14:30', '15:00'] })), 'ok', 'Excel times and dotted times');
  assert.equal(sheetCode(lt1({ academicYear: '2025-2026' })), 'academic_year_mismatch');
  assert.equal(sheetCode(lt1({ header: ['ORARIO', 'GIORNO', ...HEADER.slice(2)] })), 'bad_header');
  assert.equal(sheetCode(lt1({ titleRows: Array.from({ length: 9 }, () => 'PT - Riga di prova') })), 'no_header');
  assert.equal(sheetCode(lt1({ courseRow: 'CORSO DI LAUREA IN ALTRO CORSO' })), 'course_mismatch');
  assert.equal(sheetCode(lt1({ yearRow: '2° anno - I semestre' })), 'year_mismatch');
  assert.equal(sheetCode(lt1({ yearRow: null })), 'no_semester');
  assert.equal(sheetCode(lt1({ titleRows: ['Una riga inattesa'] })), 'unexpected_title_row');
  assert.equal(sheetCode(lt1({ cells: { E2: 'fuori posto' }, merges: [] })), 'ok', 'a value under the title merge is hidden, not a stray cell');
  assert.equal(sheetCode({ ...lt1({ cells: { E2: 'fuori posto' } }), merges: ['A1:M1', 'A3:M3'] }), 'unexpected_cell');
  assert.equal(sheetCode(lt1({ times: ['08:30', '09:30', '09:30', '10:30', '11:30', '12:30'] })), 'bad_times');
  assert.equal(sheetCode(lt1({ times: ['08:30', '09:30', '10:30', '11:30', '12:30'] })), 'bad_times');
  assert.equal(sheetCode(lt1({ times: ['06:30', '07:30', '08:30', '09:30', '10:30', '11:30'] })), 'bad_times');
  assert.equal(sheetCode(lt1({ cells: { N6: 'colonna in piu' } })), 'unexpected_column');
  assert.equal(sheetCode(lt1({ cells: { B9: 'LEZIONE UNITA' }, merges: ['B9:D9'] })), 'grid_merge');
  assert.equal(sheetCode(lt1({ cells: { B10: 'PAUSA PRANZO' }, merges: ['B10:M10'] })), 'ok');
  assert.equal(sheetCode(lt1({ lessons: [{ day: 0, slot: 0, title: 'A'.repeat(301), room: 'Aula B' }] })), 'cell_too_long');
  assert.equal(sheetCode(lt1({ state: 'hidden' })), 'hidden_sheet');
  assert.equal(sheetCode(lt2(), []), 'sheet_missing');
});

test('a gap in the time column or a lesson row without its time fails the sheet, never drops lessons', () => {
  const afternoon: GridLesson[] = [{ day: 0, slot: 8, title: 'ANALISI DI PROVA', room: 'Aula B' }];
  const gap = ['08:30', '09:30', '10:30', '11:30', '12:30', '13:30', '', '15:00', '16:00', '17:00'];
  assert.equal(sheetCode(lt1({ times: gap, lessons: afternoon })), 'bad_times');
  const noLabel = ['08:30', '09:30', '10:30', '11:30', '12:30', '13:30', '14:30', '15:00', '16:00', ''];
  assert.equal(sheetCode(lt1({ times: noLabel, lessons: [{ day: 2, slot: 9, title: 'CHIMICA DI PROVA', room: 'Aula C' }] })), 'bad_times');
  assert.equal(sheetCode(lt1({ legend: ['LEGENDA CORSI', 'ANALISI DI PROVA - 9 CFU', '18:00'] })), 'bad_times');
  assert.equal(sheetCode(lt1({ cells: { C21: 'nota' } })), 'ok', 'a stray cell further down the legend is only a warning');
});

interface CentralEntry {
  name: string;
  at: number;
  length: number;
}

// Central directory of a zip written by fflate (no zip64, no archive comment).
function central(zip: Uint8Array): { entries: CentralEntry[]; eocd: number; size: number; offset: number } {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const eocd = zip.byteLength - 22;
  assert.equal(view.getUint32(eocd, true), 0x06054b50);
  const count = view.getUint16(eocd + 10, true);
  const size = view.getUint32(eocd + 12, true);
  const offset = view.getUint32(eocd + 16, true);
  const entries: CentralEntry[] = [];
  for (let at = offset, i = 0; i < count; i++) {
    const n = view.getUint16(at + 28, true);
    const length = 46 + n + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    entries.push({ name: new TextDecoder().decode(zip.subarray(at + 46, at + 46 + n)), at, length });
    at += length;
  }
  return { entries, eocd, size, offset };
}

// More central directory entries pointing at the bytes of one existing entry.
function aliasEntries(zip: Uint8Array, from: string, names: string[]): Uint8Array {
  const cd = central(zip);
  const source = cd.entries.find((e) => e.name === from);
  assert.ok(source);
  const clones = names.map((name) => {
    const encoded = strToU8(name);
    const out = new Uint8Array(46 + encoded.length);
    out.set(zip.subarray(source.at, source.at + 46));
    const dv = new DataView(out.buffer);
    dv.setUint16(28, encoded.length, true);
    dv.setUint16(30, 0, true);
    dv.setUint16(32, 0, true);
    out.set(encoded, 46);
    return out;
  });
  const extra = clones.reduce((s, c) => s + c.length, 0);
  const result = new Uint8Array(zip.byteLength + extra);
  let w = cd.offset + cd.size;
  result.set(zip.subarray(0, w));
  for (const c of clones) {
    result.set(c, w);
    w += c.length;
  }
  result.set(zip.subarray(cd.eocd), w);
  const rv = new DataView(result.buffer);
  rv.setUint16(w + 8, cd.entries.length + names.length, true);
  rv.setUint16(w + 10, cd.entries.length + names.length, true);
  rv.setUint32(w + 12, cd.size + extra, true);
  return result;
}

test('zip entries sharing bytes or with a lying stored size are refused before they cost work', () => {
  const ok = LT_BYTES();
  const aliases = Array.from({ length: 50 }, (_, i) => `xl/worksheets/sheet${i + 10}.xml`);
  assert.equal(fileCode(aliasEntries(ok, 'xl/worksheets/sheet1.xml', aliases)), 'bad_zip');

  const parts = unzipSync(ok);
  const stored = zipSync(parts, { level: 0 });
  assert.equal(fileCode(stored), 'ok');
  const entry = central(stored).entries.find((e) => e.name === 'xl/worksheets/sheet1.xml');
  assert.ok(entry);
  const lying = stored.slice();
  new DataView(lying.buffer).setUint32(entry.at + 24, 10, true);
  assert.equal(fileCode(lying), 'bad_zip');
});

test('unknown rooms drop the lesson up to 20 percent, above that the sheet fails', () => {
  const lessons = (unknown: number): GridLesson[] =>
    Array.from({ length: 10 }, (_, i) => ({ day: i % 6, slot: Math.floor(i / 6) * 2, title: `CORSO ${i}`, room: i < unknown ? 'Aula Sconosciuta' : 'Aula B' }));
  assert.equal(sheetCode(lt1({ lessons: lessons(2) })), 'ok');
  assert.equal(sheetCode(lt1({ lessons: lessons(3) })), 'unknown_rooms');
  const parsed = parseWorkbook('LT', readXlsx(workbook([lt1({ lessons: lessons(2) }), lt2()])), CONFIG);
  const o = parsed.sheets.get(LT1.ref)!;
  assert.ok('template' in o);
  assert.equal(o.template.lessons.length, 8);
  assert.equal(o.warnings.filter((w) => w.code === 'unknown_room').length, 2);
});

test('file level problems fail every feed of that file and only those', async () => {
  const cases: [string, Route, string][] = [
    ['renamed sheet', file(workbook([lt1(), { ...lt2(), name: 'II ANNO - Navigazione' }])), 'bad_shape'],
    ['extra sheet', file(workbook([lt1(), lt2(), grid('Foglio1')])), 'bad_shape'],
    ['duplicate sheet', file(workbook([lt1(), lt2(), { ...lt1(), name: 'I ANNO - AMBIENTE' }])), 'bad_shape'],
    ['mixed semesters', file(workbook([lt1(), lt2({ yearRow: '2° anno - II semestre' })])), 'wrong_period'],
    ['doctype', file(workbook([lt1(), lt2()], { patch: (p, x) => (p.endsWith('sheet1.xml') ? x.replace('?>', '?><!DOCTYPE x [<!ENTITY a "b">]>') : x) })), 'bad_shape'],
    ['macro', file(workbook([lt1(), lt2()], { extra: { 'xl/vbaProject.bin': new Uint8Array([1, 2, 3]) } })), 'bad_shape'],
    ['html instead of xlsx', file(strToU8('<html>errore</html>')), 'bad_shape'],
    ['wrong content type', { body: LT_BYTES(), headers: { 'content-type': 'text/html' } }, 'bad_shape'],
    ['server error', { status: 500, body: 'no' }, 'http_status'],
    ['too many requests', { status: 429, body: '' }, 'http_status'],
    ['network', new TypeError('fetch failed'), 'network'],
    ['timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'],
    ['too large', { body: new Uint8Array(FILE_MAX_BYTES + 1), headers: { 'content-type': XLSX_TYPE } }, 'too_large'],
  ];
  for (const [name, route, code] of cases) {
    const r = await outcomes(route, file(LM_BYTES()));
    assert.equal(r.lt1, code, name);
    assert.equal(r.lt2, code, name);
    data(r.lm1);
  }
  const lm = await outcomes(file(LT_BYTES()), file(workbook([roomsSheet(), lm1(), grid('3° LM Ambiente')])));
  assert.equal(lm.lm1, 'bad_shape');
  data(lm.lt1);
  const hidden = await outcomes(file(workbook([lt1(), lt2({ state: 'hidden' })])), file(LM_BYTES()));
  data(hidden.lt1);
  assert.equal(hidden.lt2, 'bad_shape');
  assert.ok(hidden.logs.some((l) => l.event === 'xlsx_sheet_failed' && l.fields.code === 'hidden_sheet'));
  const old = await outcomes(file(workbook([lt1({ academicYear: '2025-2026' }), lt2()])), file(LM_BYTES()));
  assert.equal(old.lt1, 'wrong_period');
  data(old.lt2);
});

test('the reader enforces its limits and refuses broken parts', () => {
  const ok = LT_BYTES();
  assert.equal(fileCode(ok), 'ok');
  assert.equal(fileCode(strToU8('<html></html>')), 'not_zip');
  assert.equal(fileCode(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3])), 'bad_zip');
  assert.throws(() => readXlsx(ok, { ...DEFAULT_LIMITS, maxBytes: 100 }), (e) => e instanceof XlsxError && e.code === 'too_large');
  assert.throws(() => readXlsx(ok, { ...DEFAULT_LIMITS, maxPartBytes: 200 }), (e) => e instanceof XlsxError && e.code === 'part_too_large');
  assert.throws(() => readXlsx(ok, { ...DEFAULT_LIMITS, maxTotalBytes: 2_000 }), (e) => e instanceof XlsxError && e.code === 'part_too_large');
  assert.throws(() => readXlsx(ok, { ...DEFAULT_LIMITS, maxEntries: 3 }), (e) => e instanceof XlsxError && e.code === 'too_many_entries');
  assert.throws(() => readXlsx(ok, { ...DEFAULT_LIMITS, maxSheets: 1 }), (e) => e instanceof XlsxError && e.code === 'too_many_sheets');
  assert.throws(() => readXlsx(ok, { ...DEFAULT_LIMITS, maxCellsPerSheet: 10 }), (e) => e instanceof XlsxError && e.code === 'too_many_cells');
  assert.throws(() => readXlsx(ok, { ...DEFAULT_LIMITS, maxMergedCells: 20 }), (e) => e instanceof XlsxError && e.code === 'too_many_cells');
  const patched = (from: RegExp, to: string, part = 'sheet1.xml') => workbook([lt1(), lt2()], { patch: (p, x) => (p.endsWith(part) ? x.replace(from, to) : x) });
  assert.equal(fileCode(patched(/<c r="A1" t="s"><v>\d+<\/v>/, '<c r="A1" t="s"><v>99999</v>')), 'bad_cell');
  assert.equal(fileCode(patched(/<c r="A1" t="s"><v>\d+<\/v>/, '<c r="A1" t="s"><v></v>')), 'bad_cell');
  assert.equal(fileCode(patched(/<c r="A1"/, '<c r="ZZ1"')), 'bad_cell');
  assert.equal(fileCode(patched(/<\/sheetData>/, '</sheetDta>')), 'bad_xml');
  assert.equal(fileCode(patched(/worksheets\/sheet2\.xml/, 'worksheets/sheet9.xml', 'workbook.xml.rels')), 'missing_part');
  assert.equal(fileCode(patched(/worksheets\/sheet2\.xml/, '../../etc/passwd', 'workbook.xml.rels')), 'missing_part');
  const inline = patched(/<c r="A1" t="s"><v>\d+<\/v><\/c>/, '<c r="A1" t="inlineStr"><is><t>CORSO DI LAUREA IN INGEGNERIA DI PROVA</t><rPh><t>x</t></rPh></is></c>');
  assert.equal(fileCode(inline), 'ok');
});

test('the rooms sheet is only compared with the configured table', async () => {
  const drift = setup(standard(file(LT_BYTES()), file(workbook([roomsSheet(140), lm1()]))));
  await drift.adapter.prepare();
  data(await outcome(drift.adapter, LM1));
  assert.ok(drift.logs.some((l) => l.event === 'xlsx_warning' && l.fields.code === 'room_table_drift' && l.fields.where === 'R2C2'));
  const broken = setup(standard(file(LT_BYTES()), file(workbook([{ name: 'AULE-UBICAZIONE', cells: { A1: 'ALTRO' } }, lm1()]))));
  await broken.adapter.prepare();
  data(await outcome(broken.adapter, LM1));
  assert.ok(broken.logs.some((l) => l.fields.code === 'rooms_sheet_invalid'));
  const clean = setup(standard());
  await clean.adapter.prepare();
  assert.ok(!clean.logs.some((l) => l.fields.code === 'room_table_drift' || l.fields.code === 'rooms_sheet_invalid'));
});

test('discovery needs exactly one LT and one LM workbook link', () => {
  const pageUrl = sourceUrl(PAGE_URL);
  const links = findFileLinks(PAGE, pageUrl);
  assert.equal(links.LT, LT_URL);
  assert.equal(links.LM, LM_URL, 'a protocol relative link is resolved against the page');
  assert.deepEqual(links.page, { semester: 1, academicYear: '2026-2027' });
  const a = (href: string, text: string) => `<a href="${href}">${text}</a>`;
  const fails = (html: string) => assert.throws(() => findFileLinks(html, pageUrl), (e) => e instanceof XlsxError && e.code === 'discovery_ambiguous');
  fails('<p>nessun link</p>');
  fails(a(LT_URL, 'Orario LT'));
  fails(a(LT_URL, 'Orario LT') + a(LM_URL, 'Orario LM') + a('https://www.unical.it/media/medias/2026/Nuovo_LT.xlsx', 'Orario LT'));
  fails(a('https://www.unical.it/media/medias/2026/Orario_comune.xlsx', 'Orario LT e LM') + a(LM_URL, 'Orario LM'));
  fails(a('https://www.unical.it/media/medias/2026/Orario_comune.xlsx', 'Orario') + a(LT_URL, 'Orario LT') + a(LM_URL, 'Orario LM'));
  fails(a(LT_URL, 'Orario LT') + a(LT_URL, 'Orario LM') + a(LM_URL, 'Orario LM'));
  fails(a('https://www.unical.it/media/medias/2026/Orario_gAAAAABprova.xlsx', 'Orario LT') + a(LM_URL, 'Orario LM'));
  const twice = findFileLinks(a(LT_URL, 'Orario LT') + a(LT_URL, 'LT') + `<a href='${LM_URL}'>Orario <b>LM</b></a>`, pageUrl);
  assert.equal(twice.LT, LT_URL);
  assert.equal(twice.page, null);
  const many = '<a x>'.repeat(5_001) + a(LT_URL, 'LT') + a(LM_URL, 'LM');
  fails(many);
  const unclosed = '<a href="x">'.repeat(50_000);
  const started = Date.now();
  fails(unclosed);
  assert.ok(Date.now() - started < 2_000, 'unclosed anchors are scanned in linear time');
});

test('a failing page fails every xlsx feed through prepare', async () => {
  const cases: [Route, string][] = [
    [{ status: 404, body: '' }, 'http_status'],
    [new TypeError('fetch failed'), 'network'],
    [page('<p>orario non disponibile</p>'), 'bad_html'],
    [{ body: 'x'.repeat(2_000_001), headers: { 'content-type': 'text/html' } }, 'too_large'],
  ];
  for (const [route, code] of cases) {
    const { adapter, calls } = setup({ [PAGE_URL]: route });
    await assert.rejects(adapter.prepare(), (e) => e instanceof SourceError && e.code === code);
    assert.equal(calls.length, 1, 'no workbook is requested');
    assert.equal(await outcome(adapter, LT1), 'unexpected');
  }
  const mismatch = setup({ ...standard(), [PAGE_URL]: page(PAGE.replace('I&deg; SEMESTRE', 'II&deg; SEMESTRE')) });
  await mismatch.adapter.prepare();
  data(await outcome(mismatch.adapter, LT1));
  assert.ok(mismatch.logs.some((l) => l.fields.code === 'page_semester_mismatch'));
});

test('requests are sequential and polite, and a 304 reuses the parsed templates', async () => {
  let notModified = false;
  const lt = (): Served => (notModified ? { status: 304 } : file(LT_BYTES()));
  const { adapter, calls, pauses, logs } = setup(standard(lt, file(LM_BYTES())));
  await adapter.prepare();
  const before = data(await outcome(adapter, LT1));
  assert.deepEqual(calls.map((c) => c.url), [PAGE_URL, LT_URL, LM_URL]);
  assert.deepEqual(pauses, [2_000, 2_000]);
  for (const c of calls) {
    const headers = c.init.headers as Record<string, string>;
    assert.equal(headers['User-Agent'], USER_AGENT);
    assert.equal(c.init.redirect, 'error');
    assert.equal(c.init.method, 'GET');
    assert.ok(c.init.signal instanceof AbortSignal);
    assert.ok(!Object.keys(headers).some((h) => h.toLowerCase() === 'cookie'));
    assert.ok(!('If-None-Match' in headers));
  }
  assert.equal((calls[0]!.init.headers as Record<string, string>).Accept, 'text/html');
  notModified = true;
  await adapter.prepare();
  const second = calls.slice(3);
  assert.deepEqual(second.map((c) => c.url), [PAGE_URL, LT_URL, LM_URL]);
  for (const c of second.slice(1)) {
    const headers = c.init.headers as Record<string, string>;
    assert.equal(headers['If-None-Match'], '"v1"');
    assert.equal(headers['If-Modified-Since'], 'Fri, 02 Oct 2026 12:59:29 GMT');
  }
  assert.deepEqual(data(await outcome(adapter, LT1)).parsed.lessons, before.parsed.lessons);
  assert.ok(logs.some((l) => l.event === 'xlsx_file' && l.fields.status === 304));
  assert.ok(logs.some((l) => l.event === 'xlsx_file' && l.fields.changed === false), 'same bytes are not parsed again');
});

test('a 304 to an unconditional request and unknown feeds fail closed', async () => {
  const r = await outcomes({ status: 304 }, file(LM_BYTES()));
  assert.equal(r.lt1, 'http_status');
  const { adapter } = setup(standard());
  assert.equal(await outcome(adapter, LT1), 'unexpected', 'fetch before prepare');
  await adapter.prepare();
  const other = parseDiamConfig({ ...RAW_CONFIG, sheets: [{ ...RAW_CONFIG.sheets[0]!, sheet: 'III ANNO - Ambiente', year: 3 }] }).sheets[0]!;
  assert.equal(await outcome(adapter, other), 'unexpected');
  await assert.rejects(adapter.fetch({ id: LT1.id, source: 'xlsx', ref: LT2.ref }, CTX), (e) => e instanceof SourceError && e.code === 'unexpected');
  await assert.rejects(adapter.fetch({ id: LT1.id, source: 'planner', ref: null }, CTX), (e) => e instanceof SourceError && e.code === 'unexpected');
  const bad = setup(standard(), { config: async () => parseDiamConfig({ ...RAW_CONFIG, version: 2 }) });
  await assert.rejects(bad.adapter.prepare(), (e) => e instanceof SourceError && e.code === 'unexpected');
  assert.ok(bad.logs.some((l) => l.event === 'xlsx_config_invalid' && l.fields.field === 'version'));
  assert.equal(bad.calls.length, 0);
});

test('specific codes map to the closed SourceFailure codes', () => {
  const table: [XlsxCode, string][] = [
    ['network', 'network'],
    ['timeout', 'timeout'],
    ['http_status', 'http_status'],
    ['too_large', 'too_large'],
    ['part_too_large', 'too_large'],
    ['discovery_ambiguous', 'bad_html'],
    ['academic_year_mismatch', 'wrong_period'],
    ['mixed_semester', 'wrong_period'],
    ['outside_semester', 'wrong_period'],
    ['too_many_cells', 'too_many'],
    ['bad_header', 'bad_shape'],
    ['unknown_rooms', 'bad_shape'],
    ['macro', 'bad_shape'],
    ['bad_content_type', 'bad_shape'],
    ['sheet_missing', 'bad_shape'],
    ['config_invalid', 'unexpected'],
  ];
  for (const [code, failure] of table) assert.equal(sourceFailure(code), failure, code);
});

test('text helpers and sheet names follow the spec', () => {
  assert.equal(norm("  Lunedi’  1º anno \u2014 Città "), "LUNEDI' 1° ANNO - CITTA");
  assert.equal(roomAlias('Aula B'), 'B');
  assert.equal(roomAlias('DIAM B'), 'B');
  assert.equal(roomAlias('Aula Seminari'), 'SEMINARI');
  assert.deepEqual(sheetRole('LT', 'III ANNO - Mare'), { kind: 'grid', year: 3 });
  assert.deepEqual(sheetRole('LM', '2º LM Ambiente-OK'), { kind: 'grid', year: 2 });
  assert.deepEqual(sheetRole('LM', 'AULE-UBICAZIONE-OK'), { kind: 'rooms' });
  assert.equal(sheetRole('LT', 'AULE-UBICAZIONE'), null);
  assert.equal(sheetRole('LM', '3° LM Ambiente'), null);
  assert.equal(sheetRole('LT', 'IV ANNO - Mare'), null);
});

test('the configuration is validated before any request', () => {
  const fails = (patch: Record<string, unknown>, field: string) =>
    assert.throws(() => parseDiamConfig({ ...RAW_CONFIG, ...patch }), (e) => e instanceof DiamConfigError && e.field === field, field);
  const sheet = RAW_CONFIG.sheets[0]!;
  const room = RAW_CONFIG.rooms[0]!;
  fails({ version: 2 }, 'version');
  fails({ extra: true }, 'config');
  fails({ pageUrl: 'http://example.unical.it/orario/' }, 'page_url');
  fails({ pageUrl: 'https://EXAMPLE.unical.it/orario/' }, 'page_url');
  fails({ pageUrl: 'https://example.unical.it/orario/gAAAAABprova/' }, 'page_url');
  fails({ academicYear: '2026-2028' }, 'academic_year');
  fails({ semesters: { '1': { first: '2026-12-19', last: '2026-09-21' }, '2': RAW_CONFIG.semesters['2'] } }, 'semester_1');
  fails({ semesters: { '1': RAW_CONFIG.semesters['1'], '2': { first: '2026-12-01', last: '2027-06-05' } } }, 'semesters');
  fails({ closedDays: ['2026-02-30'] }, 'closed_days');
  fails({ sheets: [{ ...sheet, sheet: 'IV ANNO - Ambiente' }] }, 'sheet_name');
  fails({ sheets: [{ ...sheet, sheet: '1° LM Ambiente-OK', file: 'LM' }] }, 'sheet_name');
  fails({ sheets: [{ ...sheet, year: 2 }] }, 'sheet_year');
  fails({ sheets: [{ ...sheet, course: 'Ingegneria' }] }, 'sheet_course');
  fails({ sheets: [{ ...sheet, label: 'x'.repeat(161) }] }, 'sheet_label');
  fails({ sheets: [{ ...sheet, label: ' Prova' }] }, 'sheet_label');
  fails({ sheets: [sheet, { ...sheet, sheet: 'I ANNO - AMBIENTE' }] }, 'sheet_duplicate');
  fails({ sheets: [] }, 'sheets');
  fails({ rooms: [{ ...room, alias: 'b' }] }, 'room_alias');
  fails({ rooms: [{ ...room, alias: 'C' }] }, 'room_name');
  fails({ rooms: [{ ...room, building: '---' }] }, 'room_building');
  fails({ rooms: [{ ...room, building: '' }] }, 'room_building');
  fails({ rooms: [{ ...room, capacity: 0 }] }, 'room_capacity');
  fails({ rooms: [room, room] }, 'room_duplicate');
  fails({ rooms: [{ ...room, floor: 2 }] }, 'room');
  assert.equal(LT1.ref, 'LT|I ANNO - Ambiente');
  assert.equal(LT1.id, feedId('xlsx', 'LT|I ANNO - Ambiente'));
  assert.equal(LM1.ref, 'LM|1° LM Ambiente');
});

test('config/diam.json is valid, its rooms are on the map and the migration equals the generator output', async () => {
  const config: DiamConfig = await loadDiamConfig();
  assert.equal(config.sheets.length, 8);
  assert.equal(config.rooms.size, 9);
  assert.deepEqual(
    config.sheets.map((s) => s.ref),
    [
      'LT|I ANNO - Ambiente', 'LT|I ANNO - Mare', 'LT|II ANNO - Ambiente', 'LT|II ANNO - Mare',
      'LT|III ANNO - Ambiente', 'LT|III ANNO - Mare', 'LM|1° LM Ambiente', 'LM|2° LM Ambiente',
    ],
  );
  for (const s of config.sheets) assert.equal(s.id, feedId('xlsx', s.ref));
  const campus = await loadCampus(fileURLToPath(new URL('public/data/campus.geojson', ROOT)));
  checkBuildings(config, campus.keys);
  assert.throws(() => checkBuildings(config, new Set(['cubo-42b'])), (e) => e instanceof DiamConfigError);
  const migration = readFileSync(fileURLToPath(new URL('supabase/migrations/20261110090500_xlsx_feeds.sql', ROOT)), 'utf8');
  assert.equal(migration, renderXlsxFeeds(config));
  assert.equal(renderXlsxFeeds(config), renderXlsxFeeds(await loadDiamConfig()), 'the output is deterministic');
  assert.equal((migration.match(/\('fffd[0-9a-f]{20}', 'xlsx', /g) ?? []).length, 8);
  assert.ok(!migration.includes('\u2014'));
});

test('the registry exposes the xlsx adapter', () => {
  const adapters = createAdapters();
  assert.equal(adapters.xlsx?.kind, 'xlsx');
  assert.equal(adapters.planner?.kind, 'planner');
});
