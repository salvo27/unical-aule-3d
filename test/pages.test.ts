import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');
const DIAM_PAGE = (JSON.parse(read('config/diam.json')) as { pageUrl: string }).pageUrl;

test('the map credits both timetable sources, the DIAm one with its index page', () => {
  const app = read('public/app.js');
  assert.ok(app.includes('Orari: University Planner Unical e <a href="' + DIAM_PAGE + '"'));
});

test('README and DATA-LICENSE credit the DIAm files and name the files that exist', () => {
  for (const doc of ['README.md', 'DATA-LICENSE.md']) {
    const text = read(doc);
    assert.ok(text.includes(DIAM_PAGE), doc);
    assert.ok(text.includes("Dipartimento di Ingegneria dell'Ambiente"), doc);
    assert.ok(text.includes('config/diam.json'), doc);
  }
  const migration = 'supabase/migrations/20261110090500_xlsx_feeds.sql';
  assert.ok(read('DATA-LICENSE.md').includes(migration));
  assert.ok(read(migration).length > 0);
});

test('page scripts never write HTML', () => {
  const dir = fileURLToPath(new URL('public/', ROOT));
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    assert.ok(!/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\(|document\.write/.test(read(`public/${name}`)), name);
  }
});
