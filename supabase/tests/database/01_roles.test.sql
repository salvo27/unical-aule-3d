begin;
create extension if not exists pgtap with schema extensions;
select plan(35);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente@studenti.unical.it', now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@unical.it', now()),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'altro@studenti.unical.it', now()),
  ('10000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'moderatore@unical.it', now()),
  ('10000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'cambiata@gmail.com', now()),
  ('10000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nonconfermata@studenti.unical.it', null);
insert into public.user_roles (user_id, role) values
  ('10000000-0000-0000-0000-000000000002', 'admin'),
  ('10000000-0000-0000-0000-000000000004', 'moderator');

-- Sign-up hook: only exact Unical domains, one mailbox one address.
select is(public.hook_before_user_created('{"user":{"email":"Nome.Cognome@studenti.unical.it"}}'), '{}'::jsonb, 'student mailbox is allowed');
select is(public.hook_before_user_created('{"user":{"email":"docente@unical.it"}}'), '{}'::jsonb, 'staff mailbox is allowed');
select ok(public.hook_before_user_created('{"user":{"email":"someone@gmail.com"}}') ? 'error', 'other domains are refused');
select ok(public.hook_before_user_created('{"user":{"email":"x@unical.it.evil.com"}}') ? 'error', 'suffix tricks are refused');
select ok(public.hook_before_user_created('{"user":{"email":"x@evilunical.it"}}') ? 'error', 'look-alike domains are refused');
select ok(public.hook_before_user_created('{"user":{"email":"a@b@unical.it"}}') ? 'error', 'two @ are refused');
select ok(public.hook_before_user_created('{"user":{}}') ? 'error', 'missing email is refused');
select is((public.hook_before_user_created('{"user":{"email":"x@gmail.com"}}') -> 'error' ->> 'http_code')::int, 403, 'refusal uses 403');
select ok(public.hook_before_user_created('{"user":{"email":"m+1@studenti.unical.it"}}') ? 'error', 'sub-addressing with + is refused');
select ok(public.hook_before_user_created('{"user":{"email":"m%x@unical.it"}}') ? 'error', '% is refused');
select ok(public.hook_before_user_created('{"user":{"email":".m@unical.it"}}') ? 'error', 'leading dot is refused');
select ok(public.hook_before_user_created('{"user":{"email":"a..b@unical.it"}}') ? 'error', 'double dot is refused');

-- Access token hook: role in the token, and no token for other domains or passwords.
-- Mode all lets every Unical user in; 11_access_mode covers the other modes.
update aule.settings set accounts_mode = 'all';
select is(
  public.custom_access_token_hook('{"user_id":"10000000-0000-0000-0000-000000000001","authentication_method":"otp","claims":{"sub":"x","email":"studente@studenti.unical.it","amr":[{"method":"otp","timestamp":1}]}}') -> 'claims' ->> 'user_role',
  'student', 'default role in the token is student');
select is(
  public.custom_access_token_hook('{"user_id":"10000000-0000-0000-0000-000000000002","authentication_method":"magiclink","claims":{"sub":"x","email":"admin@unical.it"}}') -> 'claims' ->> 'user_role',
  'admin', 'admin role reaches the token');
select ok(
  public.custom_access_token_hook('{"user_id":"10000000-0000-0000-0000-000000000005","authentication_method":"otp","claims":{"sub":"x","email":"cambiata@gmail.com"}}') ? 'error',
  'no token after an email change to another domain');
select ok(
  public.custom_access_token_hook('{"user_id":"10000000-0000-0000-0000-000000000001","authentication_method":"token_refresh","claims":{"sub":"x","email":"studente@studenti.unical.it","amr":[{"method":"password","timestamp":1}]}}') ? 'error',
  'no refresh for a session that started with a password');
select ok(
  public.custom_access_token_hook('{"user_id":"10000000-0000-0000-0000-000000000001","authentication_method":"password","claims":{"sub":"x","email":"studente@studenti.unical.it"}}') ? 'error',
  'no token for a password login');
select is(public.hook_password_verification_attempt('{"user_id":"x","valid":true}') ->> 'decision', 'reject', 'password checks always fail');

-- Anonymous visitors.
set local role anon;
set local request.jwt.claims to '{"role":"anon"}';
select throws_ok($$select * from public.user_roles$$, '42501', null, 'anon cannot read roles');
select throws_ok($$select * from public.whoami()$$, '42501', null, 'anon cannot call whoami');
select throws_ok($$select public.set_user_role('10000000-0000-0000-0000-000000000001', 'admin')$$, '42501', null, 'anon cannot assign roles');

-- A student.
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_ok($$select * from public.user_roles$$, '42501', null, 'students cannot read the roles table');
select results_eq($$select role::text from public.whoami()$$, $$values ('student')$$, 'whoami returns the student role');
select throws_ok($$select public.set_user_role('10000000-0000-0000-0000-000000000001', 'admin')$$, '42501', 'forbidden', 'students cannot promote themselves');
select throws_ok($$select * from public.find_user('admin@unical.it')$$, '42501', 'forbidden', 'students cannot look up users');

-- A moderator is not an admin.
set local request.jwt.claims to '{"sub":"10000000-0000-0000-0000-000000000004","role":"authenticated"}';
select throws_ok($$select public.set_user_role('10000000-0000-0000-0000-000000000001', 'moderator')$$, '42501', 'forbidden', 'moderators cannot assign roles');
select throws_ok($$select * from public.list_staff()$$, '42501', 'forbidden', 'moderators cannot list staff');

-- An admin.
set local request.jwt.claims to '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}';
select lives_ok($$select public.set_user_role('10000000-0000-0000-0000-000000000003', 'moderator')$$, 'admins assign roles');
select throws_ok($$select public.set_user_role('10000000-0000-0000-0000-000000000002', 'student')$$, 'P0001', 'own_role', 'admins cannot change their own role');
select results_eq($$select role::text from public.find_user('Altro@studenti.unical.it')$$, $$values ('moderator')$$, 'admins find a user by exact email');
select throws_ok($$select * from public.find_user('altro')$$, 'P0001', 'invalid', 'the lookup needs a full Unical email');
select is((select count(*)::int from public.find_user('nessuno@unical.it')), 0, 'an unknown email returns nothing');
select is(
  (select count(*)::int from public.list_staff() where user_id in (
    '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000004')),
  3, 'staff list shows admins and moderators');

-- Accounts that are no longer valid.
set local request.jwt.claims to '{"sub":"10000000-0000-0000-0000-000000000005","role":"authenticated"}';
select is((select count(*)::int from public.whoami()), 0, 'a user whose email moved to another domain is nobody');
set local request.jwt.claims to '{"sub":"10000000-0000-0000-0000-000000000006","role":"authenticated"}';
select is((select count(*)::int from public.whoami()), 0, 'an unconfirmed user is nobody');

select * from finish();
rollback;
