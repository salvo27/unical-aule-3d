# Aule Unical

Mappa 3D semplificata del campus Unical con le aule libere e occupate, ricavate dagli orari pubblicati dall'Ateneo: i calendari del University Planner e i file Excel del DIAm.

È un progetto studentesco **non ufficiale**: non è un servizio dell'Università della Calabria e non è collegato all'Ateneo.

- **Mappa:** cliccando su un cubo si vedono le sue aule piano per piano.
- **Scheda dell'aula:** posti, servizi, lezioni del giorno o della settimana e disservizi segnalati.
- **Ricerca:** trova aule, cubi, insegnamenti e mense, con i filtri "libere adesso", "libere per almeno N ore" e "posti minimi".
- **Segnalazioni:** al lancio sono spente. Quando gli account saranno aperti a tutti, chi accede con la mail Unical potrà segnalare un'aula occupata o chiusa, una lezione non tenuta o un disservizio. Moderatori e admin le controlleranno dall'area admin.
- **Posizione:** il bottone in alto a destra mostra dove sei sulla mappa. La posizione resta nel browser e non viene mai mandata al server.

## Come funziona

- **Sito:** Cloudflare Pages (piano Free), progetto `aule-unical`, su https://aule-unical.pages.dev.
  - Pages serve da sé i file statici. Solo le richieste a `/api/*` passano dal Worker (`site/_worker.js`, il codice di `src/worker/`): lo decide `_routes.json`. Il Worker risponde a tre sole route: `/api/status`, `/api/rooms/:id` e `/api/search`.
  - Il Worker controlla i parametri, chiama una funzione del database con la chiave pubblica (publishable) di Supabase e rimanda la risposta così com'è, con una cache di 60 secondi.
  - Non ha segreti. Se Supabase non risponde, dà errore e dopo pochi minuti la mappa diventa grigia: mai dati vecchi.
  - `scripts/build-site.ts` prepara la cartella `site/`: i file di `public/`, le librerie in `vendor/`, le intestazioni di sicurezza (`_headers`), la configurazione del browser (`client-config.json`, più `admin-config.json` per `/admin`), `_routes.json` e `_worker.js`, un solo modulo creato con esbuild da `src/worker/index.ts`. Senza `public/404.html` la build si ferma: Pages risponderebbe con la mappa a ogni indirizzo sconosciuto.
  - Si pubblica solo `main`. Le anteprime di altri branch prendono `env.preview` di `wrangler.json`: nessun valore di Supabase e `ACCOUNTS` a `off`, quindi le loro `/api` rispondono 503.
- **Database:** Supabase (Postgres, piano Free) tiene orari, aule e configurazione, e calcola in SQL lo stato delle aule e la ricerca (`supabase/migrations/`).
- **Download degli orari:** GitHub Actions, workflow `sync` (`.github/workflows/sync.yml`).
  - Scarica gli orari alle 6:17 e alle 13:17 (ora di Roma) e quando un admin preme "Aggiorna adesso".
  - Ogni 15 minuti un controllo senza segreti chiede al database se c'è una richiesta o se un orario è stato saltato. Una richiesta parte quindi entro circa 20 minuti. Il controllo tiene anche attivo il progetto Supabase.
  - "Cerca calendari" funziona allo stesso modo e parte da solo ogni lunedì alle 5:47: legge le pagine dei dipartimenti e propone i calendari nuovi, che un admin conferma.
  - Scrive nel database solo con il ruolo `aule_sync`, che può soltanto chiamare 8 funzioni che controllano tutto quello che ricevono.
- **Fonti degli orari:** i calendari pubblici del University Planner e i file Excel del DIAm. Il codice ha un posto pronto per altre fonti (`src/sources/`).
- **Account:** `ACCOUNTS` in `wrangler.json` (`vars`) decide chi può accedere. Vale `off`, `admin` oppure `all`. Al lancio vale `admin`.
  - `admin`: si accede solo da `/admin` e solo come admin. Sulla mappa non c'è nessun accesso: niente "Accedi", segnalazioni, "Le mie segnalazioni" o link all'area admin.
  - `all`: anche la mappa ha accesso e segnalazioni, per chiunque abbia la mail Unical.
  - `off`: nessun accesso. La build non copia `admin.html`, `admin.js` e `vendor/supabase.js` e non scrive `admin-config.json`, quindi `/admin` dà 404. Se `ACCOUNTS` manca o è vuoto vale `off`.
  - Con `admin` e `all` la build scrive `site/admin-config.json`, con l'indirizzo e la chiave pubblica di Supabase: lo legge solo `/admin`. La mappa legge `client-config.json`, che ha i valori di Supabase solo con `all`. Lo stesso vale per la CSP: finché `ACCOUNTS` non vale `all`, solo `/admin` può chiamare Supabase.
  - La vecchia variabile `ACCOUNTS_ENABLED` non esiste più. Se è ancora in `.dev.vars` o in `wrangler.json`, la build si ferma apposta con l'errore `ACCOUNTS_ENABLED`, così una configurazione vecchia non cambia gli accessi di nascosto. Toglila e metti `ACCOUNTS`.
  - Nel browser supabase-js chiama direttamente le funzioni per utenti e admin con il token dell'utente. Il Worker non vede mai i token.
  - Il database controlla da sé: `accounts_mode` in `aule.settings` vale `admin` (il default), `all` oppure `off`. Con `admin` l'hook del token rifiuta chiunque non sia admin, anche chi chiama Supabase direttamente.
- **Stato di un'aula:**
  - **occupata** fino alla fine del blocco di lezioni consecutive (pause fino a 15 minuti comprese);
  - **libera** fino alla prossima lezione del giorno;
  - **grigia** se uno dei calendari che la usano non è stato scaricato da più di 30 ore (`stale_after` in `aule.settings`), se i dati non coprono il momento attuale, o se il browser non riesce ad aggiornare i dati da 5 minuti.
  - I dati coprono da 7 giorni fa a 15 giorni avanti.
- **Segnalazioni:** il database le legge a ogni richiesta, quindi sulla mappa compaiono entro un minuto.
  - "Occupata" e "chiusa" approvate rendono l'aula occupata per il loro intervallo.
  - "Occupata" compare anche senza revisione se la segnalano almeno 3 persone diverse nello stesso momento.
  - Una "lezione non tenuta" approvata libera l'aula per la durata della lezione.
  - I disservizi approvati compaiono nella scheda dell'aula.

## Avvio in locale

Servono Node 24, Docker (anche con Colima) e la CLI di Supabase. Con nvm, `nvm use` sceglie la versione giusta da `.nvmrc`.

```bash
nvm use
```

```bash
npm install
```

Avvia Supabase in locale. Il primo avvio scarica le immagini Docker e applica le migration.

```bash
colima start
```

```bash
supabase start
```

Crea `.dev.vars` da `.dev.vars.example` e metti la chiave pubblica che mostra `supabase status`:

```bash
cp .dev.vars.example .dev.vars
```

```bash
supabase status -o env
```

- `SUPABASE_URL` è già `http://127.0.0.1:54321` (`API_URL`);
- `SUPABASE_PUBLISHABLE_KEY` è `PUBLISHABLE_KEY`, la chiave che inizia con `sb_publishable_`;
- la chiave segreta (`sb_secret_`) non serve e la build la rifiuta;
- `ACCOUNTS=admin` è come online al lancio: si accede solo da `/admin` e solo come admin. Con `all` la mappa mostra anche accesso e segnalazioni (per far entrare gli studenti metti `all` anche in `accounts_mode`, vedi "Il primo admin"). Con `off` non c'è nessun accesso e `/admin` non esiste;
- un `.dev.vars` vecchio con `ACCOUNTS_ENABLED` fa fermare la build con l'errore `ACCOUNTS_ENABLED`: togli quella riga e metti `ACCOUNTS=admin`, oppure ricopia `.dev.vars.example`.

Infine:

```bash
npm run dev
```

- `npm run dev` compila, prepara `site/` con i valori di `.dev.vars` e avvia `wrangler pages dev`. La mappa è su http://localhost:3010, l'admin su `/admin`.
- Dopo una modifica in `public/`, in un altro terminale `npm run dev:site` aggiorna `site/` in un secondo, mentre `wrangler pages dev` resta acceso.
- Dopo una modifica di `ACCOUNTS` o di `.dev.vars` ferma `npm run dev` e rilancialo: `wrangler pages dev` legge `_headers`, e quindi la CSP, solo all'avvio.
- In locale le mail di accesso non partono davvero: si leggono in Mailpit, su http://127.0.0.1:54324.
- Solo in locale `?tema=attuale` mostra il vecchio aspetto e `?confronto=1` i selettori di tema e carattere. Online vengono ignorati.

### Orari in locale

Il database locale parte con calendari e pagine dei dipartimenti, ma senza orari. Per scaricarli:

1. Dai al ruolo `aule_sync` una password solo locale (mai quella del cloud):
   ```bash
   docker exec supabase_db_unical-aule-3d psql -U postgres -c "alter role aule_sync login password 'scegli-una-password-locale'"
   ```
2. Crea `.env` da `.env.example` e metti la stessa password in `SYNC_DB_PASSWORD`.
3. `npm run sync:db` scarica gli orari dal Planner (circa 190 calendari, 3 richieste alla volta) e i file del DIAm. `npm run discover:db` legge le pagine dei dipartimenti e propone i calendari nuovi. Tra due sync servono almeno 15 minuti.
4. Alla fine togli la password:
   ```bash
   docker exec supabase_db_unical-aule-3d psql -U postgres -c "alter role aule_sync nologin password null"
   ```

Dopo `supabase db reset --local` (o `npm run db:reset`) la password locale va ridata.

### Il primo admin

Con `ACCOUNTS=admin` si accede solo da `/admin` e solo come admin: il database rifiuta l'accesso a chi non ha il ruolo. Online le registrazioni sono spente, quindi l'account si crea con un invito. In locale si fa allo stesso modo.

L'admin può usare la mail Unical oppure un altro indirizzo, per esempio Gmail. Un indirizzo fuori Unical vale solo se sta nella tabella `aule.admin_emails` e solo per un admin: come studente o moderatore viene rifiutato. La tabella si riempie solo dall'SQL editor della dashboard (in locale con psql). Nessun ruolo dell'API può leggerla o scriverla, e l'indirizzo vero non va mai nel repository.

1. Solo per un indirizzo fuori Unical: aggiungilo alla lista. Scrivilo tutto in minuscolo e senza `+`, esattamente come nell'invito. `nome@example.org` è un esempio: metti il tuo.
   ```sql
   insert into aule.admin_emails (email) values ('nome@example.org');
   ```
2. Nella dashboard di Supabase (in locale Supabase Studio, http://127.0.0.1:54323): Authentication, Users, Add user, Send invitation. Scrivi lo stesso indirizzo e premi Invite user. Non aprire ancora il link dell'invito: prima serve il ruolo.
3. Dai il ruolo di admin, sempre con lo stesso indirizzo:
   ```sql
   insert into public.user_roles (user_id, role) select id, 'admin' from auth.users where email = 'nome@example.org' on conflict (user_id) do update set role = 'admin';
   ```
4. Ora apri il link dell'invito (in locale lo trovi in Mailpit): conferma la tua mail. Il link apre la mappa, senza accesso: è normale. Poi vai su `/admin` e accedi con il link che arriva alla tua mail (anche Gmail o un altro indirizzo fuori Unical, se è nella lista).
5. Gli altri ruoli si assegnano dall'area admin, sezione "Utenti e ruoli".

In locale i comandi SQL si danno con psql, per esempio:

```bash
docker exec supabase_db_unical-aule-3d psql -U postgres -c "insert into aule.admin_emails (email) values ('nome@example.org');"
```

Per togliere un indirizzo dalla lista: `delete from aule.admin_emails where email = 'nome@example.org';`. Da quel momento le funzioni admin lo rifiutano, e il rinnovo successivo del token fallisce (di solito entro un'ora).

La modalità del database è `admin` di default. Per cambiarla (online dall'SQL editor, in locale con psql) usa `all`, `admin` oppure `off`:

```bash
docker exec supabase_db_unical-aule-3d psql -U postgres -c "update aule.settings set accounts_mode = 'all';"
```

### Configurazione dall'SQL editor

Il modo normale per cambiare la configurazione è l'area admin (`/admin`). Se non puoi usarla, per esempio con `ACCOUNTS=off`, puoi fare tutto dall'SQL editor della dashboard Supabase, o in locale con psql, con le funzioni `aule.config_*`. Controllano i valori come l'area admin e scrivono in una sola transazione. Sostituiscono `discover --apply` e `discover --relabel` della versione Node.

```sql
-- stato generale: ultimo sync, calendari, proposte, aule
select jsonb_pretty(aule.config_overview());

-- aggiungere un calendario del Planner: l'id è la parte finale del link pubblico
select aule.config_add_calendar('111111111111111111111111', 'DIP · Corso di prova 1° anno', null);

-- rinominarlo (prima: discover --relabel)
select aule.config_rename_calendar('111111111111111111111111', 'DIP · Corso di prova, primo anno');

-- spegnerlo (i dati restano fino al prossimo sync) o toglierlo subito con i suoi orari
select aule.config_set_calendar_active('111111111111111111111111', false);
select aule.config_remove_calendar('111111111111111111111111');

-- i fogli del DIAm arrivano solo da config/diam.json: si possono spegnere, riaccendere e rinominare, non aggiungere né togliere

-- pagine lette da "Cerca calendari": tutte, in ordine, al posto delle precedenti
select aule.config_set_sources(array[
  'https://example.unical.it/didattica/orari',
  'https://example.unical.it/altra/pagina'
]);

-- calendari proposti dall'ultima ricerca (prima: discover --apply), da aggiungere con config_add_calendar
select jsonb_pretty(aule.config_overview() -> 'proposals');

-- chiedere un aggiornamento o una ricerca: parte entro circa 20 minuti
select aule.config_request_run('sync', null);
select aule.config_request_run('discover', null);
```

Per piani delle aule, forme dei cubi e collegamenti tra edifici ci sono `aule.config_set_room_floor(id_aula, piano, null)`, `aule.config_set_building_shape(chiave, piani, dislivello, null)` e `aule.config_link_building(nome_planner, chiave, null)`. Con `null` al posto del piano o della chiave si torna al valore stimato. Per un aggiornamento subito c'è anche Actions, workflow `sync`, Run workflow.

### Altri comandi

- `npm test`: compila ed esegue i test TypeScript (`test/`);
- `npm run typecheck:worker`: controlla il Worker (`src/worker/`) con i tipi di Cloudflare;
- `npm run build:site`: prepara `site/` per la produzione con i valori di `wrangler.json`, senza pubblicare nulla;
- `npm run db:reset`: ricrea il database locale dalle migration;
- `npm run test:db`: esegue i test del database (pgTAP, `supabase/tests/database`);
- `npm run gen:reference`: rigenera la migration dei dati di riferimento (`supabase/migrations/20261110090100_reference_data.sql`) da `public/data/campus.geojson` e `config/seed.json`. Serve solo prima del primo `supabase db push`;
- `npm run import-campus`: rigenera `public/data/campus.geojson` dalla mappa ufficiale e da OpenStreetMap. Poi crea una NUOVA migration con i soli edifici, senza mai modificare una migration già applicata:
  ```bash
  node dist/scripts/gen-reference-sql.js supabase/migrations/AAAAMMGGhhmmss_campus.sql --campus-only
  ```
  `test/reference-data.test.ts` fallisce se l'ultima migration con gli edifici non corrisponde a `campus.geojson`;
- `npm run probe:planner`: prova a scaricare 3 calendari dal Planner, senza database.

## Da dove vengono i dati

- **Orari e aule**: calendari pubblici del University Planner (`unical.prod.up.cineca.it`) e i due file Excel del Dipartimento di Ingegneria dell'Ambiente (DIAm) dell'Università della Calabria, linkati dalla pagina [Orario delle lezioni](https://diam.unical.it/didattica/iscriversi-studiare-laurearsi/orario-delle-lezioni/). La mappa cita entrambe le fonti.
  - Li scarica GitHub Actions e li salva nel database Supabase: mai nel repository, nei log o negli artifact.
  - Per ogni lezione si salvano solo titolo, orario, stato, tipo, corso, anno e aula. Per ora i nomi dei docenti non si salvano, per nessuna fonte.
  - Per gli impegni che non sono lezioni (prenotazioni delle aule, esami, riunioni) si salvano solo il tipo ("Prenotazione", "Esame", "Altro impegno") e l'orario, mai il titolo libero, i docenti o i corsi, che spesso contengono nomi di persone. Un tipo sconosciuto vale "Altro impegno" e tiene l'aula occupata.
  - I file del DIAm danno un orario settimanale tipo. Date dei semestri e giorni senza lezioni stanno in `config/diam.json` e si aggiornano a mano una volta l'anno. Tra il primo e il secondo semestre i file non danno lezioni, quindi le aule del DIAm seguono solo le altre fonti. Fuori dalle date dell'anno le aule del DIAm diventano grigie finché le date non vengono aggiornate.
  - Il Planner non indica il piano delle aule: si imposta dall'admin.
  - I dati restano dell'Università della Calabria. Il sync gira due volte al giorno, più quando un admin lo chiede, con al massimo 3 richieste insieme al Planner, e si presenta con uno User-Agent che indica questo repository. "Cerca calendari" fa una pausa tra una pagina e l'altra.
- **Configurazione**: calendari, pagine dei dipartimenti, piani e collegamenti tra edifici stanno nel database. `config/seed.json` è solo lo storico della prima configurazione, da cui è stata generata la migration dei dati di riferimento.
- **Edifici**: mappa ufficiale del campus Unical (Google My Maps), esportata in KML. I diritti restano all'Università della Calabria.
- **Ponte Pietro Bucci, edificio TechNest, posizione di Bar La Cascina e Mensa Vermicelli**: © OpenStreetMap contributors, licenza ODbL 1.0 (https://www.openstreetmap.org/copyright).
- **Mappa di base**: OpenFreeMap, © OpenMapTiles, dati © OpenStreetMap contributors.
- **Orari delle mense**: pagine ufficiali del servizio mensa Unical, verificati il 9 novembre 2026 (`public/data/canteens.json`). Gli orari della Maisonnettes Senior sono indicati da chi frequenta il campus.
- **Carattere**: Atkinson Hyperlegible Next, licenza SIL Open Font License 1.1 (`public/fonts/`).

## Account, ruoli e segnalazioni

- **Accesso:** solo con un link mandato alla mail, senza password. Il filtro è negli hook del database: passano solo i due domini esatti `@unical.it` e `@studenti.unical.it`, più gli indirizzi degli admin elencati in `aule.admin_emails`.
- **Admin con un indirizzo fuori Unical:** l'indirizzo deve stare in `aule.admin_emails`, scritto esatto (minuscolo, senza varianti con `+`), e l'utente deve avere il ruolo admin, in ogni modalità. Il controllo si ripete a ogni rinnovo del token: togliendo l'indirizzo dalla lista l'accesso si chiude. Come studente o moderatore lo stesso indirizzo non vale. La lista sta solo nel database del cloud, mai nel repository, e nessun ruolo dell'API la legge.
- **Al lancio solo gli admin:** `ACCOUNTS` e `accounts_mode` valgono `admin`. Si accede solo da `/admin`, e l'hook del token rifiuta chiunque non sia admin. Le registrazioni sono spente: l'account dell'admin si crea con un invito dalla dashboard (vedi "Il primo admin").
- **Più avanti per tutti:** con `ACCOUNTS` e `accounts_mode` a `all` (e un fornitore SMTP) studenti e moderatori accedono anche dalla mappa (vedi "Dopo il lancio").
- **Ruoli:** `student` (di default), `moderator`, `admin`, nella tabella `public.user_roles`.
  - Si cambiano solo con la funzione `set_user_role`, che possono usare solo gli admin.
  - Nessuno può cambiare il proprio ruolo.
- **Segnalazioni:**
  - si scrivono solo tramite funzioni SQL (`report_room`), che calcolano da sé l'intervallo di ogni tipo, con al massimo 20 al giorno per utente e niente doppioni;
  - le decidono moderatori e admin, mai sulle proprie, e una decisione non si cambia;
  - la mappa riceve solo dati aggregati, senza nessuna informazione sugli utenti.
- **Il Worker non vede password né token:** il browser parla con Supabase direttamente, e Supabase controlla il token.

## Secure by Design

- **Domain primitives:** id dei calendari e delle aule, piani, date, testo di ricerca, URL delle pagine sorgente e nomi sono controllati in quest'ordine: dimensione, caratteri, sintassi, semantica.
  - In TypeScript (`src/domain/primitives.ts`, `src/domain/ids.ts`) nel Worker e nel sync.
  - Nel database con DOMAIN e vincoli CHECK che rispecchiano gli stessi controlli: ogni funzione ricontrolla i suoi argomenti.
- **Privilegi minimi:**
  - ruoli Postgres separati: `aule_reader` (solo lettura), `aule_ingest` (scrive gli orari), `aule_config` (configurazione e admin), `aule_sync` (l'unico con accesso, per GitHub Actions: può solo chiamare le 8 funzioni dello schema `aule_sync`, che la Data API non espone);
  - i permessi di default sono revocati per primi e ogni permesso è dato in modo esplicito; il test `09_grants` elenca ogni funzione con i suoi permessi esatti;
  - RLS attiva su ogni tabella; gli orari stanno nello schema `aule`, non esposto;
  - funzioni `SECURITY DEFINER` con `search_path` vuoto e nessun SQL dinamico.
- **Difesa in profondità sugli account:** `ACCOUNTS` toglie i punti di accesso dalle pagine; il database chiude comunque la porta: con `accounts_mode` a `admin` l'hook del token rifiuta chi non è admin; con `off`, o senza un valore valido, rifiuta tutti. Un indirizzo fuori Unical passa solo se è in `aule.admin_emails` e ha il ruolo admin. Segnalazioni e ruoli restano protetti dalle loro funzioni in ogni modalità.
- **Fail closed:**
  - un calendario che fallisce o risponde in modo anomalo tiene i dati buoni precedenti; lo stesso se scarta troppe voci (più di 10 e più del 20%);
  - un sync non plausibile (tutto vuoto o meno della metà delle lezioni di prima) viene interrotto e restano i dati di prima;
  - uno stato sconosciuto del Planner, o un impegno di tipo sconosciuto, tiene l'aula occupata;
  - un impegno lungo più di 12 ore (per esempio un'aula chiusa per più giorni) viene diviso in pezzi e tiene l'aula occupata per tutto il tempo;
  - i dati vecchi diventano grigi, mai verdi; se Supabase non risponde il Worker dà 503 e la mappa diventa grigia;
  - le segnalazioni possono solo rendere un'aula occupata, tranne la "lezione non tenuta" approvata;
  - senza i valori in `wrangler.json` il Worker risponde 503 e la build del sito si ferma; la build si ferma anche con la vecchia variabile `ACCOUNTS_ENABLED`.
- **Scritture atomiche e transizioni esplicite:** ogni sync si chiude in una sola transazione, quindi chi legge vede tutti i dati vecchi o tutti i nuovi. Un sync passa solo da "aperto" a "finito", "abbandonato" o "interrotto"; una richiesta solo da "in attesa" ad "approvata" o "respinta".
- **Errori:** codici chiusi. Gli errori di Postgres sono tradotti in una lista fissa prima di arrivare ai log o al browser. I log contengono solo eventi, id, conteggi e codici, senza mail, nomi di docenti, titoli né contenuto delle richieste.
- **Segreti:**
  - il Worker usa solo la chiave pubblica, accetta solo GET, non inoltra mai token, cookie o indirizzi del client e non copia le intestazioni di Supabase;
  - la password di `aule_sync` sta solo nell'environment `sync` di GitHub, limitato a `main`, e solo nell'ultimo passo del job; mai in un file;
  - il sync si collega con TLS verify-full sul certificato di `config/supabase-ca.crt`: senza quel file rifiuta ogni host che non sia locale;
  - i workflow usano azioni fissate per SHA, permessi di sola lettura, `npm ci --ignore-scripts`, niente cache e niente artifact; i comandi di sync rifiutano `NODE_OPTIONS` e `NODE_PATH`.
- **Meno dati possibile:** le funzioni restituiscono solo quello che serve allo schermo; degli impegni che non sono lezioni restano solo tipo e orario; finché `ACCOUNTS` non vale `all` la mappa non conosce nemmeno l'indirizzo di Supabase, e con `off` il sito non contiene supabase-js.
- **Browser:**
  - CSP senza script inline, `connect-src` limitato al sito e alle tile della mappa; l'origine Supabase c'è solo dove serve: in `/admin`, e sulla mappa solo con `ACCOUNTS` a `all`;
  - testo inserito solo con `textContent`.
- **Test:** pgTAP in `supabase/tests/database` e test Node in `test/`, eseguiti da GitHub Actions (`.github/workflows/test.yml`) a ogni pull request e su `main`.

## Limiti noti

- "Libera" vuol dire "nessuna lezione pubblicata": esami fuori calendario, seminari o aule chiuse possono non comparire, a meno che qualcuno non li segnali.
- **Dipartimenti e corsi senza fonte al lancio:** DiScAG, DiSU, DFSSN, Medicina e i master. Le loro lezioni non sono negli orari caricati, quindi le loro aule possono risultare libere anche quando non lo sono.
  - Il portale dei corsi (`storage.portale.unical.it`) non viene usato.
- **Docenti:** per ora i loro nomi non si salvano, quindi le schede non li mostrano e la ricerca non li trova.
- **DIAm:** le variazioni pubblicate solo come avvisi (lezioni rinviate o annullate) non sono nei file Excel finché il dipartimento non li ricarica. Se il formato dei file cambia, il sync li rifiuta e dopo 30 ore le aule diventano grigie.
- Le aule che non compaiono in nessun calendario caricato non sono sulla mappa.
- Numero di piani e dislivello dei cubi sono stimati (5 piani, dislivello 0) finché non si impostano dall'admin.
- Il bar del TAU è posizionato sull'edificio del TAU: la sua posizione esatta non è in nessuna delle mappe usate.
- **Mail di accesso:** al lancio usano il servizio interno di Supabase, che scrive solo ai membri del team dell'organizzazione Supabase e poche volte all'ora. Basta per un admin; per aprire gli account a tutti serve prima un fornitore SMTP.
- **Piani Free:** Supabase include circa 5 GB di egress al mese. Su Cloudflare Pages i file statici non hanno limite di richieste; le chiamate a `/api` contano come richieste Workers, 100.000 al giorno.
  - La chiave publishable è pubblica: chiunque può chiamare `room_status` direttamente e consumare egress. È un rischio residuo, controllato ogni settimana con la pagina Usage di Supabase.
  - Su `aule-unical.pages.dev` la cache condivisa di Cloudflare non salva nulla: ogni istanza del Worker tiene la sua cache in memoria. Con un dominio proprio la cache diventa condivisa.
  - Il piano Free non fa backup: va fatto a mano ogni mese (vedi "Dopo il lancio").
- Timeout e limite di connessioni del ruolo `aule_sync` sono comodità, non confini di sicurezza: il ruolo può cambiarli da sé. Il confine sono i permessi sulle 8 funzioni.
- L'estensione `pg_net` va tenuta spenta: se fosse accesa, il ruolo di sync potrebbe fare richieste HTTP dal database.
- GitHub spegne i workflow pianificati dopo 60 giorni senza attività nel repository. L'area admin mostra un avviso quando l'ultimo aggiornamento riuscito ha più di 26 ore.
- L'ordine dei nomi con lettere accentate può differire un poco tra browser e database; a parità di nome decide l'id.
- Le risposte JSON del database sono circa il 10-15% più grandi di quelle della versione Node.

## Online

Nessuno di questi passi chiede di dare una password o una chiave segreta a qualcuno: le password restano nel tuo gestore di password e si incollano solo dove indicato.

Prima di iniziare: Node 24 sul tuo computer (`nvm install 24` e `nvm alias default 24`; wrangler richiede Node 22 o successivo; in ogni nuovo terminale del progetto basta `nvm use`) e il login di wrangler che hai già sul tuo account Cloudflare (`npx wrangler whoami` mostra l'account).

1. **Revisione, tag e merge.** Controlla il branch `move-to-cloudflare-supabase`. Prima del merge segna la versione Node:
   ```bash
   git tag node-final main
   git push origin node-final
   ```
   Poi fai il merge su `main`. Per tornare indietro basta un branch da `node-final`.

   Prova verso il Planner: Actions, workflow `sync`, Run workflow con task `probe`. Scarica 3 calendari senza database. Se fallisce con `network` o `http_status`, fermati: i runner di GitHub non raggiungono il Planner.

   Da qui i workflow pianificati partono da soli: finché non hai finito il passo 7, il job `sync` delle 6:17 e delle 13:17 (e `discover` il lunedì) fallisce con `config_invalid` e GitHub ti manda una mail. È normale.
2. **Migration su Supabase.** Dal tuo computer, `supabase link --project-ref <ref>` se serve, poi `supabase db push`. Applica le migration nuove: schema degli orari, dati di riferimento, API di sync, API di lettura, segnalazioni e admin, file Excel del DIAm, modalità degli account, lista delle mail degli admin (vuota).

   Se dopo il 10/11/2026 hai cambiato calendari, pagine o piani nell'admin della versione Node, prima del `db push` rigenera la migration dei dati di riferimento, fai il commit su `main` e il push. Dopo il `db push` non va più rigenerata.
   ```bash
   npm run gen:reference -- --admin data/admin.json
   ```
3. **pg_net spento.** In Database, Extensions controlla che `pg_net` sia spento. Non lo usiamo, e se fosse acceso il ruolo di sync potrebbe fare richieste HTTP dal database verso qualunque indirizzo.
4. **Data API.** Project Settings, Data API: schemi esposti solo `public` e `graphql_public` (oppure GraphQL spento, non serve). In API Keys valuta di disattivare le chiavi legacy JWT (anon e service_role): il codice usa solo la chiave `sb_publishable_`.
5. **SSL.** Database, Settings, SSL Configuration: attiva "Enforce SSL on incoming connections". Il certificato è già nel repository, in `config/supabase-ca.crt`: non serve scaricarlo.
6. **Password del ruolo di sync.** Copia dalla dashboard (Connect, Session pooler) l'host del pooler, che può iniziare con `aws-0` o `aws-1`. Collegati con psql come `postgres` (la password del database te la chiede psql):
   ```bash
   psql "host=<host del session pooler> port=5432 dbname=postgres user=postgres.<ref> sslmode=verify-full sslrootcert=config/supabase-ca.crt"
   ```
   Poi:
   - `\password aule_sync` e incolla due volte una password nuova generata dal tuo gestore di password (psql manda al server solo l'hash SCRAM);
   - `alter role aule_sync login;`
   - `\q`.

   Prove: con `user=aule_sync.<ref>` e `-c "select current_user"` deve rispondere `aule_sync`; con `sslmode=disable` la connessione deve essere rifiutata. Se psql dà un errore di certificato, il pooler usa un'altra catena: aggiungi la radice di produzione giusta a `config/supabase-ca.crt` (mai quella di staging), fai il commit e riprova.
7. **GitHub.** Attiva la verifica in due passaggi sul tuo account. Nel repository, Settings:
   - Environments, `sync` (GitHub lo crea da solo al primo job pianificato; se non c'è, New environment `sync`); Deployment branches and tags: Selected branches, solo `main`; nessun revisore obbligatorio (bloccherebbe i workflow pianificati);
   - nell'environment `sync`, Environment variables: `SYNC_DB_HOST` = l'host copiato al passo 6, `SYNC_DB_USER` = `aule_sync.<ref>`;
   - nell'environment `sync`, Environment secrets: `SYNC_DB_PASSWORD` = la password del passo 6, incollata dal gestore di password;
   - Actions, General: azioni consentite, Workflow permissions "Read repository contents".
8. **Valori pubblici in `wrangler.json`.** Nei `vars` in alto (non in `env.preview`) metti `SUPABASE_URL` (`https://<ref>.supabase.co`) e `SUPABASE_PUBLISHABLE_KEY` (la chiave che inizia con `sb_publishable_`, Project Settings, API Keys). Lascia `ACCOUNTS` a `"admin"`. Sono valori pubblici: fai il commit su `main` e il push. Servono al sito, al Worker e al controllo ogni 15 minuti del workflow `sync`. Non mettere mai qui la chiave `sb_secret_`: la build la rifiuta.
9. **Cloudflare Pages.** Dal tuo computer, su `main` aggiornato, lancia `npm run deploy`. La prima volta wrangler dice che il progetto `aule-unical` non esiste: scegli Create a new project e, come branch di produzione, scrivi `main`. Il sito è su https://aule-unical.pages.dev.
   - `npm run deploy` pubblica sempre il branch `main`. Non pubblicare altri branch. Nel progetto `aule-unical` di Cloudflare, Settings, spegni le anteprime degli altri branch se l'opzione c'è, oppure proteggile con Cloudflare Access (Enable access policy). In ogni caso un'anteprima prende `env.preview`: nessun valore di Supabase e `ACCOUNTS` a `off`, quindi le sue `/api` rispondono 503.
   - Con `curl -I`: `/` e `/admin` hanno la CSP (`/admin` anche `X-Robots-Tag: noindex`), e solo la CSP di `/admin` contiene l'indirizzo di Supabase. Un indirizzo inesistente dà 404 con la pagina "Pagina non trovata".
   - Con `curl -sS -o /dev/null -w '%{http_code}\n'`: `/api/status` dà 200 e `/api/nope` dà 404. Le API accettano solo GET, quindi `curl -I` lì dà 405.
   - Con il progetto Supabase in pausa `/api/status` deve dare 503 e la mappa diventare grigia.
10. **Supabase Auth.** Authentication, URL Configuration: Site URL = `https://aule-unical.pages.dev`; Redirect URLs = `https://aule-unical.pages.dev` e `https://aule-unical.pages.dev/admin`. Disattiva "Allow new users to sign up": al lancio gli account si creano solo con un invito. Controlla che gli hook "Before User Created" (`public.hook_before_user_created`) e "Custom Access Token" (`public.custom_access_token_hook`) siano attivi; se non lo sono, attivali in Authentication, Hooks con queste due funzioni.
11. **Primo admin.**
    - L'invito e i link di accesso partono dal servizio di mail interno di Supabase, che scrive solo ai membri del team dell'organizzazione. In Organization settings, Team, invita l'indirizzo che userai come admin, con il ruolo più basso che la dashboard propone, e accetta l'invito. Se il tuo account Supabase usa già quell'indirizzo non serve.
    - Se l'indirizzo non è Unical, nell'SQL editor aggiungilo alla lista, tutto in minuscolo. `nome@example.org` è un esempio: metti il tuo.
      ```sql
      insert into aule.admin_emails (email) values ('nome@example.org');
      ```
    - Authentication, Users, Add user, Send invitation, con lo stesso indirizzo. Non aprire ancora il link dell'invito.
    - Nell'SQL editor dai il ruolo di admin con la `insert` in `public.user_roles` di "Il primo admin", sempre con lo stesso indirizzo.
    - Solo ora apri il link dell'invito. Poi vai su https://aule-unical.pages.dev/admin e accedi con il link che arriva alla tua mail.
    - La modalità del database è già `admin`. Per controllarla: `select accounts_mode from aule.settings;`. Se non è `admin`, rimettila con `update aule.settings set accounts_mode = 'admin';`.
    - Controlla che la mappa non mostri "Accedi" né il riquadro delle segnalazioni.
12. **Primo sync.** In locale, con le stesse variabili in un terminale (mai in un file), `node dist/src/cli/sync-db.js --check` deve stampare `db_check`:
    ```bash
    npm run build
    export SYNC_DB_HOST='<host del session pooler>' SYNC_DB_USER='aule_sync.<ref>'
    read -rs SYNC_DB_PASSWORD && export SYNC_DB_PASSWORD
    node dist/src/cli/sync-db.js --check
    unset SYNC_DB_PASSWORD
    ```
    Poi Actions, workflow `sync`, Run workflow con task `sync`. Controlla che il log contenga solo eventi, id, conteggi e codici e che i conteggi siano vicini a quelli locali. Poi lancia anche `discover`.
13. **Configurazione.** Calendari, pagine sorgente, piani e collegamenti si cambiano dall'area admin. In alternativa ci sono le funzioni `aule.config_*` nell'SQL editor (vedi "Configurazione dall'SQL editor"). Per un aggiornamento subito: "Aggiorna adesso" nell'area admin, oppure Actions, `sync`, Run workflow. Per sapere se va tutto bene: l'area admin (ultimo aggiornamento e avviso delle 26 ore), il piè di pagina della mappa e le mail di GitHub sui job falliti.

### Dopo il lancio

1. **Segnalazioni aperte agli studenti, solo quando vuoi aprirle.** Prima l'SMTP: scegli un fornitore e configuralo in Authentication, Emails, SMTP Settings (la password SMTP resta nella dashboard Supabase), con limiti di invio ragionevoli. Prova con la tua mail. Poi, in quest'ordine:
   - riattiva "Allow new users to sign up";
   - nell'SQL editor `update aule.settings set accounts_mode = 'all';`;
   - in `wrangler.json`, nei `vars` in alto, metti `"ACCOUNTS": "all"`, fai il commit su `main` e `npm run deploy`.

   I moderatori si nominano dall'area admin, sezione "Utenti e ruoli", dopo il loro primo accesso. Gli admin con un indirizzo in `aule.admin_emails` continuano ad accedere in ogni modalità. Per tornare a solo admin fai i passi al contrario: `"ACCOUNTS": "admin"` e `npm run deploy`, poi `accounts_mode` a `admin`, poi registrazioni spente.
2. **Ogni settimana.** Nella pagina Usage di Supabase guarda l'egress (circa 5 GB al mese inclusi) e in Cloudflare, progetto `aule-unical`, le richieste al giorno delle Functions (cioè di `/api`) e il tempo CPU. Se l'egress per richiesta è molto più alto della dimensione compressa di `/api/status`, le risposte arrivano non compresse. Se l'egress va verso 2,5 GB al mese, riduci ancora il polling della mappa; il dominio proprio (punto 5) attiva la cache condivisa.
3. **Ogni mese.** Il piano Free non fa backup:
   ```bash
   supabase db dump --linked --data-only --schema aule,public -f backup-$(date +%F).sql
   ```
   Poi cifra il file (per esempio con `gpg -c`) e cancella la copia in chiaro: contiene gli uuid degli utenti, i loro ruoli e le mail degli admin fuori Unical. Il file è ignorato da git e non va mai nel repository.
4. **Ogni settembre, e se l'admin mostra l'avviso delle 26 ore.** GitHub disattiva i workflow pianificati dopo 60 giorni senza attività nel repository: Actions, `sync`, Enable workflow. Se il progetto Supabase è in pausa, ripristinalo dalla dashboard. Poi Run workflow con task `sync` e controlla la mappa. Una volta l'anno aggiorna anche le date dei semestri in `config/diam.json` e fai il commit.
5. **Dominio, più avanti.** Nel progetto `aule-unical` di Cloudflare, Custom domains, aggiungi il dominio (per esempio `aule.<dominio>`); `wrangler.json` non cambia. Poi aggiungi il nuovo indirizzo e il suo `/admin` a Site URL e Redirect URLs in Supabase. Avvisa chi accede: dovrà rifare l'accesso, perché la sessione è legata all'indirizzo. Solo sul dominio proprio funziona la cache condivisa del Worker.
6. **Rotazione della password di sync** (una volta l'anno, o subito se pensi che sia uscita): ripeti `\password aule_sync` come al passo 6 di "Online" e aggiorna il secret `SYNC_DB_PASSWORD` nell'environment `sync`. Per bloccare tutto subito: `alter role aule_sync nologin;`.
7. **SSO di Ateneo (in seguito):** con l'Area ICT Unical si può registrare l'app sul proxy SAML di Ateneo. Serve il piano Pro di Supabase.

## Licenza

Il codice è distribuito con licenza [MIT](LICENSE). I dati di terzi contenuti nel repository (mappa del campus, elementi di OpenStreetMap, orari e link dei luoghi, calendari, configurazione degli orari del DIAm, dati di riferimento generati nelle migration, carattere) non sono coperti dalla licenza MIT: vedi [DATA-LICENSE.md](DATA-LICENSE.md).

Le librerie servite al browser (MapLibre, supabase-js e le loro dipendenze) hanno le loro licenze, raccolte durante la build in `dist/licenses.txt`, copiate nel sito in `/vendor/licenses.txt` e linkate nella mappa ("Licenze"). Il carattere Atkinson Hyperlegible Next ha la licenza SIL Open Font License 1.1, in `public/fonts/AtkinsonHyperlegibleNext-OFL.txt`.
