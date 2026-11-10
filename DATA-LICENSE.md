# Dati di terzi

La licenza MIT del file `LICENSE` copre solo il codice di questo repository (`src/`, `scripts/`, `test/`, `supabase/`, `.github/`, e i file `.js`, `.html` e `.css` in `public/`). Non copre i dati elencati qui, che restano dei loro titolari, neanche quando stanno dentro una di quelle cartelle.

## `public/data/campus.geojson`

- **Forme di edifici, mense e luoghi:** mappa ufficiale del campus dell'Università della Calabria (Google My Maps), esportata in KML. I diritti restano all'Università della Calabria e non sono coperti dalla licenza del repository. Su richiesta dell'Ateneo queste forme verranno tolte o sostituite.
- **Ponte Pietro Bucci, edificio TechNest, posizione di Bar La Cascina e Mensa Vermicelli:** © OpenStreetMap contributors, disponibili con licenza [Open Database License 1.0](https://opendatacommons.org/licenses/odbl/1-0/). Fonte e note: <https://www.openstreetmap.org/copyright>. Sono pochi elementi estratti una volta sola: un estratto non sostanziale secondo le linee guida della OpenStreetMap Foundation, che va comunque attribuito come sopra.

## `public/data/canteens.json` e `public/data/places.json`

Orari, posti e link di mense, biblioteche, aula studio, teatri e cinema, presi dalle pagine pubbliche dell'Università della Calabria e del gestore del cinema e riscritti con parole nostre. Ogni voce indica la fonte e la data di verifica. Gli orari della mensa Maisonnettes Senior sono indicati da chi frequenta il campus e sono segnati come non ufficiali.

## `config/seed.json`

Identificativi e titoli dei calendari pubblici del University Planner, e indirizzi delle pagine dei dipartimenti che li pubblicano. Sono link pubblicati dall'Ateneo. Il file è lo storico della prima configurazione: quella in uso sta nel database.

## Migration generate con dati di riferimento

`supabase/migrations/20261110090100_reference_data.sql`, e ogni migration `*_campus.sql` creata in seguito con `--campus-only`, sono generate da `scripts/gen-reference-sql.ts` e contengono:

- chiavi e nomi degli edifici, presi da `public/data/campus.geojson` (diritti dei titolari della mappa, come sopra);
- calendari, pagine dei dipartimenti, collegamenti tra edifici e piani di alcune aule, presi da `config/seed.json` (come sopra).

Questi dati non sono coperti dalla licenza MIT.

## Orari del DIAm: `config/diam.json` e `supabase/migrations/20261110090500_xlsx_feeds.sql`

Date dei semestri, giorni senza lezioni, nomi dei fogli, tabella delle aule e indirizzo della pagina indice, presi dalle pagine pubbliche e dai file Excel del Dipartimento di Ingegneria dell'Ambiente (DIAm) dell'Università della Calabria. I diritti restano all'Università della Calabria.

I file Excel non vengono ridistribuiti: non sono nel repository e l'app non li serve. I test usano file inventati. Fonte degli orari: Dipartimento di Ingegneria dell'Ambiente, Università della Calabria, pagina "Orario delle lezioni" (<https://diam.unical.it/didattica/iscriversi-studiare-laurearsi/orario-delle-lezioni/>). Uso non commerciale, citando la fonte, come chiedono le note legali del portale dell'Ateneo.

## Dati scaricati quando l'app gira

Gli orari delle lezioni vengono scaricati da GitHub Actions dai calendari pubblici del University Planner e dai file Excel del DIAm, e restano nel database Supabase: mai nel repository, nei log o negli artifact dei workflow. I log contengono solo eventi, id, conteggi e codici. Degli impegni che non sono lezioni (prenotazioni, esami, riunioni) si salvano solo il tipo e l'orario. I dati restano dell'Università della Calabria.

## `public/fonts/`

Carattere Atkinson Hyperlegible Next, Copyright 2020-2024 The Atkinson Hyperlegible Next Project Authors, distribuito con licenza [SIL Open Font License 1.1](https://openfontlicense.org). Il testo della licenza è in `public/fonts/AtkinsonHyperlegibleNext-OFL.txt`. Il carattere non è coperto dalla licenza MIT.

## Mappa di base

OpenFreeMap, © OpenMapTiles, dati © OpenStreetMap contributors. L'attribuzione compare sulla mappa.
