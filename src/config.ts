// Environment settings, validated at startup: a wrong value stops the server instead of guessing.

export interface SupabaseSettings {
  url: string;
  origin: string;
  publishableKey: string;
}

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  production: boolean;
  supabase: SupabaseSettings | null;
  syncHours: number[];
  staleAfterMs: number;
}

export class EnvError extends Error {}

function intIn(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d{1,6}$/.test(raw)) throw new EnvError(name);
  const n = Number(raw);
  if (n < min || n > max) throw new EnvError(name);
  return n;
}

// Only the new publishable keys: a legacy JWT key could be the service_role one, which must never reach a browser.
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{10,200}$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Accounts work only with both values; plain http only for a local Supabase outside production.
function supabaseSettings(env: NodeJS.ProcessEnv, production: boolean): SupabaseSettings | null {
  const rawUrl = env.SUPABASE_URL?.trim() ?? '';
  const key = env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  if (!rawUrl && !key) return null;
  if (!rawUrl || !key || rawUrl.length > 200 || !PUBLISHABLE.test(key)) throw new EnvError('SUPABASE');
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new EnvError('SUPABASE_URL');
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && !production;
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) throw new EnvError('SUPABASE_URL');
  if (url.pathname !== '/' && url.pathname !== '') throw new EnvError('SUPABASE_URL');
  return { url: url.origin, origin: url.origin, publishableKey: key };
}

export function loadAppConfig(env: NodeJS.ProcessEnv): AppConfig {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || '127.0.0.1';
  if (!/^[0-9a-zA-Z.:-]{1,64}$/.test(host)) throw new EnvError('HOST');
  const dataDir = env.DATA_DIR || './data';
  if (dataDir.length > 300) throw new EnvError('DATA_DIR');
  const hours = (env.SYNC_HOURS || '6,13').split(',').map((h) => {
    if (h.trim() === '') throw new EnvError('SYNC_HOURS');
    return intIn(h.trim(), 0, 0, 23, 'SYNC_HOURS');
  });
  if (hours.length === 0 || hours.length > 12) throw new EnvError('SYNC_HOURS');
  return {
    port: intIn(env.PORT, 3000, 1, 65535, 'PORT'),
    host,
    dataDir,
    production,
    supabase: supabaseSettings(env, production),
    syncHours: [...new Set(hours)].sort((a, b) => a - b),
    staleAfterMs: intIn(env.STALE_AFTER_HOURS, 30, 1, 240, 'STALE_AFTER_HOURS') * 60 * 60 * 1000,
  };
}
