// The Cinema Unical programme: the page of the cinema's site, then one times call per film and day from today on.
// Nothing of the caller is forwarded. The calls go a few at a time and are capped, well under the Workers limit.
import { addDays, romeDay, romeInstant } from '../availability/time.js';
import { CINEMA_PAGE, CINEMA_TIMES, parseFilms, parseTimes, programme, type CinemaShow } from '../cinema/programme.js';
import { USER_AGENT } from '../user-agent.js';
import type { Bytes } from './cache.js';
import { UpstreamError, discard, readCapped, transportCode } from './rpc.js';

const PAGE_CAP = 2 * 1_048_576;
const TIMES_CAP = 65_536;
const TIMEOUT_MS = 8000;
const HTML_TYPE = /^text\/html\s*(;|$)/i;
const TIMES_TYPE = /^(text\/html|application\/json)\s*(;|$)/i;
// A week of programme, at most 40 calls, four at a time
const DAYS_AHEAD = 7;
const CALLS_MAX = 40;
const AT_ONCE = 4;
// A show that started within the last hour is still worth listing
const PAST_MS = 60 * 60_000;

export interface CinemaDeps {
  fetch: typeof fetch;
  now: () => number;
  log: (line: string) => void;
}

type Failed = (status: number, code: string, result: 'upstream_error' | 'upstream_unavailable') => UpstreamError;

async function read(deps: CinemaDeps, url: string, init: RequestInit, type: RegExp, cap: number, failed: Failed): Promise<string> {
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

export async function loadCinema(deps: CinemaDeps): Promise<Bytes> {
  const failed = (what: string): Failed => (status, code, result) => {
    deps.log(JSON.stringify({ event: 'upstream_failed', fn: `cinema_${what}`, status, code }));
    return new UpstreamError(result, status > 0 && (code === 'status' || code === 'redirect') ? `${code}_${status}` : code);
  };
  const headers = { 'User-Agent': USER_AGENT };

  const html = await read(deps, CINEMA_PAGE, { method: 'GET', headers: { ...headers, Accept: 'text/html' } }, HTML_TYPE, PAGE_CAP, failed('page'));
  const films = parseFilms(html);
  // Films on the page but none read: the page changed and the parser needs a look.
  if (films.length === 0 && html.includes('timelist')) deps.log(JSON.stringify({ event: 'cinema_unreadable' }));

  const now = deps.now();
  const today = romeDay(now);
  const last = addDays(today, DAYS_AHEAD - 1);
  const calls = films.flatMap((film) => film.days.filter((d) => d >= today && d <= last).map((day) => ({ film, day }))).slice(0, CALLS_MAX);
  const shows = new Map<string, CinemaShow[]>();
  let lost = 0;
  for (let i = 0; i < calls.length; i += AT_ONCE) {
    await Promise.all(
      calls.slice(i, i + AT_ONCE).map(async ({ film, day }) => {
        let body: string;
        try {
          const form = new URLSearchParams({ action: 'amy_movie_ajax_shortcode_showtime_layout_4', movie_id: film.id, date: day });
          const init = { method: 'POST', headers: { ...headers, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString() };
          body = await read(deps, CINEMA_TIMES, init, TIMES_TYPE, TIMES_CAP, failed('times'));
        } catch {
          lost += 1;
          return;
        }
        for (const minutes of parseTimes(body)) {
          const at = romeInstant(day, Math.floor(minutes / 60), minutes % 60);
          if (at >= now - PAST_MS) shows.set(film.url, [...(shows.get(film.url) ?? []), { at, room: null, url: null }]);
        }
      }),
    );
  }
  // Not one day read: the cinema's site is down, which is not the same as "no films".
  if (calls.length > 0 && lost === calls.length) throw new UpstreamError('upstream_unavailable', 'times');

  const listed = films.map(({ title, url, poster }) => ({ title, url, poster }));
  const encoded = new TextEncoder().encode(JSON.stringify(programme(listed, shows, now)));
  const body = new Uint8Array(encoded.byteLength);
  body.set(encoded);
  return body;
}
