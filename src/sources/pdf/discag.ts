// DISCAG profile: the "Orario delle lezioni" news page lists one PDF per course; the URL changes at every upload,
// so the links are found again at every run by their label. Section "discag" of config/pdf.json.
import { buildingKey, roomNameKey } from '../../domain/building.js';
import { feedId, roomMatchKey, syntheticRoomId } from '../../domain/ids.js';
import { sourceUrl, type CalendarId, type Label, type SourceUrl } from '../../domain/primitives.js';
import type { FetchContext } from '../types.js';
import { anchorsOf, getPage, htmlText } from './client.js';
import { pdfCode, PdfError, sourceFailure, type PdfCode } from './codes.js';
import {
  calendarOf,
  check,
  feedLabel,
  isRecord,
  keysOnly,
  pdfRef,
  PdfConfigError,
  plain,
  sha256Hex,
} from './config.js';
import { extractDiscag, type DiscagLayoutConfig, type Quirk } from './discag-layout.js';
import { expandTemplate, type CalendarConfig, type PdfRoom, type Template } from './expand.js';
import { logFindings, pdfFiles, type ParsedProfile, type PdfProfile, type ProfileDeps, type ProfileRunner, type Ready } from './runner.js';
import { norm } from './text.js';
import type { RoomPattern } from './validators.js';

export interface DiscagFeed {
  ref: string;
  id: CalendarId;
  label: Label;
  // Attachment label on the news page after norm(), without the leading "- " and the ".pdf" suffix.
  anchor: string;
  course: string;
  codes: ReadonlyMap<string, readonly number[]>;
}

export interface DiscagConfig {
  pageUrl: SourceUrl;
  pageTitle: string;
  attachments: RegExp;
  calendar: CalendarConfig;
  feeds: readonly DiscagFeed[];
  rooms: readonly RoomPattern<PdfRoom>[];
  quirks: readonly Quirk[];
}

const PAGE_URL = /^https:\/\/discag\.unical\.it\/contents\/news\/view\/(\d{1,7})-[a-z0-9-]{1,100}\/$/;
// Upper case letters, digits, '?' after a character and one final lookahead: no repetition, so no backtracking blowup.
const ROOM_PATTERN = /^(?:[A-Z0-9]\??){1,30}(?:\(\?=[A-Z0-9]{1,20}\))?$/;
const CUBE = /^\d{1,2}[A-D]{1,2}$/;
const ROOM_KEY = /^[a-z0-9]{1,100}$/;
const CAMPUS_KEY = /^[a-z0-9-]{1,80}$/;
// robots.txt of the unical.it hosts disallows *gAAAAAB*.
const ROBOTS_DISALLOWED = /gAAAAAB/;

function codesOf(value: unknown): Map<string, number[]> {
  if (!isRecord(value)) throw new PdfConfigError('feed_codes');
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 5) throw new PdfConfigError('feed_codes');
  const out = new Map<string, number[]>();
  for (const [code, years] of entries) {
    if (!/^\d{4}$/.test(code) || !Array.isArray(years) || years.length < 1 || years.length > 6) throw new PdfConfigError('feed_codes');
    if (years.some((y) => typeof y !== 'number' || !Number.isInteger(y) || y < 1 || y > 6) || new Set(years).size !== years.length) {
      throw new PdfConfigError('feed_codes');
    }
    out.set(code, years as number[]);
  }
  return out;
}

function feedOf(value: unknown): DiscagFeed {
  if (!isRecord(value)) throw new PdfConfigError('feed');
  keysOnly(value, ['ref', 'anchor', 'codes', 'course', 'label'], 'feed');
  const ref = pdfRef(value.ref, 'discag');
  const anchor = plain(value.anchor, 60, 'feed_anchor');
  const course = plain(value.course, 200, 'feed_course');
  if (norm(course) !== course) throw new PdfConfigError('feed_course');
  return { ref, id: feedId('pdf', ref), label: feedLabel(value.label), anchor: norm(anchor), course, codes: codesOf(value.codes) };
}

function roomOf(value: unknown): RoomPattern<PdfRoom> {
  if (!isRecord(value)) throw new PdfConfigError('room');
  keysOnly(value, ['pattern', 'name', 'building', 'cubes', 'bareCube'], 'room');
  const pattern = plain(value.pattern, 60, 'room_pattern');
  if (!ROOM_PATTERN.test(pattern)) throw new PdfConfigError('room_pattern');
  const name = plain(value.name, 100, 'room_name');
  const building = plain(value.building, 100, 'room_building');
  const bKey = buildingKey(building);
  const rKey = roomNameKey(name);
  if (!bKey || !CAMPUS_KEY.test(bKey)) throw new PdfConfigError('room_building');
  if (!ROOM_KEY.test(rKey)) throw new PdfConfigError('room_name');
  const matchKey = roomMatchKey(building, name);
  if (!matchKey) throw new PdfConfigError('room_building');
  if (!Array.isArray(value.cubes) || value.cubes.length > 5 || value.cubes.some((c) => typeof c !== 'string' || !CUBE.test(c))) {
    throw new PdfConfigError('room_cubes');
  }
  if (value.bareCube !== undefined && typeof value.bareCube !== 'boolean') throw new PdfConfigError('room_bare_cube');
  return {
    room: { name, building, matchKey, syntheticId: syntheticRoomId(bKey, rKey) },
    re: new RegExp(`^(?:${pattern})`),
    cubes: value.cubes as string[],
    polifunzionale: bKey === 'polifunzionale',
    bareCube: value.bareCube === true,
  };
}

function quirkOf(value: unknown): Quirk {
  if (!isRecord(value)) throw new PdfConfigError('quirk');
  keysOnly(value, ['sha256', 'page', 'code', 'note'], 'quirk');
  const page = value.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > 16) throw new PdfConfigError('quirk_page');
  if (value.code !== 'academic_year_mismatch') throw new PdfConfigError('quirk_code');
  plain(value.note, 200, 'quirk_note');
  return { sha256: sha256Hex(value.sha256), page, code: value.code };
}

export function parseDiscagConfig(raw: unknown): DiscagConfig {
  if (!isRecord(raw)) throw new PdfConfigError('discag');
  keysOnly(raw, ['pageUrl', 'pageTitle', 'academicYear', 'semester', 'semesters', 'closedDays', 'feeds', 'rooms', 'acceptedQuirks'], 'discag');
  const pageUrl = check('page_url', () => sourceUrl(raw.pageUrl));
  const news = PAGE_URL.exec(pageUrl);
  if (pageUrl !== raw.pageUrl || !news) throw new PdfConfigError('page_url');
  const pageTitle = norm(plain(raw.pageTitle, 200, 'page_title'));
  const calendar = calendarOf(raw);

  if (!Array.isArray(raw.feeds) || raw.feeds.length < 1 || raw.feeds.length > 20) throw new PdfConfigError('feeds');
  const feeds = raw.feeds.map(feedOf);
  if (new Set(feeds.map((f) => f.ref)).size !== feeds.length || new Set(feeds.map((f) => f.anchor)).size !== feeds.length) {
    throw new PdfConfigError('feed_duplicate');
  }

  if (!Array.isArray(raw.rooms) || raw.rooms.length < 1 || raw.rooms.length > 80) throw new PdfConfigError('rooms');
  const rooms = raw.rooms.map(roomOf);
  if (new Set(rooms.map((r) => r.re.source)).size !== rooms.length || new Set(rooms.map((r) => r.room.matchKey)).size !== rooms.length) {
    throw new PdfConfigError('room_duplicate');
  }

  if (!Array.isArray(raw.acceptedQuirks) || raw.acceptedQuirks.length > 20) throw new PdfConfigError('quirks');
  const quirks = raw.acceptedQuirks.map(quirkOf);
  return {
    pageUrl,
    pageTitle,
    attachments: new RegExp(`^https://discag\\.unical\\.it/media/publications_attachments/${news[1]}/[A-Za-z0-9._-]{1,120}\\.pdf$`),
    calendar,
    feeds,
    rooms,
    quirks,
  };
}

export type Link = { url: SourceUrl } | { code: Extract<PdfCode, 'discovery_missing' | 'discovery_ambiguous'> };

export interface Discovery {
  links: ReadonlyMap<string, Link>;
  unknown: number;
}

function attachmentUrl(href: string, cfg: DiscagConfig): SourceUrl | null {
  try {
    const url = sourceUrl(new URL(href, cfg.pageUrl).href);
    return cfg.attachments.test(url) && !ROBOTS_DISALLOWED.test(url) ? url : null;
  } catch {
    return null;
  }
}

// The page title must be the configured one (else the news moved to another semester); then exactly one
// attachment per course, found by its label. Unknown labels (such as the list of Teams links) are never downloaded.
export function findAttachments(html: string, cfg: DiscagConfig): Discovery {
  const h1 = [...html.matchAll(/<h1\b[^<>]{0,500}>([\s\S]{0,2000}?)<\/h1\s*>/gi)];
  const headings = html.match(/<h1\b/gi)?.length ?? 0;
  if (h1.length !== 1 || headings !== 1) throw new PdfError('bad_html');
  if (norm(htmlText(h1[0]![1] ?? '')) !== cfg.pageTitle) throw new PdfError('wrong_page_title');
  const byAnchor = new Map(cfg.feeds.map((f) => [f.anchor, f.ref]));
  const found = new Map<string, Set<SourceUrl>>(cfg.feeds.map((f) => [f.ref, new Set<SourceUrl>()]));
  const owners = new Map<SourceUrl, Set<string>>();
  let unknown = 0;
  for (const a of anchorsOf(html)) {
    const url = attachmentUrl(a.href, cfg);
    if (!url) continue;
    const label = norm(a.text.replace(/^-\s*/, '').replace(/\.pdf$/i, ''));
    const ref = byAnchor.get(label);
    if (!ref) {
      unknown += 1;
      continue;
    }
    found.get(ref)!.add(url);
    owners.set(url, (owners.get(url) ?? new Set()).add(ref));
  }
  const links = new Map<string, Link>();
  for (const [ref, urls] of found) {
    const [url] = [...urls];
    if (urls.size === 0 || !url) links.set(ref, { code: 'discovery_missing' });
    else if (urls.size > 1 || (owners.get(url)?.size ?? 0) > 1) links.set(ref, { code: 'discovery_ambiguous' });
    else links.set(ref, { url });
  }
  return { links, unknown };
}

function runner(cfg: DiscagConfig, deps: ProfileDeps): ProfileRunner {
  const files = pdfFiles<Template>(deps);
  const layout: DiscagLayoutConfig = { calendar: cfg.calendar, rooms: cfg.rooms, quirks: cfg.quirks };
  const { log } = deps;

  function failed(feed: DiscagFeed, err: unknown): Ready {
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
        discovery = findAttachments(await getPage(cfg.pageUrl, deps.http), cfg);
      } catch (err) {
        const code = pdfCode(err);
        log.warn('pdf_page_failed', { profile: 'discag', code: code ?? 'unexpected' });
        for (const f of cfg.feeds) out.set(f.ref, { failure: code ? sourceFailure(code) : 'unexpected' });
        return out;
      }
      if (discovery.unknown > 0) log.warn('pdf_warning', { profile: 'discag', code: 'unknown_attachment', count: discovery.unknown });
      for (const feed of cfg.feeds) {
        const link = discovery.links.get(feed.ref);
        if (!link || 'code' in link) {
          out.set(feed.ref, failed(feed, new PdfError(link ? link.code : 'discovery_missing')));
          continue;
        }
        await deps.sleep(deps.pauseMs);
        try {
          const template = await files.load(feed.id, link.url, (doc) => {
            let result;
            try {
              result = extractDiscag(doc.pages, feed, layout, doc.sha256);
            } catch (err) {
              // The hash is what an accepted quirk in config/pdf.json binds to.
              if (pdfCode(err) === 'academic_year_mismatch') log.warn('pdf_quirk_needed', { calendar: feed.id, sha256: doc.sha256 });
              throw err;
            }
            logFindings(log, 'pdf_warning', feed.id, result.warnings);
            if (result.unplaced.length > 0) {
              logFindings(log, 'pdf_cell_unplaced', feed.id, result.unplaced);
              throw new PdfError('unplaced_cells');
            }
            return { entries: result.entries };
          });
          out.set(feed.ref, { template });
        } catch (err) {
          out.set(feed.ref, failed(feed, err));
        }
      }
      return out;
    },

    expand(_ref: string, template: Template, ctx: FetchContext) {
      return expandTemplate(template, cfg.calendar, ctx);
    },
  };
}

export const discagProfile: PdfProfile = {
  key: 'discag',
  parse(raw: unknown): ParsedProfile {
    const cfg = parseDiscagConfig(raw);
    return {
      key: 'discag',
      feeds: cfg.feeds.map((f) => ({ ref: f.ref, id: f.id, label: f.label })),
      buildings: [...new Set(cfg.rooms.map((r) => r.room.building))],
      start: (deps) => runner(cfg, deps),
    };
  },
};
