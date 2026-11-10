import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csp, securityHeaders } from '../src/http/headers.js';

const ORIGIN = 'https://abc.supabase.co';
const SECURITY = [
  'Content-Security-Policy',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'X-Frame-Options',
  'Cross-Origin-Opener-Policy',
  'Cross-Origin-Resource-Policy',
  'Permissions-Policy',
];

function directive(policy: string, name: string): string[] {
  const found = policy.split('; ').filter((d) => d.split(' ')[0] === name);
  assert.equal(found.length, 1, name);
  return found[0]!.split(' ').slice(1);
}

test('connect-src lists self, the tiles and the given Supabase origin only', () => {
  assert.deepEqual(directive(csp(ORIGIN), 'connect-src'), ["'self'", 'https://tiles.openfreemap.org', ORIGIN]);
  assert.deepEqual(directive(csp(null), 'connect-src'), ["'self'", 'https://tiles.openfreemap.org']);
});

test('the policy keeps every source same origin', () => {
  const policy = csp(ORIGIN);
  assert.deepEqual(directive(policy, 'default-src'), ["'self'"]);
  assert.deepEqual(directive(policy, 'script-src'), ["'self'"]);
  assert.deepEqual(directive(policy, 'style-src'), ["'self'"]);
  assert.deepEqual(directive(policy, 'font-src'), ["'self'"]);
  assert.deepEqual(directive(policy, 'object-src'), ["'none'"]);
  assert.deepEqual(directive(policy, 'base-uri'), ["'none'"]);
  assert.deepEqual(directive(policy, 'frame-ancestors'), ["'none'"]);
  assert.equal(policy.split('; ').length, 12);
  assert.ok(!policy.includes('unsafe'));
});

test('all 7 security headers, HSTS only in production', () => {
  const local = securityHeaders(false, null);
  assert.deepEqual(Object.keys(local), SECURITY);
  assert.equal(local['Content-Security-Policy'], csp(null));
  assert.equal(local['X-Content-Type-Options'], 'nosniff');
  assert.equal(local['Referrer-Policy'], 'no-referrer');
  assert.equal(local['X-Frame-Options'], 'DENY');
  assert.equal(local['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(local['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(local['Permissions-Policy'], 'camera=(), microphone=(), geolocation=(self), payment=()');
  const production = securityHeaders(true, ORIGIN);
  assert.deepEqual(Object.keys(production), [...SECURITY, 'Strict-Transport-Security']);
  assert.equal(production['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(production['Content-Security-Policy'], csp(ORIGIN));
});
