// Page geometry: words with boxes (pdftotext -bbox-layout) and table rules (thin filled rectangles of pdftocairo -svg).
// Coordinates are points with the origin at the top left, as both tools print them.
import { PdfError } from './codes.js';

export interface Word {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cx: number;
  cy: number;
  t: string;
}

export interface HRule {
  y: number;
  x0: number;
  x1: number;
}

export interface VRule {
  x: number;
  y0: number;
  y1: number;
}

export interface Rules {
  h: HRule[];
  v: VRule[];
}

export interface TextPage {
  width: number;
  height: number;
  words: Word[];
}

export interface Page extends TextPage {
  rules: Rules;
}

export const MAX_WORD_CHARS = 200;
const NUM = '(-?\\d{1,5}(?:\\.\\d{1,8})?)';
const PAGE = /<page width="(\d{1,5}(?:\.\d{1,8})?)" height="(\d{1,5}(?:\.\d{1,8})?)">([\s\S]*?)<\/page>/g;
const WORD = new RegExp(`<word xMin="${NUM}" yMin="${NUM}" xMax="${NUM}" yMax="${NUM}">([^<]*)</word>`, 'g');
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

function safeChar(code: number): string {
  return code > 31 && code < 0x110000 && !(code >= 0x7f && code <= 0x9f) && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
}

function decode(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => safeChar(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(CONTROL, ' ');
}

function count(text: string, needle: string): number {
  let n = 0;
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) n += 1;
  return n;
}

// Only the <doc> part is read: the head carries the file metadata, which may name people.
// Every page and word must parse, or the text layer is refused as a whole.
export function parseBbox(xhtml: string, limits: { maxPages: number; maxWords: number }): TextPage[] {
  const start = xhtml.indexOf('<doc>');
  const end = xhtml.lastIndexOf('</doc>');
  if (start < 0 || end < start) throw new PdfError('bad_text_layer');
  const doc = xhtml.slice(start + 5, end);
  const pageCount = count(doc, '<page ');
  if (pageCount < 1 || pageCount > limits.maxPages) throw new PdfError('page_count');
  const pages: TextPage[] = [];
  for (const pm of doc.matchAll(PAGE)) {
    const width = Number(pm[1]);
    const height = Number(pm[2]);
    const body = pm[3] ?? '';
    if (!(width > 0 && width <= 5000 && height > 0 && height <= 5000)) throw new PdfError('bad_text_layer');
    const expected = count(body, '<word ');
    if (expected > limits.maxWords) throw new PdfError('too_many_words');
    const matches = [...body.matchAll(WORD)];
    if (matches.length !== expected) throw new PdfError('bad_text_layer');
    const words: Word[] = [];
    for (const wm of matches) {
      const [x0, y0, x1, y1] = [wm[1], wm[2], wm[3], wm[4]].map(Number) as [number, number, number, number];
      const raw = wm[5] ?? '';
      if (raw.length > MAX_WORD_CHARS * 8) throw new PdfError('bad_text_layer');
      const t = decode(raw).trim();
      const inside = x0 >= -5 && y0 >= -5 && x1 <= width + 5 && y1 <= height + 5 && x0 <= x1 && y0 <= y1;
      if (!inside || t.length > MAX_WORD_CHARS) throw new PdfError('bad_text_layer');
      if (t.length === 0) continue;
      words.push({ x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, t });
    }
    pages.push({ width, height, words });
  }
  if (pages.length !== pageCount) throw new PdfError('bad_text_layer');
  return pages;
}

const RECT = new RegExp(`^M ${NUM} ${NUM} L ${NUM} ${NUM} L ${NUM} ${NUM} L ${NUM} ${NUM} Z ?`);
const MOVE = new RegExp(`^M ${NUM} ${NUM} ?$`);
const D_ATTR = /\sd="([^"]{0,20000})"/;
// A transform on a group, or on a path shaped like a rule, would move the rules: refused, never guessed.
const GROUP_TRANSFORM = /<g\b[^>]*\stransform=/;
const TRANSFORM_ATTR = /\stransform="/;

function axisAligned(xs: number[], ys: number[]): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) <= 0.01;
  for (let i = 0; i < 4; i += 1) {
    const j = (i + 1) % 4;
    if (!close(xs[i]!, xs[j]!) && !close(ys[i]!, ys[j]!)) return false;
  }
  return true;
}

// Word tables are drawn as thin filled rectangles: horizontal if at most 1.5 pt tall, vertical if at most 1.5 pt wide.
export function rectRules(svg: string, maxRules = 20_000): Rules {
  const cut = svg.indexOf('</defs>');
  const body = cut >= 0 ? svg.slice(cut + 7) : svg;
  if (GROUP_TRANSFORM.test(body)) throw new PdfError('rules_transformed');
  const h: HRule[] = [];
  const v: VRule[] = [];
  let paths = 0;
  for (const pm of body.matchAll(/<path\b([^>]{0,20500})>/g)) {
    if (++paths > maxRules * 4) throw new PdfError('too_many_rules');
    const attrs = pm[1] ?? '';
    const d = D_ATTR.exec(attrs)?.[1]?.trim();
    if (!d) continue;
    let rest = d;
    const rects: number[][] = [];
    for (let m = RECT.exec(rest); m; m = RECT.exec(rest)) {
      rects.push(m.slice(1, 9).map(Number));
      rest = rest.slice(m[0].length);
    }
    // Anything but rectangles (curves, open lines) is not a rule.
    if (rects.length === 0 || (rest !== '' && !MOVE.test(rest))) continue;
    if (TRANSFORM_ATTR.test(attrs)) throw new PdfError('rules_transformed');
    for (const r of rects) {
      const xs = [r[0]!, r[2]!, r[4]!, r[6]!];
      const ys = [r[1]!, r[3]!, r[5]!, r[7]!];
      if (!axisAligned(xs, ys)) continue;
      const x0 = Math.min(...xs);
      const x1 = Math.max(...xs);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      if (y1 - y0 <= 1.5 && x1 - x0 >= 2) h.push({ y: (y0 + y1) / 2, x0, x1 });
      else if (x1 - x0 <= 1.5 && y1 - y0 >= 2) v.push({ x: (x0 + x1) / 2, y0, y1 });
      if (h.length + v.length > maxRules) throw new PdfError('too_many_rules');
    }
  }
  return { h, v };
}

// Sorted values grouped when the gap to the previous one is at most tol; the mean of each group.
export function cluster(values: readonly number[], tol = 1.5): number[] {
  const out: { sum: number; n: number; last: number }[] = [];
  for (const v of [...values].sort((a, b) => a - b)) {
    const c = out[out.length - 1];
    if (c && v - c.last <= tol) {
      c.sum += v;
      c.n += 1;
      c.last = v;
    } else out.push({ sum: v, n: 1, last: v });
  }
  return out.map((c) => c.sum / c.n);
}

export interface Line {
  cy: number;
  x0: number;
  words: Word[];
  text: string;
}

// Words grouped in lines by their vertical center, left to right.
export function lines(words: readonly Word[], tol = 2.5): Line[] {
  const sorted = [...words].sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
  const groups: { cy: number; words: Word[] }[] = [];
  for (const w of sorted) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.cy - w.cy) <= tol) last.words.push(w);
    else groups.push({ cy: w.cy, words: [w] });
  }
  return groups.map((g) => {
    const ws = g.words.sort((a, b) => a.x0 - b.x0);
    return { cy: g.cy, x0: ws[0]!.x0, words: ws, text: ws.map((w) => w.t).join(' ') };
  });
}

export function textOf(words: readonly Word[]): string {
  return lines(words)
    .map((l) => l.text)
    .join(' ');
}

export interface Band {
  top: number;
  bottom: number;
  // Vertical rules crossing the middle of the band, clustered: the cell boundaries.
  vs: number[];
  words: Word[];
}

// The space between two consecutive horizontal rules, with the words whose center is inside it.
export function bandsOf(page: Page): Band[] {
  const hy = cluster(page.rules.h.map((r) => r.y));
  const out: Band[] = [];
  for (let i = 0; i + 1 < hy.length; i += 1) {
    const top = hy[i]!;
    const bottom = hy[i + 1]!;
    const mid = (top + bottom) / 2;
    const vs = cluster(page.rules.v.filter((r) => r.y0 <= mid && r.y1 >= mid).map((r) => r.x));
    out.push({ top, bottom, vs, words: page.words.filter((w) => w.cy > top && w.cy < bottom) });
  }
  return out;
}

export interface Cell {
  left: number;
  right: number;
  words: Word[];
  text: string;
}

export function cellsOf(band: Band): Cell[] {
  const out: Cell[] = [];
  for (let j = 0; j + 1 < band.vs.length; j += 1) {
    const left = band.vs[j]!;
    const right = band.vs[j + 1]!;
    const ws = band.words.filter((w) => w.cx > left && w.cx < right);
    out.push({ left, right, words: ws, text: textOf(ws) });
  }
  return out;
}
