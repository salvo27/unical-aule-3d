// Degree level written after the course name of every lesson: "<course> (triennale)".
export type DegreeLevel = 'triennale' | 'magistrale' | 'ciclo unico';

// Same limit as one course in aule.lessons.
export const MAX_COURSE_CHARS = 200;

const PLANNER_TYPES: ReadonlyMap<string, DegreeLevel> = new Map([
  ['L', 'triennale'],
  ['LM', 'magistrale'],
  ['LM5', 'ciclo unico'],
  ['LM6', 'ciclo unico'],
]);

// Planner corsi[].tipoCorso.codice; every other type has no level.
export function plannerLevel(code: unknown): DegreeLevel | null {
  return typeof code === 'string' && code.length <= 10 ? (PLANNER_TYPES.get(code) ?? null) : null;
}

// Class codes as the University course list writes them: "L-8", "LM-32 R", "LMG/01 R", "LM-4 c.u R".
// The single cycle classes are LMG/01, LMR/02, LM-4 c.u., LM-13, LM-41, LM-42, LM-46 and LM-85 bis.
const SINGLE_CYCLE_CLASS = /^(?:LMG\/01|LMR\/02|LM-4 c\.u\.?|LM-(?:13|41|42|46)|LM-85 bis)(?: R)?$/;
const DEGREE_CLASS = /^(L|LM)-\d{1,2}(?: R)?$/;

export function classLevel(value: unknown): DegreeLevel | null {
  if (typeof value !== 'string' || value.length > 20) return null;
  if (SINGLE_CYCLE_CLASS.test(value)) return 'ciclo unico';
  const m = DEGREE_CLASS.exec(value);
  if (!m) return null;
  return m[1] === 'L' ? 'triennale' : 'magistrale';
}

// The course alone when the level is unknown; null when the label would not fit the limit of a course.
export function courseWithLevel(course: string, level: DegreeLevel | null): string | null {
  const label = level === null ? course : `${course} (${level})`;
  return [...label].length <= MAX_COURSE_CHARS ? label : null;
}
