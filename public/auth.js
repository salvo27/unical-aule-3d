// Login with a link sent to the Unical mailbox (Supabase Auth). No passwords anywhere.
import { api, ApiError } from './ui.js';
import { errorCode } from './errors.js';

const STORAGE_KEY = 'aule-auth';
let client = null;
let session = null;
const listeners = new Set();

// Same rule as public.is_unical_email in the database: no '+' or '%', no leading, trailing or double dots.
export const UNICAL_EMAIL = /^[a-z0-9]+([._-][a-z0-9]+)*@(unical\.it|studenti\.unical\.it)$/;

// Like supabaseSettings in src/settings.ts: only publishable keys, plain http only from a local page to a local host.
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{10,200}$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function supabaseUrl(value) {
  if (typeof value !== 'string' || value.length > 200) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname) && LOCAL_HOSTS.has(location.hostname);
  if ((url.protocol !== 'https:' && !local) || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

// status: "disabled" (accounts off on this site), "error" (could not ask or bad configuration), "ready".
// linkFailed: the page was opened from a login link that did not work.
export async function initAuth() {
  const params = new URL(location.href).searchParams;
  const fromLink = params.has('code') || params.has('error') || params.has('error_code');
  let config;
  try {
    config = await api('/client-config.json');
  } catch {
    return { status: 'error', linkFailed: false };
  }
  const features = config && typeof config === 'object' ? config.features : null;
  if (!features || typeof features !== 'object' || features.accounts !== true) return { status: 'disabled', linkFailed: false };
  const url = supabaseUrl(config.supabaseUrl);
  const key = typeof config.publishableKey === 'string' && PUBLISHABLE.test(config.publishableKey) ? config.publishableKey : null;
  if (!url || !key) return { status: 'error', linkFailed: false };
  if (!window.supabase || typeof window.supabase.createClient !== 'function') return { status: 'error', linkFailed: false };
  client = window.supabase.createClient(url, key, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: STORAGE_KEY },
  });
  const { data } = await client.auth.getSession();
  session = data.session;
  client.auth.onAuthStateChange((event, next) => {
    session = next;
    for (const fn of listeners) fn(event, next);
  });
  // One-time codes and errors from the link: out of the address bar once used.
  if (fromLink) history.replaceState(null, '', location.pathname);
  return { status: 'ready', linkFailed: fromLink && session === null };
}

export function enabled() {
  return client !== null;
}

export function signedIn() {
  return session !== null;
}

export function userId() {
  return session ? session.user.id : null;
}

export function onSessionChange(fn) {
  listeners.add(fn);
}

// One database function through the Data API (POST, the user's token added by supabase-js). Errors are closed codes.
export async function rpc(fn, args = {}, { timeoutMs = 15000 } = {}) {
  if (!client) throw new ApiError(0, 'accounts_disabled');
  let result;
  try {
    result = await client.rpc(fn, args).abortSignal(AbortSignal.timeout(timeoutMs));
  } catch {
    throw new ApiError(0, 'network');
  }
  const { data, error, status } = result || {};
  if (!result || error) throw new ApiError(status ?? 0, errorCode(error, status));
  return data;
}

export async function sendLoginLink(rawEmail, returnPath) {
  const email = String(rawEmail).trim().toLowerCase();
  if (!UNICAL_EMAIL.test(email)) return { ok: false, code: 'domain' };
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${location.origin}${returnPath}`, shouldCreateUser: true },
  });
  if (!error) return { ok: true };
  if (error.status === 429) return { ok: false, code: 'rate_limited' };
  if (error.status === 403 || error.status === 422) return { ok: false, code: 'domain' };
  return { ok: false, code: 'error' };
}

// If Supabase cannot be reached, the local session is removed anyway: "Esci" must always log out this browser.
export async function signOut() {
  let failed = !client;
  if (client) {
    const result = await client.auth.signOut().catch(() => ({ error: true }));
    failed = Boolean(result && result.error);
  }
  session = null;
  if (failed) {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith(STORAGE_KEY)) localStorage.removeItem(key);
    } catch {
      // storage not available: nothing stored
    }
    location.reload();
  }
}
