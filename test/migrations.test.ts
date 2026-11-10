import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const DIR = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));

function migrations(): { name: string; text: string }[] {
  return readdirSync(DIR)
    .filter((name) => /^2026111\d*_[a-z0-9_]+\.sql$/.test(name))
    .sort()
    .map((name) => ({ name, text: readFileSync(DIR + name, 'utf8') }));
}

function withoutComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, '');
}

// Header and trailer of every function, without its body.
function functionHeaders(sql: string): string[] {
  const out: string[] = [];
  const start = /\bcreate\s+(?:or\s+replace\s+)?function\b/gi;
  let match: RegExpExecArray | null;
  while ((match = start.exec(sql)) !== null) {
    const rest = sql.slice(match.index);
    const body = /\bas\s+(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)|\bbegin\s+atomic\b/i.exec(rest);
    if (!body) {
      out.push(rest.slice(0, rest.indexOf(';') + 1 || undefined));
      continue;
    }
    let header = rest.slice(0, body.index);
    const tag = body[1];
    if (tag) {
      const open = body.index + body[0].length;
      const close = rest.indexOf(tag, open);
      const after = close < 0 ? '' : rest.slice(close + tag.length);
      header += ` ${after.slice(0, after.indexOf(';') + 1 || undefined)}`;
    }
    out.push(header);
  }
  return out;
}

test('the new migrations exist', () => {
  const names = migrations().map((m) => m.name);
  assert.ok(names.includes('20261110090000_timetable_schema.sql'));
  assert.ok(names.includes('20261110090100_reference_data.sql'));
});

test('no em dash in the new migrations', () => {
  for (const m of migrations()) assert.ok(!m.text.includes('\u2014'), m.name);
});

test('no interval in days, weeks, months or years', () => {
  const unit = /\b(?:\d+\s*)?(?:days?|weeks?|mons?|months?|years?|decades?|centur(?:y|ies)|millenni(?:um|a)|d|w|y)\b/i;
  for (const m of migrations()) {
    const sql = withoutComments(m.text);
    for (const found of sql.matchAll(/\binterval\s*'([^']*)'|'([^']*)'\s*::\s*interval\b/gi)) {
      const literal = found[1] ?? found[2] ?? '';
      assert.ok(!unit.test(literal), `${m.name}: ${found[0]}`);
    }
    assert.ok(!/\bmake_interval\s*\([^)]*\b(?:years|months|weeks|days)\s*=>/i.test(sql), `${m.name}: make_interval`);
  }
});

test('no calendar day from a timestamptz', () => {
  for (const m of migrations()) {
    const sql = withoutComments(m.text);
    assert.ok(!/\bcurrent_date\b/i.test(sql), `${m.name}: current_date`);
    assert.ok(!/\bnow\s*\(\s*\)\s*::\s*date\b/i.test(sql), `${m.name}: now()::date`);
    assert.ok(!/\bdate_trunc\s*\(\s*'day'/i.test(sql), `${m.name}: date_trunc('day'`);
  }
});

test('every function sets an empty search_path', () => {
  for (const m of migrations()) {
    for (const header of functionHeaders(withoutComments(m.text))) {
      assert.match(header, /\bset\s+search_path\s*=\s*''/i, `${m.name}: ${header.slice(0, 120)}`);
    }
  }
});

test('no dynamic SQL: execute only in grants and revokes', () => {
  for (const m of migrations()) {
    const sql = withoutComments(m.text);
    for (const found of sql.matchAll(/\bexecute\b/gi)) {
      const before = sql.slice(Math.max(0, found.index - 20), found.index);
      const after = sql.slice(found.index + found[0].length, found.index + found[0].length + 10);
      assert.ok(/\b(?:grant|revoke)\s+$/i.test(before) && /^\s+on\b/i.test(after), `${m.name}: ${before}${found[0]}${after}`);
    }
  }
});

test('the lint helpers catch what they must', () => {
  const headers = functionHeaders(
    "create function a() returns int language sql set search_path = '' as $$ select 1 $$;\n" +
      'create or replace function b() returns int language sql as $f$ select 2 $f$;\n' +
      "create function c() returns int as $$ select 3 $$ language sql set search_path = '';",
  );
  assert.equal(headers.length, 3);
  assert.match(headers[0] ?? '', /search_path/);
  assert.doesNotMatch(headers[1] ?? '', /search_path/);
  assert.match(headers[2] ?? '', /search_path/);
});
