begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- Runs one statement as aule_sync or anon. Result as text, 'void', or '!<sqlstate>' with the message of P0001 errors.
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
create function pg_temp.as_anon(q text)
returns text
language plpgsql
as $$
declare
  r text;
begin
  set local role anon;
  execute q into r;
  reset role;
  return r;
exception when others then
  return '!' || sqlstate || case when sqlstate = 'P0001' then ' ' || sqlerrm else '' end;
end
$$;
create function pg_temp.j(p text) returns jsonb language sql immutable as $$
  select case when p like '{%' then p::jsonb else jsonb_build_object('error', p) end
$$;

-- P and Q are Planner calendars, X an xlsx feed. R1 is a Planner room shared by P and X, S1 and T1 are Planner only.
create function pg_temp.x() returns text language sql immutable as $$
  select aule.synthetic_id('fffd', 'xlsx|LT|Foglio di prova')
$$;
create function pg_temp.base() returns bigint language sql stable as $$
  select aule.ms(aule.rome_midnight(aule.rome_day(now()) - s.window_back_days)) from aule.settings s
$$;
create function pg_temp.top() returns bigint language sql stable as $$
  select aule.ms(aule.rome_midnight(aule.rome_day(now()) + s.window_ahead_days)) from aule.settings s
$$;
-- p_hours from now, in milliseconds.
create function pg_temp.at(p_hours integer) returns bigint language sql stable as $$
  select aule.ms(now()) + p_hours * 3600000::bigint
$$;
create function pg_temp.room(p_id text, p_key text) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'name', upper(p_key), 'code', '', 'buildingName', 'Cubo di prova', 'capacity', 100,
    'effectiveCapacity', null, 'services', '[]'::jsonb, 'buildingKeyGuess', 'cubo-31b', 'roomKey', p_key, 'nameCompact', p_key,
    'searchText', p_key || ' cubo di prova')
$$;
create function pg_temp.lesson(p_id text, p_hours integer, p_room text, p_kind text default 'ATTIVITA'' DIDATTICA')
returns jsonb language sql stable as $$
  select jsonb_build_object('id', p_id, 'title', 'Analisi matematica', 'start', pg_temp.at(p_hours),
    'end', pg_temp.at(p_hours + 2), 'status', 'active', 'kind', p_kind, 'courses', jsonb_build_array('Ingegneria di prova'),
    'year', 1, 'teachers', '[]'::jsonb, 'roomIds', jsonb_build_array(p_room), 'titleText', 'analisi matematica',
    'directText', 'analisi matematica', 'courseText', 'analisi matematica ingegneria di prova')
$$;
create function pg_temp.put(p_id text, p_rooms jsonb, p_lessons jsonb, p_from bigint default null, p_to bigint default null)
returns jsonb language sql stable as $$
  select jsonb_build_object('id', p_id, 'payload', jsonb_build_object('from', coalesce(p_from, pg_temp.base()),
    'to', coalesce(p_to, pg_temp.top()), 'skipped', 0, 'rooms', p_rooms, 'lessons', p_lessons))
$$;
create function pg_temp.fail(p_id text, p_code text) returns jsonb language sql immutable as $$
  select jsonb_build_object('id', p_id, 'fail', p_code)
$$;
create function pg_temp.p_ok() returns jsonb language sql stable as $$
  select pg_temp.put('5a5a5a5a5a5a5a5a5a5a5a5a',
    jsonb_build_array(pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'r1'), pg_temp.room('bbbbbbbbbbbbbbbbbbbbbbbb', 's1'),
      pg_temp.room('cccccccccccccccccccccccc', 't1')),
    jsonb_build_array(pg_temp.lesson('1a0000000000000000000001', 48, 'aaaaaaaaaaaaaaaaaaaaaaaa'),
      pg_temp.lesson('1a0000000000000000000002', -1, 'bbbbbbbbbbbbbbbbbbbbbbbb'),
      pg_temp.lesson('1a0000000000000000000003', 50, 'cccccccccccccccccccccccc')))
$$;
create function pg_temp.q_ok() returns jsonb language sql stable as $$
  select pg_temp.put('5b5b5b5b5b5b5b5b5b5b5b5b', jsonb_build_array(pg_temp.room('cccccccccccccccccccccccc', 't1')),
    jsonb_build_array(pg_temp.lesson('2b0000000000000000000001', 24, 'cccccccccccccccccccccccc')))
$$;
create function pg_temp.q_empty() returns jsonb language sql stable as $$
  select pg_temp.put('5b5b5b5b5b5b5b5b5b5b5b5b', '[]', '[]')
$$;
-- The xlsx lesson takes R1 from one hour ago to one hour from now.
create function pg_temp.x_ok() returns jsonb language sql stable as $$
  select pg_temp.put(pg_temp.x(), '[]',
    jsonb_build_array(pg_temp.lesson('fffe00000000000000000001', -1, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'Lezione')))
$$;

-- One run as aule_sync: puts or fails each feed in order, then finishes. Every answer, comma separated.
create function pg_temp.sync(variadic p_steps jsonb[]) returns text language plpgsql as $$
declare
  v_r text;
  v_run bigint;
  v_out text[] := '{}';
  s jsonb;
begin
  v_r := pg_temp.as_sync($q$select aule_sync.sync_begin('manual')$q$);
  if v_r like '!%' then
    return 'begin ' || v_r;
  end if;
  v_run := (v_r::jsonb ->> 'run')::bigint;
  foreach s in array p_steps loop
    if s ? 'fail' then
      v_out := v_out || pg_temp.as_sync(format('select aule_sync.sync_fail_calendar(%s, %L, %L)', v_run, s ->> 'id', s ->> 'fail'));
    else
      v_out := v_out || pg_temp.as_sync(format('select aule_sync.sync_put_calendar(%s, %L, $1)', v_run, s ->> 'id'), s -> 'payload');
    end if;
  end loop;
  v_r := pg_temp.as_sync(format('select aule_sync.sync_finish(%s)', v_run));
  return array_to_string(v_out || case when v_r like '!%' then v_r else v_r::jsonb ->> 'state' end, ', ');
end
$$;

-- What the map and the free room search show, through the public API.
create function pg_temp.states() returns text language sql as $$
  select string_agg((e ->> 'name') || ' ' || (e ->> 'state'), ', ' order by e ->> 'name')
  from jsonb_array_elements(pg_temp.j(pg_temp.as_anon('select public.room_status()::text')) -> 'rooms') e
$$;
create function pg_temp.free() returns text language sql as $$
  select coalesce(string_agg(e ->> 'name', ', ' order by e ->> 'name'), '')
  from jsonb_array_elements(pg_temp.j(pg_temp.as_anon('select public.search_rooms(null, true)::text')) -> 'rooms') e
$$;
create function pg_temp.links() returns text language sql stable as $$
  select string_agg(l.v, ', ' order by l.v)
  from (
    select case f.calendar_id::text when '5a5a5a5a5a5a5a5a5a5a5a5a' then 'P' when '5b5b5b5b5b5b5b5b5b5b5b5b' then 'Q' else 'X' end
      || ':' || case f.room_id::text when 'aaaaaaaaaaaaaaaaaaaaaaaa' then 'R1' when 'bbbbbbbbbbbbbbbbbbbbbbbb' then 'S1' else 'T1' end as v
    from aule.feed_rooms f
  ) l
$$;

delete from aule.sync_runs;
delete from aule.calendars;
delete from aule.rooms;
delete from aule.unique_lessons;
delete from aule.lesson_rooms;
delete from aule.room_calendars;
delete from public.room_requests;
update aule.run_requests set pending = false, requested_at = null, requested_by = null, served_at = null;
update aule.settings set request_cooldown = interval '0 minutes', max_runs_per_day = 96, stale_after = interval '30 hours';
insert into aule.calendars (id, source, ref, label, added_at) values
  ('5a5a5a5a5a5a5a5a5a5a5a5a', 'planner', null, 'Calendario di prova', timestamptz '2026-01-01 00:00:00+00'),
  ('5b5b5b5b5b5b5b5b5b5b5b5b', 'planner', null, 'Altro calendario di prova', timestamptz '2026-01-02 00:00:00+00'),
  (pg_temp.x(), 'xlsx', 'LT|Foglio di prova', 'Foglio xlsx di prova', timestamptz '2026-01-03 00:00:00+00');

-- Nobody but the sync functions reaches the links.
select is(pg_temp.as_anon('select count(*) from aule.feed_rooms'), '!42501', 'anon cannot read the room links');
select is(pg_temp.as_sync('select count(*) from aule.feed_rooms'), '!42501', 'aule_sync cannot read the room links');

-- Run 1: every feed ok with lessons.
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_ok(), pg_temp.x_ok()), 'void, void, void, finished', 'run 1 finishes');
select is(pg_temp.links(), 'P:R1, P:S1, P:T1, Q:T1, X:R1', 'every ok calendar with lessons links the rooms it used');
select ok((select bool_and(last_seen = now()) from aule.feed_rooms), 'a link is seen at the fetch of its calendar');
select is(pg_temp.states(), 'R1 busy, S1 busy, T1 free', 'the xlsx lesson makes the shared Planner room busy');
select is(
  (select string_agg(calendar_id::text, ',' order by calendar_id) from aule.room_calendars where room_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'),
  '5a5a5a5a5a5a5a5a5a5a5a5a', 'a Planner only room is tied to its Planner calendar alone, as before');

-- Run 2: the xlsx feed is ok but empty, with a coverage that ended before now (out of its semester).
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_empty(),
    pg_temp.put(pg_temp.x(), '[]', '[]', pg_temp.base(), pg_temp.base() + 86400000)),
  'void, void, void, finished', 'run 2 finishes');
select is((select count(*)::int from aule.lessons where calendar_id = pg_temp.x()), 0, 'the xlsx feed has no lesson left');
select is(pg_temp.links(), 'P:R1, P:S1, P:T1, Q:T1, X:R1', 'empty calendars keep their links');
select is(pg_temp.states(), 'R1 unknown, S1 busy, T1 free',
  'out of its coverage the empty xlsx feed keeps its room grey; a fresh empty Planner calendar changes nothing');
select is(pg_temp.free(), 'T1', 'the free room search never lists the grey room');
select is(pg_temp.as_anon($$select public.room_lessons('aaaaaaaaaaaaaaaaaaaaaaaa') -> 'room' ->> 'state'$$), 'unknown',
  'the room page shows it grey too');

-- The fail open case: without the link the room would look free while the xlsx feed knows nothing.
create temp table x_links as select * from aule.feed_rooms where calendar_id = pg_temp.x();
do $$ begin delete from aule.feed_rooms where calendar_id = pg_temp.x(); perform aule.refresh_timetable(); end $$;
select is(pg_temp.states(), 'R1 free, S1 busy, T1 free', 'without its link the shared room would be free');
do $$ begin insert into aule.feed_rooms select * from x_links; perform aule.refresh_timetable(); end $$;
select is(pg_temp.states(), 'R1 unknown, S1 busy, T1 free', 'with the link it is grey again');

-- Run 3: the xlsx feed fails.
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_empty(), pg_temp.fail(pg_temp.x(), 'wrong_period')),
  'void, void, void, finished', 'run 3 finishes');
select results_eq(
  $$select outcome::text, failure::text, lessons from aule.calendar_runs where calendar_id = pg_temp.x()$$,
  $$values ('failed'::text, 'wrong_period'::text, 0)$$,
  'the failed xlsx feed is recorded without lessons');
select is(pg_temp.states(), 'R1 unknown, S1 busy, T1 free', 'a failed xlsx feed keeps its room grey, never free');
select is(pg_temp.free(), 'T1', 'and out of the free room search');

-- Run 4: between two semesters the feed is ok, empty and covers now: the room follows the Planner.
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_empty(), pg_temp.put(pg_temp.x(), '[]', '[]')),
  'void, void, void, finished', 'run 4 finishes');
select is(pg_temp.states(), 'R1 free, S1 busy, T1 free', 'a fresh empty feed that covers now lets the room follow the Planner');

-- Run 5: then it fails. Its last data holds until stale_after, like stored lessons; then the room turns grey.
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_empty(), pg_temp.fail(pg_temp.x(), 'network')),
  'void, void, void, finished', 'run 5 finishes');
select is(pg_temp.states(), 'R1 free, S1 busy, T1 free', 'within stale_after the failed feed keeps its last answer');
update aule.calendar_data set fetched_at = now() - interval '31 hours' where calendar_id = pg_temp.x();
select is(pg_temp.states(), 'R1 unknown, S1 busy, T1 free', 'once the failed feed is stale its room is grey, never free');

-- Run 6: links not seen for 9600 hours are dropped, younger ones kept.
update aule.feed_rooms set last_seen = now() - interval '9599 hours' where calendar_id = pg_temp.x();
update aule.feed_rooms set last_seen = now() - interval '9601 hours' where calendar_id = '5b5b5b5b5b5b5b5b5b5b5b5b';
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_empty(), pg_temp.fail(pg_temp.x(), 'network')),
  'void, void, void, finished', 'run 6 finishes');
select is(pg_temp.links(), 'P:R1, P:S1, P:T1, X:R1', 'the link older than 9600 hours is gone, the younger one stays');

-- Run 7: a deactivated feed loses its data and its links at the next finish.
update aule.calendars set active = false where id = pg_temp.x();
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_empty()), 'void, void, finished', 'run 7 finishes');
select results_eq(
  $$select (select count(*)::int from aule.calendar_data where calendar_id = pg_temp.x()),
    (select count(*)::int from aule.feed_rooms where calendar_id = pg_temp.x()),
    (select count(*)::int from aule.room_calendars where calendar_id = pg_temp.x())$$,
  $$values (0, 0, 0)$$,
  'the deactivated feed has no data and no link left');

-- Run 8: removing a calendar drops its links at once.
select is(pg_temp.sync(pg_temp.p_ok(), pg_temp.q_ok()), 'void, void, finished', 'run 8 finishes');
select is(pg_temp.links(), 'P:R1, P:S1, P:T1, Q:T1', 'the Planner calendar is linked again');
select lives_ok($$select aule.config_remove_calendar('5b5b5b5b5b5b5b5b5b5b5b5b')$$, 'the Planner calendar is removed');
select is(
  (select count(*)::int from aule.feed_rooms where calendar_id = '5b5b5b5b5b5b5b5b5b5b5b5b')
    + (select count(*)::int from aule.room_calendars where calendar_id = '5b5b5b5b5b5b5b5b5b5b5b5b'),
  0, 'its links are gone at once');

select * from finish();
rollback;
