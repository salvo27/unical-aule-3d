// Synthetic Planner data: same shape as the real API, invented names.
export const ROOM_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
export const ROOM_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
export const CAL_1 = '111111111111111111111111';
export const CAL_2 = '222222222222222222222222';

let counter = 0;
function nextId(): string {
  counter += 1;
  return counter.toString(16).padStart(24, 'c');
}

export interface FakeEventOptions {
  id?: string;
  start: string;
  end: string;
  title?: string;
  room?: string | null;
  roomName?: string;
  building?: string;
  stato?: string;
  capacity?: number;
}

export function fakeEvent(o: FakeEventOptions): Record<string, unknown> {
  const roomId = o.room === undefined ? ROOM_A : o.room;
  return {
    id: o.id ?? nextId(),
    nome: o.title ?? 'CORSO DI PROVA',
    dataInizio: o.start,
    dataFine: o.end,
    stato: o.stato ?? 'P',
    annoCorso: 2,
    tipoEvento: { codice: 'AD', descrizione: "ATTIVITA' DIDATTICA" },
    corsi: [{ codice: '0001', descrizione: 'CORSO DI LAUREA DI PROVA' }],
    docenti: [{ id: 'x', nome: 'MARIO', cognome: 'ROSSI' }],
    risorse:
      roomId === null
        ? [{ docenteId: 'x' }]
        : [
            {
              aulaId: roomId,
              aula: {
                id: roomId,
                codice: 'AU_0001',
                descrizione: o.roomName ?? 'B6',
                capienza: o.capacity ?? 40,
                capienzaEffettiva: 22,
                piano: null,
                edificio: { id: 'e', codice: 'ED_1', descrizione: o.building ?? 'Cubo 4D' },
                serviziAula: [{ descrizione: 'Rete' }, { descrizione: 'Proiettore' }],
              },
            },
            { docenteId: 'x' },
          ],
  };
}
