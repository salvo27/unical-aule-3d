// Collects the license texts of the packages served to browsers into dist/licenses.txt.
// Only maplibre-gl, supabase-js and their dependencies: sync-only packages (pg, fflate, xmldom) never reach a browser.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LockPackage {
  version?: string;
  license?: string;
  dependencies?: Record<string, string>;
}

type Packages = Record<string, LockPackage>;

const BROWSER_PACKAGES = ['maplibre-gl', '@supabase/supabase-js'];
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

class NoticesError extends Error {}

// Node resolution: the nearest node_modules folder from the dependent package up to the root.
function resolve(packages: Packages, from: string, name: string): string {
  let base = from;
  for (;;) {
    const candidate = `${base ? `${base}/` : ''}node_modules/${name}`;
    if (packages[candidate]) return candidate;
    if (!base) throw new NoticesError(`missing ${name}`);
    const cut = base.lastIndexOf('/node_modules/');
    base = cut === -1 ? '' : base.slice(0, cut);
  }
}

function browserPackages(packages: Packages): Set<string> {
  const found = new Set<string>();
  const queue = BROWSER_PACKAGES.map((name) => resolve(packages, '', name));
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (found.has(path)) continue;
    found.add(path);
    for (const name of Object.keys(packages[path]?.dependencies ?? {})) queue.push(resolve(packages, path, name));
  }
  return found;
}

function main(): void {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages?: Packages };
  if (!lock.packages) throw new NoticesError('lockfile');
  const served = browserPackages(lock.packages);
  const parts: string[] = [];
  for (const [path, info] of Object.entries(lock.packages)) {
    if (!served.has(path)) continue;
    const dir = join(ROOT, path);
    if (!existsSync(dir)) throw new NoticesError(`not installed ${path}`);
    const file = readdirSync(dir).find((f) => /^licen[cs]e/i.test(f));
    const text = file ? readFileSync(join(dir, file), 'utf8').trim() : 'License file not included in the package.';
    parts.push(`${path.replace(/^.*node_modules\//, '')} ${info.version ?? ''} (${info.license ?? 'unknown'})\n\n${text}`);
  }
  const out = join(ROOT, 'dist', 'licenses.txt');
  const tmp = `${out}.tmp-${process.pid}`;
  mkdirSync(join(ROOT, 'dist'), { recursive: true });
  try {
    writeFileSync(tmp, `Third-party software served by unical-aule-3d\n\n${parts.join('\n\n----------\n\n')}\n`, { flag: 'wx' });
    renameSync(tmp, out);
  } catch {
    rmSync(tmp, { force: true });
    throw new NoticesError('out_file');
  }
  console.log(`dist/licenses.txt: ${parts.length} packages`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`notices: ${err instanceof NoticesError ? err.message : 'unexpected'}\n`);
  process.exitCode = 1;
}
