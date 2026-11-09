// One-off import: official Unical campus map (Google My Maps KML) for building shapes,
// OpenStreetMap for the Ponte Pietro Bucci axis. Output: public/data/campus.geojson.
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { atomicWriteJson } from '../src/store/files.js';
import { buildingKey, buildingDisplayName, buildingDepartment } from '../src/domain/building.js';
import { USER_AGENT } from '../src/user-agent.js';

const KML_URL = 'https://www.google.com/maps/d/kml?mid=17RXFIMpyGYs5LC7TGMFLzcFw52Q&forcekml=1';
// Read-only queries go to Overpass, not to the OSM editing API (OSMF API usage policy).
const OSM_URL =
  'https://overpass-api.de/api/interpreter?data=' +
  encodeURIComponent(
    '[out:xml][timeout:60][bbox:39.352,16.220,39.372,16.232];(way["highway"="pedestrian"]["name"="Ponte Pietro Bucci"];way["building"]["name"="Technest"];);(._;>;);out body;',
  );
const BUILDINGS_FOLDER = 'Strutture, edifici, aule';
const FOOD_FOLDER = 'Ristoro';
const BRIDGE_NAME = 'Ponte Pietro Bucci';
const BRIDGE_HALF_WIDTH_M = 5;
const BOUNDS = { minLon: 16.2, maxLon: 16.26, minLat: 39.33, maxLat: 39.38 };

type Position = [number, number];

async function fetchText(url: string, maxBytes: number): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error(`Response too large for ${url}`);
  return new TextDecoder().decode(buf);
}

function inBounds([lon, lat]: Position): boolean {
  return lon >= BOUNDS.minLon && lon <= BOUNDS.maxLon && lat >= BOUNDS.minLat && lat <= BOUNDS.maxLat;
}

function round(p: Position): Position {
  return [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7];
}

function parseRing(text: string): Position[] | null {
  const ring: Position[] = [];
  for (const chunk of text.trim().split(/\s+/)) {
    const [lon, lat] = chunk.split(',').map(Number);
    if (lon === undefined || lat === undefined || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    const p: Position = round([lon, lat]);
    if (!inBounds(p)) return null;
    ring.push(p);
  }
  if (ring.length < 4) return null;
  const first = ring[0]!;
  const last = ring[ring.length - 1]!;
  if (first[0] !== last[0] || first[1] !== last[1]) ring.push(first);
  return ring;
}

const FOOD = /mensa|bar\b|restaurant|ristor/i;

// Places shown with their own color instead of room availability.
const CATEGORIES: Record<string, { category: 'library' | 'study' | 'culture'; name: string; dept: string }> = {
  bau: { category: 'library', name: 'Biblioteca BAU', dept: 'Area umanistica' },
  bats: { category: 'library', name: 'Biblioteca BATS', dept: 'Area tecnico-scientifica' },
  tarantelli: { category: 'library', name: 'Biblioteca Tarantelli', dept: 'Area economica e sociale' },
  'cubo-24b': { category: 'study', name: 'Cubo 24B, aula studio C24', dept: 'Aula studio' },
  'auditorium-teatro-grande': { category: 'culture', name: 'TAU, Teatro Auditorium Unical', dept: 'Teatro e cinema' },
  'teatro-piccolo': { category: 'culture', name: 'Piccolo Teatro Unical', dept: 'Teatro' },
  'anfiteatro-polifunzionale': { category: 'culture', name: 'Anfiteatro del Polifunzionale', dept: 'Spettacoli all\'aperto' },
};
const SHOWS_FOLDER = 'Sport, spettacoli';

function folderBody(kml: string, prefix: string): string {
  const folders = [...kml.matchAll(/<Folder>\s*<name>([\s\S]*?)<\/name>([\s\S]*?)<\/Folder>/g)];
  const folder = folders.find((f) => (f[1] ?? '').startsWith(prefix));
  if (!folder || !folder[2]) throw new Error(`Folder "${prefix}" not found in KML`);
  return folder[2];
}

// Buildings with classrooms, plus canteens and bars (kind "food") from the Ristoro folder.
function parsePlaces(kml: string): unknown[] {
  const features: unknown[] = [];
  const sources: [string, 'all' | 'food' | 'categories'][] = [
    [BUILDINGS_FOLDER, 'all'],
    [FOOD_FOLDER, 'food'],
    [SHOWS_FOLDER, 'categories'],
  ];
  const seenFood = new Set<string>();
  for (const [prefix, only] of sources) {
    for (const placemark of folderBody(kml, prefix).matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
      const body = placemark[1] ?? '';
      const rawName = /<name>([\s\S]*?)<\/name>/.exec(body)?.[1] ?? '';
      const isFood = FOOD.test(rawName) && !/^(<!\[CDATA\[)?\s*ex\s/i.test(rawName);
      if (only === 'food' && !isFood) continue;
      if (only === 'categories' && !CATEGORIES[buildingKey(rawName) ?? '']) continue;
      const outer = /<outerBoundaryIs>[\s\S]*?<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
      const key = buildingKey(rawName);
      const ring = outer ? parseRing(outer) : null;
      if (!key || !ring) continue;
      const name = buildingDisplayName(rawName);
      if (isFood) {
        if (seenFood.has(key)) continue;
        seenFood.add(key);
      }
      const dept = isFood ? '' : buildingDepartment(rawName);
      const special = CATEGORIES[key];
      features.push({
        type: 'Feature',
        properties: special
          ? { kind: 'building', key, name: special.name, dept: special.dept, category: special.category }
          : { kind: isFood ? 'food' : 'building', key, name, dept },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }
  }
  return features;
}

function attributes(tag: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(/(\w+(?::\w+)*)="([^"]*)"/g)) out.set(m[1]!, m[2]!);
  return out;
}

function parseBridgeAxis(osm: string): Position[] {
  const nodes = new Map<string, Position>();
  for (const m of osm.matchAll(/<node\b[^>]*>/g)) {
    const a = attributes(m[0]);
    const id = a.get('id');
    const lon = Number(a.get('lon'));
    const lat = Number(a.get('lat'));
    if (id && Number.isFinite(lon) && Number.isFinite(lat)) nodes.set(id, [lon, lat]);
  }
  const segments: Position[][] = [];
  for (const m of osm.matchAll(/<way\b[^>]*>([\s\S]*?)<\/way>/g)) {
    const body = m[1] ?? '';
    const tags = new Map<string, string>();
    for (const t of body.matchAll(/<tag\b[^>]*\/>/g)) {
      const a = attributes(t[0]);
      const k = a.get('k');
      const v = a.get('v');
      if (k && v !== undefined) tags.set(k, v);
    }
    if (tags.get('name') !== BRIDGE_NAME || tags.get('highway') !== 'pedestrian') continue;
    const points = [...body.matchAll(/<nd ref="(\d+)"\s*\/>/g)]
      .map((n) => nodes.get(n[1]!))
      .filter((p): p is Position => p !== undefined);
    if (points.length < 2) continue;
    if (points[0]![1] > points[points.length - 1]![1]) points.reverse();
    segments.push(points);
  }
  if (segments.length === 0) throw new Error('Bridge not found in OSM data');
  segments.sort((a, b) => a[0]![1] - b[0]![1]);
  const axis: Position[] = [];
  for (const seg of segments) {
    for (const p of seg) {
      const prev = axis[axis.length - 1];
      if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) axis.push(round(p));
    }
  }
  return axis;
}

// Buildings missing from the official map, taken from OpenStreetMap by name.
const OSM_BUILDINGS = [{ osmName: 'Technest', key: 'technest', name: 'TechNest', dept: 'Piazza Vermicelli' }];

function osmBuildingRing(osm: string, name: string): Position[] | null {
  const nodes = new Map<string, Position>();
  for (const m of osm.matchAll(/<node\b[^>]*>/g)) {
    const a = attributes(m[0]);
    const id = a.get('id');
    const lon = Number(a.get('lon'));
    const lat = Number(a.get('lat'));
    if (id && Number.isFinite(lon) && Number.isFinite(lat)) nodes.set(id, [lon, lat]);
  }
  for (const m of osm.matchAll(/<way\b[^>]*>([\s\S]*?)<\/way>/g)) {
    const body = m[1] ?? '';
    const isNamed = [...body.matchAll(/<tag\b[^>]*\/>/g)].some((t) => {
      const a = attributes(t[0]);
      return a.get('k') === 'name' && a.get('v') === name;
    });
    const isBuilding = /<tag k="building"/.test(body);
    if (!isNamed || !isBuilding) continue;
    const ring = [...body.matchAll(/<nd ref="(\d+)"\s*\/>/g)].map((n) => nodes.get(n[1]!)).filter((p): p is Position => p !== undefined).map(round);
    if (ring.length >= 4 && ring.every(inBounds)) return ring;
  }
  return null;
}

function bufferLine(axis: Position[], halfWidthM: number): Position[] {
  const lat0 = (axis[0]![1] * Math.PI) / 180;
  const mx = 111_320 * Math.cos(lat0);
  const my = 110_540;
  const xy = axis.map(([lon, lat]) => [lon * mx, lat * my] as const);
  const left: Position[] = [];
  const right: Position[] = [];
  for (let i = 0; i < xy.length; i++) {
    const a = xy[Math.max(0, i - 1)]!;
    const b = xy[Math.min(xy.length - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * halfWidthM;
    const ny = (dx / len) * halfWidthM;
    const [x, y] = xy[i]!;
    left.push(round([(x + nx) / mx, (y + ny) / my]));
    right.push(round([(x - nx) / mx, (y - ny) / my]));
  }
  const ring = [...left, ...right.reverse()];
  ring.push(ring[0]!);
  return ring;
}

// Bars and canteens that the official map has only as a point, or not at all (placed on their building).
// Positions from OpenStreetMap (© OpenStreetMap contributors, ODbL) where it has the place, otherwise the building it is in.
const FOOD_POINTS: { key: string; name: string; note: string; placemark?: string; at?: Position }[] = [
  { key: 'bar-la-cascina', name: 'Bar La Cascina', at: [16.223813, 39.362126], note: 'Vicino alla mensa Martensson.' },
  { key: 'mensa-vermicelli', name: 'Mensa Vermicelli', at: [16.224983, 39.36779], note: "In piazza Vermicelli, accanto al TAU, nell'edificio del TechNest." },
  { key: 'bar-del-tau', name: 'Bar del TAU', placemark: 'Auditorium Teatro Grande', note: 'Accanto al TAU, sopra il cinema.' },
  { key: 'poli-bistrot', name: 'Poli-Bistrot', placemark: 'Polifunzionale - DFSSN', note: "Nell'edificio Polifunzionale." },
];

function placemarkCenter(kml: string, name: string): Position {
  for (const m of kml.matchAll(/<Placemark>([\s\S]*?)<\/Placemark>/g)) {
    const body = m[1] ?? '';
    const raw = (/<name>([\s\S]*?)<\/name>/.exec(body)?.[1] ?? '').replace(/ /g, ' ').trim();
    if (raw !== name) continue;
    const coords = /<coordinates>([\s\S]*?)<\/coordinates>/.exec(body)?.[1];
    const points = (coords ?? '').trim().split(/\s+/).map((c) => c.split(',').map(Number) as [number, number]);
    const valid = points.filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
    if (valid.length === 0) break;
    const center = round([valid.reduce((s, p) => s + p[0], 0) / valid.length, valid.reduce((s, p) => s + p[1], 0) / valid.length]);
    if (inBounds(center)) return center;
  }
  throw new Error(`Placemark "${name}" not found`);
}

async function main(): Promise<void> {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [kml, osm] = await Promise.all([fetchText(KML_URL, 10_000_000), fetchText(OSM_URL, 5_000_000)]);
  const buildings = parsePlaces(kml);
  for (const b of OSM_BUILDINGS) {
    const ring = osmBuildingRing(osm, b.osmName);
    if (!ring) throw new Error(`OSM building "${b.osmName}" not found`);
    buildings.push({ type: 'Feature', properties: { kind: 'building', key: b.key, name: b.name, dept: b.dept }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  for (const p of FOOD_POINTS) {
    buildings.push({
      type: 'Feature',
      properties: { kind: 'food', key: p.key, name: p.name, dept: '', note: p.note },
      geometry: { type: 'Point', coordinates: p.at ?? placemarkCenter(kml, p.placemark ?? '') },
    });
  }
  const axis = parseBridgeAxis(osm);
  const bridge = {
    type: 'Feature',
    properties: { kind: 'bridge', key: 'ponte', name: BRIDGE_NAME, dept: '' },
    geometry: { type: 'Polygon', coordinates: [bufferLine(axis, BRIDGE_HALF_WIDTH_M)] },
  };
  const collection = {
    type: 'FeatureCollection',
    attribution:
      "Edifici: mappa ufficiale del campus dell'Università della Calabria (diritti dei titolari, non coperti dalla licenza del repository). Ponte Pietro Bucci, edificio TechNest e posizione di Bar La Cascina e Mensa Vermicelli: © OpenStreetMap contributors, ODbL 1.0, https://www.openstreetmap.org/copyright",
    features: [...buildings, bridge],
  };
  const out = join(root, 'public', 'data', 'campus.geojson');
  await atomicWriteJson(out, collection);
  console.log(`Wrote ${buildings.length} places and the bridge (${axis.length} points) to ${out}`);
}

main().catch((err: unknown) => {
  console.error('Import failed:', err instanceof Error ? err.message : 'unknown error');
  process.exitCode = 1;
});
