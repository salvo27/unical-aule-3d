// The Cinema Unical programme: the page of the cinema's site, then one times call per film and day from today on.
// Nothing of the caller is forwarded. The calls go a few at a time and are capped, well under the Workers limit.
import { addDays, romeDay, romeInstant } from '../availability/time.js';
import { CINEMA_PAGE, CINEMA_TIMES, parseFilms, parseTimes, programme, type CinemaShow } from '../cinema/programme.js';
import { USER_AGENT } from '../user-agent.js';
import type { Bytes } from './cache.js';
import { failedFor, jsonBytes, readPage, type PageDeps } from './pages.js';
import { UpstreamError } from './rpc.js';

const PAGE_CAP = 2 * 1_048_576;
const TIMES_CAP = 65_536;
const HTML_TYPE = /^text\/html\s*(;|$)/i;
const TIMES_TYPE = /^(text\/html|application\/json)\s*(;|$)/i;
// A week of programme, at most 40 calls, four at a time
const DAYS_AHEAD = 7;
const CALLS_MAX = 40;
const AT_ONCE = 4;
// A show that started within the last hour is still worth listing
const PAST_MS = 60 * 60_000;

export type CinemaDeps = PageDeps;

export async function loadCinema(deps: CinemaDeps): Promise<Bytes> {
  const headers = { 'User-Agent': USER_AGENT };

  const html = await readPage(deps, CINEMA_PAGE, { method: 'GET', headers: { ...headers, Accept: 'text/html' } }, HTML_TYPE, PAGE_CAP, failedFor(deps, 'cinema_page'));
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
          body = await readPage(deps, CINEMA_TIMES, init, TIMES_TYPE, TIMES_CAP, failedFor(deps, 'cinema_times'));
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
  return jsonBytes(programme(listed, shows, now));
}
