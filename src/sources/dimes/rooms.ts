// Rooms of the app to the room and building names the Planner uses, so they can join a Planner room.
import { roomMatchKey } from '../../domain/ids.js';
import type { DimesConfig } from './config.js';
import type { Dataset } from './dataset.js';
import { normKey, text } from './text.js';

export interface ResolvedRoom {
  name: string;
  building: string;
  capacity: number | null;
  // null: no building key, the room cannot be drawn.
  matchKey: string | null;
  // Not in the room table of config/dimes.json: name and building come from the general rules.
  fallback: boolean;
}

type Ref = { app: string } | { ext: string };

const MAX_STEPS = 5;
// Placeholders such as "da definire", "n.d.", "?" or a dash: no room.
const VAGUE = /^(aul[ae]\s+)?(da\s*(definire|assegnare|stabilire|decidere)|d[ae]\s*def\.?|n\.?d\.?|\?+|[\p{Pd}.]+)$/iu;
const POLI = /^(.*?)\s*\(\s*polifunzionale\s*(?:,\s*cap\.?\s*([a-z]))?\s*\)$/i;
// "cubo 41 C" anywhere, otherwise an attached code such as "42C"; "Sala 1 e 2" names no cube.
const CUBE_NAMED = /\bcubo\s*(\d{1,2})\s?([a-z]{1,2})\b/i;
const CUBE_CODE = /\b(\d{1,2})([A-Z]{1,2})\b/;

// chiaveNomeAula() of the app: an external text naming a room of the app is that room.
function nameKey(s: string): string {
  return s.toUpperCase().replace(/\(.*$/, '').replace(/[^A-Z0-9]+/g, '');
}

function resolved(name: string, building: string, capacity: number | null, fallback: boolean): ResolvedRoom {
  return { name, building, capacity, matchKey: building ? roomMatchKey(building, name) : null, fallback };
}

export class RoomResolver {
  private readonly byName = new Map<string, string>();

  constructor(
    private readonly ds: Dataset,
    private readonly cfg: DimesConfig,
  ) {
    for (const [id, room] of ds.rooms) {
      const k = room.name ? nameKey(room.name) : '';
      if (k && !this.byName.has(k)) this.byName.set(k, id);
    }
  }

  private renamed(id: string): string {
    let x = id;
    for (let i = 0; i < MAX_STEPS && !this.ds.rooms.has(x); i++) {
      const next = this.ds.renamed.get(x);
      if (!next) break;
      x = next;
    }
    return x;
  }

  private external(t: string | null): string | null {
    if (t === null) return null;
    const x = text(t, 100);
    if (!x || VAGUE.test(x)) return null;
    return this.ds.externalNames.get(normKey(x)) ?? x;
  }

  // Same order as the app: room id, renamed id, free text, name of a removed room.
  private ref(aula: string | null, ext: string | null): Ref | null {
    if (aula !== null) {
      const id = this.renamed(aula);
      if (this.ds.rooms.has(id)) return { app: id };
    }
    const e = this.external(ext);
    if (e) {
      const k = nameKey(e);
      const app = k ? this.byName.get(k) : undefined;
      return app ? { app } : { ext: e };
    }
    if (aula !== null) {
      const old = this.external(this.ds.removed.get(aula) ?? aula.replace(/^A_/, '').replace(/_/g, ' '));
      if (old) return { ext: old };
    }
    return null;
  }

  resolve(aula: string | null, ext: string | null): ResolvedRoom | null {
    const ref = this.ref(aula, ext);
    if (!ref) return null;
    if ('app' in ref) {
      const room = this.ds.rooms.get(ref.app);
      const known = this.cfg.rooms.get(ref.app);
      if (known) return resolved(known.name, known.building, room?.capacity ?? null, false);
      if (room?.name && room.cube) return resolved(room.name, `Cubo ${room.cube}`, room.capacity, true);
      return resolved(room?.name ?? ref.app, '', null, true);
    }
    const known = this.cfg.externalRooms.get(normKey(ref.ext));
    if (known) return resolved(known.name, known.building, null, false);
    const poli = POLI.exec(ref.ext);
    if (poli) {
      const name = text(poli[1], 100) ?? ref.ext;
      return resolved(name, poli[2] ? `Polifunzionale Capannone ${poli[2].toUpperCase()}` : 'Polifunzionale', null, true);
    }
    const cube = CUBE_NAMED.exec(ref.ext) ?? CUBE_CODE.exec(ref.ext);
    if (cube) {
      const name = text(ref.ext.replace(/\s*\(.*$/, ''), 100) ?? ref.ext;
      return resolved(name, `Cubo ${Number(cube[1])}${(cube[2] ?? '').toUpperCase()}`, null, true);
    }
    return resolved(ref.ext, '', null, true);
  }
}
