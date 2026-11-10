-- Read API: room status, room lessons, search and the request flags, computed in SQL.
-- Owner aule_reader (SELECT only). anon reaches only the four public wrappers.

grant execute on function public.is_valid_user(uuid), public.crowd_threshold() to aule_reader;

-- Approved reports in the window a room page can show, plus "occupied" reports that enough valid users agree on.
create function aule.active_overrides(p_now timestamptz)
returns table (
  room_id text,
  kind public.request_kind,
  category public.issue_category,
  lesson_id text,
  starts_at timestamptz,
  ends_at timestamptz,
  source text
)
language sql
stable
set search_path = ''
as $$
  select r.room_id, r.kind, r.category, r.lesson_id, r.starts_at, r.ends_at, 'approved'::text
  from public.room_requests r
  where r.status = 'approved' and r.starts_at < p_now + interval '192 hours' and r.ends_at > p_now - interval '528 hours'
  union all
  select c.room_id, 'room_occupied'::public.request_kind, null::public.issue_category, null::text,
    min(c.starts_at), max(c.ends_at), 'crowd'::text
  from public.room_requests c
  where c.status = 'pending' and c.kind = 'room_occupied' and c.starts_at <= p_now and c.ends_at > p_now
    and public.is_valid_user(c.created_by)
  group by c.room_id
  having count(distinct c.created_by) >= public.crowd_threshold()
$$;
revoke all on function aule.active_overrides(timestamptz) from public, anon, authenticated, service_role;

-- The only place that builds a room object. Unknown state wins over any report: stale data is never free.
create function aule.room_rows_at(p_now timestamptz, p_room_id text)
returns table (
  id text,
  name text,
  building_key text,
  floor integer,
  state text,
  until bigint,
  capacity integer,
  obj jsonb
)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_stale_after interval;
begin
  if p_now is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  select s.stale_after into v_stale_after from aule.settings s;

  return query
  with o as materialized (
    select a.room_id, a.kind, a.category, a.lesson_id, a.starts_at, a.ends_at, a.source
    from aule.active_overrides(p_now) a
  ),
  fresh_cal as materialized (
    select d.calendar_id
    from aule.calendar_data d
    where not coalesce(p_now - d.fetched_at > v_stale_after or p_now < d.window_from or p_now >= d.window_to, true)
  ),
  per as (
    select v.id::text as rid, v.name as rname, v.code, v.building_name, v.building_key as bkey, v.floor as rfloor,
      v.capacity as cap, v.effective_capacity, v.services, st.room_stale, x.e0, x.min_k, x.later, x.chain_end,
      x.cur_obj, x.next_obj, iss.issues
    from aule.room_view v
    -- Grey without lessons, or when any calendar holding one of its lessons is stale or has no data.
    cross join lateral (
      select not exists (select 1 from aule.lesson_rooms l where l.room_id = v.id)
        or exists (
          select 1 from aule.room_calendars rc
          where rc.room_id = v.id and not exists (select 1 from fresh_cal fc where fc.calendar_id = rc.calendar_id)
        ) as room_stale
    ) st
    cross join lateral (
      -- Blocks still running or ahead: k 0 lesson, 1 closed, 2 occupied (approved), 3 crowd.
      with b as (
        select l.starts_at as s, l.ends_at as e, l.title as t, 0 as k, l.lesson_id::text as lid
        from aule.lesson_rooms l
        where l.room_id = v.id and l.status = 'active' and l.ends_at > p_now
          and not exists (
            select 1 from o n
            where n.room_id = l.room_id and n.kind = 'lesson_not_held' and n.source = 'approved'
              and n.lesson_id = l.lesson_id and n.starts_at = l.starts_at and n.ends_at = l.ends_at
          )
        union all
        select n.starts_at, n.ends_at,
          case when n.kind = 'room_closed' then 'Aula chiusa' else 'Segnalata occupata' end,
          case when n.kind = 'room_closed' then 1 when n.source = 'approved' then 2 else 3 end,
          null::text
        from o n
        where n.room_id = v.id and n.kind in ('room_closed', 'room_occupied') and n.ends_at > p_now
      ),
      c as (
        select max(b.e) filter (where b.s <= p_now) as e0,
          min(b.k) filter (where b.s <= p_now) as min_k,
          min(b.s) filter (where b.s > p_now) as later
        from b
      ),
      -- Chain: a block starting at most 15 minutes after the reach so far continues the busy time.
      f as (
        select b.s, b.e,
          greatest((select c.e0 from c), max(b.e) over (order by b.s rows between unbounded preceding and 1 preceding)) as reach
        from b
        where b.s > p_now
      ),
      brk as (
        select min(f.s) as s from f where f.s > f.reach + interval '15 minutes'
      )
      select c.e0, c.min_k, c.later,
        (select greatest(c.e0, max(f.e)) from f, brk where brk.s is null or f.s < brk.s) as chain_end,
        (select jsonb_build_object('title', b.t, 'end', aule.ms(b.e))
          from b where b.s <= p_now
          order by (b.k <> 0), b.s, b.k, b.lid collate "C", b.e desc
          limit 1) as cur_obj,
        (select jsonb_build_object('title', b.t, 'start', aule.ms(b.s))
          from b where b.k = 0 and b.s > p_now
          order by b.s, b.lid collate "C"
          limit 1) as next_obj
      from c
    ) x
    cross join lateral (
      select coalesce(
        jsonb_agg(jsonb_build_object('category', i.cat, 'until', aule.ms(i.ends_at)) order by i.ends_at, i.cat collate "C"),
        '[]'::jsonb) as issues
      from (
        select coalesce(n.category::text, 'altro') as cat, n.ends_at
        from o n
        where n.room_id = v.id and n.kind = 'issue' and n.source = 'approved' and n.starts_at <= p_now and p_now < n.ends_at
      ) i
    ) iss
    where p_room_id is null or v.id = p_room_id
  ),
  fin as (
    select p.*,
      case when p.room_stale then 'unknown' when p.e0 is not null then 'busy' else 'free' end as rstate,
      case
        when p.room_stale then null
        when p.e0 is not null then aule.ms(p.chain_end)
        when p.later is not null and aule.rome_day(p.later) = aule.rome_day(p_now) then aule.ms(p.later)
      end as runtil,
      case when p.e0 is null or p.min_k = 0 then null when p.min_k = 1 then 'closed' when p.min_k = 2 then 'occupied' else 'crowd' end
        as report
    from per p
  )
  select f.rid, f.rname, f.bkey, f.rfloor, f.rstate, f.runtil, f.cap,
    jsonb_build_object(
      'id', f.rid,
      'name', f.rname,
      'code', f.code,
      'buildingName', f.building_name,
      'buildingKey', f.bkey,
      'floor', f.rfloor,
      'state', f.rstate,
      'until', f.runtil,
      'current', f.cur_obj,
      'next', f.next_obj,
      'capacity', f.cap,
      'effectiveCapacity', f.effective_capacity,
      'services', to_jsonb(f.services),
      'report', f.report,
      'issues', f.issues
    )
  from fin f
  order by f.rname collate aule."it_num", f.rid collate "C";
end
$$;
revoke all on function aule.room_rows_at(timestamptz, text) from public, anon, authenticated, service_role;

create function aule.room_status_at(p_now timestamptz)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_stale_after interval;
  v_out jsonb;
begin
  if p_now is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  select s.stale_after into v_stale_after from aule.settings s;

  with r as materialized (
    select x.id, x.name, x.building_key, x.floor, x.state, x.obj from aule.room_rows_at(p_now, null) x
  ),
  cnt as (
    select r.building_key, r.floor,
      count(*) filter (where r.state = 'free')::integer as fr,
      count(*) filter (where r.state = 'busy')::integer as bu,
      count(*) filter (where r.state = 'unknown')::integer as un
    from r
    where r.building_key is not null
    group by r.building_key, r.floor
  ),
  bld as (
    select c.building_key,
      jsonb_build_object(
        'floors', coalesce(
          jsonb_object_agg(c.floor::text, jsonb_build_object('free', c.fr, 'busy', c.bu, 'unknown', c.un))
            filter (where c.floor is not null),
          '{}'::jsonb),
        'unplaced', jsonb_build_object(
          'free', coalesce(sum(c.fr) filter (where c.floor is null), 0)::integer,
          'busy', coalesce(sum(c.bu) filter (where c.floor is null), 0)::integer,
          'unknown', coalesce(sum(c.un) filter (where c.floor is null), 0)::integer),
        'total', jsonb_build_object('free', sum(c.fr)::integer, 'busy', sum(c.bu)::integer, 'unknown', sum(c.un)::integer)
      ) as obj
    from cnt c
    group by c.building_key
  )
  select jsonb_build_object(
    'now', aule.ms(p_now),
    'lastRunAt', (
      select aule.ms(sr.finished_at) from aule.sync_runs sr
      where sr.state = 'finished' and sr.ok > 0
      order by sr.finished_at desc, sr.id desc
      limit 1),
    'calendars', (select count(*)::integer from aule.calendar_data),
    'staleCalendars', (
      select count(*)::integer from aule.calendar_data d
      where coalesce(p_now - d.fetched_at > v_stale_after or p_now < d.window_from or p_now >= d.window_to, true)),
    'rooms', coalesce((select jsonb_agg(r.obj order by r.name collate aule."it_num", r.id collate "C") from r), '[]'::jsonb),
    'buildings', coalesce((select jsonb_object_agg(b.building_key, b.obj) from bld b), '{}'::jsonb),
    'shapes', coalesce((
      select jsonb_object_agg(cb.key,
        case when bs.key is null then aule.default_shape(cb.key)
          else jsonb_build_object('floors', bs.floors, 'baseLevel', bs.base_level) end)
      from aule.campus_buildings cb
      left join aule.building_shapes bs on bs.key = cb.key), '{}'::jsonb),
    'unmatchedBuildings', coalesce((
      select jsonb_agg(u.n order by u.n collate "C")
      from (select distinct r.obj ->> 'buildingName' as n from r where r.building_key is null and r.obj ->> 'buildingName' <> '') u),
      '[]'::jsonb),
    'reportsAvailable', true
  ) into v_out;
  return v_out;
end
$$;
revoke all on function aule.room_status_at(timestamptz) from public, anon, authenticated, service_role;

create function aule.room_lessons_at(p_now timestamptz, p_room_id text, p_from date, p_days integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date;
  v_room jsonb;
  v_from timestamptz;
  v_to timestamptz;
  v_lessons jsonb;
begin
  if p_now is null or p_room_id is null or p_from is null or p_days is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if char_length(p_room_id) <> 24 or p_room_id !~ '^[0-9a-f]{24}$' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  begin
    perform p_from::aule.iso_day;
  exception when check_violation then
    raise exception 'invalid' using errcode = 'P0001';
  end;
  v_today := aule.rome_day(p_now);
  if p_from < v_today - 21 or p_from > v_today + 21 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_days < 1 or p_days > 14 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  select x.obj into v_room from aule.room_rows_at(p_now, p_room_id) x;
  if v_room is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  v_from := aule.rome_midnight(p_from);
  v_to := aule.rome_midnight(p_from + p_days);

  with nh as materialized (
    select a.lesson_id, a.starts_at, a.ends_at
    from aule.active_overrides(p_now) a
    where a.room_id = p_room_id and a.kind = 'lesson_not_held' and a.source = 'approved'
  ),
  l as (
    select u.id, u.title, u.starts_at, u.ends_at, u.status, u.kind, u.courses, u.year, u.teachers,
      (u.status = 'active' and exists (
        select 1 from nh where nh.lesson_id = u.id and nh.starts_at = u.starts_at and nh.ends_at = u.ends_at
      )) as not_held
    from aule.unique_lessons u
    where u.room_ids @> array[p_room_id] and u.ends_at > v_from and u.starts_at < v_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', l.id::text,
      'title', l.title,
      'start', aule.ms(l.starts_at),
      'end', aule.ms(l.ends_at),
      'status', case when l.not_held then 'cancelled' else l.status::text end,
      'notHeld', l.not_held,
      'kind', l.kind,
      'courses', to_jsonb(l.courses),
      'year', l.year,
      'teachers', to_jsonb(l.teachers)
    ) order by l.starts_at, l.id collate "C"), '[]'::jsonb)
  into v_lessons
  from l;

  return jsonb_build_object('now', aule.ms(p_now), 'from', aule.ms(v_from), 'to', aule.ms(v_to), 'room', v_room,
    'lessons', v_lessons);
end
$$;
revoke all on function aule.room_lessons_at(timestamptz, text, date, integer) from public, anon, authenticated, service_role;

create function aule.search_at(p_now timestamptz, p_query text, p_free boolean, p_hours integer, p_seats integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_now_ms bigint;
  v_tokens text[];
  v_joined text;
  v_rooms jsonb;
  v_lessons jsonb;
begin
  if p_now is null or p_free is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_query is not null then
    if char_length(p_query) > 60 then
      raise exception 'invalid' using errcode = 'P0001';
    end if;
    begin
      perform p_query::aule.search_text;
    exception when check_violation then
      raise exception 'invalid' using errcode = 'P0001';
    end;
  end if;
  if p_hours is not null and (p_hours < 1 or p_hours > 12) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_seats is not null and (p_seats < 1 or p_seats > 2000) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_query is null and not p_free and p_hours is null and p_seats is null then
    return jsonb_build_object('rooms', '[]'::jsonb, 'lessons', '[]'::jsonb);
  end if;
  v_now_ms := aule.ms(p_now);

  if p_query is null then
    select coalesce(jsonb_agg(h.obj order by h.until is null desc, h.until desc, h.name collate aule."it_num", h.id collate "C"),
      '[]'::jsonb)
    into v_rooms
    from (
      select r.id, r.name, r.until, r.obj
      from aule.room_rows_at(p_now, null) r
      where (not (p_free or p_hours is not null) or r.state = 'free')
        and (p_hours is null or r.until is null or r.until - v_now_ms >= p_hours * 3600000::bigint)
        and (p_seats is null or coalesce(r.capacity, 0) >= p_seats)
      order by r.until is null desc, r.until desc, r.name collate aule."it_num", r.id collate "C"
      limit 50
    ) h;
    return jsonb_build_object('rooms', v_rooms, 'lessons', '[]'::jsonb);
  end if;

  v_tokens := array(
    select t.tok from unnest(string_to_array(p_query, ' ')) with ordinality as t(tok, i)
    where t.tok <> all (array['aula', 'cubo', 'prof', 'prof.', 'professore', 'professoressa', 'docente', 'lezione', 'corso', 'di'])
    order by t.i
  );
  if cardinality(v_tokens) = 0 then
    v_tokens := string_to_array(p_query, ' ');
  end if;
  v_joined := array_to_string(v_tokens, '');

  -- strpos, never LIKE: % and _ are valid query characters.
  select coalesce(jsonb_agg(h.obj order by h.score desc, h.name collate aule."it_num", h.id collate "C"), '[]'::jsonb)
  into v_rooms
  from (
    select r.id, r.name, r.obj,
      case when v.name_compact = v_joined then 3 when starts_with(v.name_compact, v_joined) then 2 else 1 end as score
    from aule.room_rows_at(p_now, null) r
    join aule.room_view v on v.id = r.id
    cross join lateral (
      select v.search_text || case when v.building_key is null then ''
        when starts_with(v.building_key, 'cubo-') then ' ' || substr(v.building_key, 6)
        else ' ' || v.building_key end as hay
    ) hs
    where (not (p_free or p_hours is not null) or r.state = 'free')
      and (p_hours is null or r.until is null or r.until - v_now_ms >= p_hours * 3600000::bigint)
      and (p_seats is null or coalesce(r.capacity, 0) >= p_seats)
      and not exists (
        select 1 from unnest(v_tokens) as t(tok)
        where strpos(hs.hay, t.tok) = 0 and strpos(replace(hs.hay, ' ', ''), t.tok) = 0
      )
    order by score desc, r.name collate aule."it_num", r.id collate "C"
    limit 50
  ) h;

  -- Title or teacher matches (rank 0) come before matches on the degree course only (rank 1). Filters never apply.
  with nh as materialized (
    select a.room_id, a.lesson_id, a.starts_at, a.ends_at
    from aule.active_overrides(p_now) a
    where a.kind = 'lesson_not_held' and a.source = 'approved'
  ),
  m as (
    select u.id, u.title, u.title_text, u.starts_at, u.ends_at, u.teachers, u.room_ids,
      case
        when not exists (
          select 1 from unnest(v_tokens) as t(tok)
          where strpos(u.direct_text, t.tok) = 0 and strpos(replace(u.direct_text, ' ', ''), t.tok) = 0) then 0
        when not exists (
          select 1 from unnest(v_tokens) as t(tok)
          where strpos(u.course_text, t.tok) = 0 and strpos(replace(u.course_text, ' ', ''), t.tok) = 0) then 1
      end as rank
    from aule.unique_lessons u
    where u.status = 'active' and u.ends_at > p_now
  ),
  pairs as (
    select m.id, m.title, m.title_text, m.starts_at, m.ends_at, m.teachers, m.rank, x.room_id,
      v.name as room_name, v.building_name, v.building_key, v.floor
    from m
    cross join lateral unnest(m.room_ids) as x(room_id)
    join aule.room_view v on v.id = x.room_id
    where m.rank is not null
      and not exists (
        select 1 from nh
        where nh.room_id = x.room_id and nh.lesson_id = m.id and nh.starts_at = m.starts_at and nh.ends_at = m.ends_at
      )
  ),
  firsts as (
    select distinct on (p.title_text, p.room_id) p.*
    from pairs p
    order by p.title_text, p.room_id, p.starts_at, p.rank, p.id collate "C"
  ),
  best as (
    select f.* from firsts f
    order by f.rank, f.starts_at, f.id collate "C", f.room_id collate "C"
    limit 20
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'lessonId', t.id::text,
      'title', t.title,
      'start', aule.ms(t.starts_at),
      'end', aule.ms(t.ends_at),
      'teachers', to_jsonb(t.teachers),
      'roomId', t.room_id,
      'roomName', t.room_name,
      'buildingName', t.building_name,
      'buildingKey', t.building_key,
      'floor', t.floor
    ) order by t.rank, t.starts_at, t.id collate "C", t.room_id collate "C"), '[]'::jsonb)
  into v_lessons
  from best t;

  return jsonb_build_object('rooms', v_rooms, 'lessons', v_lessons);
end
$$;
revoke all on function aule.search_at(timestamptz, text, boolean, integer, integer) from public, anon, authenticated, service_role;

-- Port of the scheduler rule: due when a slot of today (Rome wall clock) has passed and no run started since.
create function aule.slot_due(p_now timestamptz)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
declare
  v_latest timestamptz;
begin
  if p_now is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  select max(aule.rome_time(aule.rome_day(p_now), t.slot)) into v_latest
  from aule.settings s
  cross join lateral unnest(s.sync_slots) as t(slot)
  where aule.rome_time(aule.rome_day(p_now), t.slot) <= p_now;
  if v_latest is null then
    return false;
  end if;
  return not exists (select 1 from aule.sync_runs r where r.started_at >= v_latest);
end
$$;
revoke all on function aule.slot_due(timestamptz) from public, anon, authenticated, service_role;

-- Public wrappers: size checks first, then the internal function; only closed codes leave.

create function public.room_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return aule.room_status_at(now());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.room_status() from public, anon, authenticated, service_role;
grant execute on function public.room_status() to anon;

create function public.room_lessons(p_room_id text, p_from date default null, p_days integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_room_id is null or octet_length(p_room_id) > 64 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  return aule.room_lessons_at(now(), p_room_id, coalesce(p_from, aule.rome_day(now())), coalesce(p_days, 1));
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.room_lessons(text, date, integer) from public, anon, authenticated, service_role;
grant execute on function public.room_lessons(text, date, integer) to anon;

create function public.search_rooms(p_query text default null, p_free boolean default false, p_hours integer default null,
  p_seats integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if octet_length(p_query) > 240 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  return aule.search_at(now(), nullif(p_query, ''), coalesce(p_free, false), p_hours, p_seats);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.search_rooms(text, boolean, integer, integer) from public, anon, authenticated, service_role;
grant execute on function public.search_rooms(text, boolean, integer, integer) to anon;

-- Two booleans for the decide job of the sync workflow, nothing else.
create function public.sync_requests()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return jsonb_build_object(
    'sync', coalesce((select q.pending from aule.run_requests q where q.kind = 'sync'), false) or aule.slot_due(now()),
    'discover', coalesce((select q.pending from aule.run_requests q where q.kind = 'discover'), false)
  );
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.sync_requests() from public, anon, authenticated, service_role;
grant execute on function public.sync_requests() to anon;

-- Hand everything to the NOLOGIN reader. Grants made above move with the ownership.
grant create on schema aule to aule_reader;
alter function aule.active_overrides(timestamptz) owner to aule_reader;
alter function aule.room_rows_at(timestamptz, text) owner to aule_reader;
alter function aule.room_status_at(timestamptz) owner to aule_reader;
alter function aule.room_lessons_at(timestamptz, text, date, integer) owner to aule_reader;
alter function aule.search_at(timestamptz, text, boolean, integer, integer) owner to aule_reader;
alter function aule.slot_due(timestamptz) owner to aule_reader;
revoke create on schema aule from aule_reader;

grant create on schema public to aule_reader;
alter function public.room_status() owner to aule_reader;
alter function public.room_lessons(text, date, integer) owner to aule_reader;
alter function public.search_rooms(text, boolean, integer, integer) owner to aule_reader;
alter function public.sync_requests() owner to aule_reader;
revoke create on schema public from aule_reader;
