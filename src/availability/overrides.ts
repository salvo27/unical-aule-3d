// Approved reports (and "occupied" reports with enough people agreeing), refreshed every minute.
import type { Override, SupabaseGateway } from '../supabase/gateway.js';
import type { Logger } from '../log.js';

const H = 3_600_000;
const MAX_AGE_MS = 5 * 60_000;
// Matches what a room page can show: 21 days back, a week of closures ahead (within the 31 days the database allows).
const BACK_MS = 22 * 24 * H;
const AHEAD_MS = 8 * 24 * H;

export class OverridesService {
  private items: readonly Override[] = [];
  private fetchedAt = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly gateway: SupabaseGateway | null,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  get current(): { items: readonly Override[]; available: boolean } {
    return { items: this.items, available: this.gateway !== null && this.now() - this.fetchedAt < MAX_AGE_MS };
  }

  async refresh(): Promise<void> {
    if (!this.gateway) return;
    const t = this.now();
    try {
      const items = await this.gateway.overrides(t - BACK_MS, t + AHEAD_MS);
      // Refreshes can overlap: never let an older answer replace a newer one.
      if (t >= this.fetchedAt) {
        this.items = items;
        this.fetchedAt = t;
      }
    } catch {
      this.log.warn('overrides_refresh_failed');
    }
  }

  start(intervalMs = 60_000): void {
    if (!this.gateway || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
