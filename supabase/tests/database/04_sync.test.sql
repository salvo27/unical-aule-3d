begin;
create extension if not exists pgtap with schema extensions;
select plan(119);

-- Runs one statement as aule_sync. Result as text, 'void', or '!<sqlstate>' with the message of P0001 errors.
create function pg_temp.as_sync(q text, p jsonb default null)
returns text
language plpgsql
as $$
declare
  r text;
begin
  set local role aule_sync;
  if p is null then
    execute q into r;
  else
    execute q into r using p;
  end if;
  reset role;
  return coalesce(nullif(r, ''), 'void');
exception when others then
  return '!' || sqlstate || case when sqlstate = 'P0001' then ' ' || sqlerrm else '' end;
end
$$;

create temp table t04 (k text primary key, v jsonb not null);

create function pg_temp.j(p text) returns jsonb language sql immutable as $$
  select case when p like '{%' then p::jsonb else jsonb_build_object('error', p) end
$$;
create function pg_temp.rid(p_key text) returns bigint language sql stable as $$
  select (v ->> 'run')::bigint from pg_temp.t04 where k = p_key
$$;
create function pg_temp.run() returns bigint language sql stable as $$
  select id from aule.sync_runs where state = 'open'
$$;
-- The run window of every begin in this transaction, since now() is fixed.
create function pg_temp.base() returns bigint language sql stable as $$
  select aule.ms(aule.rome_midnight(aule.rome_day(now()) - s.window_back_days)) from aule.settings s
$$;
create function pg_temp.top() returns bigint language sql stable as $$
  select aule.ms(aule.rome_midnight(aule.rome_day(now()) + s.window_ahead_days)) from aule.settings s
$$;
create function pg_temp.at(p_hours integer) returns bigint language sql stable as $$
  select pg_temp.base() + p_hours * 3600000::bigint
$$;
create function pg_temp.ts(p_hours integer) returns timestamptz language sql stable as $$
  select aule.from_ms(pg_temp.at(p_hours))
$$;
create function pg_temp.room(p_id text, p_key text) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'name', upper(p_key), 'code', '', 'buildingName', 'Cubo 31B', 'capacity', 100,
    'effectiveCapacity', null, 'services', jsonb_build_array('Proiettore'), 'buildingKeyGuess', 'cubo-31b',
    'roomKey', p_key, 'nameCompact', p_key, 'searchText', p_key || ' cubo 31b')
$$;
create function pg_temp.lesson(p_id text, p_hours integer, p_rooms text[]) returns jsonb language sql stable as $$
  select jsonb_build_object('id', p_id, 'title', 'Analisi matematica', 'start', pg_temp.at(p_hours),
    'end', pg_temp.at(p_hours + 2), 'status', 'active', 'kind', 'ATTIVITA'' DIDATTICA',
    'courses', jsonb_build_array('Ingegneria informatica'), 'year', 1, 'teachers', jsonb_build_array('Mario Rossi'),
    'roomIds', to_jsonb(p_rooms), 'titleText', 'analisi matematica', 'directText', 'analisi matematica mario rossi',
    'courseText', 'analisi matematica mario rossi ingegneria informatica')
$$;
create function pg_temp.payload(p_rooms jsonb, p_lessons jsonb, p_from bigint default null, p_to bigint default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('from', coalesce(p_from, pg_temp.base()), 'to', coalesce(p_to, pg_temp.top()), 'skipped', 0,
    'rooms', p_rooms, 'lessons', p_lessons)
$$;
create function pg_temp.put(p_calendar text, p_payload jsonb) returns text language sql as $$
  select pg_temp.as_sync(format('select aule_sync.sync_put_calendar(%s, %L, $1)', coalesce(pg_temp.run(), 0), p_calendar), p_payload)
$$;
create function pg_temp.fail(p_calendar text, p_code text) returns text language sql as $$
  select pg_temp.as_sync(format('select aule_sync.sync_fail_calendar(%s, %L, %L)', coalesce(pg_temp.run(), 0), p_calendar, p_code))
$$;
create function pg_temp.finish(p_run bigint) returns text language sql as $$
  select pg_temp.as_sync(format('select aule_sync.sync_finish(%s)', coalesce(p_run, 0)))
$$;
create function pg_temp.timetable() returns text language sql stable as $$
  select concat_ws(' | ',
    (select string_agg(l.calendar_id || ':' || l.id || ':' || aule.ms(l.starts_at), ',' order by l.calendar_id, l.id) from aule.lessons l),
    (select string_agg(r.id || ':' || r.name, ',' order by r.id) from aule.rooms r),
    (select string_agg(u.id || ':' || u.calendar_id, ',' order by u.id) from aule.unique_lessons u),
    (select string_agg(c.calendar_id || ':' || c.outcome || ':' || c.lessons, ',' order by c.calendar_id) from aule.calendar_runs c),
    (select string_agg(d.calendar_id || ':' || aule.ms(d.fetched_at), ',' order by d.calendar_id) from aule.calendar_data d))
$$;

-- Fixtures: P1..P5 Planner calendars (P5 inactive), X1 a portal feed added first, old data for P1, P2, P3.
delete from aule.sync_runs;
delete from aule.calendars;
delete from aule.rooms;
delete from aule.unique_lessons;
delete from aule.lesson_rooms;
delete from aule.room_calendars;
delete from aule.proposals;
delete from aule.discover_failures;
delete from aule.sources;
update aule.run_requests set pending = false, requested_at = null, requested_by = null, served_at = null;
update aule.discover_state set started_at = null, finished_at = null, found = 0;

insert into aule.calendars (id, source, ref, label, active, added_at) values
  ('fffd0fb7c092ebc04936d5c8', 'portal', '0880', 'Corso di prova', true, timestamptz '2026-01-01 00:00:00+00'),
  ('111111111111111111111111', 'planner', null, 'Calendario uno', true, timestamptz '2026-02-01 00:00:00+00'),
  ('222222222222222222222222', 'planner', null, 'Calendario due', true, timestamptz '2026-02-02 00:00:00+00'),
  ('333333333333333333333333', 'planner', null, 'Calendario tre', true, timestamptz '2026-02-03 00:00:00+00'),
  ('444444444444444444444444', 'planner', null, 'Calendario quattro', true, timestamptz '2026-02-04 00:00:00+00'),
  ('555555555555555555555555', 'planner', null, 'Calendario cinque', false, timestamptz '2026-02-05 00:00:00+00');
insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key, name_compact, search_text) values
  ('aaaaaaaaaaaaaaaaaaaaaaaa', 'MT1', '', 'Cubo 31B', 100, null, '{}', 'cubo-31b', 'mt1', 'mt1', 'mt1 cubo 31b'),
  ('bbbbbbbbbbbbbbbbbbbbbbbb', 'MT2', '', 'Cubo 31B', 100, null, '{}', 'cubo-31b', 'mt2', 'mt2', 'mt2 cubo 31b'),
  ('cccccccccccccccccccccccc', 'B6', '', 'Cubo 30B', 40, null, '{}', 'cubo-30b', 'b6', 'b6', 'b6 cubo 30b'),
  ('dddddddddddddddddddddddd', 'Sala', '', 'Edificio ignoto', null, null, '{}', null, 'sala', 'sala', 'sala edificio ignoto'),
  ('777777777777777777777777', '-', '', 'Cubo 31B', null, null, '{}', 'cubo-31b', '', '-', '- cubo 31b'),
  ('ffff00000000000000000001', 'Laboratorio', '', 'Cubo 31B', null, null, '{}', 'cubo-31b', 'laboratorio', 'laboratorio', 'laboratorio cubo 31b');
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to) values
  ('111111111111111111111111', now() - interval '20 hours', pg_temp.ts(-24), pg_temp.ts(480)),
  ('222222222222222222222222', now() - interval '40 hours', pg_temp.ts(-24), pg_temp.ts(480)),
  ('333333333333333333333333', now() - interval '20 hours', pg_temp.ts(-24), pg_temp.ts(480));
insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
  title_text, direct_text, course_text)
select v.c, v.l, 'Analisi matematica', pg_temp.ts(v.h), pg_temp.ts(v.h + 2), 'active', 'Lezione', '{Ingegneria informatica}', 1,
  '{Mario Rossi}', array[v.r], 'analisi matematica', 'analisi matematica mario rossi',
  'analisi matematica mario rossi ingegneria informatica'
from (values
  ('111111111111111111111111', '1a0000000000000000000000', 100, 'aaaaaaaaaaaaaaaaaaaaaaaa'),
  ('222222222222222222222222', '1a0000000000000000000002', 300, 'bbbbbbbbbbbbbbbbbbbbbbbb'),
  ('222222222222222222222222', '2b0000000000000000000001', 310, 'bbbbbbbbbbbbbbbbbbbbbbbb'),
  ('333333333333333333333333', '3c0000000000000000000001', 150, 'cccccccccccccccccccccccc')
) as v(c, l, h, r);
insert into aule.calendar_runs (calendar_id, at, outcome, failure, lessons) values
  ('111111111111111111111111', now() - interval '20 hours', 'ok', null, 1),
  ('222222222222222222222222', now() - interval '40 hours', 'ok', null, 2),
  ('333333333333333333333333', now() - interval '20 hours', 'ok', null, 1);
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed, rooms, lessons) values
  ('schedule', 'finished', now() - interval '1441 hours', now() - interval '1441 hours', now() - interval '1440 hours',
    pg_temp.ts(0), pg_temp.ts(480), 3, 0, 3, 4),
  ('schedule', 'finished', now() - interval '1000 hours', now() - interval '1000 hours', now() - interval '999 hours',
    pg_temp.ts(0), pg_temp.ts(480), 3, 0, 3, 4);
update aule.run_requests set pending = true, requested_at = now() - interval '1 minute' where kind = 'sync';

-- What aule_sync can reach.
select is(
  (select count(*)::int from pg_class c
    where c.relnamespace = 'aule'::regnamespace and c.relkind in ('r', 'v')
      and has_table_privilege('aule_sync', c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')),
  0, 'aule_sync has no privilege on any aule table');
select is(pg_temp.as_sync('select count(*) from aule.rooms'), '!42501', 'aule_sync cannot read aule tables');
select is(pg_temp.as_sync('select count(*) from public.room_requests'), '!42501', 'aule_sync cannot read the requests');
select ok(not has_schema_privilege('aule_sync', 'aule', 'USAGE'), 'aule_sync cannot use schema aule');
select is(pg_temp.as_sync('select aule.refresh_timetable()'), '!42501', 'aule_sync cannot rebuild the timetable');
select is(
  pg_temp.as_sync($$select public.set_user_role('10000000-0000-0000-0000-000000000001', 'admin')$$),
  '!42501', 'aule_sync cannot run admin functions');
select case when to_regprocedure('public.room_status()') is null
  then pass('aule_sync cannot read the room status')
  else is(pg_temp.as_sync('select public.room_status()'), '!42501', 'aule_sync cannot read the room status')
end;
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace in ('public'::regnamespace, 'aule'::regnamespace) and has_function_privilege('aule_sync', p.oid, 'EXECUTE')),
  0, 'aule_sync can execute no function in public or aule');
select set_eq(
  $$select p.proname::text from pg_proc p where p.pronamespace = 'aule_sync'::regnamespace$$,
  array['ping', 'sync_begin', 'sync_put_calendar', 'sync_fail_calendar', 'sync_finish', 'sync_abort', 'discover_begin', 'put_proposals'],
  'schema aule_sync has exactly the 8 sync functions');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'aule_sync'::regnamespace
      and (not p.prosecdef or p.proowner <> 'aule_ingest'::regrole or not coalesce(p.proconfig @> array['search_path=""'], false))),
  0, 'the sync functions run as aule_ingest with an empty search_path');
select set_eq(
  $$select p.proname::text, r.role from pg_proc p
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'postgres', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    where p.pronamespace = 'aule_sync'::regnamespace and has_function_privilege(r.role, p.oid, 'EXECUTE')$$,
  $$select f, r from unnest(array['ping', 'sync_begin', 'sync_put_calendar', 'sync_fail_calendar', 'sync_finish', 'sync_abort',
      'discover_begin', 'put_proposals']) as f
    cross join unnest(array['aule_sync', 'aule_ingest']) as r$$,
  'only aule_sync and the owner execute the sync functions');
select set_eq(
  $$select r.role from unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_reader', 'aule_ingest', 'aule_config', 'aule_sync']) as r(role)
    where has_schema_privilege(r.role, 'aule_sync', 'USAGE') or has_schema_privilege(r.role, 'aule_sync', 'CREATE')$$,
  array['aule_sync'],
  'only aule_sync uses schema aule_sync');
select ok(not has_schema_privilege('aule_sync', 'aule_sync', 'CREATE'), 'aule_sync cannot create in its schema');
select ok(
  (select p.prosecdef and p.proowner = 'aule_ingest'::regrole from pg_proc p where p.oid = 'aule.refresh_timetable()'::regprocedure),
  'refresh_timetable runs as aule_ingest');
select set_eq(
  $$select r.role from unnest(array['public', 'anon', 'authenticated', 'service_role', 'postgres', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    where has_function_privilege(r.role, 'aule.refresh_timetable()'::regprocedure, 'EXECUTE')$$,
  array['aule_ingest', 'aule_config', 'postgres'],
  'refresh_timetable is executable by aule_config and postgres only');
select is(pg_temp.as_sync('select aule_sync.ping()'), 'ok', 'ping answers ok');

-- Begin.
select is(pg_temp.as_sync($$select aule_sync.sync_begin('bad')$$), '!P0001 invalid', 'an unknown trigger is invalid');
select is(pg_temp.as_sync('select aule_sync.sync_begin(null)'), '!P0001 invalid', 'a missing trigger is invalid');
insert into t04 values ('b1', pg_temp.j(pg_temp.as_sync($$select aule_sync.sync_begin('poll')$$)));
select is(pg_temp.rid('b1'), pg_temp.run(), 'begin opens a run and returns its id');
select is(
  (select array[(v ->> 'from')::bigint, (v ->> 'to')::bigint] from t04 where k = 'b1'),
  array[aule.ms(aule.rome_midnight(aule.rome_day(now()) - 7)), aule.ms(aule.rome_midnight(aule.rome_day(now()) + 15))],
  'the window goes from Rome midnight 7 days back to Rome midnight 15 days ahead');
select is(
  (select v -> 'calendars' from t04 where k = 'b1'),
  '[{"id": "111111111111111111111111", "source": "planner", "ref": null},
    {"id": "222222222222222222222222", "source": "planner", "ref": null},
    {"id": "333333333333333333333333", "source": "planner", "ref": null},
    {"id": "444444444444444444444444", "source": "planner", "ref": null},
    {"id": "fffd0fb7c092ebc04936d5c8", "source": "portal", "ref": "0880"}]'::jsonb,
  'begin lists the active feeds, Planner first, with source and ref');
select is(
  (select v -> 'rooms' from t04 where k = 'b1'),
  '[{"id": "aaaaaaaaaaaaaaaaaaaaaaaa", "buildingKey": "cubo-31b", "roomKey": "mt1"},
    {"id": "bbbbbbbbbbbbbbbbbbbbbbbb", "buildingKey": "cubo-31b", "roomKey": "mt2"},
    {"id": "cccccccccccccccccccccccc", "buildingKey": "cubo-30b", "roomKey": "b6"}]'::jsonb,
  'the room directory has only Planner rooms with a building key and a room key');
select is((select trigger::text from aule.sync_runs where id = pg_temp.rid('b1')), 'request', 'poll with a pending request is stored as request');
select results_eq(
  $$select pending, served_at = now() from aule.run_requests where kind = 'sync'$$,
  $$values (false, true)$$,
  'begin clears the sync request made before it');
select is((select count(*)::int from aule.sync_run_calendars where run_id = pg_temp.rid('b1')), 5, 'the run holds one row per active feed');
select is(pg_temp.as_sync($$select aule_sync.sync_begin('manual')$$), '!P0001 run_open', 'a second begin while the run is alive gives run_open');

-- Put and fail.
select is(
  pg_temp.put('111111111111111111111111', pg_temp.payload(
    jsonb_build_array(pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'mt1'), pg_temp.room('eeeeeeeeeeeeeeeeeeeeeeee', 'mt5')),
    jsonb_build_array(pg_temp.lesson('1a0000000000000000000001', 200, '{aaaaaaaaaaaaaaaaaaaaaaaa}'),
      pg_temp.lesson('1a0000000000000000000002', 204, '{eeeeeeeeeeeeeeeeeeeeeeee}')))),
  'void', 'a valid Planner calendar is accepted');
select results_eq(
  $$select (select lessons from aule.staged_calendars where calendar_id = '111111111111111111111111' and outcome = 'ok'),
    (select count(*)::int from aule.staged_lessons where calendar_id = '111111111111111111111111'),
    (select count(*)::int from aule.staged_rooms)$$,
  $$values (2, 2, 2)$$,
  'its lessons and rooms are staged');
select is(
  pg_temp.put('111111111111111111111111', pg_temp.payload('[]', '[]')),
  '!P0001 calendar_done', 'a second put of the same calendar gives calendar_done');
select is(pg_temp.fail('222222222222222222222222', 'network'), 'void', 'a failed calendar is recorded');
select is(pg_temp.fail('333333333333333333333333', 'boom'), '!P0001 invalid', 'an unknown failure code is invalid');
select is(
  pg_temp.put('555555555555555555555555', pg_temp.payload('[]', '[]')),
  '!P0001 calendar_unknown', 'an inactive calendar is not part of the run');
select is(pg_temp.fail('999999999999999999999999', 'network'), '!P0001 calendar_unknown', 'an unknown calendar gives calendar_unknown');
select is(pg_temp.put('XYZ', pg_temp.payload('[]', '[]')), '!P0001 invalid', 'a malformed calendar id is invalid');

select is(
  pg_temp.put('333333333333333333333333', jsonb_build_object('from', pg_temp.base(), 'to', pg_temp.top(), 'skipped', 0,
    'rooms', '[]'::jsonb, 'lessons', (select jsonb_agg('{}'::jsonb) from generate_series(1, 20001)))),
  '!P0001 payload_size', '20001 lessons exceed the size limit');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload('[]', '[]') || '{"extra": 1}'),
  '!P0001 payload_shape', 'an extra key gives payload_shape');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, '{cccccccccccccccccccccccc}') - 'kind'))),
  '!P0001 payload_shape', 'a lesson without a key gives payload_shape');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('CCCCCCCCCCCCCCCCCCCCCCCC', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, '{CCCCCCCCCCCCCCCCCCCCCCCC}')))),
  '!P0001 payload_value', 'a bad room id gives payload_value');
select is(
  array(select pg_temp.put('333333333333333333333333', pg_temp.payload(
      jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
      jsonb_build_array(pg_temp.lesson(p.id, 200, '{cccccccccccccccccccccccc}'))))
    from unnest(array['fffd00000000000000000009', 'ffff00000000000000000009', 'fff000000000000000000009']) p(id)),
  array_fill('!P0001 payload_value'::text, array[3]),
  'a Planner lesson id with a synthetic prefix other than fffe gives payload_value');
select is(
  array(select pg_temp.put('333333333333333333333333', pg_temp.payload(
      jsonb_build_array(pg_temp.room(p.id, 'lab9')),
      jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, array[p.id]))))
    from unnest(array['ffff00000000000000000009', 'fffe00000000000000000009', 'fffd00000000000000000009']) p(id)),
  array_fill('!P0001 payload_value'::text, array[3]),
  'a Planner room id with any fff prefix gives payload_value');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, '{cccccccccccccccccccccccc}')
      || jsonb_build_object('title', repeat('è', 301))))),
  '!P0001 payload_value', 'a title of 301 characters gives payload_value');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, '{cccccccccccccccccccccccc}')),
    pg_temp.base() - 3600000)),
  '!P0001 payload_window', 'a coverage starting before the run window gives payload_window');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', -2, '{cccccccccccccccccccccccc}')))),
  '!P0001 payload_window', 'a lesson ending at the start of the coverage gives payload_window');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, '{cccccccccccccccccccccccc}')
      || jsonb_build_object('kind', 'Prenotazione aula')))),
  '!P0001 payload_value', 'a Planner booking with its free text title gives payload_value');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, '{cccccccccccccccccccccccc}')
      || jsonb_build_object('kind', 'Esame', 'title', 'Esame', 'titleText', 'esame', 'directText', 'esame', 'courseText', 'esame')))),
  '!P0001 payload_value', 'a Planner exam with its label but still with teachers and courses gives payload_value');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 'b6')),
    jsonb_build_array(pg_temp.lesson('3c0000000000000000000002', 200, '{cccccccccccccccccccccccc}')
      || jsonb_build_object('kind', '', 'title', 'Altro impegno', 'titleText', 'altro impegno', 'directText', 'altro impegno mario rossi',
        'courseText', 'altro impegno mario rossi', 'teachers', '[]'::jsonb, 'courses', '[]'::jsonb)))),
  '!P0001 payload_value', 'an event without a lesson type whose search text names a person gives payload_value');
select results_eq(
  $$select (select count(*)::int from aule.staged_calendars where calendar_id = '333333333333333333333333'),
    (select count(*)::int from aule.staged_lessons where calendar_id = '333333333333333333333333'),
    (select count(*)::int from aule.staged_rooms)$$,
  $$values (0, 0, 2)$$,
  'rejected payloads stage nothing');
select is(
  pg_temp.put('333333333333333333333333', pg_temp.payload(
    (select jsonb_agg(jsonb_build_object('id', 'c' || lpad(to_hex(i), 23, '0'), 'name', repeat('à', 100), 'code', repeat('c', 50),
        'buildingName', repeat('è', 100), 'capacity', 5000, 'effectiveCapacity', 5000,
        'services', (select jsonb_agg(repeat('s', 60)) from generate_series(1, 15)),
        'buildingKeyGuess', repeat('k', 80), 'roomKey', repeat('r', 100), 'nameCompact', repeat('à', 100),
        'searchText', repeat('ò', 400)) order by i)
      from generate_series(1, 10) as i),
    jsonb_build_array(jsonb_build_object('id', '5e0000000000000000000001', 'title', repeat('è', 300),
      'start', pg_temp.at(150), 'end', pg_temp.at(162), 'status', 'cancelled',
      'kind', 'ATTIVITA' || repeat('''', 83) || 'DIDATTICA',
      'courses', (select jsonb_agg(repeat('c', 200)) from generate_series(1, 10)), 'year', 6,
      'teachers', (select jsonb_agg(repeat('t', 121)) from generate_series(1, 10)),
      'roomIds', (select jsonb_agg('c' || lpad(to_hex(i), 23, '0') order by i) from generate_series(1, 10) as i),
      'titleText', repeat('è', 300), 'directText', repeat('d', 2000), 'courseText', repeat('c', 5000)),
    pg_temp.lesson('5e0000000000000000000002', 150, '{c00000000000000000000001}')
      || jsonb_build_object('kind', 'Esame scritto', 'title', 'Esame', 'titleText', 'esame', 'directText', 'esame', 'courseText', 'esame',
        'teachers', '[]'::jsonb, 'courses', '[]'::jsonb),
    pg_temp.lesson('5e0000000000000000000003', 152, '{c00000000000000000000001}') || jsonb_build_object('kind', 'Attività  didattica')))),
  'void', 'a lesson with every field at its limit is accepted');
select results_eq(
  $$select ends_at - starts_at, cardinality(room_ids), char_length(title), char_length(course_text)
    from aule.staged_lessons where calendar_id = '333333333333333333333333' and id = '5e0000000000000000000001'$$,
  $$values (interval '12 hours', 10, 300, 5000)$$,
  'the maximum lesson is staged whole');
select results_eq(
  $$select id::text, title, teachers from aule.staged_lessons
    where calendar_id = '333333333333333333333333' and id <> '5e0000000000000000000001' order by id$$,
  $$values ('5e0000000000000000000002'::text, 'Esame'::text, '{}'::text[]),
    ('5e0000000000000000000003', 'Analisi matematica', '{Mario Rossi}')$$,
  'a Planner event that is not a lesson is accepted with only its label, a lesson type in any case keeps its details');

-- Portal feed: its own rooms are synthetic, a Planner room is referenced only when known.
select is(
  pg_temp.put('fffd0fb7c092ebc04936d5c8', pg_temp.payload('[]',
    jsonb_build_array(pg_temp.lesson('fffe00000000000000000001', 200, '{99999999999999999999abcd}')),
    pg_temp.at(24), pg_temp.top() - 86400000)),
  '!P0001 payload_value', 'a portal lesson cannot point at an unknown room');
select is(
  pg_temp.put('fffd0fb7c092ebc04936d5c8', pg_temp.payload(
    jsonb_build_array(pg_temp.room('abababababababababababab', 'lab2')),
    jsonb_build_array(pg_temp.lesson('fffe00000000000000000001', 200, '{abababababababababababab}')),
    pg_temp.at(24), pg_temp.top() - 86400000)),
  '!P0001 payload_value', 'portal rooms must be synthetic');
select is(
  pg_temp.put('fffd0fb7c092ebc04936d5c8', pg_temp.payload('[]',
    jsonb_build_array(pg_temp.lesson('1a0000000000000000000009', 200, '{aaaaaaaaaaaaaaaaaaaaaaaa}')),
    pg_temp.at(24), pg_temp.top() - 86400000)),
  '!P0001 payload_value', 'portal lesson ids must be synthetic');
select is(
  pg_temp.put('fffd0fb7c092ebc04936d5c8', pg_temp.payload(
    jsonb_build_array(pg_temp.room('ffff00000000000000000002', 'lab2')),
    jsonb_build_array(pg_temp.lesson('fffe00000000000000000001', 200, '{aaaaaaaaaaaaaaaaaaaaaaaa}'),
      pg_temp.lesson('fffe00000000000000000002', 220, '{ffff00000000000000000002}')),
    pg_temp.at(24), pg_temp.top() - 86400000)),
  'void', 'a portal calendar may point at an existing Planner room');
select is(
  pg_temp.put('444444444444444444444444', pg_temp.payload(
    jsonb_build_array(pg_temp.room('666666666666666666666666', 'mt6')),
    jsonb_build_array(pg_temp.lesson('4d0000000000000000000001', 210, '{666666666666666666666666}')))),
  'void', 'a calendar removed later is staged');

-- Finish: P3 deactivated and P4 removed during the run.
update aule.calendars set active = false where id = '333333333333333333333333';
delete from aule.calendars where id = '444444444444444444444444';
insert into t04 values ('f1', pg_temp.j(pg_temp.finish(pg_temp.rid('b1'))));
select is(
  (select v from t04 where k = 'f1'),
  jsonb_build_object('run', pg_temp.rid('b1'), 'state', 'finished', 'failure', null, 'ok', 2, 'failed', 1, 'rooms', 4, 'lessons', 6),
  'finish publishes the run and returns its counts');
select set_eq(
  $$select id::text from aule.lessons where calendar_id = '111111111111111111111111'$$,
  array['1a0000000000000000000001', '1a0000000000000000000002'],
  'an ok calendar is replaced');
select results_eq(
  $$select outcome::text, failure::text, lessons, at = now() from aule.calendar_runs where calendar_id = '111111111111111111111111'$$,
  $$values ('ok'::text, null::text, 2, true)$$,
  'an ok calendar is recorded with its lessons');
select set_eq(
  $$select id::text from aule.lessons where calendar_id = '222222222222222222222222'$$,
  array['1a0000000000000000000002', '2b0000000000000000000001'],
  'a failed calendar keeps its previous lessons');
select results_eq(
  $$select outcome::text, failure::text, lessons, at = now() from aule.calendar_runs where calendar_id = '222222222222222222222222'$$,
  $$values ('failed'::text, 'network'::text, 2, true)$$,
  'a failed calendar is recorded with the lessons it keeps');
select results_eq(
  $$select (select count(*)::int from aule.calendar_data where calendar_id = '333333333333333333333333'),
    (select count(*)::int from aule.calendar_runs where calendar_id = '333333333333333333333333'),
    (select count(*)::int from aule.lessons where calendar_id = '333333333333333333333333')$$,
  $$values (0, 0, 0)$$,
  'the data of a calendar deactivated before finish is removed');
select is(
  (select count(*)::int from aule.lessons where id = '4d0000000000000000000001'),
  0, 'a calendar removed during the run is skipped');
select results_eq(
  $$select window_from, window_to from aule.calendar_data where calendar_id = 'fffd0fb7c092ebc04936d5c8'$$,
  $$select pg_temp.ts(24), aule.from_ms(pg_temp.top() - 86400000)$$,
  'a portal coverage narrower than the run is stored as its window');
select set_eq(
  $$select id::text from aule.rooms$$,
  array['aaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbb', 'eeeeeeeeeeeeeeeeeeeeeeee', 'ffff00000000000000000002'],
  'rooms that no lesson references are removed');
select set_eq(
  $$select id::text from aule.unique_lessons$$,
  array['1a0000000000000000000001', '1a0000000000000000000002', '2b0000000000000000000001', 'fffe00000000000000000002'],
  'the derived lessons are rebuilt');
select ok(
  exists (select 1 from aule.lessons where id = 'fffe00000000000000000001')
    and not exists (select 1 from aule.unique_lessons where id = 'fffe00000000000000000001'),
  'a portal lesson with the same times in a room of a Planner lesson is dropped');
select is(
  (select source::text from aule.unique_lessons where id = 'fffe00000000000000000002'),
  'portal', 'a portal lesson at other times is kept');
select results_eq(
  $$select calendar_id::text, starts_at, room_ids, calendar_ids from aule.unique_lessons where id = '1a0000000000000000000002'$$,
  $$values ('111111111111111111111111'::text, pg_temp.ts(204), array['eeeeeeeeeeeeeeeeeeeeeeee']::text[],
    array['111111111111111111111111', '222222222222222222222222']::text[])$$,
  'two copies with different times: the newest fetch wins and both calendars are listed');
select set_eq(
  $$select room_id::text, lesson_id::text from aule.lesson_rooms$$,
  $$values ('aaaaaaaaaaaaaaaaaaaaaaaa', '1a0000000000000000000001'), ('eeeeeeeeeeeeeeeeeeeeeeee', '1a0000000000000000000002'),
    ('bbbbbbbbbbbbbbbbbbbbbbbb', '2b0000000000000000000001'), ('ffff00000000000000000002', 'fffe00000000000000000002')$$,
  'lesson rooms follow the chosen copies');
select ok(
  (select array_agg(calendar_id::text order by calendar_id) from aule.room_calendars where room_id = 'eeeeeeeeeeeeeeeeeeeeeeee')
    = array['111111111111111111111111', '222222222222222222222222']
  and (select fetched_at from aule.calendar_data where calendar_id = '222222222222222222222222')
    < now() - (select stale_after from aule.settings),
  'a stale older copy still ties the room to its stale calendar');
select results_eq(
  $$select state::text, ok, failed, rooms, lessons, finished_at = now() from aule.sync_runs where id = pg_temp.rid('b1')$$,
  $$values ('finished'::text, 2, 1, 4, 6, true)$$,
  'the run is finished with its counts');
select results_eq(
  $$select (select count(*)::int from aule.sync_run_calendars), (select count(*)::int from aule.staged_calendars),
    (select count(*)::int from aule.staged_lessons), (select count(*)::int from aule.staged_rooms)$$,
  $$values (0, 0, 0, 0)$$,
  'staging is empty after finish');
select results_eq(
  $$select (count(*) filter (where started_at < now() - interval '1440 hours'))::int,
    (count(*) filter (where started_at = now() - interval '1000 hours'))::int
    from aule.sync_runs$$,
  $$values (0, 1)$$,
  'runs older than 60 days are pruned, younger ones kept');
select is(pg_temp.finish(pg_temp.rid('b1')), '!P0001 run_closed', 'finish on a finished run gives run_closed');
select is(
  pg_temp.as_sync(format('select aule_sync.sync_put_calendar(%s, %L, $1)', pg_temp.rid('b1'), '111111111111111111111111'),
    pg_temp.payload('[]', '[]')),
  '!P0001 run_closed', 'put on a finished run gives run_closed');
select is(pg_temp.finish(999999999), '!P0001 run_missing', 'finish on a missing run gives run_missing');
select is(pg_temp.as_sync($$select aule_sync.sync_abort(999999999, 'network')$$), '!P0001 run_missing', 'abort on a missing run gives run_missing');
select is(pg_temp.finish(0), '!P0001 invalid', 'a run id below 1 is invalid');
select is(pg_temp.as_sync($$select aule_sync.sync_begin('manual')$$), '!P0001 too_soon', 'a begin within 15 minutes of the previous run gives too_soon');

-- Implausible (a): ten calendars ok and no lessons at all.
update aule.sync_runs set started_at = now() - interval '2 hours', last_seen_at = now() - interval '2 hours',
  finished_at = now() - interval '110 minutes' where id = pg_temp.rid('b1');
insert into aule.calendars (id, label, added_at)
select '9a' || lpad(i::text, 22, '0'), 'Calendario vuoto ' || i, timestamptz '2026-03-01 00:00:00+00' + i * interval '1 millisecond'
from generate_series(1, 10) as i;
insert into t04 values ('tt2', to_jsonb(pg_temp.timetable()));
insert into t04 values ('b2', pg_temp.j(pg_temp.as_sync($$select aule_sync.sync_begin('poll')$$)));
select is((select trigger::text from aule.sync_runs where id = pg_temp.rid('b2')), 'schedule', 'poll without a pending request is stored as schedule');
select is(
  (select count(*)::int from generate_series(1, 10) as i
    where pg_temp.put('9a' || lpad(i::text, 22, '0'), pg_temp.payload('[]', '[]')) = 'void'),
  10, 'ten empty calendars are staged');
select is(
  pg_temp.j(pg_temp.finish(pg_temp.rid('b2'))),
  jsonb_build_object('run', pg_temp.rid('b2'), 'state', 'aborted', 'failure', 'implausible', 'ok', 10, 'failed', 3,
    'rooms', null, 'lessons', null),
  'ten ok calendars without lessons make the run implausible');
select is(pg_temp.timetable(), (select v #>> '{}' from t04 where k = 'tt2'), 'the implausible run leaves the timetable unchanged');
select results_eq(
  $$select state::text, failure::text, (select count(*)::int from aule.sync_run_calendars c where c.run_id = r.id)
    from aule.sync_runs r where r.id = pg_temp.rid('b2')$$,
  $$values ('aborted'::text, 'implausible'::text, 0)$$,
  'the implausible run is aborted and its staging removed');
delete from aule.calendars where id like '9a%';

-- Implausible (b): a drop below half within 48 hours of the last good run.
update aule.sync_runs set started_at = now() - interval '90 minutes', last_seen_at = now() - interval '90 minutes',
  finished_at = now() - interval '89 minutes' where id = pg_temp.rid('b2');
update aule.calendar_runs set lessons = 1000 where calendar_id = '111111111111111111111111';
insert into t04 values ('tt3', to_jsonb(pg_temp.timetable()));
insert into t04 values ('b3', pg_temp.j(pg_temp.as_sync($$select aule_sync.sync_begin('manual')$$)));
select ok(pg_temp.rid('b3') is not null, 'a run opens once the cooldown has passed');
select is(
  pg_temp.put('111111111111111111111111', pg_temp.payload(
    jsonb_build_array(pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'mt1')),
    jsonb_build_array(pg_temp.lesson('1a0000000000000000000001', 200, '{aaaaaaaaaaaaaaaaaaaaaaaa}')))),
  'void', 'a calendar with far fewer lessons is staged');
select is(
  pg_temp.j(pg_temp.finish(pg_temp.rid('b3'))) - 'run',
  '{"state": "aborted", "failure": "implausible", "ok": 1, "failed": 2, "rooms": null, "lessons": null}'::jsonb,
  'a drop below half of the previous lessons within 48 hours is implausible');
select is(pg_temp.timetable(), (select v #>> '{}' from t04 where k = 'tt3'), 'the timetable is unchanged after the drop');

-- The same drop is accepted when the last good run is older than 48 hours.
update aule.sync_runs set started_at = now() - interval '50 hours', last_seen_at = now() - interval '50 hours',
  finished_at = now() - interval '49 hours' where id = pg_temp.rid('b1');
update aule.sync_runs set started_at = now() - interval '80 minutes', last_seen_at = now() - interval '80 minutes',
  finished_at = now() - interval '79 minutes' where id = pg_temp.rid('b3');
update aule.run_requests set pending = true, requested_at = now() + interval '1 second' where kind = 'sync';
insert into t04 values ('b4', pg_temp.j(pg_temp.as_sync($$select aule_sync.sync_begin('manual')$$)));
select ok(pg_temp.rid('b4') is not null, 'a manual run opens');
select ok((select pending from aule.run_requests where kind = 'sync'), 'a request made after the begin stays pending');
select is(
  pg_temp.put('111111111111111111111111', pg_temp.payload(
    jsonb_build_array(pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'mt1')),
    jsonb_build_array(pg_temp.lesson('1a0000000000000000000001', 200, '{aaaaaaaaaaaaaaaaaaaaaaaa}'),
      pg_temp.lesson('fffe0000000000000000000a', 230, '{aaaaaaaaaaaaaaaaaaaaaaaa}'),
      pg_temp.lesson('fffe0000000000000000000b', 232, '{aaaaaaaaaaaaaaaaaaaaaaaa}')))),
  'void', 'the smaller calendar is staged again, with the fffe pieces of a split long event');
select is(
  pg_temp.j(pg_temp.finish(pg_temp.rid('b4'))) ->> 'state',
  'finished', 'the drop is accepted when the last good run is older than 48 hours');
select set_eq(
  $$select id::text from aule.lessons where calendar_id = '111111111111111111111111'$$,
  array['1a0000000000000000000001', 'fffe0000000000000000000a', 'fffe0000000000000000000b'],
  'the accepted run replaces the calendar, split pieces included');

-- Abandoned runs: lease passed, then idle.
update aule.sync_runs set started_at = now() - interval '70 minutes', last_seen_at = now() - interval '70 minutes',
  finished_at = now() - interval '69 minutes' where id = pg_temp.rid('b4');
insert into t04 values ('b5', pg_temp.j(pg_temp.as_sync($$select aule_sync.sync_begin('schedule')$$)));
select is(
  pg_temp.put('111111111111111111111111', pg_temp.payload(
    jsonb_build_array(pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'mt1')),
    jsonb_build_array(pg_temp.lesson('1a0000000000000000000001', 200, '{aaaaaaaaaaaaaaaaaaaaaaaa}')))),
  'void', 'a scheduled run stages a calendar');
update aule.sync_runs set started_at = now() - interval '26 minutes', last_seen_at = now() - interval '1 minute'
where id = pg_temp.rid('b5');
insert into t04 values ('b6', pg_temp.j(pg_temp.as_sync($$select aule_sync.sync_begin('schedule')$$)));
select ok(pg_temp.rid('b6') is not null, 'a begin after the lease of the open run succeeds');
select results_eq(
  $$select state::text, failure::text, finished_at = now(),
    (select count(*)::int from aule.sync_run_calendars c where c.run_id = r.id) + (select count(*)::int from aule.staged_rooms s where s.run_id = r.id)
    from aule.sync_runs r where r.id = pg_temp.rid('b5')$$,
  $$values ('abandoned'::text, 'abandoned'::text, true, 0)$$,
  'an open run older than 25 minutes is abandoned and its staging emptied');
update aule.sync_runs set started_at = now() - interval '16 minutes', last_seen_at = now() - interval '6 minutes'
where id = pg_temp.rid('b6');
insert into t04 values ('b7', pg_temp.j(pg_temp.as_sync($$select aule_sync.sync_begin('schedule')$$)));
select ok(pg_temp.rid('b7') is not null, 'a begin after the open run went idle succeeds');
select is((select state::text from aule.sync_runs where id = pg_temp.rid('b6')), 'abandoned', 'a run idle for more than 5 minutes is abandoned');

-- Abort.
select is(
  pg_temp.as_sync(format('select aule_sync.sync_abort(%s, %L)', pg_temp.rid('b7'), 'boom')),
  '!P0001 invalid', 'abort with an unknown code is invalid');
select is(
  pg_temp.put('111111111111111111111111', pg_temp.payload(
    jsonb_build_array(pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'mt1')), '[]')),
  'void', 'a calendar is staged before the abort');
insert into t04 values ('tt7', to_jsonb(pg_temp.timetable()));
select is(
  pg_temp.as_sync(format('select aule_sync.sync_abort(%s, %L)', pg_temp.rid('b7'), 'network')),
  'void', 'abort with a closed code');
select results_eq(
  $$select state::text, failure::text, finished_at = now(),
    (select count(*)::int from aule.sync_run_calendars c where c.run_id = r.id) + (select count(*)::int from aule.staged_rooms s where s.run_id = r.id)
    from aule.sync_runs r where r.id = pg_temp.rid('b7')$$,
  $$values ('aborted'::text, 'network'::text, true, 0)$$,
  'abort sets the run aborted and removes its staging');
select is(pg_temp.timetable(), (select v #>> '{}' from t04 where k = 'tt7'), 'abort leaves the timetable unchanged');
select is(
  pg_temp.as_sync(format('select aule_sync.sync_abort(%s, %L)', pg_temp.rid('b7'), 'network')),
  '!P0001 run_closed', 'abort on an aborted run gives run_closed');
select is(
  pg_temp.as_sync(format('select aule_sync.sync_fail_calendar(%s, %L, %L)', pg_temp.rid('b7'), '222222222222222222222222', 'network')),
  '!P0001 run_closed', 'fail on an aborted run gives run_closed');

-- Daily cap.
update aule.sync_runs set started_at = started_at - interval '1 hour' where started_at > now() - interval '24 hours';
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed, rooms, lessons)
select 'schedule', 'finished', now() - interval '3 hours', now() - interval '3 hours', now() - interval '3 hours',
  pg_temp.ts(0), pg_temp.ts(480), 0, 1, 0, 0
from generate_series(1, 12 - (select count(*)::int from aule.sync_runs where started_at > now() - interval '24 hours'));
select is(pg_temp.as_sync($$select aule_sync.sync_begin('schedule')$$), '!P0001 too_many_runs', '12 runs in 24 hours give too_many_runs');

-- Discover.
insert into aule.sources (position, url) values
  (1, 'https://www.unical.it/didattica/orari/'),
  (2, 'https://www.unical.it/didattica/calendari/');
update aule.run_requests set pending = true, requested_at = now() - interval '1 minute' where kind = 'discover';
insert into aule.proposals (calendar_id, label, source) values
  ('abcabcabcabcabcabcabcabc', 'Proposta vecchia', 'https://www.unical.it/didattica/orari/');
insert into aule.discover_failures (position, source, failure) values (1, 'https://www.unical.it/didattica/calendari/', 'network');
select is(
  pg_temp.j(pg_temp.as_sync('select aule_sync.discover_begin()')),
  '{"sources": ["https://www.unical.it/didattica/orari/", "https://www.unical.it/didattica/calendari/"],
    "known": ["111111111111111111111111", "222222222222222222222222", "333333333333333333333333", "555555555555555555555555"]}'::jsonb,
  'discover returns the source pages in order and the known Planner ids');
select results_eq(
  $$select q.pending, q.served_at = now(), (select d.started_at = now() from aule.discover_state d)
    from aule.run_requests q where q.kind = 'discover'$$,
  $$values (false, true, true)$$,
  'discover clears its request and records its start');
select is(pg_temp.as_sync('select aule_sync.discover_begin()'), '!P0001 too_soon', 'a second discover within 15 minutes gives too_soon');
select is(
  pg_temp.j(pg_temp.as_sync('select aule_sync.put_proposals($1)',
    '{"items": [{"id": "666666666666666666666666", "label": "Calendario nuovo", "source": "https://www.unical.it/didattica/orari/"},
                {"id": "111111111111111111111111", "label": "Calendario uno", "source": "https://www.unical.it/didattica/orari/"}],
      "failures": [{"source": "https://www.unical.it/didattica/calendari/", "failure": "not_html"}]}')),
  '{"found": 1, "failures": 1}'::jsonb,
  'put_proposals stores new calendars and failures');
select results_eq(
  $$select calendar_id::text, label::text, source::text from aule.proposals$$,
  $$values ('666666666666666666666666'::text, 'Calendario nuovo'::text, 'https://www.unical.it/didattica/orari/'::text)$$,
  'proposals are replaced and known ids skipped');
select results_eq(
  $$select position::int, source::text, failure::text from aule.discover_failures$$,
  $$values (1, 'https://www.unical.it/didattica/calendari/'::text, 'not_html'::text)$$,
  'page failures are replaced');
select results_eq(
  $$select found, finished_at = now() from aule.discover_state$$,
  $$values (1, true)$$,
  'discover records how many calendars it found');
select is(
  pg_temp.as_sync('select aule_sync.put_proposals($1)',
    '{"items": [{"id": "777777777777777777777777", "label": "Calendario", "source": "https://www.unical.it/altro/"}], "failures": []}'),
  '!P0001 payload_value', 'a source page that is not configured gives payload_value');
select is(
  pg_temp.as_sync('select aule_sync.put_proposals($1)', '{"items": [], "failures": [], "extra": 1}'),
  '!P0001 payload_shape', 'an extra key gives payload_shape');
select is(
  pg_temp.as_sync('select aule_sync.put_proposals($1)',
    '{"items": [{"id": "fffd0fb7c092ebc04936d5c8", "label": "Calendario", "source": "https://www.unical.it/didattica/orari/"}], "failures": []}'),
  '!P0001 payload_value', 'a synthetic id is never a proposal');
select is(
  pg_temp.as_sync('select aule_sync.put_proposals($1)',
    '{"items": [{"id": "777777777777777777777777", "label": " Calendario", "source": "https://www.unical.it/didattica/orari/"}], "failures": []}'),
  '!P0001 payload_value', 'a padded label gives payload_value');
select is(
  pg_temp.as_sync('select aule_sync.put_proposals($1)',
    jsonb_build_object('items', (select jsonb_agg('{}'::jsonb) from generate_series(1, 601)), 'failures', '[]'::jsonb)),
  '!P0001 payload_size', '601 proposals exceed the size limit');
select is((select count(*)::int from aule.proposals), 1, 'rejected proposals change nothing');

select * from finish();
rollback;
