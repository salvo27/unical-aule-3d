// Text rules of the DIMES source, the same as src/planner/parse.ts for every value that reaches the payload.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string' || v.length > max * 2) return null;
  const t = v.replace(/\s+/g, ' ').trim();
  return t.length === 0 || t.length > max || CONTROL.test(t) ? null : t;
}

// Same as norm() of the app: lower case, no accents, anything else one space.
export function normKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Identifiers of units, classes and rooms inside the app: short, no control characters, no "|".
export function appId(v: unknown): string | null {
  return typeof v === 'string' && v.length >= 1 && v.length <= 100 && !CONTROL.test(v) && !v.includes('|') ? v : null;
}
