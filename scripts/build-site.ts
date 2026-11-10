// Builds site/ for Cloudflare Static Assets: public/, the vendor files, client-config.json and _headers.
import { constants, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { securityHeaders } from '../src/http/headers.js';
import { accountsFlag, EnvError, supabaseSettings, type SupabaseSettings } from '../src/settings.js';

export type Mode = 'production' | 'local';

type Env = Readonly<Record<string, string | undefined>>;

export interface SiteSettings {
  mode: Mode;
  supabase: SupabaseSettings;
  accounts: boolean;
}

export class SiteError extends Error {} // message = closed code

const VARS = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'ACCOUNTS_ENABLED'] as const;
const WRANGLER_MAX_BYTES = 65536;
// Cloudflare reads _headers line by line: printable ASCII only, so a value can never add a rule.
const HEADER_LINE = /^[\x20-\x7E]{1,2000}$/;
const RESERVED = new Set(['vendor', 'client-config.json']);

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const SITE = join(ROOT, 'site');
const VENDOR: Record<string, string> = {
  'maplibre-gl.mjs': 'node_modules/maplibre-gl/dist/maplibre-gl.mjs',
  'maplibre-gl-worker.mjs': 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs',
  'maplibre-gl.css': 'node_modules/maplibre-gl/dist/maplibre-gl.css',
  'supabase.js': 'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
  'licenses.txt': 'dist/licenses.txt',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The Worker needs the Supabase values even with accounts off, so they are always validated.
export function siteSettings(env: Env, mode: Mode): SiteSettings {
  const supabase = supabaseSettings(env, { allowLocalHttp: mode === 'local' });
  return { mode, supabase, accounts: accountsFlag(env) };
}

export function wranglerVars(text: string): Env {
  if (text.length > WRANGLER_MAX_BYTES) throw new SiteError('wrangler.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SiteError('wrangler.json');
  }
  if (!isRecord(parsed) || !isRecord(parsed.vars)) throw new SiteError('wrangler.json');
  const env: Record<string, string | undefined> = {};
  for (const name of VARS) {
    const value = parsed.vars[name];
    if (value !== undefined && typeof value !== 'string') throw new EnvError(name);
    env[name] = value;
  }
  return env;
}

export function renderHeaders(supabaseOrigin: string | null, production: boolean): string {
  const lines = ['/*'];
  for (const [name, value] of Object.entries(securityHeaders(production, supabaseOrigin))) lines.push(`  ${name}: ${value}`);
  lines.push('/vendor/*', '  Cache-Control: public, max-age=86400', '/admin*', '  X-Robots-Tag: noindex');
  if (!lines.every((line) => HEADER_LINE.test(line))) throw new SiteError('headers');
  return `${lines.join('\n')}\n`;
}

// With accounts off the browser never talks to Supabase, so it gets neither the URL nor the key.
export function renderClientConfig(settings: SupabaseSettings, accounts: boolean): string {
  if (!accounts) return JSON.stringify({ features: { accounts: false } });
  const checked = supabaseSettings(
    { SUPABASE_URL: settings.url, SUPABASE_PUBLISHABLE_KEY: settings.publishableKey },
    { allowLocalHttp: true },
  );
  return JSON.stringify({ supabaseUrl: checked.url, publishableKey: checked.publishableKey, features: { accounts: true } });
}

function parseMode(argv: string[]): Mode {
  const [flag, mode] = argv;
  if (argv.length !== 2 || flag !== '--mode' || (mode !== 'production' && mode !== 'local')) throw new SiteError('usage');
  return mode;
}

async function readWrangler(): Promise<string> {
  const path = join(ROOT, 'wrangler.json');
  const info = await stat(path).catch(() => null);
  if (!info?.isFile() || info.size > WRANGLER_MAX_BYTES) throw new SiteError('wrangler.json');
  return readFile(path, 'utf8');
}

function processVars(): Env {
  return Object.fromEntries(VARS.map((name) => [name, process.env[name]]));
}

async function checkInputs(): Promise<void> {
  const entries = await readdir(PUBLIC).catch(() => {
    throw new SiteError('public');
  });
  if (entries.some((name) => RESERVED.has(name) || name.startsWith('_'))) throw new SiteError('public');
  for (const source of Object.values(VENDOR)) {
    const info = await stat(join(ROOT, source)).catch(() => null);
    if (!info?.isFile()) throw new SiteError('vendor');
  }
}

// Keeps the directory itself so a running wrangler dev keeps watching it. True when site/ is left as an empty directory.
async function clearSite(): Promise<boolean> {
  const info = await lstat(SITE).catch(() => null);
  if (info?.isDirectory()) {
    for (const name of await readdir(SITE)) await rm(join(SITE, name), { recursive: true, force: true });
    return true;
  }
  if (info) await rm(SITE, { force: true });
  return false;
}

async function emptySite(): Promise<void> {
  if (!(await clearSite())) await mkdir(SITE);
}

// Dotfiles and symbolic links are never published.
async function copyTree(from: string, to: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const source = join(from, entry.name);
    const target = join(to, entry.name);
    if (entry.isDirectory()) {
      await mkdir(target);
      count += await copyTree(source, target);
    } else if (entry.isFile()) {
      await copyFile(source, target, constants.COPYFILE_EXCL);
      count++;
    }
  }
  return count;
}

async function main(argv: string[]): Promise<void> {
  const mode = parseMode(argv);
  let settings: SiteSettings;
  let config: string;
  let headers: string;
  try {
    settings = siteSettings(mode === 'production' ? wranglerVars(await readWrangler()) : processVars(), mode);
    config = renderClientConfig(settings.supabase, settings.accounts);
    headers = renderHeaders(settings.accounts ? settings.supabase.origin : null, mode === 'production');
    await checkInputs();
  } catch (err) {
    // A failed build never leaves an older site, maybe a local one, ready to deploy.
    await clearSite().catch(() => undefined);
    throw err;
  }
  let files = 0;
  try {
    await emptySite();
    files = await copyTree(PUBLIC, SITE);
    await mkdir(join(SITE, 'vendor'));
    for (const [name, source] of Object.entries(VENDOR)) {
      await copyFile(join(ROOT, source), join(SITE, 'vendor', name), constants.COPYFILE_EXCL);
      files++;
    }
    await writeFile(join(SITE, 'client-config.json'), config, { encoding: 'utf8', flag: 'wx' });
    await writeFile(join(SITE, '_headers'), headers, { encoding: 'utf8', flag: 'wx' });
  } catch {
    // Never leave a half built site behind: an empty one cannot be mistaken for a release.
    await clearSite().catch(() => undefined);
    throw new SiteError('site');
  }
  console.log(`site built: mode ${mode}, accounts ${settings.accounts ? 'on' : 'off'}, ${files + 2} files`);
}

// Compares real paths: started through a symbolic link, the build must still run and never exit 0 doing nothing.
function runDirectly(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (runDirectly()) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${err instanceof EnvError || err instanceof SiteError ? err.message : 'unexpected'}\n`);
    process.exitCode = 1;
  });
}
