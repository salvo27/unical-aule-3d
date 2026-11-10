import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatedFiles, renderClientConfig, renderHeaders, shipsAdmin, siteSettings, vendorFiles, wranglerVars, ROUTES, SiteError } from '../scripts/build-site.js';
import { csp, securityHeaders } from '../src/http/headers.js';
import { EnvError, type AccountsMode } from '../src/settings.js';

const ORIGIN = 'https://abc.supabase.co';
const KEY = 'sb_publishable_abcdefghijklmnop';
const LOCAL_URL = 'http://127.0.0.1:54321';
const TILES = "'self' https://tiles.openfreemap.org";
const MODES: AccountsMode[] = ['off', 'admin', 'all'];

function policy(connect: string): string {
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src ${connect}; worker-src 'self' blob:; child-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}

function expected(connect: string, production: boolean, adminConnect: string | null = null): string {
  return [
    '/*',
    `  Content-Security-Policy: ${policy(connect)}`,
    '  X-Content-Type-Options: nosniff',
    '  Referrer-Policy: no-referrer',
    '  X-Frame-Options: DENY',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Cross-Origin-Resource-Policy: same-origin',
    '  Permissions-Policy: camera=(), microphone=(), geolocation=(self), payment=()',
    ...(production ? ['  Strict-Transport-Security: max-age=31536000; includeSubDomains'] : []),
    '/vendor/*',
    '  Cache-Control: public, max-age=86400',
    '/admin*',
    '  X-Robots-Tag: noindex',
    ...(adminConnect ? ['  ! Content-Security-Policy', `  Content-Security-Policy: ${policy(adminConnect)}`] : []),
    '',
  ].join('\n');
}

function envError(name: string): (e: unknown) => boolean {
  return (e) => e instanceof EnvError && e.message === name;
}

function siteError(code: string): (e: unknown) => boolean {
  return (e) => e instanceof SiteError && e.message === code;
}

function rootBlock(text: string): [string, string][] {
  const lines = text.split('\n');
  const end = lines.indexOf('/vendor/*');
  assert.equal(lines[0], '/*');
  return lines.slice(1, end).map((line) => {
    const match = /^ {2}([A-Za-z-]+): (.+)$/.exec(line);
    assert.ok(match, line);
    return [match[1]!, match[2]!];
  });
}

interface Rule {
  pattern: RegExp;
  set: [string, string][];
  unset: string[];
}

// Cloudflare's asset worker: matching rules in file order; a rule first removes its "! Name" headers,
// then sets its own, appending to a name an earlier rule already set.
function served(text: string, path: string): Headers {
  const rules: Rule[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('/')) {
      const source = line.split('*').map((part) => part.replace(/[.?+^$()[\]{}|\\]/g, '\\$&')).join('.*');
      rules.push({ pattern: new RegExp(`^${source}$`), set: [], unset: [] });
      continue;
    }
    const rule = rules.at(-1);
    assert.ok(rule, line);
    const unset = /^ {2}! ([A-Za-z-]+)$/.exec(line);
    const pair = /^ {2}([A-Za-z-]+): (.+)$/.exec(line);
    if (unset) rule.unset.push(unset[1]!);
    else if (pair) rule.set.push([pair[1]!, pair[2]!]);
    else assert.fail(line);
  }
  const headers = new Headers();
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule.pattern.test(path)) continue;
    for (const name of rule.unset) headers.delete(name);
    for (const [name, value] of rule.set) {
      if (seen.has(name.toLowerCase())) headers.append(name, value);
      else headers.set(name, value);
      seen.add(name.toLowerCase());
    }
  }
  return headers;
}

const MAP_PATHS = ['/', '/index.html', '/app.js', '/client-config.json', '/data/campus.geojson', '/vendor/supabase.js'];
const ADMIN_PATHS = ['/admin', '/admin.html', '/admin.js', '/admin-config.json'];

test('renderHeaders: exact output per accounts mode, production and local', () => {
  for (const [origin, production] of [
    [ORIGIN, true],
    [LOCAL_URL, false],
  ] as const) {
    assert.equal(renderHeaders('all', origin, production), expected(`${TILES} ${origin}`, production));
    assert.equal(renderHeaders('admin', origin, production), expected(TILES, production, `${TILES} ${origin}`));
    assert.equal(renderHeaders('off', origin, production), expected(TILES, production));
    assert.ok(!renderHeaders('off', origin, production).includes(origin));
  }
});

test('renderHeaders: the root block equals securityHeaders entry by entry', () => {
  for (const production of [true, false]) {
    assert.deepEqual(rootBlock(renderHeaders('all', ORIGIN, production)), Object.entries(securityHeaders(production, ORIGIN)));
    for (const mode of ['off', 'admin'] as const) {
      assert.deepEqual(rootBlock(renderHeaders(mode, ORIGIN, production)), Object.entries(securityHeaders(production, null)));
    }
  }
});

test('_headers as Cloudflare applies it: the map reaches Supabase only in mode all, /admin* in admin and all', () => {
  for (const mode of MODES) {
    const text = renderHeaders(mode, ORIGIN, true);
    for (const path of [...MAP_PATHS, ...ADMIN_PATHS]) {
      const headers = served(text, path);
      const reaches = mode === 'all' || (mode === 'admin' && ADMIN_PATHS.includes(path));
      // One policy only: two would both apply and the stricter would win.
      assert.equal(headers.get('Content-Security-Policy'), csp(reaches ? ORIGIN : null), `${mode} ${path}`);
      for (const [name, value] of Object.entries(securityHeaders(true, null))) {
        if (name !== 'Content-Security-Policy') assert.equal(headers.get(name), value, `${mode} ${path} ${name}`);
      }
      assert.equal(headers.get('X-Robots-Tag'), ADMIN_PATHS.includes(path) ? 'noindex' : null, `${mode} ${path}`);
    }
  }
});

test('renderHeaders: a value can never add a line or a rule', () => {
  for (const mode of ['admin', 'all'] as const) {
    assert.throws(() => renderHeaders(mode, 'https://abc.supabase.co\n/*', true), siteError('headers'));
    assert.throws(() => renderHeaders(mode, 'https://abc.supabase.co\r', true), siteError('headers'));
  }
});

test('renderClientConfig: exact JSON and key set', () => {
  const settings = { url: ORIGIN, origin: ORIGIN, publishableKey: KEY };
  const on = renderClientConfig(settings, true);
  assert.equal(on, `{"supabaseUrl":"${ORIGIN}","publishableKey":"${KEY}","features":{"accounts":true}}`);
  assert.deepEqual(Object.keys(JSON.parse(on)), ['supabaseUrl', 'publishableKey', 'features']);
  const off = renderClientConfig(settings, false);
  assert.equal(off, '{"features":{"accounts":false}}');
  assert.deepEqual(Object.keys(JSON.parse(off)), ['features']);
  assert.ok(!off.includes(KEY) && !off.includes('supabase'));
});

test('renderClientConfig: a secret or legacy key is never written', () => {
  const secret = { url: ORIGIN, origin: ORIGIN, publishableKey: 'sb_secret_abcdefghijklmnop' };
  assert.throws(() => renderClientConfig(secret, true), envError('SUPABASE'));
  const legacy = { url: ORIGIN, origin: ORIGIN, publishableKey: 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.abc' };
  assert.throws(() => renderClientConfig(legacy, true), envError('SUPABASE'));
});

test('generatedFiles: the map config carries Supabase values only in mode all, the admin config exists only with an admin page', () => {
  const supabase = { url: ORIGIN, origin: ORIGIN, publishableKey: KEY };
  const on = renderClientConfig(supabase, true);
  const off = renderClientConfig(supabase, false);
  const files = (accounts: AccountsMode) => generatedFiles({ mode: 'production', supabase, accounts });
  const routes = { '_routes.json': ROUTES };
  assert.deepEqual(files('off'), { 'client-config.json': off, _headers: renderHeaders('off', ORIGIN, true), ...routes });
  assert.deepEqual(files('admin'), { 'client-config.json': off, _headers: renderHeaders('admin', ORIGIN, true), ...routes, 'admin-config.json': on });
  assert.deepEqual(files('all'), { 'client-config.json': on, _headers: renderHeaders('all', ORIGIN, true), ...routes, 'admin-config.json': on });
  assert.equal(generatedFiles({ mode: 'local', supabase, accounts: 'off' })._headers, renderHeaders('off', ORIGIN, false));
  assert.deepEqual(MODES.map(shipsAdmin), [false, true, true]);
});

test('_routes.json: Pages runs the function for /api/* only, so static files never reach it', () => {
  assert.equal(ROUTES, '{"version":1,"include":["/api/*"],"exclude":[]}');
  for (const mode of MODES) {
    assert.equal(generatedFiles({ mode: 'local', supabase: { url: LOCAL_URL, origin: LOCAL_URL, publishableKey: KEY }, accounts: mode })['_routes.json'], ROUTES);
  }
});

test('vendorFiles: supabase-js ships only with a page that signs in', () => {
  const base = ['licenses.txt', 'maplibre-gl-worker.mjs', 'maplibre-gl.css', 'maplibre-gl.mjs'];
  assert.deepEqual(Object.keys(vendorFiles('off')).sort(), base);
  for (const mode of ['admin', 'all'] as const) assert.deepEqual(Object.keys(vendorFiles(mode)).sort(), [...base, 'supabase.js'].sort());
  assert.equal(vendorFiles('admin')['supabase.js'], 'node_modules/@supabase/supabase-js/dist/umd/supabase.js');
});

test('siteSettings: production needs https and a publishable key', () => {
  const ok = siteSettings({ SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS: 'all' }, 'production');
  assert.deepEqual(ok, { mode: 'production', supabase: { url: ORIGIN, origin: ORIGIN, publishableKey: KEY }, accounts: 'all' });
  assert.throws(() => siteSettings({ SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY }, 'production'), envError('SUPABASE_URL'));
  assert.throws(() => siteSettings({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY }, 'production'), envError('SUPABASE_URL'));
  for (const mode of ['production', 'local'] as const) {
    assert.throws(() => siteSettings({ SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnop' }, mode), envError('SUPABASE'));
  }
});

test('siteSettings: local http only in local mode, Supabase values required in every accounts mode', () => {
  const local = siteSettings({ SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS: 'off' }, 'local');
  assert.equal(local.supabase.origin, LOCAL_URL);
  assert.equal(local.accounts, 'off');
  assert.equal(siteSettings({ SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY }, 'local').accounts, 'off');
  assert.throws(() => siteSettings({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY }, 'local'), envError('SUPABASE_URL'));
  assert.throws(() => siteSettings({ ACCOUNTS: 'off' }, 'local'), envError('SUPABASE'));
  assert.throws(() => siteSettings({ SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS: 'yes' }, 'local'), envError('ACCOUNTS'));
  assert.throws(() => siteSettings({ SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'false' }, 'local'), envError('ACCOUNTS_ENABLED'));
});

test('wranglerVars: only the known vars, empty values fail closed', () => {
  const env = wranglerVars(JSON.stringify({ name: 'x', vars: { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ACCOUNTS: 'admin', OTHER: 'x' } }));
  assert.deepEqual(env, { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ACCOUNTS: 'admin', ACCOUNTS_ENABLED: undefined });
  assert.throws(() => siteSettings(env, 'production'), envError('SUPABASE'));
  const filled = wranglerVars(JSON.stringify({ vars: { SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS: 'admin' } }));
  assert.equal(siteSettings(filled, 'production').accounts, 'admin');
  const stale = wranglerVars(JSON.stringify({ vars: { SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'false' } }));
  assert.throws(() => siteSettings(stale, 'production'), envError('ACCOUNTS_ENABLED'));
  assert.throws(() => wranglerVars(JSON.stringify({ vars: { ACCOUNTS: true } })), envError('ACCOUNTS'));
  assert.throws(() => wranglerVars('{"vars": '), siteError('wrangler.json'));
  assert.throws(() => wranglerVars(JSON.stringify({ vars: [] })), siteError('wrangler.json'));
  assert.throws(() => wranglerVars(JSON.stringify({})), siteError('wrangler.json'));
  assert.throws(() => wranglerVars(' '.repeat(65537)), siteError('wrangler.json'));
});

test('the admin page is exactly admin.html and admin.js, and the map never links to it', () => {
  const read = (path: string) => readFileSync(new URL(`../../public/${path}`, import.meta.url), 'utf8');
  assert.match(read('admin.html'), /<script type="module" src="\/admin\.js"><\/script>/);
  for (const name of readdirSync(new URL('../../public/', import.meta.url))) {
    if (name.endsWith('.js') && name !== 'admin.js') assert.ok(!read(name).includes("from './admin.js'"), name);
  }
  assert.ok(!read('index.html').includes('admin'));
});

// The built script runs in a temporary copy of the project, so the real site/ is never touched.
const DIST = fileURLToPath(new URL('../', import.meta.url));
const REAL_THEME = fileURLToPath(new URL('../../public/theme.js', import.meta.url));
const REAL_SRC = fileURLToPath(new URL('../../src', import.meta.url));
const REAL_ESBUILD = fileURLToPath(new URL('../../node_modules/esbuild', import.meta.url));
const VENDOR_SOURCES = [
  'maplibre-gl/dist/maplibre-gl.mjs',
  'maplibre-gl/dist/maplibre-gl-worker.mjs',
  'maplibre-gl/dist/maplibre-gl.css',
  '@supabase/supabase-js/dist/umd/supabase.js',
];
const MAP_FILES = [
  '404.html',
  '_headers',
  '_routes.json',
  '_worker.js',
  'client-config.json',
  'data/campus.geojson',
  'index.html',
  'theme.js',
  'vendor/licenses.txt',
  'vendor/maplibre-gl-worker.mjs',
  'vendor/maplibre-gl.css',
  'vendor/maplibre-gl.mjs',
];
const ADMIN_FILES = ['admin-config.json', 'admin.html', 'admin.js', 'vendor/supabase.js'];
const LOCAL_ENV = { SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS: 'admin' };

function siteFiles(accounts: AccountsMode): string[] {
  return [...MAP_FILES, ...(accounts === 'off' ? [] : ADMIN_FILES)].sort();
}

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function wranglerJson(url: string, key: string, accounts: string): string {
  return JSON.stringify({ name: 'aule-unical', vars: { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, ACCOUNTS: accounts } });
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'aule-site-'));
  put(root, 'package.json', '{"type":"module"}');
  for (const file of ['scripts/build-site.js', 'src/http/headers.js', 'src/settings.js']) {
    mkdirSync(dirname(join(root, 'dist', file)), { recursive: true });
    copyFileSync(join(DIST, file), join(root, 'dist', file));
  }
  put(root, 'dist/licenses.txt', 'licenses');
  for (const source of VENDOR_SOURCES) put(root, `node_modules/${source}`, source);
  put(root, 'node_modules/maplibre-gl/dist/maplibre-gl.mjs.map', 'map');
  // The real worker sources and bundler: the bundle in site/ is the one Pages would run.
  cpSync(REAL_SRC, join(root, 'src'), { recursive: true });
  symlinkSync(REAL_ESBUILD, join(root, 'node_modules/esbuild'), 'dir');
  put(root, 'public/index.html', '<!doctype html>');
  put(root, 'public/404.html', '<!doctype html>');
  put(root, 'public/admin.html', '<!doctype html><script type="module" src="/admin.js"></script>');
  put(root, 'public/admin.js', 'export {};');
  copyFileSync(REAL_THEME, join(root, 'public/theme.js'));
  put(root, 'public/data/campus.geojson', '{}');
  put(root, 'public/.env', 'SUPABASE_PUBLISHABLE_KEY=x');
  put(root, 'public/data/.DS_Store', 'x');
  put(root, 'outside.txt', 'outside');
  symlinkSync(join(root, 'outside.txt'), join(root, 'public/data/link.txt'));
  put(root, 'wrangler.json', wranglerJson('', '', 'admin'));
  return root;
}

function build(root: string, args: string[], env: Record<string, string> = {}, script = join(root, 'dist/scripts/build-site.js')) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd: root, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr.trim() };
}

function listFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(dir, entry.name), path));
    else out.push(path);
  }
  return out.sort();
}

function withProject(run: (root: string) => void): void {
  const root = project();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function filesWith(site: string, text: string): string[] {
  return listFiles(site).filter((file) => readFileSync(join(site, file), 'utf8').includes(text));
}

test('build CLI: started through a symbolic link it still runs and fails closed', () => {
  withProject((root) => {
    const link = join(root, 'build-link.js');
    symlinkSync(join(root, 'dist/scripts/build-site.js'), link);
    assert.deepEqual(build(root, ['--mode', 'local'], {}, link), { status: 1, stderr: 'SUPABASE' });
    assert.deepEqual(build(root, [], {}, link), { status: 1, stderr: 'usage' });
    assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV, link).status, 0);
    assert.ok(existsSync(join(root, 'site/_headers')));
  });
});

test('build CLI: site/ holds public/ and the vendor files only, theme.js unchanged', () => {
  withProject((root) => {
    assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 0, stderr: '' });
    const site = join(root, 'site');
    assert.deepEqual(listFiles(site), siteFiles('admin'));
    assert.deepEqual(readFileSync(join(site, 'theme.js')), readFileSync(REAL_THEME));
    assert.equal(readFileSync(join(site, '_headers'), 'utf8'), renderHeaders('admin', LOCAL_URL, false));
    assert.equal(readFileSync(join(site, 'client-config.json'), 'utf8'), '{"features":{"accounts":false}}');
    assert.equal(
      readFileSync(join(site, 'admin-config.json'), 'utf8'),
      renderClientConfig({ url: LOCAL_URL, origin: LOCAL_URL, publishableKey: KEY }, true),
    );
  });
});

test('build CLI: production reads wrangler.json and ships per accounts mode', () => {
  withProject((root) => {
    const site = join(root, 'site');
    const supabase = { url: ORIGIN, origin: ORIGIN, publishableKey: KEY };
    for (const mode of MODES) {
      put(root, 'wrangler.json', wranglerJson(ORIGIN, KEY, mode));
      // Process variables never override wrangler.json in production.
      assert.equal(build(root, ['--mode', 'production'], { ...LOCAL_ENV, ACCOUNTS: 'all' }).status, 0, mode);
      assert.deepEqual(listFiles(site), siteFiles(mode), mode);
      assert.equal(readFileSync(join(site, '_headers'), 'utf8'), renderHeaders(mode, ORIGIN, true), mode);
      assert.equal(readFileSync(join(site, 'client-config.json'), 'utf8'), renderClientConfig(supabase, mode === 'all'), mode);
      const withKey = { off: [], admin: ['admin-config.json'], all: ['admin-config.json', 'client-config.json'] }[mode];
      assert.deepEqual(filesWith(site, KEY), withKey, mode);
      assert.deepEqual(filesWith(site, ORIGIN), mode === 'off' ? [] : ['_headers', ...withKey].sort(), mode);
      assert.deepEqual(filesWith(site, LOCAL_URL), [], mode);
    }
  });
});

test('build CLI: a missing or empty ACCOUNTS ships no admin page, a wrong or old one fails', () => {
  withProject((root) => {
    const site = join(root, 'site');
    for (const accounts of [undefined, '']) {
      const env: Record<string, string> = { SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY };
      if (accounts !== undefined) env.ACCOUNTS = accounts;
      assert.equal(build(root, ['--mode', 'local'], env).status, 0);
      assert.deepEqual(listFiles(site), siteFiles('off'));
    }
    assert.deepEqual(build(root, ['--mode', 'local'], { ...LOCAL_ENV, ACCOUNTS: 'students' }), { status: 1, stderr: 'ACCOUNTS' });
    assert.deepEqual(listFiles(site), []);
    assert.deepEqual(build(root, ['--mode', 'local'], { ...LOCAL_ENV, ACCOUNTS_ENABLED: 'true' }), { status: 1, stderr: 'ACCOUNTS_ENABLED' });
    put(root, 'wrangler.json', JSON.stringify({ vars: { SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'false' } }));
    assert.deepEqual(build(root, ['--mode', 'production']), { status: 1, stderr: 'ACCOUNTS_ENABLED' });
  });
});

test('build CLI: a failed build leaves no older site ready to deploy', () => {
  withProject((root) => {
    const site = join(root, 'site');
    assert.equal(build(root, ['--mode', 'local'], LOCAL_ENV).status, 0);
    assert.deepEqual(build(root, ['--mode', 'production']), { status: 1, stderr: 'SUPABASE' });
    assert.deepEqual(listFiles(site), []);

    for (const reserved of ['_redirects', '_worker.js', '_routes.json', 'admin-config.json', 'client-config.json']) {
      assert.equal(build(root, ['--mode', 'local'], LOCAL_ENV).status, 0);
      put(root, `public/${reserved}`, '/* https://elsewhere.example 302');
      assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 1, stderr: 'public' }, reserved);
      assert.deepEqual(listFiles(site), []);
      rmSync(join(root, 'public', reserved));
    }

    // Without 404.html Pages would answer every unknown path with the map.
    assert.equal(build(root, ['--mode', 'local'], LOCAL_ENV).status, 0);
    rmSync(join(root, 'public/404.html'));
    assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 1, stderr: 'public' });
    assert.deepEqual(listFiles(site), []);
  });
});

test('build CLI: public/api and public/vendor are reserved, in any letter case', () => {
  withProject((root) => {
    const site = join(root, 'site');
    // The function answers /api/*, so files there would never be served.
    for (const path of ['api/status.json', 'api', 'API/index.html', 'vendor/x.js']) {
      assert.equal(build(root, ['--mode', 'local'], LOCAL_ENV).status, 0, path);
      put(root, `public/${path}`, '{}');
      assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 1, stderr: 'public' }, path);
      assert.deepEqual(listFiles(site), [], path);
      rmSync(join(root, 'public', path.split('/')[0]!), { recursive: true });
    }
  });
});

test('build CLI: a worker that does not bundle to one self-contained module fails closed', () => {
  withProject((root) => {
    const site = join(root, 'site');
    const entry = join(root, 'src/worker/index.ts');
    const original = readFileSync(entry, 'utf8');
    const broken = [
      "import { readFileSync } from 'node:fs';\nexport default { fetch: () => new Response(String(readFileSync)) };\n",
      "import pg from 'pg';\nexport default { fetch: () => new Response(String(pg)) };\n",
      'export default { fetch: ( };\n',
    ];
    for (const source of broken) {
      writeFileSync(entry, original);
      assert.equal(build(root, ['--mode', 'local'], LOCAL_ENV).status, 0);
      writeFileSync(entry, source);
      assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 1, stderr: 'worker' }, source);
      assert.deepEqual(listFiles(site), []);
    }
    rmSync(entry);
    assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 1, stderr: 'worker' });
  });
});

interface PagesWorker {
  fetch(request: Request, env: Record<string, unknown>, ctx: { waitUntil(p: Promise<unknown>): void; passThroughOnException(): void }): Promise<Response>;
}

test('the bundled _worker.js answers /api/* itself, hands the rest to the assets and survives any Cache API', async () => {
  const root = project();
  const savedFetch = globalThis.fetch;
  const savedCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
  try {
    assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 0, stderr: '' });
    const file = join(root, 'site/_worker.js');
    const text = readFileSync(file, 'utf8');
    assert.ok(!/^\s*import\s/m.test(text) && !/\bimport\(|\brequire\(/.test(text), 'one self-contained module');
    assert.match(text, /^export \{[^}]*\bas default\b[^}]*\};?$/m);
    assert.ok(!text.includes(KEY) && !text.includes(LOCAL_URL) && !text.includes('process.env'));
    const worker = ((await import(pathToFileURL(file).href)) as { default: PagesWorker }).default;

    const upstream: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      upstream.push(String(url));
      return new Response('{"ok":1}', { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const assets: string[] = [];
    const env = {
      ...LOCAL_ENV,
      ASSETS: {
        fetch: async (request: Request) => {
          assets.push(new URL(request.url).pathname);
          return new Response('static');
        },
      },
    };
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => undefined };
    const get = (path: string) => worker.fetch(new Request(`http://localhost:3010${path}`), env, ctx);

    // Node has no Cache API at all.
    const status = await get('/api/status');
    assert.equal(status.status, 200);
    assert.equal(await status.text(), '{"ok":1}');
    for (const [name, value] of Object.entries(securityHeaders(false, null))) assert.equal(status.headers.get(name), value, name);
    assert.equal(status.headers.get('Cache-Control'), 'no-store');
    // A runtime where reaching the Cache API throws.
    Object.defineProperty(globalThis, 'caches', {
      configurable: true,
      get() {
        throw new TypeError('no cache');
      },
    });
    assert.equal((await get('/api/search?q=aula')).status, 200);
    // A Cache API whose calls throw at once.
    const thrower = () => {
      throw new TypeError('no cache');
    };
    Object.defineProperty(globalThis, 'caches', { configurable: true, writable: true, value: { default: { match: thrower, put: thrower } } });
    assert.equal((await get(`/api/rooms/${'a'.repeat(24)}`)).status, 200);
    await Promise.all(pending);
    // The memory cache still keeps one call per 60 s.
    assert.equal((await get('/api/status')).status, 200);
    assert.deepEqual(
      upstream.map((url) => url.replace(`${LOCAL_URL}/rest/v1/rpc/`, '')),
      ['room_status', 'search_rooms', 'room_lessons'],
    );
    const nope = await get('/api/nope');
    assert.equal(nope.status, 404);
    assert.deepEqual(await nope.json(), { error: 'not_found' });

    for (const path of ['/', '/admin', '/api', '/vendor/supabase.js']) assert.equal(await (await get(path)).text(), 'static', path);
    assert.deepEqual(assets, ['/', '/admin', '/api', '/vendor/supabase.js']);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedCaches) Object.defineProperty(globalThis, 'caches', savedCaches);
    else delete (globalThis as Record<string, unknown>).caches;
    rmSync(root, { recursive: true, force: true });
  }
});

test('dist/licenses.txt lists the packages served to browsers and no sync-only package', () => {
  const text = readFileSync(new URL('../licenses.txt', import.meta.url), 'utf8');
  const parts = text.split('\n\n----------\n\n');
  parts[0] = parts[0]!.replace(/^Third-party software served by unical-aule-3d\n\n/, '');
  const names = parts.map((part) => {
    const match = /^(\S+) \S* \(/.exec(part);
    assert.ok(match, part.slice(0, 80));
    return match[1]!;
  });
  for (const name of ['maplibre-gl', '@supabase/supabase-js']) assert.ok(names.includes(name), name);
  for (const name of ['pg', 'fflate', '@xmldom/xmldom', 'wrangler', 'typescript', '@types/pg']) assert.ok(!names.includes(name), name);
  assert.ok(!names.some((name) => /^(pg-|postgres-|pgpass)/.test(name)), names.join(' '));
});
