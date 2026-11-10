// Requests of the PDF source: index pages and PDF files, with size limits, no redirects and no cookies.
import { createHash } from 'node:crypto';
import type { SourceUrl } from '../../domain/primitives.js';
import { USER_AGENT } from '../../user-agent.js';
import { PdfError } from './codes.js';
import { isPdf, MAX_PDF_BYTES } from './poppler.js';

export const PAGE_MAX_BYTES = 2_000_000;
export const PDF_TYPE = 'application/pdf';

export interface HttpOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

function failure(err: unknown): PdfError {
  if (err instanceof PdfError) return err;
  const name = err instanceof Error ? err.name : '';
  return new PdfError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
}

async function request(url: SourceUrl, headers: Record<string, string>, http: HttpOptions): Promise<Response> {
  try {
    return await http.fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      credentials: 'omit',
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
    throw new PdfError('too_large');
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
        throw new PdfError('too_large');
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

function mediaType(res: Response): string {
  return (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

export async function getPage(url: SourceUrl, http: HttpOptions): Promise<string> {
  const res = await request(url, { Accept: 'text/html' }, http);
  if (res.status !== 200) {
    await discard(res);
    throw new PdfError('http_status');
  }
  if (mediaType(res) !== 'text/html') {
    await discard(res);
    throw new PdfError('bad_html');
  }
  return new TextDecoder('utf-8').decode(await readLimited(res, PAGE_MAX_BYTES));
}

function safeChar(code: number): string {
  return code > 31 && code < 0x110000 && !(code >= 0x7f && code <= 0x9f) && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : ' ';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h: string) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d: string) => safeChar(Number(d)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&deg;/g, '°')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Visible text of an HTML fragment: tags dropped, entities decoded, spaces collapsed.
export function htmlText(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^<>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export interface Anchor {
  href: string;
  text: string;
}

const MAX_ANCHORS = 5_000;
const MAX_ANCHOR_TEXT = 2_000;

// Every <a href> with its decoded href and visible text; resolving and checking the URL is up to the caller.
export function anchorsOf(html: string): Anchor[] {
  const open = /<a\b([^<>]{0,2000})>/gi;
  const close = /<\/a\s*>/gi;
  const out: Anchor[] = [];
  let anchors = 0;
  let closeAt = -1;
  for (let m = open.exec(html); m; m = open.exec(html)) {
    if (++anchors > MAX_ANCHORS) throw new PdfError('bad_html');
    const bodyStart = open.lastIndex;
    if (closeAt < bodyStart) {
      close.lastIndex = bodyStart;
      const c = close.exec(html);
      if (!c) break;
      closeAt = c.index;
    }
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(m[1] ?? '');
    const raw = href?.[1] ?? href?.[2];
    if (raw === undefined) continue;
    out.push({ href: decodeEntities(raw).trim(), text: htmlText(html.slice(bodyStart, Math.min(closeAt, bodyStart + MAX_ANCHOR_TEXT))) });
  }
  return out;
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
export async function getPdf(url: SourceUrl, previous: Validators | null, http: HttpOptions): Promise<Download> {
  const headers: Record<string, string> = { Accept: PDF_TYPE };
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  const res = await request(url, headers, http);
  if (res.status === 304 && previous && (previous.etag || previous.lastModified)) {
    await discard(res);
    return { status: 'not_modified' };
  }
  if (res.status !== 200) {
    await discard(res);
    throw new PdfError('http_status');
  }
  if (mediaType(res) !== PDF_TYPE) {
    await discard(res);
    throw new PdfError('bad_content_type');
  }
  const bytes = await readLimited(res, MAX_PDF_BYTES);
  if (!isPdf(bytes)) throw new PdfError('not_pdf');
  return {
    status: 'ok',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    validators: { etag: validator(res.headers.get('etag')), lastModified: validator(res.headers.get('last-modified')) },
  };
}
