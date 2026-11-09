// Collects the license texts of the runtime dependencies into dist/licenses.txt.
// The server sends MapLibre and supabase-js to browsers, so their notices go with them.
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface LockPackage {
  version?: string;
  license?: string;
  dev?: boolean;
}

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { packages: Record<string, LockPackage> };
const parts: string[] = [];
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path || info.dev || !existsSync(path)) continue;
  const file = readdirSync(path).find((f) => /^licen[cs]e/i.test(f));
  const text = file ? readFileSync(join(path, file), 'utf8').trim() : 'License file not included in the package.';
  parts.push(`${path.replace(/^.*node_modules\//, '')} ${info.version ?? ''} (${info.license ?? 'unknown'})\n\n${text}`);
}
mkdirSync('dist', { recursive: true });
writeFileSync('dist/licenses.txt', `Third-party software served by unical-aule-3d\n\n${parts.join('\n\n----------\n\n')}\n`);
console.log(`dist/licenses.txt: ${parts.length} packages`);
