// Closed codes of the PDF source. The specific code is logged; the database only sees a SourceFailure.
import type { SourceFailure } from '../types.js';

export type PdfCode =
  // index page and downloads
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'too_large'
  | 'bad_html'
  | 'wrong_page_title'
  | 'discovery_missing'
  | 'discovery_ambiguous'
  | 'bad_content_type'
  | 'not_pdf'
  // poppler
  | 'poppler_missing'
  | 'poppler_failed'
  | 'poppler_timeout'
  | 'output_too_large'
  | 'bad_text_layer'
  | 'rules_transformed'
  | 'too_many_words'
  | 'too_many_rules'
  // file layout
  | 'page_count'
  | 'no_text_layer'
  | 'no_table'
  | 'bad_header'
  | 'day_headers'
  | 'day_order'
  | 'column_rules'
  | 'stray_words'
  | 'unexpected_band'
  | 'page_header'
  | 'course_mismatch'
  | 'year_mismatch'
  | 'unbound_note'
  | 'unplaced_cells'
  // DiSU grids, legend and lettorato table
  | 'column_gap'
  | 'column_width'
  | 'continuation_columns'
  | 'time_labels'
  | 'time_step'
  | 'time_range'
  | 'row_rules'
  | 'row_gap'
  | 'word_crosses_column'
  | 'word_crosses_row'
  | 'cell_too_long'
  | 'year_line'
  | 'year_range'
  | 'unexpected_text'
  | 'legend_header'
  | 'legend_columns'
  | 'legend_row'
  | 'legend_position'
  | 'lettorato_table'
  | 'no_grid'
  | 'no_legend'
  | 'course_header'
  | 'header_mismatch'
  | 'grid_missing'
  | 'grid_duplicate'
  // dates
  | 'wrong_semester'
  | 'academic_year_mismatch'
  | 'outside_semester'
  // volume
  | 'too_many_entries'
  | 'too_many_lessons'
  // our side
  | 'config_invalid'
  | 'feed_unknown';

// A cell that cannot be placed fails the whole file: nothing is dropped in silence.
export type CellCode =
  | 'time_without_room'
  | 'room_without_time'
  | 'bad_time'
  | 'unknown_room'
  | 'room_building_mismatch'
  | 'no_teaching'
  | 'cell_too_long'
  | 'unlabeled_column'
  | 'unknown_title'
  | 'ambiguous_title'
  | 'text_without_room'
  | 'room_outside_parentheses'
  | 'person_in_title'
  | 'start_outside_semester';

export type PdfWarning =
  | 'period_text_mismatch'
  | 'stray_text'
  | 'start_note_fuzzy'
  | 'start_note_unbound'
  | 'shared_title_merged'
  | 'room_conflict'
  | 'academic_year_mismatch_accepted'
  | 'unknown_attachment'
  | 'discovery_extra'
  | 'grid_extra'
  | 'title_typo'
  | 'title_other_pdf'
  | 'legend_duplicate'
  | 'legend_other_year'
  | 'lettorato_unmatched'
  | 'title_from_lettorato'
  | 'cell_note';

// where is a position such as p3b7d2 (page, band, day), p1n4 (page, note line) or p2g1d0h9 (page, grid, day, hour):
// never text of the file.
const WHERE = /^[pbndgh0-9/]{0,40}$/;

export function where(value: string): string {
  return WHERE.test(value) ? value : '';
}

export interface Finding {
  code: PdfWarning | CellCode;
  where: string;
}

export class PdfError extends Error {
  readonly code: PdfCode;
  readonly where: string;
  constructor(code: PdfCode, at = '') {
    super(code);
    this.name = 'PdfError';
    this.code = code;
    this.where = where(at);
  }
}

const SAME: ReadonlySet<PdfCode> = new Set(['network', 'timeout', 'http_status', 'too_large']);
const HTML: ReadonlySet<PdfCode> = new Set(['bad_html', 'discovery_missing', 'discovery_ambiguous']);
const PERIOD: ReadonlySet<PdfCode> = new Set(['wrong_page_title', 'wrong_semester', 'academic_year_mismatch', 'outside_semester']);
const MANY: ReadonlySet<PdfCode> = new Set(['too_many_words', 'too_many_rules', 'too_many_entries', 'too_many_lessons']);
const OURS: ReadonlySet<PdfCode> = new Set(['poppler_missing', 'poppler_failed', 'config_invalid', 'feed_unknown']);

// Layout codes become bad_shape, dates wrong_period, network codes stay as they are.
export function sourceFailure(code: PdfCode): SourceFailure {
  if (SAME.has(code)) return code as SourceFailure;
  if (code === 'poppler_timeout') return 'timeout';
  if (code === 'output_too_large') return 'too_large';
  if (HTML.has(code)) return 'bad_html';
  if (PERIOD.has(code)) return 'wrong_period';
  if (MANY.has(code)) return 'too_many';
  if (OURS.has(code)) return 'unexpected';
  return 'bad_shape';
}

export function pdfCode(err: unknown): PdfCode | null {
  return err instanceof PdfError ? err.code : null;
}
