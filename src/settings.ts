// Environment settings shared by the Worker, the site build and the sync CLIs. No Node globals here.

export class EnvError extends Error {} // message = variable name only

type Env = Readonly<Record<string, string | undefined>>;

export interface SupabaseSettings {
  url: string;
  origin: string;
  publishableKey: string;
}

export interface DbSettings {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  tls: { ca: string } | null;
}

// Only the new publishable keys: a legacy JWT key could be the service_role one, which must never reach a browser.
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{10,200}$/;
const URL_CHARS = /^[A-Za-z0-9.:/[\]-]+$/;
const LOCAL_HTTP_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function supabaseSettings(env: Env, options: { allowLocalHttp: boolean }): SupabaseSettings {
  const rawUrl = env.SUPABASE_URL?.trim() ?? '';
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  if (!rawUrl || !key || rawUrl.length > 200 || key.length > 215 || !PUBLISHABLE.test(key)) throw new EnvError('SUPABASE');
  if (!URL_CHARS.test(rawUrl)) throw new EnvError('SUPABASE_URL');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EnvError('SUPABASE_URL');
  }
  const local = options.allowLocalHttp && url.protocol === 'http:' && LOCAL_HTTP_HOSTS.has(url.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) throw new EnvError('SUPABASE_URL');
  if (url.pathname !== '/' && url.pathname !== '') throw new EnvError('SUPABASE_URL');
  return { url: url.origin, origin: url.origin, publishableKey: key };
}

export function accountsFlag(env: Env): boolean {
  const raw = env.ACCOUNTS_ENABLED;
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new EnvError('ACCOUNTS_ENABLED');
}

const DB_HOST = /^[A-Za-z0-9.-]{1,253}$/;
const DB_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const DB_USER = /^[a-z_][a-z0-9_]{0,62}(\.[a-z0-9]{1,40})?$/;
const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const LOCAL_DB_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const CONTROL = /\p{Cc}/u;
const DEFAULT_CA = 'config/supabase-ca.crt';
const CA_MAX_BYTES = 20000;
const PEM_TEXT = /^[\x20-\x7E\t\r\n]+$/;
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function dbHost(raw: string | undefined): string {
  if (raw === '::1') return raw;
  if (raw === undefined || raw.length > 253 || !DB_HOST.test(raw)) throw new EnvError('SYNC_DB_HOST');
  if (!raw.split('.').every((label) => DB_LABEL.test(label))) throw new EnvError('SYNC_DB_HOST');
  return raw;
}

function dbPort(raw: string | undefined): number {
  if (raw === undefined) return 5432;
  if (!/^\d{1,5}$/.test(raw)) throw new EnvError('SYNC_DB_PORT');
  const port = Number(raw);
  if (port < 1 || port > 65535) throw new EnvError('SYNC_DB_PORT');
  return port;
}

// The CA file holds only public root certificates (1 to 5), never keys.
function caBundle(text: string | null): string {
  if (text === null || text.length > CA_MAX_BYTES || !PEM_TEXT.test(text)) throw new EnvError('SYNC_DB_CA');
  const begins = text.split('-----BEGIN ').length - 1;
  const blocks = text.match(PEM_BLOCK)?.length ?? 0;
  if (blocks < 1 || blocks > 5 || begins !== blocks) throw new EnvError('SYNC_DB_CA');
  return text;
}

export function dbSettings(env: Env, readFile: (path: string) => string | null): DbSettings {
  const host = dbHost(env.SYNC_DB_HOST);
  const port = dbPort(optional(env, 'SYNC_DB_PORT'));
  const user = env.SYNC_DB_USER ?? '';
  if (user.length > 104 || !DB_USER.test(user)) throw new EnvError('SYNC_DB_USER');
  const password = env.SYNC_DB_PASSWORD ?? '';
  if (password.length < 8 || password.length > 200 || CONTROL.test(password)) throw new EnvError('SYNC_DB_PASSWORD');
  const database = optional(env, 'SYNC_DB_NAME') ?? 'postgres';
  if (database.length > 63 || !DB_NAME.test(database)) throw new EnvError('SYNC_DB_NAME');
  const caPath = optional(env, 'SYNC_DB_CA') ?? DEFAULT_CA;
  if (caPath.length > 300 || CONTROL.test(caPath)) throw new EnvError('SYNC_DB_CA');
  if (LOCAL_DB_HOSTS.has(host)) return { host, port, user, password, database, tls: null };
  return { host, port, user, password, database, tls: { ca: caBundle(readFile(caPath)) } };
}
