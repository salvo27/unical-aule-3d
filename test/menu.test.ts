import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoDay } from '../src/domain/primitives.js';
import { menuFiles, MENU_PAGE } from '../src/menu/files.js';
import { MenuError, monthIndex, parseMenu, type Period } from '../src/menu/parse.js';
import { syncMenu } from '../src/menu/sync.js';
import { silentLogger } from '../src/log.js';

// Same layout as pdftotext -layout of the University's menu files, invented dishes.
const WEEKDAYS = ['LUNEDÌ', 'MARTEDÌ', 'MERCOLEDÌ', 'GIOVEDÌ', 'VENERDÌ', 'SABATO', 'DOMENICA'];
const CODES = [
  ['C', 'C', 'C'],
  ['C', 'C', 'C'],
  ['V', 'V', 'V'],
  ['M', 'PF', 'PF'],
  ['NML', 'NML', 'NML'],
];
const AT = [31, 105, 157];

const put = (line: string, at: number, text: string) => line.padEnd(at) + text;

function row(weekday: string, codes: readonly string[], dishes: readonly string[]): string {
  let line = weekday;
  for (let k = 0; k < 3; k += 1) {
    const code = codes[k]!;
    // NML sits two characters to the left, like in the real files
    if (code) line = put(line, AT[k]! - (code.length - 1), code);
    if (dishes[k]) line = put(line, AT[k]! + 6, dishes[k]!);
  }
  return line;
}

interface PageOptions {
  header?: string;
  meal?: 'PRANZO' | 'CENA';
  days?: number;
  // A first course written on two lines around its row, on this day and row
  wrap?: { day: number; row: number; above: string; below: string };
  // Changes to one row: other codes or dishes ('' leaves a code or a dish out), or no row at all
  edit?: (day: number, row: number) => { codes?: string[]; dishes?: string[]; skip?: boolean } | null;
}

function page(options: PageOptions = {}): string {
  const lines = [put('', 90, options.header ?? 'MENÙ ORDINARIO - Dal 16 Novembre al 22 Novembre')];
  lines.push(`     ${options.meal ?? 'PRANZO'}${' '.repeat(45)}PRIMI PIATTI${' '.repeat(52)}SECONDI PIATTI   0   CONTORNI   0`);
  for (let d = 0; d < (options.days ?? 7); d += 1) {
    for (let r = 0; r < 5; r += 1) {
      const wrapped = options.wrap?.day === d && options.wrap.row === r;
      const edit = options.edit?.(d, r) ?? {};
      if (edit.skip) continue;
      const dishes = edit.dishes ?? [wrapped ? '' : `Primo ${d}${r}`, `Secondo ${d}${r}${r === 1 ? '*' : ''}`, `Contorno ${d}${r}`];
      if (wrapped) lines.push(put('', AT[0]! + 6, options.wrap!.above));
      lines.push(row(r === 2 ? WEEKDAYS[d]! : '', edit.codes ?? CODES[r]!, dishes));
      if (wrapped) lines.push(put('', AT[0]! + 6, options.wrap!.below));
      // A wrapped name leaves no blank line before the next row
      else lines.push('');
    }
  }
  lines.push('* prodotto surgelato/potrebbe contenere prodotto surgelato', '', '', 'C Linea Classica', 'V Linea Vegetariana', 'M Minestra', 'PF Piatto Freddo', 'NML Linea Mediterranea');
  return lines.join('\n') + '\n';
}

const PERIOD: Period = { startsOn: isoDay('2026-11-16'), endsOn: isoDay('2026-12-27') };
const menuError = (code: string) => (err: unknown) => err instanceof MenuError && err.code === code;

test('reads a week of lunch and dinner: line, dish and frozen mark of every course', () => {
  const days = parseMenu([page(), page({ meal: 'CENA' })].join('\f'), PERIOD);
  assert.equal(days.length, 7);
  assert.deepEqual(
    days.map((d) => d.day),
    ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'],
  );
  const thursday = days[3]!;
  assert.deepEqual(thursday.lunch?.first.map((d) => [d.line, d.name]), [
    ['C', 'Primo 30'],
    ['C', 'Primo 31'],
    ['V', 'Primo 32'],
    ['M', 'Primo 33'],
    ['NML', 'Primo 34'],
  ]);
  assert.deepEqual(thursday.lunch?.second[3], { line: 'PF', name: 'Secondo 33', frozen: false });
  assert.deepEqual(thursday.lunch?.second[1], { line: 'C', name: 'Secondo 31', frozen: true });
  assert.deepEqual(thursday.dinner?.side.map((d) => d.line), ['C', 'C', 'V', 'PF', 'NML']);
});

test('a name written above and below its row is joined, also when the next row follows at once', () => {
  const wrap = { day: 2, row: 4, above: 'Tagliatelle integrali con alici, pomodori gialli e ricotta', below: 'stagionata' };
  const [, , wednesday, thursday] = parseMenu(page({ wrap }), PERIOD);
  assert.equal(wednesday!.lunch?.first[4]?.name, 'Tagliatelle integrali con alici, pomodori gialli e ricotta stagionata');
  assert.equal(thursday!.lunch?.first[0]?.name, 'Primo 30');
});

test('the legend under the table is not a dish, and a dish called like it is', () => {
  const text = page({ edit: (d, r) => (d === 0 && r === 3 ? { dishes: ['Minestra di patate', 'Piatto freddo misto', 'Contorno 03'] } : null) });
  assert.equal(parseMenu(text, PERIOD)[0]!.lunch?.first[3]?.name, 'Minestra di patate');
  // A dish typed without the capital letter gets it
  const lower = page({ edit: (d, r) => (d === 0 && r === 0 ? { dishes: ['orzo con curcuma', 'Secondo 00', 'Contorno 00'] } : null) });
  assert.equal(parseMenu(lower, PERIOD)[0]!.lunch?.first[0]?.name, 'Orzo con curcuma');
});

test('a header without the year takes it from the period; a week across the new year too', () => {
  const winter: Period = { startsOn: isoDay('2025-12-15'), endsOn: isoDay('2026-01-11') };
  const days = parseMenu(page({ header: 'MENÙ ORDINARIO - Dal 29 Dicembre al 4 Gennaio' }), winter);
  assert.deepEqual([days[0]!.day, days.at(-1)!.day], ['2025-12-29', '2026-01-04']);
  const written = parseMenu(page({ header: 'MENÙ ORDINARIO - Dal 29 Dicembre al 4 Gennaio 2026' }), winter);
  assert.equal(written[0]!.day, '2025-12-29');
});

test('a first day written wrong is fixed by the Sunday at the end; a misspelt month is still read', () => {
  const feb: Period = { startsOn: isoDay('2026-01-12'), endsOn: isoDay('2026-02-22') };
  assert.equal(parseMenu(page({ header: 'MENÙ ORDINARIO - Dal 3 febbraio al 8 febbraio 2026' }), feb)[0]!.day, '2026-02-02');
  const mar: Period = { startsOn: isoDay('2026-02-23'), endsOn: isoDay('2026-03-29') };
  assert.equal(parseMenu(page({ header: 'MENÙ ORDINARIO - Dal 1 marzo al 8 marzo 2026' }), mar)[0]!.day, '2026-03-02');
  const sep: Period = { startsOn: isoDay('2026-08-03'), endsOn: isoDay('2026-09-13') };
  assert.equal(parseMenu(page({ header: 'MENÙ ORDINARIO - Dal 7 settmbre al 13 settembre' }), sep)[0]!.day, '2026-09-07');
  assert.equal(monthIndex('settmbre'), 8);
  assert.equal(monthIndex('set'), -1);
});

test('days of the first or last week outside the period are left out', () => {
  const short: Period = { startsOn: isoDay('2026-11-16'), endsOn: isoDay('2026-11-19') };
  assert.deepEqual(
    parseMenu(page(), short).map((d) => d.day),
    ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19'],
  );
});

test('anything off the shape is refused rather than guessed', () => {
  // Four rows for a day
  const short = page({ edit: (d, r) => (d === 6 && r === 4 ? { skip: true } : null) });
  assert.throws(() => parseMenu(short, PERIOD), menuError('row_count'));
  // A row missing the code of a column
  const noCode = page({ edit: (d, r) => (d === 2 && r === 2 ? { codes: ['V', '', 'V'] } : null) });
  assert.throws(() => parseMenu(noCode, PERIOD), menuError('bad_row'));
  // A dish missing, with nothing around to complete it
  const empty = page({ edit: (d, r) => (d === 1 && r === 0 ? { dishes: ['', 'Secondo 10', 'Contorno 10'] } : null) });
  assert.throws(() => parseMenu(empty, PERIOD), menuError('bad_dish'));
  // Days out of order
  const swapped = page().replace('MARTEDÌ', 'XX').replace('MERCOLEDÌ', 'MARTEDÌ').replace('XX', 'MERCOLEDÌ');
  assert.throws(() => parseMenu(swapped, PERIOD), menuError('bad_day'));
  // Text that belongs to no row
  const stray = page().replace('* prodotto', 'Nota a caso\n* prodotto');
  assert.throws(() => parseMenu(stray, PERIOD), menuError('stray_text'));
  // A week of another period
  assert.throws(() => parseMenu(page({ header: 'MENÙ ORDINARIO - Dal 16 Marzo al 22 Marzo' }), PERIOD), menuError('outside_period'));
  // Two lunches for the same days
  assert.throws(() => parseMenu([page(), page()].join('\f'), PERIOD), menuError('duplicate_meal'));
  assert.throws(() => parseMenu('\f\f', PERIOD), menuError('no_pages'));
  // A name longer than any real one, written on two lines like the long ones
  const long = page({ wrap: { day: 0, row: 4, above: 'x'.repeat(60), below: 'y'.repeat(60) } });
  assert.throws(() => parseMenu(long, PERIOD), menuError('bad_dish'));
});

const LINKS = `
<h3>Programmazione menu anno 2026:</h3>
<p><a href="https://www.unical.it/media/medias/2025/Menu_mense_Unical_dal_15_dicembre_al_11_gennaio_2026.pdf">15 dicembre 2025 - 11 gennaio</a></p>
<p><a href="/media/medias/2026/Menu_Mense_Unical_dal_16_novembre_al_27_dicembre__2026.pdf">16 novembre - 27 dicembre</a></p>
<p><a href="https://www.unical.it/media/medias/2026/Menu_delivery_Unical_dal_9_novembre_al_27_novembre_2026.pdf">9 novembre - 27 novembre</a></p>
<p><a href="https://example.org/media/medias/2026/Menu_Mense_Unical_dal_1_al_7_2026.pdf">1 gennaio - 7 gennaio</a></p>
<p><a href="https://www.unical.it/media/medias/2026/Menu_Mense_Unical_x_2026.pdf">Il menu</a></p>`;

test('finds the menu files of the canteens and the period of each, year included', () => {
  assert.deepEqual(menuFiles(LINKS), [
    {
      url: 'https://www.unical.it/media/medias/2025/Menu_mense_Unical_dal_15_dicembre_al_11_gennaio_2026.pdf',
      startsOn: '2025-12-15',
      endsOn: '2026-01-11',
    },
    {
      url: 'https://www.unical.it/media/medias/2026/Menu_Mense_Unical_dal_16_novembre_al_27_dicembre__2026.pdf',
      startsOn: '2026-11-16',
      endsOn: '2026-12-27',
    },
  ]);
});

test('stores the files of today and of the next two weeks, and goes on when one fails', async () => {
  const html = LINKS.replace(
    '</p>\n<p><a href="https://www.unical.it/media/medias/2026/Menu_delivery',
    '</p>\n<p><a href="/media/medias/2026/Menu_Mense_Unical_dal_28_dicembre_al_7_febbraio_2027.pdf">28 dicembre - 7 febbraio</a></p>\n<p><a href="https://www.unical.it/media/medias/2026/Menu_delivery',
  );
  const pdf = new TextEncoder().encode('%PDF-1.7 finto');
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    if (href === MENU_PAGE) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return new Response(pdf, { headers: { 'Content-Type': 'application/pdf' } });
  }) as typeof fetch;
  const calls: unknown[] = [];
  const db = {
    async call(fn: string, args?: readonly unknown[]) {
      calls.push([fn, args]);
      return { ok: true };
    },
  };
  // The December file reads, the next one does not: it keeps whatever was stored for it
  const text = async () => (calls.length === 0 ? [page(), page({ meal: 'CENA' })].join('\f') : 'rotto');
  const result = await syncMenu({
    http: { fetchImpl, timeoutMs: 1000 },
    db: db as never,
    log: silentLogger,
    now: () => Date.parse('2026-11-20T10:00:00Z'),
    text,
  });
  assert.deepEqual(result, { stored: 1, failed: 0 });
  assert.equal(calls.length, 1);
  const [fn, args] = calls[0] as [string, [{ startsOn: string; endsOn: string; source: string; days: unknown[] }]];
  assert.equal(fn, 'menu_put');
  assert.deepEqual([args[0].startsOn, args[0].endsOn, args[0].days.length], ['2026-11-16', '2026-12-27', 7]);

  // Later in December both files are due: the broken one is counted as failed, the good one still stored
  calls.length = 0;
  const later = await syncMenu({ http: { fetchImpl, timeoutMs: 1000 }, db: db as never, log: silentLogger, now: () => Date.parse('2026-12-20T10:00:00Z'), text });
  assert.deepEqual(later, { stored: 1, failed: 1 });
});
