// The University's news, from the public JSON its own news page reads: one list per category.
// Avvisi and Didattica become notices, Notizie UniCal and Ricerca e Approfondimenti become news. Only the fields the
// app shows are kept: the article itself stays on the University's site, where the link leads.
// An item that does not match is left out, never guessed.

export const NEWS_API = 'https://www.unical.it/api/news/by-context/1';
const SITE = 'https://www.unical.it';

export type NewsKind = 'notice' | 'news';

/** The categories read, with the kind each one is shown under. */
export const CATEGORIES: readonly { id: number; kind: NewsKind }[] = [
  { id: 8, kind: 'notice' }, // Avvisi
  { id: 1, kind: 'notice' }, // Didattica
  { id: 9, kind: 'news' }, // Notizie UniCal
  { id: 12, kind: 'news' }, // Ricerca e Approfondimenti
];

export interface NewsItem {
  id: number;
  title: string;
  summary: string | null;
  at: number;
  kinds: NewsKind[];
  url: string;
  image: string | null;
}

export interface NewsProgramme {
  sources: string[];
  checkedAt: number;
  items: NewsItem[];
}

export const PER_CATEGORY = 20;
const ITEMS_MAX = 80;
const TITLE_MAX = 300;
const SUMMARY_MAX = 400;
// A few minutes of clock difference with the University's server is not a news from the future
const AHEAD_MS = 10 * 60_000;

const PATH = /^\/contents\/news\/view\/\d{1,7}-[A-Za-z0-9_-]{1,300}\/$/;
const IMAGE = /^\/media\/medias\/\d{4}\/[A-Za-z0-9._-]{1,150}\.(?:webp|jpg|jpeg|png)$/i;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length === 0 || clean.length > max) return null;
  if (/[\u0000-\u001f\u007f-\u009f<>]/.test(clean)) return null;
  return clean;
}

/** The URL for one category, newest first as the University's page asks for them. */
export function categoryUrl(id: number): string {
  return `${NEWS_API}?${new URLSearchParams({ page: '1', page_size: String(PER_CATEGORY), lang: 'it', category: String(id) })}`;
}

function kindsOf(categories: unknown): NewsKind[] {
  if (!Array.isArray(categories)) return [];
  const kinds = new Set<NewsKind>();
  for (const category of categories) {
    const known = CATEGORIES.find((c) => c.id === field(category, 'id'));
    if (known) kinds.add(known.kind);
  }
  return (['notice', 'news'] as const).filter((k) => kinds.has(k));
}

/** The items of one answer of the news API, without those past `now`. */
export function parseNews(body: unknown, now: number): NewsItem[] {
  const results = field(body, 'results');
  if (!Array.isArray(results)) return [];
  const items: NewsItem[] = [];
  for (const raw of results.slice(0, PER_CATEGORY * 2)) {
    const publication = field(raw, 'publication');
    const id = field(publication, 'id');
    const start = field(raw, 'date_start');
    const path = field(raw, 'path');
    const image = field(publication, 'image');
    const title = text(field(publication, 'title'), TITLE_MAX);
    const at = typeof start === 'string' && INSTANT.test(start) ? Date.parse(start) : NaN;
    const kinds = kindsOf(field(publication, 'category_data'));
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) continue;
    if (title === null || !Number.isFinite(at) || at > now + AHEAD_MS || kinds.length === 0) continue;
    if (typeof path !== 'string' || !PATH.test(path)) continue;
    items.push({
      id,
      title,
      summary: text(field(publication, 'subheading'), SUMMARY_MAX),
      at,
      kinds,
      url: `${SITE}${path}`,
      image: typeof image === 'string' && IMAGE.test(image) ? `${SITE}${image}` : null,
    });
  }
  return items;
}

/** All the items once each, newest first. */
export function programme(lists: readonly NewsItem[][], sources: string[], now: number): NewsProgramme {
  const byId = new Map<number, NewsItem>();
  for (const item of lists.flat()) if (!byId.has(item.id)) byId.set(item.id, item);
  const items = [...byId.values()].sort((a, b) => b.at - a.at || b.id - a.id).slice(0, ITEMS_MAX);
  return { sources, checkedAt: now, items };
}
