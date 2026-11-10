// The timetable is a JSON object literal assigned to one constant of the app page. It is cut out with a bracket
// counter that knows JSON strings and read with JSON.parse: never eval, Function or a JavaScript parser.
import { DimesError } from './codes.js';

export const MARKER = 'const DATI_INCORPORATI = ';
export const JSON_MAX_CHARS = 1_500_000;
const MAX_DEPTH = 64;

// Personal or useless fields, dropped while parsing so nothing after JSON.parse ever sees them. Teachers go too:
// this source keeps only courses, years, titles, days, times and rooms.
const DROPPED: ReadonlySet<string> = new Set([
  'docenti',
  'docente',
  'docenteResp',
  'docentiLiberi',
  'etichetta',
  'cognome',
  'cf',
  'codiceFiscale',
  'codice_fiscale',
  'email',
  'mail',
  'pec',
  'telefono',
  'vincoli',
  'fonteVincoli',
  'indisponibilita',
  'note',
  'nota',
  'avvisi',
  'docentiSenzaRisposta',
  'studenti',
  'fonteStudenti',
  'studentiDichiarati',
  'sorgenti',
  'sorgentiPercorsi',
  'foglioProgrammazione',
  'finestre',
]);

export function extractLiteral(html: string): string {
  const at = html.indexOf(MARKER);
  if (at < 0) throw new DimesError('no_marker');
  if (html.indexOf(MARKER, at + 1) >= 0) throw new DimesError('many_markers');
  const start = at + MARKER.length;
  if (html.startsWith('null', start)) throw new DimesError('null_data');
  if (html.charCodeAt(start) !== 123) throw new DimesError('bad_literal');
  const stop = Math.min(html.length, start + JSON_MAX_CHARS);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stop; i++) {
    const c = html.charCodeAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (c === 92) escaped = true;
      else if (c === 34) inString = false;
      continue;
    }
    if (c === 34) inString = true;
    else if (c === 123 || c === 91) {
      if (++depth > MAX_DEPTH) throw new DimesError('bad_literal');
    } else if (c === 125 || c === 93) {
      if (--depth > 0) continue;
      if (c !== 125 || html.charCodeAt(i + 1) !== 59) throw new DimesError('bad_literal');
      return html.slice(start, i + 1);
    }
  }
  throw new DimesError(stop < html.length ? 'json_too_large' : 'bad_literal');
}

export function parseLiteral(literal: string): unknown {
  try {
    return JSON.parse(literal, (key, value: unknown) => (DROPPED.has(key) ? undefined : value)) as unknown;
  } catch {
    throw new DimesError('bad_json');
  }
}

export function extractDataset(html: string): unknown {
  return parseLiteral(extractLiteral(html));
}
