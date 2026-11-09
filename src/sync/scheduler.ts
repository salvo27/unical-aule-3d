import type { SyncService } from './sync.js';
import type { SnapshotStore } from '../store/snapshot-store.js';
import { romeDay, romeHour, romeMidnight } from '../availability/time.js';
import type { Logger } from '../log.js';

const CHECK_EVERY_MS = 60_000;
const H = 60 * 60 * 1000;

// Runs a sync once per configured hour (Europe/Rome), and at startup when the data is old.
export function startScheduler(opts: {
  sync: SyncService;
  snapshots: SnapshotStore;
  hours: number[];
  staleAfterMs: number;
  log: Logger;
  now?: () => number;
}): () => void {
  const now = opts.now ?? Date.now;
  const runSafely = (trigger: 'startup' | 'schedule') => {
    opts.sync.run(trigger).catch(() => opts.log.error('sync_crashed'));
  };

  const last = opts.snapshots.current.lastRun;
  if (!last || now() - last.startedAt > opts.staleAfterMs / 2) runSafely('startup');

  const tick = () => {
    const t = now();
    const hour = romeHour(t);
    const due = opts.hours.filter((h) => h <= hour).pop();
    if (due === undefined) return;
    const slotStart = romeMidnight(romeDay(t)) + due * H;
    const lastRun = opts.snapshots.current.lastRun;
    if (!lastRun || lastRun.startedAt < slotStart) runSafely('schedule');
  };
  const timer = setInterval(tick, CHECK_EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
