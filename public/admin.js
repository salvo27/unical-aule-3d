import { el, fmtTime, fmtDay, KIND_LABEL, CATEGORY_LABEL } from './ui.js';
import { initAuth, signedIn, userId, onSessionChange, sendLoginLink, signOut, authed } from './auth.js';

const root = document.getElementById('admin');

const MESSAGES = {
  network: 'Server non raggiungibile.',
  unauthorized: 'Sessione scaduta: accedi di nuovo.',
  forbidden: 'Non hai i permessi per questa operazione.',
  accounts_disabled: 'Gli account non sono attivi su questo server.',
  not_pending: 'Questa richiesta è già stata decisa.',
  own_request: 'Non puoi decidere una tua richiesta.',
  own_role: 'Non puoi cambiare il tuo ruolo.',
  expired: 'La richiesta è scaduta.',
  user_missing: 'Utente non trovato.',
  upstream_unavailable: 'Supabase non raggiungibile.',
  upstream_error: 'Supabase ha risposto con un errore: riprova tra poco.',
  no_lesson: 'La lezione non è più negli orari con questi dati: la richiesta si può solo respingere.',
  role: 'Ruolo non valido.',
  sync_running: 'Un aggiornamento è già in corso.',
  calendar_exists: 'Questo calendario è già presente.',
  calendar_missing: 'Calendario non trovato.',
  too_many_calendars: 'Hai raggiunto il numero massimo di calendari.',
  too_many_sources: 'Troppe pagine sorgente (massimo 60).',
  unknown_building: 'Edificio non presente sulla mappa.',
  not_found: 'Elemento non trovato.',
  payload_too_large: 'Richiesta troppo grande.',
  calendar_ref: 'Link non valido: incolla il link pubblico del Planner o il suo id.',
  label: 'Nome non valido (1-160 caratteri).',
  source_url: 'Indirizzo non valido: solo pagine https su unical.it.',
  floor: 'Piano non valido.',
  floor_count: 'Numero di piani non valido (1-15).',
  base_level: 'Dislivello non valido (0-12).',
};

function message(err) {
  if (err && err.code === 'invalid' && err.field && MESSAGES[err.field]) return MESSAGES[err.field];
  return (err && MESSAGES[err.code]) || 'Operazione non riuscita.';
}

// The API helper does not expose "field": read it here for clearer messages.
async function call(path, options) {
  try {
    return await authed(path, options);
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
let onlyUnplaced = true;
let pollTimer = 0;

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
  clearTimeout(pollTimer);
}

async function boot() {
  const auth = await initAuth();
  if (auth.status === 'error') return retryScreen(MESSAGES.network, () => location.reload());
  if (auth.status === 'disabled') {
    root.replaceChildren(
      el('h1', {}, 'Aule Unical, admin'),
      el('p', { className: 'muted' }, 'Area admin non attiva: configura SUPABASE_URL e SUPABASE_PUBLISHABLE_KEY sul server.'),
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
    role = (await authed('/admin/api/session')).role;
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
  const input = el('input', { type: 'email', id: 'email', autocomplete: 'email', maxlength: '254', required: true, placeholder: 'nome@unical.it' });
  const message = el('p', { className: 'muted' }, typeof note === 'string' ? note : '');
  const form = el(
    'form',
    {
      className: 'card login',
      on: {
        submit: async (e) => {
          e.preventDefault();
          if (busy) return;
          busy = true;
          const result = await sendLoginLink(input.value, '/admin').finally(() => (busy = false));
          message.textContent = result.ok
            ? 'Controlla la mail e apri il link da questo browser.'
            : result.code === 'domain'
              ? 'Usa la tua mail @unical.it o @studenti.unical.it.'
              : result.code === 'rate_limited'
                ? 'Hai già chiesto un link da poco: aspetta un minuto.'
                : 'Invio non riuscito, riprova.';
        },
      },
    },
    el('h1', {}, 'Aule Unical, admin'),
    el('label', { for: 'email' }, 'Mail Unical'),
    input,
    el('button', { className: 'btn', type: 'submit' }, 'Mandami il link'),
    message,
  );
  root.replaceChildren(form);
  input.focus();
}

async function loadOverview() {
  const user = currentUser;
  try {
    const nextPending = (await call('/admin/api/requests')).requests;
    let nextOverview = { moderatorOnly: true };
    let nextUsers = null;
    if (role === 'admin') {
      nextOverview = await call('/admin/api/overview');
      nextUsers = (await call('/admin/api/staff')).users;
    }
    if (user !== currentUser) return;
    pending = nextPending;
    overview = nextOverview;
    users = nextUsers;
  } catch (err) {
    if (err.status === 401) return;
    if (err.status === 403) {
      role = null;
      return showNoAccess();
    }
    if (!overview) return retryScreen(message(err), loadOverview);
    setFlash(message(err), 'error');
    return;
  }
  render();
  clearTimeout(pollTimer);
  if (overview.sync && overview.sync.running) pollTimer = setTimeout(loadOverview, 3000);
}

// One operation at a time: every control stays disabled until the page has reloaded its data.
async function withBusy(fn) {
  if (busy) return;
  busy = true;
  for (const control of root.querySelectorAll('button, select, input, textarea')) control.disabled = true;
  try {
    await fn();
  } finally {
    busy = false;
    for (const control of root.querySelectorAll('button, select, input, textarea')) control.disabled = false;
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

function section(title, ...children) {
  return el('section', { className: 'card' }, el('h2', {}, title), ...children);
}

function syncSection() {
  const { running, lastRun } = overview.sync;
  const summary = lastRun
    ? `Ultimo aggiornamento ${when(lastRun.finishedAt)}: ${lastRun.outcome === 'completed' ? 'completato' : 'non riuscito'}, ${lastRun.ok} calendari scaricati, ${lastRun.failed} con errori.`
    : 'Nessun aggiornamento ancora eseguito.';
  return section(
    'Aggiornamento orari',
    el('p', {}, summary),
    el('p', { className: 'muted' }, 'Gli orari si aggiornano da soli più volte al giorno. Usa il bottone dopo aver cambiato i calendari.'),
    el(
      'button',
      {
        className: 'btn',
        type: 'button',
        disabled: running,
        on: { click: () => act(() => call('/admin/api/sync', { method: 'POST', body: {} }), 'Aggiornamento avviato.') },
      },
      running ? 'Aggiornamento in corso…' : 'Aggiorna adesso',
    ),
  );
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
      el('td', {}, calendarStatus(c)),
      el('td', { className: 'num' }, c.run ? String(c.run.lessons) : '-'),
      el('td', {}, c.fetchedAt ? when(c.fetchedAt) : '-'),
      el(
        'td',
        {},
        el('input', {
          type: 'checkbox',
          checked: c.active,
          'aria-label': `Calendario attivo: ${c.label}`,
          on: { change: (e) => act(() => call(`/admin/api/calendars/${c.id}`, { method: 'PATCH', body: { active: e.target.checked } })) },
        }),
      ),
      el(
        'td',
        {},
        el(
          'button',
          {
            className: 'link-btn',
            type: 'button',
            on: {
              click: () => {
                if (confirm(`Rimuovere "${c.label}"?`)) act(() => call(`/admin/api/calendars/${c.id}`, { method: 'DELETE' }), 'Calendario rimosso.');
              },
            },
          },
          'Rimuovi',
        ),
      ),
    ),
  );
  const ref = el('input', { type: 'text', placeholder: 'Link pubblico del Planner o id', maxlength: '500', required: true });
  const name = el('input', { type: 'text', placeholder: 'Nome (es. DIMES · Ing. Informatica · 1° semestre)', maxlength: '160', required: true });
  const form = el(
    'form',
    {
      className: 'inline-form',
      on: {
        submit: (e) => {
          e.preventDefault();
          act(() => call('/admin/api/calendars', { method: 'POST', body: { reference: ref.value, label: name.value } }), 'Calendario aggiunto.');
        },
      },
    },
    ref,
    name,
    el('button', { className: 'btn', type: 'submit' }, 'Aggiungi'),
  );
  return section(
    `Calendari (${overview.calendars.length})`,
    el(
      'div',
      { className: 'table-wrap' },
      el(
        'table',
        {},
        el('thead', {}, el('tr', {}, ['Nome', 'Stato', 'Lezioni', 'Ultimo download', 'Attivo', ''].map((h) => el('th', {}, h)))),
        el('tbody', {}, rows),
      ),
    ),
    form,
  );
}

function discoverSection() {
  const sources = el('textarea', { rows: '4', spellcheck: 'false' });
  sources.value = overview.sources.join('\n');
  const saveSources = () => {
    const urls = sources.value
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    act(() => call('/admin/api/sources', { method: 'PUT', body: { urls } }), 'Pagine salvate.');
  };
  const search = () =>
    withBusy(async () => {
      flash = { text: 'Ricerca nelle pagine in corso…', kind: 'ok' };
      try {
        const res = await call('/admin/api/discover', { method: 'POST', body: {} });
        proposals = res.found.map((f) => ({ ...f, selected: true }));
        const failed = res.failures.length ? ` ${res.failures.length} pagine non lette.` : '';
        flash = { text: `Trovati ${res.found.length} calendari nuovi.${failed}`, kind: 'ok' };
      } catch (err) {
        flash = { text: message(err), kind: 'error' };
      }
      render();
    });
  const addSelected = () =>
    withBusy(async () => {
      let added = 0;
      let failed = 0;
      for (const p of proposals.filter((x) => x.selected)) {
        try {
          await call('/admin/api/calendars', { method: 'POST', body: { reference: p.id, label: p.label } });
          added += 1;
        } catch {
          failed += 1;
        }
      }
      proposals = null;
      flash = { text: `Aggiunti ${added} calendari${failed ? `, ${failed} non aggiunti` : ''}. Ricordati di aggiornare gli orari.`, kind: failed ? 'error' : 'ok' };
      await loadOverview();
    });
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
    'Cerca nuovi calendari',
    el('p', { className: 'muted' }, 'Pagine dei dipartimenti da leggere, una per riga (solo https su unical.it). A inizio semestre premi "Cerca" e conferma i calendari nuovi.'),
    sources,
    el(
      'div',
      { className: 'actions' },
      el('button', { className: 'btn btn-secondary', type: 'button', on: { click: saveSources } }, 'Salva pagine'),
      el('button', { className: 'btn', type: 'button', on: { click: search } }, 'Cerca'),
    ),
    list,
  );
}

const FLOOR_OPTIONS = ['', ...Array.from({ length: 15 }, (_, i) => String(i - 2))];

function floorName(v) {
  if (v === '') return '-';
  const n = Number(v);
  return n === 0 ? 'Terra' : n < 0 ? `${n}` : `${n}°`;
}

function roomsSection() {
  const rooms = overview.rooms.filter((r) => !onlyUnplaced || r.floor === null);
  const rows = rooms.map((r) => {
    const select = el(
      'select',
      {
        'aria-label': `Piano di ${r.name}`,
        on: {
          change: (e) => {
            const value = e.target.value === '' ? null : Number(e.target.value);
            act(() => call(`/admin/api/rooms/${r.id}`, { method: 'PUT', body: { floor: value } }));
          },
        },
      },
      FLOOR_OPTIONS.map((v) => el('option', { value: v }, floorName(v))),
    );
    select.value = r.floor === null ? '' : String(r.floor);
    const origin = r.floorSource === 'admin' ? 'impostato qui' : r.floorSource === 'seed' ? 'da elenco del dipartimento' : '';
    return el(
      'tr',
      {},
      el('td', {}, r.name),
      el('td', {}, r.buildingName || '-', r.buildingKey ? null : el('div', { className: 'muted' }, 'non sulla mappa')),
      el('td', { className: 'num' }, r.capacity ? String(r.capacity) : '-'),
      el('td', {}, select),
      el('td', { className: 'muted' }, origin),
    );
  });
  const toggle = el('label', { className: 'check' }, el('input', { type: 'checkbox', checked: onlyUnplaced, on: { change: (e) => ((onlyUnplaced = e.target.checked), render()) } }), ' Solo aule senza piano');
  return section(
    'Aule e piani',
    el('p', { className: 'muted' }, 'Il Planner non indica il piano: impostalo qui per colorare il piano giusto sulla mappa.'),
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
          on: { click: () => select.value && act(() => call('/admin/api/building-links', { method: 'PUT', body: { name, key: select.value } }), 'Edificio collegato.') },
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
      el('button', { className: 'link-btn', type: 'button', on: { click: () => act(() => call('/admin/api/building-links', { method: 'PUT', body: { name, key: null } })) } }, 'Scollega'),
    ),
  );
  const building = campusSelect('Edificio');
  const floors = el('input', { type: 'number', min: '1', max: '15', value: '5', 'aria-label': 'Numero di piani' });
  const base = el('input', { type: 'number', min: '0', max: '12', value: '0', 'aria-label': 'Piani di dislivello' });
  const shapeForm = el(
    'form',
    {
      className: 'inline-form',
      on: {
        submit: (e) => {
          e.preventDefault();
          if (!building.value) return;
          act(
            () => call(`/admin/api/buildings/${building.value}`, { method: 'PUT', body: { floors: Number(floors.value), baseLevel: Number(base.value) } }),
            'Forma salvata.',
          );
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
    'Edifici',
    el('h3', {}, 'Nomi del Planner da collegare alla mappa'),
    unmatched.length ? el('ul', { className: 'plain' }, unmatched) : el('p', { className: 'muted' }, 'Tutti gli edifici del Planner sono sulla mappa.'),
    links.length ? el('ul', { className: 'plain' }, links) : null,
    el('h3', {}, 'Numero di piani'),
    el('p', { className: 'muted' }, 'I cubi partono da 5 piani. Il dislivello alza il piano terra, per i cubi più in basso lungo la collina.'),
    shapeForm,
    shapes.length ? el('ul', { className: 'plain' }, shapes) : null,
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
    const decide = (decision) => act(() => call(`/admin/api/requests/${r.id}/review`, { method: 'POST', body: { decision } }), decision === 'approved' ? 'Richiesta approvata.' : 'Richiesta respinta.');
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
        el('button', { className: 'btn', type: 'button', on: { click: () => decide('approved') } }, 'Approva'),
        el('button', { className: 'btn btn-secondary', type: 'button', on: { click: () => decide('rejected') } }, 'Respingi'),
      ),
    );
  });
  return section(
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
      on: { change: (e) => act(() => call(`/admin/api/users/${u.userId}/role`, { method: 'PUT', body: { role: e.target.value } }), 'Ruolo aggiornato.') },
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
      className: 'inline-form',
      on: {
        submit: (e) => {
          e.preventDefault();
          const value = email.value.trim();
          return withBusy(async () => {
            try {
              found = (await call('/admin/api/users/lookup', { method: 'POST', body: { email: value } })).user;
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
        : el('div', { className: 'inline-form' }, el('strong', {}, found.email), roleSelect(found));
  return section(
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
      className: 'link-btn',
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
    el('header', { className: 'admin-head' }, el('h1', {}, 'Aule Unical, admin'), el('a', { href: '/' }, 'Mappa'), logout),
    flash ? el('div', { className: `notice ${flash.kind === 'error' ? 'error' : 'ok'}`, role: 'status' }, flash.text) : null,
    requestsSection(),
    ...(role === 'admin' ? [syncSection(), calendarsSection(), discoverSection(), roomsSection(), buildingsSection(), usersSection()] : []),
  ];
  root.replaceChildren(...parts.filter(Boolean));
}

boot();
