// Login with a link sent to the Unical mailbox (Supabase Auth). No passwords anywhere.
import { api } from './ui.js';

const STORAGE_KEY = 'aule-auth';
let client = null;
let session = null;
const listeners = new Set();

// Same rule as public.is_unical_email in the database: no '+' or '%', no leading, trailing or double dots.
export const UNICAL_EMAIL = /^[a-z0-9]+([._-][a-z0-9]+)*@(unical\.it|studenti\.unical\.it)$/;

// status: "disabled" (no accounts on this server), "error" (could not ask), "ready".
// linkFailed: the page was opened from a login link that did not work.
export async function initAuth() {
  const params = new URL(location.href).searchParams;
  const fromLink = params.has('code') || params.has('error') || params.has('error_code');
  let config;
  try {
    config = await api('/api/client-config');
  } catch {
    return { status: 'error', linkFailed: false };
  }
  if (!config.accounts) return { status: 'disabled', linkFailed: false };
  if (!window.supabase || typeof window.supabase.createClient !== 'function') return { status: 'error', linkFailed: false };
  client = window.supabase.createClient(config.supabaseUrl, config.publishableKey, {
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

export function token() {
  return session ? session.access_token : null;
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

export function authed(path, options = {}) {
  return api(path, { ...options, token: token() });
}
