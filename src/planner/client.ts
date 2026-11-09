import { PLANNER_HOST, type CalendarId } from '../domain/primitives.js';
import { PlannerError } from './parse.js';
import { USER_AGENT } from '../user-agent.js';

export interface PlannerApi {
  clientId(): Promise<string>;
  calendarEvents(calendar: CalendarId, clientId: string, from: number, to: number): Promise<unknown>;
  calendarInfo(calendar: CalendarId, clientId: string): Promise<unknown>;
}

interface Options {
  baseUrl?: string;
  timeoutMs?: number;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new PlannerError('too_large');
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new PlannerError('too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createPlannerApi(options: Options = {}): PlannerApi {
  const baseUrl = options.baseUrl ?? `https://${PLANNER_HOST}`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxBytes = options.maxBytes ?? 25_000_000;
  const doFetch = options.fetchImpl ?? fetch;

  async function request(path: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        ...init,
        redirect: 'error',
        headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      throw new PlannerError(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network');
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new PlannerError('http_status');
    }
    let body: string;
    try {
      body = await readLimited(res, maxBytes);
    } catch (err) {
      if (err instanceof PlannerError) throw err;
      throw new PlannerError('network');
    }
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new PlannerError('bad_json');
    }
  }

  return {
    async clientId() {
      const data = await request(`/api/Clienti/cercaPerDominio?dominio=${encodeURIComponent(PLANNER_HOST)}`, { method: 'GET' });
      const id = typeof data === 'object' && data !== null ? (data as Record<string, unknown>).id : undefined;
      if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) throw new PlannerError('client_id');
      return id;
    },
    calendarInfo(calendar, clientId) {
      return request('/api/LinkCalendario/searchCalendarioPubblico', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ linkCalendarioId: calendar, filter: { clienteId: clientId } }),
      });
    },
    calendarEvents(calendar, clientId, from, to) {
      return request('/api/Impegni/getImpegniCalendarioPubblico', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mostraImpegniAnnullati: true,
          mostraIndisponibilitaTotali: false,
          linkCalendarioId: calendar,
          clienteId: clientId,
          pianificazioneTemplate: false,
          dataInizio: new Date(from).toISOString(),
          dataFine: new Date(to).toISOString(),
        }),
      });
    },
  };
}
