// The one request of the DIMES source: a conditional GET of the app page, size limited, no redirects.
import { createHash } from 'node:crypto';
import type { SourceUrl } from '../../domain/primitives.js';
import { USER_AGENT } from '../../user-agent.js';
import { DimesError } from './codes.js';

export const PAGE_MAX_BYTES = 2_000_000;

export interface HttpOptions {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  retryMs: number;
  sleep: (ms: number) => Promise<void>;
  onRetry: () => void;
}

export interface Validators {
  etag: string | null;
  lastModified: string | null;
}

export type Download = { status: 'not_modified' } | { status: 'ok'; html: string; sha256: string; validators: Validators };

function failure(err: unknown): DimesError {
  if (err instanceof DimesError) return err;
  const name = err instanceof Error ? err.name : '';
  return new DimesError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

async function readLimited(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(res);
    throw new DimesError('too_large');
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
        throw new DimesError('too_large');
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

// Header values sent back only when they are short printable ASCII.
function validator(v: string | null): string | null {
  return v !== null && v.length <= 200 && /^[\x21-\x7e][\x20-\x7e]*$/.test(v) ? v : null;
}

async function once(url: SourceUrl, previous: Validators | null, http: HttpOptions): Promise<Response> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'text/html' };
  if (previous?.etag) headers['If-None-Match'] = previous.etag;
  if (previous?.lastModified) headers['If-Modified-Since'] = previous.lastModified;
  try {
    return await http.fetchImpl(url, { method: 'GET', redirect: 'error', headers, signal: AbortSignal.timeout(http.timeoutMs) });
  } catch (err) {
    throw failure(err);
  }
}

// One more try after a pause for network errors and 5xx, never for anything else.
async function request(url: SourceUrl, previous: Validators | null, http: HttpOptions): Promise<Response> {
  try {
    const res = await once(url, previous, http);
    if (res.status < 500) return res;
    await discard(res);
  } catch (err) {
    const code = failure(err).code;
    if (code !== 'network' && code !== 'timeout') throw err;
  }
  http.onRetry();
  await http.sleep(http.retryMs);
  return once(url, previous, http);
}

export async function getPage(url: SourceUrl, previous: Validators | null, http: HttpOptions): Promise<Download> {
  const res = await request(url, previous, http);
  if (res.status === 304 && previous && (previous.etag || previous.lastModified)) {
    await discard(res);
    return { status: 'not_modified' };
  }
  if (res.status !== 200) {
    await discard(res);
    throw new DimesError('http_status');
  }
  const type = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'text/html') {
    await discard(res);
    throw new DimesError('bad_content_type');
  }
  const bytes = await readLimited(res, PAGE_MAX_BYTES);
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new DimesError('bad_encoding');
  }
  return {
    status: 'ok',
    html,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    validators: { etag: validator(res.headers.get('etag')), lastModified: validator(res.headers.get('last-modified')) },
  };
}
