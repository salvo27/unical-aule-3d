begin;
create extension if not exists pgtap with schema extensions;
select plan(123);

-- Runs one statement as a user (null = anon). Result as text, 'ok' for void, or '!<sqlstate>' with the closed code.
create function pg_temp.as_user(p_user text, q text)
returns text
language plpgsql
as $$
declare
  r text;
begin
  if p_user is null then
    set local role anon;
    perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  else
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  end if;
  execute q into r;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return coalesce(nullif(r, ''), 'ok');
exception when others then
  return '!' || sqlstate || case when sqlstate = 'P0001' or sqlerrm = 'forbidden' then ' ' || sqlerrm else '' end;
end
$$;
create function pg_temp.adm(q text) returns text language sql as $$
  select pg_temp.as_user('70000000-0000-0000-0000-000000000001', q)
$$;
-- A JSON answer, or the error wrapped so a check fails instead of the whole file.
create function pg_temp.j(p text) returns jsonb language sql immutable as $$
  select case when p like '{%' then p::jsonb else jsonb_build_object('error', p) end
$$;
create function pg_temp.keys(p jsonb) returns text[] language sql immutable as $$
  select array(select k from jsonb_object_keys(p) as k order by k collate "C")
$$;
create function pg_temp.room(p_id text, p_name text, p_building text, p_guess text) returns void language sql as $$
  insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key,
    name_compact, search_text)
  values (p_id, p_name, 'AU_1', p_building, 40, 22, '{}', p_guess, lower(p_name), lower(p_name), lower(p_name || ' au_1 ' || p_building))
$$;
create function pg_temp.lesson(p_cal text, p_id text, p_room text) returns void language sql as $$
  insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
    title_text, direct_text, course_text)
  values (p_cal, p_id, 'Analisi', aule.from_ms(aule.ms(now())), aule.from_ms(aule.ms(now())) + interval '2 hours', 'active', '', '{}',
    null, '{}', array[p_room], 'analisi', 'analisi', 'analisi')
$$;

-- Reference data written by the migrations.
select ok(
  (select count(*) from aule.settings) = 1
    and (select array_agg(kind::text order by kind) from aule.run_requests) = array['sync', 'discover']
    and (select count(*) from aule.discover_state) = 1
    and (select count(*) from aule.calendars where source = 'planner') > 0
    and (select count(*) from aule.sources) > 0
    and (select count(*) from aule.campus_buildings) > 0,
  'reference data present after migrations');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin.uno@unical.it', now()),
  ('70000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin.due@unical.it', now()),
  ('70000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'moderatore@unical.it', now()),
  ('70000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente@studenti.unical.it', now());
insert into public.user_roles (user_id, role) values
  ('70000000-0000-0000-0000-000000000001', 'admin'),
  ('70000000-0000-0000-0000-000000000002', 'admin'),
  ('70000000-0000-0000-0000-000000000003', 'moderator');

delete from aule.calendar_data;
delete from aule.rooms;
delete from aule.sync_runs;
delete from aule.unique_lessons;
delete from aule.lesson_rooms;
delete from aule.room_calendars;
delete from aule.room_floors;
delete from aule.building_links;
delete from aule.building_shapes;
delete from aule.proposals;
delete from aule.discover_failures;
update aule.discover_state set started_at = null, finished_at = null, found = 0;
update aule.run_requests set pending = false, requested_at = null, requested_by = null, served_at = null;
insert into aule.campus_buildings (key, name) values ('prova-a', 'Edificio di prova A'), ('prova-b', 'Edificio di prova B');
do $$ begin perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'B6', 'Cubo di prova', 'prova-a'); end $$;

-- Nobody but an admin reaches the admin API.
create temp table admin_calls (q text primary key);
insert into admin_calls (q) values
  ('select public.admin_overview()'),
  ('select public.admin_add_calendar(''0a0a0a0a0a0a0a0a0a0a0a09'', ''Prova'')'),
  ('select public.admin_add_feed(''portal'', ''0880'', ''Prova'')'),
  ('select public.admin_set_calendar_active(''0a0a0a0a0a0a0a0a0a0a0a09'', false)'),
  ('select public.admin_remove_calendar(''0a0a0a0a0a0a0a0a0a0a0a09'')'),
  ('select public.admin_set_sources(array[''https://dip.unical.it/x''])'),
  ('select public.admin_set_room_floor(''aaaaaaaaaaaaaaaaaaaaaaaa'', 1)'),
  ('select public.admin_set_building_shape(''prova-a'', 3, 0)'),
  ('select public.admin_link_building(''Polo'', ''prova-a'')'),
  ('select public.admin_request_sync()'),
  ('select public.admin_request_discover()');
select is(array(select pg_temp.as_user(null, q) from admin_calls order by q), array_fill('!42501'::text, array[11]),
  'anon cannot execute any admin function');
select is(array(select pg_temp.as_user('70000000-0000-0000-0000-000000000004', q) from admin_calls order by q),
  array_fill('!42501 forbidden'::text, array[11]), 'a student gets forbidden from every admin function');
select is(array(select pg_temp.as_user('70000000-0000-0000-0000-000000000003', q) from admin_calls order by q),
  array_fill('!42501 forbidden'::text, array[11]), 'a moderator gets forbidden from every admin function');
select is((select count(*)::int from aule.calendars where id = '0a0a0a0a0a0a0a0a0a0a0a09' or (source = 'portal' and ref = '0880')), 0, 'refused calls change nothing');
select is(pg_temp.adm($$select aule.config_overview()$$), '!42501', 'aule.config_* are not reachable through the API, not even by an admin');
select is(pg_temp.as_user('70000000-0000-0000-0000-000000000004', $$select aule.config_add_calendar('0a0a0a0a0a0a0a0a0a0a0a09', 'Prova', null)$$), '!42501',
  'authenticated cannot execute aule.config_add_calendar');
select ok(aule.config_overview() ? 'campus', 'postgres runs aule.config_overview from the SQL editor');

-- Add, toggle and remove a calendar.
select is(pg_temp.adm($$select public.admin_add_calendar('0a0a0a0a0a0a0a0a0a0a0a01', 'Corso di prova 1° anno')$$), 'ok', 'admins add a Planner calendar');
select results_eq(
  $$select source::text, ref, label::text, active from aule.calendars where id = '0a0a0a0a0a0a0a0a0a0a0a01'$$,
  $$values ('planner', null::text, 'Corso di prova 1° anno', true)$$,
  'the calendar is stored active as a Planner feed');
select is(pg_temp.adm($$select public.admin_set_calendar_active('0a0a0a0a0a0a0a0a0a0a0a01', false)$$), 'ok', 'admins deactivate a calendar');
select is((select active from aule.calendars where id = '0a0a0a0a0a0a0a0a0a0a0a01'), false, 'the calendar is inactive');
select is(pg_temp.adm($$select public.admin_set_calendar_active('0a0a0a0a0a0a0a0a0a0a0a01', null)$$), '!P0001 invalid', 'active must be a boolean');
select is(pg_temp.adm($$select public.admin_remove_calendar('0a0a0a0a0a0a0a0a0a0a0a01')$$), 'ok', 'admins remove a calendar');
select is((select count(*)::int from aule.calendars where id = '0a0a0a0a0a0a0a0a0a0a0a01'), 0, 'the calendar is gone');

-- Calendar references are validated; failed calls change nothing.
select is(pg_temp.adm($$select public.admin_add_calendar('0a0a0a0a0a0a0a0a0a0a0a02', 'Corso di prova B')$$), 'ok', 'a second calendar');
select is(pg_temp.adm($$select public.admin_add_calendar('https://unical.prod.up.cineca.it/calendarioPubblico/linkCalendarioId=0a0a0a0a0a0a0a0a0a0a0a01', 'A')$$),
  '!P0001 calendar_ref', 'a link is refused: the browser extracts the id');
select is(pg_temp.adm($$select public.admin_add_calendar('0a0a0a0a0a0a0a0a0a0a0a0', 'A')$$), '!P0001 calendar_ref', 'a 23 character id is refused');
select is(pg_temp.adm($$select public.admin_add_calendar('0A0A0A0A0A0A0A0A0A0A0A01', 'A')$$), '!P0001 calendar_ref', 'upper case hex is refused');
select is(pg_temp.adm($$select public.admin_add_calendar('fffd0a0a0a0a0a0a0a0a0a01', 'A')$$), '!P0001 calendar_ref', 'a synthetic id is not a Planner calendar');
select is(pg_temp.adm($$select public.admin_add_calendar('0a0a0a0a0a0a0a0a0a0a0a02', 'Altro nome')$$), '!P0001 calendar_exists', 'the same calendar twice is refused');
select is(pg_temp.adm($$select public.admin_remove_calendar('0a0a0a0a0a0a0a0a0a0a0a01')$$), '!P0001 calendar_missing', 'removing a missing calendar is refused');
select is(pg_temp.adm($$select public.admin_set_calendar_active('0a0a0a0a0a0a0a0a0a0a0a01', true)$$), '!P0001 calendar_missing', 'toggling a missing calendar is refused');
select results_eq(
  $$select id::text, label::text from aule.calendars where id like '0a0a%'$$,
  $$values ('0a0a0a0a0a0a0a0a0a0a0a02', 'Corso di prova B')$$,
  'failed calls change nothing');

-- Labels are never trimmed in SQL; renaming happens from the SQL editor.
select is(pg_temp.adm($$select public.admin_add_calendar('0a0a0a0a0a0a0a0a0a0a0a03', ' Nome')$$), '!P0001 label', 'a label with a leading space is refused');
select is(pg_temp.adm(format('select public.admin_add_calendar(%L, %L)', '0a0a0a0a0a0a0a0a0a0a0a03', 'Nome' || chr(160))), '!P0001 label',
  'a label ending with a non breaking space is refused');
select is(pg_temp.adm($$select public.admin_add_calendar('0a0a0a0a0a0a0a0a0a0a0a03', '')$$), '!P0001 label', 'an empty label is refused');
select lives_ok($$select aule.config_rename_calendar('0a0a0a0a0a0a0a0a0a0a0a02', 'Nuovo nome di prova')$$, 'aule.config_rename_calendar renames');
select is((select label::text from aule.calendars where id = '0a0a0a0a0a0a0a0a0a0a0a02'), 'Nuovo nome di prova', 'the new label is stored');
select throws_ok($$select aule.config_rename_calendar('0a0a0a0a0a0a0a0a0a0a0a03', 'Nome')$$, 'P0001', 'calendar_missing', 'renaming a missing calendar is refused');
select throws_ok($$select aule.config_rename_calendar('0a0a0a0a0a0a0a0a0a0a0a02', 'Nome ')$$, 'P0001', 'label', 'a label with a trailing space is refused');
select throws_ok($$select aule.config_rename_calendar('x', 'Nome')$$, 'P0001', 'invalid', 'renaming needs a calendar id');

-- Feeds of other sources get the synthetic id of source and reference.
select is(pg_temp.adm($$select public.admin_add_feed('portal', '0880', 'Corso dal portale di prova')$$), 'ok', 'admins add a portal feed');
select results_eq(
  $$select id::text, source::text, ref, active from aule.calendars where source = 'portal' and ref = '0880'$$,
  $$values ('fffd0fb7c092ebc04936d5c8', 'portal', '0880', true)$$,
  'the portal feed gets the synthetic id of source and code');
select is(pg_temp.adm($$select public.admin_add_feed('portal', '0880', 'Ancora')$$), '!P0001 calendar_exists', 'the same feed twice is refused');
select is(pg_temp.adm($$select public.admin_add_feed('portal', '08 80', 'Corso')$$), '!P0001 feed_ref', 'a bad portal code gives feed_ref');
select is(pg_temp.adm($$select public.admin_add_feed('portal', 'abc', 'Corso')$$), '!P0001 feed_ref', 'a lower case portal code gives feed_ref');
select is(pg_temp.adm($$select public.admin_add_feed('pdf', 'https://www.unical.it/orario-di-prova.pdf', 'Orario PDF di prova')$$), 'ok',
  'a PDF feed takes a canonical unical URL');
select is(pg_temp.adm($$select public.admin_add_feed('pdf', 'https://example.com/orario.pdf', 'Orario')$$), '!P0001 feed_ref', 'a PDF feed elsewhere gives feed_ref');
select is(pg_temp.adm($$select public.admin_add_feed('planner', '0880', 'Corso')$$), '!P0001 invalid', 'Planner calendars use admin_add_calendar');
select is(pg_temp.adm($$select public.admin_add_feed('portal', '0881', ' Corso')$$), '!P0001 label', 'feeds follow the label rules');

-- xlsx feeds come only from their generated migration; existing ones stay manageable.
select is(pg_temp.adm($$select public.admin_add_feed('xlsx', 'LT|I ANNO - Prova', 'Foglio di prova')$$), '!P0001 invalid', 'admins cannot add an xlsx feed');
select throws_ok($$select aule.config_add_feed('xlsx', 'LT|I ANNO - Prova', 'Foglio di prova', null)$$, 'P0001', 'invalid', 'not even from the SQL editor');
insert into aule.calendars (id, source, ref, label) values (aule.synthetic_id('fffd', 'xlsx|LT|Foglio di prova'), 'xlsx', 'LT|Foglio di prova', 'Foglio xlsx di prova');
select is(pg_temp.adm(format('select public.admin_set_calendar_active(%L, false)', aule.synthetic_id('fffd', 'xlsx|LT|Foglio di prova'))), 'ok',
  'an existing xlsx feed can be deactivated');
select is(pg_temp.adm(format('select public.admin_set_calendar_active(%L, true)', aule.synthetic_id('fffd', 'xlsx|LT|Foglio di prova'))), 'ok',
  'and activated again');
select lives_ok(format('select aule.config_rename_calendar(%L, %L)', aule.synthetic_id('fffd', 'xlsx|LT|Foglio di prova'), 'Foglio xlsx rinominato'),
  'and renamed');

-- Sources: only canonical https pages on unical.it, duplicates removed, at most 60.
select is(pg_temp.adm($$select public.admin_set_sources(array['https://dip.unical.it/a', 'https://dip.unical.it/b', 'https://dip.unical.it/a'])$$), 'ok',
  'admins replace the source pages');
select is(array(select url::text from aule.sources order by position), array['https://dip.unical.it/a', 'https://dip.unical.it/b'],
  'duplicates are removed keeping the first position');
select is(pg_temp.adm($$select public.admin_set_sources(array['https://DIP.unical.it/a'])$$), '!P0001 source_url', 'an upper case host is not canonical');
select is(pg_temp.adm($$select public.admin_set_sources(array['https://dip.unical.it/a#x'])$$), '!P0001 source_url', 'a hash is refused');
select is(pg_temp.adm($$select public.admin_set_sources(array['https://example.com/'])$$), '!P0001 source_url', 'other hosts are refused');
select is(pg_temp.adm($$select public.admin_set_sources(array['http://dip.unical.it/a'])$$), '!P0001 source_url', 'plain http is refused');
select is(pg_temp.adm($$select public.admin_set_sources(array['https://dip.unical.it/a', null])$$), '!P0001 invalid', 'a null page is invalid');
select is(pg_temp.adm($$select public.admin_set_sources(null)$$), '!P0001 invalid', 'a null list is invalid');
select is(pg_temp.adm($$select public.admin_set_sources(array(select 'https://dip.unical.it/' || g from generate_series(1, 61) g))$$),
  '!P0001 too_many_sources', '61 pages are too many');
select is(array(select url::text from aule.sources order by position), array['https://dip.unical.it/a', 'https://dip.unical.it/b'],
  'failed calls keep the sources');

-- Room floors: set and cleared, only for rooms in the timetable (removing a calendar above dropped rooms without lessons).
delete from aule.rooms where id = 'aaaaaaaaaaaaaaaaaaaaaaaa';
do $$ begin perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'B6', 'Cubo di prova', 'prova-a'); end $$;
select is(pg_temp.adm($$select public.admin_set_room_floor('aaaaaaaaaaaaaaaaaaaaaaaa', 2)$$), 'ok', 'admins set a room floor');
select results_eq($$select floor, floor_source from aule.room_view where id = 'aaaaaaaaaaaaaaaaaaaaaaaa'$$, $$values (2, 'admin')$$,
  'the admin floor is used at once');
select is((select updated_by::text from aule.room_floors where room_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'), '70000000-0000-0000-0000-000000000001',
  'the floor records who set it');
select is(pg_temp.adm($$select public.admin_set_room_floor('aaaaaaaaaaaaaaaaaaaaaaaa', null)$$), 'ok', 'admins clear a room floor');
select is((select count(*)::int from aule.room_floors), 0, 'the floor row is gone');
select is(pg_temp.adm($$select public.admin_set_room_floor('aaaaaaaaaaaaaaaaaaaaaaaa', 99)$$), '!P0001 floor', 'floor 99 is refused');
select is(pg_temp.adm($$select public.admin_set_room_floor('bbbbbbbbbbbbbbbbbbbbbbbb', 1)$$), '!P0001 not_found', 'a room not in the timetable is not found');
select is(pg_temp.adm($$select public.admin_set_room_floor('x', 1)$$), '!P0001 invalid', 'a bad room id is invalid');

-- Building shapes and links only for campus buildings.
select is(pg_temp.adm($$select public.admin_set_building_shape('prova-a', 6, 1)$$), 'ok', 'admins set a building shape');
select is(pg_temp.adm($$select public.admin_set_building_shape('cubo-99z', 6, 1)$$), '!P0001 unknown_building', 'a building off the map is refused');
select is(pg_temp.adm($$select public.admin_set_building_shape('prova-a', 16, 1)$$), '!P0001 floor_count', '16 floors are refused');
select is(pg_temp.adm($$select public.admin_set_building_shape('prova-a', 6, 13)$$), '!P0001 base_level', 'a base level of 13 is refused');
select is(pg_temp.adm($$select public.admin_link_building('Polo didattico di prova', 'prova-b')$$), 'ok', 'admins link a Planner building');
select is((select campus_key::text from aule.building_links where planner_name = 'Polo didattico di prova'), 'prova-b', 'the link is stored');
select is(pg_temp.adm($$select public.admin_link_building('X', 'missing')$$), '!P0001 unknown_building', 'a link to a building off the map is refused');
select is(pg_temp.adm(format('select public.admin_link_building(%L, %L)', repeat('x', 101), 'prova-a')), '!P0001 building_name',
  'a Planner building name has at most 100 characters');
select is(pg_temp.adm($$select public.admin_link_building('Polo didattico di prova', null)$$), 'ok', 'admins remove a link');
select is((select count(*)::int from aule.building_links), 0, 'the link is gone');

-- Invalid values never reach the tables, whoever writes them.
select throws_ok($$insert into aule.calendars (id, label) values ('bad', 'x')$$, '23514', null, 'a bad calendar id is rejected by its domain');
select throws_ok($$insert into aule.calendars (id, label) values ('0a0a0a0a0a0a0a0a0a0a0a08', ' x')$$, '23514', null, 'a label with a leading space is rejected');
select throws_ok($$insert into aule.calendars (id, source, ref, label) values ('fffd00000000000000000000', 'portal', '0880', 'x')$$, '23514', null,
  'a feed id must be the synthetic id of its reference');
select throws_ok($$insert into aule.sources (position, url) values (60, 'http://dip.unical.it/a')$$, '23514', null, 'a non canonical source is rejected');
select throws_ok($$insert into aule.room_floors (room_id, floor) values ('aaaaaaaaaaaaaaaaaaaaaaaa', 99)$$, '23514', null, 'floor 99 is rejected');
select throws_ok($$insert into aule.building_shapes (key, floors, base_level) values ('prova-b', 0, 0)$$, '23514', null, 'zero floors are rejected');

-- Limits hold.
insert into aule.calendars (id, label)
select '9' || lpad(to_hex(g), 23, '0'), 'Riempitivo' from generate_series(1, 600 - (select count(*)::int from aule.calendars)) g;
select is((select count(*)::int from aule.calendars), 600, 'fixture: 600 calendars');
select is(pg_temp.adm($$select public.admin_add_calendar('0a0a0a0a0a0a0a0a0a0a0a03', 'Corso in piu')$$), '!P0001 too_many_calendars',
  'with 600 calendars the next one is refused');
select is(pg_temp.adm($$select public.admin_add_feed('portal', 'ZZ99', 'Corso in piu')$$), '!P0001 too_many_calendars', 'feeds count too');
delete from aule.calendars where label = 'Riempitivo';
insert into aule.building_links (planner_name, campus_key) select 'Edificio ' || g, 'prova-a' from generate_series(1, 300) g;
select is(pg_temp.adm($$select public.admin_link_building('Edificio nuovo', 'prova-a')$$), '!P0001 too_many_links', 'the 301st link is refused');
select is(pg_temp.adm($$select public.admin_link_building('Edificio 1', 'prova-b')$$), 'ok', 'an existing link can still change');
delete from aule.building_links;
insert into aule.campus_buildings (key, name) select 'riempitivo-' || g, 'Riempitivo ' || g from generate_series(1, 300) g;
insert into aule.building_shapes (key, floors, base_level) select 'riempitivo-' || g, 2, 0 from generate_series(1, 299) g;
select is(pg_temp.adm($$select public.admin_set_building_shape('prova-b', 3, 0)$$), '!P0001 too_many_buildings', 'the 301st shape is refused');
select is(pg_temp.adm($$select public.admin_set_building_shape('prova-a', 4, 0)$$), 'ok', 'an existing shape can still change');
delete from aule.campus_buildings where key like 'riempitivo-%';
insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key, name_compact, search_text)
select 'e' || lpad(to_hex(g), 23, '0'), 'R' || g, '', 'Cubo di prova', null, null, '{}', 'prova-a', 'r' || g, 'r' || g, 'r' || g
from generate_series(1, 3000) g;
insert into aule.room_floors (room_id, floor) select 'e' || lpad(to_hex(g), 23, '0'), 1 from generate_series(1, 3000) g;
select is(pg_temp.adm($$select public.admin_set_room_floor('aaaaaaaaaaaaaaaaaaaaaaaa', 1)$$), '!P0001 too_many_rooms', 'the 3001st room floor is refused');
delete from aule.room_floors;
delete from aule.rooms where id like 'eeee%';

-- Removing a calendar is immediate; deactivating waits for the next sync finish.
insert into aule.calendars (id, label) values ('0a0a0a0a0a0a0a0a0a0a0a03', 'Corso C'), ('0a0a0a0a0a0a0a0a0a0a0a04', 'Corso D');
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to) values
  ('0a0a0a0a0a0a0a0a0a0a0a03', now(), now() - interval '168 hours', now() + interval '336 hours'),
  ('0a0a0a0a0a0a0a0a0a0a0a04', now(), now() - interval '168 hours', now() + interval '336 hours');
do $$ begin
  perform pg_temp.room('a3a3a3a3a3a3a3a3a3a3a3a3', 'C3', 'Cubo di prova', 'prova-a');
  perform pg_temp.room('a4a4a4a4a4a4a4a4a4a4a4a4', 'C4', 'Cubo di prova', 'prova-a');
  perform pg_temp.lesson('0a0a0a0a0a0a0a0a0a0a0a03', 'cccccccccccccccccccccc03', 'a3a3a3a3a3a3a3a3a3a3a3a3');
  perform pg_temp.lesson('0a0a0a0a0a0a0a0a0a0a0a04', 'cccccccccccccccccccccc04', 'a4a4a4a4a4a4a4a4a4a4a4a4');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.adm($$select public.admin_remove_calendar('0a0a0a0a0a0a0a0a0a0a0a03')$$), 'ok', 'admins remove a calendar with data');
select is((select count(*)::int from aule.lessons where calendar_id = '0a0a0a0a0a0a0a0a0a0a0a03'), 0, 'its lessons are gone at once');
select is(array(select id::text from aule.rooms where id in ('a3a3a3a3a3a3a3a3a3a3a3a3', 'a4a4a4a4a4a4a4a4a4a4a4a4') order by 1),
  array['a4a4a4a4a4a4a4a4a4a4a4a4'], 'its orphan room is gone, the other room stays');
select is(
  (select count(*)::int from aule.unique_lessons where id = 'cccccccccccccccccccccc03')
    + (select count(*)::int from aule.lesson_rooms where room_id = 'a3a3a3a3a3a3a3a3a3a3a3a3')
    + (select count(*)::int from aule.room_calendars where calendar_id = '0a0a0a0a0a0a0a0a0a0a0a03'),
  0, 'the derived rows are rebuilt at once');
select is(pg_temp.adm($$select public.admin_set_calendar_active('0a0a0a0a0a0a0a0a0a0a0a04', false)$$), 'ok', 'admins deactivate a calendar with data');
select is((select count(*)::int from aule.lessons where calendar_id = '0a0a0a0a0a0a0a0a0a0a0a04'), 1,
  'its data stays until the next sync finish');

-- Run requests: one flag per kind, at most one request per 15 minutes for everybody.
select is(pg_temp.adm($$select public.admin_request_sync()$$), jsonb_build_object('requestedAt', aule.ms(now()))::text, 'admins request a sync');
select results_eq($$select pending, requested_by::text from aule.run_requests where kind = 'sync'$$,
  $$values (true, '70000000-0000-0000-0000-000000000001')$$, 'the flag is set with the last requester');
select is(pg_temp.as_user('70000000-0000-0000-0000-000000000002', $$select public.admin_request_sync()$$), '!P0001 too_soon',
  'a second request within 15 minutes, by another admin too, is too soon');
select is(pg_temp.as_user(null, $$select public.sync_requests() ->> 'sync'$$), 'true', 'the sync workflow sees the request');
update aule.run_requests set requested_at = now() - interval '16 minutes' where kind = 'sync';
select is(pg_temp.as_user('70000000-0000-0000-0000-000000000002', $$select public.admin_request_sync() ? 'requestedAt'$$), 'true',
  'after 15 minutes a new request passes');
select is(pg_temp.adm($$select public.admin_request_discover()$$), jsonb_build_object('requestedAt', aule.ms(now()))::text, 'admins request a discover');

-- The overview has every key the admin page reads.
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed, failure)
values ('schedule', 'aborted', now() - interval '2 hours', now() - interval '2 hours', now() - interval '110 minutes',
  now() - interval '168 hours', now() + interval '336 hours', 3, 0, 'implausible');
insert into aule.proposals (calendar_id, label, source) values
  ('0b0b0b0b0b0b0b0b0b0b0b02', 'Corso proposto B', 'https://dip.unical.it/a'),
  ('0b0b0b0b0b0b0b0b0b0b0b01', 'Corso proposto A', 'https://dip.unical.it/a'),
  ('0a0a0a0a0a0a0a0a0a0a0a02', 'Corso gia presente', 'https://dip.unical.it/a');
insert into aule.discover_failures (position, source, failure) values (1, 'https://dip.unical.it/b', 'http_status');
update aule.discover_state set started_at = now() - interval '10 minutes', finished_at = now() - interval '9 minutes', found = 3;
create temp table ov as select pg_temp.j(pg_temp.adm('select public.admin_overview()')) as j;
select is((select pg_temp.keys(j) from ov),
  array['buildingLinks', 'calendars', 'campus', 'now', 'proposals', 'rooms', 'shapes', 'sources', 'sync', 'unmatchedBuildings'],
  'admin_overview has every top level key');
select is((select pg_temp.keys(j -> 'sync') from ov), array['lastGoodAt', 'lastRun', 'late', 'requested', 'running'], 'sync keys');
select is((select pg_temp.keys(j #> '{sync,lastRun}') from ov),
  array['failed', 'failure', 'finishedAt', 'id', 'ok', 'outcome', 'startedAt', 'state', 'trigger'], 'last run keys');
select is((select j #> '{sync,requested}' from ov),
  jsonb_build_object('sync', jsonb_build_object('pending', true, 'at', aule.ms(now())),
    'discover', jsonb_build_object('pending', true, 'at', aule.ms(now()))),
  'both request flags with their time');
select is((select pg_temp.keys(c) from ov, jsonb_array_elements(j -> 'calendars') c where c ->> 'id' = '0a0a0a0a0a0a0a0a0a0a0a04'),
  array['active', 'addedAt', 'fetchedAt', 'id', 'label', 'ref', 'run', 'source'], 'calendar keys');
select is((select pg_temp.keys(j -> 'proposals') from ov), array['at', 'failures', 'found', 'items', 'startedAt'], 'proposal keys');
select is((select pg_temp.keys(r) from ov, jsonb_array_elements(j -> 'rooms') r where r ->> 'id' = 'a4a4a4a4a4a4a4a4a4a4a4a4'),
  array['buildingKey', 'buildingName', 'capacity', 'floor', 'floorSource', 'id', 'name'], 'room keys');
select is((select pg_temp.keys(c) from ov, jsonb_array_elements(j -> 'campus') c where c ->> 'key' = 'prova-a'), array['key', 'name'], 'campus keys');
select is((select (j #> '{sync,lastRun}') - 'id' - 'startedAt' - 'finishedAt' from ov),
  '{"trigger": "schedule", "state": "aborted", "outcome": "failed", "failure": "implausible", "ok": 3, "failed": 0}'::jsonb,
  'an implausible run shows as failed with its reason');
select is((select (j #> '{sync,late}') || (j #> '{sync,lastGoodAt}') || (j #> '{sync,running}') from ov), '[true, null, false]'::jsonb,
  'late without a good run');
select is((select (j -> 'proposals') - 'startedAt' - 'at' from ov),
  jsonb_build_object('found', 3,
    'failures', jsonb_build_array(jsonb_build_object('source', 'https://dip.unical.it/b', 'failure', 'http_status')),
    'items', jsonb_build_array(
      jsonb_build_object('id', '0b0b0b0b0b0b0b0b0b0b0b01', 'label', 'Corso proposto A', 'source', 'https://dip.unical.it/a'),
      jsonb_build_object('id', '0b0b0b0b0b0b0b0b0b0b0b02', 'label', 'Corso proposto B', 'source', 'https://dip.unical.it/a'))),
  'proposals without known calendars, ordered by label');
select is((select c from ov, jsonb_array_elements(j -> 'calendars') c where c ->> 'id' = '0a0a0a0a0a0a0a0a0a0a0a04') - 'addedAt',
  jsonb_build_object('id', '0a0a0a0a0a0a0a0a0a0a0a04', 'source', 'planner', 'ref', null, 'label', 'Corso D', 'active', false, 'run', null,
    'fetchedAt', aule.ms(now())),
  'a calendar with its data and no run yet');
select is((select j -> 'shapes' from ov), '{"prova-a": {"floors": 4, "baseLevel": 0}}'::jsonb, 'only stored shapes');
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed)
values ('manual', 'finished', now() - interval '28 hours', now() - interval '28 hours', now() - interval '27 hours',
  now() - interval '168 hours', now() + interval '336 hours', 5, 0);
select is((select (j #> '{sync,late}') || (j #> '{sync,lastGoodAt}') from (select pg_temp.j(pg_temp.adm('select public.admin_overview()')) as j) x),
  jsonb_build_array(true, aule.ms(now() - interval '27 hours')), 'late when the last good run is older than 26 hours');
update aule.sync_runs set finished_at = now() - interval '1 hour' where trigger = 'manual';
select is((select (j #> '{sync,late}') || (j #> '{sync,lastRun,outcome}') from (select pg_temp.j(pg_temp.adm('select public.admin_overview()')) as j) x),
  '[false, "completed"]'::jsonb, 'not late after a recent good run');

-- Hostile inputs give only codes of the browser list.
select is(pg_temp.adm(format('select public.admin_add_calendar(%L, %L)', '0a0a0a0a0a0a0a0a0a0a0a05', repeat('x', 10240))), '!P0001 label', 'a 10 KB label gives label');
select is(pg_temp.adm(format('select public.admin_add_calendar(%L, %L)', '0a0a0a0a0a0a0a0a0a0a0a05', 'Nome' || chr(1) || 'x')), '!P0001 label',
  'a control character gives label');
select is(pg_temp.adm(format('select public.admin_add_calendar(%L, %L)', repeat('0', 10240), 'Nome')), '!P0001 calendar_ref', 'a 10 KB id gives calendar_ref');
select is(pg_temp.adm($$select public.admin_set_sources(array(select 'https://dip.unical.it/' || g from generate_series(1, 1000) g))$$),
  '!P0001 too_many_sources', 'an array of 1000 urls gives too_many_sources');
select is(pg_temp.adm(format('select public.admin_set_sources(array[%L])', 'https://dip.unical.it/' || repeat('x', 10240))), '!P0001 source_url',
  'a 10 KB url gives source_url');
select is(pg_temp.adm(format('select public.admin_link_building(%L, %L)', repeat('x', 10240), 'prova-a')), '!P0001 label', 'a 10 KB building name gives label');
select is(pg_temp.adm(format('select public.admin_add_feed(%L, %L, %L)', repeat('p', 10240), '0880', 'Corso')), '!P0001 invalid', 'a 10 KB source gives invalid');
select is(pg_temp.adm(format('select public.admin_set_building_shape(%L, 3, 0)', repeat('a', 10240))), '!P0001 unknown_building',
  'a 10 KB building key gives unknown_building');

select * from finish();
rollback;
