import { atomicWriteJson, readJsonFile } from './files.js';
import { emptyConfig, parseConfig, addCalendar, setSources, linkBuilding, ConfigError, type AdminConfig } from '../domain/admin-config.js';
import { floor, type Floor } from '../domain/primitives.js';
import { buildingKey, seedKey } from '../domain/building.js';

export { ConfigError };

export interface Seed {
  calendars: { id: string; label: string }[];
  sources: string[];
  roomSeeds: { building: string; room: string; floor: number }[];
  buildingLinks?: Record<string, string>;
}

export class ConfigStore {
  private config: AdminConfig;
  private queue: Promise<unknown> = Promise.resolve();
  readonly roomSeeds: ReadonlyMap<string, Floor>;

  private constructor(private readonly path: string, config: AdminConfig, roomSeeds: Map<string, Floor>) {
    this.config = config;
    this.roomSeeds = roomSeeds;
  }

  // A missing file is created from the seed; links in the seed must point to known campus buildings.
  static async open(path: string, seed: Seed, campusKeys: ReadonlySet<string> = new Set()): Promise<ConfigStore> {
    const roomSeeds = new Map<string, Floor>();
    for (const s of seed.roomSeeds) {
      const key = buildingKey(s.building);
      if (!key) throw new ConfigError('seed_building');
      roomSeeds.set(seedKey(key, s.room), floor(s.floor));
    }
    const read = await readJsonFile(path);
    if (read.kind === 'corrupt') throw new ConfigError('corrupt_admin_config');
    if (read.kind === 'ok') return new ConfigStore(path, parseConfig(read.value), roomSeeds);
    let config = setSources(emptyConfig(), seed.sources);
    for (const c of seed.calendars) config = addCalendar(config, c.id, c.label, Date.now());
    for (const [name, key] of Object.entries(seed.buildingLinks ?? {})) config = linkBuilding(config, campusKeys, name, key);
    await atomicWriteJson(path, config);
    return new ConfigStore(path, config, roomSeeds);
  }

  get current(): AdminConfig {
    return this.config;
  }

  // Changes are serialized and the in-memory copy changes only after the file is written.
  update(change: (config: AdminConfig) => AdminConfig): Promise<AdminConfig> {
    const run = this.queue.then(async () => {
      const next = change(this.config);
      await atomicWriteJson(this.path, next);
      this.config = next;
      return next;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
