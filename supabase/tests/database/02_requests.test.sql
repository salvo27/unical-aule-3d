begin;
create extension if not exists pgtap with schema extensions;
select plan(44);

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
select throws_ok($$select public.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, '42501', null, 'anon cannot submit');
select throws_ok($$select * from public.room_requests$$, '42501', null, 'anon cannot read the table');
select throws_ok($$select * from public.public_room_overrides(now(), now() - interval '1 hour')$$, 'P0001', 'invalid', 'overrides need a valid range');

-- Student 1.
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000001","role":"authenticated"}';
select isnt(public.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, now(), now() + interval '1 hour', null), null, 'a student reports a room occupied now');
select throws_ok($$select public.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'P0001', 'duplicate', 'the same report twice is refused');
select throws_ok($$select public.submit_request('not-a-room', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'P0001', 'invalid', 'room id is validated');
select throws_ok($$select public.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_occupied', null, now() - interval '2 hours', now() - interval '1 hour', null)$$, 'P0001', 'window', '"occupied now" must start now');
select throws_ok($$select public.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_occupied', null, now(), now() + interval '2 hours', null)$$, 'P0001', 'window', '"occupied now" lasts at most 1 hour');
select throws_ok($$select public.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'issue', null, now(), now() + interval '1 day', null)$$, 'P0001', 'invalid', 'an issue needs a category');
select throws_ok($$select public.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_closed', 'bagni', now(), now() + interval '1 hour', null)$$, 'P0001', 'invalid', 'only issues have a category');
select throws_ok(
  $$select public.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'room_closed', null, now(),
    (date_trunc('day', now() at time zone 'Europe/Rome') + interval '1 day') at time zone 'Europe/Rome' + interval '1 minute', null)$$,
  'P0001', 'window', 'a closure never goes past midnight in Rome');
select throws_ok($$select public.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'issue', 'proiettore', now(), now() + interval '8 days', null)$$, 'P0001', 'window', 'issues last at most a week');
select isnt(public.submit_request('bbbbbbbbbbbbbbbbbbbbbbbb', 'issue', 'proiettore', now(), now() + interval '7 days', null), null, 'an issue with category is accepted');
select throws_ok($$select public.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, now() - interval '1 hour', now() + interval '1 hour', null)$$, 'P0001', 'invalid', '"not held" needs the lesson id');
select isnt(public.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, now() - interval '1 hour', now() + interval '1 hour', 'dddddddddddddddddddddddd'), null, '"not held" with the lesson id is accepted');
select throws_ok($$select public.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, now() - interval '1 hour', now() + interval '1 hour', 'dddddddddddddddddddddddd')$$, 'P0001', 'duplicate', 'the same lesson cannot be reported twice');
select throws_ok($$select public.submit_request('cccccccccccccccccccccccc', 'lesson_not_held', null, now() - interval '2 hours', now(), 'dddddddddddddddddddddddd')$$, 'P0001', 'duplicate', 'not even after the lesson changed times');
select throws_ok($$select * from public.get_request((select m.id from public.my_requests() m limit 1))$$, '42501', 'forbidden', 'students cannot read single requests');
select throws_ok($$insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by) values ('eeeeeeeeeeeeeeeeeeeeeeee', 'room_closed', now(), now() + interval '1 hour', '20000000-0000-0000-0000-000000000001')$$, '42501', null, 'students cannot write the table directly');
select throws_ok($$update public.room_requests set status = 'approved'$$, '42501', null, 'students cannot approve by updating the table');
select throws_ok($$select public.review_request((select id from public.my_requests() limit 1), 'approved')$$, '42501', 'forbidden', 'students cannot review');
select is((select count(*)::int from public.my_requests()), 3, 'my_requests shows only my three requests');
select throws_ok($$select * from public.pending_requests()$$, '42501', 'forbidden', 'students cannot see the queue');

-- Daily limit: student 5 already sent 19 requests today (all decided), the 20th passes, the 21st does not.
reset role;
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by, created_at, status, reviewed_at)
select lpad(to_hex(g), 24, 'c'), 'room_closed', now(), now() + interval '1 hour', '20000000-0000-0000-0000-000000000005', now() - interval '1 hour', 'rejected', now()
from generate_series(1, 19) g;
-- Student 6 already has 5 requests waiting for review.
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by)
select lpad(to_hex(g), 24, 'f'), 'room_closed', now(), now() + interval '1 hour', '20000000-0000-0000-0000-000000000006'
from generate_series(1, 5) g;
set local role authenticated;
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000005","role":"authenticated"}';
select lives_ok($$select public.submit_request('dddddddddddddddddddddddd', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'the 20th request of the day passes');
select throws_ok($$select public.submit_request('eeeeeeeeeeeeeeeeeeeeeeee', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'P0001', 'rate_limited', 'the 21st is refused');
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000006","role":"authenticated"}';
select throws_ok($$select public.submit_request('dddddddddddddddddddddddd', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'P0001', 'too_many_pending', 'at most 5 short reports waiting at once');
select lives_ok($$select public.submit_request('dddddddddddddddddddddddd', 'issue', 'wifi', now(), now() + interval '7 days', null)$$, 'issues have their own cap');

-- Crowd: two people agree, not enough; the third makes it public.
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$select public.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'second report');
select is((select count(*)::int from public.public_room_overrides(now() - interval '1 day', now() + interval '1 day') where source = 'crowd' and room_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'), 0, 'two reports are not enough');
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($$select public.submit_request('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'third report');
select results_eq(
  $$select room_id, kind::text, source from public.public_room_overrides(now() - interval '1 day', now() + interval '1 day') where source = 'crowd' and room_id = 'aaaaaaaaaaaaaaaaaaaaaaaa'$$,
  $$values ('aaaaaaaaaaaaaaaaaaaaaaaa', 'room_occupied', 'crowd')$$,
  'three different people make the room show as occupied'
);

-- An account whose email moved to another domain does not count for the crowd.
reset role;
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by)
values ('a1a1a1a1a1a1a1a1a1a1a1a1', 'room_occupied', now(), now() + interval '1 hour', '20000000-0000-0000-0000-000000000007');
set local role authenticated;
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$select public.submit_request('a1a1a1a1a1a1a1a1a1a1a1a1', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'valid report 1');
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000003","role":"authenticated"}';
select lives_ok($$select public.submit_request('a1a1a1a1a1a1a1a1a1a1a1a1', 'room_occupied', null, now(), now() + interval '1 hour', null)$$, 'valid report 2');
select is((select count(*)::int from public.public_room_overrides(now() - interval '1 day', now() + interval '1 day') where room_id = 'a1a1a1a1a1a1a1a1a1a1a1a1'), 0, 'a no longer valid account does not complete the crowd');

-- Moderator. Ids are read here as the owner, since the table is closed to users.
reset role;
insert into public.room_requests (room_id, kind, starts_at, ends_at, created_by, created_at)
values ('abababababababababababab', 'room_closed', now() - interval '2 hours', now() - interval '1 minute', '20000000-0000-0000-0000-000000000001', now() - interval '2 hours');
create temp table ids as select id, room_id, kind from public.room_requests;
grant select on ids to authenticated;
set local role authenticated;
set local request.jwt.claims to '{"sub":"20000000-0000-0000-0000-000000000004","role":"authenticated"}';
select is((select count(*)::int from public.pending_requests() where room_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'), 1, 'moderators see the queue');
select results_eq($$select kind::text, lesson_id from public.get_request((select i.id from ids i where i.room_id = 'cccccccccccccccccccccccc' and i.kind = 'lesson_not_held'))$$, $$values ('lesson_not_held', 'dddddddddddddddddddddddd')$$, 'staff read a single request with its lesson');
select lives_ok($$select public.review_request((select i.id from ids i where i.room_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'), 'approved')$$, 'moderators approve');
select throws_ok($$select public.review_request((select i.id from ids i where i.room_id = 'bbbbbbbbbbbbbbbbbbbbbbbb'), 'rejected')$$, 'P0001', 'not_pending', 'a decision cannot be changed');
select throws_ok($$select public.review_request((select i.id from ids i where i.room_id = 'abababababababababababab'), 'approved')$$, 'P0001', 'expired', 'an expired request cannot be approved');
select throws_ok($$select public.review_request((select i.id from ids i where i.room_id = 'cccccccccccccccccccccccc' and i.kind = 'lesson_not_held'), 'pending')$$, 'P0001', 'invalid', 'pending is not a decision');
select lives_ok($$select public.submit_request('efefefefefefefefefefefef', 'room_closed', null, now(), now() + interval '1 hour', null)$$, 'moderators can report too');
select throws_ok($$select public.review_request((select m.id from public.my_requests() m where m.room_id = 'efefefefefefefefefefefef'), 'approved')$$, 'P0001', 'own_request', 'nobody reviews their own request');
select lives_ok($$select public.review_request((select i.id from ids i where i.room_id = 'cccccccccccccccccccccccc' and i.kind = 'lesson_not_held'), 'approved')$$, 'moderators approve a lesson not held');

-- What anon sees: approved requests with the lesson id, no user columns.
reset role;
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select results_eq(
  $$select room_id, kind::text, category::text, lesson_id, source from public.public_room_overrides(now() - interval '1 day', now() + interval '1 day') where source = 'approved' order by room_id$$,
  $$values ('bbbbbbbbbbbbbbbbbbbbbbbb', 'issue', 'proiettore', null::text, 'approved'), ('cccccccccccccccccccccccc', 'lesson_not_held', null, 'dddddddddddddddddddddddd', 'approved')$$,
  'approved requests are public, with the lesson id'
);

select * from finish();
rollback;
