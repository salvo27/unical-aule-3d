begin;
create extension if not exists pgtap with schema extensions;
select plan(33);

-- Invented addresses only: the real list lives only in the cloud database.
select is_empty($$select email from aule.admin_emails$$, 'the list ships empty');

insert into auth.users (id, instance_id, aud, role, email, email_confirmed_at) values
  ('12000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@example.org', now()),
  ('12000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'studente@example.org', now()),
  ('12000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'moderatore@example.org', now()),
  ('12000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'admin@gmail.com', now()),
  ('12000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nonconfermato@example.org', null);
insert into public.user_roles (user_id, role) values
  ('12000000-0000-0000-0000-000000000001', 'admin'),
  ('12000000-0000-0000-0000-000000000002', 'student'),
  ('12000000-0000-0000-0000-000000000003', 'moderator'),
  ('12000000-0000-0000-0000-000000000004', 'admin'),
  ('12000000-0000-0000-0000-000000000005', 'admin');
insert into aule.admin_emails (email) values
  ('admin@example.org'), ('studente@example.org'), ('moderatore@example.org'), ('nonconfermato@example.org');

create function pg_temp.event(p_user text, p_email text, p_method text default 'otp') returns jsonb language sql immutable as $$
  select jsonb_build_object('user_id', p_user, 'authentication_method', p_method, 'claims', jsonb_build_object(
    'sub', p_user, 'email', p_email, 'amr', jsonb_build_array(jsonb_build_object(
      'method', case when p_method = 'token_refresh' then 'otp' else p_method end, 'timestamp', 1))))
$$;
create function pg_temp.outcome(p_user text, p_email text, p_method text default 'otp') returns text language sql as $$
  select case when t ? 'error' then (t -> 'error' ->> 'http_code') || ' ' || (t -> 'error' ->> 'message')
    else coalesce(t -> 'claims' ->> 'user_role', 'no role') end
  from (select public.custom_access_token_hook(pg_temp.event(p_user, p_email, p_method)) as t) x
$$;
create function pg_temp.created(p_email text) returns text language sql as $$
  select coalesce((t -> 'error' ->> 'http_code') || ' ' || (t -> 'error' ->> 'message'), 'ok')
  from (select public.hook_before_user_created(jsonb_build_object('user', jsonb_build_object('email', p_email))) as t) x
$$;
create function pg_temp.try_sql(q text) returns text language plpgsql as $$
begin
  execute q;
  return 'ok';
exception when others then
  return sqlstate;
end
$$;
create function pg_temp.try_as(p_role text, q text) returns text language plpgsql as $$
begin
  execute format('set local role %I', p_role);
  execute q;
  reset role;
  return 'ok';
exception when others then
  return sqlstate;
end
$$;
-- Runs one statement as a logged-in user: 'ok' or the sqlstate.
create function pg_temp.as_user(p_user text, q text) returns text language plpgsql as $$
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  execute q;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return 'ok';
exception when others then
  return sqlstate;
end
$$;
-- The role whoami gives a logged-in user, or nobody.
create function pg_temp.role_of(p_user text) returns text language plpgsql as $$
declare
  v text;
begin
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select w.role::text into v from public.whoami() w;
  reset role;
  perform set_config('request.jwt.claims', '', true);
  return coalesce(v, 'nobody');
exception when others then
  return sqlstate;
end
$$;

-- The list: lower-case plain addresses only.
select is(
  array(select pg_temp.try_sql(format('insert into aule.admin_emails (email) values (%L)', e))
    from unnest(array['Admin@example.org', 'admin+x@example.org', ' admin@example.org', 'admin@example.org ', E'admin@example.org\n',
      'admin@example', 'admin@@example.org', 'admin@-example.org', 'a@b.c', '.admin@example.org', 'ad..min@example.org',
      'àdmin@example.org', repeat('a', 65) || '@example.org', 'admin@' || repeat('a', 245) || '.org', '']) e),
  array_fill('23514'::text, array[15]),
  'upper case, plus addressing, padding, bad domains and wrong lengths never enter the list');
select throws_ok($$insert into aule.admin_emails (email) values (null)$$, '23502', null, 'the address is never null');
select lives_ok($$insert into aule.admin_emails (email) values ('nome.cognome-1@posta.example.org')$$,
  'a plain address with dots, dashes and subdomains enters the list');

-- Account creation.
select is(pg_temp.created('admin@example.org'), 'ok', 'a listed address can be created');
select is(pg_temp.created('admin@gmail.com'), '403 Accesso consentito solo con la mail @unical.it o @studenti.unical.it',
  'an address outside Unical and outside the list is refused at creation');
select is(
  array(select pg_temp.created(e)
    from unnest(array['Admin@example.org', 'ADMIN@EXAMPLE.ORG', 'admin+x@example.org', ' admin@example.org', 'admin@example.org.']) e),
  array_fill('403 Accesso consentito solo con la mail @unical.it o @studenti.unical.it'::text, array[5]),
  'upper-case, plus-addressing and padded variants of a listed address are refused at creation');
select is(pg_temp.created('studente@studenti.unical.it'), 'ok', 'Unical addresses are created as before');

-- Tokens in mode admin (the launch mode).
select is(pg_temp.outcome('12000000-0000-0000-0000-000000000001', 'admin@example.org'), 'admin', 'a listed admin gets a token');
select is(pg_temp.outcome('12000000-0000-0000-0000-000000000001', 'admin@example.org', 'token_refresh'), 'admin',
  'a listed admin refreshes the token');
select is(
  array[pg_temp.outcome('12000000-0000-0000-0000-000000000002', 'studente@example.org'),
    pg_temp.outcome('12000000-0000-0000-0000-000000000003', 'moderatore@example.org')],
  array_fill('403 Accesso consentito solo con il link alla mail Unical'::text, array[2]),
  'a listed address with the student or the moderator role is refused');
select is(pg_temp.outcome('12000000-0000-0000-0000-000000000004', 'admin@gmail.com'),
  '403 Accesso consentito solo con il link alla mail Unical', 'an admin outside Unical and outside the list is refused');
select is(
  array(select pg_temp.outcome('12000000-0000-0000-0000-000000000001', e)
    from unnest(array['Admin@example.org', 'ADMIN@EXAMPLE.ORG', 'admin+x@example.org']) e),
  array_fill('403 Accesso consentito solo con il link alla mail Unical'::text, array[3]),
  'upper-case and plus-addressing variants of a listed address get no token');
select is(pg_temp.outcome('12000000-0000-0000-0000-000000000001', 'admin@example.org', 'password'),
  '403 Accesso consentito solo con il link alla mail Unical', 'a listed admin is still refused with a password');

-- The other modes.
update aule.settings set accounts_mode = 'all';
select is(
  array[pg_temp.outcome('12000000-0000-0000-0000-000000000001', 'admin@example.org'),
    pg_temp.outcome('12000000-0000-0000-0000-000000000002', 'studente@example.org'),
    pg_temp.outcome('12000000-0000-0000-0000-000000000003', 'moderatore@example.org'),
    pg_temp.outcome('12000000-0000-0000-0000-000000000004', 'admin@gmail.com')],
  array['admin', '403 Accesso consentito solo con il link alla mail Unical', '403 Accesso consentito solo con il link alla mail Unical',
    '403 Accesso consentito solo con il link alla mail Unical'],
  'mode all: outside Unical only the listed admin gets a token');
update aule.settings set accounts_mode = 'off';
select is(pg_temp.outcome('12000000-0000-0000-0000-000000000001', 'admin@example.org'), '403 Accesso non disponibile',
  'mode off refuses the listed admin too');
update aule.settings set accounts_mode = 'admin';

-- Who the database thinks the caller is.
select is(pg_temp.role_of('12000000-0000-0000-0000-000000000001'), 'admin', 'whoami: a confirmed listed admin is an admin');
select is(
  array[pg_temp.role_of('12000000-0000-0000-0000-000000000002'), pg_temp.role_of('12000000-0000-0000-0000-000000000003'),
    pg_temp.role_of('12000000-0000-0000-0000-000000000004'), pg_temp.role_of('12000000-0000-0000-0000-000000000005')],
  array_fill('nobody'::text, array[4]),
  'whoami: a listed student or moderator, an unlisted admin and an unconfirmed listed admin are nobody');
select is(pg_temp.as_user('12000000-0000-0000-0000-000000000001', 'select * from public.list_staff()'), 'ok',
  'a listed admin uses the admin functions');
select is(
  array[pg_temp.as_user('12000000-0000-0000-0000-000000000002', 'select * from public.list_staff()'),
    pg_temp.as_user('12000000-0000-0000-0000-000000000003', 'select * from public.list_staff()'),
    pg_temp.as_user('12000000-0000-0000-0000-000000000004', 'select * from public.list_staff()')],
  array_fill('42501'::text, array[3]),
  'a listed student or moderator and an unlisted admin cannot');
select is(
  array[public.is_valid_user('12000000-0000-0000-0000-000000000001'), public.is_valid_user('12000000-0000-0000-0000-000000000002'),
    public.is_valid_user('12000000-0000-0000-0000-000000000003'), public.is_valid_user('12000000-0000-0000-0000-000000000004')],
  array[true, false, false, false],
  'outside Unical only the listed admin counts as a valid user');
select is(
  array[public.is_admin_email('admin@example.org'), public.is_admin_email('ADMIN@EXAMPLE.ORG'),
    public.is_admin_email('admin+x@example.org'), public.is_admin_email(null), public.is_admin_email(repeat('a', 300))],
  array[true, false, false, false, false],
  'the helper matches one exact listed address');

-- Removing an address ends the access at the next token.
delete from aule.admin_emails where email = 'admin@example.org';
select is(pg_temp.outcome('12000000-0000-0000-0000-000000000001', 'admin@example.org', 'token_refresh'),
  '403 Accesso consentito solo con il link alla mail Unical', 'once removed from the list the next token refresh fails');
select is(
  array[pg_temp.role_of('12000000-0000-0000-0000-000000000001'), public.is_valid_user('12000000-0000-0000-0000-000000000001')::text],
  array['nobody', 'false'], 'once removed from the list the admin is nobody');
select is(pg_temp.created('admin@example.org'), '403 Accesso consentito solo con la mail @unical.it o @studenti.unical.it',
  'once removed from the list the address cannot be created again');

-- Only postgres reads or writes the list; the auth server gets one boolean per address.
select is_empty(
  $$select r.rolname::text, p.priv from pg_roles r
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
    where not r.rolsuper and r.rolname <> 'postgres' and r.rolname !~ '^pg_'
      and not (p.priv = 'SELECT' and pg_has_role(r.oid, 'pg_read_all_data', 'USAGE'))
      and (has_table_privilege(r.oid, 'aule.admin_emails'::regclass, p.priv)
        or (p.priv in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES') and has_any_column_privilege(r.oid, 'aule.admin_emails'::regclass, p.priv)))
    union all
    select 'public', p.priv from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) as p(priv)
    where has_table_privilege('public', 'aule.admin_emails'::regclass, p.priv)$$,
  'no role but postgres reads or writes the list (platform readers of every table through pg_read_all_data aside)');
select is(
  array(select pg_temp.try_as(r, q)
    from unnest(array['anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) r
    cross join unnest(array['select email from aule.admin_emails',
      'insert into aule.admin_emails (email) values (''altro@example.org'')',
      'update aule.admin_emails set added_at = now()', 'delete from aule.admin_emails']) q),
  array_fill('42501'::text, array[28]),
  'every API and internal role is refused when it reads or writes the list');
select ok(
  has_function_privilege('supabase_auth_admin', 'public.is_admin_email(text)', 'EXECUTE')
    and has_function_privilege('supabase_auth_admin', 'public.hook_before_user_created(jsonb)', 'EXECUTE')
    and has_function_privilege('supabase_auth_admin', 'public.custom_access_token_hook(jsonb)', 'EXECUTE')
    and not has_schema_privilege('supabase_auth_admin', 'aule', 'USAGE')
    and not has_table_privilege('supabase_auth_admin', 'aule.admin_emails', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'),
  'supabase_auth_admin runs the hooks and the helper and has no privilege on the list');
select is(
  array(select pg_temp.try_as(r, 'select public.is_admin_email(''studente@example.org'')')
    from unnest(array['anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) r),
  array_fill('42501'::text, array[7]), 'no API or internal role calls the helper');
select ok(
  (select p.prosecdef and p.proowner = 'postgres'::regrole and p.provolatile = 's' and p.proconfig @> array['search_path=""']
    from pg_proc p where p.oid = 'public.is_admin_email(text)'::regprocedure),
  'the helper is a stable security definer owned by postgres with an empty search_path');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'aule.admin_emails'::regclass), 'row level security is on');
select is_empty($$select pol.polname from pg_policy pol where pol.polrelid = 'aule.admin_emails'::regclass$$, 'no policy opens the list');
select is_empty(
  $$select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'aule', 'aule_sync')
      and p.prosrc ~* '(update|insert\s+into|delete\s+from|truncate(\s+table)?)\s+(only\s+)?aule\.admin_emails\M'$$,
  'no function of public, aule or aule_sync writes the list');

select * from finish();
rollback;
