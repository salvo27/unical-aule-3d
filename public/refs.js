// Browser ports of calendarReference and sourceUrl (src/domain/primitives.ts). No imports, no DOM.

const PLANNER_HOST = 'unical.prod.up.cineca.it';
const HEX24 = /^[0-9a-f]{24}$/;
const CALENDAR_PATH = /^\/calendarioPubblico\/linkCalendarioId=([0-9a-f]{24})\/?$/;

// A bare id or a public Planner link, as pasted by an admin: the id, or null.
export function calendarRef(value) {
  if (typeof value !== 'string' || value.length > 500) return null;
  const trimmed = value.trim();
  if (trimmed.length === 24 && HEX24.test(trimmed)) return trimmed;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== PLANNER_HOST || url.port !== '' || url.username || url.password) return null;
  const match = CALENDAR_PATH.exec(url.pathname);
  return match ? match[1] : null;
}

// One line of the source pages: the normalized address, or the line as typed so the database answers source_url.
export function sourceUrlLine(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (value.length > 500) return trimmed;
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const host = url.hostname;
  const allowedHost = host === 'unical.it' || host.endsWith('.unical.it');
  if (url.protocol !== 'https:' || !allowedHost || url.port !== '' || url.username || url.password) return trimmed;
  url.hash = '';
  return url.href;
}
