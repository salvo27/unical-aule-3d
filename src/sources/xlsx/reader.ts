// Minimal, bounded reader for the cell values and merges of an .xlsx file.
// Formulas are never evaluated: only the cached values Excel saved are read.
import { unzipSync } from 'fflate';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { XlsxError } from './codes.js';

export interface XlsxLimits {
  maxBytes: number;
  maxEntries: number;
  maxPartBytes: number;
  maxTotalBytes: number;
  maxSheets: number;
  maxCellsPerSheet: number;
  maxSharedStrings: number;
  maxCellText: number;
  maxRow: number;
  maxCol: number;
  maxMerges: number;
  maxMergedCells: number;
}

export const DEFAULT_LIMITS: XlsxLimits = {
  maxBytes: 5_000_000,
  maxEntries: 64,
  maxPartBytes: 8_000_000,
  maxTotalBytes: 32_000_000,
  maxSheets: 12,
  maxCellsPerSheet: 20_000,
  maxSharedStrings: 20_000,
  maxCellText: 2_000,
  maxRow: 1_000,
  maxCol: 52,
  maxMerges: 1_000,
  maxMergedCells: 100_000,
};

export interface Cell {
  row: number;
  col: number;
  text: string;
  type: string;
}

export interface Range {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

export interface Sheet {
  name: string;
  state: string;
  cells: Map<string, Cell>;
  merges: Range[];
}

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const WANTED = /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d{1,3}\.xml)$/;
const REF = /^([A-Z]{1,3})(\d{1,7})$/;

export const cellKey = (row: number, col: number) => `${row},${col}`;

function colNumber(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function parseRef(ref: string | null, limits: XlsxLimits): { row: number; col: number } {
  const m = ref ? REF.exec(ref) : null;
  if (!m || !m[1] || !m[2]) throw new XlsxError('bad_cell');
  const row = Number(m[2]);
  const col = colNumber(m[1]);
  if (row < 1 || row > limits.maxRow || col < 1 || col > limits.maxCol) throw new XlsxError('bad_cell');
  return { row, col };
}

function parseXml(bytes: Uint8Array | undefined): Element {
  if (!bytes) throw new XlsxError('missing_part');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new XlsxError('bad_xml');
  }
  // OOXML parts never need a DTD: refusing it rules out entity expansion.
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new XlsxError('doctype');
  try {
    const doc = new DOMParser({
      onError: (level) => {
        if (level !== 'warning') throw new XlsxError('bad_xml');
      },
    }).parseFromString(text, 'text/xml');
    if (!doc.documentElement) throw new XlsxError('bad_xml');
    return doc.documentElement;
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    throw new XlsxError('bad_xml');
  }
}

function descendants(el: Element, name: string, ns = MAIN): Element[] {
  return Array.from(el.getElementsByTagNameNS(ns, name) as unknown as ArrayLike<Element>);
}

function child(el: Element, name: string): Element | null {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && (n as Element).namespaceURI === MAIN && (n as Element).localName === name) return n as Element;
  }
  return null;
}

// Text of the <t> runs, skipping phonetic runs (<rPh>).
function runText(el: Element): string {
  return descendants(el, 't')
    .filter((t) => (t.parentNode as Element | null)?.localName !== 'rPh')
    .map((t) => t.textContent ?? '')
    .join('');
}

function unzip(bytes: Uint8Array, limits: XlsxLimits): Record<string, Uint8Array> {
  let entries = 0;
  let declared = 0;
  let compressed = 0;
  let macro = false;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter: (f) => {
        entries += 1;
        if (entries > limits.maxEntries) throw new XlsxError('too_many_entries');
        if (/(^|\/)vbaProject\.bin$/i.test(f.name)) macro = true;
        if (macro || !WANTED.test(f.name)) return false;
        if (f.originalSize > limits.maxPartBytes) throw new XlsxError('part_too_large');
        declared += f.originalSize;
        if (declared > limits.maxTotalBytes) throw new XlsxError('part_too_large');
        // Entries sharing the same bytes would multiply the work: the parts read must fit in the file once.
        if (f.compression === 0 && f.size !== f.originalSize) throw new XlsxError('bad_zip');
        compressed += f.size;
        if (compressed > bytes.byteLength) throw new XlsxError('bad_zip');
        return true;
      },
    });
  } catch (err) {
    if (err instanceof XlsxError) throw err;
    throw new XlsxError('bad_zip');
  }
  if (macro) throw new XlsxError('macro');
  // fflate writes into a buffer of the declared size, so a lying header only truncates the part.
  let total = 0;
  for (const data of Object.values(files)) {
    if (data.byteLength > limits.maxPartBytes) throw new XlsxError('part_too_large');
    total += data.byteLength;
  }
  if (total > limits.maxTotalBytes) throw new XlsxError('part_too_large');
  return files;
}

function readCells(root: Element, shared: readonly string[], limits: XlsxLimits): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  for (const c of descendants(root, 'c')) {
    const { row, col } = parseRef(c.getAttribute('r'), limits);
    const type = c.getAttribute('t') ?? 'n';
    const v = child(c, 'v');
    let text: string | null;
    if (type === 's') {
      const raw = v?.textContent ?? '';
      if (!/^\d{1,7}$/.test(raw) || Number(raw) >= shared.length) throw new XlsxError('bad_cell');
      text = shared[Number(raw)] ?? null;
    } else if (type === 'inlineStr') {
      const is = child(c, 'is');
      text = is ? runText(is) : null;
    } else {
      text = v?.textContent ?? null;
    }
    if (text === null) continue;
    if (text.length > limits.maxCellText) throw new XlsxError('bad_cell');
    if (text.trim() === '') continue;
    if (cells.size >= limits.maxCellsPerSheet) throw new XlsxError('too_many_cells');
    cells.set(cellKey(row, col), { row, col, text, type });
  }
  return cells;
}

function readMerges(root: Element, limits: XlsxLimits): Range[] {
  const merges: Range[] = [];
  let covered = 0;
  for (const m of descendants(root, 'mergeCell')) {
    if (merges.length >= limits.maxMerges) throw new XlsxError('too_many_cells');
    const [a, b] = (m.getAttribute('ref') ?? '').split(':');
    const p = parseRef(a ?? null, limits);
    const q = parseRef(b ?? a ?? null, limits);
    const range = { r1: Math.min(p.row, q.row), c1: Math.min(p.col, q.col), r2: Math.max(p.row, q.row), c2: Math.max(p.col, q.col) };
    covered += (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
    if (covered > limits.maxMergedCells) throw new XlsxError('too_many_cells');
    merges.push(range);
  }
  return merges;
}

export function readXlsx(bytes: Uint8Array, limits: XlsxLimits = DEFAULT_LIMITS): Sheet[] {
  if (bytes.byteLength > limits.maxBytes) throw new XlsxError('too_large');
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
    throw new XlsxError('not_zip');
  }
  const files = unzip(bytes, limits);

  const shared: string[] = [];
  if (files['xl/sharedStrings.xml']) {
    for (const si of descendants(parseXml(files['xl/sharedStrings.xml']), 'si')) {
      if (shared.length >= limits.maxSharedStrings) throw new XlsxError('too_many_cells');
      shared.push(runText(si));
    }
  }

  const targets = new Map<string, string>();
  for (const r of descendants(parseXml(files['xl/_rels/workbook.xml.rels']), 'Relationship', PKG_REL)) {
    const id = r.getAttribute('Id');
    const target = r.getAttribute('Target');
    if (id && target) targets.set(id, target.startsWith('/') ? target.slice(1) : `xl/${target}`);
  }

  const sheetEls = descendants(parseXml(files['xl/workbook.xml']), 'sheet');
  if (sheetEls.length === 0) throw new XlsxError('missing_part');
  if (sheetEls.length > limits.maxSheets) throw new XlsxError('too_many_sheets');

  return sheetEls.map((s) => {
    const part = targets.get(s.getAttributeNS(REL, 'id') ?? '');
    if (!part || !WANTED.test(part) || !files[part]) throw new XlsxError('missing_part');
    const root = parseXml(files[part]);
    return {
      name: s.getAttribute('name') ?? '',
      state: s.getAttribute('state') ?? 'visible',
      cells: readCells(root, shared, limits),
      merges: readMerges(root, limits),
    };
  });
}
