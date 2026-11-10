// One POST to the Supabase Data API RPC with the publishable key. Bodies are passed through, never parsed on success.
import { supabaseSettings, type SupabaseSettings } from '../settings.js';
import type { Bytes } from './cache.js';

export const BODY_CAP = 1_048_576;
const ERROR_CAP = 4096;
const TIMEOUT_MS = 8000;

export type RpcFn = 'room_status' | 'room_lessons' | 'search_rooms';
const FUNCTIONS: ReadonlySet<string> = new Set<RpcFn>(['room_status', 'room_lessons', 'search_rooms']);

export type UpstreamCode = 'invalid' | 'not_found' | 'upstream_error' | 'upstream_unavailable';
type LogCode = 'network' | 'timeout' | 'redirect' | 'too_large' | 'content_type' | 'status' | 'P0001' | 'config';

const STATUS: Readonly<Record<UpstreamCode, number>> = { invalid: 400, not_found: 404, upstream_error: 502, upstream_unavailable: 503 };

export class UpstreamError extends Error {
  readonly code: UpstreamCode;
  readonly status: number;
  constructor(code: UpstreamCode) {
    super(code);
    this.name = 'UpstreamError';
    this.code = code;
    this.status = STATUS[code];
  }
}

export interface UpstreamEnv {
  SUPABASE_URL?: unknown;
  SUPABASE_PUBLISHABLE_KEY?: unknown;
}

export interface RpcDeps {
  fetch: typeof fetch;
  log: (line: string) => void;
}

export const JSON_TYPE = /^application\/json\s*(;|$)/i;

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function transportCode(err: unknown): LogCode {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined;
  return name === 'TimeoutError' ? 'timeout' : 'network';
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // nothing left to release
  }
}

// Reads the whole body, or returns null as soon as it grows past the cap.
export async function readCapped(res: Response, cap: number): Promise<Bytes | null> {
  const body = res.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel().catch(() => undefined);
      throw new TypeError('chunk');
    }
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function errorDetail(res: Response): Promise<{ code: string; message: string }> {
  try {
    const bytes = await readCapped(res, ERROR_CAP);
    if (!bytes) return { code: '', message: '' };
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return { code: '', message: '' };
    const record = data as Record<string, unknown>;
    return { code: text(record.code) ?? '', message: text(record.message) ?? '' };
  } catch {
    return { code: '', message: '' };
  }
}

export async function callRpc(
  env: UpstreamEnv,
  local: boolean,
  fn: RpcFn,
  args: Readonly<Record<string, unknown>>,
  deps: RpcDeps,
): Promise<Bytes> {
  const failed = (status: number, code: LogCode, result: UpstreamCode): UpstreamError => {
    deps.log(JSON.stringify({ event: 'upstream_failed', fn, status, code }));
    return new UpstreamError(result);
  };
  if (!FUNCTIONS.has(fn)) throw new UpstreamError('upstream_error');

  let settings: SupabaseSettings;
  try {
    settings = supabaseSettings(
      { SUPABASE_URL: text(env.SUPABASE_URL), SUPABASE_PUBLISHABLE_KEY: text(env.SUPABASE_PUBLISHABLE_KEY) },
      { allowLocalHttp: local },
    );
  } catch {
    throw failed(0, 'config', 'upstream_unavailable');
  }

  let res: Response;
  try {
    res = await deps.fetch(`${settings.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: { apikey: settings.publishableKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw failed(0, transportCode(err), 'upstream_unavailable');
  }

  const status = res.status;
  if (status >= 200 && status < 300) {
    if (!JSON_TYPE.test(res.headers.get('content-type') ?? '')) {
      await discard(res);
      throw failed(status, 'content_type', 'upstream_error');
    }
    const declared = res.headers.get('content-length');
    if (declared !== null && !(Number(declared) <= BODY_CAP)) {
      await discard(res);
      throw failed(status, 'too_large', 'upstream_error');
    }
    let bytes: Bytes | null;
    try {
      bytes = await readCapped(res, BODY_CAP);
    } catch (err) {
      throw failed(status, transportCode(err), 'upstream_unavailable');
    }
    if (bytes === null) throw failed(status, 'too_large', 'upstream_error');
    if (bytes.byteLength === 0) throw failed(status, 'content_type', 'upstream_error');
    return bytes;
  }
  if (status >= 300 && status < 400) {
    await discard(res);
    throw failed(status, 'redirect', 'upstream_error');
  }
  // A quota 429 or an outage turns the map grey: never stale data.
  if (status === 401 || status === 403 || status === 429 || status >= 500) {
    await discard(res);
    throw failed(status, 'status', 'upstream_unavailable');
  }
  if (status >= 400 && status < 500) {
    const detail = await errorDetail(res);
    if (detail.code === 'P0001') {
      if (detail.message === 'not_found') throw new UpstreamError('not_found');
      if (detail.message === 'invalid') throw new UpstreamError('invalid');
      throw failed(status, 'P0001', 'upstream_error');
    }
    throw failed(status, 'status', 'upstream_error');
  }
  await discard(res);
  throw failed(status, 'status', 'upstream_error');
}
