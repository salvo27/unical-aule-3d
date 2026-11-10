import { themed } from './theme.js';
import { el, fmtTime, fmtDay, KIND_LABEL, CATEGORY_LABEL, BRIDGE_LABEL, bridgeOf } from './ui.js';
import { initAuth, signedIn, userId, onSessionChange, sendLoginLink, signOut } from './auth.js';
import { whoamiRole, admin } from './data.js';
import { MESSAGES, messageFor } from './errors.js';
import { calendarRef, sourceUrlLine } from './refs.js';

const root = document.getElementById('admin');

const SYNC_WORKFLOW = 'https://github.com/salvo27/unical-aule-3d/actions/workflows/sync.yml';
const POLL_RUNNING_MS = 10_000;
const POLL_WAITING_MS = 30_000;
const POLL_LIMIT_MS = 30 * 60_000;
const SOURCE_LABEL = { planner: 'Planner', portal: 'Portale', dimes: 'App', xlsx: 'xlsx', pdf: 'PDF' };

function message(err) {
  return messageFor(err && err.code);
}

// Every database call goes through here: a 401 means the session expired.
async function call(fn, ...args) {
  try {
    return await fn(...args);
  } catch (err) {
    if (err.status === 401) {
      overview = null;
      expired = true;
      renderLogin('Sessione scaduta: accedi di nuovo.');
    }
    throw err;
  }
}

let overview = null;
let role = null;
let pending = null;
let users = null;
let found = undefined;
let currentUser = null;
let busy = false;
let expired = false;
let flash = null;
let proposals = null;
let proposalsAt;
let onlyUnplaced = true;
let pollTimer = 0;
let lastAction = Date.now();

function setFlash(text, kind = 'ok') {
  flash = { text, kind };
  render();
}

function when(ms) {
  return ms ? `${fmtDay(ms)} alle ${fmtTime(ms)}` : 'mai';
}

function retryScreen(text, again) {
  root.replaceChildren(
    el('h1', {}, 'Aule Unical, admin'),
    el('div', { className: 'notice error' }, text),
    el('button', { className: 'btn', type: 'button', on: { click: again } }, 'Riprova'),
  );
}

function clearState() {
  overview = null;
  pending = null;
  users = null;
  found = undefined;
  proposals = null;
  proposalsAt = undefined;
  clearTimeout(pollTimer);
}

async function boot() {
  const auth = await initAuth('admin');
  if (auth.status === 'error') return retryScreen(MESSAGES.network, () => location.reload());
  if (auth.status === 'disabled') {
    root.replaceChildren(
      el('h1', {}, 'Aule Unical, admin'),
      el('p', { className: 'muted' }, 'Area admin non disponibile per ora.'),
    );
    return;
  }
  currentUser = userId();
  // Token refreshes keep the same user: reload only when the user really changes.
  onSessionChange((event, next) => {
    const id = next ? next.user.id : null;
    // After a 401 the login screen is up: a refreshed token for the same user brings the page back.
    if (expired && next) {
      expired = false;
      currentUser = id;
      clearState();
      loadSession();
      return;
    }
    if (id === currentUser && event !== 'SIGNED_OUT') return;
    currentUser = id;
    clearState();
    loadSession();
  });
  if (auth.linkFailed && !signedIn()) return renderLogin('Il link non è valido o è scaduto, oppure è stato aperto in un altro browser. Chiedine uno nuovo.');
  await loadSession();
}

async function loadSession() {
  if (!signedIn()) return renderLogin();
  try {
    role = await whoamiRole();
  } catch (err) {
    if (err.status === 401) {
      expired = true;
      return renderLogin('Sessione scaduta: accedi di nuovo.');
    }
    return retryScreen(message(err), loadSession);
  }
  if (role !== 'moderator' && role !== 'admin') return showNoAccess();
  await loadOverview();
}

function showNoAccess() {
  clearState();
  root.replaceChildren(
      el('h1', {}, 'Aule Unical, admin'),
      el('p', { className: 'muted' }, 'Questo account non ha accesso all\'area admin. Chiedi a un admin di darti il ruolo di moderatore.'),
      el('button', { className: 'btn btn-secondary', type: 'button', on: { click: () => signOut().then(() => renderLogin()) } }, 'Esci'),
    );
}

function renderLogin(note) {
  const input = el('input', { className: 'login-email', type: 'email', id: 'email', autocomplete: 'email', maxlength: '254', required: true, placeholder: 'nome@unical.it' });
  const message = el('p', { className: 'muted' }, typeof note === 'string' ? note : '');
  const form = el(
    'form',
    {
      className: 'card login admin-login',
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (busy) return;
          busy = true;
          const result = await sendLoginLink(input.value, '/admin', { createUser: false }).finally(() => (busy = false));
          message.textContent = result.ok
            ? 'Controlla la mail e apri il link da questo browser.'
            : result.code === 'domain'
              ? 'Controlla la mail: lettere, numeri, punti e trattini, senza +.'
              : result.code === 'refused'
                ? "Questa mail non ha accesso all'area admin."
                : result.code === 'rate_limited'
                  ? 'Hai già chiesto un link da poco: aspetta un minuto.'
                  : 'Invio non riuscito, riprova.';
        },
      },
    },
    el('h1', {}, 'Aule Unical, admin'),
    el('label', { for: 'email' }, 'Mail'),
    input,
    el('button', { className: 'btn login-submit', type: 'submit' }, 'Mandami il link'),
    message,
  );
  root.replaceChildren(form);
  input.focus();
}

async function loadOverview() {
  const user = currentUser;
  try {
    const nextPending = await call(admin.pending);
    let nextOverview = { moderatorOnly: true };
    let nextUsers = null;
    if (role === 'admin') {
      nextOverview = await call(admin.overview);
      nextUsers = await call(admin.staff);
    }
    if (user !== currentUser) return;
    pending = nextPending;
    overview = nextOverview;
    users = nextUsers;
    if (overview.proposals) keepProposals(overview.proposals);
  } catch (err) {
    if (err.status === 401) return;
    if (err.status === 403) {
      role = null;
      return showNoAccess();
    }
    if (!overview) return retryScreen(message(err), loadOverview);
    setFlash(message(err), 'error');
    schedulePoll();
    return;
  }
  render();
  schedulePoll();
}

// The editable copy (selection, labels) is rebuilt only by a new search; added calendars leave it.
function keepProposals(info) {
  if (info.at !== proposalsAt) {
    proposalsAt = info.at;
    proposals = info.at === null ? null : info.items.map((p) => ({ ...p, selected: true }));
  } else if (proposals) {
    const ids = new Set(info.items.map((p) => p.id));
    proposals = proposals.filter((p) => ids.has(p.id));
  }
}

// Fast while a run is open, slower while a request waits for GitHub, never long after the last action.
function schedulePoll() {
  clearTimeout(pollTimer);
  const sync = overview && overview.sync;
  if (!sync || Date.now() - lastAction > POLL_LIMIT_MS) return;
  const waiting = sync.requested.sync.pending || sync.requested.discover.pending;
  const delay = sync.running ? POLL_RUNNING_MS : waiting ? POLL_WAITING_MS : 0;
  if (delay) pollTimer = setTimeout(poll, delay);
}

// Do not rebuild the page while an operation runs or someone is typing in it.
function poll() {
  const active = document.activeElement;
  const typing = active && root.contains(active) && active.matches('textarea, select, input:not([type="checkbox"])');
  if (busy || typing) return schedulePoll();
  loadOverview();
}

// One operation at a time: controls stay disabled until the page has reloaded its data.
async function withBusy(fn) {
  if (busy) return;
  busy = true;
  lastAction = Date.now();
  const locked = [...root.querySelectorAll('button, select, input, textarea')].filter((control) => !control.disabled);
  for (const control of locked) control.disabled = true;
  try {
    await fn();
  } finally {
    busy = false;
    // Controls drawn again meanwhile keep the state the new data gives them.
    for (const control of locked) control.disabled = false;
  }
}

function act(fn, success) {
  return withBusy(async () => {
    try {
      await fn();
      if (success) flash = { text: success, kind: 'ok' };
    } catch (err) {
      if (err.status === 401) return;
      flash = { text: message(err), kind: 'error' };
    }
    await loadOverview();
  });
}

function section(name, title, ...children) {
  return el('section', { className: `card card-${name}` }, el('h2', {}, title), ...children);
}

function waitingNote(request, text) {
  if (!request.pending) return null;
  return el('p', { className: 'muted' }, request.at ? `${text} alle ${fmtTime(request.at)}, in attesa.` : `${text}, in attesa.`);
}

function runOutcome(run) {
  if (run.outcome === 'completed') return 'completato';
  return run.failure === 'implausible' ? 'non riuscito (dati scaricati non plausibili, tenuti quelli di prima)' : 'non riuscito';
}

function syncSection() {
  const { running, lastRun, late, requested } = overview.sync;
  const summary = lastRun
    ? `Ultimo aggiornamento ${when(lastRun.finishedAt || lastRun.startedAt)}: ${runOutcome(lastRun)}, ${lastRun.ok} calendari scaricati, ${lastRun.failed} con errori.`
    : 'Nessun aggiornamento ancora eseguito.';
  return section(
    'sync',
    'Aggiornamento orari',
    late
      ? el(
          'div',
          { className: 'notice error' },
          "L'ultimo aggiornamento riuscito è di più di 26 ore fa. Controlla il workflow sync su GitHub: dopo 60 giorni senza attività nel repository GitHub lo disattiva. ",
          el('a', { href: SYNC_WORKFLOW, rel: 'noopener noreferrer' }, 'Apri il workflow'),
        )
      : null,
    el('p', { className: 'sync-summary' }, summary),
    waitingNote(requested.sync, 'Aggiornamento richiesto'),
    el('p', { className: 'muted' }, 'Gli orari si aggiornano da soli più volte al giorno. Usa il bottone dopo aver cambiato i calendari.'),
    el(
      'button',
      {
        className: 'btn sync-run',
        type: 'button',
        disabled: running || requested.sync.pending,
        on: { click: () => act(() => call(admin.requestSync), "Richiesta registrata: l'aggiornamento parte entro circa 20 minuti.") },
      },
      running ? 'Aggiornamento in corso…' : 'Aggiorna adesso',
    ),
  );
}

function calendarState(c) {
  if (!c.run) return 'never';
  return c.run.outcome === 'ok' ? 'ok' : 'error';
}

function calendarStatus(c) {
  if (!c.run) return 'mai scaricato';
  if (c.run.outcome === 'ok') return c.run.lessons === 0 ? 'ok, nessuna lezione nel periodo' : 'ok';
  return `errore (${c.run.failure})`;
}

function calendarsSection() {
  const rows = overview.calendars.map((c) =>
    el(
      'tr',
      {},
      el('td', {}, c.label, el('div', { className: 'mono' }, c.id)),
      el('td', {}, Object.hasOwn(SOURCE_LABEL, c.source) ? SOURCE_LABEL[c.source] : '-', c.source !== 'planner' && c.ref ? el('div', { className: 'mono' }, c.ref) : null),
      el('td', { className: `cal-status cal-${calendarState(c)}` }, calendarStatus(c)),
      el('td', { className: 'num' }, c.run ? String(c.run.lessons) : '-'),
      el('td', {}, c.fetchedAt ? when(c.fetchedAt) : '-'),
      el(
        'td',
        {},
        el('input', {
          type: 'checkbox',
          checked: c.active,
          'aria-label': `Calendario attivo: ${c.label}`,
          on: { change: (e) => act(() => call(admin.setCalendarActive, c.id, e.target.checked)) },
        }),
      ),
      el(
        'td',
        {},
        el(
          'button',
          {
            className: 'link-btn danger',
            type: 'button',
            on: {
              click: () => {
                if (confirm(`Rimuovere "${c.label}"?`)) act(() => call(admin.removeCalendar, c.id), 'Calendario rimosso.');
              },
            },
          },
          'Rimuovi',
        ),
      ),
    ),
  );
  const ref = el('input', { type: 'text', placeholder: 'Link pubblico del Planner o id', maxlength: '500', required: true });
  const name = el('input', { type: 'text', placeholder: 'Nome (es. DEMACS · Informatica · 1° semestre)', maxlength: '160', required: true });
  const form = el(
    'form',
    {
      className: 'inline-form calendar-form',
      on: {
        submit: (e) => {
          e.preventDefault();
          const id = calendarRef(ref.value);
          if (!id) return setFlash(MESSAGES.calendar_ref, 'error');
          act(() => call(admin.addCalendar, id, name.value.trim()), 'Calendario aggiunto.');
        },
      },
    },
    ref,
    name,
    el('button', { className: 'btn', type: 'submit' }, 'Aggiungi'),
  );
  return section(
    'calendars',
    `Calendari (${overview.calendars.length})`,
    el(
      'div',
      { className: 'table-wrap' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ['Nome', 'Fonte', 'Stato', 'Lezioni', 'Ultimo download', 'Attivo', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      ),
    ),
    form,
  );
}

function discoverSection() {
  const sources = el('textarea', { className: 'sources', rows: '4', spellcheck: 'false' });
  sources.value = overview.sources.join('\n');
  const saveSources = () => {
    const urls = sources.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .map(sourceUrlLine);
    act(() => call(admin.setSources, urls), 'Pagine salvate.');
  };
  const discover = overview.sync.requested.discover;
  const info = overview.proposals;
  const search = () => act(() => call(admin.requestDiscover), 'Ricerca richiesta: i calendari trovati compaiono qui entro circa 20 minuti.');
  const addSelected = () =>
    withBusy(async () => {
      let added = 0;
      let failed = 0;
      for (const p of proposals.filter((x) => x.selected)) {
        try {
          await call(admin.addCalendar, p.id, p.label.trim());
          added += 1;
        } catch (err) {
          if (err.status === 401) return;
          failed += 1;
        }
      }
      flash = { text: `Aggiunti ${added} calendari${failed ? `, ${failed} non aggiunti` : ''}. Ricordati di aggiornare gli orari.`, kind: failed ? 'error' : 'ok' };
      await loadOverview();
    });
  const unread = info.failures.length ? ` ${info.failures.length} pagine non lette.` : '';
  const result = info.at ? el('p', { className: 'muted' }, `Ultima ricerca ${when(info.at)}. Trovati ${info.items.length} calendari nuovi.${unread}`) : null;
  const list = proposals
    ? el(
        'div',
        {},
        proposals.length === 0
          ? el('p', { className: 'muted' }, 'Nessun calendario nuovo nelle pagine indicate.')
          : el(
              'ul',
              { className: 'proposals' },
              proposals.map((p) =>
                el(
                  'li',
                  {},
                  el('input', { type: 'checkbox', checked: p.selected, 'aria-label': 'Seleziona', on: { change: (e) => (p.selected = e.target.checked) } }),
                  el('input', { type: 'text', value: p.label, maxlength: '160', 'aria-label': 'Nome', on: { input: (e) => (p.label = e.target.value) } }),
                  el('span', { className: 'mono' }, new URL(p.source).hostname),
                ),
              ),
            ),
        proposals.length ? el('button', { className: 'btn', type: 'button', on: { click: addSelected } }, 'Aggiungi selezionati') : null,
      )
    : null;
  return section(
    'discover',
    'Cerca nuovi calendari',
    el('p', { className: 'muted' }, 'Pagine dei dipartimenti da leggere, una per riga (solo https su unical.it). A inizio semestre premi "Cerca calendari" e conferma i calendari nuovi.'),
    sources,
    el(
      'div',
      { className: 'actions' },
      el('button', { className: 'btn btn-secondary', type: 'button', on: { click: saveSources } }, 'Salva pagine'),
      el('button', { className: 'btn', type: 'button', disabled: discover.pending, on: { click: search } }, 'Cerca calendari'),
    ),
    waitingNote(discover, 'Ricerca richiesta'),
    result,
    list,
  );
}

const FLOOR_OPTIONS = ['', ...Array.from({ length: 15 }, (_, i) => String(i - 2)), 'coperto', 'scoperto'];

function floorName(v) {
  if (v === '') return 'non indicato';
  if (v === 'coperto' || v === 'scoperto') return BRIDGE_LABEL[v];
  const n = Number(v);
  return n === 0 ? 'Terra' : n < 0 ? `${n}` : `${n}°`;
}

// A number goes to admin_set_room_floor, a bridge to admin_set_room_bridge: each one clears the other.
function setRoomLevel(room, value) {
  if (value === 'coperto' || value === 'scoperto') return call(admin.setRoomBridge, room.id, value);
  if (value === '') return bridgeOf(room) ? call(admin.setRoomBridge, room.id, null) : call(admin.setRoomFloor, room.id, null);
  return call(admin.setRoomFloor, room.id, Number(value));
}

function roomsSection() {
  const rooms = overview.rooms.filter((r) => !onlyUnplaced || (r.floor === null && !bridgeOf(r)));
  const rows = rooms.map((r) => {
    const select = el(
      'select',
      {
        'aria-label': `Piano di ${r.name}`,
        on: { change: (e) => act(() => setRoomLevel(r, e.target.value)) },
      },
      FLOOR_OPTIONS.map((v) => el('option', { value: v }, floorName(v))),
    );
    select.value = bridgeOf(r) ?? (r.floor === null ? '' : String(r.floor));
    const origin = r.floorSource === 'admin' ? 'impostato qui' : r.floorSource === 'seed' ? 'da elenco del dipartimento' : '';
    return el(
      'tr',
      {},
      el('td', {}, r.name),
      el('td', {}, r.buildingName || '-', r.buildingKey ? null : el('div', { className: 'muted' }, 'non sulla mappa')),
      el('td', { className: 'num' }, r.capacity ? String(r.capacity) : '-'),
      el('td', {}, select),
      el('td', { className: 'muted floor-origin' }, origin),
    );
  });
  const toggle = el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: onlyUnplaced, on: { change: (e) => ((onlyUnplaced = e.target.checked), render()) } }), ' Solo aule senza piano');
  return section(
    'rooms',
    'Aule e piani',
    el('p', { className: 'muted' }, 'Il Planner non indica il piano: impostalo qui per colorare il piano giusto sulla mappa. Per le aule sui ponti scegli Ponte coperto o Ponte scoperto.'),
    toggle,
    rows.length
      ? el(
          'div',
          { className: 'table-wrap' },
          el('table', {}, el('thead', {}, el('tr', {}, ['Aula', 'Edificio', 'Posti', 'Piano', ''].map((h) => el('th', {}, h)))), el('tbody', {}, rows)),
        )
      : el('p', { className: 'muted' }, 'Nessuna aula da sistemare.'),
  );
}

function campusSelect(label) {
  const select = el('select', { 'aria-label': label }, el('option', { value: '' }, 'Scegli un edificio'));
  for (const b of [...overview.campus].sort((a, b) => a.name.localeCompare(b.name, 'it', { numeric: true }))) {
    select.append(el('option', { value: b.key }, b.name));
  }
  return select;
}

function buildingsSection() {
  const unmatched = overview.unmatchedBuildings.map((name) => {
    const select = campusSelect(`Edificio per ${name}`);
    return el(
      'li',
      {},
      el('strong', {}, name),
      select,
      el(
        'button',
        {
          className: 'btn btn-secondary',
          type: 'button',
          on: { click: () => select.value && act(() => call(admin.linkBuilding, name, select.value), 'Edificio collegato.') },
        },
        'Collega',
      ),
    );
  });
  const names = new Map(overview.campus.map((b) => [b.key, b.name]));
  const links = Object.entries(overview.buildingLinks).map(([name, key]) =>
    el(
      'li',
      {},
      `${name} → ${names.get(key) || key} `,
      el('button', { className: 'link-btn', type: 'button', on: { click: () => act(() => call(admin.linkBuilding, name, null)) } }, 'Scollega'),
    ),
  );
  const building = campusSelect('Edificio');
  const floors = el('input', { type: 'number', min: '1', max: '15', value: '5', 'aria-label': 'Numero di piani' });
  const base = el('input', { type: 'number', min: '0', max: '12', value: '0', 'aria-label': 'Piani di dislivello' });
  const shapeForm = el(
    'form',
    {
      className: 'inline-form shape-form',
      on: {
        submit: (e) => {
          e.preventDefault();
          if (!building.value) return;
          const count = Number(floors.value);
          const level = Number(base.value);
          if (!Number.isInteger(count)) return setFlash(MESSAGES.floor_count, 'error');
          if (!Number.isInteger(level)) return setFlash(MESSAGES.base_level, 'error');
          act(() => call(admin.setBuildingShape, building.value, count, level), 'Forma salvata.');
        },
      },
    },
    building,
    el('label', {}, 'Piani ', floors),
    el('label', {}, 'Dislivello ', base),
    el('button', { className: 'btn', type: 'submit' }, 'Salva'),
  );
  const shapes = Object.entries(overview.shapes).map(([key, s]) => el('li', {}, `${names.get(key) || key}: ${s.floors} piani, dislivello ${s.baseLevel}`));
  return section(
    'buildings',
    'Edifici',
    el('h3', {}, 'Nomi del Planner da collegare alla mappa'),
    unmatched.length ? el('ul', { className: 'plain unmatched' }, unmatched) : el('p', { className: 'muted' }, 'Tutti gli edifici del Planner sono sulla mappa.'),
    links.length ? el('ul', { className: 'plain building-links' }, links) : null,
    el('h3', {}, 'Numero di piani'),
    el('p', { className: 'muted' }, 'I cubi partono da 5 piani. Il dislivello alza il piano terra, per i cubi più in basso lungo la collina.'),
    shapeForm,
    shapes.length ? el('ul', { className: 'plain shapes' }, shapes) : null,
  );
}

function when2(start, end) {
  const sameDay = fmtDay(start) === fmtDay(end);
  return sameDay ? `${fmtDay(start)}, ${fmtTime(start)}-${fmtTime(end)}` : `dal ${fmtDay(start)} al ${fmtDay(end)}`;
}

function requestsSection() {
  const rows = (pending || []).map((r) => {
    const what = r.kind === 'issue' ? `${KIND_LABEL.issue}: ${CATEGORY_LABEL[r.category] || 'Altro'}` : KIND_LABEL[r.kind];
    const where = r.roomName ? `${r.roomName} (${r.buildingName || 'edificio non indicato'})` : 'Aula non più negli orari';
    const decide = (decision) => act(() => call(admin.review, r.id, decision), decision === 'approved' ? 'Richiesta approvata.' : 'Richiesta respinta.');
    return el(
      'tr',
      {},
      el('td', {}, what, r.lessonTitle ? el('div', { className: 'muted' }, r.lessonTitle) : null),
      el('td', {}, where),
      el('td', {}, when2(r.start, r.end)),
      el('td', {}, r.supporters ? `+${r.supporters} persone` : '-'),
      el('td', {}, `${r.reporterApproved} approvate, ${r.reporterRejected} respinte`),
      el(
        'td',
        { className: 'actions-cell' },
        el('button', { className: 'btn approve', type: 'button', on: { click: () => decide('approved') } }, 'Approva'),
        el('button', { className: 'btn btn-secondary reject', type: 'button', on: { click: () => decide('rejected') } }, 'Respingi'),
      ),
    );
  });
  return section(
    'requests',
    `Richieste da controllare (${rows.length})`,
    el('p', { className: 'muted' }, 'Una richiesta approvata cambia la mappa per il suo intervallo. Le richieste scadute spariscono da sole.'),
    rows.length
      ? el(
          'div',
          { className: 'table-wrap' },
          el(
            'table',
            {},
            el('thead', {}, el('tr', {}, ['Segnalazione', 'Aula', 'Quando', 'Conferme', 'Storico autore', ''].map((h) => el('th', {}, h)))),
            el('tbody', {}, rows),
          ),
        )
      : el('p', { className: 'muted' }, 'Nessuna richiesta in attesa.'),
  );
}

function roleSelect(u) {
  const select = el(
    'select',
    {
      'aria-label': `Ruolo di ${u.email}`,
      on: { change: (e) => act(() => call(admin.setRole, u.userId, e.target.value), 'Ruolo aggiornato.') },
    },
    ['student', 'moderator', 'admin'].map((r) => el('option', { value: r }, r === 'student' ? 'Studente' : r === 'moderator' ? 'Moderatore' : 'Admin')),
  );
  select.value = u.role;
  return select;
}

function usersSection() {
  const rows = (users || []).map((u) => el('tr', {}, el('td', {}, u.email), el('td', {}, roleSelect(u)), el('td', {}, u.lastSignInAt ? when(u.lastSignInAt) : 'mai')));
  const email = el('input', { type: 'email', maxlength: '254', placeholder: 'mail esatta, es. nome@studenti.unical.it', 'aria-label': 'Mail da cercare' });
  const lookup = el(
    'form',
    {
      className: 'inline-form user-lookup',
      on: {
        submit: (e) => {
          e.preventDefault();
          const value = email.value.trim();
          return withBusy(async () => {
            try {
              found = await call(admin.findUser, value);
              flash = null;
            } catch (err) {
              found = undefined;
              flash = { text: err.code === 'invalid' ? 'Scrivi una mail completa.' : message(err), kind: 'error' };
            }
            render();
          });
        },
      },
    },
    email,
    el('button', { className: 'btn btn-secondary', type: 'submit' }, 'Cerca'),
  );
  const result =
    found === undefined
      ? null
      : found === null
        ? el('p', { className: 'muted' }, 'Nessun account con questa mail. La persona deve prima accedere una volta.')
        : el('div', { className: 'inline-form user-found' }, el('strong', {}, found.email), roleSelect(found));
  return section(
    'users',
    'Utenti e ruoli',
    el('p', { className: 'muted' }, 'Per dare un ruolo cerca la persona con la sua mail esatta. Qui sotto ci sono solo moderatori e admin; il proprio ruolo non si può cambiare.'),
    lookup,
    result,
    rows.length
      ? el(
          'div',
          { className: 'table-wrap' },
          el('table', {}, el('thead', {}, el('tr', {}, ['Mail', 'Ruolo', 'Ultimo accesso'].map((h) => el('th', {}, h)))), el('tbody', {}, rows)),
        )
      : null,
  );
}

function render() {
  if (!overview) return;
  const logout = el(
    'button',
    {
      className: 'link-btn admin-logout',
      type: 'button',
      on: {
        click: async () => {
          await signOut();
          overview = null;
          renderLogin();
        },
      },
    },
    'Esci',
  );
  const parts = [
    el('header', { className: 'admin-head' }, el('h1', {}, 'Aule Unical, admin'), el('a', { className: 'admin-map-link', href: themed('/') }, 'Mappa'), logout),
    flash ? el('div', { className: `notice ${flash.kind === 'error' ? 'error' : 'ok'}`, role: 'status' }, flash.text) : null,
    requestsSection(),
    ...(role === 'admin' ? [syncSection(), calendarsSection(), discoverSection(), roomsSection(), buildingsSection(), usersSection()] : []),
  ];
  root.replaceChildren(...parts.filter(Boolean));
}

boot();
