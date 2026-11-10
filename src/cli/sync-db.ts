// Sync into Postgres through the aule_sync functions. --check only tests connection, TLS and password.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { consoleLogger as log } from '../log.js';
import { dbSettings, EnvError, type DbSettings } from '../settings.js';
import { caReader, openDb, PgSyncTarget, TargetError, type Db } from '../sync/pg-target.js';
import { runSync, type SyncTrigger } from '../sync/run.js';
import { createAdapters } from '../sources/registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TRIGGERS: readonly SyncTrigger[] = ['schedule', 'poll', 'manual'];

function config(): { settings: DbSettings; trigger: SyncTrigger } | null {
  for (const field of ['NODE_OPTIONS', 'NODE_PATH']) {
    if (process.env[field]) {
      log.error('config_invalid', { field });
      return null;
    }
  }
  try {
    const settings = dbSettings(process.env, caReader(ROOT));
    const raw = process.env.SYNC_TRIGGER || 'manual';
    if (!TRIGGERS.includes(raw as SyncTrigger)) throw new EnvError('SYNC_TRIGGER');
    return { settings, trigger: raw as SyncTrigger };
  } catch (err) {
    log.error('config_invalid', { field: err instanceof EnvError ? err.message : 'unknown' });
    return null;
  }
}

async function main(): Promise<number> {
  const cfg = config();
  if (!cfg) return 2;
  let db: Db;
  try {
    db = await openDb(cfg.settings);
  } catch (err) {
    log.error('db_failed', { code: err instanceof TargetError ? err.code : 'unknown' });
    return 4;
  }
  try {
    if (process.argv.includes('--check')) {
      if ((await db.call('ping')) !== 'ok') throw new TargetError('bad_response');
      log.info('db_check', { result: 'ok' });
      return 0;
    }
    const result = await runSync({ adapters: createAdapters(), target: new PgSyncTarget(db), log }, cfg.trigger);
    if (result.kind === 'skipped') return 0;
    if (result.kind === 'aborted') return 1;
    const { ok, failed } = result.summary;
    return ok === 0 && failed > 0 ? 1 : 0;
  } catch (err) {
    if (err instanceof TargetError) {
      log.error('db_failed', { code: err.code });
      return 4;
    }
    log.error('sync_cli_failed', { kind: err instanceof Error ? err.name : 'unknown' });
    return 1;
  } finally {
    await db.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    log.error('sync_cli_failed', { kind: err instanceof Error ? err.name : 'unknown' });
    process.exitCode = 1;
  },
);
