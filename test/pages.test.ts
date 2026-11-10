import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../', import.meta.url);
const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, ROOT)), 'utf8');
const DIAM_PAGE = (JSON.parse(read('config/diam.json')) as { pageUrl: string }).pageUrl;
const PDF = JSON.parse(read('config/pdf.json')) as { discag: { pageUrl: string }; disu: { indexUrl: string } };
const DISCAG_PAGE = PDF.discag.pageUrl;
const DISU_PAGE = PDF.disu.indexUrl;
const DIMES_PAGE = (JSON.parse(read('config/dimes.json')) as { url: string }).url;

interface UiHelpers {
  floorLabel(floor: unknown, bridge?: unknown): string;
  bridgeOf(room: unknown): string | null;
  courseParts(text: string): { name: string; level: string | null };
}

const helpers = (await import(new URL('public/ui.js', ROOT).href)) as UiHelpers;

test('the map credits every timetable source with its index page, and no other page', () => {
  const credit = /^ {6}customAttribution:\n {8}'(.*)',$/m.exec(read('public/app.js'));
  assert.ok(credit, 'customAttribution is missing from public/app.js');
  assert.ok(credit[1]!.includes('Orari: University Planner Unical e dipartimenti di <a href="' + DIAM_PAGE + '"'));
  const links = [...credit[1]!.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, ['https://www.openstreetmap.org/copyright', DIAM_PAGE, DIMES_PAGE, DISCAG_PAGE, DISU_PAGE, '/vendor/licenses.txt']);
});

test('DATA-LICENSE credits the DIAm files, the DIMES page and the DISCAG and DiSU PDFs, and names files that exist', () => {
  const text = read('DATA-LICENSE.md');
  const shown = [
    DIAM_PAGE,
    DIMES_PAGE,
    DISCAG_PAGE,
    DISU_PAGE,
    "Dipartimento di Ingegneria dell'Ambiente",
    'Dipartimento di Ingegneria Informatica, Modellistica, Elettronica e Sistemistica',
    'Dipartimento di Scienze Aziendali e Giuridiche',
    'Dipartimento di Studi Umanistici',
    'config/diam.json',
    'config/pdf.json',
    'supabase/migrations/20261110090500_xlsx_feeds.sql',
    'supabase/migrations/20261110091000_pdf_feeds.sql',
    'config/dimes.json',
    'supabase/migrations/20261110090800_dimes_feeds.sql',
  ];
  for (const part of shown) assert.ok(text.includes(part), part);
  for (const file of text.match(/(?:config|supabase\/migrations)\/[\w.-]+\.(?:json|sql)/g) ?? []) assert.ok(read(file).length > 0, file);
  const pages = new Set(text.match(/https:\/\/[a-z.]+\.unical\.it\/[^\s>)]*/g));
  assert.deepEqual([...pages].sort(), [DIAM_PAGE, DIMES_PAGE, DISCAG_PAGE, DISU_PAGE].sort());
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

function findClass(node: unknown, className: string): Tree | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findClass(child, className);
      if (found) return found;
    }
    return null;
  }
  if (typeof node !== 'object' || node === null) return null;
  const tree = node as Tree;
  return tree.attrs.className === className ? tree : findClass(tree.children, className);
}

// Top level functions of app.js, run with the given fakes in place of the page.
function fromApp<T>(names: string[], fakes: Record<string, unknown>): T {
  const app = read('public/app.js');
  const sources = names.map((name) => {
    const found = new RegExp(`^function ${name}\\([^)]*\\) \\{\\n[\\s\\S]*?\\n\\}$`, 'm').exec(app);
    assert.ok(found, `${name} is missing from public/app.js`);
    return found[0];
  });
  const make = new Function(...Object.keys(fakes), `${sources.join('\n')}\nreturn { ${names.join(', ')} };`);
  return make(...Object.values(fakes)) as T;
}

function lessonRenderers(): { lessonItem: Render; lessonHitRow: Render } {
  return fromApp<{ lessonItem: Render; lessonHitRow: Render }>(['parts', 'canReportNotHeld', 'courseText', 'lessonItem', 'lessonHitRow'], {
    el: (tag: string, attrs: Record<string, unknown> = {}, ...children: unknown[]): Tree => ({ tag, attrs, children }),
    fmtTime: (ms: number) => `t${ms}`,
    prettyTitle: (text: string) => text,
    courseParts: helpers.courseParts,
    signedIn: () => false,
    isoDayOf: () => '2026-11-10',
    dayTitle: (iso: string) => iso,
    placeName: (_key: string, name: string) => name,
    openRoom: () => undefined,
  });
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

test('the degree level closes the course label as is, in a span of its own that never breaks', () => {
  const { lessonItem } = lessonRenderers();
  const start = Date.UTC(2026, 10, 10, 8);
  const cases: [string, string, string | null][] = [
    ['INGEGNERIA INFORMATICA (triennale)', 'Ingegneria informatica (triennale)', '(triennale)'],
    ['Economia Aziendale e Management (magistrale)', 'Economia Aziendale e Management (magistrale)', '(magistrale)'],
    ['GIURISPRUDENZA (ciclo unico)', 'Giurisprudenza (ciclo unico)', '(ciclo unico)'],
    ['FISICA', 'Fisica', null],
    ['Matematica (corso A)', 'Matematica (corso A)', null],
    ['Fisica (Triennale)', 'Fisica (Triennale)', null],
  ];
  for (const [label, shown, level] of cases) {
    const lesson = { id: 'l1', title: 'Analisi', start, end: start + 3_600_000, status: 'active', year: 1, courses: [label] };
    const row = lessonItem(lesson, start, null, null);
    assert.equal(textOf(findClass(row, 'lesson-course')), shown, label);
    const span = findClass(row, 'course-level');
    assert.equal(span ? textOf(span) : null, level, label);
  }
  assert.match(read('public/style.css'), /^\.course-level \{ white-space: nowrap; \}$/m);
});

test('bridge rooms read Ponte coperto or Ponte scoperto, any other bridge value is ignored', () => {
  assert.equal(helpers.floorLabel(null, 'coperto'), 'Ponte coperto');
  assert.equal(helpers.floorLabel(null, 'scoperto'), 'Ponte scoperto');
  assert.equal(helpers.bridgeOf({ floor: null, bridge: 'scoperto' }), 'scoperto');
  for (const odd of [null, undefined, 'Coperto', 'ponte', '__proto__', 4]) {
    assert.equal(helpers.floorLabel(2, odd), '2° piano', String(odd));
    assert.equal(helpers.bridgeOf({ floor: 2, bridge: odd }), null, String(odd));
  }
  assert.equal(helpers.floorLabel(null), 'piano non indicato');
  assert.equal(helpers.floorLabel(0), 'piano terra');
  assert.equal(helpers.bridgeOf(null), null);
});

interface MapRoom {
  floor: number | null;
  bridge: unknown;
}

interface MapHelpers {
  sliceFloor(room: MapRoom): number | null;
  floorGroups(rooms: MapRoom[]): { label: string; rooms: MapRoom[] }[];
}

const mapHelpers = (): MapHelpers =>
  fromApp<MapHelpers>(['sliceFloor', 'floorGroups'], { bridgeOf: helpers.bridgeOf, floorLabel: helpers.floorLabel });

const mapRoom = (floor: number | null, bridge: unknown = null): MapRoom => ({ floor, bridge });

test('a bridge room sits on slice 4 (coperto) or 5 (scoperto), odd values have no slice', () => {
  const { sliceFloor } = mapHelpers();
  assert.equal(sliceFloor(mapRoom(null, 'coperto')), 4);
  assert.equal(sliceFloor(mapRoom(null, 'scoperto')), 5);
  assert.equal(sliceFloor(mapRoom(2)), 2);
  assert.equal(sliceFloor(mapRoom(null)), null);
  assert.equal(sliceFloor(mapRoom(null, 'ponte')), null);
  assert.equal(sliceFloor(mapRoom(1.5)), null);
});

test('the building view puts each bridge after the floor of its slice and rooms without a floor last', () => {
  const rooms = [mapRoom(3), mapRoom(null, 'scoperto'), mapRoom(null), mapRoom(0), mapRoom(null, 'coperto'), mapRoom(4), mapRoom(-1), mapRoom(null, 'coperto')];
  const groups = mapHelpers().floorGroups(rooms);
  assert.deepEqual(
    groups.map((g) => g.label),
    ['piano -1', 'piano terra', '3° piano', '4° piano', 'Ponte coperto', 'Ponte scoperto', 'piano non indicato'],
  );
  assert.equal(groups[4]!.rooms.length, 2);
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

test('every RPC call of the pages lives in data.js, the room bridge one with the parameters of its SQL function', () => {
  const dir = fileURLToPath(new URL('public/', ROOT));
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.js') && n !== 'data.js' && n !== 'auth.js')) {
    const text = read(`public/${name}`);
    assert.ok(!/\brpc\(/.test(text), name);
    assert.ok(!/^import \{[^}]*\brpc\b[^}]*\} from '\.\/auth\.js';$/m.test(text), name);
  }
  assert.match(read('supabase/migrations/20261110091300_bridge_levels.sql'), /^create function public\.admin_set_room_bridge\(p_room_id text, p_bridge text\)$/m);
  assert.match(read('public/data.js'), /^ {2}setRoomBridge: \(roomId, bridge\) => rpc\('admin_set_room_bridge', \{ p_room_id: roomId, p_bridge: bridge \}\),$/m);
});

type LevelCall = [string, string, number | string | null];

test('the admin floor menu sends a number to admin_set_room_floor and a bridge to admin_set_room_bridge', () => {
  const found = /^function setRoomLevel\(room, value\) \{\n[\s\S]*?\n\}$/m.exec(read('public/admin.js'));
  assert.ok(found, 'setRoomLevel is missing from public/admin.js');
  const calls: LevelCall[] = [];
  const admin = {
    setRoomFloor: (id: string, floor: number | null) => calls.push(['floor', id, floor]),
    setRoomBridge: (id: string, bridge: string | null) => calls.push(['bridge', id, bridge]),
  };
  const call = (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => fn(...args);
  const make = new Function('call', 'admin', 'bridgeOf', `${found[0]}\nreturn setRoomLevel;`);
  const setRoomLevel = make(call, admin, helpers.bridgeOf) as (room: MapRoom & { id: string }, value: string) => unknown;
  setRoomLevel({ id: 'r1', floor: 2, bridge: null }, 'coperto');
  setRoomLevel({ id: 'r1', floor: null, bridge: 'coperto' }, '3');
  setRoomLevel({ id: 'r1', floor: null, bridge: 'scoperto' }, '');
  setRoomLevel({ id: 'r1', floor: 0, bridge: null }, '');
  setRoomLevel({ id: 'r1', floor: null, bridge: null }, '-2');
  setRoomLevel({ id: 'r1', floor: null, bridge: null }, 'scoperto');
  assert.deepEqual(calls, [
    ['bridge', 'r1', 'coperto'],
    ['floor', 'r1', 3],
    ['bridge', 'r1', null],
    ['floor', 'r1', null],
    ['floor', 'r1', -2],
    ['bridge', 'r1', 'scoperto'],
  ]);
});
