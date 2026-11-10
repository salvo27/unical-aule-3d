// DIAm source: weekly timetables published as two xlsx files, one feed per sheet (sources/diam-xlsx spec).
// prepare() reads the index page and both files in sequence; fetch() only expands a sheet on the run window.
import { consoleLogger, type Logger } from '../log.js';
import type { SourceUrl } from '../domain/primitives.js';
import { SourceError, type SourceAdapter, type SourceFailure } from './types.js';
import { getPage, findFileLinks, getWorkbook, type FileLinks, type HttpOptions, type Validators } from './xlsx/client.js';
import { sourceFailure, xlsxCode, type Finding } from './xlsx/codes.js';
import { DiamConfigError, loadDiamConfig, type DiamConfig, type DiamSheet } from './xlsx/config.js';
import { expandTemplate } from './xlsx/expand.js';
import { parseWorkbook, type ParsedWorkbook, type Template } from './xlsx/layout.js';
import { readXlsx } from './xlsx/reader.js';
import { FILE_KINDS, type DiamFileKind } from './xlsx/text.js';

export interface XlsxAdapterOptions {
  fetchImpl?: typeof fetch;
  config?: () => Promise<DiamConfig>;
  log?: Logger;
  pauseMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface CachedFile {
  url: SourceUrl;
  validators: Validators;
  sha256: string;
  workbook: ParsedWorkbook;
}

type Ready = { template: Template } | { failure: SourceFailure };

const MAX_LOGGED_WARNINGS = 50;

export function xlsxAdapter(options: XlsxAdapterOptions = {}): SourceAdapter {
  const log = options.log ?? consoleLogger;
  const pauseMs = options.pauseMs ?? 2_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const http: HttpOptions = { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? 30_000 };
  // Validators and parsed templates of the last good response per file; never the raw file.
  const cache = new Map<DiamFileKind, CachedFile>();
  let config: DiamConfig | null = null;
  let current: Map<string, Ready> | null = null;

  async function loadConfig(): Promise<DiamConfig> {
    if (config) return config;
    try {
      config = await (options.config ?? (() => loadDiamConfig()))();
    } catch (err) {
      log.error('xlsx_config_invalid', { field: err instanceof DiamConfigError ? err.field : 'unexpected' });
      throw new SourceError('unexpected');
    }
    return config;
  }

  function logFindings(findings: readonly Finding[], fields: { calendar: string } | { file: DiamFileKind }): void {
    for (const f of findings.slice(0, MAX_LOGGED_WARNINGS)) log.warn('xlsx_warning', { ...fields, code: f.code, where: f.where });
    if (findings.length > MAX_LOGGED_WARNINGS) log.warn('xlsx_warnings_cut', { ...fields, count: findings.length });
  }

  async function loadFile(file: DiamFileKind, url: SourceUrl, cfg: DiamConfig): Promise<ParsedWorkbook> {
    const cached = cache.get(file);
    const same = cached && cached.url === url ? cached : null;
    const download = await getWorkbook(url, same ? same.validators : null, http);
    if (download.status === 'not_modified' && same) {
      log.info('xlsx_file', { file, status: 304 });
      return same.workbook;
    }
    if (download.status === 'not_modified') throw new SourceError('unexpected');
    if (same && same.sha256 === download.sha256) {
      cache.set(file, { ...same, validators: download.validators });
      log.info('xlsx_file', { file, status: 200, changed: false });
      return same.workbook;
    }
    const workbook = parseWorkbook(file, readXlsx(download.bytes), cfg);
    logFindings(workbook.warnings, { file });
    for (const sheet of cfg.sheets) {
      const outcome = workbook.sheets.get(sheet.ref);
      if (sheet.file === file && outcome && 'template' in outcome) logFindings(outcome.warnings, { calendar: sheet.id });
    }
    cache.set(file, { url, validators: download.validators, sha256: download.sha256, workbook });
    log.info('xlsx_file', { file, status: 200, changed: true });
    return workbook;
  }

  function pageFailure(err: unknown): SourceError {
    const code = xlsxCode(err);
    log.warn('xlsx_page_failed', { code: code ?? 'unexpected' });
    return new SourceError(code ? sourceFailure(code) : 'unexpected');
  }

  return {
    kind: 'xlsx',

    async prepare() {
      current = null;
      const cfg = await loadConfig();
      let links: FileLinks;
      try {
        links = findFileLinks(await getPage(cfg.pageUrl, http), cfg.pageUrl);
      } catch (err) {
        throw pageFailure(err);
      }
      const out = new Map<string, Ready>();
      for (const file of FILE_KINDS) {
        const sheets: DiamSheet[] = cfg.sheets.filter((s) => s.file === file);
        if (sheets.length === 0) continue;
        await sleep(pauseMs);
        try {
          const workbook = await loadFile(file, links[file], cfg);
          for (const sheet of sheets) {
            const outcome = workbook.sheets.get(sheet.ref) ?? { failure: 'sheet_missing' as const };
            if ('template' in outcome) {
              out.set(sheet.ref, { template: outcome.template });
            } else {
              log.warn('xlsx_sheet_failed', { calendar: sheet.id, code: outcome.failure });
              out.set(sheet.ref, { failure: sourceFailure(outcome.failure) });
            }
          }
          const page = links.page;
          if (page && workbook.semester !== null && (page.semester !== workbook.semester || page.academicYear !== cfg.academicYear)) {
            log.warn('xlsx_warning', { file, code: 'page_semester_mismatch', where: '' });
          }
        } catch (err) {
          const code = xlsxCode(err);
          log.warn('xlsx_file_failed', { file, code: code ?? 'unexpected' });
          for (const sheet of sheets) out.set(sheet.ref, { failure: code ? sourceFailure(code) : 'unexpected' });
        }
      }
      current = out;
    },

    async fetch(feed, ctx) {
      if (feed.source !== 'xlsx' || current === null || config === null) throw new SourceError('unexpected');
      const sheet = config.sheets.find((s) => s.ref === feed.ref && s.id === feed.id);
      const ready = sheet ? current.get(sheet.ref) : undefined;
      if (!sheet || !ready) {
        log.warn('xlsx_sheet_failed', { calendar: feed.id, code: 'feed_unknown' });
        throw new SourceError('unexpected');
      }
      if ('failure' in ready) throw new SourceError(ready.failure);
      try {
        return expandTemplate(ready.template, sheet, config, ctx);
      } catch (err) {
        const code = xlsxCode(err);
        log.warn('xlsx_sheet_failed', { calendar: feed.id, code: code ?? 'unexpected' });
        throw new SourceError(code ? sourceFailure(code) : 'unexpected');
      }
    },
  };
}

export const adapter: SourceAdapter | null = xlsxAdapter();
