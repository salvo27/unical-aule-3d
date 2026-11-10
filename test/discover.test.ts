import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCalendarLinks, discover } from '../src/sync/discover.js';
import { plannerTitles } from '../src/sync/titles.js';
import { calendarId, sourceUrl } from '../src/domain/primitives.js';
import type { PlannerApi } from '../src/planner/client.js';
import { CAL_1, CAL_2 } from './fixtures.js';

const SOURCE = sourceUrl('https://dispes.unical.it/didattica/frequentare-i-corsi');
const PLANNER = 'https://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=';

test('links are extracted with the nearest heading as context', () => {
  const html = `
    <h3>1&deg; semestre</h3>
    <p><a href="${PLANNER}${CAL_1}">[0831] Scienze <b>Politiche</b> L-36</a></p>
    <strong>2° semestre</strong>
    <a class="x" href="${PLANNER}${CAL_2}?a=1&amp;b=2">Scienze Politiche L-36</a>
    <a href="${PLANNER}${CAL_1}">duplicate</a>
    <a href="https://example.com/?linkCalendarioId=${CAL_2}">wrong host</a>
    <a href="https://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=XYZ">bad id</a>`;
  const found = extractCalendarLinks(html, SOURCE);
  assert.deepEqual(
    found.map((f) => [f.id, f.label]),
    [
      [CAL_1, '1° semestre · [0831] Scienze Politiche L-36'],
      [CAL_2, '2° semestre · Scienze Politiche L-36'],
    ],
  );
});

test('labels are bounded and free of markup and control characters', () => {
  const html = `<a href="${PLANNER}${CAL_1}">${'<i>x</i>'.repeat(300)}\u0007</a>`;
  const [only] = extractCalendarLinks(html, SOURCE);
  assert.ok(only);
  assert.ok(only.label.length <= 160);
  assert.ok(!/[<>\u0007]/.test(only.label));
});

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers } });
}

test('discover follows redirects only inside unical.it', async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(url);
    if (url.endsWith('/a')) return response('', { status: 302, headers: { location: '/b' } });
    if (url.endsWith('/b')) return response(`<a href="${PLANNER}${CAL_1}">x</a>`);
    if (url.endsWith('/evil')) return response('', { status: 301, headers: { location: 'https://evil.example/' } });
    if (url.endsWith('/token')) return response('', { status: 302, headers: { location: '/gAAAAABprova' } });
    return response('', { status: 404 });
  }) as unknown as typeof fetch;
  const out = await discover(
    [
      sourceUrl('https://dispes.unical.it/a'),
      sourceUrl('https://dispes.unical.it/evil'),
      sourceUrl('https://dispes.unical.it/missing'),
      sourceUrl('https://dispes.unical.it/token'),
    ],
    { fetchImpl: fakeFetch, sleep: async () => undefined },
  );
  assert.deepEqual(out.found.map((f) => f.id), [CAL_1]);
  assert.deepEqual(out.failures.map((f) => f.failure), ['redirect_blocked', 'http_status', 'redirect_blocked']);
  assert.ok(!calls.some((c) => c.includes('evil.example')));
  assert.ok(!calls.some((c) => c.includes('gAAAAAB')), 'robots.txt disallows *gAAAAAB*');
});

test('discover refuses non html and oversized pages', async () => {
  const fakeFetch = (async (url: string) => {
    if (url.endsWith('/json')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
    return response('x'.repeat(5_000));
  }) as unknown as typeof fetch;
  const out = await discover([sourceUrl('https://unical.it/json'), sourceUrl('https://unical.it/big')], { fetchImpl: fakeFetch, maxBytes: 1_000, sleep: async () => undefined });
  assert.deepEqual(out.failures.map((f) => f.failure), ['not_html', 'too_large']);
});

test('discover pauses 300 ms before every request but the first, redirects included', async () => {
  const events: string[] = [];
  const fakeFetch = (async (url: string) => {
    events.push(`get ${new URL(url).pathname}`);
    if (url.endsWith('/a')) return response('', { status: 302, headers: { location: '/b' } });
    return response(`<a href="${PLANNER}${CAL_1}">x</a>`);
  }) as unknown as typeof fetch;
  const sleep = async (ms: number) => void events.push(`pause ${ms}`);
  await discover([sourceUrl('https://dispes.unical.it/a'), sourceUrl('https://dispes.unical.it/c')], { fetchImpl: fakeFetch, sleep });
  assert.deepEqual(events, ['get /a', 'pause 300', 'get /b', 'pause 300', 'get /c']);
});

test('Planner titles: at most 3 requests in flight and a 300 ms pause between the requests of each worker', async () => {
  const ids = Array.from({ length: 8 }, (_v, i) => calendarId(String(i + 1).repeat(24)));
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];
  const pauses: number[] = [];
  const api: PlannerApi = {
    clientId: async () => '5de6319d4414ab02f80b613a',
    calendarEvents: async () => [],
    calendarInfo: async (id) => {
      calls.push(id);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      if (id === ids[2]) throw new Error('down');
      return { payload: { titolo: `Calendario ${id.slice(0, 1)}` } };
    },
  };
  const titles = await plannerTitles(api, ids, { sleep: async (ms) => void pauses.push(ms) });
  assert.equal(calls.length, 8);
  assert.ok(peak <= 3);
  assert.deepEqual(pauses, new Array(5).fill(300), 'every request after the first of each worker waits');
  assert.equal(titles.size, 7);
  assert.equal(titles.get(ids[0]!), 'Calendario 1');
  assert.deepEqual(await plannerTitles(api, [ids[0]!], { sleep: async (ms) => void pauses.push(ms) }), new Map([[ids[0]!, 'Calendario 1']]));
  assert.equal(pauses.length, 5, 'a single request never waits');
});
