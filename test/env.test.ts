import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadAppConfig, EnvError } from '../src/config.js';

const KEY = 'sb_publishable_abcdefghijklmnop';

test('without Supabase values accounts are simply off', () => {
  assert.equal(loadAppConfig({}).supabase, null);
});

test('local Supabase over http is fine in development', () => {
  const c = loadAppConfig({ SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: KEY });
  assert.deepEqual(c.supabase, { url: 'http://127.0.0.1:54321', origin: 'http://127.0.0.1:54321', publishableKey: KEY });
});

test('production needs https', () => {
  assert.throws(() => loadAppConfig({ NODE_ENV: 'production', SUPABASE_URL: 'http://127.0.0.1:54321', SUPABASE_PUBLISHABLE_KEY: KEY }), EnvError);
  const c = loadAppConfig({ NODE_ENV: 'production', SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY });
  assert.equal(c.supabase?.origin, 'https://abc.supabase.co');
});

test('half or malformed settings stop the server', () => {
  assert.throws(() => loadAppConfig({ SUPABASE_URL: 'https://abc.supabase.co' }), EnvError);
  assert.throws(() => loadAppConfig({ SUPABASE_PUBLISHABLE_KEY: KEY }), EnvError);
  assert.throws(() => loadAppConfig({ SUPABASE_URL: 'http://evil.example', SUPABASE_PUBLISHABLE_KEY: KEY }), EnvError);
  assert.throws(() => loadAppConfig({ SUPABASE_URL: 'https://abc.supabase.co/path', SUPABASE_PUBLISHABLE_KEY: KEY }), EnvError);
  assert.throws(() => loadAppConfig({ SUPABASE_URL: 'https://user:pw@abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: KEY }), EnvError);
  assert.throws(() => loadAppConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_shouldnotbehere' }), EnvError);
});

test('legacy JWT keys are refused: they could be the service_role key', () => {
  const payload = Buffer.from(JSON.stringify({ role: 'service_role', iss: 'supabase' })).toString('base64url');
  const legacy = `eyJhbGciOiJIUzI1NiJ9.${payload}.c2lnbmF0dXJlc2lnbmF0dXJl`;
  assert.throws(() => loadAppConfig({ SUPABASE_URL: 'https://abc.supabase.co', SUPABASE_PUBLISHABLE_KEY: legacy }), EnvError);
});

test('SYNC_HOURS: every element must be an hour', () => {
  assert.deepEqual(loadAppConfig({ SYNC_HOURS: '13,6' }).syncHours, [6, 13]);
  assert.throws(() => loadAppConfig({ SYNC_HOURS: '6,13,' }), EnvError);
  assert.throws(() => loadAppConfig({ SYNC_HOURS: ',' }), EnvError);
  assert.throws(() => loadAppConfig({ SYNC_HOURS: '24' }), EnvError);
});
