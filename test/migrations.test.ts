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

// pg_temp is searched first for type and table names even with search_path = '': in the functions the aule_sync
// login reaches, every type name the parser looks up must carry its schema. Only grammar keywords always mean the
// pg_catalog type. Checked on the local PostgreSQL 17 with pg_temp domains that check false: bigint, integer,
// numeric, interval and double precision, cast or declared, stay pg_catalog, while int8, bool, text, oid, tstzrange
// and a record variable hit the domain. json (a keyword only since 16), time, timestamp and varchar stay flagged:
// qualifying them costs nothing.
const KEYWORD_TYPES = new Set([
  'bigint', 'int', 'integer', 'smallint', 'boolean', 'numeric', 'decimal', 'dec', 'real', 'float', 'double',
  'interval', 'char', 'character', 'nchar', 'national', 'bit',
]);
// Words that may come right before a string literal without being its type, string prefixes included.
const BEFORE_LITERAL = new Set([
  'select', 'then', 'else', 'when', 'case', 'return', 'returning', 'raise', 'exception', 'notice', 'warning', 'info',
  'log', 'debug', 'sqlstate', 'from', 'like', 'ilike', 'similar', 'to', 'escape', 'and', 'or', 'not', 'is', 'in', 'by',
  'using', 'values', 'between', 'execute', 'perform', 'into', 'set', 'as', 'zone', 'distinct', 'all', 'any', 'some',
  'where', 'having', 'on', 'default', 'limit', 'offset', 'precision', 'varying', 'e', 'b', 'x', 'n',
]);
// Declarations without a type: name alias for $1, name [no] scroll cursor for ...
const NOT_A_TYPE = new Set(['alias', 'cursor', 'scroll', 'no']);
const NAME = String.raw`(?:"(?:[^"]|"")+"|[A-Za-z_][\w$]*)`;
const SYNC_FUNCTION = /^(?:aule_sync\.[a-z_][a-z0-9_]*|aule\.refresh_timetable)$/;

// Name and dollar quoted body of every function, comments removed.
function functionBodies(sql: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const start = /\bcreate\s+(?:or\s+replace\s+)?function\s+("?[A-Za-z_][\w$]*"?(?:\s*\.\s*"?[A-Za-z_][\w$]*"?)?)\s*\(/gi;
  let match: RegExpExecArray | null;
  while ((match = start.exec(sql)) !== null) {
    const rest = sql.slice(match.index);
    const body = /\bas\s+(\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$)/i.exec(rest);
    if (!body?.[1]) continue;
    const open = body.index + body[0].length;
    const close = rest.indexOf(body[1], open);
    const name = (match[1] ?? '').replace(/["\s]/g, '').toLowerCase();
    out.push({ name, body: close < 0 ? rest.slice(open) : rest.slice(open, close) });
  }
  return out;
}

function needsSchema(name: string): boolean {
  return name.startsWith('"') || !KEYWORD_TYPES.has(name.toLowerCase());
}

// Text inside the parentheses opened just before start.
function inside(code: string, start: number): string {
  let depth = 1;
  for (let i = start; i < code.length; i++) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')' && --depth === 0) return code.slice(start, i);
  }
  return code.slice(start);
}

// Casts, cast(... as type), typed literals and declarations whose type is neither qualified nor a keyword.
function unqualifiedTypes(body: string): string[] {
  const code = withoutComments(body).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/'(?:[^']|'')*'/g, "''");
  const found: string[] = [];
  for (const m of code.matchAll(new RegExp(String.raw`::\s*(${NAME})(\s*\.)?`, 'g'))) {
    if (!m[2] && needsSchema(m[1]!)) found.push(`::${m[1]}`);
  }
  const lastAs = new RegExp(String.raw`\bas\s+(${NAME})(\s*\.)?`, 'gi');
  for (const m of code.matchAll(/\bcast\s*\(/gi)) {
    const as = [...inside(code, m.index + m[0].length).matchAll(lastAs)].at(-1);
    if (as && !as[2] && needsSchema(as[1]!)) found.push(`as ${as[1]})`);
  }
  for (const m of code.matchAll(new RegExp(String.raw`(?<![.\w$"])(${NAME})\s*''`, 'g'))) {
    if (!BEFORE_LITERAL.has(m[1]!.toLowerCase()) && needsSchema(m[1]!)) found.push(`${m[1]} ''`);
  }
  const declaration = new RegExp(String.raw`^\s*[A-Za-z_][\w$]*\s+(?:constant\s+)?(${NAME})(\s*\.)?(%\s*type\b)?`, 'i');
  for (const block of code.matchAll(/\bdeclare\b([\s\S]*?)\bbegin\b/gi)) {
    for (const statement of (block[1] ?? '').split(';')) {
      const m = declaration.exec(statement);
      if (!m || m[2] || m[3] || NOT_A_TYPE.has(m[1]!.toLowerCase())) continue;
      if (needsSchema(m[1]!)) found.push(m[0].replace(/\s+/g, ' ').trim());
    }
  }
  return found;
}

// The newest definition of each function wins, as in the database.
function syncFunctions(): Map<string, { file: string; body: string }> {
  const out = new Map<string, { file: string; body: string }>();
  for (const m of migrations()) {
    for (const f of functionBodies(withoutComments(m.text))) {
      if (SYNC_FUNCTION.test(f.name)) out.set(f.name, { file: m.name, body: f.body });
    }
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

test('no unqualified type name in the functions the sync login reaches', () => {
  const functions = syncFunctions();
  for (const name of ['aule.refresh_timetable', 'aule_sync.sync_begin', 'aule_sync.sync_put_calendar', 'aule_sync.sync_finish']) {
    assert.ok(functions.has(name), name);
  }
  const problems: string[] = [];
  for (const [name, f] of functions) {
    const found = [...new Set(unqualifiedTypes(f.body))];
    if (found.length > 0) problems.push(`${f.file} ${name}: ${found.join(', ')}`);
  }
  assert.deepEqual(problems, []);
});

test('the type lint catches casts, typed literals and declarations, not keywords, qualified names or strings', () => {
  const body = `
declare
  v_a bigint;
  v_b pg_catalog.int8;
  v_c constant text := 'x';
  v_d aule.settings%rowtype;
  v_e pg_catalog.date;
  v_g integer;
  v_h boolean;
  v_i int8;
  v_j "char";
  v_k double precision;
  v_m settings%rowtype;
  v_n v_a%type;
  r record;
  c no scroll cursor for select 1;
  v_o alias for $1;
begin
  perform x::jsonb, y::pg_catalog.text, cast(z as uuid), cast(w as pg_catalog.numeric), date '2026-01-01';
  perform 1::bigint, 2::int, 3::smallint, true::boolean, 4::numeric(5, 2), 5::real, 6::decimal, 7::double precision;
  perform t::timestamptz, u::bool[], v::"char", w::"text", cast(s as name), b::bytea, r::regclass, q::pg_catalog."char";
  perform x::tstzrange, y::oid, cast(z as regtype[]), int4range '[1,2)', cast((select 1 as n) as integer), (select 2 as m);
  perform interval '1 hour', E'\\t', t at time zone 'Europe/Rome', pg_catalog.timestamptz 'epoch';
  raise exception 'x' using errcode = 'P0001';
  perform 'a::text cast(b as date)', u.text, r.date = '', v.textual, w::texts;
  -- c::text
  /* d::jsonb */
  declare
    v_f integer[];
    v_l text[];
  begin
    null;
  end;
end`;
  assert.deepEqual(unqualifiedTypes(body), [
    '::jsonb', '::timestamptz', '::bool', '::"char"', '::"text"', '::bytea', '::regclass', '::tstzrange', '::oid', '::texts',
    'as uuid)', 'as name)', 'as regtype)',
    "date ''", "int4range ''",
    'v_c constant text', 'v_i int8', 'v_j "char"', 'v_m settings', 'r record', 'v_l text',
  ]);
  const sql = withoutComments(
    "create function aule_sync.a(p text) returns text language sql set search_path = '' as $$ select p::text $$;\n" +
      "create or replace function aule.refresh_timetable() returns void language plpgsql as $f$ begin perform 1::int; end $f$;\n" +
      "create function aule.other() returns int language sql set search_path = '' as $$ select 1::int $$;",
  );
  const bodies = functionBodies(sql);
  assert.deepEqual(bodies.map((b) => b.name), ['aule_sync.a', 'aule.refresh_timetable', 'aule.other']);
  assert.deepEqual(bodies.map((b) => SYNC_FUNCTION.test(b.name)), [true, true, false]);
  assert.deepEqual(unqualifiedTypes(bodies[0]?.body ?? ''), ['::text']);
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
