// Closed error codes of the Supabase calls and their Italian texts. No DOM access: Node tests import this file.

// Codes the database raises on purpose (P0001) that a page may show. Any other text becomes upstream_error.
const BROWSER_CODES = new Set([
  'invalid',
  'window',
  'duplicate',
  'rate_limited',
  'too_many_pending',
  'not_pending',
  'own_request',
  'own_role',
  'expired',
  'not_found',
  'user_missing',
  'no_lesson',
  'too_soon',
  'calendar_exists',
  'calendar_missing',
  'too_many_calendars',
  'too_many_sources',
  'too_many_rooms',
  'too_many_buildings',
  'too_many_links',
  'unknown_building',
  'calendar_ref',
  'feed_ref',
  'label',
  'building_name',
  'source_url',
  'floor',
  'floor_count',
  'base_level',
]);

const JWT_CODE = /^PGRST30[1-3]$/;

export function errorCode(error, status) {
  if (!status) return 'network';
  const code = error && typeof error.code === 'string' ? error.code : '';
  const text = error && typeof error.message === 'string' ? error.message : '';
  if (code === 'P0001' && BROWSER_CODES.has(text)) return text;
  if (code === '42501') return 'forbidden';
  if (status === 401 && JWT_CODE.test(code)) return 'unauthorized';
  return 'upstream_error';
}

export const MESSAGES = Object.freeze({
  network: 'Server non raggiungibile.',
  unauthorized: 'Sessione scaduta: accedi di nuovo.',
  forbidden: 'Non hai i permessi per questa operazione.',
  accounts_disabled: 'Gli account non sono attivi.',
  upstream_error: 'Supabase ha risposto con un errore: riprova tra poco.',
  invalid: 'Dati non validi.',
  not_found: 'Elemento non trovato.',
  window: 'Non è più possibile fare questa segnalazione.',
  duplicate: 'Hai già fatto questa segnalazione.',
  rate_limited: 'Hai raggiunto il limite di 20 segnalazioni al giorno.',
  too_many_pending: 'Hai già diverse segnalazioni in attesa: aspetta che un moderatore le controlli.',
  not_pending: 'Questa richiesta è già stata decisa.',
  own_request: 'Non puoi decidere una tua richiesta.',
  own_role: 'Non puoi cambiare il tuo ruolo.',
  expired: 'La richiesta è scaduta.',
  user_missing: 'Utente non trovato.',
  no_lesson: 'La lezione non è più negli orari con questi dati: la richiesta si può solo respingere.',
  too_soon: 'Richiesta già inviata da poco: riprova tra 15 minuti.',
  calendar_exists: 'Questo calendario è già presente.',
  calendar_missing: 'Calendario non trovato.',
  too_many_calendars: 'Hai raggiunto il numero massimo di calendari.',
  too_many_sources: 'Troppe pagine sorgente (massimo 60).',
  too_many_rooms: 'Troppe aule con il piano impostato.',
  too_many_buildings: 'Troppi edifici con la forma impostata.',
  too_many_links: 'Troppi collegamenti tra edifici.',
  unknown_building: 'Edificio non presente sulla mappa.',
  calendar_ref: 'Link non valido: incolla il link pubblico del Planner o il suo id.',
  feed_ref: 'Codice non valido: usa il codice del corso (per esempio 0880).',
  label: 'Nome non valido (1-160 caratteri).',
  building_name: "Nome dell'edificio troppo lungo (massimo 100 caratteri).",
  source_url: 'Indirizzo non valido: solo pagine https su unical.it.',
  floor: 'Piano non valido.',
  floor_count: 'Numero di piani non valido (1-15).',
  base_level: 'Dislivello non valido (0-12).',
});

export const REPORT_MESSAGES = Object.freeze({
  not_found: 'Aula non trovata negli orari caricati.',
  forbidden: 'Accedi con la mail Unical per fare segnalazioni.',
  invalid: 'Segnalazione non valida.',
  accounts_disabled: 'Le segnalazioni non sono attive in questo momento.',
});

export function messageFor(code, overrides = {}, fallback = 'Operazione non riuscita.') {
  if (typeof code !== 'string') return fallback;
  if (Object.hasOwn(overrides, code)) return overrides[code];
  if (Object.hasOwn(MESSAGES, code)) return MESSAGES[code];
  return fallback;
}
