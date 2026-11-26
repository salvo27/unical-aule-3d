// Reads the canteen menu files of the university and stores them through aule_sync.menu_put.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { consoleLogger as log } from '../log.js';
import { dbSettings, EnvError, type DbSettings } from '../settings.js';
import { caReader, openDb, TargetError, type Db } from '../sync/pg-target.js';
import { syncMenu } from '../menu/sync.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TIMEOUT_MS = 30_000;

function config(): DbSettings | null {
  for (const field of ['NODE_OPTIONS', 'NODE_PATH']) {
    if (process.env[field]) {
      log.error('config_invalid', { field });
      return null;
    }
  }
  try {
    return dbSettings(process.env, caReader(ROOT));
  } catch (err) {
    log.error('config_invalid', { field: err instanceof EnvError ? err.message : 'unknown' });
    return null;
  }
}

async function main(): Promise<number> {
  const settings = config();
  if (!settings) return 2;
  let db: Db;
  try {
    db = await openDb(settings);
  } catch (err) {
    log.error('db_failed', { code: err instanceof TargetError ? err.code : 'unknown' });
    return 4;
  }
  try {
    const { stored, failed } = await syncMenu({ http: { fetchImpl: fetch, timeoutMs: TIMEOUT_MS }, db, log, now: Date.now });
    return stored === 0 && failed > 0 ? 1 : 0;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log.error('menu_cli_failed', { kind: err instanceof Error ? err.name : 'unknown' });
    process.exitCode = 1;
  },
);
