begin;
create extension if not exists pgtap with schema extensions;
select plan(114);

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
create function pg_temp.c(p_query text, p_now timestamptz default timestamptz '2026-11-16 10:30:00+00') returns text language sql as $$
  select pg_temp.rd(format('select aule.courses_at(%L, %L)::text', p_now, p_query))
$$;
create function pg_temp.tt(p_keys text[], p_from date default date '2026-11-16', p_days integer default 1,
  p_now timestamptz default timestamptz '2026-11-16 10:30:00+00')
returns text language sql as $$
  select pg_temp.rd(format('select aule.course_timetable_at(%L, %L, %L, %L)::text', p_now, p_keys, p_from, p_days))
$$;
-- The key formula, written again here: a change of aule.course_key breaks the keys that clients have stored.
create function pg_temp.k(p_title_text text, p_degree text) returns text language sql immutable as $$
  select md5(p_title_text || chr(31) || p_degree)
$$;
create function pg_temp.col(p text, p_key text, p_field text) returns text[] language sql immutable as $$
  select array(select x.e ->> p_field from jsonb_array_elements(p::jsonb -> p_key) with ordinality as x(e, i) order by x.i)
$$;
create function pg_temp.fields(p jsonb) returns text[] language sql immutable as $$
  select array(select jsonb_object_keys(p) order by 1)
$$;
create function pg_temp.room(p_id text, p_name text, p_building text, p_guess text)
returns void language sql as $$
  insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key,
    name_compact, search_text)
  values (p_id, p_name, '', p_building, 50, 30, '{}', p_guess, regexp_replace(lower(p_name), '[^a-z0-9]', '', 'g'),
    replace(lower(p_name), ' ', ''), lower(p_name))
$$;
-- Lessons last 2 hours. The teacher is stored as a sync with teacher names would store it.
create function pg_temp.lesson(p_id text, p_title text, p_courses text[], p_start numeric, p_rooms text[],
  p_status text default 'active', p_year integer default null, p_cal text default '111111111111111111111111')
returns void language sql as $$
  insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
    title_text, direct_text, course_text)
  values (p_cal, p_id, p_title, pg_temp.h(p_start), pg_temp.h(p_start + 2), p_status::aule.lesson_status, 'Lezione di prova',
    p_courses, p_year, '{Docente Inventato}', p_rooms, lower(p_title), lower(p_title || ' docente inventato'),
    lower(concat_ws(' ', p_title, 'docente inventato', nullif(array_to_string(p_courses, ' '), ''))))
$$;
create function pg_temp.not_held(p_room text, p_lesson text, p_start numeric) returns void language sql as $$
  insert into public.room_requests (room_id, kind, starts_at, ends_at, status, created_by, reviewed_at, lesson_id)
  values (p_room, 'lesson_not_held', pg_temp.h(p_start), pg_temp.h(p_start + 2), 'approved',
    '70000000-0000-0000-0000-000000000001', now(), p_lesson)
$$;

delete from aule.calendar_data;
delete from aule.rooms;
delete from aule.sync_runs;
delete from aule.unique_lessons;
delete from aule.lesson_rooms;
delete from aule.room_calendars;
delete from aule.room_floors;
delete from aule.building_links;
delete from aule.room_seeds;
delete from public.room_requests;
update aule.settings set stale_after = '30 hours';
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('70000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'studente7@studenti.unical.it', now());
insert into aule.calendars (id, label) values
  ('111111111111111111111111', 'Calendario di prova'), ('222222222222222222222222', 'Calendario vecchio')
on conflict (id) do nothing;
-- Calendar 1 is fresh, calendar 2 was fetched 40 hours ago.
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to) values
  ('111111111111111111111111', pg_temp.h(-1), pg_temp.h(-168), pg_temp.h(336)),
  ('222222222222222222222222', pg_temp.h(-40), pg_temp.h(-168), pg_temp.h(336));

-- Room 3 has no building name and no floor.
do $$ begin
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa01', 'MT5', 'Cubo 31A', 'cubo-31a');
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa02', 'MT6', 'Cubo 31A', 'cubo-31a');
  perform pg_temp.room('aaaaaaaaaaaaaaaaaaaaaa03', 'Sala Prove', '', null);
end $$;
insert into aule.room_floors (room_id, floor) values ('aaaaaaaaaaaaaaaaaaaaaa01', 0);

-- e01, e02, e03, e12: (analisi matematica 1, MATEMATICA). e03 also FISICA, under another spelling. e04: no degree course.
-- e12 ends at midnight in Rome. e05 cancelled, e06 not held in its only room, e07 not held in one room of two.
do $$ begin
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee01', 'ANALISI MATEMATICA 1', '{MATEMATICA (triennale)}', 1, '{aaaaaaaaaaaaaaaaaaaaaa01}', 'active', 2);
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee02', 'ANALISI MATEMATICA 1', '{MATEMATICA (triennale)}', 25, '{aaaaaaaaaaaaaaaaaaaaaa02}', 'active', 1);
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee03', 'Analisi Matematica 1', '{MATEMATICA (triennale),FISICA (triennale)}', -5,
    '{aaaaaaaaaaaaaaaaaaaaaa01,aaaaaaaaaaaaaaaaaaaaaa02}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee04', 'ANALISI MATEMATICA 1', '{}', 3, '{aaaaaaaaaaaaaaaaaaaaaa03}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee12', 'ANALISI MATEMATICA 1', '{MATEMATICA (triennale)}', 10.5, '{aaaaaaaaaaaaaaaaaaaaaa01}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee05', 'GEOMETRIA', '{MATEMATICA (triennale)}', 2, '{aaaaaaaaaaaaaaaaaaaaaa02}', 'cancelled');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee06', 'GEOMETRIA', '{MATEMATICA (triennale)}', 26, '{aaaaaaaaaaaaaaaaaaaaaa02}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee07', 'GEOMETRIA', '{MATEMATICA (triennale)}', 50,
    '{aaaaaaaaaaaaaaaaaaaaaa01,aaaaaaaaaaaaaaaaaaaaaa02}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee08', 'TEORIA DEI GRAFI', '{INFORMATICA (magistrale)}', 4, '{aaaaaaaaaaaaaaaaaaaaaa02}', 'active', 1);
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee09', 'INFORMATICA GIURIDICA', '{GIURISPRUDENZA}', 5, '{aaaaaaaaaaaaaaaaaaaaaa02}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee10', 'CHIMICA', array['SOSTENIBILITÀ AMBIENTALE (prova)'], 6, '{aaaaaaaaaaaaaaaaaaaaaa01}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee11', 'STORIA ANTICA', '{LETTERE}', 6, '{aaaaaaaaaaaaaaaaaaaaaa02}', 'active', null,
    '222222222222222222222222');
  -- e13, e14, e15: an exam, a booking and another commitment, as the sync stores them. e16: a real course called "Esame".
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee13', 'Esame', '{}', 200, '{aaaaaaaaaaaaaaaaaaaaaa03}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee14', 'Prenotazione', '{}', 203, '{aaaaaaaaaaaaaaaaaaaaaa03}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee15', 'Altro impegno', '{}', 206, '{aaaaaaaaaaaaaaaaaaaaaa03}');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee16', 'Esame', '{MEDICINA (prova)}', 209, '{aaaaaaaaaaaaaaaaaaaaaa03}');
  perform aule.refresh_timetable();
  perform pg_temp.not_held('aaaaaaaaaaaaaaaaaaaaaa02', 'eeeeeeeeeeeeeeeeeeeeee06', 26);
  perform pg_temp.not_held('aaaaaaaaaaaaaaaaaaaaaa01', 'eeeeeeeeeeeeeeeeeeeeee07', 50);
end $$;

create temp table keys as select
  pg_temp.k('analisi matematica 1', 'MATEMATICA (triennale)') as ka,
  pg_temp.k('analisi matematica 1', 'FISICA (triennale)') as kf,
  pg_temp.k('analisi matematica 1', '') as ke,
  pg_temp.k('geometria', 'MATEMATICA (triennale)') as kg,
  pg_temp.k('storia antica', 'LETTERE') as ks,
  repeat('0', 32) as kx;

-- The key.
select is(pg_temp.rd($$select aule.course_key('analisi matematica 1', 'MATEMATICA (triennale)')$$), 'b4af076320288714b0f4ad6dceab40a4',
  'the key is the md5 of title text, unit separator and degree label');
select is(pg_temp.rd($$select aule.course_key('analisi matematica 1', '')$$), '8f9a70e1b2b491e1e3449cede3d94bfa',
  'a course without degree has its own key');
select isnt(pg_temp.rd($$select aule.course_key('a', 'b c')$$), pg_temp.rd($$select aule.course_key('a b', 'c')$$),
  'the separator keeps title and degree apart');

-- Course search: grouping.
select is(pg_temp.col(pg_temp.c('analisi'), 'courses', 'degree'), array['', 'FISICA (triennale)', 'MATEMATICA (triennale)'],
  'one course per title and degree: a lesson of two degrees is in both, one without degree under the empty label');
select is(pg_temp.col(pg_temp.c('analisi'), 'courses', 'key'), (select array[ke, kf, ka] from keys), 'each course carries its key');
select is(pg_temp.c('analisi')::jsonb -> 'courses' -> 2,
  jsonb_build_object('key', (select ka from keys), 'title', 'ANALISI MATEMATICA 1', 'degree', 'MATEMATICA (triennale)', 'year', 1,
    'next', jsonb_build_object('start', pg_temp.m(1), 'end', pg_temp.m(3), 'roomName', 'MT5', 'buildingName', 'Cubo 31A')),
  'a course: first spelling in byte order, smallest year, next lesson with its first room');
select is(pg_temp.c('analisi')::jsonb -> 'courses' -> 1,
  jsonb_build_object('key', (select kf from keys), 'title', 'Analisi Matematica 1', 'degree', 'FISICA (triennale)', 'year', null,
    'next', null),
  'a course whose lessons are all over has no next lesson and, without years, a null year');
select is(pg_temp.c('analisi')::jsonb -> 'courses' -> 0 -> 'next',
  jsonb_build_object('start', pg_temp.m(3), 'end', pg_temp.m(5), 'roomName', 'Sala Prove', 'buildingName', null),
  'a room without building name gives a null buildingName');
select is(pg_temp.fields(pg_temp.c('analisi')::jsonb -> 'courses' -> 2), array['degree', 'key', 'next', 'title', 'year'],
  'a course has exactly five fields');
select is(pg_temp.fields(pg_temp.c('analisi')::jsonb -> 'courses' -> 2 -> 'next'), array['buildingName', 'end', 'roomName', 'start'],
  'next has exactly four fields');
select is(pg_temp.fields(pg_temp.c('analisi')::jsonb), array['courses'], 'the answer holds only the courses');

-- What is not a lesson is not a course.
select is(pg_temp.col(pg_temp.c('esame'), 'courses', 'degree'), array['MEDICINA (prova)'],
  'an exam slot without degree is not a course, a real course with the same title is');
select is(pg_temp.c('prenotazione')::jsonb -> 'courses', '[]'::jsonb, 'a booking is not a course');
select is(pg_temp.c('altro impegno')::jsonb -> 'courses', '[]'::jsonb, 'nor another commitment');
select is(pg_temp.tt(array[pg_temp.k('esame', ''), pg_temp.k('prenotazione', ''), pg_temp.k('altro impegno', '')], date '2026-11-16', 14)::jsonb
    - 'now' - 'from' - 'to' - 'stale',
  jsonb_build_object('missing', to_jsonb(array(
      select v from unnest(array[pg_temp.k('esame', ''), pg_temp.k('prenotazione', ''), pg_temp.k('altro impegno', '')]) as u(v)
      order by v collate "C")), 'lessons', '[]'::jsonb),
  'their keys match no course and bring no lesson');
select is(pg_temp.col(pg_temp.tt(array[pg_temp.k('esame', 'MEDICINA (prova)')], date '2026-11-16', 14), 'lessons', 'id'),
  array['eeeeeeeeeeeeeeeeeeeeee16'], 'the real course keeps its lesson');

-- Course search: next.
select is(pg_temp.c('analisi', pg_temp.h(2))::jsonb -> 'courses' -> 2 -> 'next' ->> 'start', pg_temp.m(1)::text,
  'a lesson in progress is still the next one');
select is(pg_temp.c('analisi', pg_temp.h(3))::jsonb -> 'courses' -> 2 -> 'next' ->> 'start', pg_temp.m(10.5)::text,
  'a lesson ending exactly now is over');
select is(pg_temp.c('geometria')::jsonb -> 'courses' -> 0 -> 'next',
  jsonb_build_object('start', pg_temp.m(50), 'end', pg_temp.m(52), 'roomName', 'MT6', 'buildingName', 'Cubo 31A'),
  'next skips cancelled and not held lessons and shows the first room where the lesson is held');

-- Course search: matching and ranking.
select is(pg_temp.col(pg_temp.c('informatica'), 'courses', 'title'), array['INFORMATICA GIURIDICA', 'TEORIA DEI GRAFI'],
  'title matches come before matches on the degree label only');
select ok(not (pg_temp.c('informatica')::jsonb -> 'courses' -> 0 ? 'rank'), 'the output has no rank field');
select is(pg_temp.col(pg_temp.c('grafi magistrale'), 'courses', 'title'), array['TEORIA DEI GRAFI'],
  'tokens may be split between title and degree label');
select is(pg_temp.col(pg_temp.c('sostenibilita'), 'courses', 'title'), array['CHIMICA'], 'the degree label is matched without accents');
select is(pg_temp.col(pg_temp.c('analisimatematica'), 'courses', 'degree'), array['', 'FISICA (triennale)', 'MATEMATICA (triennale)'],
  'a token may span two words');
select is(pg_temp.c('analisi chimica')::jsonb, '{"courses": []}'::jsonb, 'every token must match');
select is(pg_temp.c('%')::jsonb, '{"courses": []}'::jsonb, 'a percent sign is a plain character, not a wildcard');
select is(pg_temp.c('_')::jsonb, '{"courses": []}'::jsonb, 'an underscore is a plain character, not a wildcard');
select is(pg_temp.c('inventato')::jsonb, '{"courses": []}'::jsonb, 'teacher names are never searched');
select is(pg_temp.c('docente')::jsonb, '{"courses": []}'::jsonb, 'not even by a word that only the teacher text holds');
select ok(pg_temp.c('a') !~* 'inventato|docente|teacher|lezione di prova', 'no teacher name and no kind in the course list');

-- Course search: validation.
select is(pg_temp.c(null), '!P0001 invalid', 'a missing query is invalid');
select is(pg_temp.c(''), '!P0001 invalid', 'an empty query is invalid');
select is(pg_temp.c('ANALISI'), '!P0001 invalid', 'an upper case query is invalid');
select is(pg_temp.c('analisi  1'), '!P0001 invalid', 'a query with two spaces is invalid');
select is(pg_temp.c(' analisi'), '!P0001 invalid', 'a query with a leading space is invalid');
select is(pg_temp.c(repeat('a', 61)), '!P0001 invalid', 'a 61 character query is invalid');
select is(pg_temp.c(repeat('a', 60))::jsonb, '{"courses": []}'::jsonb, 'a 60 character query is valid');
select is(pg_temp.c('analisi', null), '!P0001 invalid', 'courses_at needs a time');

-- Timetable: shape and grouping.
select is(pg_temp.col(pg_temp.tt((select array[ka] from keys)), 'lessons', 'id'),
  array['eeeeeeeeeeeeeeeeeeeeee03', 'eeeeeeeeeeeeeeeeeeeeee01', 'eeeeeeeeeeeeeeeeeeeeee12'],
  'the lessons of a course in the day, by start, in every spelling of the title');
select is(pg_temp.tt((select array[ka] from keys))::jsonb - 'lessons',
  jsonb_build_object('now', pg_temp.m(0), 'from', aule.ms(timestamptz '2026-11-15 23:00:00+00'),
    'to', aule.ms(timestamptz '2026-11-16 23:00:00+00'), 'stale', false, 'missing', '[]'::jsonb),
  'the window is whole days in Rome; fresh data and known keys give stale false and nothing missing');
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'lessons' -> 1,
  jsonb_build_object('key', (select ka from keys), 'id', 'eeeeeeeeeeeeeeeeeeeeee01', 'title', 'ANALISI MATEMATICA 1',
    'start', pg_temp.m(1), 'end', pg_temp.m(3), 'status', 'active',
    'rooms', jsonb_build_array(jsonb_build_object('id', 'aaaaaaaaaaaaaaaaaaaaaa01', 'name', 'MT5', 'buildingName', 'Cubo 31A', 'floor', 0))),
  'a lesson carries key, id, title, times, status and rooms');
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'lessons' -> 0 -> 'rooms',
  jsonb_build_array(
    jsonb_build_object('id', 'aaaaaaaaaaaaaaaaaaaaaa01', 'name', 'MT5', 'buildingName', 'Cubo 31A', 'floor', 0),
    jsonb_build_object('id', 'aaaaaaaaaaaaaaaaaaaaaa02', 'name', 'MT6', 'buildingName', 'Cubo 31A', 'floor', null)),
  'rooms keep the order of the lesson; a room without floor has a null floor');
select is(pg_temp.tt((select array[ke] from keys))::jsonb -> 'lessons',
  jsonb_build_array(jsonb_build_object('key', (select ke from keys), 'id', 'eeeeeeeeeeeeeeeeeeeeee04', 'title', 'ANALISI MATEMATICA 1',
    'start', pg_temp.m(3), 'end', pg_temp.m(5), 'status', 'active',
    'rooms', jsonb_build_array(jsonb_build_object('id', 'aaaaaaaaaaaaaaaaaaaaaa03', 'name', 'Sala Prove', 'buildingName', null,
      'floor', null)))),
  'the course without degree holds only the lessons without degree; an empty building name is null');
select is(
  array(select (e ->> 'id') || ' ' || (e ->> 'key')
    from jsonb_array_elements(pg_temp.tt((select array[ka, kf] from keys))::jsonb -> 'lessons') with ordinality as x(e, i) order by i),
  (select array['eeeeeeeeeeeeeeeeeeeeee03 ' || least(ka collate "C", kf collate "C"),
    'eeeeeeeeeeeeeeeeeeeeee03 ' || greatest(ka collate "C", kf collate "C"),
    'eeeeeeeeeeeeeeeeeeeeee01 ' || ka, 'eeeeeeeeeeeeeeeeeeeeee12 ' || ka] from keys),
  'a lesson of two requested courses appears once per key, ordered by start, id and key');
select is(pg_temp.fields(pg_temp.tt((select array[ka] from keys))::jsonb), array['from', 'lessons', 'missing', 'now', 'stale', 'to'],
  'the answer has exactly six fields');
select is(pg_temp.fields(pg_temp.tt((select array[ka] from keys))::jsonb -> 'lessons' -> 0),
  array['end', 'id', 'key', 'rooms', 'start', 'status', 'title'], 'a lesson has exactly seven fields');
select is(pg_temp.fields(pg_temp.tt((select array[ka] from keys))::jsonb -> 'lessons' -> 0 -> 'rooms' -> 0),
  array['buildingName', 'floor', 'id', 'name'], 'a room has exactly four fields');
select ok(pg_temp.tt((select array[ka, kf, ke, kg, ks] from keys), date '2026-11-16', 14) !~* 'inventato|docente|teacher|lezione di prova',
  'no teacher name and no kind in the timetable');

-- Timetable: the date window.
select is(pg_temp.col(pg_temp.tt((select array[ka] from keys), date '2026-11-17'), 'lessons', 'id'), array['eeeeeeeeeeeeeeeeeeeeee02'],
  'a lesson ending at midnight belongs to the day before only');
select is(pg_temp.col(pg_temp.tt((select array[ka] from keys), date '2026-11-16', 2), 'lessons', 'id'),
  array['eeeeeeeeeeeeeeeeeeeeee03', 'eeeeeeeeeeeeeeeeeeeeee01', 'eeeeeeeeeeeeeeeeeeeeee12', 'eeeeeeeeeeeeeeeeeeeeee02'],
  'two days hold the lessons of both');
select is(pg_temp.tt((select array[ka] from keys), date '2026-11-15')::jsonb -> 'lessons', '[]'::jsonb, 'a day without lessons is empty');
select is(pg_temp.tt((select array[ka] from keys), date '2026-11-15')::jsonb -> 'missing', '[]'::jsonb,
  'a course with lessons on other days is not missing');
select is((pg_temp.tt((select array[ka] from keys), date '2026-10-26', 14)::jsonb ->> 'to')::bigint
    - (pg_temp.tt((select array[ka] from keys), date '2026-10-26', 14)::jsonb ->> 'from')::bigint,
  14 * 86400000::bigint, 'the first allowed day with 14 days is valid');
select is(pg_temp.tt((select array[ka] from keys), date '2026-12-07', 14)::jsonb -> 'lessons', '[]'::jsonb, 'so is the last allowed day');

-- Timetable: cancelled and not held lessons.
select is(
  array(select (e ->> 'id') || ' ' || (e ->> 'status')
    from jsonb_array_elements(pg_temp.tt((select array[kg] from keys), date '2026-11-16', 4)::jsonb -> 'lessons') with ordinality as x(e, i)
    order by i),
  array['eeeeeeeeeeeeeeeeeeeeee05 cancelled', 'eeeeeeeeeeeeeeeeeeeeee06 cancelled', 'eeeeeeeeeeeeeeeeeeeeee07 active'],
  'cancelled: a cancelled lesson, and one confirmed as not held in all of its rooms; not held in one room of two stays active');
update public.room_requests set status = 'pending', reviewed_at = null where lesson_id = 'eeeeeeeeeeeeeeeeeeeeee06';
select is(pg_temp.tt((select array[kg] from keys), date '2026-11-17')::jsonb -> 'lessons' -> 0 ->> 'status', 'active',
  'a report not yet approved cancels nothing');
update public.room_requests set status = 'approved', reviewed_at = now() where lesson_id = 'eeeeeeeeeeeeeeeeeeeeee06';

-- Timetable: missing keys.
select is(pg_temp.tt((select array[ka, kx] from keys))::jsonb -> 'missing', (select jsonb_build_array(kx) from keys),
  'a key that matches no lesson is listed as missing, not refused');
select is(pg_temp.col(pg_temp.tt((select array[ka, kx] from keys)), 'lessons', 'id'),
  array['eeeeeeeeeeeeeeeeeeeeee03', 'eeeeeeeeeeeeeeeeeeeeee01', 'eeeeeeeeeeeeeeeeeeeeee12'], 'the other keys still give their lessons');
select is(pg_temp.tt((select array[repeat('f', 32), kx] from keys))::jsonb - 'stale' - 'now' - 'from' - 'to',
  (select jsonb_build_object('missing', jsonb_build_array(kx, repeat('f', 32)), 'lessons', '[]'::jsonb) from keys),
  'missing keys are sorted; only unknown keys give no lessons');

-- Timetable: stale.
select is(pg_temp.tt((select array[ks] from keys))::jsonb -> 'stale', 'true'::jsonb, 'a course of a calendar fetched too long ago is stale');
select is(pg_temp.tt((select array[ka, ks] from keys))::jsonb -> 'stale', 'true'::jsonb, 'one stale course makes the answer stale');
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'stale', 'false'::jsonb,
  'control: a stale calendar that holds no lesson of the course does not');
select is(pg_temp.tt((select array[ka, kx] from keys))::jsonb -> 'stale', 'true'::jsonb,
  'a missing course may belong to the stale calendar: stale');
update aule.calendar_data set fetched_at = pg_temp.h(-2) where calendar_id = '222222222222222222222222';
select is(pg_temp.tt((select array[ks] from keys))::jsonb -> 'stale', 'false'::jsonb, 'fresh again after a new fetch');
select is(pg_temp.tt((select array[ka, kx] from keys))::jsonb -> 'stale', 'false'::jsonb,
  'with every calendar fresh a missing course is known to be absent');
update aule.calendar_data set fetched_at = pg_temp.h(-30) where calendar_id = '111111111111111111111111';
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'stale', 'false'::jsonb, 'exactly 30 hours old is still fresh');
update aule.calendar_data set fetched_at = pg_temp.h(-30.5) where calendar_id = '111111111111111111111111';
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'stale', 'true'::jsonb, 'older than the limit is stale');
update aule.calendar_data set fetched_at = pg_temp.h(-1), window_to = pg_temp.h(0) where calendar_id = '111111111111111111111111';
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'stale', 'true'::jsonb, 'a time at the end of the calendar window is stale');
update aule.calendar_data set window_from = pg_temp.h(1), window_to = pg_temp.h(336) where calendar_id = '111111111111111111111111';
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'stale', 'true'::jsonb, 'a time before the calendar window is stale');
update aule.calendar_data set window_from = pg_temp.h(-168) where calendar_id = '111111111111111111111111';
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'stale', 'false'::jsonb, 'control: fresh again');
delete from aule.calendar_data;
select is(pg_temp.tt((select array[ka] from keys))::jsonb -> 'stale', 'true'::jsonb,
  'lessons whose calendar has no data are stale, never fresh');
delete from aule.unique_lessons;
select is(pg_temp.tt((select array[ka] from keys))::jsonb - 'now' - 'from' - 'to',
  (select jsonb_build_object('stale', true, 'missing', jsonb_build_array(ka), 'lessons', '[]'::jsonb) from keys),
  'an empty database: every key missing and stale, never fresh');
select is(pg_temp.c('analisi')::jsonb, '{"courses": []}'::jsonb, 'and no course to find');

-- Timetable: validation.
select is(pg_temp.tt(null), '!P0001 invalid', 'missing keys are invalid');
select is(pg_temp.tt('{}'), '!P0001 invalid', 'no key is invalid');
select is(pg_temp.tt(array(select lpad(to_hex(i), 32, '0') from generate_series(1, 13) i)), '!P0001 invalid', '13 keys are invalid');
select is(pg_temp.tt(array(select lpad(to_hex(i), 32, '0') from generate_series(1, 12) i))::jsonb -> 'lessons', '[]'::jsonb, '12 keys are valid');
select is(pg_temp.tt(array[repeat('a', 31)]), '!P0001 invalid', 'a 31 character key is invalid');
select is(pg_temp.tt(array[repeat('a', 33)]), '!P0001 invalid', 'a 33 character key is invalid');
select is(pg_temp.tt(array[repeat('A', 32)]), '!P0001 invalid', 'an upper case key is invalid');
select is(pg_temp.tt(array[repeat('a', 31) || 'g']), '!P0001 invalid', 'a key that is not hex is invalid');
select is(pg_temp.tt(array[repeat('a', 31) || '%']), '!P0001 invalid', 'a wildcard in a key is invalid');
select is(pg_temp.tt(array[repeat('a', 32), null]), '!P0001 invalid', 'a null key is invalid');
select is(pg_temp.tt(array[repeat('a', 32), repeat('a', 32)]), '!P0001 invalid', 'a repeated key is invalid');
select is(pg_temp.tt(array[array[repeat('a', 32)], array[repeat('b', 32)]]), '!P0001 invalid', 'a nested array is invalid');
select is(
  array[pg_temp.tt(array[repeat('a', 32)], date '2026-10-25'), pg_temp.tt(array[repeat('a', 32)], date '2026-12-08'),
    pg_temp.tt(array[repeat('a', 32)], null), pg_temp.tt(array[repeat('a', 32)], date '2019-12-31')],
  array_fill('!P0001 invalid'::text, array[4]), 'a day more than 21 days away, or missing, is invalid');
select is(
  array[pg_temp.tt(array[repeat('a', 32)], date '2026-11-16', 0), pg_temp.tt(array[repeat('a', 32)], date '2026-11-16', 15),
    pg_temp.tt(array[repeat('a', 32)], date '2026-11-16', null), pg_temp.tt(array[repeat('a', 32)], date '2026-11-16', -1)],
  array_fill('!P0001 invalid'::text, array[4]), '0, 15, negative or missing days are invalid');
select is(pg_temp.tt(array[repeat('a', 32)], date '2026-11-16', 1, null), '!P0001 invalid', 'the timetable needs a time');

-- Limits: 40 courses, 600 lessons.
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to) values
  ('111111111111111111111111', pg_temp.h(-1), pg_temp.h(-168), pg_temp.h(336));
do $$ begin
  for i in 0..44 loop
    perform pg_temp.lesson(lpad(to_hex(4096 + i), 24, 'd'), 'Seminario ' || i, '{}', 20, '{aaaaaaaaaaaaaaaaaaaaaa01}');
  end loop;
  perform aule.refresh_timetable();
end $$;
select is(cardinality(pg_temp.col(pg_temp.c('seminario'), 'courses', 'key')), 40, 'course results are capped at 40');
select is((pg_temp.col(pg_temp.c('seminario'), 'courses', 'title'))[1:3] || (pg_temp.col(pg_temp.c('seminario'), 'courses', 'title'))[40],
  array['Seminario 0', 'Seminario 1', 'Seminario 2', 'Seminario 39'], 'courses are ordered by title, numbers as numbers');
select is(pg_temp.c('seminario'), pg_temp.c('seminario'), 'the order is deterministic');
insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
  title_text, direct_text, course_text)
select '111111111111111111111111', lpad(to_hex(8192 + i), 24, 'c'), 'LABORATORIO', pg_temp.h(1) + i * interval '1 minute',
  pg_temp.h(2) + i * interval '1 minute', 'active', '', '{}', null, '{}', '{aaaaaaaaaaaaaaaaaaaaaa01}', 'laboratorio', 'laboratorio',
  'laboratorio'
from generate_series(0, 599) i;
do $$ begin perform aule.refresh_timetable(); end $$;
select is(cardinality(pg_temp.col(pg_temp.tt(array[pg_temp.k('laboratorio', '')]), 'lessons', 'id')), 600, '600 lessons are returned');
insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
  title_text, direct_text, course_text)
values ('111111111111111111111111', lpad(to_hex(8192 + 600), 24, 'c'), 'LABORATORIO', pg_temp.h(1), pg_temp.h(2), 'active', '', '{}',
  null, '{}', '{aaaaaaaaaaaaaaaaaaaaaa01}', 'laboratorio', 'laboratorio', 'laboratorio');
do $$ begin perform aule.refresh_timetable(); end $$;
select is(pg_temp.tt(array[pg_temp.k('laboratorio', '')]), '!P0001 invalid', 'more than 600 lessons are refused, never cut');
select is(cardinality(pg_temp.col(pg_temp.tt(array[pg_temp.k('laboratorio', '')], date '2026-11-17'), 'lessons', 'id')), 0,
  'a narrower window still answers');

-- Grants.
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('public.search_courses(text)'::regprocedure, 'public.course_timetable(text[], date, integer)'::regprocedure)
      and p.prosecdef and p.provolatile = 's' and p.proowner = 'aule_reader'::regrole and p.proconfig @> array['search_path=""']),
  2, 'the two public wrappers are stable, run as aule_reader and have an empty search_path');
select is(
  (select count(*)::int from pg_proc p
    where p.oid in ('aule.course_key(text, text)'::regprocedure, 'aule.courses_at(timestamptz, text)'::regprocedure,
        'aule.course_timetable_at(timestamptz, text[], date, integer)'::regprocedure)
      and not p.prosecdef and p.provolatile <> 'v' and p.proowner = 'aule_reader'::regrole and p.proconfig @> array['search_path=""']),
  3, 'the three internal functions never write, run as the caller and have an empty search_path');
select set_eq(
  $$select p.proname::text, r.role from pg_proc p
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_sync', 'aule_ingest', 'aule_config']) as r(role)
    where p.oid in ('public.search_courses(text)'::regprocedure, 'public.course_timetable(text[], date, integer)'::regprocedure,
      'aule.course_key(text, text)'::regprocedure, 'aule.courses_at(timestamptz, text)'::regprocedure,
      'aule.course_timetable_at(timestamptz, text[], date, integer)'::regprocedure)
      and has_function_privilege(r.role, p.oid, 'EXECUTE')$$,
  $$values ('search_courses', 'anon'), ('course_timetable', 'anon')$$,
  'only anon runs the course API, and only its public wrappers');
select is_empty(
  $$select r.role, p.priv from unnest(array['aule', 'public']) as n(nsp)
    cross join unnest(array['anon', 'authenticated', 'service_role', 'aule_reader']) as r(role)
    cross join unnest(array['CREATE']) as p(priv)
    where has_schema_privilege(r.role, n.nsp, p.priv)$$,
  'the migration leaves no role able to create in aule or public');

-- As anon, through the public wrappers that use now().
set local role anon;
select is(jsonb_array_length(public.search_courses('seminario') -> 'courses'), 40, 'anon searches courses');
select is(public.course_timetable(array[repeat('0', 32)]) - 'now' - 'from' - 'to' - 'stale',
  jsonb_build_object('missing', jsonb_build_array(repeat('0', 32)), 'lessons', '[]'::jsonb), 'anon reads a timetable');
select ok(
  ((public.course_timetable(array[repeat('0', 32)]) ->> 'to')::bigint - (public.course_timetable(array[repeat('0', 32)]) ->> 'from')::bigint)
    between 167 * 3600000::bigint and 169 * 3600000::bigint,
  'the default window is 7 days from today');
select throws_ok($$select public.search_courses(null)$$, 'P0001', 'invalid', 'a missing query is invalid');
select throws_ok($$select public.search_courses('')$$, 'P0001', 'invalid', 'an empty query is invalid, not an empty search');
select throws_ok($$select public.search_courses('ANALISI')$$, 'P0001', 'invalid', 'the wrapper validates again');
select throws_ok($$select public.search_courses(repeat('a', 241))$$, 'P0001', 'invalid', 'a 241 byte query is invalid');
select throws_ok($$select public.course_timetable(null)$$, 'P0001', 'invalid', 'missing keys are invalid');
select throws_ok($$select public.course_timetable('{}')$$, 'P0001', 'invalid', 'no key is invalid');
select throws_ok($$select public.course_timetable(array(select lpad(to_hex(i), 32, '0') from generate_series(1, 13) i))$$, 'P0001',
  'invalid', '13 keys through the wrapper are invalid');
select throws_ok($$select public.course_timetable(array[repeat('a', 100000)])$$, 'P0001', 'invalid', 'a very long key is invalid');
select throws_ok($$select public.course_timetable(array[repeat('0', 32)], date '2099-12-31', 1)$$, 'P0001', 'invalid', 'a far day is invalid');
select throws_ok($$select public.course_timetable(array[repeat('0', 32)], null, 0)$$, 'P0001', 'invalid', 'zero days is invalid');
select throws_ok($$select aule.courses_at(now(), 'analisi')$$, '42501', null, 'anon cannot reach the internal search');
select throws_ok($$select aule.course_timetable_at(now(), array[repeat('0', 32)], date '2026-11-16', 1)$$, '42501', null,
  'nor the internal timetable');
select throws_ok($$select aule.course_key('a', 'b')$$, '42501', null, 'nor the key function');
reset role;

select * from finish();
rollback;
