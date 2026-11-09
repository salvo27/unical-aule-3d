-- Hardening after the independent review.
-- 1. One Unical mailbox = one account: no sub-addressing, and the domain rule holds for every token and every call.
-- 2. No passwords: password logins and tokens from password sessions are refused.
-- 3. Request windows are enforced by the database with the same limits as the server; "lesson not held" keeps the lesson id.
-- 4. Admins look users up by exact email instead of listing everybody.

-- Exact domains, letters/digits with single dots, dashes or underscores between them. No '+' or '%'.
create function public.is_unical_email(email text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select email is not null
    and length(email) <= 254
    and length(split_part(email, '@', 1)) between 1 and 64
    and email ~ '^[a-z0-9]+([._-][a-z0-9]+)*@(unical\.it|studenti\.unical\.it)$'
$$;

revoke execute on function public.is_unical_email(text) from public, anon, authenticated;
grant execute on function public.is_unical_email(text) to supabase_auth_admin;

create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
begin
  if public.is_unical_email(lower(coalesce(event -> 'user' ->> 'email', ''))) then
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

-- Every token (login and refresh) must belong to a Unical address and must not come from a password.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  r public.app_role;
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
  return jsonb_set(event, '{claims,user_role}', to_jsonb(coalesce(r, 'student'::public.app_role)::text));
end
$$;

-- Password checks always fail: the project has no passwords.
create function public.hook_password_verification_attempt(event jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object('decision', 'reject', 'message', 'Accesso consentito solo con il link alla mail Unical', 'should_logout_user', true)
$$;

revoke execute on function public.hook_password_verification_attempt(jsonb) from public, anon, authenticated;
grant execute on function public.hook_password_verification_attempt(jsonb) to supabase_auth_admin;

-- The caller counts as a user only with a confirmed Unical email right now (an email change to another domain locks them out).
create or replace function public.app_user_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then null
    when not exists (
      select 1 from auth.users u
      where u.id = auth.uid()
        and u.email_confirmed_at is not null
        and u.deleted_at is null
        and (u.banned_until is null or u.banned_until < now())
        and public.is_unical_email(lower(u.email))
    ) then null
    else coalesce(
      (select ur.role from public.user_roles ur where ur.user_id = auth.uid()),
      'student'::public.app_role
    )
  end
$$;

create or replace function public.whoami()
returns table (user_id uuid, role public.app_role)
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid(), public.app_user_role()
  where auth.uid() is not null and public.app_user_role() is not null
$$;

-- Users: exact lookup by email, and the list of staff. No full user list.
drop function public.list_users();

create function public.find_user(p_email text)
returns table (user_id uuid, email text, role public.app_role)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not public.is_unical_email(lower(coalesce(p_email, ''))) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  return query
    select u.id, u.email::text, coalesce(ur.role, 'student'::public.app_role)
    from auth.users u
    left join public.user_roles ur on ur.user_id = u.id
    where lower(u.email) = lower(p_email) and u.email_confirmed_at is not null
    limit 1;
end
$$;

create function public.list_staff()
returns table (user_id uuid, email text, role public.app_role, last_sign_in_at timestamptz)
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
    select u.id, u.email::text, ur.role, u.last_sign_in_at
    from public.user_roles ur
    join auth.users u on u.id = ur.user_id
    where ur.role in ('moderator', 'admin')
    order by ur.role desc, u.email
    limit 200;
end
$$;

revoke execute on function public.find_user(text) from public, anon;
revoke execute on function public.list_staff() from public, anon;
grant execute on function public.find_user(text) to authenticated;
grant execute on function public.list_staff() to authenticated;

-- Requests: lesson id for "not held", windows per kind in the table itself.
alter table public.room_requests add column lesson_id text;
-- Rows written under the first rules: a "not held" without its lesson cannot be kept, long windows are shortened.
delete from public.room_requests where kind = 'lesson_not_held';
update public.room_requests
  set ends_at = starts_at + case kind when 'room_occupied' then interval '1 hour' when 'room_closed' then interval '12 hours' else interval '7 days' end
  where ends_at - starts_at > case kind when 'room_occupied' then interval '1 hour' when 'room_closed' then interval '12 hours' else interval '7 days' end;
alter table public.room_requests add constraint room_requests_lesson check (
  (kind = 'lesson_not_held') = (lesson_id is not null)
  and (lesson_id is null or lesson_id ~ '^[0-9a-f]{24}$')
);
alter table public.room_requests drop constraint room_requests_window;
alter table public.room_requests add constraint room_requests_window check (
  ends_at > starts_at
  and ends_at - starts_at <= case kind
    when 'room_occupied' then interval '1 hour'
    when 'room_closed' then interval '12 hours'
    when 'lesson_not_held' then interval '12 hours'
    else interval '7 days'
  end
);
create unique index room_requests_one_per_lesson on public.room_requests (created_by, room_id, lesson_id)
  where kind = 'lesson_not_held';

drop function public.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz);

create function public.submit_request(
  p_room_id text,
  p_kind public.request_kind,
  p_category public.issue_category,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_lesson_id text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  now_ts timestamptz := now();
  rome_midnight timestamptz := (date_trunc('day', now() at time zone 'Europe/Rome') + interval '1 day') at time zone 'Europe/Rome';
  new_id uuid;
begin
  if uid is null or public.app_user_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_room_id is null or p_room_id !~ '^[0-9a-f]{24}$' or p_kind is null
     or p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at
     or (p_kind = 'issue') <> (p_category is not null)
     or (p_kind = 'lesson_not_held') <> (p_lesson_id is not null)
     or (p_lesson_id is not null and p_lesson_id !~ '^[0-9a-f]{24}$') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- Same limits as the server (src/domain/requests.ts); the server is not trusted to enforce them alone.
  if (p_kind in ('room_occupied', 'room_closed', 'issue') and abs(extract(epoch from p_starts_at - now_ts)) > 900)
     or (p_kind = 'room_occupied' and p_ends_at - p_starts_at > interval '1 hour')
     or (p_kind = 'room_closed' and (p_ends_at - p_starts_at > interval '12 hours' or p_ends_at > rome_midnight))
     or (p_kind = 'issue' and p_ends_at - p_starts_at > interval '7 days')
     or (p_kind = 'lesson_not_held' and (p_starts_at > now_ts + interval '15 minutes' or p_ends_at < now_ts - interval '12 hours' or p_ends_at - p_starts_at > interval '12 hours')) then
    raise exception 'window' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room_requests:' || uid::text, 0));

  if (select count(*) from public.room_requests r where r.created_by = uid and r.created_at > now_ts - interval '24 hours') >= 20 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if (select count(*) from public.room_requests r where r.created_by = uid and r.status = 'pending' and r.ends_at > now_ts) >= 5 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.room_requests r
    where r.created_by = uid and r.room_id = p_room_id and r.kind = p_kind
      and r.category is not distinct from p_category
      and r.lesson_id is not distinct from p_lesson_id
      and r.starts_at < p_ends_at and r.ends_at > p_starts_at
      and (p_kind = 'lesson_not_held' or r.ends_at > now_ts)
  ) then
    raise exception 'duplicate' using errcode = 'P0001';
  end if;

  insert into public.room_requests (room_id, kind, category, starts_at, ends_at, created_by, lesson_id)
  values (p_room_id, p_kind, p_category, p_starts_at, p_ends_at, uid, p_lesson_id)
  returning id into new_id;
  return new_id;
end
$$;

revoke execute on function public.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz, text) to authenticated;

-- my_requests also requires a valid user.
create or replace function public.my_requests()
returns table (
  id uuid,
  room_id text,
  kind public.request_kind,
  category public.issue_category,
  starts_at timestamptz,
  ends_at timestamptz,
  status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or public.app_user_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select r.id, r.room_id, r.kind, r.category, r.starts_at, r.ends_at,
      case when r.status = 'pending' and r.ends_at <= now() then 'expired' else r.status::text end,
      r.created_at
    from public.room_requests r
    where r.created_by = auth.uid()
    order by r.created_at desc
    limit 50;
end
$$;

-- Queue: most urgent first, with the lesson id.
drop function public.pending_requests();

create function public.pending_requests()
returns table (
  id uuid,
  room_id text,
  kind public.request_kind,
  category public.issue_category,
  lesson_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  created_at timestamptz,
  supporters integer,
  reporter_approved integer,
  reporter_rejected integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return query
    select r.id, r.room_id, r.kind, r.category, r.lesson_id, r.starts_at, r.ends_at, r.created_at,
      (select count(distinct o.created_by)::integer from public.room_requests o
        where o.room_id = r.room_id and o.kind = r.kind and o.created_by <> r.created_by
          and o.status in ('pending', 'approved') and o.starts_at < r.ends_at and o.ends_at > r.starts_at),
      (select count(*)::integer from public.room_requests h where h.created_by = r.created_by and h.status = 'approved'),
      (select count(*)::integer from public.room_requests h where h.created_by = r.created_by and h.status = 'rejected')
    from public.room_requests r
    where r.status = 'pending' and r.ends_at > now()
    order by r.ends_at, r.created_at
    limit 200;
end
$$;

revoke execute on function public.pending_requests() from public, anon;
grant execute on function public.pending_requests() to authenticated;

-- Map overrides now carry the lesson id, so "not held" cancels exactly that lesson.
drop function public.public_room_overrides(timestamptz, timestamptz);

create function public.public_room_overrides(p_from timestamptz, p_to timestamptz)
returns table (
  room_id text,
  kind public.request_kind,
  category public.issue_category,
  lesson_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  source text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  return query
    (select r.room_id, r.kind, r.category, r.lesson_id, r.starts_at, r.ends_at, 'approved'::text
      from public.room_requests r
      where r.status = 'approved' and r.starts_at < p_to and r.ends_at > p_from
      limit 5000)
    union all
    (select c.room_id, 'room_occupied'::public.request_kind, null::public.issue_category, null::text,
        min(c.starts_at), max(c.ends_at), 'crowd'::text
      from public.room_requests c
      where c.status = 'pending' and c.kind = 'room_occupied' and c.starts_at <= now() and c.ends_at > now()
      group by c.room_id
      having count(distinct c.created_by) >= public.crowd_threshold());
end
$$;

revoke execute on function public.public_room_overrides(timestamptz, timestamptz) from public;
grant execute on function public.public_room_overrides(timestamptz, timestamptz) to anon, authenticated;
