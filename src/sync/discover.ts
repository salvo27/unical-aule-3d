// Finds public Planner calendars linked from Unical pages. Results are proposals: an admin confirms them.
import { calendarId, sourceUrl, PLANNER_HOST, type CalendarId, type SourceUrl } from '../domain/primitives.js';
import { USER_AGENT } from '../user-agent.js';

export interface DiscoveredCalendar {
  id: CalendarId;
  label: string;
  source: SourceUrl;
}

export interface DiscoveryResult {
  found: DiscoveredCalendar[];
  failures: { source: SourceUrl; failure: string }[];
}

interface Options {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

const TOKEN = /<(h[1-6]|strong|b)\b[^>]*>([\s\S]*?)<\/\1>|<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF = /\bhref\s*=\s*"([^"]*)"|\bhref\s*=\s*'([^']*)'/i;
const ID_PARAM = /linkCalendarioId=([0-9a-f]{24})(?![0-9a-z])/;
const MAX_LABEL = 160;

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

function safeChar(code: number): string {
  return code > 31 && code < 0x110000 && !(code >= 0x7f && code <= 0x9f) ? String.fromCodePoint(code) : ' ';
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/[<>]/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function plannerIdFromHref(href: string): CalendarId | null {
  let url: URL;
  try {
    url = new URL(decodeEntities(href));
  } catch {
    return null;
  }
  if (url.hostname !== PLANNER_HOST) return null;
  const match = ID_PARAM.exec(url.pathname + url.search);
  if (!match) return null;
  try {
    return calendarId(match[1]);
  } catch {
    return null;
  }
}

export function extractCalendarLinks(html: string, source: SourceUrl): DiscoveredCalendar[] {
  const out: DiscoveredCalendar[] = [];
  const seen = new Set<string>();
  let context = '';
  for (const m of html.matchAll(TOKEN)) {
    if (m[1]) {
      const heading = plainText(m[2] ?? '');
      if (heading) context = heading.slice(0, 60);
      continue;
    }
    const hrefMatch = HREF.exec(m[3] ?? '');
    const href = hrefMatch?.[1] ?? hrefMatch?.[2];
    if (!href) continue;
    const id = plannerIdFromHref(href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const text = plainText(m[4] ?? '') || `Calendario ${id}`;
    const full = context ? `${context} · ${text}` : text;
    out.push({ id, label: full.slice(0, MAX_LABEL).trim(), source });
  }
  return out;
}

class DiscoveryError extends Error {
  constructor(readonly failure: string) {
    super(failure);
  }
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new DiscoveryError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchPage(start: SourceUrl, options: Required<Options>): Promise<string> {
  let url: SourceUrl = start;
  for (let hop = 0; hop <= 3; hop++) {
    let res: Response;
    try {
      res = await options.fetchImpl(url, {
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
        signal: AbortSignal.timeout(options.timeoutMs),
      });
    } catch {
      throw new DiscoveryError('network');
    }
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel().catch(() => undefined);
      if (!location) throw new DiscoveryError('http_status');
      try {
        url = sourceUrl(new URL(location, url).href);
      } catch {
        throw new DiscoveryError('redirect_blocked');
      }
      // robots.txt of the unical.it hosts: "Disallow: *gAAAAAB*".
      if (url.includes('gAAAAAB')) throw new DiscoveryError('redirect_blocked');
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new DiscoveryError('http_status');
    }
    if (!(res.headers.get('content-type') ?? '').toLowerCase().includes('text/html')) {
      await res.body?.cancel().catch(() => undefined);
      throw new DiscoveryError('not_html');
    }
    return readLimited(res, options.maxBytes);
  }
  throw new DiscoveryError('too_many_redirects');
}

export async function discover(sources: readonly SourceUrl[], options: Options = {}): Promise<DiscoveryResult> {
  const opts: Required<Options> = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: options.maxBytes ?? 3_000_000,
  };
  const result: DiscoveryResult = { found: [], failures: [] };
  const seen = new Set<string>();
  for (const source of sources) {
    try {
      const html = await fetchPage(source, opts);
      for (const item of extractCalendarLinks(html, source)) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        result.found.push(item);
      }
    } catch (err) {
      result.failures.push({ source, failure: err instanceof DiscoveryError ? err.failure : 'unexpected' });
    }
  }
  return result;
}
