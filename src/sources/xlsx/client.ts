// Requests of the DIAm source: the index page and the two workbooks, with size limits and no redirects.
import { createHash } from 'node:crypto';
import { sourceUrl, type SourceUrl } from '../../domain/primitives.js';
import { USER_AGENT } from '../../user-agent.js';
import { XlsxError } from './codes.js';
import { norm, type DiamFileKind } from './text.js';

export const PAGE_MAX_BYTES = 2_000_000;
export const FILE_MAX_BYTES = 5_000_000;
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FILE_URL = /^https:\/\/www\.unical\.it\/media\/medias\/20\d\d\/[A-Za-z0-9._-]{1,120}\.xlsx$/;
// robots.txt of www.unical.it: "Disallow: *gAAAAAB*".
const ROBOTS_DISALLOWED = /gAAAAAB/;
const MAX_ANCHORS = 5_000;
const MAX_ANCHOR_TEXT = 2_000;

export interface HttpOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

function failure(err: unknown): XlsxError {
  if (err instanceof XlsxError) return err;
  const name = err instanceof Error ? err.name : '';
  return new XlsxError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
}

async function request(url: string, headers: Record<string, string>, http: HttpOptions): Promise<Response> {
  try {
    return await http.fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      headers: { 'User-Agent': USER_AGENT, ...headers },
      signal: AbortSignal.timeout(http.timeoutMs),
    });
  } catch (err) {
    throw failure(err);
  }
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    throw new XlsxError('too_large');
  }
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new XlsxError('too_large');
      }
      chunks.push(value);
    }
  } catch (err) {
    throw failure(err);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function getPage(url: SourceUrl, http: HttpOptions): Promise<string> {
  const res = await request(url, { Accept: 'text/html' }, http);
  if (res.status !== 200) {
    await discard(res);
    throw new XlsxError('http_status');
  }
  return new TextDecoder('utf-8').decode(await readLimited(res, PAGE_MAX_BYTES));
}

export interface PageSemester {
  semester: 1 | 2;
  academicYear: string;
}

export interface FileLinks {
  LT: SourceUrl;
  LM: SourceUrl;
  page: PageSemester | null;
}

function safeChar(code: number): string {
  return code > 31 && code < 0x110000 && !(code >= 0x7f && code <= 0x9f) ? String.fromCodePoint(code) : ' ';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => safeChar(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function anchorText(html: string): string {
  return decodeEntities(html.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

// Only workbooks under www.unical.it/media/medias/<year>/ that also pass sourceUrl().
function fileUrl(href: string, page: SourceUrl): SourceUrl | null {
  try {
    const url = sourceUrl(new URL(decodeEntities(href).trim(), page).href);
    return FILE_URL.test(url) && !ROBOTS_DISALLOWED.test(url) ? url : null;
  } catch {
    return null;
  }
}

function classify(text: string, url: string): DiamFileKind | null {
  const t = norm(text);
  const name = url.slice(url.lastIndexOf('/') + 1).toLowerCase();
  const lt = /(^|[^A-Z0-9])LT([^A-Z0-9]|$)/.test(t) || name.includes('triennal');
  const lm = /(^|[^A-Z0-9])LM([^A-Z0-9]|$)/.test(t) || name.includes('magistral');
  return lt === lm ? null : lt ? 'LT' : 'LM';
}

function pageSemester(html: string): PageSemester | null {
  const m = /\b(II|I)\s*(?:\u00b0|\u00ba|&deg;|&#176;|&ordm;)\s*SEMESTRE\s+(\d{4})\s*(?:-|\u2013|&ndash;)\s*(\d{4})/i.exec(html);
  return m ? { semester: m[1]?.toUpperCase() === 'II' ? 2 : 1, academicYear: `${m[2]}-${m[3]}` } : null;
}

// Exactly one LT and one LM link, each in one class only; anything else fails the whole source.
export function findFileLinks(html: string, page: SourceUrl): FileLinks {
  const open = /<a\b([^<>]{0,2000})>/gi;
  const close = /<\/a\s*>/gi;
  const classes = new Map<SourceUrl, Set<DiamFileKind | null>>();
  let anchors = 0;
  let closeAt = -1;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    if (++anchors > MAX_ANCHORS) throw new XlsxError('discovery_ambiguous');
    const bodyStart = open.lastIndex;
    if (closeAt < bodyStart) {
      close.lastIndex = bodyStart;
      const c = close.exec(html);
      if (!c) break;
      closeAt = c.index;
    }
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1] ?? '');
    const raw = href?.[1] ?? href?.[2];
    const url = raw ? fileUrl(raw, page) : null;
    if (!url) continue;
    const kind = classify(anchorText(html.slice(bodyStart, Math.min(closeAt, bodyStart + MAX_ANCHOR_TEXT))), url);
    const set = classes.get(url) ?? new Set<DiamFileKind | null>();
    set.add(kind);
    classes.set(url, set);
  }
  const found: Record<DiamFileKind, SourceUrl[]> = { LT: [], LM: [] };
  for (const [url, set] of classes) {
    const kinds = [...set];
    const kind = kinds[0];
    if (kinds.length !== 1 || !kind) throw new XlsxError('discovery_ambiguous');
    found[kind].push(url);
  }
  const [lt] = found.LT;
  const [lm] = found.LM;
  if (found.LT.length !== 1 || found.LM.length !== 1 || !lt || !lm) throw new XlsxError('discovery_ambiguous');
  return { LT: lt, LM: lm, page: pageSemester(html) };
}

export interface Validators {
  etag: string | null;
  lastModified: string | null;
}

export type Download =
  | { status: 'not_modified' }
  | { status: 'ok'; bytes: Uint8Array; sha256: string; validators: Validators };

// Header values sent back only when they are short printable ASCII.
function validator(v: string | null): string | null {
  return v !== null && v.length <= 200 && /^[\x21-\x7e][\x20-\x7e]*$/.test(v) ? v : null;
}

// Conditional GET with the validators of the last good response; nothing of the file is kept besides them.
export async function getWorkbook(url: SourceUrl, previous: Validators | null, http: HttpOptions): Promise<Download> {
  const headers: Record<string, string> = { Accept: XLSX_TYPE };
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  const res = await request(url, headers, http);
  if (res.status === 304 && previous && (previous.etag || previous.lastModified)) {
    await discard(res);
    return { status: 'not_modified' };
  }
  if (res.status !== 200) {
    await discard(res);
    throw new XlsxError('http_status');
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== XLSX_TYPE) {
    await discard(res);
    throw new XlsxError('bad_content_type');
  }
  const bytes = await readLimited(res, FILE_MAX_BYTES);
  return {
    status: 'ok',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    validators: { etag: validator(res.headers.get('etag')), lastModified: validator(res.headers.get('last-modified')) },
  };
}
