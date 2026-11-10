// DiSU profile: the "Orario delle lezioni" index links one news per semester, the news links one PDF per course,
// class or curriculum. Every upload changes the URL, so the links are found again at every run. Section "disu" of
// config/pdf.json. Two phases: the layout of every file, then the cells, whose titles may come from another file.
import { buildingKey, roomNameKey } from '../../domain/building.js';
import { feedId, roomMatchKey, syntheticRoomId } from '../../domain/ids.js';
import { isoDay, sourceUrl, type CalendarId, type Label, type SourceUrl } from '../../domain/primitives.js';
import { courseWithLevel, type DegreeLevel } from '../level.js';
import type { FetchContext } from '../types.js';
import { anchorsOf, getPage, htmlText } from './client.js';
import { pdfCode, PdfError, sourceFailure, type PdfCode } from './codes.js';
import { calendarOf, check, feedLabel, isRecord, keysOnly, pdfRef, PdfConfigError, plain } from './config.js';
import {
  disuRules,
  disuTemplate,
  readDisuFile,
  type Candidate,
  type DisuFile,
  type DisuGridSpec,
  type DisuRooms,
  type Suspension,
} from './disu-layout.js';
import { expandTemplate, type CalendarConfig, type PdfRoom } from './expand.js';
import { logFindings, pdfFiles, type ParsedProfile, type PdfProfile, type ProfileDeps, type ProfileRunner, type Ready } from './runner.js';
import { norm } from './text.js';

export type Level = 'LT' | 'LM';
const DEGREE: Readonly<Record<Level, DegreeLevel>> = { LT: 'triennale', LM: 'magistrale' };

export interface DisuFeed {
  ref: string;
  id: CalendarId;
  label: Label;
  file: RegExp;
  level: Level;
  degree: DegreeLevel;
  header: string;
  duration: number;
  course: string;
  grids: readonly DisuGridSpec[];
}

export interface DisuConfig {
  indexUrl: SourceUrl;
  newsTitle: string;
  newsPath: RegExp;
  fileUrl: RegExp;
  calendar: CalendarConfig;
  suspensions: readonly Suspension[];
  feeds: readonly DisuFeed[];
  rooms: DisuRooms;
  buildings: readonly string[];
}

const INDEX_URL = /^https:\/\/disu\.unical\.it\/[a-z0-9/-]{1,200}\/$/;
const NEWS_BASE = '/didattica/offerta-formativa/orario-lezioni/contents/news/view/';
const SLUG = /^[a-z0-9-]{1,100}$/;
const PREFIX = /^(?:[A-Za-z0-9]{1,20}_){1,8}$/;
const STEM = /^[A-Za-z0-9]{1,20}(?:_[A-Za-z0-9]{1,20}){0,6}$/;
const REF_KEY = /^disu:[a-z0-9-]{1,40}$/;
const GRID = /^([1-6])(?:\|(.{1,140}))?$/;
const ALIAS = /^[A-Z0-9]{1,40}$/;
const ROOM_KEY = /^[a-z0-9]{1,100}$/;
const CAMPUS_KEY = /^[a-z0-9-]{1,80}$/;
// robots.txt of the unical.it hosts disallows *gAAAAAB*.
const ROBOTS_DISALLOWED = /gAAAAAB/;

function level(value: unknown, field: string): Level {
  if (value !== 'LT' && value !== 'LM') throw new PdfConfigError(field);
  return value;
}

function years(value: unknown, field: string, max: number): number[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) throw new PdfConfigError(field);
  if (value.some((y) => typeof y !== 'number' || !Number.isInteger(y) || y < 1 || y > max) || new Set(value).size !== value.length) {
    throw new PdfConfigError(field);
  }
  return value as number[];
}

function suspensionOf(value: unknown, calendar: CalendarConfig): Suspension {
  if (!isRecord(value)) throw new PdfConfigError('suspension');
  keysOnly(value, ['first', 'last', 'level', 'years'], 'suspension');
  const first = check('suspension', () => isoDay(value.first));
  const last = check('suspension', () => isoDay(value.last));
  if (last < first || first < calendar.semesters[1].first || last > calendar.semesters[2].last) throw new PdfConfigError('suspension');
  return { first, last, level: level(value.level, 'suspension'), years: years(value.years, 'suspension', 6) };
}

function gridOf(value: unknown, duration: number): DisuGridSpec {
  if (typeof value !== 'string' || value.length > 150) throw new PdfConfigError('feed_grids');
  const m = GRID.exec(value);
  if (!m || Number(m[1]) > duration) throw new PdfConfigError('feed_grids');
  return { year: Number(m[1]), curriculum: m[2] === undefined ? null : plain(m[2], 140, 'feed_grids') };
}

function feedOf(value: unknown, prefix: string): DisuFeed {
  if (!isRecord(value)) throw new PdfConfigError('feed');
  keysOnly(value, ['ref', 'stem', 'level', 'duration', 'header', 'course', 'grids', 'label'], 'feed');
  const ref = pdfRef(value.ref, 'disu');
  if (!REF_KEY.test(ref)) throw new PdfConfigError('feed_ref');
  const stem = plain(value.stem, 140, 'feed_stem');
  if (!STEM.test(stem)) throw new PdfConfigError('feed_stem');
  const duration = value.duration;
  if (typeof duration !== 'number' || !Number.isInteger(duration) || duration < 1 || duration > 6) throw new PdfConfigError('feed_duration');
  const course = plain(value.course, 200, 'feed_course');
  if (norm(course) !== course) throw new PdfConfigError('feed_course');
  const feedLevel = level(value.level, 'feed_level');
  const degree = DEGREE[feedLevel];
  if (courseWithLevel(course, degree) === null) throw new PdfConfigError('feed_course');
  if (!Array.isArray(value.grids) || value.grids.length < 1 || value.grids.length > 8) throw new PdfConfigError('feed_grids');
  const grids = value.grids.map((g) => gridOf(g, duration));
  const gridKeys = grids.map((g) => `${g.year}|${norm(g.curriculum ?? '')}`);
  if (new Set(gridKeys).size !== gridKeys.length) throw new PdfConfigError('feed_grids');
  // A curriculum grid stores "<course> - <curriculum> (<level>)", which must fit the 200 characters of a course.
  if (grids.some((g) => g.curriculum !== null && courseWithLevel(`${course} - ${g.curriculum}`, degree) === null)) {
    throw new PdfConfigError('feed_grids');
  }
  return {
    ref,
    id: feedId('pdf', ref),
    label: feedLabel(value.label),
    // The CMS adds a short suffix at every upload: "_XepjXh4", "_3" or nothing.
    file: new RegExp(`^${prefix}${stem}(?:_[A-Za-z0-9]{1,8})?\\.pdf$`),
    level: feedLevel,
    degree,
    header: plain(value.header, 200, 'feed_header'),
    duration,
    course,
    grids,
  };
}

function roomOf(value: unknown): { aliases: string[]; room: PdfRoom } {
  if (!isRecord(value)) throw new PdfConfigError('room');
  keysOnly(value, ['aliases', 'name', 'building'], 'room');
  const aliases = value.aliases;
  if (!Array.isArray(aliases) || aliases.length < 1 || aliases.length > 6 || aliases.some((a) => typeof a !== 'string' || !ALIAS.test(a))) {
    throw new PdfConfigError('room_aliases');
  }
  const name = plain(value.name, 100, 'room_name');
  const building = plain(value.building, 100, 'room_building');
  const bKey = buildingKey(building);
  const rKey = roomNameKey(name);
  if (!bKey || !CAMPUS_KEY.test(bKey)) throw new PdfConfigError('room_building');
  if (!ROOM_KEY.test(rKey)) throw new PdfConfigError('room_name');
  const matchKey = roomMatchKey(building, name);
  if (!matchKey) throw new PdfConfigError('room_building');
  return { aliases: aliases as string[], room: { name, building, matchKey, syntheticId: syntheticRoomId(bKey, rKey) } };
}

export function parseDisuConfig(raw: unknown): DisuConfig {
  if (!isRecord(raw)) throw new PdfConfigError('disu');
  keysOnly(
    raw,
    ['indexUrl', 'newsTitle', 'newsSlug', 'filePrefix', 'academicYear', 'semester', 'semesters', 'closedDays', 'suspensions', 'feeds', 'rooms'],
    'disu',
  );
  const indexUrl = check('index_url', () => sourceUrl(raw.indexUrl));
  if (indexUrl !== raw.indexUrl || !INDEX_URL.test(indexUrl)) throw new PdfConfigError('index_url');
  const newsTitle = plain(raw.newsTitle, 200, 'news_title').replace(/\s+/g, ' ');
  const slug = plain(raw.newsSlug, 100, 'news_slug');
  if (!SLUG.test(slug)) throw new PdfConfigError('news_slug');
  const prefix = plain(raw.filePrefix, 100, 'file_prefix');
  if (!PREFIX.test(prefix)) throw new PdfConfigError('file_prefix');
  const calendar = calendarOf(raw);

  if (!Array.isArray(raw.suspensions) || raw.suspensions.length > 10) throw new PdfConfigError('suspensions');
  const suspensions = raw.suspensions.map((s) => suspensionOf(s, calendar));

  if (!Array.isArray(raw.feeds) || raw.feeds.length < 1 || raw.feeds.length > 40) throw new PdfConfigError('feeds');
  const feeds = raw.feeds.map((f) => feedOf(f, prefix));
  if (new Set(feeds.map((f) => f.ref)).size !== feeds.length) throw new PdfConfigError('feed_duplicate');
  // No file name of one feed may be read as the file of another, with or without the upload suffix.
  const stems = (raw.feeds as Record<string, unknown>[]).map((f) => String(f.stem));
  feeds.forEach((f, i) => {
    stems.forEach((s, j) => {
      if (i !== j && f.file.test(`${prefix}${s}.pdf`)) throw new PdfConfigError('feed_stem');
    });
  });

  if (!Array.isArray(raw.rooms) || raw.rooms.length < 1 || raw.rooms.length > 80) throw new PdfConfigError('rooms');
  const parsedRooms = raw.rooms.map(roomOf);
  const rooms = new Map<string, PdfRoom>();
  for (const r of parsedRooms) {
    for (const a of r.aliases) {
      if (rooms.has(a)) throw new PdfConfigError('room_duplicate');
      rooms.set(a, r.room);
    }
  }
  if (new Set(parsedRooms.map((r) => r.room.matchKey)).size !== parsedRooms.length) throw new PdfConfigError('room_duplicate');
  return {
    indexUrl,
    newsTitle,
    newsPath: new RegExp(`^${NEWS_BASE}\\d{1,7}-${slug}/$`),
    fileUrl: new RegExp(`^https://www\\.unical\\.it/media/medias/20\\d\\d/${prefix}[A-Za-z0-9_]{1,80}\\.pdf$`),
    calendar,
    suspensions,
    feeds,
    rooms,
    buildings: [...new Set(parsedRooms.map((r) => r.room.building))],
  };
}

// ---------- discovery ----------

function resolved(href: string, base: SourceUrl): URL | null {
  try {
    const url = new URL(href, base);
    if (url.protocol !== 'https:' || url.port !== '' || url.username || url.password || url.search || ROBOTS_DISALLOWED.test(url.href)) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

// Exactly one news of the index, by path and by link text; the link shows up twice (list and side box).
export function findNews(html: string, cfg: DisuConfig): SourceUrl {
  const urls = new Set<SourceUrl>();
  for (const a of anchorsOf(html)) {
    if (a.text !== cfg.newsTitle) continue;
    const url = resolved(a.href, cfg.indexUrl);
    if (url && url.hostname === 'disu.unical.it' && cfg.newsPath.test(url.pathname)) urls.add(sourceUrl(url.href));
  }
  const [only] = [...urls];
  if (!only) throw new PdfError('discovery_missing');
  if (urls.size > 1) throw new PdfError('discovery_ambiguous');
  return only;
}

export type Link = { url: SourceUrl } | { code: Extract<PdfCode, 'discovery_missing' | 'discovery_ambiguous'> };

export interface Discovery {
  links: ReadonlyMap<string, Link>;
  extra: number;
}

// The news must still be the configured one; then exactly one PDF per feed, by file name. A PDF that fits no
// feed is counted for the admin and never downloaded.
export function findFiles(html: string, newsUrl: SourceUrl, cfg: DisuConfig): Discovery {
  const h1 = [...html.matchAll(/<h1\b[^<>]{0,500}>([\s\S]{0,2000}?)<\/h1\s*>/gi)];
  const headings = html.match(/<h1\b/gi)?.length ?? 0;
  if (h1.length !== 1 || headings !== 1) throw new PdfError('bad_html');
  if (htmlText(h1[0]![1] ?? '') !== cfg.newsTitle) throw new PdfError('wrong_page_title');
  const found = new Map<string, Set<SourceUrl>>(cfg.feeds.map((f) => [f.ref, new Set<SourceUrl>()]));
  const owners = new Map<SourceUrl, number>();
  let extra = 0;
  const seen = new Set<SourceUrl>();
  for (const a of anchorsOf(html)) {
    const url = resolved(a.href, newsUrl);
    if (!url || !cfg.fileUrl.test(url.href)) continue;
    const href = sourceUrl(url.href);
    if (seen.has(href)) continue;
    seen.add(href);
    const name = url.pathname.slice(url.pathname.lastIndexOf('/') + 1);
    const feeds = cfg.feeds.filter((f) => f.file.test(name));
    if (feeds.length === 0) extra += 1;
    for (const f of feeds) found.get(f.ref)!.add(href);
    owners.set(href, feeds.length);
  }
  const links = new Map<string, Link>();
  for (const [ref, urls] of found) {
    const [url] = [...urls];
    if (!url) links.set(ref, { code: 'discovery_missing' });
    else if (urls.size > 1 || (owners.get(url) ?? 0) > 1) links.set(ref, { code: 'discovery_ambiguous' });
    else links.set(ref, { url });
  }
  return { links, extra };
}

// ---------- runner ----------

function runner(cfg: DisuConfig, deps: ProfileDeps): ProfileRunner {
  const files = pdfFiles<DisuFile>(deps, { parseRules: (svg) => disuRules(svg) });
  const { log } = deps;
  const semester = cfg.calendar.semesters[cfg.calendar.semester];

  function failed(feed: DisuFeed, err: unknown): Ready {
    const code = pdfCode(err) ?? 'unexpected';
    const where = err instanceof PdfError ? err.where : '';
    log.warn('pdf_feed_failed', { calendar: feed.id, code, where });
    return { failure: code === 'unexpected' ? 'unexpected' : sourceFailure(code) };
  }

  return {
    async prepare(): Promise<ReadonlyMap<string, Ready>> {
      const out = new Map<string, Ready>();
      let discovery: Discovery;
      try {
        const news = findNews(await getPage(cfg.indexUrl, deps.http), cfg);
        await deps.sleep(deps.pauseMs);
        discovery = findFiles(await getPage(news, deps.http), news, cfg);
      } catch (err) {
        const code = pdfCode(err);
        log.warn('pdf_page_failed', { profile: 'disu', code: code ?? 'unexpected' });
        for (const f of cfg.feeds) out.set(f.ref, { failure: code ? sourceFailure(code) : 'unexpected' });
        return out;
      }
      if (discovery.extra > 0) log.warn('pdf_warning', { profile: 'disu', code: 'discovery_extra', count: discovery.extra });

      const read = new Map<string, DisuFile>();
      for (const feed of cfg.feeds) {
        const link = discovery.links.get(feed.ref);
        if (!link || 'code' in link) {
          out.set(feed.ref, failed(feed, new PdfError(link ? link.code : 'discovery_missing')));
          continue;
        }
        await deps.sleep(deps.pauseMs);
        try {
          read.set(feed.ref, await files.load(feed.id, link.url, (doc) => readDisuFile(doc.pages, feed, cfg.rooms)));
        } catch (err) {
          out.set(feed.ref, failed(feed, err));
        }
      }

      // Only files read in this run lend their titles: a failed file makes the cells that need it unplaced.
      for (const feed of cfg.feeds) {
        const file = read.get(feed.ref);
        if (!file) continue;
        const others: Candidate[] = [];
        for (const [ref, f] of read) if (ref !== feed.ref) others.push(...f.candidates);
        try {
          const result = disuTemplate(file, others, { feedId: feed.id, level: feed.level, semester, suspensions: cfg.suspensions });
          logFindings(log, 'pdf_warning', feed.id, result.warnings);
          if (result.unplaced.length > 0) {
            logFindings(log, 'pdf_cell_unplaced', feed.id, result.unplaced);
            throw new PdfError('unplaced_cells');
          }
          out.set(feed.ref, { template: { entries: result.entries } });
        } catch (err) {
          out.set(feed.ref, failed(feed, err));
        }
      }
      return out;
    },

    expand(_ref: string, template, ctx: FetchContext) {
      return expandTemplate(template, cfg.calendar, ctx);
    },
  };
}

export const disuProfile: PdfProfile = {
  key: 'disu',
  parse(raw: unknown): ParsedProfile {
    const cfg = parseDisuConfig(raw);
    return {
      key: 'disu',
      feeds: cfg.feeds.map((f) => ({ ref: f.ref, id: f.id, label: f.label })),
      buildings: cfg.buildings,
      start: (deps) => runner(cfg, deps),
    };
  },
};
