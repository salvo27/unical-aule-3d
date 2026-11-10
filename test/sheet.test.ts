import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');
const app = read('public/app.js');

// app.js starts the page as soon as it loads, so the pure helper is taken from its source and run alone.
type Size = 'collapsed' | 'normal' | 'tall';
type Gesture = (dy: number, closable: boolean, size: Size) => string;
const helper = /^function sheetGesture\(dy, closable, size\) \{\n[\s\S]*?\n\}$/m.exec(app);
assert.ok(helper, 'sheetGesture is missing from public/app.js');
const sheetGesture = new Function(`${helper[0]}\nreturn sheetGesture;`)() as Gesture;
const SIZES: Size[] = ['collapsed', 'normal', 'tall'];

test('a tap or a short drag leaves the sheet as it is', () => {
  for (const size of SIZES) {
    for (const dy of [0, 5, -5, 60, -60, Number.NaN]) {
      assert.equal(sheetGesture(dy, false, size), 'stay', `${dy} ${size}`);
      assert.equal(sheetGesture(dy, true, size), 'stay', `${dy} ${size}`);
    }
  }
});

test('down from the tall sheet of a detail goes back to the normal height first', () => {
  assert.equal(sheetGesture(61, true, 'tall'), 'normal');
  assert.equal(sheetGesture(400, true, 'tall'), 'normal');
  assert.equal(sheetGesture(61, false, 'tall'), 'normal');
});

test('a second swipe down closes the detail, which lowers the sheet; without a detail it collapses', () => {
  assert.equal(sheetGesture(61, true, 'normal'), 'close');
  assert.equal(sheetGesture(61, true, 'collapsed'), 'close');
  assert.equal(sheetGesture(61, false, 'normal'), 'collapsed');
  assert.equal(sheetGesture(400, false, 'collapsed'), 'collapsed');
});

test('up opens one size at a time, the tall one only for a detail', () => {
  assert.equal(sheetGesture(-61, false, 'collapsed'), 'normal');
  assert.equal(sheetGesture(-61, true, 'collapsed'), 'normal');
  assert.equal(sheetGesture(-61, true, 'normal'), 'tall');
  assert.equal(sheetGesture(-400, false, 'normal'), 'stay');
  assert.equal(sheetGesture(-400, true, 'tall'), 'stay');
});

test('a detail opens the tall sheet on a phone, and both looks give it about 85vh', () => {
  assert.match(app, /setSheet\(phone\.matches && CLOSABLE\.has\(view\.name\) \? 'tall' : 'normal'\);/);
  assert.match(read('public/style.css'), /@media \(max-width: 720px\) \{[^@]*\n {2}\.panel\.tall \{ max-height: 85vh; max-height: 85dvh; \}/);
  assert.match(
    read('public/theme-essenziale.css'),
    /@media \(max-width: 720px\) \{[^@]*\n {2}:root\[data-theme="essenziale"\] \.panel\.tall \{ max-height: 85vh; max-height: 85dvh; \}/,
  );
});

test('a redraw of the same view keeps the body scroll; the status refresh redraws the same view', () => {
  const render = /^function render\(\) \{\n[\s\S]*?\n\}$/m.exec(app);
  assert.ok(render);
  assert.match(render[0], /const top = renderedView === v \? panelBody\.scrollTop : 0;/);
  assert.match(render[0], /renderedView = v;\n {2}panelBody\.scrollTop = top;\n\}$/);
  assert.match(app, /const view = entering \? \{ name: 'search', results: null \} : state\.view;/);
  assert.match(app, /if \(entering\) \{\n {4}state\.view = view;\n {4}state\.history = \[\];\n {4}setSheet\('normal'\);/);
});

test('the search waits for a pause in typing and keeps what the panel shows until the answer arrives', () => {
  assert.match(app, /const SEARCH_DELAY_MS = 400;/);
  assert.equal((app.match(/\}, SEARCH_DELAY_MS\),/g) ?? []).length, 2);
  assert.match(app, /if \(!refresh\) setSearchPending\(true\);\n {2}let results = null;/);
  assert.match(app, /if \(seq !== searchSeq\) return;\n {2}setSearchPending\(false\);\n {2}if \(state\.view !== startView\) return;/);
  const render = /^function render\(\) \{\n[\s\S]*?\n\}$/m.exec(app);
  assert.ok(render);
  assert.match(render[0], /panelBody\.classList\.toggle\('is-pending', searchPending\);/);
  assert.match(render[0], /panelBody\.setAttribute\('aria-busy', String\(searchPending\)\);/);
  assert.ok(!/Ricerca in corso/.test(app) || /if \(!v\.results\)/.test(app));
  assert.match(read('public/style.css'), /\.panel-body\.is-pending \{ opacity: 0\.6;/);
});

test('the close button sits in the panel head, not in the scrolled body', () => {
  const head = /<div class="head-row">[\s\S]*?<\/div>/.exec(read('public/index.html'));
  assert.ok(head);
  assert.match(head[0], /<button type="button" id="panel-close" class="panel-close" aria-label="Chiudi" hidden>/);
  assert.ok(!app.includes("className: 'close'"));
});
