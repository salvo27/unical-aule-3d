// Closed codes of the DIAm xlsx source. The specific code is logged; the database only sees a SourceFailure.
import type { SourceFailure } from '../types.js';

export type XlsxCode =
  // page
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'too_large'
  | 'discovery_ambiguous'
  // file
  | 'bad_content_type'
  | 'not_zip'
  | 'bad_zip'
  | 'too_many_entries'
  | 'part_too_large'
  | 'macro'
  | 'doctype'
  | 'bad_xml'
  | 'missing_part'
  | 'too_many_sheets'
  | 'too_many_cells'
  | 'bad_cell'
  | 'unexpected_sheet'
  | 'duplicate_sheet'
  | 'mixed_semester'
  // sheet
  | 'no_header'
  | 'bad_header'
  | 'unexpected_title_row'
  | 'unexpected_cell'
  | 'course_mismatch'
  | 'academic_year_mismatch'
  | 'year_mismatch'
  | 'no_semester'
  | 'bad_times'
  | 'unexpected_column'
  | 'grid_merge'
  | 'cell_too_long'
  | 'unknown_rooms'
  | 'hidden_sheet'
  | 'sheet_missing'
  | 'outside_semester'
  // our side
  | 'config_invalid'
  | 'feed_unknown';

export type XlsxWarning =
  | 'no_room'
  | 'unknown_room'
  | 'prefix_mismatch'
  | 'ambiguous_rooms'
  | 'room_without_title'
  | 'time_note'
  | 'hidden_value'
  | 'legend_extra'
  | 'room_table_drift'
  | 'rooms_sheet_invalid'
  | 'page_semester_mismatch';

export interface Finding {
  code: XlsxWarning;
  where: string;
}

export class XlsxError extends Error {
  readonly code: XlsxCode;
  constructor(code: XlsxCode) {
    super(code);
    this.name = 'XlsxError';
    this.code = code;
  }
}

const SAME: ReadonlySet<XlsxCode> = new Set(['network', 'timeout', 'http_status', 'too_large']);
const PERIOD: ReadonlySet<XlsxCode> = new Set(['academic_year_mismatch', 'mixed_semester', 'outside_semester']);
const MANY: ReadonlySet<XlsxCode> = new Set(['too_many_entries', 'too_many_sheets', 'too_many_cells']);

// Layout codes become bad_shape, dates wrong_period, network codes stay as they are.
export function sourceFailure(code: XlsxCode): SourceFailure {
  if (SAME.has(code)) return code as SourceFailure;
  if (code === 'part_too_large') return 'too_large';
  if (code === 'discovery_ambiguous') return 'bad_html';
  if (PERIOD.has(code)) return 'wrong_period';
  if (MANY.has(code)) return 'too_many';
  if (code === 'config_invalid' || code === 'feed_unknown') return 'unexpected';
  return 'bad_shape';
}

export function xlsxCode(err: unknown): XlsxCode | null {
  return err instanceof XlsxError ? err.code : null;
}
