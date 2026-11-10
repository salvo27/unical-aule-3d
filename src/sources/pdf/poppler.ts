// Runs poppler on an untrusted PDF: execFile with fixed arguments (never a shell), time and size limits,
// a private temporary folder removed in any case. Returns words and table rules per page.
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfError } from './codes.js';
import { parseBbox, rectRules, type Page, type Rules } from './grid.js';

export const MAX_PDF_BYTES = 5_000_000;
export const MAX_PAGES = 16;
export const MAX_WORDS_PER_PAGE = 6_000;
const MAX_TEXT_OUTPUT = 20_000_000;
const MAX_SVG_BYTES = 20_000_000;
const CALL_TIMEOUT_MS = 30_000;
const FILE_DEADLINE_MS = 90_000;
// Fixed places only: a PATH set by an earlier step must not choose the binary.
const POPPLER_DIRS = ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];

export interface PopplerBin {
  pdftotext: string;
  pdftocairo: string;
}

let found: Promise<PopplerBin | null> | null = null;

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function popplerBin(): Promise<PopplerBin | null> {
  found ??= (async () => {
    for (const dir of POPPLER_DIRS) {
      const bin = { pdftotext: join(dir, 'pdftotext'), pdftocairo: join(dir, 'pdftocairo') };
      if ((await executable(bin.pdftotext)) && (await executable(bin.pdftocairo))) return bin;
    }
    return null;
  })();
  return found;
}

export function isPdf(bytes: Uint8Array): boolean {
  return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2d;
}

interface ExecFailure {
  code?: unknown;
  killed?: boolean;
}

function run(file: string, args: string[], home: string, deadline: number, maxBuffer: number): Promise<string> {
  const timeout = Math.min(CALL_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) return Promise.reject(new PdfError('poppler_timeout'));
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer,
        killSignal: 'SIGKILL',
        windowsHide: true,
        cwd: home,
        // No secret of the sync job reaches the child.
        env: { PATH: '/usr/bin:/bin', HOME: home, LC_ALL: 'C' },
      },
      (err, stdout) => {
        if (!err) return resolve(stdout);
        const e = err as ExecFailure;
        if (e.code === 'ENOENT') reject(new PdfError('poppler_missing'));
        else if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') reject(new PdfError('output_too_large'));
        else if (e.killed) reject(new PdfError('poppler_timeout'));
        else reject(new PdfError('poppler_failed'));
      },
    );
  });
}

export interface ReadPdfOptions {
  maxPages?: number;
  // A layout that draws its tables in another way passes its own reader of the SVG body.
  parseRules?: (svg: string) => Rules;
  bin?: () => Promise<PopplerBin | null>;
}

export async function readPdf(bytes: Uint8Array, options: ReadPdfOptions = {}): Promise<Page[]> {
  if (bytes.length > MAX_PDF_BYTES) throw new PdfError('too_large');
  if (!isPdf(bytes)) throw new PdfError('not_pdf');
  const maxPages = options.maxPages ?? MAX_PAGES;
  const parseRules = options.parseRules ?? ((svg: string) => rectRules(svg));
  const bin = await (options.bin ?? popplerBin)();
  if (!bin) throw new PdfError('poppler_missing');
  const deadline = Date.now() + FILE_DEADLINE_MS;
  const dir = await mkdtemp(join(tmpdir(), 'aule-pdf-'));
  try {
    const pdf = join(dir, 'in.pdf');
    await writeFile(pdf, bytes, { flag: 'wx', mode: 0o600 });
    // One page more than allowed, so a longer file is seen and refused without reading all of it.
    const xhtml = await run(
      bin.pdftotext,
      ['-f', '1', '-l', String(maxPages + 1), '-bbox-layout', '-enc', 'UTF-8', pdf, '-'],
      dir,
      deadline,
      MAX_TEXT_OUTPUT,
    );
    const pages = parseBbox(xhtml, { maxPages, maxWords: MAX_WORDS_PER_PAGE });
    const out: Page[] = [];
    for (let p = 1; p <= pages.length; p += 1) {
      // The SVG comes through stdout, so its limit holds while it is written and nothing grows on disk.
      const svg = await run(bin.pdftocairo, ['-svg', '-f', String(p), '-l', String(p), pdf, '-'], dir, deadline, MAX_SVG_BYTES);
      out.push({ ...pages[p - 1]!, rules: parseRules(svg) });
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
