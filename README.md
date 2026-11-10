# Aule Unical

Mappa 3D semplificata del campus Unical con le aule libere e occupate, ricavate dagli orari pubblicati sul University Planner.

È un progetto studentesco **non ufficiale**: non è un servizio dell'Università della Calabria e non è collegato all'Ateneo.
- **Mappa:** cliccando su un cubo si vedono le sue aule piano per piano.
- **Scheda dell'aula:** posti, servizi, lezioni del giorno o della settimana e disservizi segnalati.
- **Ricerca:** trova aule, cubi, insegnamenti, docenti e mense, con i filtri "libere adesso", "libere per almeno N ore" e "posti minimi".
- **Segnalazioni:** chi accede con la mail Unical può segnalare un'aula occupata o chiusa, una lezione non tenuta o un disservizio. Moderatori e admin le controllano dall'area admin.
- **Posizione:** il bottone in alto a destra mostra dove sei sulla mappa. La posizione resta nel browser e non viene mai mandata al server.

## Come funziona

- **Sito:** Cloudflare Workers (piano Free) serve i file di `public/` e risponde a tre sole route: `/api/status`, `/api/rooms/:id` e `/api/search`.
  - Il Worker controlla i parametri, chiama una funzione del database con la chiave pubblica (publishable) di Supabase e rimanda la risposta così com'è, con una cache di 60 secondi.
  - Non ha segreti. Se Supabase non risponde, dà errore e dopo pochi minuti la mappa diventa grigia: mai dati vecchi.
  - `scripts/build-site.ts` prepara la cartella `site/` con le intestazioni di sicurezza (`_headers`) e la configurazione del browser (`client-config.json`).
- **Database:** Supabase (Postgres, piano Free) tiene orari, aule e configurazione, e calcola in SQL lo stato delle aule e la ricerca (`supabase/migrations/`).
- **Download degli orari:** GitHub Actions, workflow `sync` (`.github/workflows/sync.yml`).
  - Scarica gli orari alle 6:17 e alle 13:17 (ora di Roma) e quando un admin preme "Aggiorna adesso".
  - Ogni 15 minuti un controllo senza segreti chiede al database se c'è una richiesta o se un orario è stato saltato. Una richiesta parte quindi entro circa 20 minuti. Il controllo tiene anche attivo il progetto Supabase.
  - "Cerca calendari" funziona allo stesso modo e parte da solo ogni lunedì alle 5:47: legge le pagine dei dipartimenti e propone i calendari nuovi, che un admin conferma.
  - Scrive nel database solo con il ruolo `aule_sync`, che può soltanto chiamare 8 funzioni che controllano tutto quello che ricevono.
- **Fonti degli orari:** i calendari pubblici del University Planner e i file Excel del DIAm. Il codice ha un posto pronto per altre fonti (`src/sources/`), che restano spente.
- **Account:** nel browser supabase-js chiama direttamente le funzioni per utenti e admin con il token dell'utente. Il Worker non vede mai i token.
  - Con `ACCOUNTS_ENABLED` a `"false"` in `wrangler.json` la mappa nasconde accesso, segnalazioni e link all'admin, e l'area admin mostra "non disponibile".
  - Il flag nasconde solo l'interfaccia: tutte le regole restano nel database.
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
- `ACCOUNTS_ENABLED=true` accende account e admin; con `false` vedi il sito come al lancio.

Infine:

```bash
npm run dev
```

- `npm run dev` compila, prepara `site/` e avvia `wrangler dev`. La mappa è su http://localhost:3010, l'admin su `/admin`.
- Dopo una modifica in `public/`, in un altro terminale `npm run dev:site` aggiorna `site/` in un secondo, mentre `wrangler dev` resta acceso.
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

1. Accedi una volta dalla mappa con la tua mail Unical, così l'account viene creato.
2. Dai il ruolo dal database: in locale con il comando qui sotto, online dall'SQL editor della dashboard Supabase.
3. Gli altri ruoli li assegni dall'area admin, sezione "Utenti e ruoli".

```bash
docker exec supabase_db_unical-aule-3d psql -U postgres -c "insert into public.user_roles (user_id, role) select id, 'admin' from auth.users where email = 'TUA_MAIL@unical.it' on conflict (user_id) do update set role = 'admin';"
```

### Configurazione senza account

Finché gli account sono spenti (online, al lancio) la configurazione si cambia dall'SQL editor della dashboard Supabase, o in locale con psql, con le funzioni `aule.config_*`. Controllano i valori come l'area admin e scrivono in una sola transazione. Sostituiscono `discover --apply` e `discover --relabel` della versione Node.

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
- `npm run typecheck:worker`: controlla il Worker con i tipi di Cloudflare;
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
  - Per ogni lezione si salvano solo titolo, orario, stato, tipo, corso, anno, docenti e aula.
  - Per gli impegni che non sono lezioni (prenotazioni delle aule, esami, riunioni) si salvano solo il tipo ("Prenotazione", "Esame", "Altro impegno") e l'orario, mai il titolo libero, i docenti o i corsi, che spesso contengono nomi di persone. Un tipo sconosciuto vale "Altro impegno" e tiene l'aula occupata.
  - I file del DIAm danno un orario settimanale tipo. Date dei semestri e giorni senza lezioni stanno in `config/diam.json` e si aggiornano a mano una volta l'anno.
  - Il Planner non indica il piano delle aule: si imposta dall'admin.
  - I dati restano dell'Università della Calabria. Il sync gira due volte al giorno, più quando un admin lo chiede, con al massimo 3 richieste insieme al Planner, e si presenta con uno User-Agent che indica questo repository.
- **Configurazione**: calendari, pagine dei dipartimenti, piani e collegamenti tra edifici stanno nel database. `config/seed.json` è solo lo storico della prima configurazione, da cui è stata generata la migration dei dati di riferimento.
- **Edifici**: mappa ufficiale del campus Unical (Google My Maps), esportata in KML. I diritti restano all'Università della Calabria.
- **Ponte Pietro Bucci, edificio TechNest, posizione di Bar La Cascina e Mensa Vermicelli**: © OpenStreetMap contributors, licenza ODbL 1.0 (https://www.openstreetmap.org/copyright).
- **Mappa di base**: OpenFreeMap, © OpenMapTiles, dati © OpenStreetMap contributors.
- **Orari delle mense**: pagine ufficiali del servizio mensa Unical, verificati il 9 novembre 2026 (`public/data/canteens.json`). Gli orari della Maisonnettes Senior sono indicati da chi frequenta il campus.
- **Carattere**: Atkinson Hyperlegible Next, licenza SIL Open Font License 1.1 (`public/fonts/`).

## Account, ruoli e segnalazioni

- **Accesso:** solo con un link mandato alla mail Unical (`@unical.it` o `@studenti.unical.it`), senza password. Il filtro sui domini è un hook del database: tutto è rifiutato tranne i due domini esatti.
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
- **Fail closed:**
  - un calendario che fallisce o risponde in modo anomalo tiene i dati buoni precedenti;
  - un sync non plausibile (tutto vuoto o meno della metà delle lezioni di prima) viene interrotto e restano i dati di prima;
  - uno stato sconosciuto del Planner, o un impegno di tipo sconosciuto, tiene l'aula occupata;
  - i dati vecchi diventano grigi, mai verdi; se Supabase non risponde il Worker dà 503 e la mappa diventa grigia;
  - le segnalazioni possono solo rendere un'aula occupata, tranne la "lezione non tenuta" approvata;
  - senza i valori in `wrangler.json` il Worker risponde 503 e la build del sito si ferma.
- **Scritture atomiche e transizioni esplicite:** ogni sync si chiude in una sola transazione, quindi chi legge vede tutti i dati vecchi o tutti i nuovi. Un sync passa solo da "aperto" a "finito", "abbandonato" o "interrotto"; una richiesta solo da "in attesa" ad "approvata" o "respinta".
- **Errori:** codici chiusi. Gli errori di Postgres sono tradotti in una lista fissa prima di arrivare ai log o al browser. I log contengono solo eventi, id, conteggi e codici, senza mail, nomi di docenti, titoli né contenuto delle richieste.
- **Segreti:**
  - il Worker usa solo la chiave pubblica, accetta solo GET, non inoltra mai token, cookie o indirizzi del client e non copia le intestazioni di Supabase;
  - la password di `aule_sync` sta solo nell'environment `sync` di GitHub, limitato a `main`, e solo nell'ultimo passo del job; mai in un file;
  - il sync si collega con TLS verify-full sul certificato di `config/supabase-ca.crt`: senza quel file rifiuta ogni host che non sia locale;
  - i workflow usano azioni fissate per SHA, permessi di sola lettura, `npm ci --ignore-scripts`, niente cache e niente artifact; i comandi di sync rifiutano `NODE_OPTIONS` e `NODE_PATH`.
- **Meno dati possibile:** le funzioni restituiscono solo quello che serve allo schermo; degli impegni che non sono lezioni restano solo tipo e orario; il flag `ACCOUNTS_ENABLED` nasconde solo l'interfaccia, le regole restano nel database.
- **Browser:**
  - CSP senza script inline, `connect-src` limitato al sito, alle tile della mappa e a Supabase (nessuna origine Supabase con gli account spenti);
  - testo inserito solo con `textContent`.
- **Test:** pgTAP in `supabase/tests/database` e test Node in `test/`, eseguiti da GitHub Actions (`.github/workflows/test.yml`) a ogni pull request e su `main`.

## Limiti noti

- "Libera" vuol dire "nessuna lezione pubblicata": esami fuori calendario, seminari o aule chiuse possono non comparire, a meno che qualcuno non li segnali.
- **Dipartimenti e corsi senza fonte al lancio:** DiScAG, DiSU, DIMES, DFSSN, Medicina e i master. Le loro lezioni non sono negli orari caricati, quindi le loro aule possono risultare libere anche quando non lo sono.
  - Il portale dei corsi (`storage.portale.unical.it`) e l'app del DIMES hanno un `robots.txt` che vieta l'accesso automatico: si aggiungeranno solo con il consenso scritto dell'Ateneo.
- **DIAm:** le variazioni pubblicate solo come avvisi (lezioni rinviate o annullate) non sono nei file Excel finché il dipartimento non li ricarica. Se il formato dei file cambia, il sync li rifiuta e dopo 30 ore le aule diventano grigie.
- Le aule che non compaiono in nessun calendario caricato non sono sulla mappa.
- Numero di piani e dislivello dei cubi sono stimati (5 piani, dislivello 0) finché non si impostano dall'admin.
- Il bar del TAU è posizionato sull'edificio del TAU: la sua posizione esatta non è in nessuna delle mappe usate.
- **Piani Free:** Supabase include circa 5 GB di egress al mese, Cloudflare Workers 100.000 richieste al giorno.
  - La chiave publishable è pubblica: chiunque può chiamare `room_status` direttamente e consumare egress. È un rischio residuo, controllato ogni settimana con la pagina Usage di Supabase.
  - Su workers.dev la cache condivisa di Cloudflare non funziona: ogni istanza del Worker tiene la sua cache in memoria. Con un dominio proprio la cache diventa condivisa.
  - Il piano Free non fa backup: va fatto a mano ogni mese (vedi "Dopo il lancio").
- Timeout e limite di connessioni del ruolo `aule_sync` sono comodità, non confini di sicurezza: il ruolo può cambiarli da sé. Il confine sono i permessi sulle 8 funzioni.
- L'estensione `pg_net` va tenuta spenta: se fosse accesa, il ruolo di sync potrebbe fare richieste HTTP dal database.
- GitHub spegne i workflow pianificati dopo 60 giorni senza attività nel repository. L'area admin mostra un avviso quando l'ultimo aggiornamento riuscito ha più di 26 ore.
- L'ordine dei nomi con lettere accentate può differire un poco tra browser e database; a parità di nome decide l'id.
- Le risposte JSON del database sono circa il 10-15% più grandi di quelle della versione Node.

## Online

Nessuno di questi passi chiede di dare una password o una chiave segreta a qualcuno: le password restano nel tuo gestore di password e si incollano solo dove indicato.

1. **Node 24 sul tuo computer.** `nvm install 24` e `nvm alias default 24` (wrangler richiede Node 22 o successivo). In ogni nuovo terminale del progetto basta `nvm use`.
2. **Prova verso il Planner.** Dopo il merge del passo 3 (i workflow partono solo da `main`), Actions, workflow `sync`, Run workflow con task `probe`: scarica 3 calendari senza database. Se fallisce con `network` o `http_status`, fermati: i runner di GitHub non raggiungono il Planner.
3. **Revisione, tag e merge.** Controlla il branch `move-to-cloudflare-supabase`. Prima del merge segna la versione Node:
   ```bash
   git tag node-final main
   git push origin node-final
   ```
   Poi fai il merge su `main`. Per tornare indietro basta un branch da `node-final`.

   Da qui i workflow pianificati partono da soli: finché non hai finito il passo 11, il job `sync` delle 6:17 e delle 13:17 (e `discover` il lunedì) fallisce con `config_invalid` e GitHub ti manda una mail. È normale.
4. **Configurazione aggiornata.** Se dopo il 10/11/2026 hai cambiato calendari, pagine o piani nell'admin della versione Node, prima del passo 5 rigenera la seconda migration e fai il commit. Dopo il passo 5 non va più rigenerata.
   ```bash
   npm run gen:reference -- --admin data/admin.json
   ```
5. **Migration su Supabase.** Dal tuo computer, `supabase link --project-ref <ref>` se serve, poi `supabase db push`. Applica le migration nuove: schema degli orari, dati di riferimento, API di sync, API di lettura, segnalazioni e admin, file Excel del DIAm.
6. **Estensioni.** Database, Extensions: `pg_net` deve essere spento (non lo usiamo; se fosse acceso, il ruolo di sync potrebbe fare richieste HTTP dal database).
7. **Data API.** Project Settings, Data API: schemi esposti solo `public` e `graphql_public` (oppure GraphQL spento, non serve). In API Keys valuta di disattivare le chiavi legacy JWT (anon e service_role): il codice usa solo la chiave `sb_publishable_`.
8. **SSL e certificato.** Database, Settings, SSL Configuration: attiva "Enforce SSL on incoming connections" e scarica il certificato. Salvalo come `config/supabase-ca.crt`; se il pooler usa più radici di produzione mettile tutte nello stesso file, una dopo l'altra (mai quella di staging). Fai il commit: è un certificato pubblico. Senza questo file il sync rifiuta di collegarsi al cloud.
9. **Password del ruolo di sync.** Copia dalla dashboard (Connect, Session pooler) l'host del pooler, che può iniziare con `aws-0` o `aws-1`. Collegati con psql come `postgres` (la password del database te la chiede psql):
   ```bash
   psql "host=<host del session pooler> port=5432 dbname=postgres user=postgres.<ref> sslmode=verify-full sslrootcert=config/supabase-ca.crt"
   ```
   Poi:
   - `\password aule_sync` e incolla due volte una password nuova generata dal tuo gestore di password (psql manda al server solo l'hash SCRAM);
   - `alter role aule_sync login;`
   - `\q`.

   Prove: con `user=aule_sync.<ref>` e `-c "select current_user"` deve rispondere `aule_sync`; con `sslmode=disable` la connessione deve essere rifiutata. Se psql dà un errore di certificato, il pooler usa un'altra catena: aggiungi la radice giusta a `config/supabase-ca.crt` e riprova.
10. **Valori pubblici in `wrangler.json`.** In `vars` metti `SUPABASE_URL` (`https://<ref>.supabase.co`) e `SUPABASE_PUBLISHABLE_KEY` (la chiave che inizia con `sb_publishable_`, Project Settings, API Keys). Lascia `ACCOUNTS_ENABLED` a `"false"`. Sono valori pubblici; fai il commit. Non mettere mai qui la chiave `sb_secret_`.
11. **GitHub.** Attiva la verifica in due passaggi sul tuo account. Nel repository, Settings:
    - Environments, `sync` (GitHub lo crea da solo al primo job pianificato; se non c'è, New environment `sync`); Deployment branches and tags: Selected branches, solo `main`; nessun revisore obbligatorio (bloccherebbe i workflow pianificati);
    - nell'environment `sync`, Environment variables: `SYNC_DB_HOST` = l'host copiato al passo 9, `SYNC_DB_USER` = `aule_sync.<ref>`;
    - nell'environment `sync`, Environment secrets: `SYNC_DB_PASSWORD` = la password del passo 9, incollata dal gestore di password;
    - Actions, General: azioni consentite, Workflow permissions "Read repository contents".
12. **Primo sync.** In locale, con le stesse variabili in un terminale (mai in un file), `node dist/src/cli/sync-db.js --check` deve stampare `db_check`:
    ```bash
    npm run build
    export SYNC_DB_HOST='<host del session pooler>' SYNC_DB_USER='aule_sync.<ref>'
    read -rs SYNC_DB_PASSWORD && export SYNC_DB_PASSWORD
    node dist/src/cli/sync-db.js --check
    unset SYNC_DB_PASSWORD
    ```
    Poi Actions, workflow `sync`, Run workflow con task `sync`. Controlla che il log contenga solo eventi, id, conteggi e codici e che i conteggi siano vicini a quelli locali. Poi lancia anche `discover`.
13. **Cloudflare.** Crea un account Free con un sottodominio workers.dev dal nome neutro (niente nomi di persone). Dal tuo computer `npx wrangler login` (oppure un token limitato al solo Workers), poi `npm run deploy` (con `ACCOUNTS_ENABLED` a `"false"`). Annota l'indirizzo `https://aule-unical.<sottodominio>.workers.dev`.
    - In Workers, Settings, controlla che i log di invocazione siano spenti e che non ci siano URL di anteprima.
    - Con `curl -I`: `/` e `/admin` hanno la CSP (`/admin` anche `X-Robots-Tag: noindex`), un file inesistente dà 404 senza contenuto, `/api/status` risponde 200, `/api/nope` dà 404.
    - Con il progetto Supabase in pausa `/api/status` deve dare 503 e la mappa diventare grigia.
14. **Supabase Auth.** Authentication, URL Configuration: Site URL = l'indirizzo workers.dev; Redirect URLs = lo stesso indirizzo e `/admin`. Disattiva "Allow new users to sign up" finché l'SMTP non è pronto. Controlla che gli hook "Before User Created" (`public.hook_before_user_created`) e "Custom Access Token" (`public.custom_access_token_hook`) siano disponibili sul piano Free e attivi.
15. **Configurazione finché gli account sono spenti.** Ogni modifica (calendari, pagine sorgente, piani, collegamenti) si fa nel SQL editor con le funzioni `aule.config_*` (vedi "Configurazione senza account"). Per un aggiornamento subito: Actions, `sync`, Run workflow. Per sapere se va tutto bene: piè di pagina della mappa (ora dell'ultimo aggiornamento, calendari non aggiornati) e le mail di GitHub sui job falliti.

### Dopo il lancio

1. **SMTP e account.** Scegli un fornitore SMTP e configuralo in Authentication, Emails, SMTP Settings (la password SMTP resta nella dashboard Supabase), con limiti di invio ragionevoli. Prova con la tua mail Unical. Poi riattiva "Allow new users to sign up", metti `"ACCOUNTS_ENABLED": "true"` in `wrangler.json`, fai il commit e `npm run deploy`.
2. **Primo admin.** Accedi una volta dalla mappa, poi nell'SQL editor di Supabase esegui la `insert` del comando di "Il primo admin" sostituendo la tua mail.
3. **Ogni settimana.** Nella pagina Usage di Supabase guarda l'egress (circa 5 GB al mese inclusi) e in Cloudflare le richieste e i subrequest al giorno del Worker e il tempo CPU. Se l'egress per richiesta è molto più alto della dimensione compressa di `/api/status`, le risposte arrivano non compresse. Se l'egress va verso 2,5 GB al mese, riduci ancora il polling della mappa; il dominio proprio (punto 6) attiva la cache condivisa.
4. **Ogni mese.** Il piano Free non fa backup:
   ```bash
   supabase db dump --linked --data-only --schema aule,public -f backup-$(date +%F).sql
   ```
   Poi cifra il file (per esempio con `gpg -c`) e cancella la copia in chiaro: contiene gli uuid degli utenti e i loro ruoli. Il file è ignorato da git e non va mai nel repository.
5. **Ogni settembre, e se l'admin mostra l'avviso delle 26 ore.** GitHub disattiva i workflow pianificati dopo 60 giorni senza attività nel repository: Actions, `sync`, Enable workflow. Se il progetto Supabase è in pausa, ripristinalo dalla dashboard. Poi Run workflow con task `sync` e controlla la mappa. Una volta l'anno aggiorna anche le date dei semestri in `config/diam.json` e fai il commit.
6. **Dominio, più avanti.** Aggiungi il dominio come zona Cloudflare, in `wrangler.json` metti `"workers_dev": false` e `"routes": [{ "pattern": "aule.<dominio>", "custom_domain": true }]`, `npm run deploy`, poi aggiorna Site URL e Redirect URLs in Supabase. Avvisa gli utenti: dovranno rifare l'accesso, perché la sessione è legata all'indirizzo. Solo sul dominio proprio funziona la cache condivisa del Worker.
7. **Rotazione della password di sync** (una volta l'anno, o subito se pensi che sia uscita): ripeti `\password aule_sync` come al passo 9 e aggiorna il secret `SYNC_DB_PASSWORD` nell'environment `sync`. Per bloccare tutto subito: `alter role aule_sync nologin;`.
8. **SSO di Ateneo (in seguito):** con l'Area ICT Unical si può registrare l'app sul proxy SAML di Ateneo. Serve il piano Pro di Supabase.

## Licenza

Il codice è distribuito con licenza [MIT](LICENSE). I dati di terzi contenuti nel repository (mappa del campus, elementi di OpenStreetMap, orari e link dei luoghi, calendari, configurazione degli orari del DIAm, dati di riferimento generati nelle migration, carattere) non sono coperti dalla licenza MIT: vedi [DATA-LICENSE.md](DATA-LICENSE.md).

Le librerie servite al browser (MapLibre, supabase-js e le loro dipendenze) hanno le loro licenze, raccolte durante la build in `dist/licenses.txt`, copiate nel sito in `/vendor/licenses.txt` e linkate nella mappa ("Licenze"). Il carattere Atkinson Hyperlegible Next ha la licenza SIL Open Font License 1.1, in `public/fonts/AtkinsonHyperlegibleNext-OFL.txt`.
