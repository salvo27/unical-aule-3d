import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plannerAdapter, plannerEventKind, redactNonLesson } from '../src/sources/planner.js';
import { SourceError, type FetchContext, type Feed } from '../src/sources/types.js';
import { PlannerError, type PlannerFailure } from '../src/planner/parse.js';
import type { PlannerApi } from '../src/planner/client.js';
import { calendarId } from '../src/domain/primitives.js';
import { fakeEvent, CAL_1 } from './fixtures.js';

const CLIENT = '5de6319d4414ab02f80b613a';
const FROM = Date.parse('2026-11-08T23:00:00Z');
const TO = Date.parse('2026-11-30T23:00:00Z');
const FEED: Feed = { id: calendarId(CAL_1), source: 'planner', ref: null };
const CTX: FetchContext = { from: FROM, to: TO, plannerRooms: new Map() };
const START = '2026-11-16T08:00:00.000Z';
const END = '2026-11-16T10:00:00.000Z';

function api(events: () => unknown, clientId: () => Promise<string> = async () => CLIENT): PlannerApi & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    clientId,
    calendarInfo: async () => ({}),
    calendarEvents: async (...args) => {
      calls.push(args);
      return events();
    },
  };
}

const typed = (descrizione: string | null, title = 'Riunione di Mario Rossi') => ({
  ...fakeEvent({ start: START, end: END, title }),
  tipoEvento: descrizione === null ? undefined : { codice: 'XX', descrizione },
});

test('coverage equals the run window and the window reaches the Planner', async () => {
  const fake = api(() => [fakeEvent({ start: START, end: END })]);
  const adapter = plannerAdapter(fake);
  assert.equal(adapter.kind, 'planner');
  await adapter.prepare();
  const data = await adapter.fetch(FEED, CTX);
  assert.equal(data.from, FROM);
  assert.equal(data.to, TO);
  assert.equal(data.parsed.lessons.length, 1);
  assert.deepEqual(fake.calls, [[CAL_1, CLIENT, FROM, TO]]);
});

test('every PlannerError code maps to the same SourceError code', async () => {
  const codes: PlannerFailure[] = ['network', 'timeout', 'http_status', 'too_large', 'bad_json', 'bad_shape', 'too_many', 'client_id'];
  for (const code of codes) {
    const failing = plannerAdapter(
      api(
        () => [],
        async () => {
          throw new PlannerError(code);
        },
      ),
    );
    await assert.rejects(failing.prepare(), (err) => err instanceof SourceError && err.code === code);
    const adapter = plannerAdapter(
      api(() => {
        throw new PlannerError(code);
      }),
    );
    await adapter.prepare();
    await assert.rejects(adapter.fetch(FEED, CTX), (err) => err instanceof SourceError && err.code === code);
  }
});

test('a malformed response is bad_shape, other errors are unexpected', async () => {
  const adapter = plannerAdapter(api(() => ({ unexpected: true })));
  await adapter.prepare();
  await assert.rejects(adapter.fetch(FEED, CTX), (err) => err instanceof SourceError && err.code === 'bad_shape');
  const broken = plannerAdapter(
    api(() => {
      throw new TypeError('x');
    }),
  );
  await broken.prepare();
  await assert.rejects(broken.fetch(FEED, CTX), (err) => err instanceof SourceError && err.code === 'unexpected');
});

test('fetch before prepare fails closed', async () => {
  const adapter = plannerAdapter(api(() => []));
  await assert.rejects(adapter.fetch(FEED, CTX), (err) => err instanceof SourceError && err.code === 'client_id');
});

test('Planner types: only teaching activity is a lesson', () => {
  assert.equal(plannerEventKind("ATTIVITA' DIDATTICA"), 'lesson');
  assert.equal(plannerEventKind('Attività didattica'), 'lesson');
  assert.equal(plannerEventKind('ESAMI'), 'exam');
  assert.equal(plannerEventKind('Esame'), 'exam');
  assert.equal(plannerEventKind("PROVA D'ESAME"), 'exam');
  assert.equal(plannerEventKind('PRENOTAZIONE AULA'), 'booking');
  assert.equal(plannerEventKind("ALTRE ATTIVITA'"), 'other');
  assert.equal(plannerEventKind('TUTORAGGIO'), 'other');
  assert.equal(plannerEventKind('RIUNIONE'), 'other');
  assert.equal(plannerEventKind(''), 'other');
});

test('events that are not lessons keep only a fixed label, times, rooms and state', async () => {
  const events = [
    typed("ATTIVITA' DIDATTICA", 'ANALISI MATEMATICA I'),
    typed('ESAMI'),
    typed('PRENOTAZIONE'),
    typed("ALTRE ATTIVITA'"),
    typed('TIPO NUOVO'),
    typed(null),
    { ...typed('ESAMI'), stato: 'A' },
  ];
  const adapter = plannerAdapter(api(() => events));
  await adapter.prepare();
  const { lessons } = (await adapter.fetch(FEED, CTX)).parsed;
  assert.deepEqual(
    lessons.map((l) => l.title),
    ['ANALISI MATEMATICA I', 'Esame', 'Prenotazione', 'Altro impegno', 'Altro impegno', 'Altro impegno', 'Esame'],
  );
  assert.deepEqual(lessons[0]!.teachers, ['Mario Rossi']);
  assert.deepEqual(lessons[0]!.courses, ['CORSO DI LAUREA DI PROVA']);
  for (const l of lessons.slice(1)) {
    assert.deepEqual(l.teachers, []);
    assert.deepEqual(l.courses, []);
    assert.equal(l.start, Date.parse(START));
    assert.equal(l.end, Date.parse(END));
    assert.equal(l.roomIds.length, 1);
  }
  assert.deepEqual(
    lessons.map((l) => l.status),
    ['active', 'active', 'active', 'active', 'active', 'active', 'cancelled'],
  );
  assert.equal(JSON.stringify(lessons.slice(1)).includes('Rossi'), false);
});

test('an event that is not a lesson stays busy even with an empty or overlong free text name', async () => {
  const unnamed: Record<string, unknown> = { ...typed('PRENOTAZIONE') };
  delete unnamed.nome;
  const events = [
    typed('PRENOTAZIONE', ''),
    typed('ESAMI', `Appello di Mario Rossi ${'x'.repeat(400)}`),
    unnamed,
    typed("ATTIVITA' DIDATTICA", ''),
    typed("ATTIVITA' DIDATTICA", 'x'.repeat(301)),
  ];
  const adapter = plannerAdapter(api(() => events));
  await adapter.prepare();
  const { parsed } = await adapter.fetch(FEED, CTX);
  assert.deepEqual(
    parsed.lessons.map((l) => l.title),
    ['Prenotazione', 'Esame', 'Prenotazione'],
  );
  assert.equal(parsed.skipped, 2, 'a lesson without a valid title is still skipped');
  assert.equal(JSON.stringify(parsed).includes('Rossi'), false);
});

test('redactNonLesson leaves lessons untouched', () => {
  const lesson = {
    id: 'cccccccccccccccccccccc01',
    title: 'FISICA',
    start: 1,
    end: 2,
    status: 'active' as const,
    kind: "ATTIVITA' DIDATTICA",
    courses: ['C'],
    year: 1,
    teachers: ['Mario Rossi'],
    roomIds: ['aaaaaaaaaaaaaaaaaaaaaaaa'],
  } as Parameters<typeof redactNonLesson>[0];
  assert.equal(redactNonLesson(lesson), lesson);
  assert.equal(redactNonLesson({ ...lesson, kind: 'ESAMI' }).year, 1);
});
