// Talks to Supabase through database functions (PostgREST RPC). The user's token goes with each call,
// so Supabase checks it and the database rules (RLS, role checks) run as that user.
import { createHash } from 'node:crypto';

import { ROLES, REQUEST_KINDS, ISSUE_CATEGORIES, type AppRole, type RequestKind, type IssueCategory } from '../domain/vocab.js';

export { ROLES, REQUEST_KINDS, ISSUE_CATEGORIES, type AppRole, type RequestKind, type IssueCategory };

export interface Identity {
  userId: string;
  role: AppRole;
}

export interface Override {
  roomId: string;
  kind: RequestKind;
  category: IssueCategory | null;
  lessonId: string | null;
  start: number;
  end: number;
  source: 'approved' | 'crowd';
}

export interface PendingRequest {
  id: string;
  roomId: string;
  kind: RequestKind;
  category: IssueCategory | null;
  lessonId: string | null;
  start: number;
  end: number;
  createdAt: number;
  supporters: number;
  reporterApproved: number;
  reporterRejected: number;
}

export interface MyRequest {
  id: string;
  roomId: string;
  kind: RequestKind;
  category: IssueCategory | null;
  start: number;
  end: number;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: number;
}

export interface UserRow {
  userId: string;
  email: string;
  role: AppRole;
  lastSignInAt: number | null;
}

export interface NewRequest {
  roomId: string;
  kind: RequestKind;
  category: IssueCategory | null;
  lessonId: string | null;
  start: number;
  end: number;
}

export interface RequestSummary {
  id: string;
  roomId: string;
  kind: RequestKind;
  lessonId: string | null;
  start: number;
  end: number;
  status: 'pending' | 'approved' | 'rejected';
}

export interface SupabaseGateway {
  // fresh: skip the short cache (for staff and admin calls, so a removed role stops working at once).
  whoami(token: string, options?: { fresh?: boolean }): Promise<Identity | null>;
  getRequest(token: string, id: string): Promise<RequestSummary | null>;
  submitRequest(token: string, input: NewRequest): Promise<string>;
  myRequests(token: string): Promise<MyRequest[]>;
  pendingRequests(token: string): Promise<PendingRequest[]>;
  reviewRequest(token: string, id: string, decision: 'approved' | 'rejected'): Promise<void>;
  findUser(token: string, email: string): Promise<UserRow | null>;
  listStaff(token: string): Promise<UserRow[]>;
  setUserRole(token: string, userId: string, role: AppRole): Promise<void>;
  overrides(from: number, to: number): Promise<Override[]>;
}

export class GatewayError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) {
    super(code);
    this.name = 'GatewayError';
    this.code = code;
    this.status = status;
  }
}

// Codes raised on purpose by our SQL functions. Any other message stays inside the server.
const DOMAIN_CODES: Record<string, number> = {
  invalid: 400,
  window: 400,
  duplicate: 409,
  rate_limited: 429,
  too_many_pending: 429,
  not_pending: 409,
  own_request: 409,
  own_role: 409,
  expired: 409,
  not_found: 404,
  user_missing: 404,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROOM = /^[0-9a-f]{24}$/;
const JWT = /^[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{2,4000}\.[A-Za-z0-9_-]{10,2000}$/;
const CACHE_MS = 30_000;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

export function looksLikeJwt(token: string): boolean {
  return token.length <= 8192 && JWT.test(token);
}

type Rec = Record<string, unknown>;
const isRecord = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === 'string' && (list as readonly string[]).includes(v);

function time(v: unknown): number | null {
  if (typeof v !== 'string' || v.length > 40) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0;
}

function rows(data: unknown): Rec[] {
  if (!Array.isArray(data)) throw new GatewayError('upstream_error', 502);
  return data.filter(isRecord).slice(0, 5000);
}

interface Options {
  url: string;
  publishableKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  // Called with closed values only (function name, HTTP status, PostgREST code): never tokens or bodies.
  onUpstreamError?: (fn: string, status: number, code: string) => void;
}

export function createSupabaseGateway(options: Options): SupabaseGateway {
  const base = options.url.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const identities = new Map<string, { identity: Identity | null; expires: number }>();

  async function rpc(fn: string, body: Rec, token?: string): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: options.publishableKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await doFetch(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      options.onUpstreamError?.(fn, 0, 'network');
      throw new GatewayError('upstream_unavailable', 503);
    }
    const text = await res.text().catch(() => '');
    if (text.length > 2_000_000) throw new GatewayError('upstream_error', 502);
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (res.ok) return data;
    const code = isRecord(data) && typeof data.code === 'string' ? data.code : '';
    const message = isRecord(data) && typeof data.message === 'string' ? data.message : '';
    // Only PostgREST's JWT errors mean "log in again"; a rejected API key is our misconfiguration.
    if (res.status === 401 && /^PGRST30[1-3]$/.test(code)) throw new GatewayError('unauthorized', 401);
    if (code === '42501') throw new GatewayError('forbidden', 403);
    if (code === 'P0001') {
      const status = DOMAIN_CODES[message];
      if (status) throw new GatewayError(message, status);
      options.onUpstreamError?.(fn, res.status, 'P0001');
      throw new GatewayError('request_failed', 400);
    }
    options.onUpstreamError?.(fn, res.status, /^[A-Z0-9]{1,10}$/.test(code) ? code : 'none');
    throw new GatewayError('upstream_error', 502);
  }

  function prune(t: number): void {
    if (identities.size < 500) return;
    for (const [k, v] of identities) if (v.expires <= t) identities.delete(k);
    if (identities.size >= 500) identities.clear();
  }

  return {
    async whoami(token, whoOptions) {
      if (!looksLikeJwt(token)) return null;
      const key = createHash('sha256').update(token).digest('hex');
      const t = now();
      const cached = identities.get(key);
      if (cached && cached.expires > t && !whoOptions?.fresh) return cached.identity;
      let identity: Identity | null = null;
      try {
        const [row] = rows(await rpc('whoami', {}, token));
        if (row && isUuid(row.user_id) && oneOf(ROLES, row.role)) identity = { userId: row.user_id, role: row.role };
      } catch (err) {
        if (!(err instanceof GatewayError) || err.code !== 'unauthorized') throw err;
      }
      prune(t);
      identities.set(key, { identity, expires: t + CACHE_MS });
      return identity;
    },

    async submitRequest(token, input) {
      const id = await rpc(
        'submit_request',
        {
          p_room_id: input.roomId,
          p_kind: input.kind,
          p_category: input.category,
          p_starts_at: new Date(input.start).toISOString(),
          p_ends_at: new Date(input.end).toISOString(),
          p_lesson_id: input.lessonId,
        },
        token,
      );
      if (!isUuid(id)) throw new GatewayError('upstream_error', 502);
      return id;
    },

    async myRequests(token) {
      const out: MyRequest[] = [];
      for (const r of rows(await rpc('my_requests', {}, token))) {
        const start = time(r.starts_at);
        const end = time(r.ends_at);
        const createdAt = time(r.created_at);
        const status = r.status;
        if (!isUuid(r.id) || typeof r.room_id !== 'string' || !ROOM.test(r.room_id) || !oneOf(REQUEST_KINDS, r.kind)) continue;
        if (start === null || end === null || createdAt === null) continue;
        if (status !== 'pending' && status !== 'approved' && status !== 'rejected' && status !== 'expired') continue;
        out.push({ id: r.id, roomId: r.room_id, kind: r.kind, category: oneOf(ISSUE_CATEGORIES, r.category) ? r.category : null, start, end, status, createdAt });
      }
      return out;
    },

    async pendingRequests(token) {
      const out: PendingRequest[] = [];
      for (const r of rows(await rpc('pending_requests', {}, token))) {
        const start = time(r.starts_at);
        const end = time(r.ends_at);
        const createdAt = time(r.created_at);
        if (!isUuid(r.id) || typeof r.room_id !== 'string' || !ROOM.test(r.room_id) || !oneOf(REQUEST_KINDS, r.kind)) continue;
        if (start === null || end === null || createdAt === null) continue;
        out.push({
          id: r.id,
          roomId: r.room_id,
          kind: r.kind,
          category: oneOf(ISSUE_CATEGORIES, r.category) ? r.category : null,
          lessonId: typeof r.lesson_id === 'string' && ROOM.test(r.lesson_id) ? r.lesson_id : null,
          start,
          end,
          createdAt,
          supporters: count(r.supporters),
          reporterApproved: count(r.reporter_approved),
          reporterRejected: count(r.reporter_rejected),
        });
      }
      return out;
    },

    async getRequest(token, id) {
      const [r] = rows(await rpc('get_request', { p_id: id }, token));
      if (!r) return null;
      const start = time(r.starts_at);
      const end = time(r.ends_at);
      const status = r.status;
      if (!isUuid(r.id) || typeof r.room_id !== 'string' || !ROOM.test(r.room_id) || !oneOf(REQUEST_KINDS, r.kind)) return null;
      if (start === null || end === null || (status !== 'pending' && status !== 'approved' && status !== 'rejected')) return null;
      const lessonId = typeof r.lesson_id === 'string' && ROOM.test(r.lesson_id) ? r.lesson_id : null;
      return { id: r.id, roomId: r.room_id, kind: r.kind, lessonId, start, end, status };
    },

    async reviewRequest(token, id, decision) {
      await rpc('review_request', { p_id: id, p_decision: decision }, token);
    },

    async findUser(token, email) {
      const [r] = rows(await rpc('find_user', { p_email: email }, token));
      if (!r || !isUuid(r.user_id) || typeof r.email !== 'string' || r.email.length > 254 || !oneOf(ROLES, r.role)) return null;
      return { userId: r.user_id, email: r.email, role: r.role, lastSignInAt: null };
    },

    async listStaff(token) {
      const out: UserRow[] = [];
      for (const r of rows(await rpc('list_staff', {}, token))) {
        if (!isUuid(r.user_id) || typeof r.email !== 'string' || r.email.length > 254 || !oneOf(ROLES, r.role)) continue;
        out.push({ userId: r.user_id, email: r.email, role: r.role, lastSignInAt: time(r.last_sign_in_at) });
      }
      return out;
    },

    async setUserRole(token, userId, role) {
      await rpc('set_user_role', { target: userId, new_role: role }, token);
    },

    async overrides(from, to) {
      const out: Override[] = [];
      const data = await rpc('public_room_overrides', { p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString() });
      for (const r of rows(data)) {
        const start = time(r.starts_at);
        const end = time(r.ends_at);
        if (typeof r.room_id !== 'string' || !ROOM.test(r.room_id) || !oneOf(REQUEST_KINDS, r.kind)) continue;
        if (start === null || end === null || end <= start) continue;
        if (r.source !== 'approved' && r.source !== 'crowd') continue;
        const lessonId = typeof r.lesson_id === 'string' && ROOM.test(r.lesson_id) ? r.lesson_id : null;
        if (r.kind === 'lesson_not_held' && !lessonId) continue;
        out.push({ roomId: r.room_id, kind: r.kind, category: oneOf(ISSUE_CATEGORIES, r.category) ? r.category : null, lessonId, start, end, source: r.source });
      }
      return out;
    },
  };
}
