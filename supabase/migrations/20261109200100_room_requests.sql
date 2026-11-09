-- Requests from logged-in users about a room: occupied now, lesson not held, room closed, or an issue.
-- Writes go only through functions: the table itself is closed to anon and authenticated.

create type public.request_kind as enum ('room_occupied', 'lesson_not_held', 'room_closed', 'issue');
create type public.issue_category as enum (
  'bagni', 'proiettore', 'prese', 'riscaldamento', 'aria_condizionata', 'pulizia', 'macchinette', 'wifi', 'arredi', 'altro'
);
create type public.request_status as enum ('pending', 'approved', 'rejected');

create table public.room_requests (
  id uuid primary key default gen_random_uuid(),
  room_id text not null check (room_id ~ '^[0-9a-f]{24}$'),
  kind public.request_kind not null,
  category public.issue_category,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.request_status not null default 'pending',
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  constraint room_requests_window check (
    ends_at > starts_at
    and ends_at - starts_at <= case when kind = 'issue' then interval '30 days' else interval '12 hours' end
  ),
  constraint room_requests_category check ((kind = 'issue') = (category is not null)),
  constraint room_requests_review check ((status = 'pending') = (reviewed_at is null))
);

create index room_requests_room_window on public.room_requests (room_id, starts_at, ends_at);
create index room_requests_status_end on public.room_requests (status, ends_at);
create index room_requests_author on public.room_requests (created_by, created_at);

alter table public.room_requests enable row level security;
revoke all on table public.room_requests from public, anon, authenticated;

-- How many different users must report "occupied now" before the map shows it without a review.
create function public.crowd_threshold()
returns integer
language sql
immutable
as $$
  select 3
$$;

create function public.submit_request(
  p_room_id text,
  p_kind public.request_kind,
  p_category public.issue_category,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  now_ts timestamptz := now();
  new_id uuid;
begin
  if uid is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_room_id is null or p_room_id !~ '^[0-9a-f]{24}$' or p_kind is null
     or p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at
     or (p_kind = 'issue') <> (p_category is not null) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  if (p_kind = 'room_occupied' and (abs(extract(epoch from p_starts_at - now_ts)) > 900 or p_ends_at - p_starts_at > interval '3 hours'))
     or (p_kind = 'room_closed' and (p_starts_at < now_ts - interval '1 hour' or p_starts_at > now_ts + interval '7 days' or p_ends_at - p_starts_at > interval '12 hours'))
     or (p_kind = 'lesson_not_held' and (p_starts_at > now_ts + interval '15 minutes' or p_ends_at < now_ts - interval '12 hours' or p_ends_at - p_starts_at > interval '12 hours'))
     or (p_kind = 'issue' and (abs(extract(epoch from p_starts_at - now_ts)) > 900 or p_ends_at - p_starts_at > interval '30 days')) then
    raise exception 'window' using errcode = 'P0001';
  end if;

  -- One request at a time per user, so the limits below cannot be raced.
  perform pg_advisory_xact_lock(hashtextextended('room_requests:' || uid::text, 0));

  if (select count(*) from public.room_requests r where r.created_by = uid and r.created_at > now_ts - interval '24 hours') >= 20 then
    raise exception 'rate_limited' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from public.room_requests r
    where r.created_by = uid and r.room_id = p_room_id and r.kind = p_kind
      and r.status in ('pending', 'approved') and r.ends_at > now_ts
      and r.starts_at < p_ends_at and r.ends_at > p_starts_at
  ) then
    raise exception 'duplicate' using errcode = 'P0001';
  end if;

  insert into public.room_requests (room_id, kind, category, starts_at, ends_at, created_by)
  values (p_room_id, p_kind, p_category, p_starts_at, p_ends_at, uid)
  returning id into new_id;
  return new_id;
end
$$;

-- Explicit transition: only pending requests, only staff, never on their own request.
create function public.review_request(p_id uuid, p_decision public.request_status)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.room_requests%rowtype;
begin
  if not public.is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_id is null or p_decision is null or p_decision = 'pending' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  select * into r from public.room_requests where id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if r.created_by = auth.uid() then
    raise exception 'own_request' using errcode = 'P0001';
  end if;
  if r.status <> 'pending' then
    raise exception 'not_pending' using errcode = 'P0001';
  end if;
  if p_decision = 'approved' and r.ends_at <= now() then
    raise exception 'expired' using errcode = 'P0001';
  end if;
  update public.room_requests
    set status = p_decision, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_id;
end
$$;

-- Review queue: no user identity, only how many others agree and the reporter's track record.
create function public.pending_requests()
returns table (
  id uuid,
  room_id text,
  kind public.request_kind,
  category public.issue_category,
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
    select r.id, r.room_id, r.kind, r.category, r.starts_at, r.ends_at, r.created_at,
      (select count(distinct o.created_by)::integer from public.room_requests o
        where o.room_id = r.room_id and o.kind = r.kind and o.created_by <> r.created_by
          and o.status in ('pending', 'approved') and o.starts_at < r.ends_at and o.ends_at > r.starts_at),
      (select count(*)::integer from public.room_requests h where h.created_by = r.created_by and h.status = 'approved'),
      (select count(*)::integer from public.room_requests h where h.created_by = r.created_by and h.status = 'rejected')
    from public.room_requests r
    where r.status = 'pending' and r.ends_at > now()
    order by r.created_at
    limit 200;
end
$$;

-- The caller's own requests. "expired" is derived: a pending request whose window is over.
create function public.my_requests()
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
  if auth.uid() is null then
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

-- What the map needs, with no user data: approved requests, plus "occupied now" when enough people agree.
create function public.public_room_overrides(p_from timestamptz, p_to timestamptz)
returns table (
  room_id text,
  kind public.request_kind,
  category public.issue_category,
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
    (select r.room_id, r.kind, r.category, r.starts_at, r.ends_at, 'approved'::text
      from public.room_requests r
      where r.status = 'approved' and r.starts_at < p_to and r.ends_at > p_from
      limit 5000)
    union all
    (select c.room_id, 'room_occupied'::public.request_kind, null::public.issue_category,
        min(c.starts_at), max(c.ends_at), 'crowd'::text
      from public.room_requests c
      where c.status = 'pending' and c.kind = 'room_occupied' and c.starts_at <= now() and c.ends_at > now()
      group by c.room_id
      having count(distinct c.created_by) >= public.crowd_threshold());
end
$$;

revoke execute on function public.crowd_threshold() from public, anon, authenticated;
revoke execute on function public.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz) from public, anon;
revoke execute on function public.review_request(uuid, public.request_status) from public, anon;
revoke execute on function public.pending_requests() from public, anon;
revoke execute on function public.my_requests() from public, anon;
revoke execute on function public.public_room_overrides(timestamptz, timestamptz) from public;
grant execute on function public.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz) to authenticated;
grant execute on function public.review_request(uuid, public.request_status) to authenticated;
grant execute on function public.pending_requests() to authenticated;
grant execute on function public.my_requests() to authenticated;
grant execute on function public.public_room_overrides(timestamptz, timestamptz) to anon, authenticated;
