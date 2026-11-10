import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dimesAdapter, type DimesAdapterOptions } from '../src/sources/dimes.js';
import { createAdapters } from '../src/sources/registry.js';
import { SourceError, type Feed, type FetchContext, type SourceData } from '../src/sources/types.js';
import { PAGE_MAX_BYTES } from '../src/sources/dimes/client.js';
import { DimesError, sourceFailure, type DimesCode } from '../src/sources/dimes/codes.js';
import { DimesConfigError, loadDimesConfig, parseDimesConfig, type DimesConfig } from '../src/sources/dimes/config.js';
import { readDataset } from '../src/sources/dimes/dataset.js';
import { coverage, expandPlan } from '../src/sources/dimes/expand.js';
import { extractDataset, extractLiteral, JSON_MAX_CHARS, MARKER, parseLiteral } from '../src/sources/dimes/extract.js';
import { buildPlan, RESERVED_TITLE, type WeeklyPlan } from '../src/sources/dimes/plan.js';
import { checkBuildings, renderDimesFeeds } from '../scripts/gen-dimes-feeds-sql.js';
import { feedId, roomMatchKey, syntheticRoomId } from '../src/domain/ids.js';
import { isoDay, plannerId } from '../src/domain/primitives.js';
import { romeMidnight } from '../src/availability/time.js';
import { buildPayload } from '../src/sync/payload.js';
import { loadCampus } from '../src/campus.js';
import { USER_AGENT } from '../src/user-agent.js';
import type { LogFields, Logger } from '../src/log.js';

const ROOT = new URL('../../', import.meta.url);
const REAL = JSON.parse(readFileSync(fileURLToPath(new URL('config/dimes.json', ROOT)), 'utf8')) as { expected: unknown };
const URL_APP = 'https://orariocorsi.prova.unical.it/';

// Invented configuration in the shape of config/dimes.json, with its expected structure.
const RAW_CONFIG = {
  version: 1,
  url: URL_APP,
  label: 'Prova · Orario delle lezioni',
  academicYear: '2026/2027',
  semesters: { I: { first: '2026-09-21', last: '2026-12-19' }, II: { first: '2027-02-22', last: '2027-06-05' } },
  yearEnd: '2027-09-18',
  noLessonDays: ['2026-11-01', '2026-12-08'],
  expected: REAL.expected,
  rooms: [
    { app: 'A_CONSOLIDATA_32B1', name: 'Consolidata 32B1', building: 'Cubo 32B' },
    { app: 'A_32B3', name: '32B3', building: 'Cubo 32B' },
    { app: 'A_43C1', name: 'Consolidata 43C1', building: 'Cubo 43C' },
  ],
  externalRooms: [
    { texts: ['CP3 (Polifunzionale)'], name: 'CP3', building: 'Polifunzionale' },
    { texts: ['14 (Polifunzionale, cap. C)'], name: 'Aula 14', building: 'Polifunzionale Capannone C' },
    { texts: ['Aula sem. 44Z'], name: 'Aula sem. 44Z', building: 'Cubo 44Z' },
  ],
  offMapBuildings: { 'Polifunzionale Capannone C': 'capannone-c' },
  degreeClasses: { '0001': 'L-8', '0002': 'LM-25 R' },
};
const CONFIG = parseDimesConfig(RAW_CONFIG);
const FEED: Feed = { id: CONFIG.feedId, source: 'dimes', ref: URL_APP };

const day = (d: string) => isoDay(d);
const FROM = romeMidnight(day('2026-11-09'));
const TO = romeMidnight(day('2026-11-23'));
const CTX: FetchContext = { from: FROM, to: TO, plannerRooms: new Map() };
const NOW = Date.parse('2026-11-10T10:00:00Z');

// Strings that stand for personal or internal fields: none may leave the parser.
const SECRETS = [
  'CFSEGRETO',
  'VINCOLO_SEGRETO',
  'NOTA_',
  'FONTE_',
  'docente.segreto@example.invalid',
  'AVVISO_SEGRETO',
  'NOME_SENZA_RISPOSTA_SEGRETO',
  'NOME_LIBERO_SEGRETO',
  'Segretissimo',
  'SORGENTE_SEGRETA',
  'PERCORSO_SEGRETO',
  'FOGLIO_SEGRETO',
  'ID_DOC_',
  'libero:',
  '99000001',
];
// Invented teachers of the fixture: this source never reads teachers at all.
const TEACHERS = ['rossi', 'bianchi', 'verdi', 'nonusato'];

type Data = Record<string, any>;

function data(): Data {
  return {
    meta: {
      generato: '2026-09-01T08:00:00',
      annoAccademico: '2026/2027',
      dipartimento: { sigla: 'PROVA', nome: 'Dipartimento di prova', ateneo: 'Ateneo di prova' },
      giorni: ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì'],
      slot: ['08:30', '09:30', '10:30', '11:30', '12:30', '13:30', '15:00', '16:00', '17:00', '18:00'],
      durataSlot: 60,
      settimane: 13,
      sorgenti: { orario: 'SORGENTE_SEGRETA' },
      sorgentiPercorsi: { orario: '/PERCORSO_SEGRETO/orario.xlsx' },
      foglioProgrammazione: 'FOGLIO_SEGRETO',
      unitaFuse: { U_VECCHIA: 'U_ANALISI' },
      auleEsterne: [{ nome: 'CP3 (Polifunzionale)', alias: ['Aula CP3', 'CP3'] }],
      auleRimosse: { A_VECCHIA: 'Aula sem. 44Z' },
      auleRinominate: { A_LAB_VECCHIO: 'A_32B3' },
    },
    classi: [
      {
        id: '0001_OFO_1_GruppoA', cds: '0001', curr: 'OFO', anno: 1, partizione: 'Gruppo A', cdsNome: 'L INGEGNERIA DI PROVA',
        tipo: 'TRIENNALE', currNome: 'FORMATIVO', studenti: 90, fonteStudenti: 'FONTE_STUDENTI', studentiDichiarati: true,
        ordine: 0, famiglia: 'ingegneria di prova', partizioneEreditata: [], insegnamentiSdoppiati: [],
      },
      { id: '0001_OFO_2_9999', cds: '0001', curr: 'OFO', anno: 2, partizione: '', cdsNome: 'L INGEGNERIA DI PROVA', tipo: 'TRIENNALE', studenti: 70 },
      { id: '0002_ROB_1_9999', cds: '0002', curr: 'ROB', anno: 1, partizione: '', cdsNome: 'LM ROBOTICA DI PROVA', tipo: 'MAGISTRALE' },
    ],
    famiglie: [{ id: 'ingegneria di prova', nome: 'INGEGNERIA DI PROVA', tipo: 'TRIENNALE', cds: ['0001'] }],
    unita: [
      {
        id: 'U_ANALISI', cod: '99000001', nome: 'ANALISI DI PROVA', nomi: ['ANALISI DI PROVA'], nomiClasse: {}, codiClasse: { '0001_OFO_1_GruppoA': '99000002' },
        cfu: 9, semestre: 'I', semestriClasse: {}, classi: ['0001_OFO_1_GruppoA'], mutuato: false, docenteResp: 'ID_DOC_901',
        docenti: [
          { id: 'ID_DOC_901', etichetta: 'Rossi Mario', ore: 60, ignoto: false },
          { id: 'ID_DOC_999', etichetta: 'Docente da nominare', ore: 0, ignoto: true },
        ],
        note: 'NOTA_UNITA', fonteOre: 'FONTE_ORE',
      },
      {
        id: 'U_FISICA', cod: '99000003', nome: 'FISICA DI PROVA', semestre: null, classi: ['0001_OFO_1_GruppoA', '0001_OFO_2_9999'],
        docenti: [{ id: 'ID_DOC_902', etichetta: 'Bianchi Anna', ore: 40, ignoto: false }],
      },
      {
        id: 'U_ROBOT', nome: 'ROBOTICA DI PROVA', nomiClasse: { '0002_ROB_1_9999': 'ROBOTICA DI PROVA I' }, semestre: 'I',
        classi: ['0002_ROB_1_9999'], docenti: [{ id: 'ID_DOC_902', etichetta: 'Bianchi Anna', ore: 10, ignoto: false }],
      },
      { id: 'U_SECONDO', nome: 'CORSO DEL SECONDO SEMESTRE', semestre: 'II', classi: ['0001_OFO_1_GruppoA'], docenti: [] },
    ],
    docenti: {
      ID_DOC_901: {
        id: 'ID_DOC_901', cf: 'CFSEGRETO01', nome: 'MARIO', cognome: 'ROSSI', etichetta: 'Rossi Mario',
        vincoli: { '0': [{ da: 510, a: 630, motivo: 'VINCOLO_SEGRETO' }] }, note: 'NOTA_DOCENTE', fonteVincoli: 'FONTE_VINCOLI',
        email: 'docente.segreto@example.invalid',
      },
      ID_DOC_902: { id: 'ID_DOC_902', cf: 'CFSEGRETO02', nome: 'Anna', cognome: 'Bianchi', etichetta: 'Bianchi Anna', vincoli: {}, note: '', fonteVincoli: null },
      ID_DOC_903: { id: 'ID_DOC_903', cf: 'CFSEGRETO03', nome: 'Nonusato', cognome: 'Segretissimo', etichetta: 'Segretissimo Nonusato', vincoli: {} },
    },
    aule: [
      {
        id: 'A_CONSOLIDATA_32B1', nome: 'Consolidata 32B1', dip: 'PROVA', cubo: '32B', piano: '5', posti: 278,
        note: 'NOTA_AULA', finestre: { '0': [{ da: 510, a: 630 }] }, vincoli: { x: 'VINCOLO_SEGRETO' }, soloFinestre: false, esterna: false,
      },
      { id: 'A_32B3', nome: '32B3', dip: 'PROVA', cubo: '32B', piano: '7', posti: 132 },
      { id: 'A_43C1', nome: '43C1', dip: 'ALTRO', cubo: '43C', piano: '5', posti: 280, esterna: true, soloFinestre: true },
      { id: 'A_NUOVA', nome: '45C2', dip: 'PROVA', cubo: '45c', piano: '1', posti: 50 },
    ],
    avvisi: ['AVVISO_SEGRETO'],
    docentiSenzaRisposta: ['NOME_SENZA_RISPOSTA_SEGRETO'],
    statiIniziali: {
      'Orario di prova (I semestre) v1': {
        nome: 'Orario di prova (I semestre) v1',
        semestre: 'I',
        salvato: '2026-10-01T10:00:00.000Z',
        posizioni: {
          U_ANALISI: [
            { g: 0, s: 2, off: 0, aula: 'A_CONSOLIDATA_32B1', aulaEsterna: null },
            { g: 0, s: 3, off: 0, aula: 'A_CONSOLIDATA_32B1', aulaEsterna: null },
            { g: 0, s: 4, off: 0, aula: 'A_CONSOLIDATA_32B1', aulaEsterna: null },
            { g: 1, s: 0, off: 0, aula: 'A_32B3', aulaEsterna: null },
          ],
          U_VECCHIA: [{ g: 2, s: 0, off: 0, aula: 'A_LAB_VECCHIO', aulaEsterna: null }],
          U_FISICA: [
            { g: 3, s: 6, off: 1, aula: null, aulaEsterna: 'Aula CP3' },
            { g: 3, s: 7, off: 1, aula: null, aulaEsterna: 'Aula CP3' },
          ],
          U_ROBOT: [
            { g: 4, s: 0, off: 0, aula: 'A_43C1', aulaEsterna: null },
            { g: 4, s: 2, off: 0, aula: 'A_VECCHIA', aulaEsterna: null },
            { g: 1, s: 2, off: 0, aula: null, aulaEsterna: '14  (Polifunzionale, cap. C)' },
            { g: 2, s: 3, off: 0, aula: 'A_NUOVA', aulaEsterna: null },
          ],
          U_SECONDO: [{ g: 0, s: 0, off: 0, aula: 'A_32B3', aulaEsterna: null }],
        },
        riserve: [{ sem: 'I', c: '0001_OFO_2_9999', g: 2, s: 5, off: 0, aula: 'A_32B3', aulaEsterna: null, nota: 'NOTA_RISERVA' }],
        personalizzazioni: {
          nuove: {},
          aggiunte: {},
          rimosse: {},
          oreSett: {},
          docente: { U_ROBOT: 'libero:anna verdi' },
          classiNuove: {},
          docentiLiberi: { 'libero:anna verdi': 'Anna Verdi', 'libero:nome segreto': 'NOME_LIBERO_SEGRETO' },
        },
      },
    },
  };
}

function page(d: unknown = data()): string {
  return `<!doctype html><html><head><script>\nconst MODO_BASE = "lettura";\n${MARKER}${JSON.stringify(d)};\nfunction avvia(){}\n</script></head><body></body></html>`;
}

function plan(d: Data = data(), cfg: DimesConfig = CONFIG): WeeklyPlan {
  return buildPlan(readDataset(parseLiteral(extractLiteral(page(d))), cfg), cfg);
}

function codeOf(fn: () => unknown): DimesCode | string {
  try {
    fn();
    return 'ok';
  } catch (err) {
    return err instanceof DimesError ? err.code : String(err);
  }
}

type Route = { status?: number; body?: string | null; headers?: Record<string, string> } | Error;

function setup(routes: Route[], options: Partial<DimesAdapterOptions> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const logs: { level: string; event: string; fields: LogFields }[] = [];
  const pauses: number[] = [];
  const queue = [...routes];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const route = queue.length > 1 ? queue.shift()! : queue[0]!;
    if (route instanceof Error) throw route;
    return new Response(route.body ?? null, { status: route.status ?? 200, headers: route.headers ?? {} });
  }) as typeof fetch;
  const at = (level: string) => (event: string, fields: LogFields = {}) => void logs.push({ level, event, fields });
  const log: Logger = { info: at('info'), warn: at('warn'), error: at('error') };
  const adapter = dimesAdapter({
    fetchImpl,
    log,
    config: async () => CONFIG,
    now: () => NOW,
    sleep: async (ms) => void pauses.push(ms),
    ...options,
  });
  return { adapter, calls, logs, pauses };
}

const ok = (body: string = page(), headers: Record<string, string> = {}): Route => ({
  status: 200,
  body,
  headers: { 'content-type': 'text/html', etag: '"v1"', 'last-modified': 'Mon, 19 Oct 2026 13:31:02 GMT', ...headers },
});

async function outcome(routes: Route[], ctx: FetchContext = CTX, options: Partial<DimesAdapterOptions> = {}) {
  const s = setup(routes, options);
  let result: SourceData | string;
  try {
    await s.adapter.prepare();
    result = await s.adapter.fetch(FEED, ctx);
  } catch (err) {
    if (!(err instanceof SourceError)) throw err;
    result = err.code;
  }
  return { ...s, result };
}

const iso = (ms: number) => new Date(ms).toISOString();

// ---------- least data ----------

test('personal fields of the page never reach the dataset, the lessons, the payload or the logs', async () => {
  const html = page();
  for (const s of SECRETS) assert.ok(html.includes(s), `the fixture contains ${s}`);

  const parsed = JSON.stringify(parseLiteral(extractLiteral(html)));
  for (const s of ['CFSEGRETO', 'VINCOLO_SEGRETO', 'NOTA_', 'docente.segreto@example.invalid', 'AVVISO_SEGRETO', 'NOME_SENZA_RISPOSTA_SEGRETO', 'SORGENTE_SEGRETA', 'FOGLIO_SEGRETO', 'NOME_LIBERO_SEGRETO', 'Segretissimo', 'ID_DOC_', 'libero:']) {
    assert.ok(!parsed.includes(s), `${s} is dropped while parsing`);
  }
  for (const t of TEACHERS) assert.ok(!parsed.toLowerCase().includes(t), `${t} is dropped while parsing`);

  const ds = readDataset(parseLiteral(extractLiteral(html)), CONFIG);
  const dataset = JSON.stringify(ds, (_k, v: unknown) => (v instanceof Map ? [...v] : v));
  for (const s of SECRETS) assert.ok(!dataset.includes(s), `${s} is not in the dataset`);
  for (const t of TEACHERS) assert.ok(!dataset.toLowerCase().includes(t), `${t} is not in the dataset`);

  const { result, logs } = await outcome([ok(html)]);
  assert.ok(typeof result !== 'string', String(result));
  const payload = buildPayload(result.parsed, result.from, result.to);
  const out = JSON.stringify(result) + JSON.stringify(payload) + JSON.stringify(logs);
  for (const s of [...SECRETS, 'U_ANALISI', 'A_CONSOLIDATA_32B1', '0001_OFO']) assert.ok(!out.includes(s), `${s} never leaves the adapter`);
  for (const t of TEACHERS) assert.ok(!out.toLowerCase().includes(t), `${t} never leaves the adapter`);
  assert.ok(result.parsed.lessons.length > 0);
  for (const l of result.parsed.lessons) {
    assert.deepEqual(l.teachers, []);
    assert.deepEqual(Object.keys(l).sort(), ['courses', 'end', 'id', 'kind', 'roomIds', 'start', 'status', 'teachers', 'title', 'year']);
  }
  for (const r of result.parsed.rooms) {
    assert.deepEqual(Object.keys(r).sort(), ['buildingName', 'capacity', 'code', 'effectiveCapacity', 'id', 'name', 'services']);
    assert.equal(r.code, '');
  }
});

test('logs carry only events, ids, counts and codes', async () => {
  const { logs } = await outcome([ok()]);
  const events = logs.map((l) => l.event);
  assert.deepEqual(events, ['dimes_page', 'dimes_plan', 'dimes_rooms']);
  for (const l of logs) {
    for (const [k, v] of Object.entries(l.fields)) {
      if (k === 'calendar') assert.equal(v, CONFIG.feedId);
      else assert.ok(typeof v === 'number' || typeof v === 'boolean', `${l.event}.${k}`);
    }
  }
});

// ---------- extraction ----------

test('the embedded literal is cut with a brace counter that knows JSON strings', () => {
  const wrap = (body: string) => `<script>${MARKER}${body};\nconst ALTRO = {};</script>`;
  assert.deepEqual(extractDataset(wrap('{"a":"x{y}z","b":"say \\"}\\" here","c":{"d":[1,{"e":"\\\\"}]}}')), {
    a: 'x{y}z',
    b: 'say "}" here',
    c: { d: [1, { e: '\\' }] },
  });
  assert.equal(codeOf(() => extractLiteral('<script>const ALTRO = {};</script>')), 'no_marker');
  assert.equal(codeOf(() => extractLiteral(wrap('{}') + wrap('{}'))), 'many_markers');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}null;`)), 'null_data');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}[1,2];`)), 'bad_literal');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}{"a":1}`)), 'bad_literal');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}{"a":"}"`)), 'bad_literal');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}{"a":1}\n;`)), 'bad_literal');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}${'{"a":'.repeat(70)}1${'}'.repeat(70)};`)), 'bad_literal');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}{"a":${'['.repeat(70)}${']'.repeat(70)}};`)), 'bad_literal');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}{"a":1]};`)), 'bad_literal');
  assert.equal(codeOf(() => extractLiteral(`${MARKER}{"a":"${'x'.repeat(JSON_MAX_CHARS)}"};`)), 'json_too_large');
  assert.equal(codeOf(() => extractDataset(`${MARKER}{"a":01};`)), 'bad_json');
  assert.equal(codeOf(() => extractDataset(`${MARKER}{a:1};`)), 'bad_json');
  // A JavaScript expression is never evaluated.
  assert.equal(codeOf(() => extractDataset(`${MARKER}{"a":(()=>1)()};`)), 'bad_json');
});

// ---------- structure ----------

test('the structure must be the expected one, unknown structure fails closed', () => {
  const change = (fn: (d: Data) => void) => {
    const d = data();
    fn(d);
    return codeOf(() => plan(d));
  };
  assert.equal(change(() => undefined), 'ok');
  assert.equal(change((d) => (d.meta.annoAccademico = '2025/2026')), 'wrong_year');
  assert.equal(change((d) => (d.statiIniziali = {})), 'no_state');
  assert.equal(change((d) => (Object.values(d.statiIniziali)[0] as Data).semestre = 'III'), 'no_state');
  assert.equal(change((d) => ((Object.values(d.statiIniziali)[0] as Data).posizioni = {})), 'no_state');
  assert.equal(change((d) => (d.nuovaChiave = 1)), 'unknown_key');
  assert.equal(change((d) => (d.meta.nuovaChiave = 1)), 'unknown_key');
  assert.equal(change((d) => (d.unita[0].nuovaChiave = 1)), 'unknown_key');
  assert.equal(change((d) => ((Object.values(d.statiIniziali)[0] as Data).posizioni.U_ANALISI[0].nuova = 1)), 'unknown_key');
  assert.equal(change((d) => delete d.meta.slot), 'bad_shape');
  assert.equal(change((d) => (d.meta.slot = ['09:30', '08:30'])), 'bad_shape');
  assert.equal(change((d) => (d.meta.slot = ['8:30'])), 'bad_shape');
  assert.equal(change((d) => (d.meta.durataSlot = 20)), 'bad_shape');
  assert.equal(change((d) => (d.meta.giorni = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato'])), 'bad_days');
  assert.equal(change((d) => (d.meta.giorni = ['Martedì', 'Lunedì', 'Mercoledì', 'Giovedì', 'Venerdì'])), 'bad_days');
  assert.equal(change((d) => (d.unita[0].docenti = 'qualunque forma')), 'ok', 'teacher fields are dropped before any check');
  assert.equal(change((d) => (d.unita[0].semestre = 'annuale')), 'bad_shape');
  assert.equal(change((d) => (d.classi[0].cds = '1')), 'bad_shape');
  assert.equal(change((d) => (d.classi[0].anno = 9)), 'bad_shape');
  assert.equal(change((d) => d.classi.push(d.classi[0])), 'bad_shape');
  assert.equal(change((d) => ((Object.values(d.statiIniziali)[0] as Data).posizioni.U_ANALISI[0].g = '0')), 'bad_shape');
  assert.equal(change((d) => ((Object.values(d.statiIniziali)[0] as Data).posizioni.U_ANALISI[0].aula = 5)), 'bad_shape');
  assert.equal(change((d) => (d.unita = Array.from({ length: 3001 }, () => d.unita[0]))), 'too_many');
  assert.equal(change((d) => (d.aule = Array.from({ length: 301 }, () => d.aule[0]))), 'too_many');
  // Keys of the page are only map keys: a "__proto__" key is data, not a prototype.
  const proto = plan(JSON.parse(JSON.stringify(data()).replace('"U_SECONDO":[', '"__proto__":[')) as Data);
  assert.equal(proto.skipped, 1, 'an unknown teaching named __proto__ is skipped and counted');
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('single bad hours are skipped and counted, above 10 percent the plan fails', () => {
  const d = data();
  const positions = (Object.values(d.statiIniziali)[0] as Data).posizioni;
  positions.U_ANALISI.push({ g: 5, s: 0, off: 0, aula: 'A_32B3', aulaEsterna: null });
  const p = plan(d);
  assert.equal(p.skipped, 1);
  assert.equal(p.ignored, 1);
  assert.equal(p.hours, 13);
  positions.U_ANALISI.push({ g: 0, s: 10, off: 0, aula: 'A_32B3', aulaEsterna: null });
  positions.U_SCONOSCIUTA = [{ g: 0, s: 0, off: 3, aula: 'A_32B3', aulaEsterna: null }];
  assert.equal(codeOf(() => plan(d)), 'too_many_skipped');
  // Only hours of the other semester: nothing to show is a failure, not an empty timetable.
  const other = data();
  const state = Object.values(other.statiIniziali)[0] as Data;
  state.posizioni = { U_SECONDO: [{ g: 0, s: 0, off: 0, aula: 'A_32B3', aulaEsterna: null }] };
  state.riserve = [];
  assert.equal(codeOf(() => plan(other)), 'no_state');
});

// ---------- weekly plan ----------

test('contiguous hours merge, fused units, renamed, removed and external rooms follow the app', () => {
  const p = plan();
  const blocks = p.blocks.map((b) => ({ key: b.key, title: b.title, wd: b.weekday, from: b.startMin, to: b.endMin, room: `${b.room.building}|${b.room.name}` }));
  assert.deepEqual(blocks, [
    { key: 'U_ANALISI', title: 'ANALISI DI PROVA', wd: 0, from: 630, to: 810, room: 'Cubo 32B|Consolidata 32B1' },
    { key: 'U_ANALISI', title: 'ANALISI DI PROVA', wd: 1, from: 510, to: 570, room: 'Cubo 32B|32B3' },
    { key: 'U_ANALISI', title: 'ANALISI DI PROVA', wd: 2, from: 510, to: 570, room: 'Cubo 32B|32B3' },
    { key: 'U_FISICA', title: 'FISICA DI PROVA', wd: 3, from: 930, to: 1050, room: 'Polifunzionale|CP3' },
    { key: 'U_ROBOT', title: 'ROBOTICA DI PROVA I', wd: 1, from: 630, to: 690, room: 'Polifunzionale Capannone C|Aula 14' },
    { key: 'U_ROBOT', title: 'ROBOTICA DI PROVA I', wd: 2, from: 690, to: 750, room: 'Cubo 45C|45C2' },
    { key: 'U_ROBOT', title: 'ROBOTICA DI PROVA I', wd: 4, from: 510, to: 570, room: 'Cubo 43C|Consolidata 43C1' },
    { key: 'U_ROBOT', title: 'ROBOTICA DI PROVA I', wd: 4, from: 630, to: 690, room: 'Cubo 44Z|Aula sem. 44Z' },
    { key: 'reserve|0001_OFO_2_9999', title: RESERVED_TITLE, wd: 2, from: 810, to: 870, room: 'Cubo 32B|32B3' },
  ]);
  assert.equal(p.fallbackRooms, 1, 'only 45C2 comes from the general rule');
  const fisica = p.blocks.find((b) => b.key === 'U_FISICA')!;
  assert.deepEqual(fisica.courses, ['INGEGNERIA DI PROVA (triennale)']);
  assert.equal(fisica.year, null, 'a block shared by two years has no year');
  const robot = p.blocks.find((b) => b.key === 'U_ROBOT')!;
  assert.deepEqual(robot.courses, ['ROBOTICA DI PROVA (magistrale)']);
  assert.equal(robot.year, 1);
  const analisi = p.blocks.find((b) => b.key === 'U_ANALISI')!;
  assert.equal(analisi.room.capacity, 278);
  assert.ok(p.blocks.every((b) => !('teachers' in b)));
});

// ---------- expansion ----------

test('the weekly plan becomes dated lessons in Rome time, only inside the semester and outside days without lessons', async () => {
  const { result } = await outcome([ok()]);
  assert.ok(typeof result !== 'string');
  assert.equal(result.from, FROM);
  assert.equal(result.to, TO);
  const monday = result.parsed.lessons.filter((l) => l.title === 'ANALISI DI PROVA' && iso(l.start).startsWith('2026-11-09'));
  assert.deepEqual(monday.map((l) => [iso(l.start), iso(l.end)]), [['2026-11-09T09:30:00.000Z', '2026-11-09T12:30:00.000Z']]);
  assert.equal(result.parsed.lessons.length, 18, 'nine weekly blocks in two weeks');
  for (const l of result.parsed.lessons) {
    assert.equal(l.status, 'active');
    assert.equal(l.kind, "ATTIVITA' DIDATTICA");
    assert.match(l.id, /^fffe[0-9a-f]{20}$/);
    assert.equal(l.roomIds.length, 1);
  }
  assert.equal(new Set(result.parsed.lessons.map((l) => l.id)).size, 18);

  const expand = (from: string, to: string, today: string, p: WeeklyPlan = plan()) =>
    expandPlan(p, CONFIG, { from: romeMidnight(day(from)), to: romeMidnight(day(to)), plannerRooms: new Map() }, day(today));
  const days = (e: ReturnType<typeof expand>) => [...new Set(e.data.parsed.lessons.map((l) => iso(l.start).slice(0, 10)))].sort();
  assert.deepEqual(days(expand('2026-12-07', '2026-12-12', '2026-12-08')), ['2026-12-07', '2026-12-09', '2026-12-10', '2026-12-11']);
  assert.deepEqual(days(expand('2026-12-14', '2026-12-28', '2026-12-20')), ['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17', '2026-12-18']);
  // Daylight saving ends on Sunday 25/10/2026: 08:30 in Rome is 06:30Z before and 07:30Z after.
  const dst = expand('2026-10-20', '2026-10-28', '2026-10-25').data.parsed.lessons.filter((l) => l.title === 'ANALISI DI PROVA');
  assert.deepEqual(dst.map((l) => iso(l.start)), [
    '2026-10-20T06:30:00.000Z',
    '2026-10-21T06:30:00.000Z',
    '2026-10-26T09:30:00.000Z',
    '2026-10-27T07:30:00.000Z',
  ]);
});

test('coverage stops where the state stops, a state of the other semester fails with wrong_period', async () => {
  const p = plan();
  const window = (from: string, to: string) => ({ from: romeMidnight(day(from)), to: romeMidnight(day(to)) });
  assert.deepEqual(coverage('I', CONFIG, window('2027-02-15', '2027-03-01')), { from: romeMidnight(day('2027-02-15')), to: romeMidnight(day('2027-02-22')) });
  assert.deepEqual(coverage('I', CONFIG, window('2026-09-14', '2026-09-30')), { from: romeMidnight(day('2026-09-21')), to: romeMidnight(day('2026-09-30')) });
  assert.deepEqual(coverage('II', CONFIG, window('2026-12-14', '2026-12-30')), { from: romeMidnight(day('2026-12-20')), to: romeMidnight(day('2026-12-30')) });
  assert.deepEqual(coverage('II', CONFIG, window('2027-09-10', '2027-10-01')), { from: romeMidnight(day('2027-09-10')), to: romeMidnight(day('2027-09-19')) });
  assert.equal(codeOf(() => coverage('I', CONFIG, window('2027-02-22', '2027-03-01'))), 'outside_semester');
  const inBreak = expandPlan(p, CONFIG, { ...window('2027-02-15', '2027-03-01'), plannerRooms: new Map() }, day('2027-02-21'));
  assert.equal(inBreak.data.parsed.lessons.length, 0);
  assert.equal(inBreak.data.to, romeMidnight(day('2027-02-22')));
  assert.equal(codeOf(() => expandPlan(p, CONFIG, { ...window('2027-02-16', '2027-03-10'), plannerRooms: new Map() }, day('2027-02-23'))), 'semester_mismatch');

  const late = await outcome([ok()], { ...window('2027-02-16', '2027-03-10'), plannerRooms: new Map() }, { now: () => Date.parse('2027-02-23T10:00:00Z') });
  assert.equal(late.result, 'wrong_period');
  assert.ok(late.logs.some((l) => l.event === 'dimes_failed' && l.fields.code === 'semester_mismatch' && l.fields.calendar === CONFIG.feedId));
  const year = await outcome([ok(page({ ...data(), meta: { ...data().meta, annoAccademico: '2027/2028' } }))]);
  assert.equal(year.result, 'wrong_period');
  assert.ok(year.logs.some((l) => l.event === 'dimes_failed' && l.fields.code === 'wrong_year'));
});

// ---------- rooms ----------

test('a room the Planner knows keeps its Planner id, the others get stable synthetic ids', async () => {
  const consolidata = roomMatchKey('Cubo 32B', 'Consolidata 32B1')!;
  const plannerRoom = plannerId('5fc6b254d0ffc7001bffc112');
  const ctx: FetchContext = { ...CTX, plannerRooms: new Map([[consolidata, plannerRoom]]) };
  const first = await outcome([ok()], ctx);
  const second = await outcome([ok()], ctx);
  assert.ok(typeof first.result !== 'string' && typeof second.result !== 'string');
  const lessons = first.result.parsed.lessons;
  assert.ok(lessons.filter((l) => l.title === 'ANALISI DI PROVA' && l.roomIds[0] === plannerRoom).length === 2);
  assert.ok(!first.result.parsed.rooms.some((r) => r.id === plannerRoom), 'a Planner room is not repeated');
  assert.deepEqual(lessons.map((l) => l.id), second.result.parsed.lessons.map((l) => l.id), 'lesson ids do not change between runs');
  const rooms = new Map(first.result.parsed.rooms.map((r) => [`${r.buildingName}|${r.name}`, r]));
  assert.deepEqual([...rooms.keys()].sort(), [
    'Cubo 32B|32B3',
    'Cubo 43C|Consolidata 43C1',
    'Cubo 44Z|Aula sem. 44Z',
    'Cubo 45C|45C2',
    'Polifunzionale Capannone C|Aula 14',
    'Polifunzionale|CP3',
  ]);
  assert.equal(rooms.get('Cubo 43C|Consolidata 43C1')?.id, syntheticRoomId('cubo-43c', 'consolidata43c1'));
  assert.equal(rooms.get('Polifunzionale|CP3')?.capacity, null);
  assert.equal(rooms.get('Cubo 32B|32B3')?.capacity, 132);
  const counts = first.logs.find((l) => l.event === 'dimes_rooms')?.fields;
  assert.deepEqual(counts, { calendar: CONFIG.feedId, planner: 1, synthetic: 6, unplaced: 0 });
  const payload = buildPayload(first.result.parsed, first.result.from, first.result.to);
  assert.equal(payload.skipped, 0);
  assert.equal(payload.rooms.find((r) => r.name === 'Aula 14')?.buildingKeyGuess, 'polifunzionale-capannone-c');
});

test('a room without a building key keeps no lesson on the map and is counted', async () => {
  const d = data();
  (Object.values(d.statiIniziali)[0] as Data).posizioni.U_FISICA[0].aulaEsterna = 'Sala riunioni';
  const { result, logs } = await outcome([ok(page(d))]);
  assert.ok(typeof result !== 'string');
  assert.equal(result.parsed.skipped, 2);
  assert.equal(logs.find((l) => l.event === 'dimes_rooms')?.fields.unplaced, 1);
  assert.equal(logs.find((l) => l.event === 'dimes_plan')?.fields.fallbackRooms, 2);
  // A cube is read from "cubo NN X" or an attached code, never from loose words such as "1 e".
  const roomOf = (text: string) => {
    (Object.values(d.statiIniziali)[0] as Data).posizioni.U_FISICA[0].aulaEsterna = text;
    const b = plan(d).blocks.find((x) => x.key === 'U_FISICA' && x.startMin === 930)!;
    return `${b.room.building}|${b.room.name}|${b.room.matchKey}`;
  };
  assert.equal(roomOf('Sala 1 e 2'), '|Sala 1 e 2|null');
  assert.equal(roomOf('Laboratorio 2 B (cubo 41 C)'), 'Cubo 41C|Laboratorio 2 B|cubo-41c|laboratorio2b');
  assert.equal(roomOf('Sala seminari 42C'), 'Cubo 42C|Sala seminari 42C|cubo-42c|salaseminari42c');
  // Placeholders are no room at all.
  for (const vague of ['da definire', 'n.d.', '?', String.fromCharCode(0x2013, 0x2013)]) {
    (Object.values(d.statiIniziali)[0] as Data).posizioni.U_FISICA[0].aulaEsterna = vague;
    assert.equal(plan(d).skipped, 1, vague);
  }
});

// ---------- requests ----------

test('one polite conditional GET; a 304 or the same bytes reuse the plan', async () => {
  const s = setup([ok(), { status: 304 }, ok()]);
  await s.adapter.prepare();
  const first = await s.adapter.fetch(FEED, CTX);
  await s.adapter.prepare();
  const second = await s.adapter.fetch(FEED, CTX);
  await s.adapter.prepare();
  assert.deepEqual(first, second);
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[0]!.url, URL_APP);
  for (const c of s.calls) {
    assert.equal(c.init.redirect, 'error');
    assert.equal(c.init.method, 'GET');
    assert.ok(c.init.signal instanceof AbortSignal);
  }
  const headers = s.calls.map((c) => c.init.headers as Record<string, string>);
  assert.equal(headers[0]!['User-Agent'], USER_AGENT);
  assert.equal(headers[0]!['If-None-Match'], undefined);
  assert.equal(headers[1]!['If-None-Match'], '"v1"');
  assert.equal(headers[1]!['If-Modified-Since'], 'Mon, 19 Oct 2026 13:31:02 GMT');
  assert.deepEqual(
    s.logs.filter((l) => l.event === 'dimes_page').map((l) => l.fields),
    [{ status: 200, changed: true }, { status: 304 }, { status: 200, changed: false }],
  );
});

test('network errors and 5xx get one more try after a pause, everything else fails closed', async () => {
  const retried = await outcome([{ status: 503, body: 'no' }, ok()]);
  assert.ok(typeof retried.result !== 'string');
  assert.deepEqual(retried.pauses, [60_000]);
  assert.equal(retried.calls.length, 2);
  assert.ok(retried.logs.some((l) => l.event === 'dimes_retry'));
  const down = await outcome([new TypeError('fetch failed'), { status: 500 }]);
  assert.equal(down.result, 'http_status');
  assert.equal(down.calls.length, 2);
  assert.equal((await outcome([new TypeError('fetch failed')])).result, 'network');
  const timeout = new Error('timeout');
  timeout.name = 'TimeoutError';
  assert.equal((await outcome([timeout])).result, 'timeout');
  const notFound = await outcome([{ status: 404 }]);
  assert.equal(notFound.result, 'http_status');
  assert.equal(notFound.calls.length, 1, 'no retry for a 4xx');
  assert.equal((await outcome([{ status: 302, headers: { location: 'https://altro.example/' } }])).result, 'http_status');
  assert.equal((await outcome([{ status: 304 }])).result, 'http_status', 'a 304 to an unconditional request');
  assert.equal((await outcome([ok(page(), { 'content-type': 'application/json' })])).result, 'bad_html');
  assert.equal((await outcome([ok(page(), { 'content-length': String(PAGE_MAX_BYTES + 1) })])).result, 'too_large');
  assert.equal((await outcome([ok(page() + ' '.repeat(PAGE_MAX_BYTES))])).result, 'too_large');
  const bad = await outcome([{ status: 200, body: null, headers: { 'content-type': 'text/html; charset=utf-8' } }]);
  assert.equal(bad.result, 'bad_html');
  assert.ok(bad.logs.some((l) => l.event === 'dimes_failed' && l.fields.code === 'no_marker'));
  assert.equal((await outcome([ok(page().replace('{"meta"', '{"meta":1,"x"'))])).result, 'bad_shape');
});

test('invalid UTF-8 is refused before any parsing', async () => {
  const bytes = new Uint8Array([0x3c, 0xff, 0xfe, 0x3e]);
  const fetchImpl = (async () => new Response(bytes, { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const adapter = dimesAdapter({ fetchImpl, log: { info() {}, warn() {}, error() {} }, config: async () => CONFIG, now: () => NOW });
  await assert.rejects(adapter.prepare(), (e) => e instanceof SourceError && e.code === 'bad_html');
});

test('only the configured feed is served, nothing runs before prepare', async () => {
  const s = setup([ok()]);
  await assert.rejects(s.adapter.fetch(FEED, CTX), (e) => e instanceof SourceError && e.code === 'unexpected');
  await s.adapter.prepare();
  const other: Feed = { id: feedId('dimes', 'https://altro.unical.it/'), source: 'dimes', ref: 'https://altro.unical.it/' };
  await assert.rejects(s.adapter.fetch(other, CTX), (e) => e instanceof SourceError && e.code === 'unexpected');
  await assert.rejects(s.adapter.fetch({ ...FEED, source: 'xlsx' }, CTX), (e) => e instanceof SourceError && e.code === 'unexpected');
  assert.ok(s.logs.some((l) => l.event === 'dimes_failed' && l.fields.code === 'feed_unknown'));
  assert.equal(s.calls.length, 1);
  const broken = setup([ok()], { config: async () => parseDimesConfig({ ...RAW_CONFIG, version: 2 }) });
  await assert.rejects(broken.adapter.prepare(), (e) => e instanceof SourceError && e.code === 'unexpected');
  assert.equal(broken.calls.length, 0);
  assert.ok(broken.logs.some((l) => l.event === 'dimes_config_invalid' && l.fields.field === 'version'));
});

// ---------- codes, configuration, generator ----------

test('specific codes map to the closed SourceFailure codes', () => {
  const expected: Record<DimesCode, string> = {
    network: 'network',
    timeout: 'timeout',
    http_status: 'http_status',
    too_large: 'too_large',
    bad_content_type: 'bad_html',
    bad_encoding: 'bad_html',
    no_marker: 'bad_html',
    many_markers: 'bad_html',
    null_data: 'bad_html',
    bad_literal: 'bad_html',
    json_too_large: 'too_large',
    bad_json: 'bad_json',
    bad_shape: 'bad_shape',
    unknown_key: 'bad_shape',
    bad_days: 'bad_shape',
    too_many: 'too_many',
    too_many_skipped: 'bad_shape',
    wrong_year: 'wrong_period',
    no_state: 'wrong_period',
    semester_mismatch: 'wrong_period',
    outside_semester: 'wrong_period',
    config_invalid: 'unexpected',
    feed_unknown: 'unexpected',
  };
  for (const [code, failure] of Object.entries(expected)) assert.equal(sourceFailure(code as DimesCode), failure, code);
});

test('the configuration is validated before any request', () => {
  const field = (patch: Record<string, unknown>) => {
    try {
      parseDimesConfig({ ...RAW_CONFIG, ...patch });
      return 'ok';
    } catch (err) {
      return err instanceof DimesConfigError ? err.field : String(err);
    }
  };
  assert.equal(field({}), 'ok');
  assert.equal(field({ url: 'https://orariocorsi.prova.example.com/' }), 'url');
  assert.equal(field({ url: 'http://orariocorsi.prova.unical.it/' }), 'url');
  assert.equal(field({ url: 'https://orariocorsi.prova.unical.it/?x=1' }), 'url');
  assert.equal(field({ url: 'https://orariocorsi.prova.unical.it' }), 'url');
  assert.equal(field({ academicYear: '2026/2028' }), 'academic_year');
  assert.equal(field({ semesters: { I: RAW_CONFIG.semesters.II, II: RAW_CONFIG.semesters.I } }), 'semesters');
  assert.equal(field({ semesters: { ...RAW_CONFIG.semesters, III: RAW_CONFIG.semesters.I } }), 'semesters');
  assert.equal(field({ yearEnd: '2027-05-01' }), 'year_end');
  assert.equal(field({ noLessonDays: ['2026-02-30'] }), 'no_lesson_days');
  assert.equal(field({ expected: { days: ['Lunedì'], keys: {} } }), 'expected_days');
  const keys = (REAL.expected as { keys: Record<string, string[]> }).keys;
  assert.equal(field({ expected: { days: ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì'], keys: { ...keys, unit: ['id', 'nome'] } } }), 'expected_keys');
  assert.equal(field({ expected: { days: ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì'], keys: { ...keys, extra: [] } } }), 'expected_keys');
  assert.equal(field({ rooms: [{ app: 'a_minuscolo', name: 'X1', building: 'Cubo 32B' }] }), 'room_app');
  assert.equal(field({ rooms: [{ app: 'A_X', name: 'X1', building: 'Edificio senza chiave !!!' + '!'.repeat(80) }] }), 'room_building');
  assert.equal(field({ rooms: [{ app: 'A_X', name: ' X1', building: 'Cubo 32B' }] }), 'room_name');
  assert.equal(field({ rooms: [RAW_CONFIG.rooms[0], RAW_CONFIG.rooms[0]] }), 'room_duplicate');
  assert.equal(field({ externalRooms: [{ texts: ['CP3'], name: 'CP3', building: 'Polifunzionale' }, { texts: ['cp3'], name: 'CP3', building: 'Polifunzionale' }] }), 'external_room_texts');
  assert.equal(field({ offMapBuildings: { 'Polifunzionale Capannone C': 'Capannone C' } }), 'off_map_buildings');
  assert.equal(field({ extra: true }), 'config');
  assert.equal(field({ degreeClasses: undefined }), 'degree_classes');
  assert.equal(field({ degreeClasses: ['L-8'] }), 'degree_classes');
  assert.equal(field({ degreeClasses: { '001': 'L-8' } }), 'degree_classes');
  assert.equal(field({ degreeClasses: { '0001': 'L-8 c.u.' } }), 'degree_classes');
  assert.equal(field({ degreeClasses: { '0001': 'Laurea' } }), 'degree_classes');
  assert.equal(field({ degreeClasses: {} }), 'ok');
});

test('the level comes from the degree class of the course code; unknown codes and long names show none', () => {
  const single = parseDimesConfig({ ...RAW_CONFIG, degreeClasses: { '0001': 'LMG/01 R' } });
  const courses = (p: WeeklyPlan, key: string) => p.blocks.find((b) => b.key === key)!.courses;
  const p = plan(data(), single);
  assert.deepEqual(courses(p, 'U_FISICA'), ['INGEGNERIA DI PROVA (ciclo unico)']);
  assert.deepEqual(courses(p, 'U_ROBOT'), ['ROBOTICA DI PROVA'], 'a code without a class has no level');
  const long = data();
  long.classi[2].cdsNome = `LM ${'R'.repeat(188)}`;
  assert.deepEqual(courses(plan(long), 'U_ROBOT'), ['R'.repeat(188)], 'the label would pass 200 characters');
  long.classi[2].cdsNome = `LM ${'R'.repeat(187)}`;
  assert.deepEqual(courses(plan(long), 'U_ROBOT'), [`${'R'.repeat(187)} (magistrale)`]);
});

test('config/dimes.json is valid, its rooms are on the map and the migration equals the generator output', async () => {
  const config = await loadDimesConfig();
  assert.equal(config.url, 'https://orariocorsi.dimes.unical.it/');
  assert.equal(config.feedId, feedId('dimes', config.url));
  assert.equal(config.feedId, 'fffd8f89e0e2c0fae1ea60a6');
  assert.equal(config.rooms.size, 28);
  assert.equal(config.levels.size, 12);
  assert.deepEqual(new Set(config.levels.values()), new Set(['triennale', 'magistrale']));
  const campus = await loadCampus(fileURLToPath(new URL('public/data/campus.geojson', ROOT)));
  checkBuildings(config, campus.keys);
  assert.throws(() => checkBuildings(config, new Set(['cubo-32b'])), (e) => e instanceof DimesConfigError);
  const migration = readFileSync(fileURLToPath(new URL('supabase/migrations/20261110090800_dimes_feeds.sql', ROOT)), 'utf8');
  assert.equal(migration, renderDimesFeeds(config));
  assert.equal(renderDimesFeeds(config), renderDimesFeeds(await loadDimesConfig()), 'the output is deterministic');
  assert.equal((migration.match(/\('fffd[0-9a-f]{20}', 'dimes', /g) ?? []).length, 1);
  assert.ok(!migration.includes(String.fromCharCode(0x2014)), 'no em dash');
});

test('the registry exposes the dimes adapter', () => {
  const adapters = createAdapters();
  assert.equal(adapters.dimes?.kind, 'dimes');
  assert.equal(adapters.planner?.kind, 'planner');
});
