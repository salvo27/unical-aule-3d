const CUBE = /\bcub[oi]\s*(\d{1,2})\s*\/?\s*([a-z]{1,3})\b/;

function clean(name: string): string {
  return name
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function slug(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Shared key between Planner building names ("Cubo 4D") and campus map names ("Cubo 4D - DiBEST").
export function buildingKey(name: string): string | null {
  if (name.length > 200) return null;
  const text = clean(name).toLowerCase();
  const cube = CUBE.exec(text);
  if (cube && cube[1] && cube[2]) return `cubo-${Number(cube[1])}${cube[2]}`;
  const base = text.split(DEPT_SEPARATOR)[0] ?? '';
  const key = slug(base);
  return key.length > 0 ? key : null;
}

// "Cubo 1A - DISPeS", "Cubo 1A -DISPeS" and "Cubo 1A- DISPeS", but not "Cubi 7-11B".
const DEPT_SEPARATOR = /\s+-\s*|\s*-\s+/;

export function buildingDisplayName(name: string): string {
  return (clean(name).split(DEPT_SEPARATOR)[0] ?? '').trim();
}

export function buildingDepartment(name: string): string {
  return (clean(name).split(DEPT_SEPARATOR)[1] ?? '').trim();
}

export function roomNameKey(name: string): string {
  return slug(clean(name).replace(/^aula\s+/i, '')).replace(/-/g, '');
}

export function seedKey(building: string, room: string): string {
  return `${building}|${roomNameKey(room)}`;
}
