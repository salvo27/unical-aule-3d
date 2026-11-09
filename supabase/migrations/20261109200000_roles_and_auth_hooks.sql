-- Roles and auth hooks.
-- One role per user (student by default). Roles change only through set_user_role.
-- Supabase grants new objects to anon/authenticated by default: every grant here is explicit.

create type public.app_role as enum ('student', 'moderator', 'admin');

create table public.user_roles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role public.app_role not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

alter table public.user_roles enable row level security;
revoke all on table public.user_roles from public, anon, authenticated;

-- Role of the caller, null when not logged in.
create function public.app_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then null
    else coalesce(
      (select ur.role from public.user_roles ur where ur.user_id = auth.uid()),
      'student'::public.app_role
    )
  end
$$;

create function public.is_staff()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.app_user_role() in ('moderator', 'admin'), false)
$$;

create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.app_user_role() = 'admin', false)
$$;

-- Called by the Node server with the user's token: PostgREST checks the token before running it.
create function public.whoami()
returns table (user_id uuid, role public.app_role)
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid(), public.app_user_role()
  where auth.uid() is not null
$$;

-- Only admins assign roles, and never their own (no self promotion, no locking yourself out).
create function public.set_user_role(target uuid, new_role public.app_role)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if target is null or new_role is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if target = auth.uid() then
    raise exception 'own_role' using errcode = 'P0001';
  end if;
  if not exists (select 1 from auth.users u where u.id = target) then
    raise exception 'user_missing' using errcode = 'P0001';
  end if;
  insert into public.user_roles (user_id, role, updated_by)
  values (target, new_role, auth.uid())
  on conflict (user_id) do update
    set role = excluded.role, updated_at = now(), updated_by = excluded.updated_by;
end
$$;

-- Users and roles for the admin page. The email is shown only to admins, who need it to assign roles.
create function public.list_users()
returns table (user_id uuid, email text, role public.app_role, created_at timestamptz, last_sign_in_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select u.id, u.email::text, coalesce(ur.role, 'student'::public.app_role), u.created_at, u.last_sign_in_at
    from auth.users u
    left join public.user_roles ur on ur.user_id = u.id
    order by u.created_at desc
    limit 500;
end
$$;

revoke execute on function public.app_user_role() from public, anon;
revoke execute on function public.is_staff() from public, anon;
revoke execute on function public.is_admin() from public, anon;
revoke execute on function public.whoami() from public, anon;
revoke execute on function public.set_user_role(uuid, public.app_role) from public, anon;
revoke execute on function public.list_users() from public, anon;
grant execute on function public.app_user_role() to authenticated;
grant execute on function public.is_staff() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.whoami() to authenticated;
grant execute on function public.set_user_role(uuid, public.app_role) to authenticated;
grant execute on function public.list_users() to authenticated;

-- Auth hook: only Unical mailboxes can create an account. Anything else is refused.
create function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  email text := lower(coalesce(event -> 'user' ->> 'email', ''));
begin
  if length(email) <= 254 and email ~ '^[a-z0-9._%+-]{1,64}@(unical\.it|studenti\.unical\.it)$' then
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

-- Auth hook: the role goes into the access token for the interface. Authorization reads the table.
create function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.app_role;
begin
  select ur.role into r from public.user_roles ur where ur.user_id = (event ->> 'user_id')::uuid;
  return jsonb_set(event, '{claims,user_role}', to_jsonb(coalesce(r, 'student'::public.app_role)::text));
end
$$;

revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
revoke execute on function public.custom_access_token_hook(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
grant usage on type public.app_role to supabase_auth_admin;
grant select on table public.user_roles to supabase_auth_admin;
create policy user_roles_read_by_auth on public.user_roles
  for select to supabase_auth_admin using (true);
