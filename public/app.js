import { themed } from './theme.js';
import * as maplibregl from '/vendor/maplibre-gl.mjs';
import {
  el,
  api,
  fmtTime,
  fmtDay,
  isoDayOf,
  shiftDay,
  mondayOf,
  prettyTitle,
  floorLabel,
  normalize,
  debounce,
  KIND_LABEL,
  CATEGORY_LABEL,
  STATUS_LABEL,
} from './ui.js';
import { initAuth, enabled as accountsEnabled, signedIn, onSessionChange, sendLoginLink, signOut, authed } from './auth.js';

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const FALLBACK_STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#f2efe9' } }] };
const FLOOR_H = 3.4;
const GAP = 0.45;
const BRIDGE_LEVEL = 4;
const STATUS_REFRESH_MS = 60_000;
const STATUS_MAX_AGE_MS = 5 * 60_000;
const MENSA_PAGE = 'https://www.unical.it/campus/vivere-il-campus/servizio-mensa/';
const COLORS = {
  free: '#2e9b57',
  'free-soft': '#a9d9bb',
  busy: '#d64541',
  'busy-soft': '#f0b3b1',
  unknown: '#9aa1a9',
  'unknown-soft': '#cfd3d8',
  plinth: '#d9d3c9',
  food: '#e0a33a',
  library: '#3b7dd8',
  culture: '#8e5bb5',
};

const CATEGORY_TEXT = {
  library: { label: 'Biblioteca', words: 'biblioteca libri studiare aula studio', note: 'Biblioteca di Ateneo.' },
  study: { label: 'Aula studio', words: 'aula studio studiare biblioteca', note: 'Aula studio aperta agli studenti.' },
  culture: { label: 'Cinema e teatro', words: 'cinema teatro spettacoli concerti', note: 'Teatro, cinema e spettacoli.' },
};

const $ = (id) => document.getElementById(id);
const panel = $('panel');
const panelToggle = $('panel-toggle');
const panelBody = $('panel-body');
const panelFoot = $('panel-foot');

const state = {
  campus: null,
  places: new Map(),
  canteens: null,
  placeInfo: null,
  status: null,
  statusAt: 0,
  statusError: false,
  view: { name: 'home' },
  history: [],
  query: '',
  filters: { free: false, hours: null, seats: null },
  map: null,
  mapReady: false,
  role: null,
};

// ---------- data ----------

function isFresh() {
  return state.status !== null && Date.now() - state.statusAt < STATUS_MAX_AGE_MS;
}

function roomState(room) {
  return isFresh() ? room.state : 'unknown';
}

async function loadStatus() {
  try {
    state.status = await api('/api/status');
    state.statusAt = Date.now();
    state.statusError = false;
  } catch {
    state.statusError = true;
  }
  updateMap();
  renderFoot();
  // Do not rebuild the panel while someone is typing or choosing in it.
  const active = document.activeElement;
  if (active && panelBody.contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;
  if (state.view.name === 'search') runSearch(false);
  else render();
}

function centerOf(geometry) {
  if (geometry.type === 'Point') return geometry.coordinates;
  const ring = geometry.coordinates[0];
  let x = 0;
  let y = 0;
  for (const [lon, lat] of ring) {
    x += lon;
    y += lat;
  }
  return [x / ring.length, y / ring.length];
}

function indexPlaces() {
  for (const f of state.campus.features) {
    const p = f.properties;
    if (p.kind !== 'building' && p.kind !== 'food') continue;
    if (!state.places.has(p.key)) {
      state.places.set(p.key, {
        key: p.key,
        name: p.name,
        dept: p.dept,
        note: p.note || '',
        kind: p.kind,
        category: p.category || null,
        center: centerOf(f.geometry),
      });
    }
  }
}

function placeName(key, fallback) {
  return (key && state.places.get(key)?.name) || fallback || 'Edificio non indicato';
}

// ---------- map ----------

function defaultShape(key) {
  return key.startsWith('cubo-') ? { floors: 5, baseLevel: 0 } : { floors: 2, baseLevel: 0 };
}

function aggregate(c) {
  if (c.free > 0) return 'free';
  if (c.busy > 0) return 'busy';
  return 'unknown';
}

function sliceState(building, floor) {
  if (!building) return null;
  const c = building.floors[String(floor)];
  if (c) return aggregate(c);
  const u = building.unplaced;
  if (u.free + u.busy + u.unknown > 0) return `${aggregate(u)}-soft`;
  return null;
}

function buildSlices() {
  const fresh = isFresh();
  const features = [];
  for (const f of state.campus.features) {
    const p = f.properties;
    if (p.kind === 'food') {
      if (f.geometry.type === 'Polygon') {
        features.push({ type: 'Feature', geometry: f.geometry, properties: { key: p.key, kind: 'food', base: 0, top: 5, state: 'food' } });
      }
      continue;
    }
    if (p.kind !== 'building') continue;
    const shape = state.status?.shapes?.[p.key] ?? defaultShape(p.key);
    const building = state.status?.buildings?.[p.key];
    const categoryColor = p.category && !building ? (p.category === 'culture' ? 'culture' : 'library') : null;
    const floors = new Set(Array.from({ length: shape.floors }, (_, i) => i));
    if (building) for (const k of Object.keys(building.floors)) floors.add(Number(k));
    if (shape.baseLevel > 0) {
      features.push({ type: 'Feature', geometry: f.geometry, properties: { key: p.key, kind: 'building', base: 0, top: shape.baseLevel * FLOOR_H - GAP, state: 'plinth' } });
    }
    for (const floor of [...floors].sort((a, b) => a - b)) {
      const level = shape.baseLevel + floor;
      if (level < 0) continue;
      let s = sliceState(building, floor);
      if (categoryColor) s = categoryColor;
      else if (!state.status) s = 'unknown';
      else if (!fresh && s) s = s.endsWith('-soft') ? 'unknown-soft' : 'unknown';
      features.push({
        type: 'Feature',
        geometry: f.geometry,
        properties: { key: p.key, kind: 'building', floor, base: level * FLOOR_H, top: level * FLOOR_H + FLOOR_H - GAP, state: s ?? 'none' },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

function outlines() {
  const features = [];
  for (const f of state.campus.features) {
    const p = f.properties;
    if (p.kind !== 'building' && p.kind !== 'food') continue;
    const label = p.key.startsWith('cubo-') ? p.key.slice(5).toUpperCase() : p.kind === 'food' ? p.name : '';
    features.push({ type: 'Feature', geometry: f.geometry, properties: { key: p.key, label } });
  }
  return { type: 'FeatureCollection', features };
}

function addLayers(map) {
  for (const layer of map.getStyle().layers) {
    if (layer['source-layer'] === 'building' || /building/i.test(layer.id)) map.setLayoutProperty(layer.id, 'visibility', 'none');
  }
  const bridge = state.campus.features.filter((f) => f.properties.kind === 'bridge');
  map.addSource('slices', { type: 'geojson', data: buildSlices() });
  map.addSource('bridge', { type: 'geojson', data: { type: 'FeatureCollection', features: bridge } });
  map.addSource('outline', { type: 'geojson', data: outlines() });

  const colorMatch = ['match', ['get', 'state']];
  for (const [k, v] of Object.entries(COLORS)) colorMatch.push(k, v);
  colorMatch.push('#ece8e1');

  map.addLayer({ id: 'selected', type: 'line', source: 'outline', filter: ['==', ['get', 'key'], ''], paint: { 'line-color': '#6f0b0a', 'line-width': 3 } });
  map.addLayer({
    id: 'slices',
    type: 'fill-extrusion',
    source: 'slices',
    paint: {
      'fill-extrusion-color': colorMatch,
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-height': ['get', 'top'],
      'fill-extrusion-opacity': 0.92,
    },
  });
  map.addLayer({
    id: 'bridge',
    type: 'fill-extrusion',
    source: 'bridge',
    paint: {
      'fill-extrusion-color': '#cfc8bd',
      'fill-extrusion-base': BRIDGE_LEVEL * FLOOR_H - 1,
      'fill-extrusion-height': BRIDGE_LEVEL * FLOOR_H,
      'fill-extrusion-opacity': 0.95,
    },
  });
  map.addLayer({
    id: 'food-points',
    type: 'circle',
    source: 'outline',
    filter: ['==', ['geometry-type'], 'Point'],
    paint: { 'circle-radius': 7, 'circle-color': COLORS.food, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  });
  map.on('mouseenter', 'food-points', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'food-points', () => (map.getCanvas().style.cursor = ''));
  if (map.getStyle().glyphs) {
    map.addLayer({
      id: 'labels',
      type: 'symbol',
      source: 'outline',
      minzoom: 15.8,
      filter: ['all', ['==', ['geometry-type'], 'Point'], ['!=', ['get', 'label'], '']],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'], 'text-size': 12 },
      paint: { 'text-color': '#1d1d1f', 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
    });
  }
  // With a tilted map one click can cross several cubes: take the nearest, whose base is lowest on screen.
  map.on('click', (e) => {
    const layers = ['slices', 'food-points'].filter((id) => map.getLayer(id));
    const hits = map.queryRenderedFeatures(e.point, { layers });
    let best = null;
    let bestY = Number.NEGATIVE_INFINITY;
    for (const f of hits) {
      const place = state.places.get(f.properties.key);
      if (!place) continue;
      const y = f.layer.id === 'food-points' ? Number.POSITIVE_INFINITY : map.project(place.center).y;
      if (y > bestY) {
        bestY = y;
        best = place;
      }
    }
    if (!best) return;
    if (best.kind === 'food') openFood(best.key);
    else openBuilding(best.key);
  });
  map.on('mouseenter', 'slices', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'slices', () => (map.getCanvas().style.cursor = ''));
}

function initMap() {
  maplibregl.setWorkerUrl('/vendor/maplibre-gl-worker.mjs');
  const map = new maplibregl.Map({
    container: 'map',
    style: STYLE_URL,
    center: [16.2262, 39.3602],
    zoom: 15.6,
    pitch: 55,
    bearing: -20,
    maxBounds: [
      [16.2, 39.34],
      [16.25, 39.38],
    ],
    attributionControl: {
      compact: true,
      customAttribution:
        'Progetto studentesco non ufficiale · Edifici: mappa del campus Unical e <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> · Orari: University Planner Unical · <a href="/vendor/licenses.txt" target="_blank" rel="noopener">Licenze</a>',
    },
    locale: {
      'NavigationControl.ZoomIn': 'Avvicina',
      'NavigationControl.ZoomOut': 'Allontana',
      'NavigationControl.ResetBearing': 'Trascina per ruotare, clicca per tornare al nord',
      'GeolocateControl.FindMyLocation': 'Mostra la mia posizione',
      'GeolocateControl.LocationNotAvailable': 'Posizione non disponibile',
      'AttributionControl.ToggleAttribution': 'Fonti della mappa',
    },
  });
  state.map = map;
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  // The position stays in the browser: it is never sent to our server.
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true, timeout: 10_000 },
      trackUserLocation: true,
      showAccuracyCircle: true,
      fitBoundsOptions: { maxZoom: 17 },
    }),
    'top-right',
  );
  // Fall back to a plain background only if the base style itself cannot be loaded.
  let styleLoaded = false;
  let usedFallback = false;
  map.on('error', (e) => {
    console.warn('Errore della mappa:', (e.error && e.error.message) || 'sconosciuto');
    if (!styleLoaded && !usedFallback) {
      usedFallback = true;
      map.setStyle(FALLBACK_STYLE);
    }
  });
  map.on('style.load', () => {
    styleLoaded = true;
    if (state.mapReady) return;
    try {
      addLayers(map);
    } catch (err) {
      console.error('Impossibile disegnare gli edifici:', err.message);
      return;
    }
    map.getContainer().append(labelRoot);
    buildRoofLabels();
    map.on('move', placeRoofLabels);
    map.on('resize', placeRoofLabels);
    state.mapReady = true;
    updateMap();
  });
}

// ---------- labels on the roofs ----------
// MapLibre draws text at ground level, which on a tilted map lands on the facade of another cube.
// These labels sit where each roof appears: the view ray through the roof meets the ground
// height * tan(pitch) further away, in the direction the camera looks.

const RAD = Math.PI / 180;
const SHORT_LABELS = {
  'cubo-24b': '24B · C24',
  bau: 'BAU',
  bats: 'BATS',
  tarantelli: 'Tarantelli',
  'auditorium-teatro-grande': 'TAU',
  'teatro-piccolo': 'PTU',
  'anfiteatro-polifunzionale': 'Anfiteatro',
  technest: 'TechNest',
};
const labelRoot = el('div', { className: 'roof-labels', 'aria-hidden': 'true' });
let roofLabels = [];

function shortLabel(p) {
  if (SHORT_LABELS[p.key]) return SHORT_LABELS[p.key];
  if (p.key.startsWith('cubo-')) return p.key.slice(5).toUpperCase();
  return p.kind === 'food' ? p.name : '';
}

function buildRoofLabels() {
  labelRoot.replaceChildren();
  roofLabels = [];
  const seen = new Set();
  for (const f of state.campus.features) {
    const p = f.properties;
    if ((p.kind !== 'building' && p.kind !== 'food') || f.geometry.type !== 'Polygon' || seen.has(p.key)) continue;
    const text = shortLabel(p);
    if (!text) continue;
    seen.add(p.key);
    const node = el('span', { className: 'roof-label' }, text);
    labelRoot.append(node);
    roofLabels.push({ key: p.key, kind: p.kind, center: centerOf(f.geometry), node });
  }
}

function roofHeight(label) {
  if (label.kind === 'food') return 5;
  const shape = state.status?.shapes?.[label.key] ?? defaultShape(label.key);
  return (shape.baseLevel + shape.floors) * FLOOR_H;
}

function placeRoofLabels() {
  const map = state.map;
  if (!map || !state.mapReady) return;
  const visible = map.getZoom() >= 15.8;
  labelRoot.hidden = !visible;
  if (!visible) return;
  const pitch = map.getPitch() * RAD;
  const bearing = map.getBearing() * RAD;
  const { width, height } = map.getContainer().getBoundingClientRect();
  const items = roofLabels
    .map((label) => {
      const d = roofHeight(label) * Math.tan(pitch);
      const [lon, lat] = label.center;
      const point = map.project([lon + (d * Math.sin(bearing)) / (111_320 * Math.cos(lat * RAD)), lat + (d * Math.cos(bearing)) / 110_540]);
      return { label, point };
    })
    .sort((a, b) => b.point.y - a.point.y);
  const placed = [];
  for (const { label, point } of items) {
    const box = { x: point.x - 26, y: point.y - 9, w: 52, h: 18 };
    const inside = point.x > -40 && point.x < width + 40 && point.y > -20 && point.y < height + 20;
    const free = inside && !placed.some((b) => b.x < box.x + box.w && box.x < b.x + b.w && b.y < box.y + box.h && box.y < b.y + b.h);
    label.node.hidden = !free;
    if (!free) continue;
    placed.push(box);
    label.node.style.transform = `translate(${Math.round(point.x)}px, ${Math.round(point.y)}px) translate(-50%, -50%)`;
  }
}

function updateMap() {
  if (!state.mapReady) return;
  state.map.getSource('slices').setData(buildSlices());
  placeRoofLabels();
}

function select(key) {
  if (state.mapReady) state.map.setFilter('selected', ['==', ['get', 'key'], key || '']);
}

function flyTo(key) {
  const place = state.places.get(key);
  if (!place || !state.map) return;
  const mobile = window.innerWidth <= 720;
  state.map.easeTo({
    center: place.center,
    zoom: Math.max(state.map.getZoom(), 16.6),
    duration: 700,
    padding: mobile ? { bottom: window.innerHeight * 0.55, top: 0, left: 0, right: 0 } : { left: 400, top: 0, bottom: 0, right: 0 },
  });
}

// ---------- navigation ----------

function show(view) {
  state.history.push(state.view);
  if (state.history.length > 30) state.history.shift();
  state.view = view;
  setCollapsed(false);
  render();
  panelBody.scrollTop = 0;
}

function back() {
  state.view = state.history.pop() || { name: 'home' };
  select(state.view.key || null);
  render();
}

function closeDetail() {
  state.history = [];
  state.view = { name: 'home' };
  select(null);
  render();
  panelBody.scrollTop = 0;
  // On a phone the map is the point: closing a detail also lowers the sheet.
  if (window.innerWidth <= 720) setCollapsed(true);
}

function setCollapsed(collapsed) {
  panel.classList.toggle('collapsed', collapsed);
  panelToggle.setAttribute('aria-expanded', String(!collapsed));
  panelToggle.setAttribute('aria-label', collapsed ? 'Apri il pannello' : 'Riduci il pannello');
}

function openBuilding(key) {
  show({ name: 'building', key });
  select(key);
  flyTo(key);
}

function openFood(key) {
  show({ name: 'food', key });
  select(key);
  flyTo(key);
}

function openRoom(id, day) {
  const view = { name: 'room', id, mode: 'day', day: day || isoDayOf(Date.now()), data: null, error: null };
  show(view);
  const room = state.status?.rooms.find((r) => r.id === id);
  if (room?.buildingKey) {
    select(room.buildingKey);
    flyTo(room.buildingKey);
  }
  loadRoom(view);
}

async function loadRoom(view) {
  const from = view.mode === 'day' ? view.day : mondayOf(view.day);
  const days = view.mode === 'day' ? 1 : 7;
  view.data = null;
  view.error = null;
  render();
  try {
    view.data = await api(`/api/rooms/${encodeURIComponent(view.id)}?from=${from}&days=${days}`);
  } catch (err) {
    view.error = err;
  }
  if (state.view === view) render();
}

// ---------- rendering ----------

function render() {
  const v = state.view;
  for (const c of [...panel.classList]) if (c.startsWith('view-')) panel.classList.remove(c);
  panel.classList.add(`view-${v.name}`);
  panelBody.replaceChildren();
  if (state.status && !isFresh()) {
    panelBody.append(el('div', { className: 'notice notice-stale' }, 'Non riesco ad aggiornare i dati: per sicurezza le aule sono mostrate in grigio.'));
  }
  if (v.name === 'building') renderBuilding(v);
  else if (v.name === 'room') renderRoom(v);
  else if (v.name === 'food') renderFood(v);
  else if (v.name === 'search') renderSearch(v);
  else if (v.name === 'login') renderLogin(v);
  else if (v.name === 'mine') renderMine(v);
  else renderHome();
}

// Texts made of parts are joined by " · " with each part in its own span, so a theme can style them.
function parts(items, sep = ' · ') {
  const out = [];
  for (const [className, content] of items) {
    if (!content) continue;
    if (out.length > 0) out.push(el('span', { className: 'sep' }, sep));
    out.push(el('span', { className }, content));
  }
  return out;
}

const timeOf = (ms) => el('span', { className: 'time' }, fmtTime(ms));

function renderFoot() {
  const s = state.status;
  const nodes = parts([
    ['foot-updated', s?.lastRunAt ? ['Orari aggiornati alle ', timeOf(s.lastRunAt), ` del ${fmtDay(s.lastRunAt)}`] : null],
    ['foot-stale', s?.staleCalendars ? `${s.staleCalendars} calendari non aggiornati` : null],
    ['foot-offline', state.statusError ? 'connessione assente' : null],
    ['foot-reports', s && accountsEnabled() && !s.reportsAvailable ? 'segnalazioni non aggiornate' : null],
  ]);
  if (nodes.length > 0) panelFoot.replaceChildren(...nodes);
  else panelFoot.textContent = 'Caricamento dei dati…';
}

function pill(room) {
  const s = roomState(room);
  if (s === 'free') return el('span', { className: 'pill pill-free' }, room.until ? ['libera fino ', timeOf(room.until)] : 'libera');
  if (s === 'busy') return el('span', { className: 'pill pill-busy' }, room.until ? ['occupata fino ', timeOf(room.until)] : 'occupata');
  return el('span', { className: 'pill pill-unknown' }, 'non aggiornato');
}

function roomRow(room, { showBuilding = true } = {}) {
  const sub = parts([
    ['row-building', showBuilding ? placeName(room.buildingKey, room.buildingName) : null],
    ['row-floor', floorLabel(room.floor)],
    ['row-seats', room.capacity ? `${room.capacity} posti` : null],
  ]);
  return el(
    'li',
    {},
    el(
      'button',
      { className: `row row-room row-${roomState(room)}`, type: 'button', on: { click: () => openRoom(room.id) } },
      el('div', { className: 'row-main' }, el('div', { className: 'row-title' }, room.name), el('div', { className: 'row-sub' }, sub)),
      pill(room),
    ),
  );
}

function placeRow(place) {
  const sub = place.kind === 'food' ? 'Mensa e ristoro' : place.category ? CATEGORY_TEXT[place.category].label : place.dept || 'Edificio';
  const open = () => (place.kind === 'food' ? openFood(place.key) : openBuilding(place.key));
  return el(
    'li',
    {},
    el(
      'button',
      { className: `row row-place place-${place.kind === 'food' ? 'food' : place.category || 'building'}`, type: 'button', on: { click: open } },
      el('div', { className: 'row-main' }, el('div', { className: 'row-title' }, place.name), el('div', { className: 'row-sub' }, sub)),
    ),
  );
}

function detailNav() {
  return el(
    'div',
    { className: 'detail-nav' },
    state.history.length > 0 ? el('button', { className: 'back', type: 'button', on: { click: back } }, '‹ Indietro') : null,
    el('button', { className: 'close', type: 'button', 'aria-label': 'Chiudi', on: { click: closeDetail } }, '×'),
  );
}

function renderHome() {
  const s = state.status;
  if (!s) {
    panelBody.append(
      state.statusError
        ? el('div', { className: 'notice error' }, 'Non riesco a caricare gli orari. Riprovo tra un minuto.')
        : el('p', { className: 'muted' }, 'Caricamento delle aule…'),
    );
    return;
  }
  const counts = { free: 0, busy: 0, unknown: 0 };
  for (const r of s.rooms) counts[roomState(r)] += 1;
  panelBody.append(
    el(
      'div',
      { className: 'summary' },
      el('div', { className: 'stat stat-free' }, el('strong', {}, String(counts.free)), el('span', {}, 'aule libere adesso')),
      el('div', { className: 'stat stat-busy' }, el('strong', {}, String(counts.busy)), el('span', {}, 'aule occupate')),
    ),
  );
  if (counts.unknown > 0) panelBody.append(el('p', { className: 'muted note-unknown' }, `${counts.unknown} aule senza dati aggiornati, mostrate in grigio.`));
  if (s.rooms.length === 0) {
    panelBody.append(el('p', { className: 'muted' }, 'Nessuna aula negli orari caricati per questo periodo.'));
    return;
  }
  const best = Object.entries(s.buildings)
    .filter(([, b]) => isFresh() && b.total.free > 0)
    .sort((a, b) => b[1].total.free - a[1].total.free)
    .slice(0, 8);
  if (best.length > 0) {
    panelBody.append(
      group(
        'buildings',
        'Edifici con più aule libere',
        el(
          'ul',
          { className: 'list list-buildings' },
          best.map(([key, b]) =>
            el(
              'li',
              {},
              el(
                'button',
                { className: 'row row-building', type: 'button', on: { click: () => openBuilding(key) } },
                el(
                  'div',
                  { className: 'row-main' },
                  el('div', { className: 'row-title' }, placeName(key)),
                  el('div', { className: 'row-sub' }, `${b.total.free} libere su ${b.total.free + b.total.busy + b.total.unknown}`),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
  panelBody.append(el('p', { className: 'muted hint' }, 'Tocca un cubo sulla mappa per vedere le sue aule, piano per piano.'));
}

function renderBuilding(v) {
  const place = state.places.get(v.key);
  const rooms = (state.status?.rooms || []).filter((r) => r.buildingKey === v.key);
  const category = place && place.category ? CATEGORY_TEXT[place.category] : null;
  panelBody.append(detailNav());
  panelBody.append(
    el(
      'div',
      { className: `detail-head detail-building${place?.category ? ` place-${place.category}` : ''}` },
      el('h2', {}, place ? place.name : 'Edificio'),
      category ? el('p', {}, category.label) : place?.dept ? el('p', {}, place.dept) : null,
    ),
  );
  if (category && rooms.length === 0) {
    renderPlaceInfo(v.key, category.note);
    return;
  }
  if (!state.status) {
    panelBody.append(
      state.statusError
        ? el('div', { className: 'notice error' }, 'Non riesco a caricare gli orari. Riprovo tra un minuto.')
        : el('p', { className: 'muted' }, 'Caricamento delle aule…'),
    );
    return;
  }
  if (rooms.length === 0) {
    panelBody.append(el('p', { className: 'muted' }, 'Nessuna aula di questo edificio compare negli orari caricati.'));
    return;
  }
  const counts = { free: 0, busy: 0, unknown: 0 };
  for (const r of rooms) counts[roomState(r)] += 1;
  panelBody.append(
    el(
      'p',
      { className: 'muted building-counts' },
      parts([
        ['count count-free', `${counts.free} libere`],
        ['count count-busy', `${counts.busy} occupate`],
        ['count count-unknown', counts.unknown ? `${counts.unknown} non aggiornate` : null],
      ]),
    ),
  );
  const groups = new Map();
  for (const r of rooms) {
    const k = r.floor === null ? 'none' : String(r.floor);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const order = [...groups.keys()].sort((a, b) => (a === 'none' ? 1 : b === 'none' ? -1 : Number(a) - Number(b)));
  for (const k of order) {
    const label = floorLabel(k === 'none' ? null : Number(k));
    const rows = groups.get(k).map((r) => roomRow(r, { showBuilding: false }));
    panelBody.append(group('floor', label.charAt(0).toUpperCase() + label.slice(1), el('ul', { className: 'list list-rooms' }, rows)));
  }
}

function stateBanner(room) {
  const s = roomState(room);
  if (s === 'unknown') {
    return el(
      'div',
      { className: 'state-banner state-unknown' },
      el('span', { className: 'banner-head' }, 'Dato non aggiornato'),
      el('small', { className: 'banner-note' }, 'Gli orari di questa aula non sono stati scaricati di recente: non possiamo dire se è libera.'),
    );
  }
  if (s === 'busy') {
    const until = room.until ? [' fino alle ', timeOf(room.until)] : null;
    const reason = {
      occupied: 'Segnalazione approvata da un moderatore.',
      crowd: 'Segnalata come occupata da più persone in questo momento.',
      closed: 'Chiusura segnalata e approvata.',
    }[room.report];
    const head = room.report === 'closed' ? 'Chiusa' : room.report === 'crowd' ? 'Probabilmente occupata' : 'Occupata';
    return el(
      'div',
      { className: 'state-banner state-busy' },
      el('span', { className: 'banner-head' }, head, until),
      reason
        ? el('small', { className: 'banner-reason' }, reason)
        : room.current
          ? el('small', { className: 'banner-current' }, prettyTitle(room.current.title))
          : null,
    );
  }
  let next = null;
  if (room.next) {
    const sameDay = isoDayOf(room.next.start) === isoDayOf(Date.now());
    next = el(
      'small',
      { className: 'banner-next' },
      `Prossima lezione: ${prettyTitle(room.next.title)}, ${sameDay ? '' : fmtDay(room.next.start) + ' '}alle ${fmtTime(room.next.start)}`,
    );
  }
  return el(
    'div',
    { className: 'state-banner state-free' },
    el('span', { className: 'banner-head' }, room.until ? ['Libera fino alle ', timeOf(room.until)] : 'Libera per il resto della giornata'),
    next,
  );
}

function canReportNotHeld(l, now) {
  return signedIn() && l.status === 'active' && l.start <= now + 15 * 60_000 && l.end >= now - 12 * 3_600_000;
}

function lessonItem(l, now, onNotHeld, view) {
  const reported = view && view.reportedLessons && view.reportedLessons.has(l.id);
  const sending = view && view.report && view.report.sending;
  const running = l.status === 'active' && l.start <= now && now < l.end;
  const classes = ['lesson'];
  if (l.end <= now) classes.push('done');
  if (l.status === 'cancelled') classes.push('cancelled');
  if (running) classes.push('running');
  if (l.notHeld) classes.push('not-held');
  const meta = parts([
    ['lesson-teacher', l.teachers.join(', ')],
    ['lesson-year', l.year ? `${l.year}° anno` : null],
    ['lesson-course', l.courses[0] ? prettyTitle(l.courses[0]) : null],
  ]);
  return el(
    'li',
    { className: classes.join(' ') },
    el(
      'div',
      { className: 'lesson-time' },
      el('span', { className: 'lesson-hours' }, el('span', { className: 'lesson-start' }, fmtTime(l.start)), '-', el('span', { className: 'lesson-end' }, fmtTime(l.end))),
      running ? el('span', { className: 'tag tag-now' }, 'in corso') : null,
      l.notHeld
        ? el('span', { className: 'tag tag-not-held' }, 'non tenuta, segnalata')
        : l.status === 'cancelled'
          ? el('span', { className: 'tag tag-cancelled' }, 'annullata')
          : null,
    ),
    el('div', { className: 'lesson-title' }, prettyTitle(l.title)),
    meta.length > 0 ? el('div', { className: 'lesson-meta' }, meta) : null,
    reported
      ? el('div', { className: 'lesson-meta lesson-reported' }, 'Segnalata come non tenuta')
      : onNotHeld && canReportNotHeld(l, now)
        ? el('button', { className: 'link-btn lesson-report', type: 'button', disabled: sending, on: { click: () => onNotHeld(l) } }, 'Segnala che non si è tenuta')
        : null,
  );
}

function renderRoom(v) {
  const room = state.status?.rooms.find((r) => r.id === v.id) || v.data?.room;
  panelBody.append(detailNav());
  if (!room) {
    panelBody.append(v.error ? el('div', { className: 'notice error' }, 'Aula non trovata negli orari caricati.') : el('p', { className: 'muted' }, 'Caricamento…'));
    return;
  }
  const seats = room.capacity
    ? `${room.capacity}${room.effectiveCapacity && room.effectiveCapacity !== room.capacity ? ` (${room.effectiveCapacity} effettivi)` : ''}`
    : 'non indicati';
  const services = room.services.length ? parts(room.services.map((s) => ['service', s]), ', ') : 'non indicati';
  // Name, place, state and seats in one block, so a theme can draw it as a title block.
  panelBody.append(
    el(
      'div',
      { className: 'room-head' },
      el(
        'div',
        { className: 'detail-head detail-room' },
        el('h2', { className: 'room-name' }, room.name),
        el('p', { className: 'room-where' }, parts([['room-building', placeName(room.buildingKey, room.buildingName)], ['room-floor', floorLabel(room.floor)]])),
      ),
      stateBanner(room),
      el(
        'dl',
        { className: 'facts room-facts' },
        el('dt', { className: 'fact-seats' }, 'Posti'),
        el('dd', { className: 'fact-seats' }, seats),
        el('dt', { className: 'fact-services' }, 'Servizi'),
        el('dd', { className: 'fact-services' }, services),
      ),
    ),
  );
  if (room.issues && room.issues.length > 0) {
    const list = room.issues.map((i) => CATEGORY_LABEL[i.category] || 'Altro').join(', ');
    panelBody.append(el('div', { className: 'notice notice-issues' }, `Disservizi segnalati: ${list}.`));
  }
  const reports = reportBox(room, v);
  if (reports) panelBody.append(reports);

  const step = v.mode === 'day' ? 1 : 7;
  const move = (n) => {
    v.day = shiftDay(v.day, n * step);
    loadRoom(v);
  };
  const toggle = () => {
    v.mode = v.mode === 'day' ? 'week' : 'day';
    loadRoom(v);
  };
  const rangeLabel = v.mode === 'day' ? dayTitle(v.day) : `Settimana dal ${fmtDay(Date.parse(mondayOf(v.day) + 'T12:00:00Z'))}`;
  panelBody.append(
    el(
      'div',
      { className: `tabs mode-${v.mode}` },
      el('button', { className: 'icon-btn nav-prev', type: 'button', 'aria-label': v.mode === 'day' ? 'Giorno precedente' : 'Settimana precedente', on: { click: () => move(-1) } }, '‹'),
      el('strong', { className: 'range-label' }, rangeLabel),
      el('button', { className: 'icon-btn nav-next', type: 'button', 'aria-label': v.mode === 'day' ? 'Giorno successivo' : 'Settimana successiva', on: { click: () => move(1) } }, '›'),
      el('span', { className: 'spacer' }),
      el('button', { className: 'chip mode-toggle', type: 'button', on: { click: toggle } }, v.mode === 'day' ? 'Settimana' : 'Giorno'),
    ),
  );

  if (v.error) {
    const msg = v.error.code === 'invalid' ? 'Questo periodo è fuori dagli orari scaricati.' : 'Impossibile caricare le lezioni. Riprova.';
    panelBody.append(el('div', { className: 'notice error' }, msg));
    return;
  }
  if (!v.data) {
    panelBody.append(el('p', { className: 'muted' }, 'Caricamento delle lezioni…'));
    return;
  }
  const now = Date.now();
  const notHeld = (l) => submitReport(v, room.id, 'lesson_not_held', { lessonId: l.id });
  if (v.data.lessons.length === 0) {
    panelBody.append(el('p', { className: 'muted' }, 'Nessuna lezione in programma in questa aula.'));
    return;
  }
  if (v.mode === 'day') {
    panelBody.append(el('ul', { className: 'lessons lessons-day' }, v.data.lessons.map((l) => lessonItem(l, now, notHeld, v))));
    return;
  }
  const byDay = new Map();
  for (const l of v.data.lessons) {
    const d = isoDayOf(l.start);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(l);
  }
  const list = el('ul', { className: 'lessons lessons-week' });
  for (const [d, lessons] of byDay) {
    list.append(el('li', { className: 'day-title' }, dayTitle(d)));
    for (const l of lessons) list.append(lessonItem(l, now, notHeld, v));
  }
  panelBody.append(list);
}

const REPORT_ERRORS = {
  duplicate: 'Hai già fatto questa segnalazione.',
  rate_limited: 'Hai raggiunto il limite di 20 segnalazioni al giorno.',
  too_many_pending: 'Hai già diverse segnalazioni in attesa: aspetta che un moderatore le controlli.',
  window: 'Non è più possibile fare questa segnalazione.',
  unauthorized: 'Sessione scaduta: accedi di nuovo.',
  accounts_disabled: 'Le segnalazioni non sono attive in questo momento.',
  not_found: 'Aula non trovata negli orari caricati.',
};

async function submitReport(view, roomId, kind, extra = {}) {
  if (view.report && view.report.sending) return;
  view.report = { sending: true };
  render();
  try {
    await authed('/api/requests', { method: 'POST', body: { roomId, kind, ...extra } });
    if (extra.lessonId) (view.reportedLessons ??= new Set()).add(extra.lessonId);
    view.report = { ok: true, text: 'Segnalazione inviata, grazie. La vedrà un moderatore.' };
    loadStatus();
  } catch (err) {
    const text = err.code === 'invalid' && err.field === 'lesson' ? REPORT_ERRORS.window : REPORT_ERRORS[err.code];
    view.report = { ok: false, text: text || 'Segnalazione non inviata, riprova.' };
  }
  if (state.view === view) render();
}

function reportBox(room, v) {
  if (!accountsEnabled()) return null;
  const box = el('section', { className: 'report-box' }, el('h3', { className: 'section-title' }, 'Segnala'));
  if (!signedIn()) {
    box.append(
      el('p', { className: 'muted report-login-note' }, 'Accedi con la mail Unical per segnalare un problema o un\'aula occupata.'),
      el('button', { className: 'chip report-login', type: 'button', on: { click: () => show({ name: 'login' }) } }, 'Accedi'),
    );
    return box;
  }
  const busy = v.report && v.report.sending;
  const category = el(
    'select',
    { className: 'report-category', 'aria-label': 'Tipo di disservizio', on: { change: (e) => (v.category = e.target.value) } },
    el('option', { value: '' }, 'Disservizio…'),
    Object.entries(CATEGORY_LABEL).map(([value, text]) => el('option', { value }, text)),
  );
  category.value = v.category || '';
  box.append(
    el(
      'div',
      { className: 'chip-row report-quick' },
      el('button', { className: 'chip report-occupied', type: 'button', disabled: busy, on: { click: () => submitReport(v, room.id, 'room_occupied') } }, 'È occupata adesso'),
      el('button', { className: 'chip report-closed', type: 'button', disabled: busy, on: { click: () => submitReport(v, room.id, 'room_closed') } }, 'È chiusa'),
    ),
    el(
      'div',
      { className: 'chip-row report-issue' },
      category,
      el(
        'button',
        {
          className: 'chip report-send',
          type: 'button',
          disabled: busy,
          on: { click: () => category.value && submitReport(v, room.id, 'issue', { category: category.value }) },
        },
        'Invia',
      ),
    ),
  );
  if (v.report && !v.report.sending) box.append(el('div', { className: `notice ${v.report.ok ? 'ok' : 'error'}` }, v.report.text));
  box.append(el('p', { className: 'muted report-note' }, 'Un moderatore controlla ogni segnalazione. "Occupata" compare subito se la segnalano almeno 3 persone.'));
  return box;
}

const LOGIN_ERRORS = {
  domain: 'Usa la tua mail @unical.it o @studenti.unical.it.',
  rate_limited: 'Hai già chiesto un link da poco: aspetta un minuto e riprova.',
  error: 'Invio non riuscito, riprova tra poco.',
};

function renderLogin(v) {
  panelBody.append(detailNav());
  panelBody.append(el('div', { className: 'detail-head detail-login' }, el('h2', {}, 'Accedi'), el('p', {}, 'Ti mandiamo un link alla mail Unical: niente password.')));
  if (v.sent) {
    panelBody.append(el('div', { className: 'notice ok' }, 'Controlla la mail e apri il link da questo browser.'));
    return;
  }
  const input = el('input', {
    className: 'login-email',
    type: 'email',
    required: true,
    maxlength: '254',
    autocomplete: 'email',
    placeholder: 'nome@studenti.unical.it',
    'aria-label': 'Mail Unical',
    on: { input: (e) => (v.email = e.target.value) },
  });
  input.value = v.email || '';
  const form = el(
    'form',
    {
      className: 'login-form',
      on: {
        submit: async (e) => {
          e.preventDefault();
          v.error = null;
          const result = await sendLoginLink(input.value, '/');
          if (result.ok) v.sent = true;
          else v.error = LOGIN_ERRORS[result.code] || LOGIN_ERRORS.error;
          render();
        },
      },
    },
    input,
    el('button', { className: 'chip login-submit', type: 'submit' }, 'Mandami il link'),
  );
  panelBody.append(form);
  if (v.error) panelBody.append(el('div', { className: 'notice error' }, v.error));
}

async function openMine() {
  const view = { name: 'mine', items: null, error: false };
  show(view);
  try {
    view.items = (await authed('/api/requests/mine')).requests;
  } catch {
    view.error = true;
  }
  if (state.view === view) render();
}

function renderMine(v) {
  panelBody.append(detailNav());
  const admin = state.role === 'moderator' || state.role === 'admin' ? el('a', { className: 'chip admin-link', href: themed('/admin') }, 'Area admin') : null;
  panelBody.append(
    el('div', { className: 'detail-head detail-mine' }, el('h2', {}, 'Le mie segnalazioni')),
    el(
      'div',
      { className: 'chip-row account-actions' },
      admin,
      el(
        'button',
        {
          className: 'chip logout',
          type: 'button',
          on: {
            click: async () => {
              await signOut();
              state.role = null;
              renderAccount();
              back();
            },
          },
        },
        'Esci',
      ),
    ),
  );
  if (v.error) return panelBody.append(el('div', { className: 'notice error' }, 'Impossibile caricare le segnalazioni.'));
  if (!v.items) return panelBody.append(el('p', { className: 'muted' }, 'Caricamento…'));
  if (v.items.length === 0) return panelBody.append(el('p', { className: 'muted' }, 'Non hai ancora fatto segnalazioni.'));
  panelBody.append(
    el(
      'ul',
      { className: 'list list-requests' },
      v.items.map((r) => {
        const what = r.kind === 'issue' ? `${KIND_LABEL.issue}: ${CATEGORY_LABEL[r.category] || 'Altro'}` : KIND_LABEL[r.kind];
        const where = r.roomName ? `${r.roomName}, ${placeName(r.buildingKey, r.buildingName)}` : 'Aula non più negli orari';
        return el(
          'li',
          { className: `row row-request request-${Object.hasOwn(STATUS_LABEL, r.status) ? r.status : 'other'}` },
          el(
            'div',
            { className: 'row-main' },
            el('div', { className: 'row-title' }, what),
            el('div', { className: 'row-sub' }, parts([['request-where', where], ['request-date', fmtDay(r.createdAt)]])),
          ),
          el('span', { className: `pill pill-${r.status === 'approved' ? 'free' : r.status === 'rejected' ? 'busy' : 'unknown'} pill-request` }, STATUS_LABEL[r.status]),
        );
      }),
    ),
  );
}

function renderAccount() {
  const button = $('account');
  if (!accountsEnabled()) {
    button.hidden = true;
    return;
  }
  button.hidden = false;
  button.textContent = signedIn() ? 'Il mio account' : 'Accedi';
}

async function refreshRole() {
  state.role = null;
  if (!signedIn()) return;
  try {
    state.role = (await authed('/api/me')).role;
  } catch {
    state.role = null;
  }
  if (state.view.name === 'mine') render();
}

function dayTitle(iso) {
  const today = isoDayOf(Date.now());
  if (iso === today) return 'Oggi';
  if (iso === shiftDay(today, 1)) return 'Domani';
  if (iso === shiftDay(today, -1)) return 'Ieri';
  const label = fmtDay(Date.parse(iso + 'T12:00:00Z'));
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function safeLink(href, text) {
  try {
    const url = new URL(href);
    if (url.protocol !== 'https:') return null;
    return el('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, text);
  } catch {
    return null;
  }
}

// Hours and links of libraries, study rooms and theatres, from public/data/places.json (source and check date included).
function renderPlaceInfo(key, fallback) {
  const info = state.placeInfo?.places?.[key];
  if (!info) {
    panelBody.append(el('p', { className: 'muted place-note' }, fallback));
    return;
  }
  if (info.hours && info.hours.length > 0) {
    panelBody.append(el('dl', { className: 'facts hours' }, info.hours.flatMap((h) => [el('dt', {}, h.days), el('dd', {}, h.time)])));
  }
  if (info.note) panelBody.append(el('p', { className: 'muted place-note' }, info.note));
  const links = (info.links || []).map((l) => safeLink(l.url, l.label)).filter(Boolean);
  if (links.length > 0) panelBody.append(el('div', { className: 'chip-row place-links' }, links.map((a) => ((a.className = 'chip'), a))));
  const source = info.source ? safeLink(info.source, 'fonte') : null;
  if (info.checkedAt) {
    panelBody.append(el('p', { className: 'muted source-note' }, `Informazioni verificate il ${info.checkedAt}`, source ? ', ' : '', source, '. Possono cambiare durante le festività.'));
  }
}

function renderFood(v) {
  const place = state.places.get(v.key);
  panelBody.append(detailNav());
  panelBody.append(el('div', { className: 'detail-head detail-food' }, el('h2', {}, place ? place.name : 'Mensa'), el('p', {}, 'Mensa e ristoro')));
  if (place?.note) panelBody.append(el('p', { className: 'muted place-note' }, place.note));
  const info = state.canteens?.places?.[v.key];
  if (!info) {
    panelBody.append(el('p', { className: 'muted source-note' }, 'Orari non disponibili qui. ', safeLink(MENSA_PAGE, 'Pagina del servizio mensa Unical')));
    return;
  }
  panelBody.append(
    el(
      'dl',
      { className: 'facts hours' },
      info.hours.flatMap((h) => [el('dt', {}, h.days), el('dd', {}, h.time)]),
    ),
  );
  if (info.note) panelBody.append(el('p', { className: 'muted place-note' }, info.note));
  if (info.official === false) {
    panelBody.append(
      el('p', { className: 'muted source-note' }, 'Orari non presenti nelle pagine ufficiali, indicati da chi frequenta il campus. ', safeLink(MENSA_PAGE, 'Pagina del servizio mensa')),
    );
    return;
  }
  const source = safeLink(info.source || state.canteens.source || MENSA_PAGE, 'fonte');
  panelBody.append(el('p', { className: 'muted source-note' }, `Orari verificati il ${state.canteens.checkedAt}, `, source, '. Possono cambiare durante le festività.'));
}

// ---------- search ----------

function matchPlaces(query) {
  const tokens = normalize(query)
    .split(' ')
    .filter((t) => t && t !== 'cubo' && t !== 'aula');
  if (tokens.length === 0) return [];
  const out = [];
  for (const place of state.places.values()) {
    const extra = place.kind === 'food' ? 'mensa ristoro bar mangiare' : place.category ? CATEGORY_TEXT[place.category].words : '';
    const hay = normalize(`${place.name} ${place.dept || ''} ${extra}`);
    const compact = hay.replace(/\s+/g, '');
    if (tokens.every((t) => hay.includes(t) || compact.includes(t))) out.push(place);
    if (out.length >= 8) break;
  }
  return out;
}

async function runSearch(reset = true) {
  const q = state.query.trim();
  const f = state.filters;
  if (!q && !f.free && !f.hours && !f.seats) {
    if (state.view.name === 'search') {
      state.view = { name: 'home' };
      state.history = [];
    }
    render();
    return;
  }
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (f.free) params.set('free', '1');
  if (f.hours) params.set('hours', String(f.hours));
  if (f.seats) params.set('seats', String(f.seats));
  const view = { name: 'search', results: state.view.name === 'search' && !reset ? state.view.results : null, error: null, places: q ? matchPlaces(q) : [] };
  state.view = view;
  state.history = [];
  setCollapsed(false);
  render();
  try {
    view.results = await api(`/api/search?${params}`);
  } catch (err) {
    view.error = err;
  }
  if (state.view === view) render();
}

function lessonHitRow(hit) {
  const day = isoDayOf(hit.start);
  return el(
    'li',
    {},
    el(
      'button',
      { className: 'row row-lesson', type: 'button', on: { click: () => openRoom(hit.roomId, day) } },
      el(
        'div',
        { className: 'row-main' },
        el('div', { className: 'row-title' }, prettyTitle(hit.title)),
        el(
          'div',
          { className: 'row-sub' },
          parts([
            ['hit-when', `${dayTitle(day)} ${fmtTime(hit.start)}-${fmtTime(hit.end)}`],
            ['hit-where', `${hit.roomName}, ${placeName(hit.buildingKey, hit.buildingName)}`],
          ]),
        ),
      ),
    ),
  );
}

function group(name, title, list) {
  return el('div', { className: `group group-${name}` }, el('h3', { className: 'section-title' }, title), list);
}

function renderSearch(v) {
  if (v.places.length > 0) {
    panelBody.append(group('places', 'Luoghi', el('ul', { className: 'list list-places' }, v.places.map(placeRow))));
  }
  if (v.error) {
    panelBody.append(
      el('div', { className: 'notice error' }, v.error.code === 'invalid' ? 'Ricerca non valida: controlla il testo e i filtri.' : 'Ricerca non disponibile al momento.'),
    );
    return;
  }
  if (!v.results) {
    panelBody.append(el('p', { className: 'muted' }, 'Ricerca in corso…'));
    return;
  }
  const { rooms, lessons } = v.results;
  if (rooms.length > 0) {
    panelBody.append(group('rooms', 'Aule', el('ul', { className: 'list list-rooms' }, rooms.map((r) => roomRow(r)))));
  }
  if (lessons.length > 0) {
    panelBody.append(group('lessons', 'Lezioni', el('ul', { className: 'list list-lessons' }, lessons.map(lessonHitRow))));
  }
  if (rooms.length === 0 && lessons.length === 0 && v.places.length === 0) {
    panelBody.append(el('p', { className: 'muted' }, 'Nessun risultato.'));
  }
}

function bindControls() {
  panelToggle.addEventListener('click', () => setCollapsed(!panel.classList.contains('collapsed')));
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '')) return;
    if (['building', 'room', 'food', 'login', 'mine'].includes(state.view.name)) closeDetail();
  });
  const input = $('q');
  input.addEventListener(
    'input',
    debounce(() => {
      state.query = input.value;
      runSearch();
    }, 250),
  );
  $('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.query = input.value;
    runSearch();
  });
  const free = $('f-free');
  free.addEventListener('click', () => {
    state.filters.free = !state.filters.free;
    free.setAttribute('aria-pressed', String(state.filters.free));
    runSearch();
  });
  $('f-hours').addEventListener('change', (e) => {
    state.filters.hours = e.target.value ? Number(e.target.value) : null;
    runSearch();
  });
  const seats = $('f-seats');
  seats.addEventListener(
    'input',
    debounce(() => {
      const raw = seats.value.trim();
      const n = Number(raw);
      state.filters.seats = /^\d{1,4}$/.test(raw) && n >= 1 && n <= 2000 ? n : null;
      seats.setAttribute('aria-invalid', String(raw !== '' && state.filters.seats === null));
      runSearch();
    }, 350),
  );
}

// ---------- start ----------

async function start() {
  bindControls();
  render();
  renderFoot();
  $('account').addEventListener('click', () => (signedIn() ? openMine() : show({ name: 'login' })));
  const auth = await initAuth();
  if (auth.status === 'ready') {
    onSessionChange(() => {
      renderAccount();
      refreshRole();
      if (state.view.name === 'login' && signedIn()) back();
      else render();
    });
    refreshRole();
    if (auth.linkFailed) show({ name: 'login', error: 'Il link non è valido o è scaduto, oppure è stato aperto in un altro browser. Chiedine uno nuovo.' });
  }
  renderAccount();
  try {
    state.campus = await api('/data/campus.geojson');
  } catch {
    panelBody.replaceChildren(el('div', { className: 'notice error' }, 'Impossibile caricare la mappa del campus. Ricarica la pagina.'));
    return;
  }
  state.canteens = await api('/data/canteens.json').catch(() => null);
  state.placeInfo = await api('/data/places.json').catch(() => null);
  indexPlaces();
  initMap();
  await loadStatus();
  setInterval(loadStatus, STATUS_REFRESH_MS);
  setInterval(() => {
    if (!isFresh()) {
      updateMap();
      renderFoot();
    }
  }, 30_000);
}

start();
