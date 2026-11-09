import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCalendarLinks, discover } from '../src/sync/discover.js';
import { sourceUrl } from '../src/domain/primitives.js';
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
    return response('', { status: 404 });
  }) as unknown as typeof fetch;
  const out = await discover(
    [sourceUrl('https://dispes.unical.it/a'), sourceUrl('https://dispes.unical.it/evil'), sourceUrl('https://dispes.unical.it/missing')],
    { fetchImpl: fakeFetch },
  );
  assert.deepEqual(out.found.map((f) => f.id), [CAL_1]);
  assert.deepEqual(out.failures.map((f) => f.failure), ['redirect_blocked', 'http_status']);
  assert.ok(!calls.some((c) => c.includes('evil.example')));
});

test('discover refuses non html and oversized pages', async () => {
  const fakeFetch = (async (url: string) => {
    if (url.endsWith('/json')) return new Response('{}', { headers: { 'content-type': 'application/json' } });
    return response('x'.repeat(5_000));
  }) as unknown as typeof fetch;
  const out = await discover([sourceUrl('https://unical.it/json'), sourceUrl('https://unical.it/big')], { fetchImpl: fakeFetch, maxBytes: 1_000 });
  assert.deepEqual(out.failures.map((f) => f.failure), ['not_html', 'too_large']);
});
