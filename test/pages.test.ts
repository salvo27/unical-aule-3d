import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');
const DIAM_PAGE = (JSON.parse(read('config/diam.json')) as { pageUrl: string }).pageUrl;

test('the map credits both timetable sources, the DIAm one with its index page', () => {
  const app = read('public/app.js');
  assert.ok(app.includes('Orari: University Planner Unical e <a href="' + DIAM_PAGE + '"'));
});

test('README and DATA-LICENSE credit the DIAm files and name the files that exist', () => {
  for (const doc of ['README.md', 'DATA-LICENSE.md']) {
    const text = read(doc);
    assert.ok(text.includes(DIAM_PAGE), doc);
    assert.ok(text.includes("Dipartimento di Ingegneria dell'Ambiente"), doc);
    assert.ok(text.includes('config/diam.json'), doc);
  }
  const migration = 'supabase/migrations/20261110090500_xlsx_feeds.sql';
  assert.ok(read('DATA-LICENSE.md').includes(migration));
  assert.ok(read(migration).length > 0);
});

// Pages answers unknown paths with the map unless a top level 404.html exists.
test('404.html: a plain page with no script and a link back to the map', () => {
  const page = read('public/404.html');
  assert.match(page, /^<!doctype html>\n<html lang="it"/);
  assert.ok(!/<script|<form|<iframe|\son[a-z]+=/i.test(page));
  assert.match(page, /<meta name="robots" content="noindex">/);
  assert.match(page, /<a href="\/">Torna alla mappa delle aule<\/a>/);
  for (const href of page.match(/(?:href|src)="[^"]*"/g) ?? []) assert.match(href, /^(?:href|src)="\/[^/]/, href);
});

test('page scripts never write HTML', () => {
  const dir = fileURLToPath(new URL('public/', ROOT));
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js'))) {
    assert.ok(!/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML\(|document\.write/.test(read(`public/${name}`)), name);
  }
});

// ---------- lesson rows taken from app.js and drawn with a fake el() ----------

interface Tree {
  tag: string;
  attrs: Record<string, unknown>;
  children: unknown[];
}

type Render = (...args: unknown[]) => unknown;

function textOf(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node !== 'object' || node === null) return '';
  return (node as Tree).children.map(textOf).join('');
}

function classesOf(node: unknown): string[] {
  if (Array.isArray(node)) return node.flatMap(classesOf);
  if (typeof node !== 'object' || node === null) return [];
  const tree = node as Tree;
  return [...(typeof tree.attrs.className === 'string' ? [tree.attrs.className] : []), ...tree.children.flatMap(classesOf)];
}

function lessonRenderers(): { lessonItem: Render; lessonHitRow: Render } {
  const app = read('public/app.js');
  const sources = ['parts', 'canReportNotHeld', 'lessonItem', 'lessonHitRow'].map((name) => {
    const found = new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(app);
    assert.ok(found, `${name} is missing from public/app.js`);
    return found[0];
  });
  const fakes: Record<string, unknown> = {
    el: (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]): Tree => ({ tag, attrs, children }),
    fmtTime: (ms: number) => `t${ms}`,
    prettyTitle: (text: string) => text,
    signedIn: () => false,
    isoDayOf: () => '2026-11-10',
    dayTitle: (iso: string) => iso,
    placeName: (_key: string, name: string) => name,
    openRoom: () => undefined,
  };
  const make = new Function(...Object.keys(fakes), `${sources.join('\n')}\nreturn { lessonItem, lessonHitRow };`);
  return make(...Object.values(fakes)) as { lessonItem: Render; lessonHitRow: Render };
}

test('no teacher on the map: lesson rows and search hits skip the field even when it is there', () => {
  const { lessonItem, lessonHitRow } = lessonRenderers();
  const start = Date.UTC(2026, 10, 10, 8);
  const base = { id: 'l1', title: 'Analisi matematica', start, end: start + 7_200_000, status: 'active', year: 1, courses: ['Ingegneria informatica'] };
  for (const lesson of [base, { ...base, teachers: ['Mario Rossi'] }]) {
    const row = lessonItem(lesson, start + 60_000, null, null);
    const text = textOf(row);
    for (const shown of ['Analisi matematica', '1° anno', 'Ingegneria informatica']) assert.ok(text.includes(shown), shown);
    assert.ok(!text.includes('Mario Rossi'));
    assert.ok(!classesOf(row).includes('lesson-teacher'));
  }
  const hit = lessonHitRow({
    roomId: 'aaaaaaaaaaaaaaaaaaaaaaaa', title: 'Analisi matematica', start, end: start + 7_200_000,
    roomName: 'Aula MT1', buildingKey: 'cubo-31b', buildingName: 'Cubo 31B', teachers: ['Mario Rossi'],
  });
  assert.ok(textOf(hit).includes('Analisi matematica'));
  assert.ok(!textOf(hit).includes('Mario Rossi'));
});

test('the pages never mention teachers, and the search hint offers rooms, cubes, courses and canteens', () => {
  const dir = fileURLToPath(new URL('public/', ROOT));
  for (const name of readdirSync(dir).filter((n) => /\.(js|html)$/.test(n))) {
    assert.ok(!/docent|teacher/i.test(read(`public/${name}`)), name);
  }
  assert.match(read('public/index.html'), /placeholder="Aula, cubo, corso o mensa" aria-label="Cerca">/);
});

// ---------- browser modules run in Node with small fakes of the browser globals ----------

interface ApiErrorLike extends Error {
  status: number;
  code: string;
}

interface UiModule {
  api(path: unknown, options?: Record<string, unknown>): Promise<unknown>;
  ApiError: new (status: number, code: string) => ApiErrorLike;
}

interface AuthModule {
  initAuth(page: string): Promise<{ status: string; linkFailed: boolean }>;
  enabled(): boolean;
  rpc(fn: string): Promise<unknown>;
  sendLoginLink(email: string, returnPath: string, options?: { createUser?: boolean }): Promise<{ ok: boolean; code?: string }>;
  UNICAL_EMAIL: RegExp;
  ADMIN_EMAIL: RegExp;
}

const UI_URL = new URL('public/ui.js', ROOT).href;
const AUTH_URL = new URL('public/auth.js', ROOT).href;
const KEY = 'sb_publishable_abcdefghijklmnop';
const SUPABASE = 'https://abc.supabase.co';

interface FetchCall {
  path: string;
  init: RequestInit;
}

interface Browser {
  fetches: FetchCall[];
  scripts: string[];
  replaced: number;
  urls: string[];
  clients: unknown[][];
  otp: unknown[];
  otpStatus: number | null;
}

let fresh = 0;

// Each test gets its own copy of auth.js (module state) and puts the globals back afterwards.
async function withBrowser(
  files: Record<string, unknown>,
  run: (auth: AuthModule, browser: Browser) => Promise<void>,
  href = 'https://aule.example.pages.dev/',
): Promise<void> {
  const browser: Browser = { fetches: [], scripts: [], replaced: 0, urls: [], clients: [], otp: [], otpStatus: null };
  const url = new URL(href);
  const fakeWindow: Record<string, unknown> = {};
  const fakeSupabase = {
    createClient: (...args: unknown[]) => {
      browser.clients.push(args);
      return {
        auth: {
          getSession: async () => ({ data: { session: null } }),
          onAuthStateChange: () => undefined,
          signInWithOtp: async (options: unknown) => {
            browser.otp.push(options);
            return { error: browser.otpStatus === null ? null : { status: browser.otpStatus } };
          },
        },
      };
    },
  };
  const globals: Record<string, unknown> = {
    fetch: async (path: string, init: RequestInit) => {
      browser.fetches.push({ path, init });
      if (!Object.hasOwn(files, path)) return new Response('{"error":"not_found"}', { status: 404 });
      return new Response(JSON.stringify(files[path]), { status: 200, headers: { 'content-type': 'application/json' } });
    },
    location: { href, hostname: url.hostname, origin: url.origin, pathname: url.pathname, search: url.search, hash: url.hash },
    window: fakeWindow,
    history: {
      replaceState: (_state: unknown, _title: string, next: string) => {
        browser.replaced += 1;
        browser.urls.push(next);
      },
    },
    document: {
      createElement: (tag: string) => {
        assert.equal(tag, 'script');
        const listeners: Record<string, () => void> = {};
        return { src: '', addEventListener: (name: string, fn: () => void) => (listeners[name] = fn), listeners };
      },
      head: {
        append: (script: { src: string; listeners: Record<string, () => void> }) => {
          browser.scripts.push(script.src);
          fakeWindow.supabase = fakeSupabase;
          script.listeners.load?.();
        },
      },
    },
  };
  const saved = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  try {
    fresh += 1;
    const auth = (await import(`${AUTH_URL}?copy=${fresh}`)) as AuthModule;
    await run(auth, browser);
  } finally {
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

const OFF = { features: { accounts: false } };
const ON = { supabaseUrl: SUPABASE, publishableKey: KEY, features: { accounts: true } };

test('api() reads our own origin with GET only and never sends an Authorization header', async () => {
  await withBrowser({ '/api/status': { ok: 1 } }, async (_auth, browser) => {
    const { api } = (await import(UI_URL)) as UiModule;
    const options = { token: 'user-token', method: 'POST', body: { a: 1 }, headers: { Authorization: 'Bearer x' } };
    assert.deepEqual(await api('/api/status', options), { ok: 1 });
    assert.equal(browser.fetches.length, 1);
    const { path, init } = browser.fetches[0]!;
    assert.equal(path, '/api/status');
    assert.equal(init.method, 'GET');
    assert.equal(init.credentials, 'omit');
    assert.equal(init.body, undefined);
    assert.deepEqual(init.headers, { Accept: 'application/json' });
    assert.ok(!JSON.stringify(init).includes('user-token'));
    await assert.rejects(api('/missing'), (e: ApiErrorLike) => e.status === 404 && e.code === 'not_found');
  });
});

test('api() refuses any path that could leave our origin, before fetching', async () => {
  await withBrowser({}, async (_auth, browser) => {
    const { api } = (await import(UI_URL)) as UiModule;
    for (const path of ['https://abc.supabase.co/rest/v1/rpc/x', '//evil.example/x', '/\\evil.example', 'api/status', '', null]) {
      await assert.rejects(api(path), (e: ApiErrorLike) => e.code === 'invalid', String(path));
    }
    assert.equal(browser.fetches.length, 0);
  });
});

test('map without accounts: no Supabase script, no client, no way to sign in, also from a login link', async () => {
  await withBrowser(
    { '/client-config.json': OFF, '/admin-config.json': ON },
    async (auth, browser) => {
      assert.deepEqual(await auth.initAuth('map'), { status: 'disabled', linkFailed: false });
      assert.deepEqual(browser.fetches.map((f) => f.path), ['/client-config.json']);
      assert.deepEqual(browser.scripts, []);
      assert.deepEqual(browser.clients, []);
      assert.equal(browser.replaced, 0);
      assert.equal(auth.enabled(), false);
      assert.deepEqual(await auth.sendLoginLink('studente@studenti.unical.it', '/'), { ok: false, code: 'error' });
      await assert.rejects(auth.rpc('my_requests'), (e: ApiErrorLike) => e.code === 'accounts_disabled');
    },
    'https://aule.example.pages.dev/?code=abc',
  );
});

test('a config with a bad key or URL, or an unknown page, never loads supabase-js', async () => {
  const bad = [
    { ...ON, publishableKey: 'sb_secret_abcdefghijklmnop' },
    { ...ON, supabaseUrl: 'http://abc.supabase.co' },
    { ...ON, supabaseUrl: `${SUPABASE}/rest` },
    { features: { accounts: 'true' }, supabaseUrl: SUPABASE, publishableKey: KEY },
  ];
  for (const config of bad) {
    await withBrowser({ '/client-config.json': config }, async (auth, browser) => {
      const result = await auth.initAuth('map');
      assert.notEqual(result.status, 'ready', JSON.stringify(config));
      assert.deepEqual(browser.scripts, []);
    });
  }
  await withBrowser({ '/client-config.json': ON }, async (auth, browser) => {
    for (const page of ['nope', '__proto__', 'constructor']) assert.deepEqual(await auth.initAuth(page), { status: 'error', linkFailed: false });
    assert.deepEqual(browser.fetches, []);
  });
});

test('admin page: its own config, supabase-js on demand, links only for existing accounts', async () => {
  await withBrowser({ '/client-config.json': OFF, '/admin-config.json': ON }, async (auth, browser) => {
    assert.deepEqual(await auth.initAuth('admin'), { status: 'ready', linkFailed: false });
    assert.deepEqual(browser.fetches.map((f) => f.path), ['/admin-config.json']);
    assert.deepEqual(browser.scripts, ['/vendor/supabase.js']);
    assert.equal(browser.clients.length, 1);
    assert.deepEqual(browser.clients[0]!.slice(0, 2), [SUPABASE, KEY]);
    assert.equal(auth.enabled(), true);

    assert.deepEqual(await auth.sendLoginLink(' Admin@Unical.it ', '/admin', { createUser: false }), { ok: true });
    assert.deepEqual(browser.otp, [
      { email: 'admin@unical.it', options: { emailRedirectTo: 'https://aule.example.pages.dev/admin', shouldCreateUser: false } },
    ]);
    browser.otpStatus = 422;
    assert.deepEqual(await auth.sendLoginLink('admin@unical.it', '/admin', { createUser: false }), { ok: false, code: 'refused' });
    browser.otpStatus = 429;
    assert.deepEqual(await auth.sendLoginLink('admin@unical.it', '/admin', { createUser: false }), { ok: false, code: 'rate_limited' });
    assert.deepEqual(await auth.sendLoginLink('someone@gmail.com', '/admin'), { ok: false, code: 'domain' });
    assert.equal(browser.otp.length, 3);
  });
});

test('admin page: an admin address outside Unical gets a link, odd shapes are refused before Supabase', async () => {
  await withBrowser({ '/admin-config.json': ON }, async (auth, browser) => {
    assert.equal((await auth.initAuth('admin')).status, 'ready');
    assert.deepEqual(await auth.sendLoginLink(' Admin@Example.org ', '/admin', { createUser: false }), { ok: true });
    assert.deepEqual(browser.otp, [
      { email: 'admin@example.org', options: { emailRedirectTo: 'https://aule.example.pages.dev/admin', shouldCreateUser: false } },
    ]);
    const odd = ['admin+x@example.org', 'admin@example', 'a@b.c', '.admin@example.org', 'ad..min@example.org', 'admin@-example.org',
      'àdmin@example.org', 'admin@@example.org', 'admin@example.org.', 'admin @example.org', `${'a'.repeat(65)}@example.org`,
      `admin@${'a'.repeat(245)}.org`, ''];
    for (const email of odd) assert.deepEqual(await auth.sendLoginLink(email, '/admin', { createUser: false }), { ok: false, code: 'domain' }, email);
    // The map still signs up Unical addresses only.
    assert.deepEqual(await auth.sendLoginLink('admin@example.org', '/'), { ok: false, code: 'domain' });
    assert.equal(browser.otp.length, 1);
  });
});

test('the address rules of the pages are the ones of the database', async () => {
  const sqlRule = (path: string): string => {
    const found = read(path).split('\n').filter((line) => /^\s+(and )?email ~ '/.test(line));
    assert.equal(found.length, 1, path);
    return /email ~ '([^']+)'/.exec(found[0]!)![1]!;
  };
  await withBrowser({}, async (auth) => {
    assert.equal(auth.UNICAL_EMAIL.source, sqlRule('supabase/migrations/20261109210000_hardening.sql'));
    assert.equal(auth.ADMIN_EMAIL.source, sqlRule('supabase/migrations/20261110090700_admin_emails.sql'));
  });
});

test('a session in the address fragment, as an opened invite leaves it, is dropped on every page and mode', async () => {
  const invite = '#access_token=a.b.c&expires_in=3600&refresh_token=r&token_type=bearer&type=invite';
  const cases: [Record<string, unknown>, string, string, string][] = [
    [{ '/client-config.json': OFF }, 'map', `https://aule.example.pages.dev/${invite}`, '/'],
    [{ '/client-config.json': ON }, 'map', `https://aule.example.pages.dev/?x=1${invite}`, '/?x=1'],
    [{ '/admin-config.json': ON }, 'admin', `https://aule.example.pages.dev/admin${invite}`, '/admin'],
    [{}, 'map', 'https://aule.example.pages.dev/#error=access_denied&error_code=otp_expired', '/'],
    [{}, 'nope', `https://aule.example.pages.dev/${invite}`, '/'],
  ];
  for (const [files, page, href, left] of cases) {
    await withBrowser(files, async (auth, browser) => {
      await auth.initAuth(page);
      assert.deepEqual(browser.urls, [left], href);
    }, href);
  }
  await withBrowser({ '/client-config.json': OFF }, async (auth, browser) => {
    await auth.initAuth('map');
    assert.deepEqual(browser.urls, []);
  }, 'https://aule.example.pages.dev/#sezione');
});

test('the map has no access point in its markup and opens account views only with accounts on', () => {
  const index = read('public/index.html');
  for (const text of ['Accedi', 'id="account"', 'supabase', 'admin']) assert.ok(!index.includes(text), text);
  assert.match(read('public/admin.html'), /<script src="\/vendor\/supabase\.js"><\/script>/);

  const app = read('public/app.js');
  assert.match(app, /const auth = await initAuth\('map'\);/);
  assert.match(app, /^function show\(view\) \{\n {2}if \(ACCOUNT_VIEWS\.has\(view\.name\) && !accountsEnabled\(\)\) return false;/m);
  assert.match(app, /^const ACCOUNT_VIEWS = new Set\(\['login', 'mine'\]\);$/m);
  assert.match(app, /^function renderAccount\(\) \{\n {2}if \(!accountsEnabled\(\)\) return;/m);
  assert.match(app, /\['foot-reports', s && accountsEnabled\(\) && !s\.reportsAvailable \?/);
  assert.match(app, /^function reportBox\(room, v\) \{\n {2}if \(!accountsEnabled\(\)\) return null;/m);
  // Every way into the login view goes through show().
  assert.equal(app.match(/name: 'login'/g)?.length, 3);
  assert.equal(app.match(/show\(\{ name: 'login'/g)?.length, 3);

  const admin = read('public/admin.js');
  assert.match(admin, /const auth = await initAuth\('admin'\);/);
  assert.match(admin, /sendLoginLink\(input\.value, '\/admin', \{ createUser: false \}\)/);
});
