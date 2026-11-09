import { open, rename, unlink, readFile, mkdir, copyFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

// Write to a temp file, flush it, then rename: readers see the old file or the new one, never half of it.
export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8');
    await handle.sync();
  } catch (err) {
    await handle.close();
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export type JsonRead = { kind: 'missing' } | { kind: 'ok'; value: unknown } | { kind: 'corrupt' };

export async function readJsonFile(path: string): Promise<JsonRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing' };
    throw err;
  }
  try {
    return { kind: 'ok', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'corrupt' };
  }
}

export async function backupCorrupt(path: string): Promise<string> {
  const target = `${path}.corrupt-${Date.now()}`;
  await copyFile(path, target);
  return target;
}
