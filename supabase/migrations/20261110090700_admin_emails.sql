-- Admin addresses outside Unical. Only postgres fills the list, from the SQL editor:
--   insert into aule.admin_emails (email) values ('nome@example.org');
-- Such an address counts only while it is listed and its user is an admin; removing it ends the next token refresh.

create table aule.admin_emails (
  email text primary key
    constraint admin_emails_shape check (
      char_length(email) between 6 and 254
      and char_length(split_part(email, '@', 1)) between 1 and 64
      and email ~ '^[a-z0-9]+([._-][a-z0-9]+)*@([a-z0-9]+(-+[a-z0-9]+)*\.)+[a-z]{2,63}$'
    ),
  added_at timestamptz not null default now()
);
alter table aule.admin_emails enable row level security;
revoke all on table aule.admin_emails from public, anon, authenticated, service_role;

-- The hooks run as supabase_auth_admin: one exact address in, one boolean out. No case folding, no variants.
create function public.is_admin_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    char_length(p_email) <= 254
    and exists (select 1 from aule.admin_emails a where a.email = p_email),
    false)
$$;
revoke all on function public.is_admin_email(text) from public, anon, authenticated, service_role;
grant execute on function public.is_admin_email(text) to supabase_auth_admin;

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if public.is_unical_email(lower(coalesce(event -> 'user' ->> 'email', '')))
     or public.is_admin_email(event -> 'user' ->> 'email') then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object(
    'error', jsonb_build_object(
      'http_code', 403,
      'message', 'Accesso consentito solo con la mail @unical.it o @studenti.unical.it'
    )
  );
end
$$;

-- Same checks as before; an address outside Unical also needs the list and the admin role, in every mode.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.app_role;
  v_mode text;
  raw_email text := event -> 'claims' ->> 'email';
  unical boolean := public.is_unical_email(lower(coalesce(raw_email, '')));
  used_password boolean :=
    event ->> 'authentication_method' = 'password'
    or coalesce(jsonb_path_exists(event -> 'claims' -> 'amr', '$[*] ? (@.method == "password")'), false);
begin
  if used_password or not (unical or public.is_admin_email(raw_email)) then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'Accesso consentito solo con il link alla mail Unical')
    );
  end if;
  select ur.role into r from public.user_roles ur where ur.user_id = (event ->> 'user_id')::uuid;
  if not unical and r is distinct from 'admin' then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'Accesso consentito solo con il link alla mail Unical')
    );
  end if;
  v_mode := public.accounts_mode();
  if v_mode is distinct from 'all' and (v_mode is distinct from 'admin' or r is distinct from 'admin') then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'Accesso non disponibile')
    );
  end if;
  return jsonb_set(event, '{claims,user_role}', to_jsonb(coalesce(r, 'student'::public.app_role)::text));
end
$$;

-- A listed address outside Unical is a user only as an admin; as a student or moderator it is nobody.
create or replace function public.app_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then null
    else (
      select case
        when public.is_unical_email(lower(u.email)) then coalesce(ur.role, 'student'::public.app_role)
        when ur.role = 'admin' and public.is_admin_email(u.email) then ur.role
        else null
      end
      from auth.users u
      left join public.user_roles ur on ur.user_id = u.id
      where u.id = auth.uid()
        and u.email_confirmed_at is not null
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until < now())
    )
  end
$$;

create or replace function public.is_valid_user(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    left join public.user_roles ur on ur.user_id = u.id
    where u.id = uid
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until < now())
      and (public.is_unical_email(lower(u.email)) or (ur.role = 'admin' and public.is_admin_email(u.email)))
  )
$$;
