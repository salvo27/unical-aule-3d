// One request to a public page of another site: no redirects, a timeout, a size cap and the expected content type.
import type { Bytes } from './cache.js';
import { UpstreamError, discard, readCapped, transportCode } from './rpc.js';

const TIMEOUT_MS = 8000;

export interface PageDeps {
  fetch: typeof fetch;
  now: () => number;
  log: (line: string) => void;
}

export type Failed = (status: number, code: string, result: 'upstream_error' | 'upstream_unavailable') => UpstreamError;

/** A Failed that logs the page by name and keeps the reason in the error, as "status_403" or "redirect_301". */
export function failedFor(deps: PageDeps, fn: string): Failed {
  return (status, code, result) => {
    deps.log(JSON.stringify({ event: 'upstream_failed', fn, status, code }));
    return new UpstreamError(result, status > 0 && (code === 'status' || code === 'redirect') ? `${code}_${status}` : code);
  };
}

export async function readPage(deps: PageDeps, url: string, init: RequestInit, type: RegExp, cap: number, failed: Failed): Promise<string> {
  let res: Response;
  try {
    res = await deps.fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw failed(0, transportCode(err), 'upstream_unavailable');
  }
  const status = res.status;
  if (status !== 200) {
    await discard(res);
    const down = status === 429 || status >= 500;
    throw failed(status, status >= 300 && status < 400 ? 'redirect' : 'status', down ? 'upstream_unavailable' : 'upstream_error');
  }
  if (!type.test(res.headers.get('content-type') ?? '')) {
    await discard(res);
    throw failed(status, 'content_type', 'upstream_error');
  }
  let bytes: Bytes | null;
  try {
    bytes = await readCapped(res, cap);
  } catch (err) {
    throw failed(status, transportCode(err), 'upstream_unavailable');
  }
  if (bytes === null) throw failed(status, 'too_large', 'upstream_error');
  return new TextDecoder('utf-8').decode(bytes);
}

/** The JSON of a value as the bytes the handler caches and sends. */
export function jsonBytes(value: unknown): Bytes {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const body = new Uint8Array(encoded.byteLength);
  body.set(encoded);
  return body;
}
