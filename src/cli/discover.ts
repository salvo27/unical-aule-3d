// Reads the configured source pages and lists new Planner calendars, named with their Planner title.
// --apply adds them; --relabel renames the calendars already configured with their Planner title.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { loadAppConfig } from '../config.js';
import { consoleLogger as log } from '../log.js';
import { ConfigStore, type Seed } from '../store/config-store.js';
import { addCalendar, renameCalendar } from '../domain/admin-config.js';
import { discover } from '../sync/discover.js';
import { plannerTitles } from '../sync/titles.js';
import { createPlannerApi } from '../planner/client.js';
import { loadCampus } from '../campus.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const relabel = process.argv.includes('--relabel');
  const env = loadAppConfig(process.env);
  const dataDir = resolve(ROOT, env.dataDir);
  const seed = JSON.parse(await readFile(join(ROOT, 'config', 'seed.json'), 'utf8')) as Seed;
  const campus = await loadCampus(join(ROOT, 'public', 'data', 'campus.geojson'));
  const config = await ConfigStore.open(join(dataDir, 'admin.json'), seed, campus.keys);
  const api = createPlannerApi();

  if (relabel) {
    const ids = config.current.calendars.map((c) => c.id);
    const titles = await plannerTitles(api, ids);
    await config.update((c) => [...titles].reduce((acc, [id, title]) => renameCalendar(acc, id, title), c));
    console.log(`renamed ${titles.size} of ${ids.length} calendars`);
  }

  const known = new Set<string>(config.current.calendars.map((c) => c.id));
  const result = await discover(config.current.sources);
  const fresh = result.found.filter((f) => !known.has(f.id));
  const titles = await plannerTitles(api, fresh.map((f) => f.id));
  const named = fresh.map((f) => ({ ...f, label: titles.get(f.id) ?? f.label }));
  for (const f of result.failures) console.log(`page not read (${f.failure}): ${f.source}`);
  for (const f of named) console.log(`${f.id}  ${f.label}`);
  console.log(`${named.length} new calendars on ${config.current.sources.length} pages`);
  if (!apply || named.length === 0) return;
  await config.update((c) => named.reduce((acc, f) => addCalendar(acc, f.id, f.label, Date.now()), c));
  console.log(`added ${named.length} calendars`);
}

main().catch((err: unknown) => {
  log.error('discover_cli_failed', { kind: err instanceof Error ? err.name : 'unknown' });
  process.exitCode = 1;
});
