// The menu files linked from the canteen page of the university, with the period each one covers.
// The page lists them as "16 novembre - 27 dicembre" under the year; the year of the last day is at the end of the
// file name ("..._dal_15_dicembre_al_11_gennaio_2026.pdf"). Only the menus of the canteens: not the delivery ones.
import { isoDay, sourceUrl, type IsoDay, type SourceUrl } from '../domain/primitives.js';
import { anchorsOf } from '../sources/pdf/client.js';
import { monthIndex, type Period } from './parse.js';

export const MENU_PAGE = 'https://www.unical.it/campus/vivere-il-campus/servizio-mensa/';
const FILE = /^https:\/\/www\.unical\.it\/media\/medias\/\d{4}\/Menu_[Mm]ense_Unical_[A-Za-z0-9_]{1,120}_(\d{4})\.pdf$/;
const LABEL = /^(\d{1,2})\s+(\p{L}+)(?:\s+(\d{4}))?\s*[-–]\s*(\d{1,2})\s+(\p{L}+)(?:\s+(\d{4}))?$/u;
const MAX_DAYS = 70;

export interface MenuFile extends Period {
  url: SourceUrl;
}

function day(y: number, m: number, d: number): IsoDay | null {
  try {
    return isoDay(`${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  } catch {
    return null;
  }
}

function spanDays(from: IsoDay, to: IsoDay): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

export function menuFiles(html: string, base: string = MENU_PAGE): MenuFile[] {
  const out = new Map<string, MenuFile>();
  for (const a of anchorsOf(html)) {
    let url: SourceUrl;
    try {
      url = sourceUrl(new URL(a.href, base).href);
    } catch {
      continue;
    }
    const file = FILE.exec(url);
    const label = LABEL.exec(a.text.trim());
    if (!file || !label) continue;
    const [m1, m2] = [monthIndex(label[2] ?? ''), monthIndex(label[5] ?? '')];
    if (m1 < 0 || m2 < 0) continue;
    const endYear = Number(label[6] ?? file[1]);
    const startYear = label[3] ? Number(label[3]) : m1 > m2 ? endYear - 1 : endYear;
    const startsOn = day(startYear, m1, Number(label[1]));
    const endsOn = day(endYear, m2, Number(label[4]));
    if (!startsOn || !endsOn) continue;
    const span = spanDays(startsOn, endsOn);
    if (span < 0 || span > MAX_DAYS) continue;
    out.set(url, { url, startsOn, endsOn });
  }
  return [...out.values()].sort((a, b) => (a.startsOn < b.startsOn ? -1 : 1));
}
