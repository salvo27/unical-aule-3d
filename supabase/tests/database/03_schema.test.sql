begin;
create extension if not exists pgtap with schema extensions;
select plan(90);

-- Schema and roles.
select has_schema('aule', 'schema aule exists');
select is(
  (select count(*)::int from unnest(array['anon', 'authenticated', 'service_role', 'aule_sync']) as r(role),
    unnest(array['USAGE', 'CREATE']) as p(priv) where has_schema_privilege(r.role, 'aule', p.priv)),
  0, 'anon, authenticated, service_role and aule_sync cannot use schema aule');
select ok(
  (select bool_and(has_schema_privilege(r, 'aule', 'USAGE') and not has_schema_privilege(r, 'aule', 'CREATE'))
    from unnest(array['aule_reader', 'aule_ingest', 'aule_config']) as r),
  'the three owner roles use schema aule and cannot create in it');
select ok(
  (select not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and not rolcanlogin
    from pg_roles where rolname = 'aule_ingest'),
  'aule_ingest is a plain nologin role without inherit');
select ok(
  (select not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and not rolcanlogin
    from pg_roles where rolname = 'aule_reader'),
  'aule_reader is a plain nologin role without inherit');
select ok(
  (select not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls and not rolcanlogin
    from pg_roles where rolname = 'aule_config'),
  'aule_config is a plain nologin role without inherit');
select ok(
  (select not rolinherit and not rolsuper and not rolcreatedb and not rolcreaterole and not rolreplication and not rolbypassrls
    from pg_roles where rolname = 'aule_sync'),
  'aule_sync has no attribute beyond a later login');
select is((select rolconnlimit from pg_roles where rolname = 'aule_sync'), 2, 'aule_sync has at most 2 connections');
select ok(
  (select setconfig @> array['statement_timeout=60s', 'lock_timeout=10s', 'idle_in_transaction_session_timeout=60s', 'search_path=""']
    from pg_db_role_setting where setrole = 'aule_sync'::regrole and setdatabase = 0),
  'aule_sync has its timeouts and an empty search_path');
select is(
  (select count(*)::int from unnest(array['aule_ingest', 'aule_reader', 'aule_config', 'aule_sync']) as r
    where pg_has_role('postgres', r, 'SET') and not pg_has_role('postgres', r, 'USAGE')),
  4, 'postgres can set the four roles without inheriting their privileges');

-- Tables, RLS and privileges.
select tables_are('aule', array[
  'settings', 'campus_buildings', 'room_seeds', 'calendars', 'sources', 'room_floors', 'building_shapes', 'building_links',
  'run_requests', 'proposals', 'discover_state', 'discover_failures', 'rooms', 'calendar_data', 'lessons', 'calendar_runs',
  'sync_runs', 'sync_run_calendars', 'staged_calendars', 'staged_lessons', 'staged_rooms', 'unique_lessons', 'lesson_rooms',
  'room_calendars', 'admin_emails', 'feed_rooms'
], 'schema aule has exactly the timetable, configuration and admin address tables');
select views_are('aule', array['room_view'], 'schema aule has only the room view');
select is(
  (select count(*)::int from pg_class where relnamespace = 'aule'::regnamespace and relkind in ('r', 'p') and not relrowsecurity),
  0, 'RLS is enabled on every aule table');
select is(
  array(select relname::text from pg_class where relnamespace = 'public'::regnamespace and relkind in ('r', 'p', 'v', 'm', 'S', 'f') order by 1),
  array['room_requests', 'user_roles'],
  'no new table, view or sequence in schema public');
select set_eq(
  $$select c.relname::text, r.role, string_agg(p.letter, '' order by p.ord)
    from pg_class c
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    cross join (values (1, 'S', 'SELECT'), (2, 'I', 'INSERT'), (3, 'U', 'UPDATE'), (4, 'D', 'DELETE'),
      (5, 'T', 'TRUNCATE'), (6, 'R', 'REFERENCES'), (7, 'G', 'TRIGGER')) as p(ord, letter, priv)
    where c.relnamespace = 'aule'::regnamespace and c.relkind in ('r', 'v') and has_table_privilege(r.role, c.oid, p.priv)
    group by 1, 2$$,
  $$values
    ('settings', 'aule_reader', 'S'), ('settings', 'aule_ingest', 'S'), ('settings', 'aule_config', 'S'),
    ('campus_buildings', 'aule_reader', 'S'), ('campus_buildings', 'aule_config', 'S'),
    ('room_seeds', 'aule_reader', 'S'), ('room_seeds', 'aule_config', 'S'),
    ('room_floors', 'aule_reader', 'S'), ('room_floors', 'aule_config', 'SIUD'),
    ('building_shapes', 'aule_reader', 'S'), ('building_shapes', 'aule_config', 'SIUD'),
    ('building_links', 'aule_reader', 'S'), ('building_links', 'aule_config', 'SIUD'),
    ('calendars', 'aule_ingest', 'S'), ('calendars', 'aule_config', 'SIUD'),
    ('sources', 'aule_ingest', 'S'), ('sources', 'aule_config', 'SIUD'),
    ('rooms', 'aule_reader', 'S'), ('rooms', 'aule_ingest', 'SIUD'), ('rooms', 'aule_config', 'SD'),
    ('calendar_data', 'aule_reader', 'S'), ('calendar_data', 'aule_ingest', 'SIUD'), ('calendar_data', 'aule_config', 'S'),
    ('lessons', 'aule_ingest', 'SIUD'), ('lessons', 'aule_config', 'S'),
    ('calendar_runs', 'aule_ingest', 'SIUD'), ('calendar_runs', 'aule_config', 'S'),
    ('sync_runs', 'aule_reader', 'S'), ('sync_runs', 'aule_ingest', 'SIUD'), ('sync_runs', 'aule_config', 'S'),
    ('sync_run_calendars', 'aule_ingest', 'SIUD'), ('staged_calendars', 'aule_ingest', 'SIUD'),
    ('staged_lessons', 'aule_ingest', 'SIUD'), ('staged_rooms', 'aule_ingest', 'SIUD'),
    ('unique_lessons', 'aule_reader', 'S'), ('unique_lessons', 'aule_ingest', 'SIUD'),
    ('lesson_rooms', 'aule_reader', 'S'), ('lesson_rooms', 'aule_ingest', 'SIUD'),
    ('room_calendars', 'aule_reader', 'S'), ('room_calendars', 'aule_ingest', 'SIUD'),
    ('feed_rooms', 'aule_ingest', 'SIUD'),
    ('run_requests', 'aule_reader', 'S'), ('run_requests', 'aule_ingest', 'SU'), ('run_requests', 'aule_config', 'SU'),
    ('proposals', 'aule_ingest', 'SIUD'), ('proposals', 'aule_config', 'S'),
    ('discover_state', 'aule_ingest', 'SIUD'), ('discover_state', 'aule_config', 'S'),
    ('discover_failures', 'aule_ingest', 'SIUD'), ('discover_failures', 'aule_config', 'S'),
    ('room_view', 'aule_reader', 'S'), ('room_view', 'aule_config', 'S')$$,
  'table privileges are exactly the planned ones');
select is(
  (select count(*)::int from pg_class c
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(priv)
    where c.relnamespace = 'aule'::regnamespace and c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, p.priv)),
  0, 'nobody but the owner uses the aule sequences');
select set_eq(
  $$select p.proname::text, r.role from pg_proc p
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    where p.pronamespace = 'aule'::regnamespace
      and p.proname in ('plain', 'source_url_ok', 'all_hex24', 'texts_ok', 'synthetic_id', 'ms', 'from_ms', 'ms_exact',
        'rome_day', 'rome_midnight', 'rome_time', 'default_shape', 'source_rank')
      and has_function_privilege(r.role, p.oid, 'EXECUTE')$$,
  $$select h, r from unnest(array['plain', 'source_url_ok', 'all_hex24', 'texts_ok', 'synthetic_id', 'ms', 'from_ms', 'ms_exact',
      'rome_day', 'rome_midnight', 'rome_time', 'default_shape', 'source_rank']) as h
    cross join unnest(array['aule_reader', 'aule_ingest', 'aule_config']) as r$$,
  'helpers are executable only by aule_reader, aule_ingest and aule_config');
select results_eq(
  $$select count(*)::int, (count(*) filter (where prosecdef or proowner <> 'postgres'::regrole::oid))::int from pg_proc
    where pronamespace = 'aule'::regnamespace
      and proname in ('plain', 'source_url_ok', 'all_hex24', 'texts_ok', 'synthetic_id', 'ms', 'from_ms', 'ms_exact',
        'rome_day', 'rome_midnight', 'rome_time', 'default_shape', 'source_rank')$$,
  $$values (13, 0)$$,
  'the 13 helpers are owned by postgres and run as the caller');

-- Domains: one valid and one invalid value each.
select lives_ok($$select 'aaaaaaaaaaaaaaaaaaaaaaaa'::aule.hex24$$, 'hex24 accepts a lower case id');
select throws_ok($$select 'AAAAAAAAAAAAAAAAAAAAAAAA'::aule.hex24$$, '23514', null, 'hex24 rejects upper case');
select lives_ok($$select 'cubo-4d'::aule.campus_key$$, 'campus_key accepts a key');
select throws_ok($$select 'Cubo 4D'::aule.campus_key$$, '23514', null, 'campus_key rejects a name');
select lives_ok($$select 'Corso di prova 1° anno'::aule.label$$, 'label accepts a plain label');
select throws_ok($$select E'\u00a0Corso di prova'::aule.label$$, '23514', null, 'label rejects a leading NBSP');
select lives_ok($$select 12::aule.floor$$, 'floor accepts 12');
select throws_ok($$select 13::aule.floor$$, '23514', null, 'floor rejects 13');
select lives_ok($$select 1::aule.floor_count$$, 'floor_count accepts 1');
select throws_ok($$select 0::aule.floor_count$$, '23514', null, 'floor_count rejects 0');
select lives_ok($$select 0::aule.base_level$$, 'base_level accepts 0');
select throws_ok($$select (-1)::aule.base_level$$, '23514', null, 'base_level rejects -1');
select lives_ok($$select 'https://www.unical.it/didattica/orari/'::aule.source_url$$, 'source_url accepts a canonical Unical url');
select throws_ok($$select 'https://WWW.unical.it/didattica/orari/'::aule.source_url$$, '23514', null, 'source_url rejects an upper case host');
select lives_ok($$select 'aula mt1'::aule.search_text$$, 'search_text accepts a normalized query');
select throws_ok($$select 'aula  mt1'::aule.search_text$$, '23514', null, 'search_text rejects two spaces');
select lives_ok($$select date '2026-11-16'::aule.iso_day$$, 'iso_day accepts a day in range');
select throws_ok($$select date '2019-12-31'::aule.iso_day$$, '23514', null, 'iso_day rejects a day before 2020');
select lives_ok($$select '0880'::aule.portal_code$$, 'portal_code accepts a course code');
select throws_ok($$select 'tt0880'::aule.portal_code$$, '23514', null, 'portal_code rejects lower case');
select lives_ok($$select 'implausible'::aule.failure_code$$, 'failure_code accepts a known code');
select throws_ok($$select 'boom'::aule.failure_code$$, '23514', null, 'failure_code rejects an unknown code');
select lives_ok($$select 'not_html'::aule.discover_failure$$, 'discover_failure accepts a known code');
select throws_ok($$select 'timeout'::aule.discover_failure$$, '23514', null, 'discover_failure rejects a sync code');

-- Collation and helpers.
select ok('B9' < 'B10' collate aule."it_num", 'numeric collation puts B9 before B10');
select is(aule.ms(aule.from_ms(1794251741014)), 1794251741014::bigint, 'ms and from_ms round trip');
select is(aule.from_ms(0), timestamptz '1970-01-01 00:00:00+00', 'from_ms starts at the epoch');
select is(aule.ms(timestamptz '2026-11-16 10:30:00.123+00'), 1794825000123::bigint, 'ms keeps milliseconds');
select ok(aule.ms_exact(timestamptz '2026-11-16 10:30:00.123+00'), 'milliseconds are exact');
select ok(not aule.ms_exact(timestamptz '2026-11-16 10:30:00.1234+00'), 'microseconds are not exact');
select is(aule.rome_midnight('2026-11-16'), timestamptz '2026-11-15 23:00:00+00', 'Rome midnight in winter time');
select is(aule.rome_midnight('2026-07-01'), timestamptz '2026-06-30 22:00:00+00', 'Rome midnight in summer time');
select is(aule.rome_midnight('2026-03-29'), timestamptz '2026-03-28 23:00:00+00', 'Rome midnight on the spring change day');
select is(aule.rome_midnight('2026-03-30'), timestamptz '2026-03-29 22:00:00+00', 'Rome midnight after the spring change');
select is(aule.rome_midnight('2026-10-25'), timestamptz '2026-10-24 22:00:00+00', 'Rome midnight on the autumn change day');
select is(aule.rome_midnight('2026-10-26'), timestamptz '2026-10-25 23:00:00+00', 'Rome midnight after the autumn change');
select is(aule.rome_day(timestamptz '2026-11-08 23:30:00+00'), date '2026-11-09', 'Rome day after midnight');
select is(aule.rome_day(timestamptz '2026-11-08 22:59:59+00'), date '2026-11-08', 'Rome day before midnight');
select is(aule.rome_time('2027-03-28', '06:17'), timestamptz '2027-03-28 04:17:00+00', 'slot time in summer time on the change day');
select is(aule.rome_time('2026-10-25', '06:17'), timestamptz '2026-10-25 05:17:00+00', 'slot time in winter time on the change day');
select is(aule.synthetic_id('fffd', 'portal|0880'), 'fffd0fb7c092ebc04936d5c8', 'synthetic id matches the shared vector');
select ok(aule.plain('Corso di prova', 1, 160), 'plain accepts a plain value');
select ok(not aule.plain(E'\u00a0Corso', 1, 160), 'plain rejects a leading NBSP');
select ok(not aule.plain(E'Corso\ufeff', 1, 160), 'plain rejects a trailing U+FEFF');
select ok(not aule.plain(E'Corso\tdi prova', 1, 160), 'plain rejects control characters');
select ok(not aule.plain(null, 0, 160), 'plain rejects null');
select is(aule.default_shape('cubo-4d'), '{"floors":5,"baseLevel":0}'::jsonb, 'cubes get 5 floors');
select is(aule.default_shape('polifunzionale'), '{"floors":2,"baseLevel":0}'::jsonb, 'other buildings get 2 floors');
select ok(
  aule.source_rank('planner') < aule.source_rank('portal') and aule.source_rank('portal') < aule.source_rank('dimes')
    and aule.source_rank('dimes') < aule.source_rank('xlsx') and aule.source_rank('xlsx') < aule.source_rank('pdf'),
  'Planner has the highest priority');
select ok(aule.all_hex24(array['aaaaaaaaaaaaaaaaaaaaaaaa', 'fffd0fb7c092ebc04936d5c8']), 'all_hex24 accepts ids');
select ok(not aule.all_hex24(array['aaaaaaaaaaaaaaaaaaaaaaaa', null]), 'all_hex24 rejects a null element');
select ok(not aule.texts_ok(array['Mario Rossi', ' Luigi Bianchi'], 10, 121), 'texts_ok rejects a padded element');

-- Reference data from the generated migration.
select is((select count(*)::int from aule.campus_buildings), 140, '140 campus buildings');
select is((select count(*)::int from aule.room_seeds), 15, '15 room seeds');
select is((select count(*)::int from aule.calendars where source = 'planner' and active), 188, '188 active Planner calendars');
select is((select count(*)::int from aule.sources), 24, '24 source pages');
select is((select count(*)::int from aule.building_links), 4, '4 building links');
select is((select campus_key::text from aule.building_links where planner_name = 'Polifunzionale Capannone C'), 'capannone-c',
  'Capannone C of the Planner is placed on the map');
select is((select count(*)::int from aule.settings), 1, 'one settings row');
select is((select count(*)::int from aule.run_requests), 2, 'two request flags');
select is((select count(*)::int from aule.discover_state), 1, 'one discover state row');

-- Calendar checks.
select throws_ok(
  $$insert into aule.calendars (id, label) values ('fff000000000000000000000', 'Calendario di prova')$$,
  '23514', null, 'a Planner id with the synthetic prefix is rejected');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label) values ('aaaaaaaaaaaaaaaaaaaaaaaa', 'planner', '0880', 'Calendario di prova')$$,
  '23514', null, 'a Planner calendar has no ref');
select lives_ok(
  $$insert into aule.calendars (id, source, ref, label) values ('fffd0fb7c092ebc04936d5c8', 'portal', '0880', 'Corso di prova')$$,
  'a portal feed with its synthetic id is accepted');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label) values ('fffd00000000000000000000', 'portal', '0881', 'Corso di prova')$$,
  '23514', null, 'a portal feed id must equal its synthetic id');
select lives_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values (aule.synthetic_id('fffd', 'xlsx|LT|I ANNO - Esempio'), 'xlsx', 'LT|I ANNO - Esempio', 'Foglio di prova')$$,
  'an xlsx feed with a sheet identity is accepted');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values (aule.synthetic_id('fffd', 'dimes|non un url'), 'dimes', 'non un url', 'Corso di prova')$$,
  '23514', null, 'a dimes feed needs a canonical url');

-- Room view: admin link before the guessed key, admin floor before the seed.
delete from aule.calendar_data;
delete from aule.rooms;
insert into aule.rooms (id, name, code, building_name, services, building_key_guess, room_key, name_compact, search_text) values
  ('a00000000000000000000001', 'MT1', '', 'Cubo 31B', '{}', 'cubo-31b', 'mt1', 'mt1', 'mt1 cubo 31b'),
  ('a00000000000000000000002', 'Aula 1', '', 'Cubo 31B - Prova', '{}', 'cubo-31b', '1', 'aula1', 'aula 1 cubo 31b'),
  ('a00000000000000000000003', 'Lab', '', 'Edificio sconosciuto', '{}', 'edificio-sconosciuto', 'lab', 'lab', 'lab edificio sconosciuto');
insert into aule.building_links (planner_name, campus_key) values ('Cubo 31B - Prova', 'cubo-30b');
select results_eq(
  $$select building_key, floor, floor_source from aule.room_view where id = 'a00000000000000000000001'$$,
  $$values ('cubo-31b'::text, 0, 'seed'::text)$$,
  'a seeded room gets the seed floor');
select results_eq(
  $$select building_key from aule.room_view where id = 'a00000000000000000000002'$$,
  $$values ('cubo-30b'::text)$$,
  'the admin link wins over the guessed key');
select results_eq(
  $$select building_key, floor, floor_source from aule.room_view where id = 'a00000000000000000000003'$$,
  $$values (null::text, null::integer, null::text)$$,
  'an unknown building has no key and no floor');
insert into aule.room_floors (room_id, floor) values ('a00000000000000000000001', 3);
select results_eq(
  $$select building_key, floor, floor_source from aule.room_view where id = 'a00000000000000000000001'$$,
  $$values ('cubo-31b'::text, 3, 'admin'::text)$$,
  'the admin floor wins over the seed');
set local role aule_reader;
select set_config('aule_test.rooms', (select count(*)::text from aule.room_view), true);
reset role;
select is(current_setting('aule_test.rooms'), '3', 'aule_reader reads the room view');

select * from finish();
rollback;
