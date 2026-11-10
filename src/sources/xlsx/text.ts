// Text rules shared by the configuration and the layout check of the DIAm workbooks.

export type DiamFileKind = 'LT' | 'LM';
export const FILE_KINDS: readonly DiamFileKind[] = ['LT', 'LM'];

// Degree signs unified, accents and typographic quotes and dashes removed, spaces collapsed, upper case.
export function norm(s: string): string {
  return s
    .replace(/[\u00ba\u00b0]/g, '\u00b0')
    .replace(/[\u2018\u2019\u0060\u00b4]/g, "'")
    .replace(/[\u2013\u2014]/g, '-')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// "Aula B", "AULA B" and "DIAM B" give "B"; "Aula Seminari" gives "SEMINARI".
export function roomAlias(text: string): string {
  return norm(text)
    .replace(/^AULA\s+/, '')
    .replace(/^DIAM\s+/, '')
    .replace(/[^A-Z0-9]/g, '');
}

// The -OK suffix is dropped, so removing it from a sheet name never changes a feed id.
export function sheetKey(name: string): string {
  return norm(name).replace(/-OK$/, '');
}

const LT_GRID = /^(III|II|I) ANNO - (AMBIENTE|MARE)$/;
const LM_GRID = /^([12])\u00b0 LM AMBIENTE(-OK)?$/;
const LM_ROOMS = /^AULE-UBICAZIONE(-OK)?$/;

export type SheetRole = { kind: 'grid'; year: number } | { kind: 'rooms' };

// Allowed sheet names after norm; anything else rejects the whole file.
export function sheetRole(file: DiamFileKind, name: string): SheetRole | null {
  const n = norm(name);
  if (file === 'LT') {
    const m = LT_GRID.exec(n);
    return m && m[1] ? { kind: 'grid', year: m[1].length } : null;
  }
  if (LM_ROOMS.test(n)) return { kind: 'rooms' };
  const m = LM_GRID.exec(n);
  return m && m[1] ? { kind: 'grid', year: Number(m[1]) } : null;
}
