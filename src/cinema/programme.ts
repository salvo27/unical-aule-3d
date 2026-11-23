// The Cinema Unical programme, read from the public "Sale Unical" page of the cinema's own site (cosenzacinema.it).
// The page lists the films with their days; the times of one film on one day come from the call the page itself makes.
// The ticket office (18tickets) is not read: it answers servers with a bot check, and that is its owner's choice.
// A film or a time that does not match is left out, never guessed. Links are rebuilt from what we read and checked.
import { isoDay, type IsoDay } from '../domain/primitives.js';

export const CINEMA_PAGE = 'https://cosenzacinema.it/programmazione-sale-unical/';
export const CINEMA_TIMES = 'https://cosenzacinema.it/wp-admin/admin-ajax.php';
export const TICKETS = 'https://unical.cosenzacinema.18tickets.it/';
const SITE = 'https://cosenzacinema.it';

export interface CinemaShow {
  at: number;
  room: number | null;
  url: string | null;
}

export interface CinemaFilm {
  title: string;
  url: string;
  poster: string | null;
  shows: CinemaShow[];
}

export interface CinemaProgramme {
  source: string;
  tickets: string;
  checkedAt: number;
  films: CinemaFilm[];
}

/** A film of the page: its id for the times call and the days it is on. */
export interface ListedFilm {
  id: string;
  title: string;
  url: string;
  poster: string | null;
  days: IsoDay[];
}

const FILMS_MAX = 30;
const DAYS_MAX = 21;
const TIMES_MAX = 12;
const TITLE_MAX = 120;

const FILM_START = /class="amy-movie-item row"/g;
const TITLE = /<h3 class="amy-movie-field-title">\s*<a href="https:\/\/cosenzacinema\.it\/movie\/([a-z0-9-]{1,120})\/">([^<]{1,400})<\/a>/;
const POSTER = /<div class="amy-movie-item-poster">[\s\S]{0,300}?<img[^>]*\ssrc="https:\/\/cosenzacinema\.it\/wp-content\/uploads\/(\d{4}\/\d{2}\/[A-Za-z0-9._-]{1,150}\.(?:jpg|jpeg|png|webp))"/;
const SELECT = /<select[^>]*\bclass="timelist"[^>]*\bdata-movie="(\d{1,9})"[^>]*>([\s\S]{0,4000}?)<\/select>/;
const OPTION = /<option value="(\d{4}-\d{2}-\d{2})"/g;
// The answer is a JSON string of HTML: quotes and slashes may come escaped
const TIME = /<span class=\\?"intro-time\\?">\s*(\d{1,2})[:.](\d{2})\s*<\\?\/span>/g;

const NAMED: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  agrave: 'à',
  egrave: 'è',
  eacute: 'é',
  igrave: 'ì',
  ograve: 'ò',
  oacute: 'ó',
  ugrave: 'ù',
  ocirc: 'ô',
  auml: 'ä',
  ouml: 'ö',
  uuml: 'ü',
  ntilde: 'ñ',
  ccedil: 'ç',
  Agrave: 'À',
  Egrave: 'È',
  Eacute: 'É',
  Igrave: 'Ì',
  Ograve: 'Ò',
  Ugrave: 'Ù',
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (all, code: string) => {
    if (code.startsWith('#')) {
      const n = code.startsWith('#x') || code.startsWith('#X') ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
    }
    return Object.hasOwn(NAMED, code) ? (NAMED[code] ?? all) : all;
  });
}

function title(raw: string): string | null {
  const text = decode(raw).replace(/\s+/g, ' ').trim();
  if (text.length === 0 || text.length > TITLE_MAX) return null;
  if (/[\u0000-\u001f\u007f-\u009f<>]/.test(text)) return null;
  return text;
}

function day(value: string): IsoDay | null {
  try {
    return isoDay(value);
  } catch {
    return null;
  }
}

/** The films of the programme page, each with the days it is on. */
export function parseFilms(html: string): ListedFilm[] {
  const starts = [...html.matchAll(FILM_START)].map((m) => m.index);
  const films: ListedFilm[] = [];
  const seen = new Set<string>();
  for (const [i, start] of starts.entries()) {
    if (films.length >= FILMS_MAX) break;
    const block = html.slice(start, starts[i + 1] ?? html.length);
    const [, slug, rawTitle] = TITLE.exec(block) ?? [];
    const [, id, options] = SELECT.exec(block) ?? [];
    if (slug === undefined || rawTitle === undefined || id === undefined || options === undefined || seen.has(id)) continue;
    const name = title(rawTitle);
    if (name === null) continue;
    const days = [...new Set([...options.matchAll(OPTION)].map((m) => day(m[1] ?? '')).filter((d): d is IsoDay => d !== null))].sort().slice(0, DAYS_MAX);
    const file = POSTER.exec(block)?.[1];
    seen.add(id);
    films.push({ id, title: name, url: `${SITE}/movie/${slug}/`, poster: file ? `${SITE}/wp-content/uploads/${file}` : null, days });
  }
  return films;
}

/** The times of one film on one day, as minutes after midnight, from the answer of the times call. */
export function parseTimes(body: string): number[] {
  const minutes = new Set<number>();
  for (const [, h, m] of body.matchAll(TIME)) {
    const hour = Number(h);
    const minute = Number(m);
    if (hour <= 23 && minute <= 59) minutes.add(hour * 60 + minute);
    if (minutes.size >= TIMES_MAX) break;
  }
  return [...minutes].sort((a, b) => a - b);
}

/** The programme in the shape the app reads: films in order of their first show, without the ones left with none. */
export function programme(films: readonly Omit<CinemaFilm, 'shows'>[], shows: ReadonlyMap<string, CinemaShow[]>, now: number): CinemaProgramme {
  const out = films
    .map((film) => ({ ...film, shows: [...(shows.get(film.url) ?? [])].sort((a, b) => a.at - b.at) }))
    .filter((film) => film.shows.length > 0);
  const first = (film: CinemaFilm): number => film.shows[0]?.at ?? 0;
  out.sort((a, b) => first(a) - first(b) || a.title.localeCompare(b.title));
  return { source: CINEMA_PAGE, tickets: TICKETS, checkedAt: now, films: out };
}
