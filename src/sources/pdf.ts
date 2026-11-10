// PDF source: timetables published as PDF files by departments without Planner calendars, one feed per file.
// prepare() runs every department layout (profile) in sequence; fetch() only expands a template on the run window.
import { consoleLogger, type Logger } from '../log.js';
import { SourceError, type SourceAdapter } from './types.js';
import { pdfCode, sourceFailure } from './pdf/codes.js';
import { loadPdfConfig, PdfConfigError } from './pdf/config.js';
import type { Page } from './pdf/grid.js';
import { readPdf, type ReadPdfOptions } from './pdf/poppler.js';
import { PROFILES } from './pdf/profiles.js';
import type { ParsedProfile, ProfileRunner, Ready } from './pdf/runner.js';

export interface PdfAdapterOptions {
  fetchImpl?: typeof fetch;
  config?: () => Promise<readonly ParsedProfile[]>;
  log?: Logger;
  pauseMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  readPdf?: (bytes: Uint8Array, options?: ReadPdfOptions) => Promise<Page[]>;
}

interface Started {
  profile: ParsedProfile;
  runner: ProfileRunner;
}

export function pdfAdapter(options: PdfAdapterOptions = {}): SourceAdapter {
  const log = options.log ?? consoleLogger;
  const deps = {
    http: { fetchImpl: options.fetchImpl ?? fetch, timeoutMs: options.timeoutMs ?? 30_000 },
    log,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    pauseMs: options.pauseMs ?? 2_000,
    readPdf: options.readPdf ?? ((bytes: Uint8Array, read?: ReadPdfOptions) => readPdf(bytes, read)),
  };
  // Runners keep the validators and templates of the last good files between runs of the same process.
  let started: Started[] | null = null;
  let current: Map<string, Ready> | null = null;

  async function start(): Promise<Started[]> {
    if (started) return started;
    let profiles: readonly ParsedProfile[];
    try {
      profiles = await (options.config ?? (() => loadPdfConfig(PROFILES)))();
    } catch (err) {
      log.error('pdf_config_invalid', { field: err instanceof PdfConfigError ? err.field : 'unexpected' });
      throw new SourceError('unexpected');
    }
    started = profiles.map((profile) => ({ profile, runner: profile.start(deps) }));
    return started;
  }

  return {
    kind: 'pdf',

    async prepare() {
      current = null;
      const all = await start();
      const out = new Map<string, Ready>();
      for (const { profile, runner } of all) {
        try {
          for (const [ref, ready] of await runner.prepare()) out.set(ref, ready);
        } catch (err) {
          const code = pdfCode(err);
          log.warn('pdf_page_failed', { profile: profile.key, code: code ?? 'unexpected' });
          for (const f of profile.feeds) out.set(f.ref, { failure: code ? sourceFailure(code) : 'unexpected' });
        }
      }
      current = out;
    },

    async fetch(feed, ctx) {
      if (feed.source !== 'pdf' || current === null || started === null) throw new SourceError('unexpected');
      const owner = started.find((s) => s.profile.feeds.some((f) => f.ref === feed.ref && f.id === feed.id));
      const ready = owner && feed.ref !== null ? current.get(feed.ref) : undefined;
      if (!owner || !ready || feed.ref === null) {
        log.warn('pdf_feed_failed', { calendar: feed.id, code: 'feed_unknown', where: '' });
        throw new SourceError('unexpected');
      }
      if ('failure' in ready) throw new SourceError(ready.failure);
      try {
        return owner.runner.expand(feed.ref, ready.template, ctx);
      } catch (err) {
        const code = pdfCode(err);
        log.warn('pdf_feed_failed', { calendar: feed.id, code: code ?? 'unexpected', where: '' });
        throw new SourceError(code ? sourceFailure(code) : 'unexpected');
      }
    },
  };
}

export const adapter: SourceAdapter | null = pdfAdapter();
