// DIMES source: the weekly plan embedded in the timetable app page, one feed.
// prepare() makes the one conditional GET and builds the plan; fetch() only expands it on the run window.
import { romeDay } from '../availability/time.js';
import { consoleLogger, type Logger } from '../log.js';
import { SourceError, type SourceAdapter } from './types.js';
import { getPage, type HttpOptions, type Validators } from './dimes/client.js';
import { dimesCode, sourceFailure } from './dimes/codes.js';
import { DimesConfigError, loadDimesConfig, type DimesConfig } from './dimes/config.js';
import { readDataset } from './dimes/dataset.js';
import { expandPlan } from './dimes/expand.js';
import { extractDataset } from './dimes/extract.js';
import { buildPlan, type WeeklyPlan } from './dimes/plan.js';

export interface DimesAdapterOptions {
  fetchImpl?: typeof fetch;
  config?: () => Promise<DimesConfig>;
  log?: Logger;
  now?: () => number;
  timeoutMs?: number;
  retryMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

// Validators and the plan of the last good response; never the page or the data it embeds.
interface Cached {
  validators: Validators;
  sha256: string;
  plan: WeeklyPlan;
}

export function dimesAdapter(options: DimesAdapterOptions = {}): SourceAdapter {
  const log = options.log ?? consoleLogger;
  const now = options.now ?? Date.now;
  const http: HttpOptions = {
    fetchImpl: options.fetchImpl ?? fetch,
    timeoutMs: options.timeoutMs ?? 30_000,
    retryMs: options.retryMs ?? 60_000,
    sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))),
    onRetry: () => log.warn('dimes_retry'),
  };
  let config: DimesConfig | null = null;
  let cache: Cached | null = null;
  let current: WeeklyPlan | null = null;

  async function loadConfig(): Promise<DimesConfig> {
    if (config) return config;
    try {
      config = await (options.config ?? (() => loadDimesConfig()))();
    } catch (err) {
      log.error('dimes_config_invalid', { field: err instanceof DimesConfigError ? err.field : 'unexpected' });
      throw new SourceError('unexpected');
    }
    return config;
  }

  function failed(err: unknown, fields: { calendar: string } | Record<string, never> = {}): SourceError {
    if (err instanceof SourceError) return err;
    const code = dimesCode(err);
    log.warn('dimes_failed', { ...fields, code: code ?? 'unexpected' });
    return new SourceError(code ? sourceFailure(code) : 'unexpected');
  }

  async function load(cfg: DimesConfig): Promise<WeeklyPlan> {
    const download = await getPage(cfg.url, cache?.validators ?? null, http);
    if (download.status === 'not_modified') {
      if (!cache) throw new SourceError('unexpected');
      log.info('dimes_page', { status: 304 });
      return cache.plan;
    }
    if (cache && cache.sha256 === download.sha256) {
      cache = { ...cache, validators: download.validators };
      log.info('dimes_page', { status: 200, changed: false });
      return cache.plan;
    }
    const plan = buildPlan(readDataset(extractDataset(download.html), cfg), cfg);
    cache = { validators: download.validators, sha256: download.sha256, plan };
    log.info('dimes_page', { status: 200, changed: true });
    log.info('dimes_plan', {
      hours: plan.hours,
      blocks: plan.blocks.length,
      skipped: plan.skipped,
      ignored: plan.ignored,
      fallbackRooms: plan.fallbackRooms,
    });
    return plan;
  }

  return {
    kind: 'dimes',

    async prepare() {
      current = null;
      const cfg = await loadConfig();
      try {
        current = await load(cfg);
      } catch (err) {
        throw failed(err);
      }
    },

    async fetch(feed, ctx) {
      if (feed.source !== 'dimes' || config === null || current === null) throw new SourceError('unexpected');
      // Only the configured app: a feed added by hand with another URL is never requested.
      if (feed.id !== config.feedId || feed.ref !== config.url) {
        log.warn('dimes_failed', { calendar: feed.id, code: 'feed_unknown' });
        throw new SourceError('unexpected');
      }
      try {
        const out = expandPlan(current, config, ctx, romeDay(now()));
        log.info('dimes_rooms', { calendar: feed.id, ...out.rooms });
        return out.data;
      } catch (err) {
        throw failed(err, { calendar: feed.id });
      }
    },
  };
}

export const adapter: SourceAdapter | null = dimesAdapter();
