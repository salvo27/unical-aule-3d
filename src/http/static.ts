// Static files are read once at startup into a fixed map: a request can only hit a known path.
import { readdir, readFile } from 'node:fs/promises';
import { join, extname, relative, sep } from 'node:path';

export interface StaticFile {
  body: Buffer;
  type: string;
  cache: string;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.geojson': 'application/geo+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function fileFor(path: string, body: Buffer, cache: string): StaticFile | null {
  const type = TYPES[extname(path).toLowerCase()];
  if (!type) return null;
  return { body, type, cache };
}

export async function loadStaticFiles(publicDir: string, extra: Record<string, string>): Promise<Map<string, StaticFile>> {
  const files = new Map<string, StaticFile>();
  for (const full of await walk(publicDir)) {
    const urlPath = '/' + relative(publicDir, full).split(sep).join('/');
    const file = fileFor(full, await readFile(full), 'no-cache');
    if (file) files.set(urlPath, file);
  }
  for (const [urlPath, full] of Object.entries(extra)) {
    const file = fileFor(full, await readFile(full), 'public, max-age=86400');
    if (!file) throw new Error('static_type');
    files.set(urlPath, file);
  }
  const index = files.get('/index.html');
  if (index) files.set('/', index);
  const admin = files.get('/admin.html');
  if (admin) files.set('/admin', admin);
  return files;
}
