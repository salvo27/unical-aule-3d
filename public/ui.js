// DOM helpers: text always goes through text nodes, never through innerHTML.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'on') {
      for (const [event, handler] of Object.entries(value)) node.addEventListener(event, handler);
    } else if (key === 'className') {
      node.className = value;
    } else if (key === 'value') {
      node.value = value;
    } else {
      node.setAttribute(key, value === true ? '' : String(value));
    }
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

export class ApiError extends Error {
  constructor(status, code, field) {
    super(code);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

// Reads of our own origin only (Worker API and static files): GET, no body, no credentials, never an Authorization header.
// User tokens travel only through supabase-js (auth.js), straight to Supabase.
export async function api(path, { timeoutMs = 15000 } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) throw new ApiError(0, 'invalid');
  const init = { method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit', signal: AbortSignal.timeout(timeoutMs) };
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const code = (data && typeof data.error === 'string' && data.error) || 'http_error';
    throw new ApiError(res.status, code, data && typeof data.field === 'string' ? data.field : undefined);
  }
  return data;
}

const TZ = 'Europe/Rome';
const timeFmt = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const dateFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

export const fmtTime = (ms) => timeFmt.format(ms);
export const fmtDay = (ms) => dayFmt.format(ms);
export const isoDayOf = (ms) => dateFmt.format(ms);

export function shiftDay(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86400000).toISOString().slice(0, 10);
}

export function mondayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDay(iso, -((weekday + 6) % 7));
}

const ROMAN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i;

// Timetables are often ALL CAPS: show them in sentence case, keeping roman numerals.
export function prettyTitle(text) {
  if (text !== text.toUpperCase()) return text;
  const words = text.toLowerCase().split(' ');
  return words
    .map((w, i) => (ROMAN.test(w) ? w.toUpperCase() : i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

export const BRIDGE_LABEL = Object.freeze({ coperto: 'Ponte coperto', scoperto: 'Ponte scoperto' });

// 'coperto', 'scoperto' or null: any other value counts as no bridge.
export function bridgeOf(room) {
  const bridge = room ? room.bridge : null;
  return bridge === 'coperto' || bridge === 'scoperto' ? bridge : null;
}

export function floorLabel(floor, bridge = null) {
  if (bridge === 'coperto' || bridge === 'scoperto') return BRIDGE_LABEL[bridge];
  if (floor === null || floor === undefined) return 'piano non indicato';
  if (floor === 0) return 'piano terra';
  if (floor < 0) return `piano ${floor}`;
  return `${floor}° piano`;
}

const DEGREE_LEVEL = / \((triennale|magistrale|ciclo unico)\)$/;

// A course label may end with its degree level: the name gets prettyTitle, the level stays as is.
export function courseParts(text) {
  const found = DEGREE_LEVEL.exec(text);
  if (!found) return { name: prettyTitle(text), level: null };
  return { name: prettyTitle(text.slice(0, found.index)), level: `(${found[1]})` };
}

export function normalize(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function debounce(fn, ms) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export const KIND_LABEL = {
  room_occupied: 'Occupata',
  lesson_not_held: 'Lezione non tenuta',
  room_closed: 'Chiusa',
  issue: 'Disservizio',
};

export const CATEGORY_LABEL = {
  bagni: 'Bagni',
  proiettore: 'Proiettore',
  prese: 'Prese elettriche',
  riscaldamento: 'Riscaldamento',
  aria_condizionata: 'Aria condizionata',
  pulizia: 'Pulizia',
  macchinette: 'Macchinette',
  wifi: 'Wi-Fi',
  arredi: 'Banchi e sedie',
  altro: 'Altro',
};

export const STATUS_LABEL = {
  pending: 'in attesa',
  approved: 'approvata',
  rejected: 'respinta',
  expired: 'scaduta',
};
