begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- Section 2.14 of the contract: every function of public, aule and aule_sync, its owner, security and grantees
-- (EXECUTE besides the owner). Anything else, or any difference, fails.
create temp table expected_fn (sig text primary key, owner text not null, definer boolean not null, grantees text[] not null);
insert into expected_fn (sig, owner, definer, grantees) values
  ('public.app_user_role()', 'postgres', true, '{}'),
  ('public.is_staff()', 'postgres', true, '{}'),
  ('public.is_admin()', 'postgres', true, '{aule_config}'),
  ('public.whoami()', 'postgres', true, '{authenticated}'),
  ('public.set_user_role(uuid, public.app_role)', 'postgres', true, '{authenticated}'),
  ('public.find_user(text)', 'postgres', true, '{authenticated}'),
  ('public.list_staff()', 'postgres', true, '{authenticated}'),
  ('public.is_unical_email(text)', 'postgres', false, '{supabase_auth_admin}'),
  ('public.hook_before_user_created(jsonb)', 'postgres', false, '{supabase_auth_admin}'),
  ('public.custom_access_token_hook(jsonb)', 'postgres', false, '{supabase_auth_admin}'),
  ('public.hook_password_verification_attempt(jsonb)', 'postgres', false, '{supabase_auth_admin}'),
  ('public.crowd_threshold()', 'postgres', false, '{aule_reader}'),
  ('public.is_valid_user(uuid)', 'postgres', true, '{aule_reader}'),
  ('public.review_request(uuid, public.request_status)', 'postgres', true, '{authenticated}'),
  ('public.my_requests()', 'postgres', true, '{authenticated}'),
  ('public.pending_requests()', 'postgres', true, '{authenticated}'),
  ('public.report_room(text, public.request_kind, public.issue_category, text)', 'postgres', true, '{authenticated}'),
  ('public.admin_overview()', 'aule_config', true, '{authenticated}'),
  ('public.admin_add_calendar(text, text)', 'aule_config', true, '{authenticated}'),
  ('public.admin_add_feed(text, text, text)', 'aule_config', true, '{authenticated}'),
  ('public.admin_set_calendar_active(text, boolean)', 'aule_config', true, '{authenticated}'),
  ('public.admin_remove_calendar(text)', 'aule_config', true, '{authenticated}'),
  ('public.admin_set_sources(text[])', 'aule_config', true, '{authenticated}'),
  ('public.admin_set_room_floor(text, integer)', 'aule_config', true, '{authenticated}'),
  ('public.admin_set_building_shape(text, integer, integer)', 'aule_config', true, '{authenticated}'),
  ('public.admin_link_building(text, text)', 'aule_config', true, '{authenticated}'),
  ('public.admin_request_sync()', 'aule_config', true, '{authenticated}'),
  ('public.admin_request_discover()', 'aule_config', true, '{authenticated}'),
  ('public.room_status()', 'aule_reader', true, '{anon}'),
  ('public.room_lessons(text, date, integer)', 'aule_reader', true, '{anon}'),
  ('public.search_rooms(text, boolean, integer, integer)', 'aule_reader', true, '{anon}'),
  ('public.sync_requests()', 'aule_reader', true, '{anon}'),
  ('aule_sync.ping()', 'aule_ingest', true, '{aule_sync}'),
  ('aule_sync.sync_begin(text)', 'aule_ingest', true, '{aule_sync}'),
  ('aule_sync.sync_put_calendar(bigint, text, jsonb)', 'aule_ingest', true, '{aule_sync}'),
  ('aule_sync.sync_fail_calendar(bigint, text, text)', 'aule_ingest', true, '{aule_sync}'),
  ('aule_sync.sync_finish(bigint)', 'aule_ingest', true, '{aule_sync}'),
  ('aule_sync.sync_abort(bigint, text)', 'aule_ingest', true, '{aule_sync}'),
  ('aule_sync.discover_begin()', 'aule_ingest', true, '{aule_sync}'),
  ('aule_sync.put_proposals(jsonb)', 'aule_ingest', true, '{aule_sync}'),
  ('aule.plain(text, integer, integer)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.source_url_ok(text)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.all_hex24(text[])', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.texts_ok(text[], integer, integer)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.synthetic_id(text, text)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.ms(timestamptz)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.from_ms(bigint)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.ms_exact(timestamptz)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.rome_day(timestamptz)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.rome_midnight(date)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.rome_time(date, time)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.default_shape(text)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.source_rank(aule.feed_source)', 'postgres', false, '{aule_reader,aule_ingest,aule_config}'),
  ('aule.refresh_timetable()', 'aule_ingest', true, '{aule_config,postgres}'),
  ('aule.active_overrides(timestamptz)', 'aule_reader', false, '{}'),
  ('aule.room_rows_at(timestamptz, text)', 'aule_reader', false, '{}'),
  ('aule.room_status_at(timestamptz)', 'aule_reader', false, '{}'),
  ('aule.room_lessons_at(timestamptz, text, date, integer)', 'aule_reader', false, '{}'),
  ('aule.search_at(timestamptz, text, boolean, integer, integer)', 'aule_reader', false, '{}'),
  ('aule.slot_due(timestamptz)', 'aule_reader', false, '{}'),
  ('aule.report_window(timestamptz, text, public.request_kind, text)', 'postgres', false, '{}'),
  ('aule.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz, text)', 'postgres', true, '{}'),
  ('aule.current_uid()', 'postgres', true, '{aule_config}'),
  ('aule.config_add_calendar(text, text, uuid)', 'aule_config', false, '{postgres}'),
  ('aule.config_add_feed(text, text, text, uuid)', 'aule_config', false, '{postgres}'),
  ('aule.config_rename_calendar(text, text)', 'aule_config', false, '{postgres}'),
  ('aule.config_set_calendar_active(text, boolean)', 'aule_config', false, '{postgres}'),
  ('aule.config_remove_calendar(text)', 'aule_config', false, '{postgres}'),
  ('aule.config_set_sources(text[])', 'aule_config', false, '{postgres}'),
  ('aule.config_set_room_floor(text, integer, uuid)', 'aule_config', false, '{postgres}'),
  ('aule.config_set_building_shape(text, integer, integer, uuid)', 'aule_config', false, '{postgres}'),
  ('aule.config_link_building(text, text, uuid)', 'aule_config', false, '{postgres}'),
  ('aule.config_request_run(text, uuid)', 'aule_config', false, '{postgres}'),
  ('aule.config_overview()', 'aule_config', false, '{postgres}');

create temp table checked_roles (role text primary key);
insert into checked_roles (role) values
  ('anon'), ('authenticated'), ('service_role'), ('aule_sync'), ('aule_reader'), ('aule_ingest'), ('aule_config');

-- Functions: inventory, owner, security and EXECUTE (grants through PUBLIC count).
select is_empty($$select sig from expected_fn where to_regprocedure(sig) is null$$, 'every function of the inventory exists');
select is_empty(
  $$select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'aule', 'aule_sync')
      and not exists (select 1 from expected_fn e where to_regprocedure(e.sig) = p.oid)$$,
  'no function in public, aule or aule_sync beyond the inventory');
select is_empty(
  $$select e.sig, pg_get_userbyid(p.proowner), p.prosecdef from expected_fn e join pg_proc p on p.oid = to_regprocedure(e.sig)
    where pg_get_userbyid(p.proowner) <> e.owner or p.prosecdef <> e.definer$$,
  'owner and security of every function as in the inventory');
select is_empty(
  $$select e.sig, r.role from expected_fn e cross join checked_roles r
    where e.sig like 'public.%' and to_regprocedure(e.sig) is not null
      and has_function_privilege(r.role, to_regprocedure(e.sig), 'EXECUTE') <> (r.role = e.owner or r.role = any (e.grantees))$$,
  'EXECUTE on public functions exactly for the owner and the listed roles');
select is_empty(
  $$select e.sig, r.role from expected_fn e cross join checked_roles r
    where e.sig like 'aule.%' and to_regprocedure(e.sig) is not null
      and has_function_privilege(r.role, to_regprocedure(e.sig), 'EXECUTE') <> (r.role = e.owner or r.role = any (e.grantees))$$,
  'EXECUTE on aule functions exactly for the owner and the listed roles');
select is_empty(
  $$select e.sig, r.role from expected_fn e cross join checked_roles r
    where e.sig like 'aule\_sync.%' and to_regprocedure(e.sig) is not null
      and has_function_privilege(r.role, to_regprocedure(e.sig), 'EXECUTE') <> (r.role = e.owner or r.role = any (e.grantees))$$,
  'EXECUTE on aule_sync functions exactly for the owner and aule_sync');
select is_empty(
  $$select e.sig from expected_fn e
    where 'postgres' = any (e.grantees) and not has_function_privilege('postgres', to_regprocedure(e.sig), 'EXECUTE')$$,
  'postgres runs refresh_timetable and aule.config_* from the SQL editor');
select is_empty(
  $$select e.sig from expected_fn e
    where 'supabase_auth_admin' = any (e.grantees) and not has_function_privilege('supabase_auth_admin', to_regprocedure(e.sig), 'EXECUTE')$$,
  'the auth hooks stay executable by supabase_auth_admin');
select hasnt_function('public', 'submit_request', 'public.submit_request is gone (report_room replaces it)');
select hasnt_function('public', 'get_request', 'public.get_request is gone');
select hasnt_function('public', 'public_room_overrides', 'public.public_room_overrides is gone');
select throws_ok($$select aule.config_add_feed('xlsx', 'LT|Foglio di prova', 'Foglio di prova', null)$$, 'P0001', 'invalid',
  'xlsx feeds never enter through the configuration API, not even as postgres');

-- Tables and the view of schema aule: exactly the privileges of section 2.6.
create temp table expected_tbl (tbl text, role text, privs text, primary key (tbl, role));
insert into expected_tbl (tbl, role, privs) values
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
  ('run_requests', 'aule_reader', 'S'), ('run_requests', 'aule_ingest', 'SU'), ('run_requests', 'aule_config', 'SU'),
  ('proposals', 'aule_ingest', 'SIUD'), ('proposals', 'aule_config', 'S'),
  ('discover_state', 'aule_ingest', 'SIUD'), ('discover_state', 'aule_config', 'S'),
  ('discover_failures', 'aule_ingest', 'SIUD'), ('discover_failures', 'aule_config', 'S'),
  ('room_view', 'aule_reader', 'S'), ('room_view', 'aule_config', 'S');
create temp table table_privs (ord integer, letter text, priv text);
insert into table_privs values (1, 'S', 'SELECT'), (2, 'I', 'INSERT'), (3, 'U', 'UPDATE'), (4, 'D', 'DELETE'),
  (5, 'T', 'TRUNCATE'), (6, 'R', 'REFERENCES'), (7, 'G', 'TRIGGER');

select set_eq(
  $$select c.relname::text from pg_class c where c.relnamespace = 'aule'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f')$$,
  $$select distinct tbl from expected_tbl$$,
  'every table and view of schema aule is in the privilege table');
select set_eq(
  $$select c.relname::text, r.role, string_agg(p.letter, '' order by p.ord)
    from pg_class c cross join checked_roles r cross join table_privs p
    where c.relnamespace = 'aule'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(r.role, c.oid, p.priv)
    group by 1, 2$$,
  $$select tbl, role, privs from expected_tbl$$,
  'privileges on every aule table and view exactly as in 2.6');
select is_empty(
  $$select c.relname, r.role, p.priv from pg_class c cross join checked_roles r
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(priv)
    where c.relnamespace = 'aule'::regnamespace and c.relkind = 'S' and has_sequence_privilege(r.role, c.oid, p.priv)$$,
  'no role uses the sequences of schema aule');

-- Tables of schema public: no table privilege for any role; only aule_reader reads some columns of room_requests.
select is_empty(
  $$select c.relname, r.role, p.priv from pg_class c cross join checked_roles r cross join table_privs p
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_table_privilege(r.role, c.oid, p.priv)$$,
  'no role has a table privilege in schema public');
select set_eq(
  $$select c.relname::text, r.role, p.priv from pg_class c cross join checked_roles r
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'REFERENCES']) as p(priv)
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f') and has_any_column_privilege(r.role, c.oid, p.priv)$$,
  $$values ('room_requests', 'aule_reader', 'SELECT')$$,
  'only aule_reader has a column privilege in schema public, SELECT on room_requests');

-- Schemas.
select set_eq(
  $$select n.nspname::text, r.role, p.priv from pg_namespace n cross join checked_roles r cross join unnest(array['USAGE', 'CREATE']) as p(priv)
    where n.nspname in ('aule', 'aule_sync') and has_schema_privilege(r.role, n.oid, p.priv)$$,
  $$values ('aule', 'aule_reader', 'USAGE'), ('aule', 'aule_ingest', 'USAGE'), ('aule', 'aule_config', 'USAGE'), ('aule_sync', 'aule_sync', 'USAGE')$$,
  'schema aule_sync is usable only by aule_sync, schema aule only by its three owner roles, nobody creates in them');
select is_empty(
  $$select r.role from checked_roles r where has_schema_privilege(r.role, 'public', 'CREATE')$$,
  'no role creates objects in schema public');

-- What aule_sync can reach: its 8 functions. pg_net functions, if the extension is on, are listed (it must be off in the cloud).
select diag('pg_net is installed: aule_sync can execute ' || string_agg(p.oid::regprocedure::text, ', ' order by p.oid::regprocedure::text)
    || '. Turn pg_net off in the cloud before giving aule_sync a login.')
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'net' and exists (select 1 from pg_extension where extname = 'pg_net')
  and has_schema_privilege('aule_sync', n.oid, 'USAGE') and has_function_privilege('aule_sync', p.oid, 'EXECUTE')
having count(*) > 0;
select set_eq(
  $$select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast_)?temp_'
      and not (n.nspname = 'net' and exists (select 1 from pg_extension where extname = 'pg_net'))
      and has_schema_privilege('aule_sync', n.oid, 'USAGE') and has_function_privilege('aule_sync', p.oid, 'EXECUTE')$$,
  $$select to_regprocedure(sig)::oid from expected_fn where sig like 'aule\_sync.%'$$,
  'aule_sync can execute exactly the 8 functions of schema aule_sync');

-- Default privileges: new objects in public are closed to anon, authenticated and PUBLIC.
create function public.probe_grants() returns integer language sql set search_path = '' as $$ select 1 $$;
create table public.probe_grants_table (id integer);
create sequence public.probe_grants_seq;
select is_empty(
  $$select r.role from unnest(array['anon', 'authenticated', 'public']) as r(role)
    where has_function_privilege(r.role, 'public.probe_grants()', 'EXECUTE')$$,
  'a new function in public is not executable by anon, authenticated or PUBLIC');
select is_empty(
  $$select r.role, p.priv from unnest(array['anon', 'authenticated', 'public']) as r(role) cross join table_privs p
    where has_table_privilege(r.role, 'public.probe_grants_table', p.priv)$$,
  'a new table in public has no privilege for anon, authenticated or PUBLIC');
select is_empty(
  $$select r.role, p.priv from unnest(array['anon', 'authenticated', 'public']) as r(role)
    cross join unnest(array['USAGE', 'SELECT', 'UPDATE']) as p(priv)
    where has_sequence_privilege(r.role, 'public.probe_grants_seq', p.priv)$$,
  'a new sequence in public has no privilege for anon, authenticated or PUBLIC');

-- aule_sync logs in and may create temp objects. With search_path = '' pg_temp is searched first for type names,
-- so a temp domain named like a built-in type would run its check as aule_ingest inside the aule_sync functions.
-- Every function and helper on that path must ignore such domains. Nothing above has called them in this session.
delete from aule.calendar_data;
delete from aule.rooms;
delete from aule.sync_runs;
delete from aule.proposals;
delete from aule.discover_failures;
update aule.calendars set active = false;
insert into aule.calendars (id, label) values ('121212121212121212121212', 'DIP · Calendario di prova');
update aule.settings set request_cooldown = interval '0 minutes';
update aule.discover_state set started_at = null, finished_at = null;

set local role aule_sync;
create function pg_temp.shadowed(v anyelement) returns pg_catalog.bool
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'shadowed' using errcode = 'P0001';
end $$;
create function pg_temp.exercise_sync() returns pg_catalog.text
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_out pg_catalog.text;
  v_begin pg_catalog.jsonb;
  v_result pg_catalog.jsonb;
  v_run pg_catalog.int8;
  v_from pg_catalog.int8;
begin
  begin
    v_out := 'ping ' || aule_sync.ping();
  exception when others then v_out := 'ping ' || sqlerrm;
  end;
  begin
    v_begin := aule_sync.sync_begin('manual');
    v_run := (v_begin ->> 'run')::pg_catalog.int8;
    v_from := (v_begin ->> 'from')::pg_catalog.int8;
    v_out := v_out || ', begin ok';
  exception when others then v_out := v_out || ', begin ' || sqlerrm;
  end;
  begin
    perform aule_sync.sync_put_calendar(v_run, '121212121212121212121212', jsonb_build_object(
      'from', v_from, 'to', (v_begin ->> 'to')::pg_catalog.int8, 'skipped', 0,
      'rooms', jsonb_build_array(jsonb_build_object('id', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'name', 'B6', 'code', 'AU_0001',
        'buildingName', 'Cubo 4D', 'capacity', 40, 'effectiveCapacity', 22, 'services', jsonb_build_array('Rete'),
        'buildingKeyGuess', 'cubo-4d', 'roomKey', 'b6', 'nameCompact', 'b6', 'searchText', 'b6 cubo 4d')),
      'lessons', jsonb_build_array(jsonb_build_object('id', 'cccccccccccccccccccccc01', 'title', 'ANALISI MATEMATICA I',
        'start', v_from + 86400000, 'end', v_from + 93600000, 'status', 'active', 'kind', 'ATTIVITA'' DIDATTICA',
        'courses', jsonb_build_array('CORSO DI LAUREA DI PROVA'), 'year', 1, 'teachers', jsonb_build_array('Mario Rossi'),
        'roomIds', jsonb_build_array('aaaaaaaaaaaaaaaaaaaaaaaa'), 'titleText', 'analisi matematica i',
        'directText', 'analisi matematica i mario rossi', 'courseText', 'corso di laurea di prova'))));
    v_out := v_out || ', put ok';
  exception when others then v_out := v_out || ', put ' || sqlerrm;
  end;
  begin
    v_result := aule_sync.sync_finish(v_run);
    v_out := v_out || ', finish ' || (v_result ->> 'state') || ' ' || (v_result ->> 'lessons');
  exception when others then v_out := v_out || ', finish ' || sqlerrm;
  end;
  begin
    v_begin := aule_sync.sync_begin('poll');
    v_run := (v_begin ->> 'run')::pg_catalog.int8;
    perform aule_sync.sync_fail_calendar(v_run, '121212121212121212121212', 'network');
    v_out := v_out || ', fail ok';
  exception when others then v_out := v_out || ', fail ' || sqlerrm;
  end;
  begin
    perform aule_sync.sync_abort(v_run, 'timeout');
    v_out := v_out || ', abort ok';
  exception when others then v_out := v_out || ', abort ' || sqlerrm;
  end;
  begin
    v_result := aule_sync.discover_begin();
    v_result := aule_sync.put_proposals(jsonb_build_object(
      'items', jsonb_build_array(jsonb_build_object('id', '343434343434343434343434', 'label', 'DIP · Corso nuovo',
        'source', v_result -> 'sources' ->> 0)),
      'failures', jsonb_build_array()));
    v_out := v_out || ', proposals ' || (v_result ->> 'found');
  exception when others then v_out := v_out || ', proposals ' || sqlerrm;
  end;
  return v_out;
end $$;
create domain pg_temp.text as pg_catalog.text check (pg_temp.shadowed(value));
create domain pg_temp.jsonb as pg_catalog.jsonb check (pg_temp.shadowed(value));
create domain pg_temp.json as pg_catalog.json check (pg_temp.shadowed(value));
create domain pg_temp.timestamptz as pg_catalog.timestamptz check (pg_temp.shadowed(value));
create domain pg_temp.date as pg_catalog.date check (pg_temp.shadowed(value));
create domain pg_temp.uuid as pg_catalog.uuid check (pg_temp.shadowed(value));
create domain pg_temp.bool as pg_catalog.bool check (pg_temp.shadowed(value));
create domain pg_temp.int2 as pg_catalog.int2 check (pg_temp.shadowed(value));
create domain pg_temp.int4 as pg_catalog.int4 check (pg_temp.shadowed(value));
create domain pg_temp.int8 as pg_catalog.int8 check (pg_temp.shadowed(value));
create domain pg_temp.float8 as pg_catalog.float8 check (pg_temp.shadowed(value));
create domain pg_temp.name as pg_catalog.name check (pg_temp.shadowed(value));
create temp table shadow_outcome as select pg_temp.exercise_sync() as outcome;
grant select on shadow_outcome to postgres;
drop domain pg_temp.text, pg_temp.jsonb, pg_temp.json, pg_temp.timestamptz, pg_temp.date, pg_temp.uuid, pg_temp.bool,
  pg_temp.int2, pg_temp.int4, pg_temp.int8, pg_temp.float8, pg_temp.name;
reset role;
select is((select outcome from shadow_outcome),
  'ping ok, begin ok, put ok, finish finished 1, fail ok, abort ok, proposals 1',
  'temp types named like built-in types never reach the code aule_sync runs as aule_ingest');

select * from finish();
rollback;
