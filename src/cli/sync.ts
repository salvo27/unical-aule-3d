// One-off sync from the command line, same rules as the scheduled one.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { loadAppConfig } from '../config.js';
import { consoleLogger as log } from '../log.js';
import { ConfigStore, type Seed } from '../store/config-store.js';
import { SnapshotStore } from '../store/snapshot-store.js';
import { createPlannerApi } from '../planner/client.js';
import { SyncService } from '../sync/sync.js';
import { loadCampus } from '../campus.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function main(): Promise<void> {
  const env = loadAppConfig(process.env);
  const dataDir = resolve(ROOT, env.dataDir);
  const seed = JSON.parse(await readFile(join(ROOT, 'config', 'seed.json'), 'utf8')) as Seed;
  const campus = await loadCampus(join(ROOT, 'public', 'data', 'campus.geojson'));
  const config = await ConfigStore.open(join(dataDir, 'admin.json'), seed, campus.keys);
  const snapshots = await SnapshotStore.open(join(dataDir, 'snapshot.json'), log);
  const sync = new SyncService({ api: createPlannerApi(), config, snapshots, log });
  const summary = await sync.run('admin');
  if (!summary || summary.outcome !== 'completed') process.exitCode = 1;
}

main().catch(() => {
  log.error('sync_cli_failed');
  process.exitCode = 1;
});
