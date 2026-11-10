begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

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

-- Fixed time: 2026-11-16 11:30 in Rome. h(x) is x hours from it.
create function pg_temp.h(p numeric) returns timestamptz language sql immutable as $$
  select timestamptz '2026-11-16 10:30:00+00' + p * interval '1 hour'
$$;
create function pg_temp.s(p_query text, p_free boolean default false, p_hours integer default null, p_seats integer default null)
returns text language sql as $$
  select pg_temp.rd(format('select aule.search_at(%L, %L, %L, %L, %L)::text',
    timestamptz '2026-11-16 10:30:00+00', p_query, p_free, p_hours, p_seats))
$$;
create function pg_temp.ids(p text, p_key text default 'rooms', p_field text default 'id') returns text[] language sql immutable as $$
  select array(select x.e ->> p_field from jsonb_array_elements(p::jsonb -> p_key) with ordinality as x(e, i) order by x.i)
$$;
-- Precomputed columns as buildPayload computes them.
create function pg_temp.room(p_id text, p_name text, p_building text, p_guess text, p_capacity integer default 50)
returns void language sql as $$
  insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key,
    name_compact, search_text)
  values (p_id, p_name, '', p_building, p_capacity, 30, '{}', p_guess,
    regexp_replace(regexp_replace(lower(p_name), '^aula\s+', ''), '[^a-z0-9]', '', 'g'),
    replace(regexp_replace(lower(p_name), '^aula ', ''), ' ', ''),
    lower(p_name || ' ' || p_building))
$$;
create function pg_temp.lesson(p_id text, p_title text, p_room text, p_start numeric, p_teachers text[] default '{}',
  p_courses text[] default '{}', p_cal text default '111111111111111111111111')
returns void language sql as $$
  insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
    title_text, direct_text, course_text)
  values (p_cal, p_id, p_title, pg_temp.h(p_start), pg_temp.h(p_start + 2), 'active', '', p_courses, null, p_teachers, array[p_room],
    lower(p_title),
    lower(concat_ws(' ', p_title, nullif(array_to_string(p_teachers, ' '), ''))),
    lower(concat_ws(' ', p_title, nullif(array_to_string(p_teachers, ' '), ''), nullif(array_to_string(p_courses, ' '), ''))))
$$;

-- Rooms whose states equal the fixtures of the search tests: r1 free all day, r2 busy for 1 hour,
-- r3 free for 30 minutes, r4 unknown (stale calendar).
delete from aule.calendar_data;
delete from aule.rooms;
delete from aule.sync_runs;
delete from aule.unique_lessons;
delete from aule.lesson_rooms;
delete from aule.room_calendars;
delete from aule.room_floors;
delete from aule.building_links;
delete from aule.building_shapes;
delete from aule.room_seeds;
delete from public.room_requests;
update aule.settings set stale_after = '30 hours';
insert into aule.calendars (id, label) values
  ('111111111111111111111111', 'Calendario di prova'), ('222222222222222222222222', 'Calendario vecchio')
on conflict (id) do nothing;
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to) values
  ('111111111111111111111111', pg_temp.h(-1), pg_temp.h(-168), pg_temp.h(336)),
  ('222222222222222222222222', pg_temp.h(-40), pg_temp.h(-100), pg_temp.h(100));
do $$ begin
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa01', 'MT1', 'Cubo 30B', 'cubo-30b', 110);
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa02', 'MT13', 'Cubo 30B', 'cubo-30b');
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa03', 'B6', 'Cubo 4D', 'cubo-4d', 40);
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa04', 'Aula Magna', 'Aula Magna', 'aula-magna');
  perform pg_temp.lesson('dddddddddddddddddddddd01', 'Ricevimento', 'aaaaaaaaaaaaaaaaaaaaaa01', 20);
  perform pg_temp.lesson('dddddddddddddddddddddd02', 'Ricevimento', 'aaaaaaaaaaaaaaaaaaaaaa02', -1);
  perform pg_temp.lesson('dddddddddddddddddddddd03', 'Ricevimento', 'aaaaaaaaaaaaaaaaaaaaaa03', 0.5);
  perform pg_temp.lesson('dddddddddddddddddddddd04', 'Ricevimento', 'aaaaaaaaaaaaaaaaaaaaaa04', 5, '{}', '{}', '222222222222222222222222');
  perform aule.refresh_timetable();
end $$;

-- Room and filter cases.
select is(pg_temp.ids(pg_temp.s('aula mt1')), array['aaaaaaaaaaaaaaaaaaaaaa01', 'aaaaaaaaaaaaaaaaaaaaaa02'],
  'room name search puts the exact match first and ignores the word aula');
select is(pg_temp.ids(pg_temp.s('30b')), array['aaaaaaaaaaaaaaaaaaaaaa01', 'aaaaaaaaaaaaaaaaaaaaaa02'], 'a cube code finds all its rooms');
select is(pg_temp.ids(pg_temp.s(null, true)), array['aaaaaaaaaaaaaaaaaaaaaa01', 'aaaaaaaaaaaaaaaaaaaaaa03'],
  'free now, the longest free first');
select is(pg_temp.ids(pg_temp.s(null, false, 1)), array['aaaaaaaaaaaaaaaaaaaaaa01'], 'free for at least 1 hour');
select is(pg_temp.ids(pg_temp.s(null, true, null, 100)), array['aaaaaaaaaaaaaaaaaaaaaa01'], 'free now with at least 100 seats');
select is(pg_temp.ids(pg_temp.s('magna')), array['aaaaaaaaaaaaaaaaaaaaaa04'], 'control: an unknown room matches a plain query');
select is(pg_temp.ids(pg_temp.s('magna', true)), '{}'::text[], 'unknown rooms never match the free filters');
select is(pg_temp.s(null)::jsonb, '{"rooms": [], "lessons": []}'::jsonb, 'no query and no filter returns nothing');

-- Validation.
select is(pg_temp.s('mt  1'), '!P0001 invalid', 'a query with two spaces is invalid');
select is(pg_temp.s('MT1'), '!P0001 invalid', 'an upper case query is invalid');
select is(pg_temp.s(repeat('a', 61)), '!P0001 invalid', 'a 61 character query is invalid');
select is(pg_temp.s(null, false, 13), '!P0001 invalid', '13 hours is invalid');
select is(pg_temp.s(null, false, 0), '!P0001 invalid', '0 hours is invalid');
select is(pg_temp.s(null, false, null, 0), '!P0001 invalid', '0 seats is invalid');
select is(pg_temp.s(null, false, null, 2001), '!P0001 invalid', '2001 seats is invalid');
select is(pg_temp.s('mt1', null), '!P0001 invalid', 'a missing free flag is invalid');

-- Lesson cases.
do $$ begin
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee01', 'ANALISI MATEMATICA I', 'aaaaaaaaaaaaaaaaaaaaaa01', 1, '{Anna Bianchi}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee02', 'ANALISI MATEMATICA I', 'aaaaaaaaaaaaaaaaaaaaaa01', 25, '{Anna Bianchi}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee03', 'ANALISI MATEMATICA I', 'aaaaaaaaaaaaaaaaaaaaaa03', -5, '{Anna Bianchi}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee04', 'FISICA', 'aaaaaaaaaaaaaaaaaaaaaa02', 2, '{Carlo Verdi}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeeec1', 'SOCIOLOGIA', 'aaaaaaaaaaaaaaaaaaaaaa01', 1, '{}', '{SCIENZE POLITICHE}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeeec2', 'TEORIE POLITICHE', 'aaaaaaaaaaaaaaaaaaaaaa02', 5);
  perform aule.refresh_timetable();
end $$;
select is(pg_temp.ids(pg_temp.s('analisi'), 'lessons', 'lessonId'), array['eeeeeeeeeeeeeeeeeeeeee01'],
  'course search returns the next lesson per course and room');
select is(pg_temp.s('analisi')::jsonb -> 'lessons' -> 0,
  jsonb_build_object('lessonId', 'eeeeeeeeeeeeeeeeeeeeee01', 'title', 'ANALISI MATEMATICA I', 'start', aule.ms(pg_temp.h(1)),
    'end', aule.ms(pg_temp.h(3)), 'teachers', jsonb_build_array('Anna Bianchi'), 'roomId', 'aaaaaaaaaaaaaaaaaaaaaa01',
    'roomName', 'MT1', 'buildingName', 'Cubo 30B', 'buildingKey', 'cubo-30b', 'floor', null,
    'bridge', null),
  'a lesson hit carries the room labels');
select is(pg_temp.ids(pg_temp.s('verdi'), 'lessons', 'lessonId'), array['eeeeeeeeeeeeeeeeeeeeee04'], 'teacher search finds the lesson');
select is(pg_temp.ids(pg_temp.s('politiche'), 'lessons', 'lessonId'), array['eeeeeeeeeeeeeeeeeeeeeec2', 'eeeeeeeeeeeeeeeeeeeeeec1'],
  'lessons matching the title come before those matching only the degree course');
select ok(not (pg_temp.s('politiche')::jsonb -> 'lessons' -> 0 ? 'rank'), 'the output has no rank key');
select is(pg_temp.s('teorie')::jsonb -> 'lessons' -> 0 -> 'teachers', '[]'::jsonb,
  'a lesson hit stored without teacher names keeps the teachers field as an empty array');
select is(pg_temp.s('fisica', true)::jsonb,
  jsonb_build_object('rooms', '[]'::jsonb, 'lessons', jsonb_build_array(jsonb_build_object('lessonId', 'eeeeeeeeeeeeeeeeeeeeee04',
    'title', 'FISICA', 'start', aule.ms(pg_temp.h(2)), 'end', aule.ms(pg_temp.h(4)), 'teachers', jsonb_build_array('Carlo Verdi'),
    'roomId', 'aaaaaaaaaaaaaaaaaaaaaa02', 'roomName', 'MT13', 'buildingName', 'Cubo 30B', 'buildingKey', 'cubo-30b', 'floor', null,
    'bridge', null))),
  'a filter with a query still returns lesson hits in busy rooms');
select is(pg_temp.s('%')::jsonb, '{"rooms": [], "lessons": []}'::jsonb, 'a percent sign is a plain character, not a wildcard');
select is(pg_temp.s('_')::jsonb, '{"rooms": [], "lessons": []}'::jsonb, 'an underscore is a plain character, not a wildcard');

-- A building link changes room hits at once.
do $$ begin perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa05', 'P1', 'Polo nuovo', 'polo-nuovo'); end $$;
select is(pg_temp.ids(pg_temp.s('4d')), array['aaaaaaaaaaaaaaaaaaaaaa03'], 'control: a room of an unknown building has no cube code');
do $$ begin
  if to_regprocedure('aule.config_link_building(text, text, uuid)') is null then
    insert into aule.building_links (planner_name, campus_key) values ('Polo nuovo', 'cubo-4d');
  else
    perform aule.config_link_building('Polo nuovo', 'cubo-4d', null::uuid);
  end if;
end $$;
select is(pg_temp.ids(pg_temp.s('4d')), array['aaaaaaaaaaaaaaaaaaaaaa03', 'aaaaaaaaaaaaaaaaaaaaaa05'], 'a new building link changes room hits at once');

-- Lessons confirmed as not held are not proposed.
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('60000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente@studenti.unical.it', now());
delete from aule.lessons where id like 'eeee%';
do $$ begin
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee11', 'ANALISI', 'aaaaaaaaaaaaaaaaaaaaaa01', 1);
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee12', 'ANALISI', 'aaaaaaaaaaaaaaaaaaaaaa01', 25);
  perform aule.refresh_timetable();
end $$;
insert into public.room_requests (room_id, kind, starts_at, ends_at, status, created_by, reviewed_at, lesson_id) values
  ('aaaaaaaaaaaaaaaaaaaaaa01', 'lesson_not_held', pg_temp.h(1), pg_temp.h(3), 'approved', '60000000-0000-0000-0000-000000000001', now(),
    'eeeeeeeeeeeeeeeeeeeeee11');
select is(pg_temp.ids(pg_temp.s('analisi'), 'lessons', 'lessonId'), array['eeeeeeeeeeeeeeeeeeeeee12'], 'lessons confirmed as not held are not proposed');

-- A room on a bridge has no floor, in room and lesson hits alike.
insert into aule.room_floors (room_id, bridge) values ('aaaaaaaaaaaaaaaaaaaaaa01', 'coperto');
select is(
  (select jsonb_build_object('floor', e -> 'floor', 'bridge', e -> 'bridge')
    from jsonb_array_elements(pg_temp.s('analisi')::jsonb -> 'lessons') e),
  '{"floor": null, "bridge": "coperto"}'::jsonb, 'a lesson hit in a bridge room carries the bridge');
select is(
  (select jsonb_build_object('floor', e -> 'floor', 'bridge', e -> 'bridge')
    from jsonb_array_elements(pg_temp.s('mt1')::jsonb -> 'rooms') e
    where e ->> 'id' = 'aaaaaaaaaaaaaaaaaaaaaa01'),
  '{"floor": null, "bridge": "coperto"}'::jsonb, 'so does the room hit');
delete from aule.room_floors;

-- Results are capped.
do $$ begin
  for i in 0..199 loop
    perform pg_temp.room(lpad(to_hex(4096 + i), 24, 'b'), 'Aula ' || i, 'Cubo 30B', 'cubo-30b');
    perform pg_temp.lesson(lpad(to_hex(4096 + i), 24, 'd'), 'Seminario', lpad(to_hex(4096 + i), 24, 'b'), 20);
  end loop;
  perform aule.refresh_timetable();
end $$;
select is(cardinality(pg_temp.ids(pg_temp.s(null, true))), 50, 'room results are capped at 50');
select is(cardinality(pg_temp.ids(pg_temp.s('seminario'), 'lessons', 'lessonId')), 20, 'lesson results are capped at 20');

-- As anon, through the public wrapper.
set local role anon;
select is(
  array(select e ->> 'id' from jsonb_array_elements(public.search_rooms('aula mt1') -> 'rooms') with ordinality as x(e, i) order by i),
  array['aaaaaaaaaaaaaaaaaaaaaa01', 'aaaaaaaaaaaaaaaaaaaaaa02'], 'anon searches rooms');
select is(public.search_rooms(), '{"rooms": [], "lessons": []}'::jsonb, 'anon without query and filter gets nothing');
select is(public.search_rooms(''), '{"rooms": [], "lessons": []}'::jsonb, 'an empty query is no query');
select throws_ok($$select public.search_rooms('mt1', false, 13)$$, 'P0001', 'invalid', 'the wrapper validates again');
reset role;

select * from finish();
rollback;
