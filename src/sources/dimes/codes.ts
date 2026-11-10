// Closed codes of the DIMES source. The specific code is logged; the database only sees a SourceFailure.
import type { SourceFailure } from '../types.js';

export type DimesCode =
  // request
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'too_large'
  | 'bad_content_type'
  | 'bad_encoding'
  // page
  | 'no_marker'
  | 'many_markers'
  | 'null_data'
  | 'bad_literal'
  | 'json_too_large'
  | 'bad_json'
  // structure
  | 'bad_shape'
  | 'unknown_key'
  | 'bad_days'
  | 'too_many'
  | 'too_many_skipped'
  // period
  | 'wrong_year'
  | 'no_state'
  | 'semester_mismatch'
  | 'outside_semester'
  // our side
  | 'config_invalid'
  | 'feed_unknown';

export class DimesError extends Error {
  readonly code: DimesCode;
  constructor(code: DimesCode) {
    super(code);
    this.name = 'DimesError';
    this.code = code;
  }
}

const SAME: ReadonlySet<DimesCode> = new Set(['network', 'timeout', 'http_status', 'too_large', 'bad_json', 'bad_shape', 'too_many']);
const HTML: ReadonlySet<DimesCode> = new Set(['bad_content_type', 'bad_encoding', 'no_marker', 'many_markers', 'null_data', 'bad_literal']);
const PERIOD: ReadonlySet<DimesCode> = new Set(['wrong_year', 'no_state', 'semester_mismatch', 'outside_semester']);

export function sourceFailure(code: DimesCode): SourceFailure {
  if (SAME.has(code)) return code as SourceFailure;
  if (code === 'json_too_large') return 'too_large';
  if (HTML.has(code)) return 'bad_html';
  if (PERIOD.has(code)) return 'wrong_period';
  if (code === 'unknown_key' || code === 'bad_days' || code === 'too_many_skipped') return 'bad_shape';
  return 'unexpected';
}

export function dimesCode(err: unknown): DimesCode | null {
  return err instanceof DimesError ? err.code : null;
}
