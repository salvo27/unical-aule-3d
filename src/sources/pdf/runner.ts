// Port between the pdf adapter and the department layouts (profiles), plus the cache of the last good file per feed.
// A profile owns one section of config/pdf.json, its feeds (ref "<profile>:<key>"), discovery and layout.
import type { CalendarId, Label, SourceUrl } from '../../domain/primitives.js';
import type { Logger } from '../../log.js';
import type { FetchContext, SourceData, SourceFailure } from '../types.js';
import { getPdf, type HttpOptions, type Validators } from './client.js';
import { PdfError, type Finding } from './codes.js';
import type { Template } from './expand.js';
import type { Page } from './grid.js';
import type { ReadPdfOptions } from './poppler.js';

export interface PdfFeed {
  ref: string;
  id: CalendarId;
  label: Label;
}

export type Ready = { template: Template } | { failure: SourceFailure };

export interface ProfileDeps {
  http: HttpOptions;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
  pauseMs: number;
  readPdf: (bytes: Uint8Array, options?: ReadPdfOptions) => Promise<Page[]>;
}

export interface ProfileRunner {
  // Every feed of the profile gets a template or a failure; requests in sequence with a pause between them.
  prepare(): Promise<ReadonlyMap<string, Ready>>;
  expand(ref: string, template: Template, ctx: FetchContext): SourceData;
}

export interface ParsedProfile {
  key: string;
  feeds: readonly PdfFeed[];
  // Building names of the room table, checked against the campus map by the feed generator.
  buildings: readonly string[];
  start(deps: ProfileDeps): ProfileRunner;
}

export interface PdfProfile {
  key: string;
  parse(raw: unknown): ParsedProfile;
}

export interface PdfDocument {
  sha256: string;
  pages: Page[];
}

interface Cached<T> {
  url: SourceUrl;
  validators: Validators;
  sha256: string;
  value: T;
}

export interface PdfFiles<T> {
  load(feed: CalendarId, url: SourceUrl, parse: (doc: PdfDocument) => T): Promise<T>;
}

// Validators and the parsed value of the last good file per feed; never the file itself.
// A layout that draws its tables in another way passes its own reader options.
export function pdfFiles<T>(deps: ProfileDeps, read?: ReadPdfOptions): PdfFiles<T> {
  const cache = new Map<CalendarId, Cached<T>>();
  return {
    async load(feed, url, parse) {
      const cached = cache.get(feed);
      const same = cached && cached.url === url ? cached : null;
      const download = await getPdf(url, same ? same.validators : null, deps.http);
      if (download.status === 'not_modified') {
        if (!same) throw new PdfError('http_status');
        deps.log.info('pdf_file', { calendar: feed, status: 304 });
        return same.value;
      }
      if (same && same.sha256 === download.sha256) {
        cache.set(feed, { ...same, validators: download.validators });
        deps.log.info('pdf_file', { calendar: feed, status: 200, changed: false });
        return same.value;
      }
      const value = parse({ sha256: download.sha256, pages: await deps.readPdf(download.bytes, read) });
      cache.set(feed, { url, validators: download.validators, sha256: download.sha256, value });
      deps.log.info('pdf_file', { calendar: feed, status: 200, changed: true });
      return value;
    },
  };
}

const MAX_LOGGED = 50;

export function logFindings(log: Logger, event: string, calendar: CalendarId, findings: readonly Finding[]): void {
  for (const f of findings.slice(0, MAX_LOGGED)) log.warn(event, { calendar, code: f.code, where: f.where });
  if (findings.length > MAX_LOGGED) log.warn(`${event}s_cut`, { calendar, count: findings.length });
}
