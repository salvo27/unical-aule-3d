# Aule Unical

Mappa 3D semplificata del campus Unical con le aule libere e occupate, ricavate dagli orari pubblicati sul University Planner.

È un progetto studentesco **non ufficiale**: non è un servizio dell'Università della Calabria e non è collegato all'Ateneo.
- **Mappa:** cliccando su un cubo si vedono le sue aule piano per piano.
- **Scheda dell'aula:** posti, servizi, lezioni del giorno o della settimana e disservizi segnalati.
- **Ricerca:** trova aule, cubi, insegnamenti, docenti e mense, con i filtri "libere adesso", "libere per almeno N ore" e "posti minimi".
- **Segnalazioni:** chi accede con la mail Unical può segnalare un'aula occupata o chiusa, una lezione non tenuta o un disservizio. Moderatori e admin le controllano dall'area admin.
- **Posizione:** il bottone in alto a destra mostra dove sei sulla mappa. La posizione resta nel browser e non viene mai mandata al server.

## Avvio in locale

Servono Node 20.10 o successivo, Docker (anche con Colima) e la CLI di Supabase.

```bash
npm install
cp .env.example .env
```

Avvia Supabase in locale. Il primo avvio scarica le immagini Docker e applica le migration.

```bash
colima start
```

```bash
supabase start
```

Poi metti in `.env` l'URL e la chiave pubblica (publishable) che mostra `supabase status`:

```bash
supabase status -o env
```

- `SUPABASE_URL` è `API_URL` (in locale `http://127.0.0.1:54321`);
- `SUPABASE_PUBLISHABLE_KEY` è `PUBLISHABLE_KEY`, la chiave che inizia con `sb_publishable_`;
- la chiave segreta (`sb_secret_`) non serve e il server la rifiuta.

Infine:

```bash
npm run dev
```

La mappa è su http://localhost:3010 (porta in `.env`), l'admin su `/admin`. In locale le mail di accesso non partono davvero: si leggono in Mailpit, su http://127.0.0.1:54324.

### Il primo admin

1. Accedi una volta dalla mappa con la tua mail Unical, così l'account viene creato.
2. Dai il ruolo dal database: in locale con il comando qui sotto, online dall'SQL editor della dashboard Supabase.
3. Gli altri ruoli li assegni dall'area admin, sezione "Utenti e ruoli".

```bash
docker exec supabase_db_unical-aule-3d psql -U postgres -c "insert into public.user_roles (user_id, role) select id, 'admin' from auth.users where email = 'TUA_MAIL@unical.it' on conflict (user_id) do update set role = 'admin';"
```

### Altri comandi

- `npm test`: compila ed esegue i test del server;
- `supabase test db`: esegue i test del database (pgTAP);
- `npm run sync`: scarica subito gli orari, come la sincronizzazione automatica;
- `npm run discover`: legge le pagine dei dipartimenti e mostra i calendari nuovi. Con `-- --apply` li aggiunge, con `-- --relabel` rinomina quelli presenti con il titolo del Planner;
- `npm run import-campus`: rigenera `public/data/campus.geojson` dalla mappa ufficiale e da OpenStreetMap.

## Da dove vengono i dati

- **Orari e aule**: calendari pubblici del University Planner (`unical.prod.up.cineca.it`).
  - Per ogni lezione si salvano solo titolo, orario, stato, tipo, corso, anno, docenti e aula.
  - Il Planner non indica il piano delle aule: si imposta dall'admin.
  - I dati restano dell'Università della Calabria. Il server li scarica due volte al giorno, con al massimo 3 richieste insieme, e si presenta con uno User-Agent che indica questo repository.
- **Edifici**: mappa ufficiale del campus Unical (Google My Maps), esportata in KML. I diritti restano all'Università della Calabria.
- **Ponte Pietro Bucci, edificio TechNest, posizione di Bar La Cascina e Mensa Vermicelli**: © OpenStreetMap contributors, licenza ODbL 1.0 (https://www.openstreetmap.org/copyright).
- **Mappa di base**: OpenFreeMap, © OpenMapTiles, dati © OpenStreetMap contributors.
- **Orari delle mense**: pagine ufficiali del servizio mensa Unical, verificati il 9 novembre 2026 (`public/data/canteens.json`). Gli orari della Maisonnettes Senior sono indicati da chi frequenta il campus.

## Come lavora

- **Download degli orari:** il server scarica i calendari attivi alle ore indicate in `SYNC_HOURS` (fuso di Roma), all'avvio se i dati sono vecchi, e quando l'admin preme "Aggiorna adesso". I dati coprono da 7 giorni fa a 15 giorni avanti.
- **Stato di un'aula:**
  - **occupata** fino alla fine del blocco di lezioni consecutive;
  - **libera** fino alla prossima lezione del giorno;
  - **grigia** se uno dei calendari che la usano non è stato scaricato da più di `STALE_AFTER_HOURS` ore, o se il browser non riesce ad aggiornare i dati da 5 minuti.
- **Segnalazioni:** il server rilegge ogni minuto quelle approvate.
  - "Occupata" e "chiusa" approvate rendono l'aula occupata per il loro intervallo.
  - "Occupata" compare anche senza revisione se la segnalano almeno 3 persone diverse nello stesso momento.
  - Una "lezione non tenuta" approvata libera l'aula per la durata della lezione.
  - I disservizi approvati compaiono nella scheda dell'aula.

## Account, ruoli e segnalazioni

- **Accesso:** solo con un link mandato alla mail Unical (`@unical.it` o `@studenti.unical.it`), senza password. Il filtro sui domini è un hook del database: tutto è rifiutato tranne i due domini esatti.
- **Ruoli:** `student` (di default), `moderator`, `admin`, nella tabella `public.user_roles`.
  - Si cambiano solo con la funzione `set_user_role`, che possono usare solo gli admin.
  - Nessuno può cambiare il proprio ruolo.
- **Segnalazioni:**
  - si scrivono solo tramite funzioni SQL, con limiti di tempo per tipo, al massimo 20 al giorno per utente e niente doppioni;
  - le decidono moderatori e admin, mai sulle proprie, e una decisione non si cambia;
  - la mappa riceve solo dati aggregati, senza nessuna informazione sugli utenti.
- **Il server Node non vede password e non verifica i token da solo:** passa il token dell'utente alle funzioni del database, e Supabase lo controlla.

## Secure by Design

- **Domain primitives** (`src/domain/primitives.ts`, `src/domain/requests.ts`): id dei calendari e delle aule, piani, date, testo di ricerca, URL delle pagine sorgente, nomi e richieste. Ogni valore viene controllato in quest'ordine: dimensione, caratteri, sintassi, semantica.
- **Il database applica le regole da sé:**
  - la tabella delle richieste è chiusa a tutti e si passa solo dalle funzioni;
  - vincoli CHECK su finestre e categorie;
  - permessi assegnati in modo esplicito;
  - test pgTAP in `supabase/tests/database`.
- **Fail closed:**
  - un calendario che fallisce o risponde in modo anomalo tiene i dati buoni precedenti;
  - uno stato sconosciuto del Planner tiene l'aula occupata;
  - i dati vecchi diventano grigi, mai verdi;
  - le segnalazioni possono solo rendere un'aula occupata, tranne la "lezione non tenuta" approvata;
  - senza Supabase configurato, account e admin restano spenti;
  - una configurazione admin corrotta blocca l'avvio invece di essere sovrascritta.
- **Scritture atomiche** (`src/store/files.ts`) e transizioni di stato esplicite (`review_request`: solo da "in attesa" ad "approvata" o "respinta").
- **Errori:** codici chiusi verso il client. I log contengono solo id, conteggi e codici, senza mail, nomi di docenti né contenuto delle richieste.
- **Browser:**
  - CSP senza script inline;
  - testo inserito solo con `textContent`;
  - file statici serviti da una lista chiusa caricata all'avvio.
- **Test** (`test/`, `supabase/tests/`): casi normali, limite, non validi ed estremi, compresi i percorsi HTTP, i ruoli e i tentativi di abuso.

## Limiti noti

- "Libera" vuol dire "nessuna lezione pubblicata sul Planner": esami fuori calendario, seminari o aule chiuse possono non comparire, a meno che qualcuno non li segnali.
- Le aule che non compaiono in nessun calendario caricato non sono sulla mappa. CTC, DIAm, DiScAG e DiSU pubblicano gli orari solo in PDF o Excel; DIMES ha un sito suo.
- Numero di piani e dislivello dei cubi sono stimati (5 piani, dislivello 0) finché non si impostano dall'admin.
- Il bar del TAU è posizionato sull'edificio del TAU: la sua posizione esatta non è in nessuna delle mappe usate.

## Online

1. **Progetto Supabase.**
   - Crea il progetto e applica le migration:
     ```bash
     supabase link --project-ref <ref>
     ```
     ```bash
     supabase db push
     ```
   - Nella dashboard, in Authentication, attiva i due hook ("Before User Created" con `public.hook_before_user_created`, "Custom Access Token" con `public.custom_access_token_hook`).
   - Attiva la conferma della mail e imposta Site URL e Redirect URLs sul dominio dell'app (anche `/admin`).
2. **SMTP proprio:** quello incluso in Supabase manda poche mail l'ora e solo ai membri del team.
3. **Server Node:** imposta `NODE_ENV=production`, `HOST=0.0.0.0`, `SUPABASE_URL` in https, `SUPABASE_PUBLISHABLE_KEY` e un `DATA_DIR` su disco persistente: lì stanno la configurazione dei calendari e gli orari scaricati.
4. **SSO di Ateneo (in seguito):** con l'Area ICT Unical si può registrare l'app sul proxy SAML di Ateneo. Serve il piano Pro di Supabase.

## Licenza

Il codice è distribuito con licenza [MIT](LICENSE). I dati di terzi contenuti nel repository (mappa del campus, elementi di OpenStreetMap, orari e link dei luoghi, calendari) non sono coperti dalla licenza MIT: vedi [DATA-LICENSE.md](DATA-LICENSE.md).

Le librerie servite al browser (MapLibre, supabase-js e le loro dipendenze) hanno le loro licenze, raccolte durante la build in `dist/licenses.txt` e linkate nella mappa ("Licenze").
