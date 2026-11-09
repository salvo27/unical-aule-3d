// Admin configuration aggregate: every change goes through these pure functions,
// which validate input and return a new object.
import {
  calendarId,
  calendarReference,
  plannerId,
  floor,
  floorCount,
  baseLevel,
  sourceUrl,
  label,
  type CalendarId,
  type Label,
  type SourceUrl,
  type Floor,
  type FloorCount,
  type BaseLevel,
} from './primitives.js';
import { ValidationError } from './errors.js';

export interface CalendarEntry {
  id: CalendarId;
  label: Label;
  active: boolean;
  addedAt: number;
}

export interface BuildingShape {
  floors: FloorCount;
  baseLevel: BaseLevel;
}

export interface AdminConfig {
  version: 1;
  calendars: CalendarEntry[];
  sources: SourceUrl[];
  rooms: Record<string, { floor: Floor }>;
  buildings: Record<string, BuildingShape>;
  buildingLinks: Record<string, string>;
}

export class DomainError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'DomainError';
    this.code = code;
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const LIMITS = { calendars: 600, sources: 60, rooms: 3000, buildings: 300, links: 300 } as const;

const CAMPUS_KEY = /^[a-z0-9-]{1,80}$/;

export function emptyConfig(): AdminConfig {
  return { version: 1, calendars: [], sources: [], rooms: {}, buildings: {}, buildingLinks: {} };
}

export function addCalendar(config: AdminConfig, reference: unknown, name: unknown, now: number): AdminConfig {
  const id = calendarReference(reference);
  const entryLabel = label(name);
  if (config.calendars.some((c) => c.id === id)) throw new DomainError('calendar_exists');
  if (config.calendars.length >= LIMITS.calendars) throw new DomainError('too_many_calendars');
  return { ...config, calendars: [...config.calendars, { id, label: entryLabel, active: true, addedAt: now }] };
}

export function removeCalendar(config: AdminConfig, id: unknown): AdminConfig {
  const target = calendarId(id);
  if (!config.calendars.some((c) => c.id === target)) throw new DomainError('calendar_missing');
  return { ...config, calendars: config.calendars.filter((c) => c.id !== target) };
}

export function setCalendarActive(config: AdminConfig, id: unknown, active: unknown): AdminConfig {
  const target = calendarId(id);
  if (typeof active !== 'boolean') throw new ValidationError('active');
  if (!config.calendars.some((c) => c.id === target)) throw new DomainError('calendar_missing');
  return { ...config, calendars: config.calendars.map((c) => (c.id === target ? { ...c, active } : c)) };
}

export function renameCalendar(config: AdminConfig, id: unknown, name: unknown): AdminConfig {
  const target = calendarId(id);
  const entryLabel = label(name);
  if (!config.calendars.some((c) => c.id === target)) throw new DomainError('calendar_missing');
  return { ...config, calendars: config.calendars.map((c) => (c.id === target ? { ...c, label: entryLabel } : c)) };
}

export function setSources(config: AdminConfig, urls: unknown): AdminConfig {
  if (!Array.isArray(urls)) throw new ValidationError('sources');
  if (urls.length > LIMITS.sources) throw new DomainError('too_many_sources');
  const unique = [...new Set(urls.map((u) => sourceUrl(u)))];
  return { ...config, sources: unique };
}

export function setRoomFloor(config: AdminConfig, roomId: unknown, value: unknown): AdminConfig {
  const id = plannerId(roomId);
  const rooms = { ...config.rooms };
  if (value === null) {
    delete rooms[id];
  } else {
    if (!(id in rooms) && Object.keys(rooms).length >= LIMITS.rooms) throw new DomainError('too_many_rooms');
    rooms[id] = { floor: floor(value) };
  }
  return { ...config, rooms };
}

function knownKey(keys: ReadonlySet<string>, key: unknown): string {
  if (typeof key !== 'string' || !CAMPUS_KEY.test(key) || !keys.has(key)) throw new DomainError('unknown_building');
  return key;
}

export function setBuildingShape(
  config: AdminConfig,
  keys: ReadonlySet<string>,
  key: unknown,
  floors: unknown,
  base: unknown,
): AdminConfig {
  const k = knownKey(keys, key);
  const shape = { floors: floorCount(floors), baseLevel: baseLevel(base) };
  if (!(k in config.buildings) && Object.keys(config.buildings).length >= LIMITS.buildings) {
    throw new DomainError('too_many_buildings');
  }
  return { ...config, buildings: { ...config.buildings, [k]: shape } };
}

function plannerBuildingName(value: unknown): string {
  const name = label(value);
  if (name.length > 100) throw new ValidationError('building_name');
  return name;
}

export function linkBuilding(config: AdminConfig, keys: ReadonlySet<string>, name: unknown, key: unknown): AdminConfig {
  const plannerName = plannerBuildingName(name);
  const links = { ...config.buildingLinks };
  if (key === null) {
    delete links[plannerName];
  } else {
    if (!(plannerName in links) && Object.keys(links).length >= LIMITS.links) throw new DomainError('too_many_links');
    links[plannerName] = knownKey(keys, key);
  }
  return { ...config, buildingLinks: links };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Reads back what we wrote. Anything else means tampering or corruption: refuse it.
export function parseConfig(value: unknown): AdminConfig {
  try {
    if (!isRecord(value) || value.version !== 1) throw new ConfigError('version');
    const { calendars, sources, rooms, buildings, buildingLinks } = value;
    if (!Array.isArray(calendars) || calendars.length > LIMITS.calendars) throw new ConfigError('calendars');
    if (!Array.isArray(sources) || sources.length > LIMITS.sources) throw new ConfigError('sources');
    if (!isRecord(rooms) || !isRecord(buildings) || !isRecord(buildingLinks)) throw new ConfigError('maps');
    const seen = new Set<string>();
    const parsedCalendars = calendars.map((c): CalendarEntry => {
      if (!isRecord(c) || typeof c.active !== 'boolean' || typeof c.addedAt !== 'number' || !Number.isFinite(c.addedAt)) {
        throw new ConfigError('calendar');
      }
      const id = calendarId(c.id);
      if (seen.has(id)) throw new ConfigError('calendar_duplicate');
      seen.add(id);
      return { id, label: label(c.label), active: c.active, addedAt: c.addedAt };
    });
    const parsedRooms: AdminConfig['rooms'] = {};
    for (const [id, r] of Object.entries(rooms)) {
      if (!isRecord(r)) throw new ConfigError('room');
      parsedRooms[plannerId(id)] = { floor: floor(r.floor) };
    }
    const parsedBuildings: AdminConfig['buildings'] = {};
    for (const [key, b] of Object.entries(buildings)) {
      if (!CAMPUS_KEY.test(key) || !isRecord(b)) throw new ConfigError('building');
      parsedBuildings[key] = { floors: floorCount(b.floors), baseLevel: baseLevel(b.baseLevel) };
    }
    const parsedLinks: AdminConfig['buildingLinks'] = {};
    for (const [name, key] of Object.entries(buildingLinks)) {
      if (typeof key !== 'string' || !CAMPUS_KEY.test(key)) throw new ConfigError('link');
      parsedLinks[plannerBuildingName(name)] = key;
    }
    return {
      version: 1,
      calendars: parsedCalendars,
      sources: sources.map((s) => sourceUrl(s)),
      rooms: parsedRooms,
      buildings: parsedBuildings,
      buildingLinks: parsedLinks,
    };
  } catch (err) {
    if (err instanceof ConfigError) throw err;
    throw new ConfigError('invalid_value');
  }
}
