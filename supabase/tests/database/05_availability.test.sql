begin;
create extension if not exists pgtap with schema extensions;
select plan(99);

-- Runs one query as aule_reader. Result as text, or '!<sqlstate>' with the message of P0001 errors.
create function pg_temp.rd(q text)
returns text
language plpgsql
as $$
declare
  r text;
begin
  set local role aule_reader;
  execute q into r;
  reset role;
  return r;
exception when others then
  return '!' || sqlstate || case when sqlstate = 'P0001' then ' ' || sqlerrm else '' end;
end
$$;

-- Fixed time: 2026-11-16 11:30 in Rome. h(x) is x hours from it, m(x) the same in milliseconds.
create function pg_temp.h(p numeric) returns timestamptz language sql immutable as $$
  select timestamptz '2026-11-16 10:30:00+00' + p * interval '1 hour'
$$;
create function pg_temp.m(p numeric) returns bigint language sql stable as $$
  select aule.ms(pg_temp.h(p))
$$;
create function pg_temp.pick(p jsonb, variadic k text[]) returns jsonb language sql immutable as $$
  select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) from jsonb_each(p) e where e.key = any (k)
$$;
create function pg_temp.status(p_now timestamptz default timestamptz '2026-11-16 10:30:00+00') returns jsonb language sql as $$
  select pg_temp.rd(format('select aule.room_status_at(%L)::text', p_now))::jsonb
$$;
create function pg_temp.r(p_room text default 'aaaaaaaaaaaaaaaaaaaaaaaa', p_now timestamptz default timestamptz '2026-11-16 10:30:00+00')
returns jsonb language sql as $$
  select e from jsonb_array_elements(pg_temp.status(p_now) -> 'rooms') e where e ->> 'id' = p_room
$$;
create function pg_temp.lessons(p_room text, p_from date, p_days integer,
  p_now timestamptz default timestamptz '2026-11-16 10:30:00+00')
returns jsonb language sql as $$
  select pg_temp.rd(format('select aule.room_lessons_at(%L, %L, %L, %L)::text', p_now, p_room, p_from, p_days))::jsonb
$$;

create function pg_temp.clear() returns void language plpgsql as $$
begin
  delete from aule.calendar_data;
  delete from aule.rooms;
  delete from aule.sync_runs;
  delete from aule.unique_lessons;
  delete from aule.lesson_rooms;
  delete from aule.room_calendars;
  delete from aule.room_floors;
  delete from aule.building_links;
  delete from aule.building_shapes;
  delete from public.room_requests;
end
$$;
create function pg_temp.cal(p_id text, p_fetched timestamptz, p_from timestamptz, p_to timestamptz) returns void language plpgsql as $$
begin
  insert into aule.calendars (id, label) values (p_id, 'Calendario di prova') on conflict (id) do nothing;
  insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to) values (p_id, p_fetched, p_from, p_to);
end
$$;
-- Precomputed columns as buildPayload computes them.
create function pg_temp.room(p_id text, p_name text default 'B6', p_building text default 'Cubo 4D', p_guess text default 'cubo-4d')
returns void language sql as $$
  insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key,
    name_compact, search_text)
  values (p_id, p_name, 'AU_1', p_building, 40, 22, '{}', p_guess,
    regexp_replace(regexp_replace(lower(p_name), '^aula\s+', ''), '[^a-z0-9]', '', 'g'),
    replace(regexp_replace(lower(p_name), '^aula ', ''), ' ', ''),
    lower(p_name || ' au_1 ' || p_building))
$$;
create temp sequence lesson_seq;
create function pg_temp.lesson(p_cal text, p_room text, p_start timestamptz, p_end timestamptz, p_status text default 'active',
  p_id text default null)
returns void language sql as $$
  insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
    title_text, direct_text, course_text)
  values (p_cal, coalesce(p_id, lpad(to_hex(nextval('pg_temp.lesson_seq')), 24, 'd')), 'Analisi', p_start, p_end,
    p_status::aule.lesson_status, '', '{}', null, '{}', array[p_room], 'analisi', 'analisi', 'analisi')
$$;
create function pg_temp.l(p_start numeric, p_end numeric, p_status text default 'active', p_id text default null)
returns void language sql as $$
  select pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(p_start), pg_temp.h(p_end), p_status, p_id)
$$;
create function pg_temp.req(p_room text, p_kind text, p_start timestamptz, p_end timestamptz, p_status text default 'approved',
  p_category text default null, p_lesson text default null, p_user integer default 1)
returns void language sql as $$
  insert into public.room_requests (room_id, kind, category, starts_at, ends_at, status, created_by, reviewed_at, lesson_id)
  values (p_room, p_kind::public.request_kind, p_category::public.issue_category, p_start, p_end, p_status::public.request_status,
    ('50000000-0000-0000-0000-00000000000' || p_user)::uuid, case when p_status = 'pending' then null else now() end, p_lesson)
$$;
-- Calendar 1 fetched one hour before the fixed time, covering 7 days back and 14 ahead, with room A.
create function pg_temp.base(p_fetched numeric default -1) returns void language plpgsql as $$
begin
  perform pg_temp.clear();
  perform pg_temp.cal('111111111111111111111111', pg_temp.h(p_fetched), pg_temp.h(-168), pg_temp.h(336));
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa');
end
$$;

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('50000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente1@studenti.unical.it', now()),
  ('50000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente2@studenti.unical.it', now()),
  ('50000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente3@studenti.unical.it', now());
delete from aule.room_seeds;
insert into aule.room_seeds (building_key, room_key, floor) values ('cubo-30b', 'mt1', 0);
update aule.settings set stale_after = '30 hours', sync_slots = '{06:17,13:17}';

-- The 22 cases of the availability tests.
do $$ begin perform pg_temp.base(); perform pg_temp.l(-1, 0.5); perform pg_temp.l(0.6, 2); perform pg_temp.l(3, 4);
  perform aule.refresh_timetable(); end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until', 'current'),
  jsonb_build_object('state', 'busy', 'until', pg_temp.m(2), 'current', jsonb_build_object('title', 'Analisi', 'end', pg_temp.m(0.5))),
  'a room with a lesson now is busy until the end of back to back lessons');
select is(array[(pg_temp.r() -> 'current' ->> 'end')::bigint, (pg_temp.r() ->> 'until')::bigint], array[pg_temp.m(0.5), pg_temp.m(2)],
  'current.end is the end of the shown block, until the end of the chain');

do $$ begin perform pg_temp.base(); perform pg_temp.l(1, 2); perform aule.refresh_timetable(); end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until'), jsonb_build_object('state', 'free', 'until', pg_temp.m(1)),
  'a free room is free until the next lesson of the same day');

do $$ begin perform pg_temp.base(); perform pg_temp.l(20, 22); perform aule.refresh_timetable(); end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until', 'next'),
  jsonb_build_object('state', 'free', 'until', null, 'next', jsonb_build_object('title', 'Analisi', 'start', pg_temp.m(20))),
  'a lesson tomorrow does not limit today');

do $$ begin perform pg_temp.base(); perform pg_temp.l(-2, 0); perform aule.refresh_timetable(); end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'current'), '{"state": "free", "current": null}'::jsonb,
  'a lesson ending exactly now leaves the room free');

do $$ begin perform pg_temp.base(); perform pg_temp.l(-1, 1, 'cancelled'); perform aule.refresh_timetable(); end $$;
select is(pg_temp.r() ->> 'state', 'free', 'a cancelled lesson does not occupy the room');

do $$ begin perform pg_temp.base(); perform pg_temp.l(5, 6); perform aule.refresh_timetable(); end $$;
select is(pg_temp.r() ->> 'state', 'free', 'control: fresh data is free');
update aule.calendar_data set fetched_at = pg_temp.h(-31);
select is(pg_temp.r() ->> 'state', 'unknown', 'old data makes the room unknown, never free');
select is((pg_temp.status() ->> 'staleCalendars')::int, 1, 'old data counts as a stale calendar');

do $$ begin perform pg_temp.base(); perform pg_temp.l(5, 6); perform aule.refresh_timetable(); end $$;
select is(pg_temp.r() ->> 'state', 'free', 'control: data covering today is free');
update aule.calendar_data set window_to = pg_temp.h(-1);
select is(pg_temp.r() ->> 'state', 'unknown', 'data that does not cover today makes the room unknown');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(5, 6);
  perform pg_temp.cal('222222222222222222222222', pg_temp.h(-40), pg_temp.h(-100), pg_temp.h(100));
  perform pg_temp.lesson('222222222222222222222222', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(7), pg_temp.h(8));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.r() ->> 'state', 'unknown', 'a room shared by a fresh and a stale calendar is unknown');

do $$ begin
  perform pg_temp.base();
  perform pg_temp.cal('222222222222222222222222', pg_temp.h(-1), pg_temp.h(-168), pg_temp.h(336));
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(1), pg_temp.h(2), 'active', 'cccccccccccccccccccccc09');
  perform pg_temp.lesson('222222222222222222222222', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(1), pg_temp.h(2), 'active', 'cccccccccccccccccccccc09');
  perform aule.refresh_timetable();
end $$;
select is(jsonb_array_length(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-11-16', 1) -> 'lessons'), 1,
  'the same lesson in two calendars is counted once');

-- Across sources a lower priority copy goes only when it changes nothing: same times, all its rooms, still active.
insert into aule.calendars (id, source, ref, label) values ('fffd0fb7c092ebc04936d5c8', 'portal', '0880', 'Corso di prova')
  on conflict (id) do nothing;
create function pg_temp.two_sources() returns void language plpgsql as $$
begin
  perform pg_temp.base();
  perform pg_temp.room('bbbbbbbbbbbbbbbbbbbbbbbb', 'B7');
  insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to)
  values ('fffd0fb7c092ebc04936d5c8', pg_temp.h(-1), pg_temp.h(-168), pg_temp.h(336));
end
$$;
do $$ begin
  perform pg_temp.two_sources();
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1), pg_temp.h(1), 'active', 'cccccccccccccccccccccc40');
  perform pg_temp.lesson('fffd0fb7c092ebc04936d5c8', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1), pg_temp.h(1), 'active', 'fffe00000000000000000040');
  perform aule.refresh_timetable();
end $$;
select is(jsonb_path_query_array(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-11-16', 1), '$.lessons[*].id'),
  '["cccccccccccccccccccccc40"]'::jsonb, 'control: a lesson of another source in the same room at the same times is dropped');
do $$ begin
  perform pg_temp.two_sources();
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1), pg_temp.h(1), 'cancelled', 'cccccccccccccccccccccc41');
  perform pg_temp.lesson('fffd0fb7c092ebc04936d5c8', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1), pg_temp.h(1), 'active', 'fffe00000000000000000041');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until'), jsonb_build_object('state', 'busy', 'until', pg_temp.m(1)),
  'a cancelled Planner event never frees a room another source holds at the same times');
do $$ begin
  perform pg_temp.two_sources();
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1), pg_temp.h(1), 'active', 'cccccccccccccccccccccc42');
  insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
    title_text, direct_text, course_text)
  values ('fffd0fb7c092ebc04936d5c8', 'fffe00000000000000000042', 'Idraulica', pg_temp.h(-1), pg_temp.h(1), 'active', '', '{}', null,
    '{}', '{aaaaaaaaaaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbbbbbbbbbb}', 'idraulica', 'idraulica', 'idraulica');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r('bbbbbbbbbbbbbbbbbbbbbbbb'), 'state', 'current'),
  jsonb_build_object('state', 'busy', 'current', jsonb_build_object('title', 'Idraulica', 'end', pg_temp.m(1))),
  'a lesson of another source sharing only one room with a Planner lesson keeps its other rooms busy');

do $$ begin
  perform pg_temp.base();
  perform pg_temp.room('bbbbbbbbbbbbbbbbbbbbbbbb', 'Aula MT1', 'Cubo 30B', 'cubo-30b');
  perform pg_temp.l(1, 2);
  perform pg_temp.lesson('111111111111111111111111', 'bbbbbbbbbbbbbbbbbbbbbbbb', pg_temp.h(-1), pg_temp.h(1));
  insert into aule.room_floors (room_id, floor) values ('aaaaaaaaaaaaaaaaaaaaaaaa', 3);
  perform aule.refresh_timetable();
end $$;
select is((pg_temp.r() ->> 'floor')::int, 3, 'the admin floor comes first');
select is((pg_temp.r('bbbbbbbbbbbbbbbbbbbbbbbb') ->> 'floor')::int, 0, 'else the seed floor of the resolved building');
select is(pg_temp.status() -> 'buildings' -> 'cubo-4d',
  '{"floors": {"3": {"free": 1, "busy": 0, "unknown": 0}}, "unplaced": {"free": 0, "busy": 0, "unknown": 0},
    "total": {"free": 1, "busy": 0, "unknown": 0}}'::jsonb,
  'building counts per floor, unplaced and total');
select is(pg_temp.status() -> 'buildings' -> 'cubo-30b' -> 'floors' -> '0', '{"free": 0, "busy": 1, "unknown": 0}'::jsonb,
  'the seeded room is counted on its floor');

do $$ begin
  perform pg_temp.clear();
  perform pg_temp.cal('111111111111111111111111', pg_temp.h(-1), pg_temp.h(-168), pg_temp.h(336));
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa', 'B6', 'Polo nuovo', 'polo-nuovo');
  perform pg_temp.l(1, 2);
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.r() -> 'buildingKey', 'null'::jsonb, 'a room of an unknown building stays off the map');
select is(pg_temp.status() -> 'unmatchedBuildings', '["Polo nuovo"]'::jsonb, 'its building is listed as unmatched');
insert into aule.building_links (planner_name, campus_key) values ('Polo nuovo', 'cubo-30b');
select is(pg_temp.r() ->> 'buildingKey', 'cubo-30b', 'an admin link places it at once');
select is(pg_temp.status() -> 'unmatchedBuildings', '[]'::jsonb, 'a linked building is no longer unmatched');

do $$ begin perform pg_temp.clear(); end $$;
select is(pg_temp.status() -> 'shapes' -> 'cubo-4d', '{"floors": 5, "baseLevel": 0}'::jsonb, 'cubes get 5 floors by default');
select is((select count(*)::int from jsonb_object_keys(pg_temp.status() -> 'shapes')), (select count(*)::int from aule.campus_buildings),
  'every campus building gets a shape');
insert into aule.building_shapes (key, floors, base_level) values ('aula-magna', 3, 1);
select is(pg_temp.status() -> 'shapes' -> 'aula-magna', '{"floors": 3, "baseLevel": 1}'::jsonb, 'a stored shape wins');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(20, 22);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.5), pg_temp.h(0.5));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'report', 'until'),
  jsonb_build_object('state', 'busy', 'report', 'occupied', 'until', pg_temp.m(0.5)),
  'an approved occupied report makes a free room busy until it ends');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(20, 22);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.2), pg_temp.h(0.8), 'pending', null, null, 1);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.2), pg_temp.h(0.8), 'pending', null, null, 2);
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.r() ->> 'state', 'free', 'two people are not a crowd');
do $$ begin perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.2), pg_temp.h(0.8), 'pending', null, null, 3); end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'report'), '{"state": "busy", "report": "crowd"}'::jsonb,
  'enough people agreeing show the room busy, marked as crowd');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(5, 6);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed', pg_temp.h(2), pg_temp.h(4));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until'), jsonb_build_object('state', 'free', 'until', pg_temp.m(2)),
  'a closure later today shortens the free time');

do $$ begin perform pg_temp.base(); perform pg_temp.l(-1, 1, 'active', 'cccccccccccccccccccccc16'); perform aule.refresh_timetable(); end $$;
do $$ begin perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', pg_temp.h(-1), pg_temp.h(1), 'approved', null, 'cccccccccccccccccccccc16'); end $$;
select is(pg_temp.r() ->> 'state', 'free', 'an approved not held frees the room');
select is(pg_temp.pick(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-11-16', 1) -> 'lessons' -> 0, 'status', 'notHeld'),
  '{"status": "cancelled", "notHeld": true}'::jsonb, 'the room page shows the lesson as cancelled and not held');
delete from public.room_requests;
do $$ begin perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', pg_temp.h(-1), pg_temp.h(1), 'pending', null, 'cccccccccccccccccccccc16'); end $$;
select is(pg_temp.r() ->> 'state', 'busy', 'a pending not held has no effect');
delete from public.room_requests;
do $$ begin perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', pg_temp.h(-1), pg_temp.h(1), 'approved', null, 'ffffffffffffffffffffffff'); end $$;
select is(pg_temp.r() ->> 'state', 'busy', 'a not held of another lesson id has no effect');
delete from public.room_requests;
do $$ begin perform pg_temp.req('bbbbbbbbbbbbbbbbbbbbbbbb', 'lesson_not_held', pg_temp.h(-1), pg_temp.h(1), 'approved', null, 'cccccccccccccccccccccc16'); end $$;
select is(pg_temp.r() ->> 'state', 'busy', 'a not held for another room has no effect');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(-1, 1, 'active', 'cccccccccccccccccccccc17'); perform pg_temp.l(-0.5, 2);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', pg_temp.h(-1), pg_temp.h(1), 'approved', null, 'cccccccccccccccccccccc17');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until'), jsonb_build_object('state', 'busy', 'until', pg_temp.m(2)),
  'an overlapping lesson stays busy when another one was not held');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(0.5, 2.5);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.4), pg_temp.h(0.6));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until', 'report'),
  jsonb_build_object('state', 'busy', 'until', pg_temp.m(2.5), 'report', 'occupied'),
  'busy until covers reports and lessons together');
do $$ begin
  perform pg_temp.base(); perform pg_temp.l(-1, 0.5);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed', pg_temp.h(0.6), pg_temp.h(3));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'until', 'report'), jsonb_build_object('until', pg_temp.m(3), 'report', null),
  'a closure right after a lesson extends it, and during a lesson the banner shows the lesson');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(20, 22);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'issue', pg_temp.h(-1), pg_temp.h(100), 'approved', 'proiettore');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'issues'),
  jsonb_build_object('state', 'free', 'issues', jsonb_build_array(jsonb_build_object('category', 'proiettore', 'until', pg_temp.m(100)))),
  'issues are listed but do not change availability');

do $$ begin
  perform pg_temp.base(-40); perform pg_temp.l(5, 6);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.5), pg_temp.h(0.5));
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'issue', pg_temp.h(-1), pg_temp.h(50), 'approved', 'wifi');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until'), '{"state": "unknown", "until": null}'::jsonb,
  'reports never turn stale data into a known state');
select is(pg_temp.pick(pg_temp.r(), 'current', 'next', 'report', 'issues'),
  jsonb_build_object('current', jsonb_build_object('title', 'Segnalata occupata', 'end', pg_temp.m(0.5)),
    'next', jsonb_build_object('title', 'Analisi', 'start', pg_temp.m(5)), 'report', 'occupied',
    'issues', jsonb_build_array(jsonb_build_object('category', 'wifi', 'until', pg_temp.m(50)))),
  'current, next, report and issues stay computed for a grey room');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(-0.5, 1.5, 'active', 'cccccccccccccccccccccc21');
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', pg_temp.h(-1), pg_temp.h(1), 'approved', null, 'cccccccccccccccccccccc21');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.r() ->> 'state', 'busy', 'a not held stops applying if the timetable moves the lesson');
do $$ begin
  perform pg_temp.base();
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1) + interval '1 minute', pg_temp.h(1),
    'active', 'cccccccccccccccccccccc22');
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', pg_temp.h(-1), pg_temp.h(1), 'approved', null, 'cccccccccccccccccccccc22');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.r() ->> 'state', 'busy', 'a not held stops applying if the lesson moves by 1 minute');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(20, 22);
  perform pg_temp.req('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_occupied', pg_temp.h(-0.5), pg_temp.h(0.5));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.r() ->> 'state', 'free', 'reports for other rooms have no effect');

-- The 3 cases of the overrides tests.
do $$ begin
  perform pg_temp.base(); perform pg_temp.l(20, 22);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.5), pg_temp.h(0.5), 'pending');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.r() ->> 'state', 'free', 'a pending report of one person changes nothing');
update public.room_requests set status = 'approved', reviewed_at = now();
select is(pg_temp.r() ->> 'state', 'busy', 'a request approved in the same transaction changes the status at once');
select is(pg_temp.status() -> 'reportsAvailable', 'true'::jsonb, 'reports are always available');
do $$ begin
  perform pg_temp.base(); perform pg_temp.l(-504, -502, 'active', 'cccccccccccccccccccccc33');
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', pg_temp.h(-504), pg_temp.h(-502), 'approved', null, 'cccccccccccccccccccccc33');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-10-26', 1) -> 'lessons' -> 0, 'id', 'status', 'notHeld'),
  '{"id": "cccccccccccccccccccccc33", "status": "cancelled", "notHeld": true}'::jsonb,
  'an approved not held 21 days back still marks the lesson on its day');

-- Edge cases of the chain and of the shown block.
do $$ begin
  perform pg_temp.base(); perform pg_temp.l(-1, 0.5); perform pg_temp.l(0.75, 2); perform aule.refresh_timetable();
end $$;
select is((pg_temp.r() ->> 'until')::bigint, pg_temp.m(2), 'a gap of exactly 15 minutes continues the chain');
do $$ begin
  perform pg_temp.base(); perform pg_temp.l(-1, 0.5);
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(0.75) + interval '1 millisecond', pg_temp.h(2));
  perform aule.refresh_timetable();
end $$;
select is((pg_temp.r() ->> 'until')::bigint, pg_temp.m(0.5), 'a gap of 15 minutes and 1 ms breaks the chain');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(2, 3);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed', pg_temp.h(-1), pg_temp.h(0));
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-1), pg_temp.h(0));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'current', 'report', 'until'),
  jsonb_build_object('state', 'free', 'current', null, 'report', null, 'until', pg_temp.m(2)),
  'a block ending exactly now is not current');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(-1, 0.5); perform pg_temp.l(1.5, 3);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(0.5), pg_temp.h(1.5));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'until', 'report'), jsonb_build_object('until', pg_temp.m(3), 'report', null),
  'a report bridging two lesson islands joins them');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(20, 22);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.2), pg_temp.h(0.8), 'pending', null, null, 1);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.1), pg_temp.h(0.7), 'pending', null, null, 2);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.2), pg_temp.h(0.6), 'pending', null, null, 3);
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'state', 'until', 'current', 'report'),
  jsonb_build_object('state', 'busy', 'until', pg_temp.m(0.8), 'current', jsonb_build_object('title', 'Segnalata occupata', 'end', pg_temp.m(0.8)),
    'report', 'crowd'),
  'a crowd without a lesson is busy until its latest report ends');

do $$ begin
  perform pg_temp.base(); perform pg_temp.l(20, 22);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', pg_temp.h(-0.5), pg_temp.h(0.5));
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed', pg_temp.h(-0.5), pg_temp.h(2));
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.r(), 'report', 'current', 'until'),
  jsonb_build_object('report', 'closed', 'current', jsonb_build_object('title', 'Aula chiusa', 'end', pg_temp.m(2)), 'until', pg_temp.m(2)),
  'closed and occupied together give closed');

do $$ begin perform pg_temp.base(-3); perform pg_temp.l(5, 6); perform aule.refresh_timetable(); end $$;
select is(pg_temp.r() ->> 'state', 'free', 'control: a 3 hour old calendar is fresh with the default limit');
update aule.settings set stale_after = '2 hours';
select is(array[pg_temp.r() ->> 'state', pg_temp.status() ->> 'staleCalendars'], array['unknown', '1'],
  'stale_after at 2 hours makes a 3 hour old calendar grey');
update aule.settings set stale_after = '30 hours';

-- Daylight saving days: Rome midnights bound the day and free until stays within the Rome day.
do $$ begin
  perform pg_temp.clear();
  perform pg_temp.cal('111111111111111111111111', timestamptz '2026-10-24 22:00:00+00', timestamptz '2026-10-20 00:00:00+00',
    timestamptz '2026-11-05 00:00:00+00');
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa');
  perform pg_temp.room('bbbbbbbbbbbbbbbbbbbbbbbb', 'B7');
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', timestamptz '2026-10-25 22:30:00+00', timestamptz '2026-10-25 23:00:00+00');
  perform pg_temp.lesson('111111111111111111111111', 'bbbbbbbbbbbbbbbbbbbbbbbb', timestamptz '2026-10-25 23:30:00+00', timestamptz '2026-10-26 00:30:00+00');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-10-25', 1, timestamptz '2026-10-24 22:30:00+00'), 'from', 'to'),
  jsonb_build_object('from', aule.ms(timestamptz '2026-10-24 22:00:00+00'), 'to', aule.ms(timestamptz '2026-10-25 23:00:00+00')),
  '2026-10-25 at 00:30 in Rome: the day has 25 hours between Rome midnights');
select is(pg_temp.pick(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-10-25', 1, timestamptz '2026-10-25 01:30:00+00'), 'from', 'to'),
  jsonb_build_object('from', aule.ms(timestamptz '2026-10-24 22:00:00+00'), 'to', aule.ms(timestamptz '2026-10-25 23:00:00+00')),
  '2026-10-25 at 02:30 in Rome: same bounds');
select is(array[(pg_temp.r('aaaaaaaaaaaaaaaaaaaaaaaa', timestamptz '2026-10-24 22:30:00+00') ->> 'until')::bigint,
    (pg_temp.r('bbbbbbbbbbbbbbbbbbbbbbbb', timestamptz '2026-10-24 22:30:00+00') ->> 'until')::bigint],
  array[aule.ms(timestamptz '2026-10-25 22:30:00+00'), null],
  '2026-10-25 at 00:30 in Rome: free until 23:30 the same day, not past midnight');
select is(array[(pg_temp.r('aaaaaaaaaaaaaaaaaaaaaaaa', timestamptz '2026-10-25 01:30:00+00') ->> 'until')::bigint,
    (pg_temp.r('bbbbbbbbbbbbbbbbbbbbbbbb', timestamptz '2026-10-25 01:30:00+00') ->> 'until')::bigint],
  array[aule.ms(timestamptz '2026-10-25 22:30:00+00'), null],
  '2026-10-25 at 02:30 in Rome: free until 23:30 the same day, not past midnight');
do $$ begin
  perform pg_temp.clear();
  perform pg_temp.cal('111111111111111111111111', timestamptz '2027-03-27 23:00:00+00', timestamptz '2027-03-20 00:00:00+00',
    timestamptz '2027-04-05 00:00:00+00');
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa');
  perform pg_temp.room('bbbbbbbbbbbbbbbbbbbbbbbb', 'B7');
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', timestamptz '2027-03-28 21:30:00+00', timestamptz '2027-03-28 22:00:00+00');
  perform pg_temp.lesson('111111111111111111111111', 'bbbbbbbbbbbbbbbbbbbbbbbb', timestamptz '2027-03-28 22:30:00+00', timestamptz '2027-03-28 23:30:00+00');
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.pick(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2027-03-28', 1, timestamptz '2027-03-27 23:30:00+00'), 'from', 'to'),
  jsonb_build_object('from', aule.ms(timestamptz '2027-03-27 23:00:00+00'), 'to', aule.ms(timestamptz '2027-03-28 22:00:00+00')),
  '2027-03-28 at 00:30 in Rome: the day has 23 hours between Rome midnights');
select is(pg_temp.pick(pg_temp.lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2027-03-28', 1, timestamp '2027-03-28 02:30' at time zone 'Europe/Rome'), 'from', 'to'),
  jsonb_build_object('from', aule.ms(timestamptz '2027-03-27 23:00:00+00'), 'to', aule.ms(timestamptz '2027-03-28 22:00:00+00')),
  '2027-03-28 at 02:30 in Rome, a time that does not exist: same bounds');
select is(array[(pg_temp.r('aaaaaaaaaaaaaaaaaaaaaaaa', timestamptz '2027-03-27 23:30:00+00') ->> 'until')::bigint,
    (pg_temp.r('bbbbbbbbbbbbbbbbbbbbbbbb', timestamptz '2027-03-27 23:30:00+00') ->> 'until')::bigint],
  array[aule.ms(timestamptz '2027-03-28 21:30:00+00'), null],
  '2027-03-28 at 00:30 in Rome: free until 23:30 the same day, not past midnight');
select is(array[(pg_temp.r('aaaaaaaaaaaaaaaaaaaaaaaa', timestamp '2027-03-28 02:30' at time zone 'Europe/Rome') ->> 'until')::bigint,
    (pg_temp.r('bbbbbbbbbbbbbbbbbbbbbbbb', timestamp '2027-03-28 02:30' at time zone 'Europe/Rome') ->> 'until')::bigint],
  array[aule.ms(timestamptz '2027-03-28 21:30:00+00'), null],
  '2027-03-28 at 02:30 in Rome: free until 23:30 the same day, not past midnight');

-- Last good run.
do $$ begin perform pg_temp.clear(); end $$;
select is(pg_temp.status() -> 'lastRunAt', 'null'::jsonb, 'no run gives a null lastRunAt');
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed, failure) values
  ('schedule', 'finished', pg_temp.h(-6), pg_temp.h(-6), pg_temp.h(-5), pg_temp.h(-200), pg_temp.h(300), 3, 0, null),
  ('schedule', 'finished', pg_temp.h(-4), pg_temp.h(-4), pg_temp.h(-3), pg_temp.h(-200), pg_temp.h(300), 0, 3, null),
  ('manual', 'aborted', pg_temp.h(-2.5), pg_temp.h(-2.5), pg_temp.h(-2), pg_temp.h(-200), pg_temp.h(300), 0, 0, 'implausible');
select is((pg_temp.status() ->> 'lastRunAt')::bigint, pg_temp.m(-5), 'lastRunAt ignores aborted runs and finished runs without an ok calendar');

-- Validation of the room page.
do $$ begin perform pg_temp.base(); perform pg_temp.l(1, 2); perform aule.refresh_timetable(); end $$;
select is(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'xyz', date '2026-11-16', 1)::text$$),
  '!P0001 invalid', 'a malformed room id is invalid');
select is(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'AAAAAAAAAAAAAAAAAAAAAAAA', date '2026-11-16', 1)::text$$),
  '!P0001 invalid', 'an upper case room id is invalid');
select is(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-12-08', 1)::text$$),
  '!P0001 invalid', 'a day 22 days ahead is invalid');
select is(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-10-25', 1)::text$$),
  '!P0001 invalid', 'a day 22 days back is invalid');
select is(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-11-16', 0)::text$$),
  '!P0001 invalid', 'zero days is invalid');
select is(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-11-16', 15)::text$$),
  '!P0001 invalid', '15 days is invalid');
select is(pg_temp.rd($$select aule.room_lessons_at(null, 'aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-11-16', 1)::text$$),
  '!P0001 invalid', 'a missing time is invalid');
select is(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'eeeeeeeeeeeeeeeeeeeeeeee', date '2026-11-16', 1)::text$$),
  '!P0001 not_found', 'an unknown room is not found');
select ok(pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-12-07', 14)::text$$) not like '!%'
  and pg_temp.rd($$select aule.room_lessons_at(timestamptz '2026-11-16 10:30:00+00', 'aaaaaaaaaaaaaaaaaaaaaaaa', date '2026-10-26', 14)::text$$) not like '!%',
  '21 days either way and 14 days are accepted');
select is(pg_temp.rd('select aule.room_status_at(null)::text'), '!P0001 invalid', 'the status needs a time');

-- Sync slots in Rome wall clock time: 06:17 and 13:17.
do $$ begin perform pg_temp.clear(); end $$;
select is(pg_temp.rd($$select aule.slot_due(timestamptz '2026-11-16 04:00:00+00')::text$$), 'false', 'no slot before 06:17 in Rome');
select is(pg_temp.rd($$select aule.slot_due(timestamptz '2026-11-16 10:30:00+00')::text$$), 'true', 'a passed slot without a run is due');
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed) values
  ('schedule', 'finished', aule.rome_time(date '2026-11-16', time '06:00'), aule.rome_time(date '2026-11-16', time '06:00'),
    aule.rome_time(date '2026-11-16', time '06:05'), pg_temp.h(-200), pg_temp.h(300), 1, 0);
select is(pg_temp.rd($$select aule.slot_due(timestamptz '2026-11-16 10:30:00+00')::text$$), 'true', 'a run before the slot does not count');
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed) values
  ('schedule', 'finished', aule.rome_time(date '2026-11-16', time '06:20'), aule.rome_time(date '2026-11-16', time '06:20'),
    aule.rome_time(date '2026-11-16', time '06:25'), pg_temp.h(-200), pg_temp.h(300), 1, 0);
select is(pg_temp.rd($$select aule.slot_due(timestamptz '2026-11-16 10:30:00+00')::text$$), 'false', 'a run after the slot serves it');
select is(pg_temp.rd($$select aule.slot_due(timestamptz '2026-11-16 12:30:00+00')::text$$), 'true', 'the 13:17 slot is due again');
select is(pg_temp.rd('select aule.slot_due(null)::text'), '!P0001 invalid', 'slot_due needs a time');

-- Grants of the read API.
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.room_status()'::regprocedure, 'public.room_lessons(text, date, integer)'::regprocedure,
      'public.search_rooms(text, boolean, integer, integer)'::regprocedure, 'public.sync_requests()'::regprocedure)
      and p.prosecdef and p.proowner = 'aule_reader'::regrole and p.proconfig @> array['search_path=""']),
  4, 'the four public wrappers run as aule_reader with an empty search_path');
select set_eq(
  $$select p.proname::text, r.role from pg_proc p
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_sync', 'aule_ingest', 'aule_config']) as r(role)
    where p.oid in ('public.room_status()'::regprocedure, 'public.room_lessons(text, date, integer)'::regprocedure,
      'public.search_rooms(text, boolean, integer, integer)'::regprocedure, 'public.sync_requests()'::regprocedure,
      'aule.active_overrides(timestamptz)'::regprocedure, 'aule.room_rows_at(timestamptz, text)'::regprocedure,
      'aule.room_status_at(timestamptz)'::regprocedure, 'aule.room_lessons_at(timestamptz, text, date, integer)'::regprocedure,
      'aule.search_at(timestamptz, text, boolean, integer, integer)'::regprocedure, 'aule.slot_due(timestamptz)'::regprocedure)
      and has_function_privilege(r.role, p.oid, 'EXECUTE')$$,
  $$values ('room_status', 'anon'), ('room_lessons', 'anon'), ('search_rooms', 'anon'), ('sync_requests', 'anon')$$,
  'only anon executes the read API, and only its public wrappers');

-- As anon, through the public wrappers that use now().
do $$
declare
  n timestamptz := aule.from_ms(aule.ms(now()));
begin
  perform pg_temp.clear();
  perform pg_temp.cal('111111111111111111111111', n - interval '1 hour', n - interval '168 hours', n + interval '336 hours');
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaaaa');
  perform pg_temp.lesson('111111111111111111111111', 'aaaaaaaaaaaaaaaaaaaaaaaa', n + interval '20 hours', n + interval '22 hours');
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', n - interval '10 minutes', n + interval '50 minutes', 'pending', null, null, 1);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', n - interval '10 minutes', n + interval '50 minutes', 'pending', null, null, 2);
  perform pg_temp.req('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', n - interval '10 minutes', n + interval '50 minutes', 'pending', null, null, 3);
  perform aule.refresh_timetable();
  update aule.settings set sync_slots = '{00:00}';
  update aule.run_requests set pending = false, requested_at = null, requested_by = null, served_at = null;
end $$;
set local role anon;
select is(
  (select e ->> 'report' from jsonb_array_elements(public.room_status() -> 'rooms') e where e ->> 'id' = 'aaaaaaaaaaaaaaaaaaaaaaaa'),
  'crowd', 'anon reads the status with an active crowd');
select ok(public.room_lessons('aaaaaaaaaaaaaaaaaaaaaaaa') ? 'lessons', 'anon reads a room page');
select throws_ok($$select public.search_rooms(repeat('a', 241))$$, 'P0001', 'invalid', 'a 241 byte query is invalid');
select throws_ok($$select public.search_rooms(repeat(U&'\00e8', 121))$$, 'P0001', 'invalid', 'the query limit counts bytes');
select throws_ok($$select public.room_lessons('%')$$, 'P0001', 'invalid', 'a percent sign is not a room id');
select throws_ok($$select public.room_lessons('aaaaaaaaaaaaaaaaaaaaaaa%')$$, 'P0001', 'invalid', 'a wildcard in a room id is invalid');
select throws_ok($$select public.room_lessons(repeat('a', 100000))$$, 'P0001', 'invalid', 'a very long room id is invalid');
select throws_ok($$select public.room_lessons(null)$$, 'P0001', 'invalid', 'a missing room id is invalid');
select throws_ok($$select public.room_lessons('aaaaaaaaaaaaaaaaaaaaaaaa', date '2099-12-31', 1)$$, 'P0001', 'invalid', 'a far day is invalid');
select throws_ok($$select public.room_lessons('aaaaaaaaaaaaaaaaaaaaaaaa', null, 0)$$, 'P0001', 'invalid', 'zero days through the wrapper is invalid');
select throws_ok($$select aule.room_status_at(now())$$, '42501', null, 'anon cannot reach schema aule');
select is(public.sync_requests(), '{"sync": true, "discover": false}'::jsonb, 'a slot passed today without a run asks for a sync');
reset role;
insert into aule.sync_runs (trigger, state, started_at, last_seen_at, finished_at, window_from, window_to, ok, failed) values
  ('schedule', 'finished', now(), now(), now(), now() - interval '168 hours', now() + interval '336 hours', 1, 0);
set local role anon;
select is(public.sync_requests(), '{"sync": false, "discover": false}'::jsonb, 'a run after the slot clears it');
reset role;
update aule.run_requests set pending = true, requested_at = now() where kind = 'discover';
set local role anon;
select is(public.sync_requests(), '{"sync": false, "discover": true}'::jsonb, 'two booleans, nothing else: a discover request shows');
reset role;

select * from finish();
rollback;
