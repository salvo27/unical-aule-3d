// Builds site/ for Cloudflare Pages: public/, the vendor files, the client configs, _headers, _routes.json and _worker.js.
import { constants, realpathSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { csp, securityHeaders } from '../src/http/headers.js';
import { accountsMode, EnvError, supabaseSettings, type AccountsMode, type SupabaseSettings } from '../src/settings.js';

export type Mode = 'production' | 'local';

type Env = Readonly<Record<string, string | undefined>>;

export interface SiteSettings {
  mode: Mode;
  supabase: SupabaseSettings;
  accounts: AccountsMode;
}

export class SiteError extends Error {} // message = closed code

// ACCOUNTS_ENABLED is read only to refuse it (see accountsMode).
const VARS = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'ACCOUNTS', 'ACCOUNTS_ENABLED'] as const;
const WRANGLER_MAX_BYTES = 65536;
const WORKER_MAX_BYTES = 1_048_576;
// Cloudflare reads _headers line by line: printable ASCII only, so a value can never add a rule.
const HEADER_LINE = /^[\x20-\x7E]{1,2000}$/;
const MAP_CONFIG = 'client-config.json';
const ADMIN_CONFIG = 'admin-config.json';
// _routes.json sends /api/* to the function, so a public/api folder would never be served.
const RESERVED = new Set(['vendor', 'api', MAP_CONFIG, ADMIN_CONFIG]);
// Without a top level 404.html Pages would answer every unknown path with the map.
const NOT_FOUND_PAGE = '404.html';
// The admin page ships only when someone may sign in to it.
const ADMIN_FILES = ['admin.html', 'admin.js'];
// Pages runs _worker.js only for these paths: static files never invoke it.
export const ROUTES = JSON.stringify({ version: 1, include: ['/api/*'], exclude: [] });

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const SITE = join(ROOT, 'site');
const WORKER_ENTRY = join(ROOT, 'src/worker/index.ts');
const VENDOR: Record<string, string> = {
  'maplibre-gl.mjs': 'node_modules/maplibre-gl/dist/maplibre-gl.mjs',
  'maplibre-gl-worker.mjs': 'node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs',
  'maplibre-gl.css': 'node_modules/maplibre-gl/dist/maplibre-gl.css',
  'licenses.txt': 'dist/licenses.txt',
};
// Only a page that signs in loads supabase-js.
const ACCOUNT_VENDOR: Record<string, string> = {
  'supabase.js': 'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The Worker needs the Supabase values in every mode, so they are always validated.
export function siteSettings(env: Env, mode: Mode): SiteSettings {
  const supabase = supabaseSettings(env, { allowLocalHttp: mode === 'local' });
  return { mode, supabase, accounts: accountsMode(env) };
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

export function shipsAdmin(accounts: AccountsMode): boolean {
  return accounts !== 'off';
}

export function vendorFiles(accounts: AccountsMode): Record<string, string> {
  return shipsAdmin(accounts) ? { ...VENDOR, ...ACCOUNT_VENDOR } : { ...VENDOR };
}

// The map page reaches Supabase only in mode all. In mode admin only /admin* gets the origin:
// the "!" line drops the policy of /* first, otherwise Cloudflare would send both and the stricter would win.
export function renderHeaders(accounts: AccountsMode, supabaseOrigin: string, production: boolean): string {
  const lines = ['/*'];
  for (const [name, value] of Object.entries(securityHeaders(production, accounts === 'all' ? supabaseOrigin : null))) lines.push(`  ${name}: ${value}`);
  lines.push('/vendor/*', '  Cache-Control: public, max-age=86400', '/admin*', '  X-Robots-Tag: noindex');
  if (accounts === 'admin') lines.push('  ! Content-Security-Policy', `  Content-Security-Policy: ${csp(supabaseOrigin)}`);
  if (!lines.every((line) => HEADER_LINE.test(line))) throw new SiteError('headers');
  return `${lines.join('\n')}\n`;
}

// A page that may not sign in gets neither the URL nor the key.
export function renderClientConfig(settings: SupabaseSettings, accounts: boolean): string {
  if (!accounts) return JSON.stringify({ features: { accounts: false } });
  const checked = supabaseSettings(
    { SUPABASE_URL: settings.url, SUPABASE_PUBLISHABLE_KEY: settings.publishableKey },
    { allowLocalHttp: true },
  );
  return JSON.stringify({ supabaseUrl: checked.url, publishableKey: checked.publishableKey, features: { accounts: true } });
}

// File name to content of the generated files, per mode.
export function generatedFiles(settings: SiteSettings): Record<string, string> {
  const files: Record<string, string> = {
    [MAP_CONFIG]: renderClientConfig(settings.supabase, settings.accounts === 'all'),
    _headers: renderHeaders(settings.accounts, settings.supabase.origin, settings.mode === 'production'),
    '_routes.json': ROUTES,
  };
  if (shipsAdmin(settings.accounts)) files[ADMIN_CONFIG] = renderClientConfig(settings.supabase, true);
  return files;
}

// One self-contained ES module: only relative imports resolve, so no package or Node built-in can slip in.
// Secrets never reach it: Pages passes the vars at run time.
export async function bundleWorker(entry: string): Promise<string> {
  let text: string | undefined;
  try {
    const { build } = await import('esbuild');
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'es2022',
      write: false,
      outfile: '_worker.js',
      charset: 'utf8',
      legalComments: 'none',
      logLevel: 'silent',
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
    });
    text = result.outputFiles[0]?.text;
  } catch {
    throw new SiteError('worker');
  }
  if (!text || Buffer.byteLength(text) > WORKER_MAX_BYTES) throw new SiteError('worker');
  return text;
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

async function checkInputs(vendor: Record<string, string>): Promise<void> {
  const entries = await readdir(PUBLIC).catch(() => {
    throw new SiteError('public');
  });
  if (entries.some((name) => RESERVED.has(name.toLowerCase()) || name.startsWith('_'))) throw new SiteError('public');
  const notFound = await lstat(join(PUBLIC, NOT_FOUND_PAGE)).catch(() => null);
  if (!notFound?.isFile()) throw new SiteError('public');
  for (const source of Object.values(vendor)) {
    const info = await stat(join(ROOT, source)).catch(() => null);
    if (!info?.isFile()) throw new SiteError('vendor');
  }
}

// Keeps the directory itself so a running wrangler pages dev keeps watching it. True when site/ is left as an empty directory.
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

// Dotfiles and symbolic links are never published; skip applies to the top level only.
async function copyTree(from: string, to: string, skip: ReadonlySet<string> = new Set()): Promise<number> {
  let count = 0;
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
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
  let generated: Record<string, string>;
  let vendor: Record<string, string>;
  try {
    settings = siteSettings(mode === 'production' ? wranglerVars(await readWrangler()) : processVars(), mode);
    vendor = vendorFiles(settings.accounts);
    await checkInputs(vendor);
    generated = { ...generatedFiles(settings), '_worker.js': await bundleWorker(WORKER_ENTRY) };
  } catch (err) {
    // A failed build never leaves an older site, maybe a local one, ready to deploy.
    await clearSite().catch(() => undefined);
    throw err;
  }
  let files = 0;
  try {
    await emptySite();
    files = await copyTree(PUBLIC, SITE, new Set(shipsAdmin(settings.accounts) ? [] : ADMIN_FILES));
    await mkdir(join(SITE, 'vendor'));
    for (const [name, source] of Object.entries(vendor)) {
      await copyFile(join(ROOT, source), join(SITE, 'vendor', name), constants.COPYFILE_EXCL);
      files++;
    }
    for (const [name, text] of Object.entries(generated)) {
      await writeFile(join(SITE, name), text, { encoding: 'utf8', flag: 'wx' });
      files++;
    }
  } catch {
    // Never leave a half built site behind: an empty one cannot be mistaken for a release.
    await clearSite().catch(() => undefined);
    throw new SiteError('site');
  }
  console.log(`site built: mode ${mode}, accounts ${settings.accounts}, ${files} files`);
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
