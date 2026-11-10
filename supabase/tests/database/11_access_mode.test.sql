begin;
create extension if not exists pgtap with schema extensions;
select plan(21);

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('11000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente@studenti.unical.it', now()),
  ('11000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'declassato@unical.it', now()),
  ('11000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'moderatore@unical.it', now()),
  ('11000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@unical.it', now());
insert into public.user_roles (user_id, role) values
  ('11000000-0000-0000-0000-000000000002', 'student'),
  ('11000000-0000-0000-0000-000000000003', 'moderator'),
  ('11000000-0000-0000-0000-000000000004', 'admin');

-- The event the auth server sends, and what the hook makes of it: the role, or the http code and message.
create function pg_temp.event(p_user text, p_email text, p_method text default 'otp') returns jsonb language sql immutable as $$
  select jsonb_build_object('user_id', p_user, 'authentication_method', p_method, 'claims', jsonb_build_object(
    'sub', p_user, 'email', p_email, 'amr', jsonb_build_array(jsonb_build_object('method', p_method, 'timestamp', 1))))
$$;
create function pg_temp.outcome(p_user text, p_email text, p_method text default 'otp') returns text language sql as $$
  select case when t ? 'error' then (t -> 'error' ->> 'http_code') || ' ' || (t -> 'error' ->> 'message')
    else coalesce(t -> 'claims' ->> 'user_role', 'no role') end
  from (select public.custom_access_token_hook(pg_temp.event(p_user, p_email, p_method)) as t) x
$$;
create function pg_temp.everyone() returns text[] language sql as $$
  select array[
    pg_temp.outcome('11000000-0000-0000-0000-000000000001', 'studente@studenti.unical.it'),
    pg_temp.outcome('11000000-0000-0000-0000-000000000002', 'declassato@unical.it'),
    pg_temp.outcome('11000000-0000-0000-0000-000000000003', 'moderatore@unical.it'),
    pg_temp.outcome('11000000-0000-0000-0000-000000000004', 'admin@unical.it')]
$$;
-- Runs one statement as a role, the closed sqlstate or 'ok'.
create function pg_temp.try_as(p_role text, q text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  perform set_config('request.jwt.claims',
    '{"sub":"11000000-0000-0000-0000-000000000004","role":"authenticated"}', true);
  execute q;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok';
exception when others then
  return sqlstate;
end
$$;

-- The setting.
select is((select accounts_mode from aule.settings), 'admin', 'the launch mode is admin');
select throws_ok($$update aule.settings set accounts_mode = 'tutti'$$, '23514', null, 'the mode is off, admin or all');
select throws_ok($$update aule.settings set accounts_mode = null$$, '23502', null, 'the mode is never null');
select is(public.accounts_mode(), 'admin', 'the helper returns the mode');

-- Mode admin: only admins get a token.
select is(public.custom_access_token_hook(pg_temp.event('11000000-0000-0000-0000-000000000001', 'studente@studenti.unical.it')),
  '{"error":{"http_code":403,"message":"Accesso non disponibile"}}'::jsonb, 'a student is refused with the closed error and nothing else');
select is(pg_temp.outcome('11000000-0000-0000-0000-000000000002', 'declassato@unical.it'), '403 Accesso non disponibile',
  'a user with the student role is refused');
select is(pg_temp.outcome('11000000-0000-0000-0000-000000000003', 'moderatore@unical.it'), '403 Accesso non disponibile',
  'a moderator is refused');
select is(pg_temp.outcome('11000000-0000-0000-0000-000000000004', 'admin@unical.it'), 'admin', 'an admin gets a token');
select is(public.custom_access_token_hook(pg_temp.event('11000000-0000-0000-0000-000000000004', 'admin@unical.it')),
  jsonb_set(pg_temp.event('11000000-0000-0000-0000-000000000004', 'admin@unical.it'), '{claims,user_role}', '"admin"'),
  'the admin token is the event plus the role');
select is(pg_temp.outcome('11000000-0000-0000-0000-000000000004', 'admin@unical.it', 'password'),
  '403 Accesso consentito solo con il link alla mail Unical', 'an admin password login is still refused');
select is(pg_temp.outcome('11000000-0000-0000-0000-000000000004', 'admin@gmail.com'),
  '403 Accesso consentito solo con il link alla mail Unical', 'an admin with an email outside Unical is still refused');

-- Mode off: nobody.
update aule.settings set accounts_mode = 'off';
select is(pg_temp.everyone(), array_fill('403 Accesso non disponibile'::text, array[4]), 'mode off refuses everybody, admins included');

-- Mode all: as before the access mode.
update aule.settings set accounts_mode = 'all';
select is(pg_temp.everyone(), array['student', 'student', 'moderator', 'admin'], 'mode all gives every Unical user a token with the role');
select is(
  array[
    pg_temp.outcome('11000000-0000-0000-0000-000000000001', 'studente@studenti.unical.it', 'password'),
    pg_temp.outcome('11000000-0000-0000-0000-000000000001', 'studente@gmail.com')],
  array_fill('403 Accesso consentito solo con il link alla mail Unical'::text, array[2]),
  'mode all still refuses passwords and other domains');

-- Only postgres changes the mode; the auth server reads only the mode.
select is_empty(
  $$select r.rolname::text, p.priv from pg_roles r cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
    where not r.rolsuper and r.rolname <> 'postgres' and r.rolname !~ '^pg_'
      and (has_table_privilege(r.oid, 'aule.settings'::regclass, p.priv)
        or (p.priv in ('INSERT', 'UPDATE') and has_column_privilege(r.oid, 'aule.settings'::regclass, 'accounts_mode', p.priv)))
    union all
    select 'public', p.priv from unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
    where has_table_privilege('public', 'aule.settings'::regclass, p.priv)$$,
  'no role but postgres can write aule.settings');
select is(
  array(select pg_temp.try_as(r, 'update aule.settings set accounts_mode = ''off''')
    from unnest(array['anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r),
  array_fill('42501'::text, array[7]), 'every API and internal role is refused when it tries to change the mode');
select is((select accounts_mode from aule.settings), 'all', 'the mode is unchanged');
select is_empty(
  $$select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'aule', 'aule_sync')
      and p.prosrc ~* '(update|insert\s+into|delete\s+from|truncate(\s+table)?)\s+(only\s+)?aule\.settings\M'$$,
  'no function of public, aule or aule_sync writes aule.settings');
select ok(
  has_function_privilege('supabase_auth_admin', 'public.accounts_mode()', 'EXECUTE')
    and has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'EXECUTE')
    and not has_schema_privilege('supabase_auth_admin', 'aule', 'USAGE')
    and not has_table_privilege('supabase_auth_admin', 'aule.settings', 'SELECT'),
  'supabase_auth_admin runs the hook and the helper, and reads nothing of schema aule directly');
select is(
  array(select pg_temp.try_as(r, 'select public.accounts_mode()') from unnest(array['anon', 'authenticated', 'service_role']) as r),
  array_fill('42501'::text, array[3]), 'the API roles cannot call the helper');

-- Fail closed: without a mode nobody gets a token.
delete from aule.settings;
select is(pg_temp.outcome('11000000-0000-0000-0000-000000000004', 'admin@unical.it'), '403 Accesso non disponibile',
  'without the settings row even an admin is refused');

select * from finish();
rollback;
