// The shows of the campus theatres: the theatres page for the link of this season, then the season and the PTU pages.
// Nothing of the caller is forwarded. One page that fails leaves the other theatre's shows; both failing is an outage.
import { romeDay } from '../availability/time.js';
import { PTU_PAGE, SEASON_PAGE, THEATRES_PAGE, parseShows, programme, seasonLink, type TheatreShow } from '../theatres/programme.js';
import { USER_AGENT } from '../user-agent.js';
import type { Bytes } from './cache.js';
import { failedFor, jsonBytes, readPage, type PageDeps } from './pages.js';
import { UpstreamError } from './rpc.js';

const PAGE_CAP = 2 * 1_048_576;
const HTML_TYPE = /^text\/html\s*(;|$)/i;

export type TheatresDeps = PageDeps;

export async function loadTheatres(deps: TheatresDeps): Promise<Bytes> {
  const init: RequestInit = { method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' } };
  const read = (url: string, fn: string) => readPage(deps, url, init, HTML_TYPE, PAGE_CAP, failedFor(deps, fn));

  // Without the theatres page, last known season page: better than no TAU at all
  let season = SEASON_PAGE;
  try {
    season = seasonLink(await read(THEATRES_PAGE, 'theatres_page')) ?? SEASON_PAGE;
  } catch {
    // already logged
  }
  const from = romeDay(deps.now());
  const pages = await Promise.all(
    [
      [season, 'theatres_season'],
      [PTU_PAGE, 'theatres_ptu'],
    ].map(async ([url = '', fn = '']): Promise<TheatreShow[] | null> => {
      try {
        return parseShows(await read(url, fn), url, from);
      } catch {
        return null;
      }
    }),
  );
  const fetched = pages.filter((p): p is TheatreShow[] => p !== null);
  if (fetched.length === 0) throw new UpstreamError('upstream_unavailable', 'pages');
  return jsonBytes(programme(fetched, [season, PTU_PAGE], deps.now()));
}
