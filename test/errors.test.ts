import { test } from 'node:test';
import assert from 'node:assert/strict';

interface ErrorsModule {
  errorCode(error: unknown, status?: number | null): string;
  MESSAGES: Readonly<Record<string, string>>;
  REPORT_MESSAGES: Readonly<Record<string, string>>;
  messageFor(code: unknown, overrides?: Record<string, string>, fallback?: string): string;
}

const { errorCode, MESSAGES, REPORT_MESSAGES, messageFor } = (await import(
  new URL('../../public/errors.js', import.meta.url).href
)) as ErrorsModule;

// The browser list of the contract (2.9), written here again on purpose.
const BROWSER_CODES = [
  'invalid',
  'window',
  'duplicate',
  'rate_limited',
  'too_many_pending',
  'not_pending',
  'own_request',
  'own_role',
  'expired',
  'not_found',
  'user_missing',
  'no_lesson',
  'too_soon',
  'calendar_exists',
  'calendar_missing',
  'too_many_calendars',
  'too_many_sources',
  'too_many_rooms',
  'too_many_buildings',
  'too_many_links',
  'unknown_building',
  'calendar_ref',
  'feed_ref',
  'label',
  'building_name',
  'source_url',
  'floor',
  'floor_count',
  'base_level',
];

test('known P0001 messages pass through as codes', () => {
  for (const code of BROWSER_CODES) {
    assert.equal(errorCode({ code: 'P0001', message: code, details: null, hint: null }, 400), code);
  }
});

test('unknown P0001 messages, internal and other errors become upstream_error', () => {
  for (const message of ['internal', 'payload_shape', 'run_open', 'Invalid', 'invalid ', 'constructor', 'toString', '']) {
    assert.equal(errorCode({ code: 'P0001', message }, 400), 'upstream_error');
  }
  assert.equal(errorCode({ code: 'XX000', message: 'invalid' }, 500), 'upstream_error');
  assert.equal(errorCode({ code: '22P02', message: 'invalid input syntax' }, 400), 'upstream_error');
  assert.equal(errorCode({ message: '<html>' }, 200), 'upstream_error');
  assert.equal(errorCode(null, 503), 'upstream_error');
});

test('42501 is forbidden whatever the status', () => {
  assert.equal(errorCode({ code: '42501', message: 'forbidden' }, 403), 'forbidden');
  assert.equal(errorCode({ code: '42501', message: 'permission denied for function admin_overview' }, 401), 'forbidden');
});

test('401 with an expired or invalid token is unauthorized, other 401 are not', () => {
  for (const code of ['PGRST301', 'PGRST302', 'PGRST303']) {
    assert.equal(errorCode({ code, message: 'JWT expired' }, 401), 'unauthorized');
  }
  assert.equal(errorCode({ code: 'PGRST300', message: 'x' }, 401), 'upstream_error');
  assert.equal(errorCode({ code: 'PGRST3011', message: 'x' }, 401), 'upstream_error');
  assert.equal(errorCode({ code: 'PGRST301', message: 'x' }, 400), 'upstream_error');
  assert.equal(errorCode({ message: 'x' }, 401), 'upstream_error');
});

test('no status is a network error', () => {
  assert.equal(errorCode({ code: '', message: 'AbortError: signal timed out' }, 0), 'network');
  assert.equal(errorCode({ code: 'P0001', message: 'duplicate' }, 0), 'network');
  assert.equal(errorCode(null, undefined), 'network');
  assert.equal(errorCode(undefined, null), 'network');
});

test('every code a page can see has an Italian message', () => {
  for (const code of [...BROWSER_CODES, 'network', 'unauthorized', 'forbidden', 'accounts_disabled', 'upstream_error']) {
    const text = MESSAGES[code] ?? '';
    assert.ok(text.length > 0 && text.length <= 200, code);
    assert.ok(!text.includes('\u2014'), code);
  }
  for (const text of Object.values(REPORT_MESSAGES)) assert.ok(text.length > 0 && !text.includes('\u2014'));
});

test('messageFor prefers overrides, then MESSAGES, then the fallback', () => {
  assert.equal(messageFor('forbidden', REPORT_MESSAGES), REPORT_MESSAGES.forbidden);
  assert.notEqual(REPORT_MESSAGES.forbidden, MESSAGES.forbidden);
  assert.equal(messageFor('duplicate', REPORT_MESSAGES), MESSAGES.duplicate);
  assert.equal(messageFor('label'), MESSAGES.label);
  assert.equal(messageFor('no_such_code'), 'Operazione non riuscita.');
  assert.equal(messageFor('no_such_code', REPORT_MESSAGES, 'Segnalazione non inviata, riprova.'), 'Segnalazione non inviata, riprova.');
  assert.equal(messageFor(undefined, {}, 'fallback'), 'fallback');
  assert.equal(messageFor('constructor'), 'Operazione non riuscita.');
  assert.equal(messageFor('__proto__', REPORT_MESSAGES), 'Operazione non riuscita.');
});
