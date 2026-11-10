import { createPlannerApi } from '../planner/client.js';
import { plannerAdapter } from './planner.js';
import { adapter as portal } from './portal.js';
import { adapter as dimes } from './dimes.js';
import { adapter as xlsx } from './xlsx.js';
import { adapter as pdf } from './pdf.js';
import type { SourceAdapter, SourceKind } from './types.js';

// A feed whose source has no adapter here fails with "unsupported" (grey, fail closed).
export function createAdapters(): Partial<Record<SourceKind, SourceAdapter>> {
  const adapters: Partial<Record<SourceKind, SourceAdapter>> = { planner: plannerAdapter(createPlannerApi()) };
  const others: [SourceKind, SourceAdapter | null][] = [
    ['portal', portal],
    ['dimes', dimes],
    ['xlsx', xlsx],
    ['pdf', pdf],
  ];
  for (const [kind, adapter] of others) {
    if (adapter && adapter.kind === kind) adapters[kind] = adapter;
  }
  return adapters;
}
