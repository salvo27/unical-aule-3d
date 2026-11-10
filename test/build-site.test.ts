import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderClientConfig, renderHeaders, siteSettings, wranglerVars, SiteError } from '../scripts/build-site.js';
import { securityHeaders } from '../src/http/headers.js';
import { EnvError } from '../src/settings.js';

const ORIGIN = 'https://abc.supabase.co';
const KEY = 'sb_publishable_abcdefghijklmnop';
const LOCAL_URL = 'http://127.0.0.1:54321';

function csp(connect: string): string {
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src ${connect}; worker-src 'self' blob:; child-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`;
}

function expected(connect: string, production: boolean): string {
  return [
    '/*',
    `  Content-Security-Policy: ${csp(connect)}`,
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

test('renderHeaders: exact output in production, local and with accounts off', () => {
  const tiles = "'self' https://tiles.openfreemap.org";
  assert.equal(renderHeaders(ORIGIN, true), expected(`${tiles} ${ORIGIN}`, true));
  assert.equal(renderHeaders(LOCAL_URL, false), expected(`${tiles} ${LOCAL_URL}`, false));
  assert.equal(renderHeaders(null, true), expected(tiles, true));
  assert.equal(renderHeaders(null, false), expected(tiles, false));
  assert.ok(!renderHeaders(null, true).includes('supabase'));
});

test('renderHeaders: the root block equals securityHeaders entry by entry', () => {
  for (const origin of [ORIGIN, null]) {
    for (const production of [true, false]) {
      assert.deepEqual(rootBlock(renderHeaders(origin, production)), Object.entries(securityHeaders(production, origin)));
    }
  }
});

test('renderHeaders: a value can never add a line or a rule', () => {
  assert.throws(() => renderHeaders('https://abc.supabase.co\n/*', true), siteError('headers'));
  assert.throws(() => renderHeaders('https://abc.supabase.co\r', true), siteError('headers'));
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

test('siteSettings: production needs https and a publishable key', () => {
  const ok = siteSettings({ SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'true' }, 'production');
  assert.deepEqual(ok, { mode: 'production', supabase: { url: ORIGIN, origin: ORIGIN, publishableKey: KEY }, accounts: true });
  assert.throws(() => siteSettings({ SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY }, 'production'), envError('SUPABASE_URL'));
  assert.throws(() => siteSettings({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY }, 'production'), envError('SUPABASE_URL'));
  for (const mode of ['production', 'local'] as const) {
    assert.throws(() => siteSettings({ SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: 'sb_secret_abcdefghijklmnop' }, mode), envError('SUPABASE'));
  }
});

test('siteSettings: local http only in local mode, Supabase values required even with accounts off', () => {
  const local = siteSettings({ SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'false' }, 'local');
  assert.equal(local.supabase.origin, LOCAL_URL);
  assert.equal(local.accounts, false);
  assert.throws(() => siteSettings({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY }, 'local'), envError('SUPABASE_URL'));
  assert.throws(() => siteSettings({ ACCOUNTS_ENABLED: 'false' }, 'local'), envError('SUPABASE'));
  assert.throws(() => siteSettings({ SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'yes' }, 'local'), envError('ACCOUNTS_ENABLED'));
});

test('wranglerVars: only the three vars, empty values fail closed', () => {
  const env = wranglerVars(JSON.stringify({ name: 'x', vars: { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ACCOUNTS_ENABLED: 'false', OTHER: 'x' } }));
  assert.deepEqual(env, { SUPABASE_URL: '', SUPABASE_PUBLISHABLE_KEY: '', ACCOUNTS_ENABLED: 'false' });
  assert.throws(() => siteSettings(env, 'production'), envError('SUPABASE'));
  const filled = wranglerVars(JSON.stringify({ vars: { SUPABASE_URL: ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'false' } }));
  assert.equal(siteSettings(filled, 'production').accounts, false);
  assert.throws(() => wranglerVars(JSON.stringify({ vars: { ACCOUNTS_ENABLED: true } })), envError('ACCOUNTS_ENABLED'));
  assert.throws(() => wranglerVars('{"vars": '), siteError('wrangler.json'));
  assert.throws(() => wranglerVars(JSON.stringify({ vars: [] })), siteError('wrangler.json'));
  assert.throws(() => wranglerVars(JSON.stringify({})), siteError('wrangler.json'));
  assert.throws(() => wranglerVars(' '.repeat(65537)), siteError('wrangler.json'));
});

// The built script runs in a temporary copy of the project, so the real site/ is never touched.
const DIST = fileURLToPath(new URL('../', import.meta.url));
const REAL_THEME = fileURLToPath(new URL('../../public/theme.js', import.meta.url));
const VENDOR_SOURCES = [
  'maplibre-gl/dist/maplibre-gl.mjs',
  'maplibre-gl/dist/maplibre-gl-worker.mjs',
  'maplibre-gl/dist/maplibre-gl.css',
  '@supabase/supabase-js/dist/umd/supabase.js',
];
const SITE_FILES = [
  '_headers',
  'client-config.json',
  'data/campus.geojson',
  'index.html',
  'theme.js',
  'vendor/licenses.txt',
  'vendor/maplibre-gl-worker.mjs',
  'vendor/maplibre-gl.css',
  'vendor/maplibre-gl.mjs',
  'vendor/supabase.js',
];
const LOCAL_ENV = { SUPABASE_URL: LOCAL_URL, SUPABASE_PUBLISHABLE_KEY: KEY, ACCOUNTS_ENABLED: 'true' };

function put(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

function wranglerJson(url: string, key: string, accounts: string): string {
  return JSON.stringify({ name: 'aule-unical', vars: { SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, ACCOUNTS_ENABLED: accounts } });
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
  put(root, 'public/index.html', '<!doctype html>');
  copyFileSync(REAL_THEME, join(root, 'public/theme.js'));
  put(root, 'public/data/campus.geojson', '{}');
  put(root, 'public/.env', 'SUPABASE_PUBLISHABLE_KEY=x');
  put(root, 'public/data/.DS_Store', 'x');
  put(root, 'outside.txt', 'outside');
  symlinkSync(join(root, 'outside.txt'), join(root, 'public/data/link.txt'));
  put(root, 'wrangler.json', wranglerJson('', '', 'false'));
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
    assert.deepEqual(listFiles(site), SITE_FILES);
    assert.deepEqual(readFileSync(join(site, 'theme.js')), readFileSync(REAL_THEME));
    assert.equal(readFileSync(join(site, '_headers'), 'utf8'), renderHeaders(LOCAL_URL, false));
    assert.equal(
      readFileSync(join(site, 'client-config.json'), 'utf8'),
      renderClientConfig({ url: LOCAL_URL, origin: LOCAL_URL, publishableKey: KEY }, true),
    );
  });
});

test('build CLI: production reads wrangler.json, accounts off leaves no Supabase value in site/', () => {
  withProject((root) => {
    put(root, 'wrangler.json', wranglerJson(ORIGIN, KEY, 'false'));
    assert.equal(build(root, ['--mode', 'production'], LOCAL_ENV).status, 0);
    const site = join(root, 'site');
    assert.equal(readFileSync(join(site, 'client-config.json'), 'utf8'), '{"features":{"accounts":false}}');
    assert.equal(readFileSync(join(site, '_headers'), 'utf8'), renderHeaders(null, true));
    for (const file of listFiles(site)) {
      const text = readFileSync(join(site, file), 'utf8');
      assert.ok(!text.includes(ORIGIN) && !text.includes(KEY) && !text.includes(LOCAL_URL), file);
    }
    put(root, 'wrangler.json', wranglerJson(ORIGIN, KEY, 'true'));
    assert.equal(build(root, ['--mode', 'production']).status, 0);
    assert.equal(readFileSync(join(site, '_headers'), 'utf8'), renderHeaders(ORIGIN, true));
    assert.equal(
      readFileSync(join(site, 'client-config.json'), 'utf8'),
      renderClientConfig({ url: ORIGIN, origin: ORIGIN, publishableKey: KEY }, true),
    );
  });
});

test('build CLI: a failed build leaves no older site ready to deploy', () => {
  withProject((root) => {
    const site = join(root, 'site');
    assert.equal(build(root, ['--mode', 'local'], LOCAL_ENV).status, 0);
    assert.deepEqual(build(root, ['--mode', 'production']), { status: 1, stderr: 'SUPABASE' });
    assert.deepEqual(listFiles(site), []);

    assert.equal(build(root, ['--mode', 'local'], LOCAL_ENV).status, 0);
    put(root, 'public/_redirects', '/* https://elsewhere.example 302');
    assert.deepEqual(build(root, ['--mode', 'local'], LOCAL_ENV), { status: 1, stderr: 'public' });
    assert.deepEqual(listFiles(site), []);
  });
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
