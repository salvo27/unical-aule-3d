// The shows of the two campus theatres, read from the University's own pages: the season of the Teatro Auditorium
// (TAU) and the next shows of the Piccolo Teatro (PTU). Each show is a block with a poster, a title in <h4> and a
// paragraph with the theatre, one line per day, maybe a note in italics, and the time.
// A block that does not match is left out, never guessed: no day, no show. Cancelled shows are skipped.
import { romeInstant, romeMidnight } from '../availability/time.js';
import { isoDay, type IsoDay } from '../domain/primitives.js';

export const THEATRES_PAGE = 'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/';
export const PTU_PAGE = 'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/ptu/';
// The season page changes name every year: its link is read from the theatres page, this one is the fallback
export const SEASON_PAGE = 'https://www.unical.it/campus/vivere-il-campus/teatri-e-cinema/stagione-teatrale-2026-27/';
const SITE = 'https://www.unical.it';

export type Theatre = 'tau' | 'ptu';

export interface TheatreDate {
  at: number;
  /** False when the page gives the day but not the time: `at` is then midnight in Rome. */
  timed: boolean;
  note: string | null;
}

export interface TheatreShow {
  title: string;
  theatre: Theatre;
  url: string;
  poster: string | null;
  dates: TheatreDate[];
}

export interface TheatreProgramme {
  sources: string[];
  checkedAt: number;
  shows: TheatreShow[];
}

const SHOWS_MAX = 40;
const DATES_MAX = 10;
const TITLE_MAX = 160;
const NOTE_MAX = 120;

const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const BLOCK_START = /<div class="row mb-4">/g;
const TITLE = /<h4>([^<]{1,400})<\/h4>/;
const PARAGRAPH = /<p>([\s\S]{0,2000}?)<\/p>/;
const POSTER = /<img[^>]*\ssrc="(\/media\/medias\/\d{4}\/[A-Za-z0-9._-]{1,150}\.(?:webp|jpg|jpeg|png))"/;
const DAY = new RegExp(`(\\d{1,2})\\s+(${MONTHS.join('|')})\\s+(\\d{4})`, 'i');
const NOTE = /<i>([^<]{1,400})<\/i>/;
// "21:oo" with letters for zeros is on the real page
const TIME = /\bore\s+(\d{1,2})[:.]([0-9oO]{2})\b/i;
const SEASON_LINK = /href="(?:https:)?\/\/www\.unical\.it(\/campus\/vivere-il-campus\/teatri-e-cinema\/stagione-teatrale-\d{4}-\d{2}\/)"/;

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
  agrave: 'à',
  egrave: 'è',
  eacute: 'é',
  igrave: 'ì',
  ograve: 'ò',
  ugrave: 'ù',
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

function text(raw: string, max: number): string | null {
  const clean = decode(raw.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (clean.length === 0 || clean.length > max) return null;
  if (/[\u0000-\u001f\u007f-\u009f<>]/.test(clean)) return null;
  return clean;
}

function day(d: string, month: string, y: string): IsoDay | null {
  const m = MONTHS.indexOf(month.toLowerCase()) + 1;
  try {
    return isoDay(`${y}-${String(m).padStart(2, '0')}-${d.padStart(2, '0')}`);
  } catch {
    return null;
  }
}

/** The season page linked from the theatres page, or null when the link is not there. */
export function seasonLink(html: string): string | null {
  const path = SEASON_LINK.exec(html)?.[1];
  return path ? `${SITE}${path}` : null;
}

/** The shows of one page, with their days from `from` on, in time order. */
export function parseShows(html: string, page: string, from: IsoDay): TheatreShow[] {
  const starts = [...html.matchAll(BLOCK_START)].map((m) => m.index);
  const shows: TheatreShow[] = [];
  for (const [i, start] of starts.entries()) {
    if (shows.length >= SHOWS_MAX) break;
    const block = html.slice(start, starts[i + 1] ?? html.length);
    // "Lo Schiaccianoci" with quotes around the whole title loses them; quotes inside a title stay
    const title = text(TITLE.exec(block)?.[1] ?? '', TITLE_MAX)?.replace(/^"([^"]+)"$/, '$1') ?? null;
    const paragraph = PARAGRAPH.exec(block)?.[1];
    if (title === null || paragraph === undefined || /annullat/i.test(title)) continue;
    const [place = '', ...lines] = paragraph.split(/<br\s*\/?>/i);
    const theatre: Theatre | null = /\bPTU\b/i.test(place) ? 'ptu' : /\bTAU\b/i.test(place) ? 'tau' : null;
    if (theatre === null) continue;
    const time = TIME.exec(paragraph);
    const hour = time ? Number(time[1]) : NaN;
    const minute = time ? Number((time[2] ?? '').replace(/o/gi, '0')) : NaN;
    const timed = hour <= 23 && minute <= 59;
    const dates: TheatreDate[] = [];
    for (const line of lines) {
      const [, d, month, y] = DAY.exec(line) ?? [];
      if (d === undefined || month === undefined || y === undefined) continue;
      const when = day(d, month, y);
      if (when === null || when < from) continue;
      const note = text(NOTE.exec(line)?.[1] ?? '', NOTE_MAX);
      dates.push({ at: timed ? romeInstant(when, hour, minute) : romeMidnight(when), timed, note });
      if (dates.length >= DATES_MAX) break;
    }
    if (dates.length === 0) continue;
    dates.sort((a, b) => a.at - b.at);
    const poster = POSTER.exec(block)?.[1];
    shows.push({ title, theatre, url: page, poster: poster ? `${SITE}${poster}` : null, dates });
  }
  return shows;
}

/** The shows of both theatres in the order of their first day. */
export function programme(pages: readonly TheatreShow[][], sources: string[], now: number): TheatreProgramme {
  const first = (show: TheatreShow): number => show.dates[0]?.at ?? 0;
  const shows = pages.flat().sort((a, b) => first(a) - first(b) || a.title.localeCompare(b.title));
  return { sources, checkedAt: now, shows };
}
