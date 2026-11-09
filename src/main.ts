import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { loadAppConfig } from './config.js';
import { consoleLogger as log } from './log.js';
import { ConfigStore, type Seed } from './store/config-store.js';
import { SnapshotStore } from './store/snapshot-store.js';
import { createPlannerApi } from './planner/client.js';
import { SyncService } from './sync/sync.js';
import { startScheduler } from './sync/scheduler.js';
import { discover } from './sync/discover.js';
import { plannerTitles } from './sync/titles.js';
import { loadCampus } from './campus.js';
import { createSupabaseGateway } from './supabase/gateway.js';
import { OverridesService } from './availability/overrides.js';
import { loadStaticFiles } from './http/static.js';
import { createHandler } from './http/app.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function main(): Promise<void> {
  const env = loadAppConfig(process.env);
  const dataDir = resolve(ROOT, env.dataDir);
  const seed = JSON.parse(await readFile(join(ROOT, 'config', 'seed.json'), 'utf8')) as Seed;
  const campus = await loadCampus(join(ROOT, 'public', 'data', 'campus.geojson'));
  const config = await ConfigStore.open(join(dataDir, 'admin.json'), seed, campus.keys);
  const snapshots = await SnapshotStore.open(join(dataDir, 'snapshot.json'), log);
  const api = createPlannerApi();
  const sync = new SyncService({ api, config, snapshots, log });
  const gateway = env.supabase
    ? createSupabaseGateway({
        url: env.supabase.url,
        publishableKey: env.supabase.publishableKey,
        onUpstreamError: (fn, status, code) => log.error('supabase_failed', { fn, status, code }),
      })
    : null;
  const overrides = new OverridesService(gateway, log);
  const vendor = join(ROOT, 'node_modules', 'maplibre-gl', 'dist');
  const staticFiles = await loadStaticFiles(join(ROOT, 'public'), {
    '/vendor/maplibre-gl.mjs': join(vendor, 'maplibre-gl.mjs'),
    '/vendor/maplibre-gl-worker.mjs': join(vendor, 'maplibre-gl-worker.mjs'),
    '/vendor/maplibre-gl.css': join(vendor, 'maplibre-gl.css'),
    '/vendor/supabase.js': join(ROOT, 'node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js'),
    '/vendor/licenses.txt': join(ROOT, 'dist', 'licenses.txt'),
  });

  if (!gateway) log.warn('accounts_disabled', { reason: 'SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY not set' });

  const handler = createHandler({
    config,
    snapshots,
    sync,
    campus,
    staticFiles,
    discover: async (sources) => {
      const result = await discover(sources);
      const titles = await plannerTitles(api, result.found.map((f) => f.id));
      return { ...result, found: result.found.map((f) => ({ ...f, label: titles.get(f.id) ?? f.label })) };
    },
    supabase: env.supabase,
    gateway,
    overrides,
    log,
    now: Date.now,
    staleAfterMs: env.staleAfterMs,
    production: env.production,
  });
  const server = createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  overrides.start();
  const stopScheduler = startScheduler({ sync, snapshots, hours: env.syncHours, staleAfterMs: env.staleAfterMs, log });

  server.listen(env.port, env.host, () => log.info('server_started', { host: env.host, port: env.port }));
  const shutdown = () => {
    stopScheduler();
    overrides.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err: unknown) => {
  log.error('startup_failed', { kind: err instanceof Error ? err.name : 'unknown', detail: err instanceof Error ? err.message : '' });
  process.exitCode = 1;
});
