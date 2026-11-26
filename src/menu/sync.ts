// Keeps the canteen menu in the database: the menu files of today and of the next two weeks, read and stored.
// A file that cannot be read leaves the menu stored before for its period: the app shows that, or nothing.
import { addDays, romeDay } from '../availability/time.js';
import type { IsoDay } from '../domain/primitives.js';
import { sourceUrl } from '../domain/primitives.js';
import type { Logger } from '../log.js';
import { getPage, getPdf, type HttpOptions } from '../sources/pdf/client.js';
import { pdfCode } from '../sources/pdf/codes.js';
import { layoutText } from '../sources/pdf/poppler.js';
import type { Db } from '../sync/pg-target.js';
import { TargetError } from '../sync/pg-target.js';
import { menuFiles, MENU_PAGE } from './files.js';
import { MenuError, parseMenu } from './parse.js';

const AHEAD_DAYS = 14;

export interface MenuSyncDeps {
  http: HttpOptions;
  db: Pick<Db, 'call'>;
  log: Logger;
  now: () => number;
  text?: (bytes: Uint8Array) => Promise<string>;
}

export interface MenuSyncResult {
  stored: number;
  failed: number;
}

function code(err: unknown): string {
  if (err instanceof MenuError) return err.code;
  if (err instanceof TargetError) return `db_${err.code}`;
  return pdfCode(err) ?? 'unexpected';
}

export async function syncMenu(deps: MenuSyncDeps): Promise<MenuSyncResult> {
  const today: IsoDay = romeDay(deps.now());
  let files;
  try {
    files = menuFiles(await getPage(sourceUrl(MENU_PAGE), deps.http));
  } catch (err) {
    deps.log.error('menu_page_failed', { code: code(err) });
    return { stored: 0, failed: 1 };
  }
  const wanted = files.filter((f) => f.endsOn >= today && f.startsOn <= addDays(today, AHEAD_DAYS));
  if (wanted.length === 0) {
    deps.log.warn('menu_none_current', { files: files.length });
    return { stored: 0, failed: 0 };
  }
  const result: MenuSyncResult = { stored: 0, failed: 0 };
  for (const file of wanted) {
    try {
      const download = await getPdf(file.url, null, deps.http);
      if (download.status !== 'ok') throw new MenuError('no_pages');
      const days = parseMenu(await (deps.text ?? layoutText)(download.bytes), file);
      await deps.db.call('menu_put', [{ startsOn: file.startsOn, endsOn: file.endsOn, source: file.url, days }]);
      deps.log.info('menu_stored', { startsOn: file.startsOn, endsOn: file.endsOn, days: days.length });
      result.stored += 1;
    } catch (err) {
      deps.log.error('menu_file_failed', { startsOn: file.startsOn, code: code(err) });
      result.failed += 1;
    }
  }
  return result;
}
