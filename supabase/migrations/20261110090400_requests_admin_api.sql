-- Requests, configuration and admin API.
-- Reports: report_room decides the window in the database. Configuration: aule.config_* (SQL editor, owner aule_config)
-- and the public admin_* wrappers (admins only). Public functions let only closed codes out.

-- Requests

-- Moved out of the API: only report_room calls it, with a window computed here.
create function aule.submit_request(
  p_room_id text,
  p_kind public.request_kind,
  p_category public.issue_category,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_lesson_id text
)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  uid uuid := auth.uid();
  now_ts timestamptz := now();
  rome_midnight timestamptz := aule.rome_midnight(aule.rome_day(now()) + 1);
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
     or (p_kind = 'issue' and p_ends_at - p_starts_at > interval '168 hours')
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
revoke all on function aule.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz, text)
  from public, anon, authenticated, service_role;

drop function public.submit_request(text, public.request_kind, public.issue_category, timestamptz, timestamptz, text);
drop function public.get_request(uuid);
drop function public.public_room_overrides(timestamptz, timestamptz);

-- Used only inside definer functions; no policy calls them.
revoke execute on function public.app_user_role(), public.is_staff(), public.is_admin() from authenticated;
grant execute on function public.is_admin() to aule_config;

-- Leftovers of the platform defaults: the service role never touches these tables.
revoke all on table public.room_requests, public.user_roles from service_role;

-- New rows only: windows come from the database with millisecond precision.
alter table public.room_requests add constraint room_requests_ms
  check (aule.ms_exact(starts_at) and aule.ms_exact(ends_at)) not valid;

-- The window of a report made at p_now.
create function aule.report_window(p_now timestamptz, p_room_id text, p_kind public.request_kind, p_lesson_id text)
returns table (starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_start timestamptz;
  v_end timestamptz;
begin
  if p_now is null or p_kind is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_kind = 'room_occupied' then
    v_start := p_now;
    v_end := p_now + interval '1 hour';
  elsif p_kind = 'room_closed' then
    v_start := p_now;
    v_end := least(p_now + interval '12 hours', aule.rome_midnight(aule.rome_day(p_now) + 1));
  elsif p_kind = 'issue' then
    v_start := p_now;
    v_end := p_now + interval '168 hours';
  elsif p_kind = 'lesson_not_held' then
    select u.starts_at, u.ends_at into v_start, v_end
    from aule.unique_lessons u
    where u.id = p_lesson_id and u.status = 'active' and p_room_id = any (u.room_ids)
      and u.starts_at <= p_now + interval '15 minutes' and u.ends_at >= p_now - interval '12 hours'
      and u.ends_at - u.starts_at <= interval '12 hours';
    if not found then
      raise exception 'window' using errcode = 'P0001';
    end if;
  else
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  starts_at := v_start;
  ends_at := v_end;
  return next;
end
$$;
revoke all on function aule.report_window(timestamptz, text, public.request_kind, text) from public, anon, authenticated, service_role;

create function public.report_room(p_room_id text, p_kind public.request_kind, p_category public.issue_category default null,
  p_lesson_id text default null)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now timestamptz;
  v_start timestamptz;
  v_end timestamptz;
begin
  if auth.uid() is null or public.app_user_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_room_id) > 64 or octet_length(p_lesson_id) > 64 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_room_id is null or p_room_id !~ '^[0-9a-f]{24}$' or p_kind is null
     or (p_kind = 'issue') <> (p_category is not null)
     or (p_kind = 'lesson_not_held') <> (p_lesson_id is not null)
     or (p_lesson_id is not null and p_lesson_id !~ '^[0-9a-f]{24}$') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if not exists (select 1 from aule.rooms r where r.id = p_room_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  v_now := aule.from_ms(aule.ms(now()));
  select w.starts_at, w.ends_at into v_start, v_end from aule.report_window(v_now, p_room_id, p_kind, p_lesson_id) w;
  return aule.submit_request(p_room_id, p_kind, p_category, v_start, v_end, p_lesson_id);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.report_room(text, public.request_kind, public.issue_category, text) from public, anon, authenticated, service_role;
grant execute on function public.report_room(text, public.request_kind, public.issue_category, text) to authenticated;

-- A "not held" is approved only while that lesson is in the timetable, in that room, at those times.
create or replace function public.review_request(p_id uuid, p_decision public.request_status)
returns void
language plpgsql
volatile
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
  select q.* into r from public.room_requests q where q.id = p_id for update;
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
  if p_decision = 'approved' and r.kind = 'lesson_not_held' and not exists (
    select 1 from aule.unique_lessons u
    where u.id = r.lesson_id and u.status = 'active' and r.room_id = any (u.room_ids)
      and u.starts_at = r.starts_at and u.ends_at = r.ends_at
  ) then
    raise exception 'no_lesson' using errcode = 'P0001';
  end if;
  update public.room_requests q
    set status = p_decision, reviewed_by = auth.uid(), reviewed_at = now()
    where q.id = p_id;
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.review_request(uuid, public.request_status) from public, anon, authenticated, service_role;
grant execute on function public.review_request(uuid, public.request_status) to authenticated;

-- The caller's last 50 requests with the room labels; "expired" is a pending request whose window is over.
drop function public.my_requests();
create function public.my_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or public.app_user_role() is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object('requests', coalesce((
    select jsonb_agg(x.item order by x.created_at desc, x.id)
    from (
      select q.created_at, q.id, jsonb_build_object(
        'id', q.id, 'roomId', q.room_id, 'kind', q.kind, 'category', q.category,
        'start', aule.ms(q.starts_at), 'end', aule.ms(q.ends_at),
        'status', case when q.status = 'pending' and q.ends_at <= now() then 'expired' else q.status::text end,
        'createdAt', aule.ms(q.created_at),
        'roomName', v.name, 'buildingName', v.building_name, 'buildingKey', v.building_key, 'floor', v.floor) as item
      from public.room_requests q
      left join aule.room_view v on v.id = q.room_id
      where q.created_by = v_uid
      order by q.created_at desc, q.id
      limit 50
    ) x), '[]'::jsonb));
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.my_requests() from public, anon, authenticated, service_role;
grant execute on function public.my_requests() to authenticated;

-- Review queue, most urgent first: no user identity, only how many others agree and the reporter's track record.
drop function public.pending_requests();
create function public.pending_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_staff() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return jsonb_build_object('requests', coalesce((
    select jsonb_agg(x.item order by x.ends_at, x.created_at, x.id)
    from (
      select q.ends_at, q.created_at, q.id, jsonb_build_object(
        'id', q.id, 'roomId', q.room_id, 'kind', q.kind, 'category', q.category, 'lessonId', q.lesson_id,
        'start', aule.ms(q.starts_at), 'end', aule.ms(q.ends_at), 'createdAt', aule.ms(q.created_at),
        'supporters', (
          select count(distinct o.created_by)::integer from public.room_requests o
          where o.room_id = q.room_id and o.kind = q.kind and o.created_by <> q.created_by
            and o.status in ('pending', 'approved') and o.starts_at < q.ends_at and o.ends_at > q.starts_at
            and public.is_valid_user(o.created_by)),
        'reporterApproved', (
          select count(*)::integer from public.room_requests h where h.created_by = q.created_by and h.status = 'approved'),
        'reporterRejected', (
          select count(*)::integer from public.room_requests h where h.created_by = q.created_by and h.status = 'rejected'),
        'roomName', v.name, 'buildingName', v.building_name, 'buildingKey', v.building_key, 'floor', v.floor,
        'lessonTitle', (select u.title from aule.unique_lessons u where u.id = q.lesson_id)) as item
      from public.room_requests q
      left join aule.room_view v on v.id = q.room_id
      where q.status = 'pending' and q.ends_at > now() and public.is_valid_user(q.created_by)
      order by q.ends_at, q.created_at, q.id
      limit 200
    ) x), '[]'::jsonb));
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.pending_requests() from public, anon, authenticated, service_role;
grant execute on function public.pending_requests() to authenticated;

-- Configuration. aule.config_* run as the caller: postgres from the SQL editor, aule_config from the admin_* wrappers.
-- Limits: calendars 600, sources 60, rooms 3000, buildings 300, links 300.

create function aule.current_uid()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid()
$$;
revoke all on function aule.current_uid() from public, anon, authenticated, service_role;
grant execute on function aule.current_uid() to aule_config;

-- Calendars keep no author (least data): p_by keeps the signature of the other writers.
create function aule.config_add_calendar(p_id text, p_label text, p_by uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_id is null or octet_length(p_id) <> 24 then
    raise exception 'calendar_ref' using errcode = 'P0001';
  end if;
  if p_id !~ '^[0-9a-f]{24}$' or starts_with(p_id, 'fff') then
    raise exception 'calendar_ref' using errcode = 'P0001';
  end if;
  if p_label is null or char_length(p_label) > 160 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  if not aule.plain(p_label, 1, 160) then
    raise exception 'label' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if exists (select 1 from aule.calendars c where c.id = p_id) then
    raise exception 'calendar_exists' using errcode = 'P0001';
  end if;
  if (select count(*) from aule.calendars) >= 600 then
    raise exception 'too_many_calendars' using errcode = 'P0001';
  end if;
  insert into aule.calendars (id, source, ref, label, active) values (p_id, 'planner', null, p_label, true);
end
$$;
revoke all on function aule.config_add_calendar(text, text, uuid) from public, anon, authenticated, service_role;

-- xlsx and dimes feeds come only from their generated migrations: the adapters serve only config/diam.json and config/dimes.json.
create function aule.config_add_feed(p_source text, p_ref text, p_label text, p_by uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_id text;
begin
  if p_source is null or octet_length(p_source) > 16 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_source not in ('portal', 'pdf') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_ref is null or char_length(p_ref) > 500 then
    raise exception 'feed_ref' using errcode = 'P0001';
  end if;
  if (p_source = 'portal' and p_ref !~ '^[A-Z0-9]{2,12}$') or (p_source <> 'portal' and not aule.source_url_ok(p_ref)) then
    raise exception 'feed_ref' using errcode = 'P0001';
  end if;
  if p_label is null or char_length(p_label) > 160 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  if not aule.plain(p_label, 1, 160) then
    raise exception 'label' using errcode = 'P0001';
  end if;
  v_id := aule.synthetic_id('fffd', p_source || '|' || p_ref);
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if exists (select 1 from aule.calendars c where c.id = v_id) then
    raise exception 'calendar_exists' using errcode = 'P0001';
  end if;
  if (select count(*) from aule.calendars) >= 600 then
    raise exception 'too_many_calendars' using errcode = 'P0001';
  end if;
  insert into aule.calendars (id, source, ref, label, active) values (v_id, p_source::aule.feed_source, p_ref, p_label, true);
end
$$;
revoke all on function aule.config_add_feed(text, text, text, uuid) from public, anon, authenticated, service_role;

-- Replaces discover --relabel.
create function aule.config_rename_calendar(p_id text, p_label text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_id is null or octet_length(p_id) <> 24 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_id !~ '^[0-9a-f]{24}$' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_label is null or char_length(p_label) > 160 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  if not aule.plain(p_label, 1, 160) then
    raise exception 'label' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  update aule.calendars c set label = p_label where c.id = p_id;
  if not found then
    raise exception 'calendar_missing' using errcode = 'P0001';
  end if;
end
$$;
revoke all on function aule.config_rename_calendar(text, text) from public, anon, authenticated, service_role;

-- The data of a deactivated calendar stays until the next sync_finish.
create function aule.config_set_calendar_active(p_id text, p_active boolean)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_id is null or octet_length(p_id) <> 24 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_id !~ '^[0-9a-f]{24}$' or p_active is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  update aule.calendars c set active = p_active where c.id = p_id;
  if not found then
    raise exception 'calendar_missing' using errcode = 'P0001';
  end if;
end
$$;
revoke all on function aule.config_set_calendar_active(text, boolean) from public, anon, authenticated, service_role;

-- Removal is immediate: its data and runs go with the calendar, then orphan rooms and the derived tables.
-- xlsx feeds come only from their generated migration: they can be deactivated, never removed.
create function aule.config_remove_calendar(p_id text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_id is null or octet_length(p_id) <> 24 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_id !~ '^[0-9a-f]{24}$' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if exists (select 1 from aule.calendars c where c.id = p_id and c.source = 'xlsx') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  delete from aule.calendars c where c.id = p_id;
  if not found then
    raise exception 'calendar_missing' using errcode = 'P0001';
  end if;
  delete from aule.rooms r where not exists (select 1 from aule.lessons l where r.id = any (l.room_ids));
  perform aule.refresh_timetable();
end
$$;
revoke all on function aule.config_remove_calendar(text) from public, anon, authenticated, service_role;

-- Only canonical URLs (the browser normalizes them); duplicates keep their first position.
create function aule.config_set_sources(p_urls text[])
returns void
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_urls text[] := '{}';
  v_url text;
begin
  if p_urls is null or coalesce(array_ndims(p_urls), 1) <> 1 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if cardinality(p_urls) > 60 then
    raise exception 'too_many_sources' using errcode = 'P0001';
  end if;
  if array_position(p_urls, null) is not null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  foreach v_url in array p_urls loop
    if char_length(v_url) > 500 then
      raise exception 'source_url' using errcode = 'P0001';
    end if;
    if not aule.source_url_ok(v_url) then
      raise exception 'source_url' using errcode = 'P0001';
    end if;
    if not v_url = any (v_urls) then
      v_urls := v_urls || v_url;
    end if;
  end loop;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  delete from aule.sources where true;
  insert into aule.sources (position, url)
  select u.ord, u.url from unnest(v_urls) with ordinality as u(url, ord);
end
$$;
revoke all on function aule.config_set_sources(text[]) from public, anon, authenticated, service_role;

-- A null floor clears the admin value, so the seed (or nothing) applies again.
create function aule.config_set_room_floor(p_room_id text, p_floor integer, p_by uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_room_id is null or octet_length(p_room_id) <> 24 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_room_id !~ '^[0-9a-f]{24}$' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_floor is not null and (p_floor < -2 or p_floor > 12) then
    raise exception 'floor' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if not exists (select 1 from aule.rooms r where r.id = p_room_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_floor is null then
    delete from aule.room_floors f where f.room_id = p_room_id;
    return;
  end if;
  if not exists (select 1 from aule.room_floors f where f.room_id = p_room_id)
     and (select count(*) from aule.room_floors) >= 3000 then
    raise exception 'too_many_rooms' using errcode = 'P0001';
  end if;
  insert into aule.room_floors (room_id, floor, updated_at, updated_by) values (p_room_id, p_floor, now(), p_by)
  on conflict (room_id) do update set floor = excluded.floor, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end
$$;
revoke all on function aule.config_set_room_floor(text, integer, uuid) from public, anon, authenticated, service_role;

create function aule.config_set_building_shape(p_key text, p_floors integer, p_base_level integer, p_by uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_key is null or octet_length(p_key) > 80 then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  if p_key !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  if p_floors is null or p_floors < 1 or p_floors > 15 then
    raise exception 'floor_count' using errcode = 'P0001';
  end if;
  if p_base_level is null or p_base_level < 0 or p_base_level > 12 then
    raise exception 'base_level' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if not exists (select 1 from aule.campus_buildings b where b.key = p_key) then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  if not exists (select 1 from aule.building_shapes s where s.key = p_key)
     and (select count(*) from aule.building_shapes) >= 300 then
    raise exception 'too_many_buildings' using errcode = 'P0001';
  end if;
  insert into aule.building_shapes (key, floors, base_level, updated_at, updated_by)
  values (p_key, p_floors, p_base_level, now(), p_by)
  on conflict (key) do update set floors = excluded.floors, base_level = excluded.base_level,
    updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end
$$;
revoke all on function aule.config_set_building_shape(text, integer, integer, uuid) from public, anon, authenticated, service_role;

-- A Planner building name onto a campus key; a null key removes the link.
create function aule.config_link_building(p_name text, p_key text, p_by uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_name is null or char_length(p_name) > 160 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  if not aule.plain(p_name, 1, 160) then
    raise exception 'label' using errcode = 'P0001';
  end if;
  if char_length(p_name) > 100 then
    raise exception 'building_name' using errcode = 'P0001';
  end if;
  if p_key is not null and octet_length(p_key) > 80 then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  if p_key is not null and p_key !~ '^[a-z0-9-]{1,80}$' then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if p_key is null then
    delete from aule.building_links bl where bl.planner_name = p_name;
    return;
  end if;
  if not exists (select 1 from aule.campus_buildings b where b.key = p_key) then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  if not exists (select 1 from aule.building_links bl where bl.planner_name = p_name)
     and (select count(*) from aule.building_links) >= 300 then
    raise exception 'too_many_links' using errcode = 'P0001';
  end if;
  insert into aule.building_links (planner_name, campus_key, updated_at, updated_by) values (p_name, p_key, now(), p_by)
  on conflict (planner_name) do update set campus_key = excluded.campus_key, updated_at = excluded.updated_at,
    updated_by = excluded.updated_by;
end
$$;
revoke all on function aule.config_link_building(text, text, uuid) from public, anon, authenticated, service_role;

-- The flag read by public.sync_requests(): at most one request per cooldown for everybody, only the last requester kept.
create function aule.config_request_run(p_kind text, p_by uuid)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_at timestamptz;
begin
  if p_kind is null or p_kind not in ('sync', 'discover') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  update aule.run_requests q
    set pending = true, requested_at = now(), requested_by = p_by
    where q.kind = p_kind::aule.run_kind
      and (q.requested_at is null or q.requested_at <= now() - (select s.request_cooldown from aule.settings s))
    returning q.requested_at into v_at;
  if not found then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  return jsonb_build_object('requestedAt', aule.ms(v_at));
end
$$;
revoke all on function aule.config_request_run(text, uuid) from public, anon, authenticated, service_role;

-- Everything the admin page shows. Users and requesters stay out: only times and counts.
create function aule.config_overview()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_now timestamptz := now();
  v_late_after interval;
  v_good timestamptz;
  v_out jsonb;
begin
  select s.late_after into v_late_after from aule.settings s;
  select sr.finished_at into v_good
  from aule.sync_runs sr
  where sr.state = 'finished' and sr.ok > 0
  order by sr.finished_at desc, sr.id desc
  limit 1;

  select jsonb_build_object(
    'now', aule.ms(v_now),
    'sync', jsonb_build_object(
      'running', exists (select 1 from aule.sync_runs sr where sr.state = 'open'),
      'lastRun', (
        select jsonb_build_object('id', sr.id, 'trigger', sr.trigger, 'state', sr.state, 'startedAt', aule.ms(sr.started_at),
          'finishedAt', aule.ms(sr.finished_at), 'outcome', case when sr.state = 'finished' then 'completed' else 'failed' end,
          'failure', sr.failure, 'ok', sr.ok, 'failed', sr.failed)
        from aule.sync_runs sr
        where sr.state <> 'open'
        order by sr.id desc
        limit 1),
      'lastGoodAt', aule.ms(v_good),
      'late', v_good is null or v_good < v_now - v_late_after,
      'requested', jsonb_build_object(
        'sync', coalesce((
          select jsonb_build_object('pending', q.pending, 'at', case when q.pending then aule.ms(q.requested_at) end)
          from aule.run_requests q where q.kind = 'sync'), '{"pending": false, "at": null}'::jsonb),
        'discover', coalesce((
          select jsonb_build_object('pending', q.pending, 'at', case when q.pending then aule.ms(q.requested_at) end)
          from aule.run_requests q where q.kind = 'discover'), '{"pending": false, "at": null}'::jsonb))),
    'calendars', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', c.id, 'source', c.source, 'ref', c.ref, 'label', c.label, 'active', c.active, 'addedAt', aule.ms(c.added_at),
          'run', case when cr.calendar_id is null then null::jsonb
            else jsonb_build_object('at', aule.ms(cr.at), 'outcome', cr.outcome, 'failure', cr.failure, 'lessons', cr.lessons) end,
          'fetchedAt', aule.ms(d.fetched_at))
        order by aule.source_rank(c.source), c.added_at, c.id::text collate "C")
      from aule.calendars c
      left join aule.calendar_runs cr on cr.calendar_id = c.id
      left join aule.calendar_data d on d.calendar_id = c.id), '[]'::jsonb),
    'sources', coalesce((select jsonb_agg(s.url order by s.position) from aule.sources s), '[]'::jsonb),
    'proposals', jsonb_build_object(
      'startedAt', (select aule.ms(ds.started_at) from aule.discover_state ds),
      'at', (select aule.ms(ds.finished_at) from aule.discover_state ds),
      'found', coalesce((select ds.found from aule.discover_state ds), 0),
      'failures', coalesce((
        select jsonb_agg(jsonb_build_object('source', f.source, 'failure', f.failure) order by f.position)
        from aule.discover_failures f), '[]'::jsonb),
      'items', coalesce((
        select jsonb_agg(jsonb_build_object('id', p.calendar_id, 'label', p.label, 'source', p.source)
          order by p.label::text collate aule."it_num", p.calendar_id::text collate "C")
        from aule.proposals p
        where not exists (select 1 from aule.calendars c where c.id = p.calendar_id)), '[]'::jsonb)),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'buildingName', v.building_name,
          'buildingKey', v.building_key, 'floor', v.floor, 'floorSource', v.floor_source, 'capacity', v.capacity)
        order by v.name collate aule."it_num", v.id::text collate "C")
      from aule.room_view v), '[]'::jsonb),
    'unmatchedBuildings', coalesce((
      select jsonb_agg(u.n order by u.n collate "C")
      from (select distinct v.building_name as n from aule.room_view v where v.building_key is null and v.building_name <> '') u),
      '[]'::jsonb),
    'buildingLinks', coalesce((select jsonb_object_agg(bl.planner_name, bl.campus_key) from aule.building_links bl), '{}'::jsonb),
    'shapes', coalesce((
      select jsonb_object_agg(bs.key, jsonb_build_object('floors', bs.floors, 'baseLevel', bs.base_level))
      from aule.building_shapes bs), '{}'::jsonb),
    'campus', coalesce((
      select jsonb_agg(jsonb_build_object('key', cb.key, 'name', cb.name)
        order by cb.name collate aule."it_num", cb.key::text collate "C")
      from aule.campus_buildings cb), '[]'::jsonb)
  ) into v_out;
  return v_out;
end
$$;
revoke all on function aule.config_overview() from public, anon, authenticated, service_role;

-- Admin API: admins only, sizes first, then the configuration function as aule_config.

create function public.admin_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return aule.config_overview();
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_overview() from public, anon, authenticated, service_role;
grant execute on function public.admin_overview() to authenticated;

create function public.admin_add_calendar(p_id text, p_label text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_id) > 64 then
    raise exception 'calendar_ref' using errcode = 'P0001';
  end if;
  if octet_length(p_label) > 640 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  perform aule.config_add_calendar(p_id, p_label, aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_add_calendar(text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_add_calendar(text, text) to authenticated;

create function public.admin_add_feed(p_source text, p_ref text, p_label text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_source) > 16 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if octet_length(p_ref) > 2000 then
    raise exception 'feed_ref' using errcode = 'P0001';
  end if;
  if octet_length(p_label) > 640 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  perform aule.config_add_feed(p_source, p_ref, p_label, aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_add_feed(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_add_feed(text, text, text) to authenticated;

create function public.admin_set_calendar_active(p_id text, p_active boolean)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_id) > 64 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform aule.config_set_calendar_active(p_id, p_active);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_set_calendar_active(text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_calendar_active(text, boolean) to authenticated;

create function public.admin_remove_calendar(p_id text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_id) > 64 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform aule.config_remove_calendar(p_id);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_remove_calendar(text) from public, anon, authenticated, service_role;
grant execute on function public.admin_remove_calendar(text) to authenticated;

create function public.admin_set_sources(p_urls text[])
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_urls is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if cardinality(p_urls) > 60 then
    raise exception 'too_many_sources' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_urls) as u(v) where octet_length(u.v) > 2000) then
    raise exception 'source_url' using errcode = 'P0001';
  end if;
  perform aule.config_set_sources(p_urls);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_set_sources(text[]) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_sources(text[]) to authenticated;

create function public.admin_set_room_floor(p_room_id text, p_floor integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_room_id) > 64 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform aule.config_set_room_floor(p_room_id, p_floor, aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_set_room_floor(text, integer) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_room_floor(text, integer) to authenticated;

create function public.admin_set_building_shape(p_key text, p_floors integer, p_base_level integer)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_key) > 80 then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  perform aule.config_set_building_shape(p_key, p_floors, p_base_level, aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_set_building_shape(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_building_shape(text, integer, integer) to authenticated;

create function public.admin_link_building(p_name text, p_key text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if octet_length(p_name) > 640 then
    raise exception 'label' using errcode = 'P0001';
  end if;
  if octet_length(p_key) > 80 then
    raise exception 'unknown_building' using errcode = 'P0001';
  end if;
  perform aule.config_link_building(p_name, p_key, aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_link_building(text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_link_building(text, text) to authenticated;

create function public.admin_request_sync()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return aule.config_request_run('sync', aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_request_sync() from public, anon, authenticated, service_role;
grant execute on function public.admin_request_sync() to authenticated;

create function public.admin_request_discover()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return aule.config_request_run('discover', aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_request_discover() from public, anon, authenticated, service_role;
grant execute on function public.admin_request_discover() to authenticated;

-- Hand the configuration and admin functions to the NOLOGIN aule_config. Grants made above move with the ownership.
grant create on schema aule to aule_config;
alter function aule.config_add_calendar(text, text, uuid) owner to aule_config;
alter function aule.config_add_feed(text, text, text, uuid) owner to aule_config;
alter function aule.config_rename_calendar(text, text) owner to aule_config;
alter function aule.config_set_calendar_active(text, boolean) owner to aule_config;
alter function aule.config_remove_calendar(text) owner to aule_config;
alter function aule.config_set_sources(text[]) owner to aule_config;
alter function aule.config_set_room_floor(text, integer, uuid) owner to aule_config;
alter function aule.config_set_building_shape(text, integer, integer, uuid) owner to aule_config;
alter function aule.config_link_building(text, text, uuid) owner to aule_config;
alter function aule.config_request_run(text, uuid) owner to aule_config;
alter function aule.config_overview() owner to aule_config;
revoke create on schema aule from aule_config;

grant create on schema public to aule_config;
alter function public.admin_overview() owner to aule_config;
alter function public.admin_add_calendar(text, text) owner to aule_config;
alter function public.admin_add_feed(text, text, text) owner to aule_config;
alter function public.admin_set_calendar_active(text, boolean) owner to aule_config;
alter function public.admin_remove_calendar(text) owner to aule_config;
alter function public.admin_set_sources(text[]) owner to aule_config;
alter function public.admin_set_room_floor(text, integer) owner to aule_config;
alter function public.admin_set_building_shape(text, integer, integer) owner to aule_config;
alter function public.admin_link_building(text, text) owner to aule_config;
alter function public.admin_request_sync() owner to aule_config;
alter function public.admin_request_discover() owner to aule_config;
revoke create on schema public from aule_config;

-- postgres runs aule.config_* from the SQL editor; only the new owner can grant it.
set role aule_config;
grant execute on function
  aule.config_add_calendar(text, text, uuid),
  aule.config_add_feed(text, text, text, uuid),
  aule.config_rename_calendar(text, text),
  aule.config_set_calendar_active(text, boolean),
  aule.config_remove_calendar(text),
  aule.config_set_sources(text[]),
  aule.config_set_room_floor(text, integer, uuid),
  aule.config_set_building_shape(text, integer, integer, uuid),
  aule.config_link_building(text, text, uuid),
  aule.config_request_run(text, uuid),
  aule.config_overview()
to postgres;
reset role;
