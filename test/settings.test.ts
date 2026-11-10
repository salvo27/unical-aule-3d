import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseSettings, accountsFlag, dbSettings, EnvError } from '../src/settings.js';

const KEY = 'sb_publishable_abcdefghijklmnop';
const LOCAL = { allowLocalHttp: true };
const REMOTE = { allowLocalHttp: false };

function envError(name: string): (e: unknown) => boolean {
  return (e) => e instanceof EnvError && e.message === name;
}

test('supabase: missing values throw, never null', () => {
  assert.throws(() => supabaseSettings({}, LOCAL), envError('SUPABASE'));
  assert.throws(() => supabaseSettings({ SUPABASE_URL: ' ', SUPABASE_PUBLISHABLE_KEY: '' }, LOCAL), envError('SUPABASE'));
});

test('supabase: local http only with allowLocalHttp', () => {
  const c = supabaseSettings({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: KEY }, LOCAL);
  assert.deepEqual(c, { url: 'http://127.0.0.1:54321', origin: 'http://127.0.0.1:54321', publishableKey: KEY });
  assert.equal(supabaseSettings({ SUPABASE_URL: 'http://localhost:54321/', SUPABASE_PUBLISHABLE_KEY: KEY }, LOCAL).origin, 'http://localhost:54321');
  assert.equal(supabaseSettings({ SUPABASE_URL: 'http://[::1]:54321', SUPABASE_PUBLISHABLE_KEY: KEY }, LOCAL).origin, 'http://[::1]:54321');
  assert.throws(() => supabaseSettings({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: KEY }, REMOTE), envError('SUPABASE_URL'));
  assert.throws(() => supabaseSettings({ SUPABASE_URL: 'http://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY }, LOCAL), envError('SUPABASE_URL'));
});

test('supabase: https otherwise', () => {
  const c = supabaseSettings({ SUPABASE_URL: ' https://abc.supabase.co ', SUPABASE_PUBLISHABLE_KEY: KEY }, REMOTE);
  assert.deepEqual(c, { url: 'https://abc.supabase.co', origin: 'https://abc.supabase.co', publishableKey: KEY });
});

test('supabase: half or malformed settings throw', () => {
  assert.throws(() => supabaseSettings({ SUPABASE_URL: 'https://abc.supabase.co' }, REMOTE), envError('SUPABASE'));
  assert.throws(() => supabaseSettings({ SUPABASE_PUBLISHABLE_KEY: KEY }, REMOTE), envError('SUPABASE'));
  assert.throws(() => supabaseSettings({ SUPABASE_URL: `https://${'a'.repeat(200)}.co`, SUPABASE_PUBLISHABLE_KEY: KEY }, REMOTE), envError('SUPABASE'));
  for (const url of [
    'http://evil.example',
    'https://abc.supabase.co/path',
    'https://user:pw@abc.supabase.co',
    'https://abc.supabase.co/?x=1',
    'https://abc.supabase.co?',
    'https://abc.supabase.co#top',
    'ftp://abc.supabase.co',
    'not a url',
    'https://abc.supabase.co/%2e',
  ]) {
    assert.throws(() => supabaseSettings({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: KEY }, LOCAL), EnvError, url);
  }
});

test('supabase: secret and legacy JWT keys are refused', () => {
  assert.throws(() => supabaseSettings({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_shouldnotbehere' }, REMOTE), envError('SUPABASE'));
  const payload = Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url');
  const legacy = `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlc2lnbmF0dXJl`;
  assert.throws(() => supabaseSettings({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: legacy }, REMOTE), envError('SUPABASE'));
  assert.throws(() => supabaseSettings({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_short' }, REMOTE), envError('SUPABASE'));
});

test('accountsFlag: only true and false', () => {
  assert.equal(accountsFlag({ ACCOUNTS_ENABLED: 'true' }), true);
  assert.equal(accountsFlag({ ACCOUNTS_ENABLED: 'false' }), false);
  assert.equal(accountsFlag({}), false);
  assert.equal(accountsFlag({ ACCOUNTS_ENABLED: '' }), false);
  for (const raw of ['TRUE', '1', 'yes', ' true', 'on']) {
    assert.throws(() => accountsFlag({ ACCOUNTS_ENABLED: raw }), envError('ACCOUNTS_ENABLED'), raw);
  }
});

const PASSWORD = 'local-pass-1234';
const CERT = '-----BEGIN CERTIFICATE-----\nTUlJQmZha2VjZXJ0aWZpY2F0ZWZvcnRlc3Rz\nQUFBQUFBQUFBQUFBQUFB\n-----END CERTIFICATE-----\n';

function local(extra: Record<string, string> = {}): Record<string, string> {
  return { SYNC_DB_HOST: '127.0.0.1', SYNC_DB_USER: 'aule_sync', SYNC_DB_PASSWORD: PASSWORD, ...extra };
}

function remote(extra: Record<string, string> = {}): Record<string, string> {
  return { SYNC_DB_HOST: 'db.example.com', SYNC_DB_USER: 'aule_sync.abcdefghijklmnopqrst', SYNC_DB_PASSWORD: PASSWORD, ...extra };
}

function noFile(): string | null {
  return null;
}

test('dbSettings: defaults and local host without TLS', () => {
  const read: string[] = [];
  const s = dbSettings(local(), (path) => {
    read.push(path);
    return CERT;
  });
  assert.deepEqual(s, { host: '127.0.0.1', port: 5432, user: 'aule_sync', password: PASSWORD, database: 'postgres', tls: null });
  assert.deepEqual(read, []);
  assert.equal(dbSettings(local({ SYNC_DB_HOST: 'localhost', SYNC_DB_PORT: '54322' }), noFile).port, 54322);
  assert.equal(dbSettings(local({ SYNC_DB_HOST: '::1', SYNC_DB_PORT: '', SYNC_DB_NAME: '' }), noFile).tls, null);
});

test('dbSettings: remote host reads the default CA file', () => {
  const read: string[] = [];
  const s = dbSettings(remote({ SYNC_DB_PORT: '6543', SYNC_DB_NAME: 'aule' }), (path) => {
    read.push(path);
    return CERT + CERT;
  });
  assert.deepEqual(read, ['config/supabase-ca.crt']);
  assert.deepEqual(s, {
    host: 'db.example.com',
    port: 6543,
    user: 'aule_sync.abcdefghijklmnopqrst',
    password: PASSWORD,
    database: 'aule',
    tls: { ca: CERT + CERT },
  });
  const other: string[] = [];
  dbSettings(remote({ SYNC_DB_CA: '/tmp/ca.pem' }), (path) => {
    other.push(path);
    return CERT;
  });
  assert.deepEqual(other, ['/tmp/ca.pem']);
});

test('dbSettings: remote host without a valid CA throws SYNC_DB_CA', () => {
  assert.throws(() => dbSettings(remote(), noFile), envError('SYNC_DB_CA'));
  assert.throws(() => dbSettings(remote(), () => ''), envError('SYNC_DB_CA'));
  assert.throws(() => dbSettings(remote(), () => 'TUlJQmZha2VjZXJ0aWZpY2F0ZQ==\n'), envError('SYNC_DB_CA'));
  assert.throws(() => dbSettings(remote(), () => CERT.repeat(6)), envError('SYNC_DB_CA'));
  assert.equal(dbSettings(remote(), () => CERT.repeat(5)).tls?.ca, CERT.repeat(5));
  assert.throws(() => dbSettings(remote(), () => CERT + '-----BEGIN PRIVATE KEY-----\nQUFB\n-----END PRIVATE KEY-----\n'), envError('SYNC_DB_CA'));
  assert.throws(() => dbSettings(remote(), () => CERT + 'A'.repeat(20000)), envError('SYNC_DB_CA'));
  assert.throws(() => dbSettings(remote(), () => CERT.replace('QUFB', 'QUFBè')), envError('SYNC_DB_CA'));
  assert.throws(() => dbSettings(remote({ SYNC_DB_CA: 'x'.repeat(301) }), () => CERT), envError('SYNC_DB_CA'));
});

test('dbSettings: host, port, user and name rules', () => {
  for (const host of ['', 'db example.com', 'db..example.com', '-db.example.com', 'db_1.example.com', '::2', 'a'.repeat(254)]) {
    assert.throws(() => dbSettings(local({ SYNC_DB_HOST: host }), noFile), envError('SYNC_DB_HOST'), host);
  }
  assert.throws(() => dbSettings({ SYNC_DB_USER: 'aule_sync', SYNC_DB_PASSWORD: PASSWORD }, noFile), envError('SYNC_DB_HOST'));
  for (const port of ['0', '65536', '-1', '54 32', '5432x', '123456', '1.5']) {
    assert.throws(() => dbSettings(local({ SYNC_DB_PORT: port }), noFile), envError('SYNC_DB_PORT'), port);
  }
  assert.equal(dbSettings(local({ SYNC_DB_PORT: '65535' }), noFile).port, 65535);
  for (const user of ['', 'Aule_sync', '1aule', 'aule-sync', 'aule_sync.', 'aule_sync.ABC', `aule_sync.${'a'.repeat(41)}`, 'a.b.c']) {
    assert.throws(() => dbSettings(local({ SYNC_DB_USER: user }), noFile), envError('SYNC_DB_USER'), user);
  }
  assert.equal(dbSettings(local({ SYNC_DB_USER: `aule_sync.${'a'.repeat(40)}` }), noFile).user, `aule_sync.${'a'.repeat(40)}`);
  for (const name of ['Postgres', 'post-gres', '9db', 'a'.repeat(64)]) {
    assert.throws(() => dbSettings(local({ SYNC_DB_NAME: name }), noFile), envError('SYNC_DB_NAME'), name);
  }
});

test('dbSettings: the password never appears in the error', () => {
  const secrets = ['short', 'x'.repeat(201), 'bad\npassword-value', 'bad\u0000password-value', 'bad\u0085password-value'];
  for (const password of secrets) {
    assert.throws(
      () => dbSettings(local({ SYNC_DB_PASSWORD: password }), noFile),
      (e: unknown) => e instanceof EnvError && e.message === 'SYNC_DB_PASSWORD' && !String(e.stack).includes(password),
    );
  }
  assert.throws(() => dbSettings(local({ SYNC_DB_PASSWORD: '' }), noFile), envError('SYNC_DB_PASSWORD'));
  assert.equal(dbSettings(local({ SYNC_DB_PASSWORD: 'with spaces ok' }), noFile).password, 'with spaces ok');
  assert.throws(
    () => dbSettings(remote(), noFile),
    (e: unknown) => e instanceof EnvError && !String(e.stack).includes(PASSWORD),
  );
});
