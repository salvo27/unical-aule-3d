import { readFile } from 'node:fs/promises';

export interface Campus {
  keys: ReadonlySet<string>;
  names: ReadonlyMap<string, string>;
}

const KEY = /^[a-z0-9-]{1,80}$/;

export async function loadCampus(path: string): Promise<Campus> {
  const data = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { features?: unknown }).features)) {
    throw new Error('campus_file');
  }
  const names = new Map<string, string>();
  for (const f of (data as { features: unknown[] }).features) {
    const p = (f as { properties?: Record<string, unknown> }).properties;
    if (!p || p.kind !== 'building' || typeof p.key !== 'string' || !KEY.test(p.key) || typeof p.name !== 'string') continue;
    if (!names.has(p.key)) names.set(p.key, p.name.slice(0, 100));
  }
  if (names.size === 0) throw new Error('campus_empty');
  return { keys: new Set(names.keys()), names };
}
