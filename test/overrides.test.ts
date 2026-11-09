import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OverridesService } from '../src/availability/overrides.js';
import { silentLogger } from '../src/log.js';
import type { Override, SupabaseGateway } from '../src/supabase/gateway.js';

const item = (roomId: string): Override => ({ roomId, kind: 'room_closed', category: null, lessonId: null, start: 0, end: 1, source: 'approved' });

test('an older answer never replaces a newer one', async () => {
  const pending: ((v: Override[]) => void)[] = [];
  const gateway = { overrides: () => new Promise<Override[]>((resolve) => pending.push(resolve)) } as unknown as SupabaseGateway;
  let now = 1_000;
  const service = new OverridesService(gateway, silentLogger, () => now);
  const first = service.refresh();
  now = 2_000;
  const second = service.refresh();
  pending[1]!([item('bbbbbbbbbbbbbbbbbbbbbbbb')]);
  await second;
  pending[0]!([item('aaaaaaaaaaaaaaaaaaaaaaaa')]);
  await first;
  assert.deepEqual(service.current.items.map((o) => o.roomId), ['bbbbbbbbbbbbbbbbbbbbbbbb']);
});

test('reports are marked unavailable when refreshes keep failing', async () => {
  const gateway = { overrides: async () => { throw new Error('down'); } } as unknown as SupabaseGateway;
  let now = 0;
  const service = new OverridesService(gateway, silentLogger, () => now);
  await service.refresh();
  now = 10 * 60_000;
  assert.equal(service.current.available, false);
});

test('the window covers what a room page can show', async () => {
  let range: [number, number] = [0, 0];
  const gateway = { overrides: async (from: number, to: number) => { range = [from, to]; return []; } } as unknown as SupabaseGateway;
  const now = Date.parse('2026-11-16T10:00:00Z');
  await new OverridesService(gateway, silentLogger, () => now).refresh();
  const day = 24 * 3_600_000;
  assert.ok(now - range[0] >= 21 * day, 'at least 21 days back');
  assert.ok(range[1] - range[0] <= 31 * day, 'within the database limit');
});
