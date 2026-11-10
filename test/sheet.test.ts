import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');
const app = read('public/app.js');

// app.js starts the page as soon as it loads, so the pure helper is taken from its source and run alone.
type Gesture = (dy: number, closable: boolean) => string;
const helper = /^function sheetGesture\(dy, closable\) \{\n[\s\S]*?\n\}$/m.exec(app);
assert.ok(helper, 'sheetGesture is missing from public/app.js');
const sheetGesture = new Function(`${helper[0]}\nreturn sheetGesture;`)() as Gesture;

test('a tap or a short drag leaves the sheet as it is', () => {
  for (const dy of [0, 5, -5, 60, -60]) {
    assert.equal(sheetGesture(dy, false), 'stay', String(dy));
    assert.equal(sheetGesture(dy, true), 'stay', String(dy));
  }
  assert.equal(sheetGesture(Number.NaN, true), 'stay');
});

test('down past 60px collapses the sheet, and also closes an open detail', () => {
  assert.equal(sheetGesture(61, false), 'collapse');
  assert.equal(sheetGesture(400, false), 'collapse');
  assert.equal(sheetGesture(61, true), 'close');
  assert.equal(sheetGesture(400, true), 'close');
});

test('up past 60px expands the sheet, with or without a detail', () => {
  assert.equal(sheetGesture(-61, false), 'expand');
  assert.equal(sheetGesture(-61, true), 'expand');
  assert.equal(sheetGesture(-400, true), 'expand');
});

test('the close button sits in the panel head, not in the scrolled body', () => {
  const head = /<div class="head-row">[\s\S]*?<\/div>/.exec(read('public/index.html'));
  assert.ok(head);
  assert.match(head[0], /<button type="button" id="panel-close" class="panel-close" aria-label="Chiudi" hidden>/);
  assert.ok(!app.includes("className: 'close'"));
});
