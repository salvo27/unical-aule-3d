begin;
create extension if not exists pgtap with schema extensions;
select plan(47);

-- Now with millisecond precision, as report_room computes it.
create function pg_temp.n() returns timestamptz language sql stable as $$
  select aule.from_ms(aule.ms(now()))
$$;
-- A closure ends within the Rome day, whatever the time of the run.
create function pg_temp.closed_end() returns timestamptz language sql stable as $$
  select least(pg_temp.n() + interval '1 hour', aule.rome_midnight(aule.rome_day(now()) + 1))
$$;
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

delete from public.room_requests;
insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's1@studenti.unical.it', now()),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's2@studenti.unical.it', now()),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's3@studenti.unical.it', now()),
  ('20000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'mod@unical.it', now()),
  ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's5@studenti.unical.it', now()),
  ('20000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 's6@studenti.unical.it', now()),
  ('20000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ora.privata@gmail.com', now());
insert into public.user_roles (user_id, role) values ('20000000-0000-0000-0000-000000000004', 'moderator');

-- Anonymous visitors.
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select aule.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, '42501', null, 'anon cannot execute aule.submit_request');
select throws_ok($$select * from public.room_requests$$, '42501', null, 'anon cannot read the table');
select throws_ok($$select * from aule.active_overrides(now())$$, '42501', null, 'anon cannot read the overrides directly');

-- Signed in users reach the requests only through report_room.
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$select aule.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, '42501', null, 'authenticated cannot execute aule.submit_request');

-- Student 1. aule.submit_request runs as postgres with the user's claims, as report_room calls it.
reset role;
select isnt(aule.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null), null, 'a student reports a room occupied now');
select throws_ok($$select aule.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'P0001', 'duplicate', 'the same report twice is refused');
select throws_ok($$select aule.submit_request('not-a-room', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'P0001', 'invalid', 'room id is validated');
select throws_ok($$select aule.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_occupied', null, pg_temp.n() - interval '2 hours', pg_temp.n() - interval '1 hour', null)$$, 'P0001', 'window', '"occupied now" must start now');
select throws_ok($$select aule.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '2 hours', null)$$, 'P0001', 'window', '"occupied now" lasts at most 1 hour');
select throws_ok($$select aule.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'issue', null, pg_temp.n(), pg_temp.n() + interval '24 hours', null)$$, 'P0001', 'invalid', 'an issue needs a category');
select throws_ok($$select aule.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_closed', 'bagni', pg_temp.n(), pg_temp.closed_end(), null)$$, 'P0001', 'invalid', 'only issues have a category');
select throws_ok(
  $$select aule.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_closed', null, pg_temp.n(),
    aule.rome_midnight(aule.rome_day(now()) + 1) + interval '1 minute', null)$$,
  'P0001', 'window', 'a closure never goes past midnight in Rome');
select throws_ok($$select aule.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'issue', 'proiettore', pg_temp.n(), pg_temp.n() + interval '192 hours', null)$$, 'P0001', 'window', 'issues last at most a week');
select isnt(aule.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'issue', 'proiettore', pg_temp.n(), pg_temp.n() + interval '168 hours', null), null, 'an issue with category is accepted');
select throws_ok($$select aule.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, pg_temp.n() - interval '1 hour', pg_temp.n() + interval '1 hour', null)$$, 'P0001', 'invalid', '"not held" needs the lesson id');
select isnt(aule.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, pg_temp.n() - interval '1 hour', pg_temp.n() + interval '1 hour', 'dddddddddddddddddddddddd'), null, '"not held" with the lesson id is accepted');
select throws_ok($$select aule.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, pg_temp.n() - interval '1 hour', pg_temp.n() + interval '1 hour', 'dddddddddddddddddddddddd')$$, 'P0001', 'duplicate', 'the same lesson cannot be reported twice');
select throws_ok($$select aule.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, pg_temp.n() - interval '2 hours', pg_temp.n(), 'dddddddddddddddddddddddd')$$, 'P0001', 'duplicate', 'not even after the lesson changed times');

-- What student 1 can do through the API.
set local role authenticated;
select throws_ok($$select public.pending_requests() -> 'requests'$$, '42501', 'forbidden', 'students cannot read single requests from the queue');
select throws_ok($$insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by) values ('eeeeeeeeeeeeeeeeeeeeeeee', 'room_closed', now(), now() + interval '1 hour', '20000000-0000-0000-0000-000000000001')$$, '42501', null, 'students cannot write the table directly');
select throws_ok($$update public.room_requests set status = 'approved'$$, '42501', null, 'students cannot approve by updating the table');
select throws_ok($$select public.review_request((select (e ->> 'id')::uuid from jsonb_array_elements(public.my_requests() -> 'requests') e limit 1), 'approved')$$, '42501', 'forbidden', 'students cannot review');
select is(jsonb_array_length(public.my_requests() -> 'requests'), 3, 'my_requests shows only my three requests');
select throws_ok($$select public.pending_requests()$$, '42501', 'forbidden', 'students cannot see the queue');

-- Daily limit: student 5 already sent 19 requests today (all decided), the 20th passes, the 21st does not.
reset role;
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by, created_at, status, reviewed_at)
select lpad(to_hex(g), 24, 'c'), 'room_closed', pg_temp.n(), pg_temp.n() + interval '1 hour', '20000000-0000-0000-0000-000000000005', now() - interval '1 hour', 'rejected', now()
from generate_series(1, 19) g;
-- Student 6 already has 5 requests waiting for review.
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by)
select lpad(to_hex(g), 24, 'f'), 'room_closed', pg_temp.n(), pg_temp.n() + interval '1 hour', '20000000-0000-0000-0000-000000000006'
from generate_series(1, 5) g;
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}';
select lives_ok($$select aule.submit_request('dddddddddddddddddddddddd', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'the 20th request of the day passes');
select throws_ok($$select aule.submit_request('eeeeeeeeeeeeeeeeeeeeeeee', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'P0001', 'rate_limited', 'the 21st is refused');
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000006","role":"authenticated"}';
select throws_ok($$select aule.submit_request('dddddddddddddddddddddddd', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'P0001', 'too_many_pending', 'at most 5 short reports waiting at once');
select lives_ok($$select aule.submit_request('dddddddddddddddddddddddd', 'issue', 'wifi', pg_temp.n(), pg_temp.n() + interval '168 hours', null)$$, 'issues have their own cap');

-- Crowd: two people agree, not enough; the third makes it public.
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$select aule.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'second report');
select is(pg_temp.rd($$select count(*) from aule.active_overrides(now()) where source = 'crowd' and room_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'$$), '0', 'two reports are not enough');
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($$select aule.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'third report');
select is(
  pg_temp.rd($$select string_agg(room_id || '|' || kind || '|' || source, ',') from aule.active_overrides(now()) where source = 'crowd' and room_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'$$),
  'aaaaaaaaaaaaaaaaaaaaaaaa|room_occupied|crowd',
  'three different people make the room show as occupied'
);

-- An account whose email moved to another domain does not count for the crowd.
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by)
values ('a1a1a1a1a1a1a1a1a1a1a1a1', 'room_occupied', pg_temp.n(), pg_temp.n() + interval '1 hour', '20000000-0000-0000-0000-000000000007');
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$select aule.submit_request('a1a1a1a1a1a1a1a1a1a1a1a1', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'valid report 1');
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($$select aule.submit_request('a1a1a1a1a1a1a1a1a1a1a1a1', 'room_occupied', null, pg_temp.n(), pg_temp.n() + interval '1 hour', null)$$, 'valid report 2');
select is(pg_temp.rd($$select count(*) from aule.active_overrides(now()) where room_id = 'a1a1a1a1a1a1a1a1a1a1a1a1'$$), '0', 'a no longer valid account does not complete the crowd');

-- Moderator. Ids are read here as the owner, since the table is closed to users.
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by, created_at)
values ('abababababababababababab', 'room_closed', pg_temp.n() - interval '2 hours', pg_temp.n() - interval '1 minute', '20000000-0000-0000-0000-000000000001', now() - interval '2 hours');
create temp table ids as select id, room_id, kind from public.room_requests;
grant select on ids to authenticated;
set local role authenticated;
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is((select count(*)::int from jsonb_array_elements(public.pending_requests() -> 'requests') e where e ->> 'roomId' = 'bbbbbbbbbbbbbbbbbbbbbbbb'), 1, 'moderators see the queue');
select is(
  (select e ->> 'lessonId' from jsonb_array_elements(public.pending_requests() -> 'requests') e
    where e ->> 'roomId' = 'cccccccccccccccccccccccc' and e ->> 'kind' = 'lesson_not_held'),
  'dddddddddddddddddddddddd', 'staff see the lesson of a request in the queue');
select lives_ok($$select public.review_request((select i.id from ids i where i.room_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'), 'approved')$$, 'moderators approve');
select throws_ok($$select public.review_request((select i.id from ids i where i.room_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'), 'rejected')$$, 'P0001', 'not_pending', 'a decision cannot be changed');
select throws_ok($$select public.review_request((select i.id from ids i where i.room_id = 'abababababababababababab'), 'approved')$$, 'P0001', 'expired', 'an expired request cannot be approved');
select throws_ok($$select public.review_request((select i.id from ids i where i.room_id = 'cccccccccccccccccccccccc' and i.kind = 'lesson_not_held'), 'pending')$$, 'P0001', 'invalid', 'pending is not a decision');
reset role;
select lives_ok($$select aule.submit_request('efefefefefefefefefefefef', 'room_closed', null, pg_temp.n(), pg_temp.closed_end(), null)$$, 'moderators can report too');
delete from aule.calendar_data;
delete from aule.rooms;
delete from aule.sync_runs;
do $$ begin perform aule.refresh_timetable(); end $$;
set local role authenticated;
select throws_ok($$select public.review_request((select (e ->> 'id')::uuid from jsonb_array_elements(public.my_requests() -> 'requests') e where e ->> 'roomId' = 'efefefefefefefefefefefef'), 'approved')$$, 'P0001', 'own_request', 'nobody reviews their own request');
select throws_ok($$select public.review_request((select i.id from ids i where i.room_id = 'cccccccccccccccccccccccc' and i.kind = 'lesson_not_held'), 'approved')$$, 'P0001', 'no_lesson', 'approving a not held whose lesson is gone fails with no_lesson');

-- The lesson enters the timetable with the times of the request.
reset role;
insert into aule.calendars (id, label) values ('0b0b0b0b0b0b0b0b0b0b0b01', 'Calendario di prova') on conflict (id) do nothing;
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to)
values ('0b0b0b0b0b0b0b0b0b0b0b01', now(), pg_temp.n() - interval '168 hours', pg_temp.n() + interval '336 hours');
insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess, room_key, name_compact, search_text)
values ('cccccccccccccccccccccccc', 'C1', 'AU_2', 'Cubo 4D', 40, null, '{}', 'cubo-4d', 'c1', 'c1', 'c1 au_2 cubo 4d');
insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids, title_text, direct_text, course_text)
values ('0b0b0b0b0b0b0b0b0b0b0b01', 'dddddddddddddddddddddddd', 'Analisi', pg_temp.n() - interval '1 hour', pg_temp.n() + interval '1 hour', 'active',
  '', '{}', null, '{}', array['cccccccccccccccccccccccc'], 'analisi', 'analisi', 'analisi');
do $$ begin perform aule.refresh_timetable(); end $$;
set local role authenticated;
select lives_ok($$select public.review_request((select i.id from ids i where i.room_id = 'cccccccccccccccccccccccc' and i.kind = 'lesson_not_held'), 'approved')$$, 'moderators approve a lesson not held');
select throws_ok($$select public.review_request('30000000-0000-0000-0000-000000000099', 'approved')$$, 'P0001', 'not_found', 'approving a request that cannot be read fails closed');

-- What the map reads: approved requests with the lesson id, no user columns.
reset role;
select is(
  pg_temp.rd($$select string_agg(concat_ws('|', room_id, kind, coalesce(category::text, '-'), coalesce(lesson_id, '-'), source), ',' order by room_id)
    from aule.active_overrides(now()) where source = 'approved'$$),
  'bbbbbbbbbbbbbbbbbbbbbbbb|issue|proiettore|-|approved,cccccccccccccccccccccccc|lesson_not_held|-|dddddddddddddddddddddddd|approved',
  'approved requests reach the map, with the lesson id'
);

select * from finish();
rollback;
