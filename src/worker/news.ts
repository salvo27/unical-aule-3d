// The University's news: one call per category to the public JSON its news page reads. Nothing of the caller is
// forwarded. A category that fails leaves the others; all of them failing is an outage, not "no news".
import { CATEGORIES, categoryUrl, parseNews, programme, type NewsItem } from '../news/programme.js';
import { USER_AGENT } from '../user-agent.js';
import type { Bytes } from './cache.js';
import { failedFor, jsonBytes, readPage, type PageDeps } from './pages.js';
import { UpstreamError } from './rpc.js';

// The answers carry the whole article: twenty of them stay well under this
const ANSWER_CAP = 2 * 1_048_576;
const JSON_ANSWER = /^application\/json\s*(;|$)/i;

export type NewsDeps = PageDeps;

export async function loadNews(deps: NewsDeps): Promise<Bytes> {
  const init: RequestInit = { method: 'GET', headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } };
  const now = deps.now();
  const urls = CATEGORIES.map((c) => categoryUrl(c.id));
  const lists = await Promise.all(
    urls.map(async (url): Promise<NewsItem[] | null> => {
      let answer: string;
      try {
        answer = await readPage(deps, url, init, JSON_ANSWER, ANSWER_CAP, failedFor(deps, 'news'));
      } catch {
        return null;
      }
      let body: unknown = null;
      try {
        body = JSON.parse(answer);
      } catch {
        // checked just below
      }
      // An answer without a list: the API changed and the parser needs a look
      if (!Array.isArray((body as { results?: unknown } | null)?.results)) {
        deps.log(JSON.stringify({ event: 'news_unreadable' }));
        return null;
      }
      return parseNews(body, now);
    }),
  );
  const read = lists.filter((l): l is NewsItem[] => l !== null);
  if (read.length === 0) throw new UpstreamError('upstream_unavailable', 'news');
  return jsonBytes(programme(read, urls, now));
}
