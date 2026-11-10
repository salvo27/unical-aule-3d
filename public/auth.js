// Login with a link sent by mail (Supabase Auth). No passwords anywhere.
import { api, ApiError } from './ui.js';
import { errorCode } from './errors.js';

const STORAGE_KEY = 'aule-auth';
const SUPABASE_SCRIPT = '/vendor/supabase.js';
// Each page reads its own config: the map one has Supabase values only when students may sign in.
export const CONFIGS = Object.freeze({ map: '/client-config.json', admin: '/admin-config.json' });
let client = null;
let session = null;
const listeners = new Set();

// Same rule as public.is_unical_email in the database: no '+' or '%', no leading, trailing or double dots.
export const UNICAL_EMAIL = /^[a-z0-9]+([._-][a-z0-9]+)*@(unical\.it|studenti\.unical\.it)$/;
// Same shape as the CHECK of aule.admin_emails (Unical addresses fit it too). The database decides who gets in.
export const ADMIN_EMAIL = /^[a-z0-9]+([._-][a-z0-9]+)*@([a-z0-9]+(-+[a-z0-9]+)*\.)+[a-z]{2,63}$/;

// Like supabaseSettings in src/settings.ts: only publishable keys, plain http only from a local page to a local host.
const PUBLISHABLE = /^sb_publishable_[A-Za-z0-9_-]{10,200}$/;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
// An opened invite lands on a page with a session in the fragment. Login is PKCE only, so it is never used.
const FRAGMENT_KEYS = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'error', 'error_code', 'error_description'];

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

// Tokens never stay in the address bar or in this history entry, whatever the page and the accounts mode.
function dropAuthFragment() {
  const hash = typeof location.hash === 'string' ? location.hash : '';
  if (hash.length < 2) return;
  const params = new URLSearchParams(hash.slice(1));
  if (FRAGMENT_KEYS.some((key) => params.has(key))) history.replaceState(null, '', `${location.pathname}${location.search}`);
}

// supabase-js is loaded only when the page may sign in, so the map without accounts never downloads it.
function loadSupabase(timeoutMs = 15000) {
  if (window.supabase) return Promise.resolve();
  return new Promise((resolve) => {
    const script = document.createElement('script');
    const timer = setTimeout(resolve, timeoutMs);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    script.addEventListener('load', done);
    script.addEventListener('error', done);
    script.src = SUPABASE_SCRIPT;
    document.head.append(script);
  });
}

// status: "disabled" (no login on this page), "error" (could not ask or bad configuration), "ready".
// linkFailed: the page was opened from a login link that did not work.
export async function initAuth(page) {
  dropAuthFragment();
  if (!Object.hasOwn(CONFIGS, page)) return { status: 'error', linkFailed: false };
  let config;
  try {
    config = await api(CONFIGS[page]);
  } catch {
    return { status: 'error', linkFailed: false };
  }
  const features = config && typeof config === 'object' ? config.features : null;
  if (!features || typeof features !== 'object' || features.accounts !== true) return { status: 'disabled', linkFailed: false };
  const url = supabaseUrl(config.supabaseUrl);
  const key = typeof config.publishableKey === 'string' && PUBLISHABLE.test(config.publishableKey) ? config.publishableKey : null;
  if (!url || !key) return { status: 'error', linkFailed: false };
  const params = new URL(location.href).searchParams;
  const fromLink = params.has('code') || params.has('error') || params.has('error_code');
  await loadSupabase();
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

// The map signs up Unical addresses only. The admin page (createUser false) sends links only to existing accounts,
// and an admin may have an address outside Unical, so there any plain address is accepted.
function acceptedEmail(email, signup) {
  if (email.length < 6 || email.length > 254 || email.indexOf('@') > 64) return false;
  return (signup ? UNICAL_EMAIL : ADMIN_EMAIL).test(email);
}

// Codes: domain (an address this page does not accept), refused (Supabase said no), rate_limited, error.
export async function sendLoginLink(rawEmail, returnPath, { createUser = true } = {}) {
  if (!client) return { ok: false, code: 'error' };
  const email = String(rawEmail).trim().toLowerCase();
  const signup = createUser === true;
  if (!acceptedEmail(email, signup)) return { ok: false, code: 'domain' };
  const { error } = await client.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${location.origin}${returnPath}`, shouldCreateUser: signup },
  });
  if (!error) return { ok: true };
  if (error.status === 429) return { ok: false, code: 'rate_limited' };
  if (error.status === 403 || error.status === 422) return { ok: false, code: 'refused' };
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
