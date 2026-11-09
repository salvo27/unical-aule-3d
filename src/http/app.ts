import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ConfigStore } from '../store/config-store.js';
import type { SnapshotStore } from '../store/snapshot-store.js';
import type { SyncService } from '../sync/sync.js';
import type { DiscoveryResult } from '../sync/discover.js';
import type { Campus } from '../campus.js';
import type { Logger } from '../log.js';
import type { StaticFile } from './static.js';
import type { SupabaseSettings } from '../config.js';
import type { OverridesService } from '../availability/overrides.js';
import { GatewayError, isUuid, ROLES, type SupabaseGateway, type Identity, type AppRole } from '../supabase/gateway.js';
import { ValidationError } from '../domain/errors.js';
import {
  DomainError,
  addCalendar,
  removeCalendar,
  setCalendarActive,
  setSources,
  setRoomFloor,
  setBuildingShape,
  linkBuilding,
} from '../domain/admin-config.js';
import { plannerId, isoDay, dayCount, searchText, minSeats, minFreeHours, type SourceUrl } from '../domain/primitives.js';
import { parseRequestInput, requestWindow } from '../domain/requests.js';
import { computeStatus, roomLessons, allLessons, notHeldKeys, type StatusResult, type RoomStatus } from '../availability/availability.js';
import { search } from '../availability/search.js';
import { romeDay, romeMidnight, addDays } from '../availability/time.js';

export interface AppDeps {
  config: ConfigStore;
  snapshots: SnapshotStore;
  sync: SyncService;
  campus: Campus;
  staticFiles: ReadonlyMap<string, StaticFile>;
  discover: (sources: readonly SourceUrl[]) => Promise<DiscoveryResult>;
  supabase: SupabaseSettings | null;
  gateway: SupabaseGateway | null;
  overrides: OverridesService;
  log: Logger;
  now: () => number;
  staleAfterMs: number;
  production: boolean;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function csp(supabaseOrigin: string | null): string {
  const connect = ["'self'", 'https://tiles.openfreemap.org', supabaseOrigin].filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src ${connect}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

function securityHeaders(production: boolean, supabaseOrigin: string | null): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Security-Policy': csp(supabaseOrigin),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    // Location only for our own pages (the "my position" button); it never leaves the browser.
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self), payment=()',
  };
  if (production) headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  return headers;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJson(req: IncomingMessage, maxBytes = 16_384): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) throw new HttpError(413, 'payload_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw new HttpError(413, 'payload_too_large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'bad_json');
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)[name] : undefined;
}

// State-changing requests must come from our own pages.
function sameOrigin(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin';
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header.length > 8300) return null;
  const match = /^Bearer ([A-Za-z0-9._-]{1,8192})$/.exec(header);
  return match ? match[1]! : null;
}

type Need = 'user' | 'staff' | 'admin';

export function createHandler(deps: AppDeps): (req: IncomingMessage, res: ServerResponse) => void {
  const headers = securityHeaders(deps.production, deps.supabase?.origin ?? null);
  let cache: { snapshot: unknown; config: unknown; overrides: unknown; slot: number; value: StatusResult } | null = null;

  function status(now: number): StatusResult {
    const snapshot = deps.snapshots.current;
    const config = deps.config.current;
    const overrides = deps.overrides.current;
    const slot = Math.floor(now / 30_000);
    if (cache && cache.snapshot === snapshot && cache.config === config && cache.overrides === overrides.items && cache.slot === slot) {
      return cache.value;
    }
    const value = computeStatus({
      snapshot,
      config,
      roomSeeds: deps.config.roomSeeds,
      campusKeys: deps.campus.keys,
      now,
      staleAfterMs: deps.staleAfterMs,
      overrides: overrides.items,
      reportsAvailable: overrides.available,
    });
    cache = { snapshot, config, overrides: overrides.items, slot, value };
    return value;
  }

  async function identify(req: IncomingMessage, need: Need): Promise<{ token: string; identity: Identity; gateway: SupabaseGateway }> {
    const gateway = deps.gateway;
    if (!gateway) throw new HttpError(503, 'accounts_disabled');
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'unauthorized');
    const identity = await gateway.whoami(token, { fresh: need !== 'user' });
    if (!identity) throw new HttpError(401, 'unauthorized');
    if (need === 'staff' && identity.role === 'student') throw new HttpError(403, 'forbidden');
    if (need === 'admin' && identity.role !== 'admin') throw new HttpError(403, 'forbidden');
    return { token, identity, gateway };
  }

  function roomLabel(rooms: Map<string, RoomStatus>, roomId: string) {
    const room = rooms.get(roomId);
    return room
      ? { roomName: room.name, buildingName: room.buildingName, buildingKey: room.buildingKey, floor: room.floor }
      : { roomName: null, buildingName: null, buildingKey: null, floor: null };
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    const q = url.searchParams;
    const now = deps.now();

    if (method === 'GET' && path === '/api/status') return sendJson(res, 200, status(now));

    if (method === 'GET' && path === '/api/client-config') {
      return sendJson(
        res,
        200,
        deps.supabase ? { accounts: true, supabaseUrl: deps.supabase.url, publishableKey: deps.supabase.publishableKey } : { accounts: false },
      );
    }

    const roomMatch = /^\/api\/rooms\/([^/]{1,40})$/.exec(path);
    if (method === 'GET' && roomMatch) {
      const id = plannerId(roomMatch[1]);
      const today = romeDay(now);
      const fromDay = q.has('from') ? isoDay(q.get('from')) : today;
      if (fromDay < addDays(today, -21) || fromDay > addDays(today, 21)) throw new ValidationError('day');
      const days = q.has('days') ? dayCount(q.get('days')) : 1;
      const room = status(now).rooms.find((r) => r.id === id);
      if (!room) throw new HttpError(404, 'not_found');
      const from = romeMidnight(fromDay);
      const to = romeMidnight(addDays(fromDay, days));
      const lessons = roomLessons(deps.snapshots.current, id, from, to, deps.overrides.current.items).map((l) => ({
        id: l.id,
        title: l.title,
        start: l.start,
        end: l.end,
        status: l.status,
        notHeld: l.notHeld === true,
        kind: l.kind,
        courses: l.courses,
        year: l.year,
        teachers: l.teachers,
      }));
      return sendJson(res, 200, { now, from, to, room, lessons });
    }

    if (method === 'GET' && path === '/api/search') {
      const raw = q.get('q') ?? '';
      const query = raw.trim() === '' ? null : searchText(raw);
      const free = q.get('free');
      if (free !== null && free !== '0' && free !== '1') throw new ValidationError('free');
      const filters = {
        freeNow: free === '1',
        minHours: q.has('hours') ? minFreeHours(q.get('hours')) : null,
        minSeats: q.has('seats') ? minSeats(q.get('seats')) : null,
      };
      const notHeld = notHeldKeys(deps.overrides.current.items);
      return sendJson(res, 200, search(query, filters, status(now).rooms, allLessons(deps.snapshots.current), now, notHeld));
    }

    if (method === 'GET' && path === '/api/me') {
      const { identity } = await identify(req, 'user');
      return sendJson(res, 200, { role: identity.role });
    }

    if (method === 'POST' && path === '/api/requests') {
      if (!sameOrigin(req)) throw new HttpError(403, 'forbidden');
      const { token, gateway } = await identify(req, 'user');
      const input = parseRequestInput(await readJson(req, 1024));
      if (!deps.snapshots.current.rooms[input.roomId]) throw new HttpError(404, 'not_found');
      const lesson = input.lessonId ? (allLessons(deps.snapshots.current).find((l) => l.id === input.lessonId) ?? null) : null;
      const window = requestWindow(input, now, lesson);
      const id = await gateway.submitRequest(token, { roomId: input.roomId, kind: input.kind, category: input.category, lessonId: input.lessonId, ...window });
      deps.log.info('request_submitted', { kind: input.kind });
      void deps.overrides.refresh();
      return sendJson(res, 201, { id });
    }

    if (method === 'GET' && path === '/api/requests/mine') {
      const { token, gateway } = await identify(req, 'user');
      const rooms = new Map(status(now).rooms.map((r) => [r.id, r]));
      const mine = (await gateway.myRequests(token)).map((r) => ({ ...r, ...roomLabel(rooms, r.roomId) }));
      return sendJson(res, 200, { requests: mine });
    }

    throw new HttpError(404, 'not_found');
  }

  async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method !== 'GET' && method !== 'HEAD' && !sameOrigin(req)) throw new HttpError(403, 'forbidden');
    const now = deps.now();

    if (method === 'GET' && path === '/admin/api/session') {
      if (!deps.gateway) return sendJson(res, 200, { accounts: false, role: null });
      const token = bearer(req);
      const identity = token ? await deps.gateway.whoami(token) : null;
      return sendJson(res, 200, { accounts: true, role: identity?.role ?? null });
    }

    if (method === 'GET' && path === '/admin/api/requests') {
      const { token, gateway } = await identify(req, 'staff');
      const rooms = new Map(status(now).rooms.map((r) => [r.id, r]));
      const lessons = allLessons(deps.snapshots.current);
      const pending = (await gateway.pendingRequests(token)).map((r) => {
        const lesson = r.lessonId ? lessons.find((l) => l.id === r.lessonId) : undefined;
        return { ...r, ...roomLabel(rooms, r.roomId), lessonTitle: lesson?.title ?? null };
      });
      return sendJson(res, 200, { requests: pending });
    }

    const reviewMatch = /^\/admin\/api\/requests\/([^/]{1,40})\/review$/.exec(path);
    if (method === 'POST' && reviewMatch) {
      const { token, gateway } = await identify(req, 'staff');
      const id = reviewMatch[1];
      if (!isUuid(id)) throw new ValidationError('request_id');
      const decision = field(await readJson(req, 256), 'decision');
      if (decision !== 'approved' && decision !== 'rejected') throw new ValidationError('decision');
      if (decision === 'approved') {
        // A "not held" can be approved only while that lesson is still in the timetable, in that room, at those times.
        const request = await gateway.getRequest(token, id);
        if (!request) throw new HttpError(404, 'not_found');
        if (request.kind === 'lesson_not_held') {
          const lesson = allLessons(deps.snapshots.current).find((l) => l.id === request.lessonId);
          const matches =
            lesson !== undefined &&
            lesson.status === 'active' &&
            lesson.roomIds.includes(request.roomId as never) &&
            lesson.start === request.start &&
            lesson.end === request.end;
          if (!matches) throw new HttpError(409, 'no_lesson');
        }
      }
      await gateway.reviewRequest(token, id, decision);
      deps.log.info('request_reviewed', { decision });
      await deps.overrides.refresh();
      return sendJson(res, 200, { ok: true });
    }

    // Everything below is for admins only.
    const { token, gateway } = await identify(req, 'admin');

    if (method === 'GET' && path === '/admin/api/staff') {
      return sendJson(res, 200, { users: await gateway.listStaff(token) });
    }
    // The email travels in the body, never in the URL (URLs end up in logs and history).
    if (method === 'POST' && path === '/admin/api/users/lookup') {
      const email = field(await readJson(req, 512), 'email');
      if (typeof email !== 'string' || email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new ValidationError('email');
      return sendJson(res, 200, { user: await gateway.findUser(token, email.trim().toLowerCase()) });
    }
    const roleMatch = /^\/admin\/api\/users\/([^/]{1,40})\/role$/.exec(path);
    if (method === 'PUT' && roleMatch) {
      const userId = roleMatch[1];
      if (!isUuid(userId)) throw new ValidationError('user_id');
      const role = field(await readJson(req, 256), 'role');
      if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) throw new ValidationError('role');
      await gateway.setUserRole(token, userId, role as AppRole);
      deps.log.info('role_changed', { role });
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && path === '/admin/api/overview') {
      const config = deps.config.current;
      const snapshot = deps.snapshots.current;
      const current = status(now);
      return sendJson(res, 200, {
        now,
        sync: { running: deps.sync.running, lastRun: snapshot.lastRun },
        calendars: config.calendars.map((c) => ({
          ...c,
          run: snapshot.runs[c.id] ?? null,
          fetchedAt: snapshot.calendars[c.id]?.fetchedAt ?? null,
        })),
        sources: config.sources,
        rooms: current.rooms.map((r) => ({
          id: r.id,
          name: r.name,
          buildingName: r.buildingName,
          buildingKey: r.buildingKey,
          floor: r.floor,
          floorSource: config.rooms[r.id] ? 'admin' : r.floor !== null ? 'seed' : null,
          capacity: r.capacity,
        })),
        unmatchedBuildings: current.unmatchedBuildings,
        buildingLinks: config.buildingLinks,
        shapes: config.buildings,
        campus: [...deps.campus.names.entries()].map(([key, name]) => ({ key, name })),
      });
    }
    if (method === 'POST' && path === '/admin/api/sync') {
      if (deps.sync.running) throw new HttpError(409, 'sync_running');
      deps.sync.run('admin').catch(() => deps.log.error('sync_crashed'));
      deps.log.info('admin_sync_requested');
      return sendJson(res, 202, { started: true });
    }
    if (method === 'POST' && path === '/admin/api/calendars') {
      const body = await readJson(req);
      await deps.config.update((c) => addCalendar(c, field(body, 'reference'), field(body, 'label'), now));
      return sendJson(res, 201, { ok: true });
    }
    const calMatch = /^\/admin\/api\/calendars\/([^/]{1,40})$/.exec(path);
    if (calMatch && method === 'PATCH') {
      const body = await readJson(req);
      await deps.config.update((c) => setCalendarActive(c, calMatch[1], field(body, 'active')));
      return sendJson(res, 200, { ok: true });
    }
    if (calMatch && method === 'DELETE') {
      await deps.config.update((c) => removeCalendar(c, calMatch[1]));
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'PUT' && path === '/admin/api/sources') {
      const body = await readJson(req);
      await deps.config.update((c) => setSources(c, field(body, 'urls')));
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'POST' && path === '/admin/api/discover') {
      const config = deps.config.current;
      const known = new Set<string>(config.calendars.map((c) => c.id));
      const result = await deps.discover(config.sources);
      return sendJson(res, 200, { found: result.found.filter((f) => !known.has(f.id)), failures: result.failures });
    }
    const roomMatch = /^\/admin\/api\/rooms\/([^/]{1,40})$/.exec(path);
    if (roomMatch && method === 'PUT') {
      const body = await readJson(req);
      const id = plannerId(roomMatch[1]);
      if (!deps.snapshots.current.rooms[id]) throw new HttpError(404, 'not_found');
      await deps.config.update((c) => setRoomFloor(c, id, field(body, 'floor')));
      return sendJson(res, 200, { ok: true });
    }
    const buildingMatch = /^\/admin\/api\/buildings\/([^/]{1,80})$/.exec(path);
    if (buildingMatch && method === 'PUT') {
      const body = await readJson(req);
      await deps.config.update((c) => setBuildingShape(c, deps.campus.keys, buildingMatch[1], field(body, 'floors'), field(body, 'baseLevel')));
      return sendJson(res, 200, { ok: true });
    }
    if (method === 'PUT' && path === '/admin/api/building-links') {
      const body = await readJson(req);
      await deps.config.update((c) => linkBuilding(c, deps.campus.keys, field(body, 'name'), field(body, 'key')));
      return sendJson(res, 200, { ok: true });
    }
    throw new HttpError(404, 'not_found');
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const file = deps.staticFiles.get(url.pathname);
    if (!file) throw new HttpError(404, 'not_found');
    res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': file.cache, 'Content-Length': file.body.length });
    res.end(req.method === 'HEAD' ? undefined : file.body);
  }

  return (req, res) => {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const run = async () => {
      if ((req.url ?? '').length > 2048) throw new HttpError(414, 'uri_too_long');
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
        return handleApi(req, res, url);
      }
      if (url.pathname.startsWith('/admin/api/')) return handleAdmin(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method_not_allowed');
      return serveStatic(req, res, url);
    };
    run().catch((err: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (err instanceof HttpError) return sendJson(res, err.status, { error: err.code });
      if (err instanceof GatewayError) return sendJson(res, err.status, { error: err.code });
      if (err instanceof ValidationError) return sendJson(res, 400, { error: 'invalid', field: err.code });
      if (err instanceof DomainError) return sendJson(res, 409, { error: err.code });
      deps.log.error('request_failed', { method: req.method ?? '', kind: err instanceof Error ? err.name : 'unknown' });
      sendJson(res, 500, { error: 'server_error' });
    });
  };
}
