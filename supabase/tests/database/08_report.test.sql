begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- Fixed time: 2026-11-16 11:30 in Rome. h(x) is x hours from it.
create function pg_temp.h(p numeric) returns timestamptz language sql immutable as $$
  select timestamptz '2026-11-16 10:30:00+00' + p * interval '1 hour'
$$;
-- Now with millisecond precision, as report_room computes it.
create function pg_temp.n() returns timestamptz language sql stable as $$
  select aule.from_ms(aule.ms(now()))
$$;
create function pg_temp.lesson(p_id text, p_room text, p_start timestamptz, p_end timestamptz, p_status text default 'active')
returns void language sql as $$
  insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
    title_text, direct_text, course_text)
  values ('0c0c0c0c0c0c0c0c0c0c0c01', p_id, 'Analisi', p_start, p_end, p_status::aule.lesson_status, '', '{}', null, '{}',
    array[p_room], 'analisi', 'analisi', 'analisi')
$$;
create function pg_temp.win(p_now timestamptz, p_kind text, p_lesson text default null, p_room text default 'aaaaaaaaaaaaaaaaaaaaaaaa')
returns text language plpgsql as $$
declare
  r text;
begin
  select w.starts_at::text || ' .. ' || w.ends_at::text into r
  from aule.report_window(p_now, p_room, p_kind::public.request_kind, p_lesson) w;
  return r;
exception when others then
  return '!' || sqlstate || case when sqlstate = 'P0001' then ' ' || sqlerrm else '' end;
end
$$;

set local timezone to 'UTC';
delete from aule.calendar_data;
delete from aule.rooms;
delete from aule.sync_runs;
delete from public.room_requests;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('80000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente@studenti.unical.it', now()),
  ('80000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'esterno@example.com', now());

insert into aule.calendars (id, label) values ('0c0c0c0c0c0c0c0c0c0c0c01', 'Calendario di prova') on conflict (id) do nothing;
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to)
values ('0c0c0c0c0c0c0c0c0c0c0c01', now(), least(pg_temp.h(0), pg_temp.n()) - interval '168 hours',
  greatest(pg_temp.h(0), pg_temp.n()) + interval '336 hours');
insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key, name_compact, search_text)
values
  ('aaaaaaaaaaaaaaaaaaaaaaaa', 'B6', 'AU_1', 'Cubo 4D', 40, 22, '{}', 'cubo-4d', 'b6', 'b6', 'b6 au_1 cubo 4d'),
  ('bbbbbbbbbbbbbbbbbbbbbbbb', 'B7', 'AU_2', 'Cubo 4D', 40, 22, '{}', 'cubo-4d', 'b7', 'b7', 'b7 au_2 cubo 4d');
do $$ begin
  -- Around the fixed time, for aule.report_window.
  perform pg_temp.lesson('dddddddddddddddddddddd01', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1), pg_temp.h(1));
  perform pg_temp.lesson('dddddddddddddddddddddd02', 'bbbbbbbbbbbbbbbbbbbbbbbb', pg_temp.h(-1), pg_temp.h(1));
  perform pg_temp.lesson('dddddddddddddddddddddd03', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-1), pg_temp.h(1), 'cancelled');
  perform pg_temp.lesson('dddddddddddddddddddddd04', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(2), pg_temp.h(3));
  perform pg_temp.lesson('dddddddddddddddddddddd05', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.h(-20), pg_temp.h(-18));
  -- Around now, for report_room.
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee01', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.n() - interval '1 hour', pg_temp.n() + interval '1 hour');
  perform pg_temp.lesson('eeeeeeeeeeeeeeeeeeeeee02', 'aaaaaaaaaaaaaaaaaaaaaaaa', pg_temp.n() + interval '2 hours', pg_temp.n() + interval '3 hours');
  perform aule.refresh_timetable();
end $$;

-- Valid inputs per kind: the browser says what happened, the database decides the window.
set local role authenticated;
set local request.jwt.claims to '{"sub":"80000000-0000-0000-0000-000000000001","role":"authenticated"}';
select isnt(public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied'), null, 'a student reports a room occupied');
select isnt(public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'issue', 'proiettore'), null, 'an issue with its category');
select isnt(public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', null, 'eeeeeeeeeeeeeeeeeeeeee01'), null, 'a lesson not held with its lesson');

-- Invalid inputs are refused, not repaired.
select throws_ok($$select public.report_room('x', 'room_occupied')$$, 'P0001', 'invalid', 'a bad room id is invalid');
select throws_ok($$select public.report_room(null, 'room_occupied')$$, 'P0001', 'invalid', 'a missing room id is invalid');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', null)$$, 'P0001', 'invalid', 'a missing kind is invalid');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'issue')$$, 'P0001', 'invalid', 'an issue without category is invalid');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed', 'bagni')$$, 'P0001', 'invalid', 'a category on a closure is invalid');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held')$$, 'P0001', 'invalid', 'a not held without lesson is invalid');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, 'eeeeeeeeeeeeeeeeeeeeee01')$$, 'P0001', 'invalid', 'a lesson on an occupied report is invalid');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', null, 'EEEEEEEEEEEEEEEEEEEEEE01')$$, 'P0001', 'invalid', 'a bad lesson id is invalid');
select throws_ok(format('select public.report_room(%L, %L)', repeat('a', 10240), 'room_occupied'), 'P0001', 'invalid', 'a 10 KB room id gives only invalid');
select throws_ok(format('select public.report_room(%L, %L, null, %L)', 'aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', repeat('e', 10240)), 'P0001', 'invalid', 'a 10 KB lesson id gives only invalid');
select throws_ok($$select public.report_room('abababababababababababab', 'room_occupied')$$, 'P0001', 'not_found', 'a room not in the timetable is not found');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'lesson_not_held', null, 'eeeeeeeeeeeeeeeeeeeeee02')$$, 'P0001', 'window', 'a lesson that has not started is checked by the database');
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied')$$, 'P0001', 'duplicate', 'the limits of submit_request still apply');

-- Who may report.
set local request.jwt.claims to '{"sub":"80000000-0000-0000-0000-000000000002","role":"authenticated"}';
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed')$$, '42501', 'forbidden', 'a user without a Unical email cannot report');
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select public.report_room('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed')$$, '42501', null, 'anon cannot execute report_room');
select throws_ok($$select * from aule.report_window(now(), 'aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed', null)$$, '42501', null, 'anon cannot reach the window rule');

-- What was stored: windows computed by the database, with millisecond precision.
reset role;
select results_eq(
  $$select kind::text, starts_at, ends_at, aule.ms_exact(starts_at) and aule.ms_exact(ends_at)
    from public.room_requests where created_by = '80000000-0000-0000-0000-000000000001' order by 1$$,
  $$values
    ('issue', pg_temp.n(), pg_temp.n() + interval '168 hours', true),
    ('lesson_not_held', pg_temp.n() - interval '1 hour', pg_temp.n() + interval '1 hour', true),
    ('room_occupied', pg_temp.n(), pg_temp.n() + interval '1 hour', true)$$,
  'the stored windows are the ones of the database, in milliseconds');
select throws_ok(
  $$insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by)
    values ('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_closed', timestamptz '2026-11-16 10:30:00.000001+00', timestamptz '2026-11-16 11:30:00+00',
      '80000000-0000-0000-0000-000000000001')$$,
  '23514', 'new row for relation "room_requests" violates check constraint "room_requests_ms"',
  'a window with microseconds is rejected by room_requests_ms');

-- Windows decided by the database (port of requestWindow).
select is(pg_temp.win(pg_temp.h(0), 'room_occupied'), '2026-11-16 10:30:00+00 .. 2026-11-16 11:30:00+00', '"occupied now" lasts one hour');
select is(pg_temp.win(pg_temp.h(0), 'issue'), '2026-11-16 10:30:00+00 .. 2026-11-23 10:30:00+00', 'an issue lasts 168 hours');
select is(pg_temp.win(pg_temp.h(0), 'room_closed'), '2026-11-16 10:30:00+00 .. 2026-11-16 22:30:00+00', 'a closure lasts at most 12 hours');
select is(pg_temp.win(timestamptz '2026-11-16 20:00:00+00', 'room_closed'), '2026-11-16 20:00:00+00 .. 2026-11-16 23:00:00+00', 'and never past midnight in Rome');
select is(pg_temp.win(timestamptz '2026-10-25 20:00:00+00', 'room_closed'), '2026-10-25 20:00:00+00 .. 2026-10-25 23:00:00+00', 'also on the day daylight saving ends');
select is(pg_temp.win(timestamptz '2026-03-29 19:00:00+00', 'room_closed'), '2026-03-29 19:00:00+00 .. 2026-03-29 22:00:00+00', 'and on the day it starts');

-- A lesson not held uses the lesson times and checks the lesson.
select is(pg_temp.win(pg_temp.h(0), 'lesson_not_held', 'dddddddddddddddddddddd01'), '2026-11-16 09:30:00+00 .. 2026-11-16 11:30:00+00', 'the window is the lesson');
select is(pg_temp.win(pg_temp.h(0), 'lesson_not_held', 'dddddddddddddddddddddd99'), '!P0001 window', 'a missing lesson gives window');
select is(pg_temp.win(pg_temp.h(0), 'lesson_not_held', 'dddddddddddddddddddddd02'), '!P0001 window', 'a lesson in another room gives window');
select is(pg_temp.win(pg_temp.h(0), 'lesson_not_held', 'dddddddddddddddddddddd03'), '!P0001 window', 'a cancelled lesson gives window');
select is(pg_temp.win(pg_temp.h(0), 'lesson_not_held', 'dddddddddddddddddddddd04'), '!P0001 window', 'a future lesson gives window');
select is(pg_temp.win(pg_temp.h(0), 'lesson_not_held', 'dddddddddddddddddddddd05'), '!P0001 window', 'a lesson ended too long ago gives window');
select is(pg_temp.win(pg_temp.h(1.75), 'lesson_not_held', 'dddddddddddddddddddddd04'), '2026-11-16 12:30:00+00 .. 2026-11-16 13:30:00+00', 'a lesson starting within 15 minutes can be reported');
select is(pg_temp.win(pg_temp.h(13), 'lesson_not_held', 'dddddddddddddddddddddd01'), '2026-11-16 09:30:00+00 .. 2026-11-16 11:30:00+00', 'a lesson ended 12 hours ago still can');
select is(pg_temp.win(pg_temp.h(13) + interval '1 millisecond', 'lesson_not_held', 'dddddddddddddddddddddd01'), '!P0001 window', 'one millisecond later it cannot');

select * from finish();
rollback;
