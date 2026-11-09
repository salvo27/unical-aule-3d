-- Second hardening round after the fix verification.
-- 1. Only authors that are still valid users count for the crowd and as supporters.
-- 2. The "waiting" cap counts short reports only; issues have their own cap; a clear code for both.
-- 3. A lesson can be reported as not held once per user, whatever its times.
-- 4. Staff read one request by id (used before approving a "not held").

-- A user counts while their email is a confirmed Unical address and the account is active.
create function public.is_valid_user(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from auth.users u
    where u.id = uid
      and u.email_confirmed_at is not null
      and u.deleted_at is null
      and (u.banned_until is null or u.banned_until < now())
      and public.is_unical_email(lower(u.email))
  )
$$;

revoke execute on function public.is_valid_user(uuid) from public, anon, authenticated;

create or replace function public.submit_request(
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
  -- Short reports and issues have separate caps, so week-long issues never block "occupied now".
  if (p_kind <> 'issue' and (select count(*) from public.room_requests r
        where r.created_by = uid and r.status = 'pending' and r.ends_at > now_ts and r.kind <> 'issue') >= 5)
     or (p_kind = 'issue' and (select count(*) from public.room_requests r
        where r.created_by = uid and r.status = 'pending' and r.ends_at > now_ts and r.kind = 'issue') >= 10) then
    raise exception 'too_many_pending' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.room_requests r
    where r.created_by = uid and r.room_id = p_room_id and r.kind = p_kind
      and (
        (p_kind = 'lesson_not_held' and r.lesson_id = p_lesson_id)
        or (p_kind <> 'lesson_not_held'
            and r.category is not distinct from p_category
            and r.starts_at < p_ends_at and r.ends_at > p_starts_at
            and r.ends_at > now_ts)
      )
  ) then
    raise exception 'duplicate' using errcode = 'P0001';
  end if;

  insert into public.room_requests (room_id, kind, category, starts_at, ends_at, created_by, lesson_id)
  values (p_room_id, p_kind, p_category, p_starts_at, p_ends_at, uid, p_lesson_id)
  returning id into new_id;
  return new_id;
end
$$;

create or replace function public.pending_requests()
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
          and o.status in ('pending', 'approved') and o.starts_at < r.ends_at and o.ends_at > r.starts_at
          and public.is_valid_user(o.created_by)),
      (select count(*)::integer from public.room_requests h where h.created_by = r.created_by and h.status = 'approved'),
      (select count(*)::integer from public.room_requests h where h.created_by = r.created_by and h.status = 'rejected')
    from public.room_requests r
    where r.status = 'pending' and r.ends_at > now() and public.is_valid_user(r.created_by)
    order by r.ends_at, r.created_at
    limit 200;
end
$$;

create or replace function public.public_room_overrides(p_from timestamptz, p_to timestamptz)
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
        and public.is_valid_user(c.created_by)
      group by c.room_id
      having count(distinct c.created_by) >= public.crowd_threshold());
end
$$;

-- One request by id, for staff: the server checks a "not held" against the timetable before approving it.
create function public.get_request(p_id uuid)
returns table (
  id uuid,
  room_id text,
  kind public.request_kind,
  lesson_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  status public.request_status
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
    select r.id, r.room_id, r.kind, r.lesson_id, r.starts_at, r.ends_at, r.status
    from public.room_requests r
    where r.id = p_id;
end
$$;

revoke execute on function public.get_request(uuid) from public, anon;
grant execute on function public.get_request(uuid) to authenticated;
