-- Who gets a token: off = nobody, admin = admins only (launch value), all = every Unical user.
-- Only postgres changes it, from the SQL editor: update aule.settings set accounts_mode = 'all';

alter table aule.settings
  add column accounts_mode text not null default 'admin'
  constraint settings_accounts_mode check (accounts_mode in ('off', 'admin', 'all'));

-- The hook runs as supabase_auth_admin: this value is the only thing of schema aule it can read.
create function public.accounts_mode()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select s.accounts_mode from aule.settings s
$$;
revoke all on function public.accounts_mode() from public, anon, authenticated, service_role;
grant execute on function public.accounts_mode() to supabase_auth_admin;

-- Owned by the NOLOGIN reader, which can only read. The grant above moves with the ownership.
grant create on schema public to aule_reader;
alter function public.accounts_mode() owner to aule_reader;
revoke create on schema public from aule_reader;

-- postgres calls the hook from the SQL editor and the tests; only the new owner can grant it.
set role aule_reader;
grant execute on function public.accounts_mode() to postgres;
reset role;

-- Same checks as before, then the access mode. A missing or unknown mode refuses every token.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.app_role;
  v_mode text;
  email text := lower(coalesce(event -> 'claims' ->> 'email', ''));
  used_password boolean :=
    event ->> 'authentication_method' = 'password'
    or coalesce(jsonb_path_exists(event -> 'claims' -> 'amr', '$[*] ? (@.method == "password")'), false);
begin
  if not public.is_unical_email(email) or used_password then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'Accesso consentito solo con il link alla mail Unical')
    );
  end if;
  select ur.role into r from public.user_roles ur where ur.user_id = (event ->> 'user_id')::uuid;
  v_mode := public.accounts_mode();
  if v_mode is distinct from 'all' and (v_mode is distinct from 'admin' or r is distinct from 'admin') then
    return jsonb_build_object(
      'error', jsonb_build_object('http_code', 403, 'message', 'Accesso non disponibile')
    );
  end if;
  return jsonb_set(event, '{claims,user_role}', to_jsonb(coalesce(r, 'student'::public.app_role)::text));
end
$$;
