import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderXlsxFeeds } from '../scripts/gen-xlsx-feeds-sql.js';
import { loadDiamConfig } from '../src/sources/xlsx/config.js';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

function run(script: string, args: string[]) {
  const result = spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30_000 });
  return { status: result.status, stderr: result.stderr.trim() };
}

function withLink(name: string, check: (dir: string, link: string, direct: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aule-gen-'));
    try {
      const direct = join(SCRIPTS, name);
      const link = join(dir, `link-${name}`);
      symlinkSync(direct, link);
      await check(dir, link, direct);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'gen-xlsx-feeds-sql: started through a symbolic link it still runs, fails closed and writes the same file',
  withLink('gen-xlsx-feeds-sql.js', async (dir, link, direct) => {
    assert.deepEqual(run(link, []), { status: 1, stderr: 'usage' });
    assert.deepEqual(run(link, [join(dir, 'out.txt')]), { status: 1, stderr: 'usage' });
    assert.deepEqual(run(link, [join(dir, 'link.sql')]), { status: 0, stderr: '' });
    assert.deepEqual(run(direct, [join(dir, 'direct.sql')]), { status: 0, stderr: '' });
    const out = readFileSync(join(dir, 'link.sql'), 'utf8');
    assert.equal(out, readFileSync(join(dir, 'direct.sql'), 'utf8'));
    assert.equal(out, renderXlsxFeeds(await loadDiamConfig()));
  }),
);

test(
  'gen-reference-sql: started through a symbolic link it still runs, fails closed and writes the same file',
  withLink('gen-reference-sql.js', (dir, link, direct) => {
    assert.deepEqual(run(link, []), { status: 1, stderr: 'usage' });
    assert.deepEqual(run(link, [join(dir, 'out.sql'), '--unknown']), { status: 1, stderr: 'usage' });
    assert.deepEqual(run(link, [join(dir, 'link.sql')]), { status: 0, stderr: '' });
    assert.deepEqual(run(direct, [join(dir, 'direct.sql')]), { status: 0, stderr: '' });
    const out = readFileSync(join(dir, 'link.sql'), 'utf8');
    assert.equal(out, readFileSync(join(dir, 'direct.sql'), 'utf8'));
    assert.ok(out.includes('-- campus:begin\n') && out.includes('-- campus:end\n'));
  }),
);
