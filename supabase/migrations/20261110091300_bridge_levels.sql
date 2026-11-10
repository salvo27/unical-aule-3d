-- Rooms on the two bridges: "bridge" next to "floor" in every room object, admins set it like a floor.
-- pdf feeds, like xlsx and dimes ones, come only from their generated migration: admins deactivate them, never add or remove.

-- The admin row holds a floor or a bridge; a bridge room has no floor, not even the seed one.
create or replace view aule.room_view with (security_invoker = true) as
select r.id, r.name, r.code, r.building_name, r.capacity, r.effective_capacity, r.services,
  r.name_compact, r.search_text, k.key as building_key,
  (case when f.room_id is not null then f.floor else s.floor end)::integer as floor,
  case when f.room_id is not null then 'admin' when s.floor is not null then 'seed' end as floor_source,
  f.bridge
from aule.rooms r
cross join lateral (
  select coalesce(
    (select bl.campus_key from aule.building_links bl where bl.planner_name = r.building_name),
    (select cb.key from aule.campus_buildings cb where cb.key = r.building_key_guess)
  )::text as key
) k
left join aule.room_floors f on f.room_id = r.id
left join aule.room_seeds s on s.building_key = k.key and s.room_key = r.room_key;

-- Only the owner replaces a function: the new bodies are created as the NOLOGIN owners, which keeps owner and grants.
grant create on schema aule to aule_reader;
set role aule_reader;

create or replace function aule.room_rows_at(p_now timestamptz, p_room_id text)
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
      v.bridge as rbridge, v.capacity as cap, v.effective_capacity, v.services, st.room_stale, x.e0, x.min_k, x.later,
      x.chain_end, x.cur_obj, x.next_obj, iss.issues
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
      'bridge', f.rbridge,
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

create or replace function aule.room_status_at(p_now timestamptz)
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
  -- A bridge room counts on the slice the map draws it on: 4 coperto, 5 scoperto.
  cnt as (
    select r.building_key,
      coalesce(r.floor, case r.obj ->> 'bridge' when 'coperto' then 4 when 'scoperto' then 5 end) as floor,
      count(*) filter (where r.state = 'free')::integer as fr,
      count(*) filter (where r.state = 'busy')::integer as bu,
      count(*) filter (where r.state = 'unknown')::integer as un
    from r
    where r.building_key is not null
    group by 1, 2
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

create or replace function aule.search_at(p_now timestamptz, p_query text, p_free boolean, p_hours integer, p_seats integer)
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
      v.name as room_name, v.building_name, v.building_key, v.floor, v.bridge
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
      'floor', t.floor,
      'bridge', t.bridge
    ) order by t.rank, t.starts_at, t.id collate "C", t.room_id collate "C"), '[]'::jsonb)
  into v_lessons
  from best t;

  return jsonb_build_object('rooms', v_rooms, 'lessons', v_lessons);
end
$$;

set role postgres;
revoke create on schema aule from aule_reader;

grant create on schema aule to aule_config;
grant create on schema public to aule_config;
set role aule_config;

-- A number replaces the bridge. A null floor clears the admin value, floor or bridge, so the seed (or nothing) applies again.
create or replace function aule.config_set_room_floor(p_room_id text, p_floor integer, p_by uuid)
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
  insert into aule.room_floors (room_id, floor, bridge, updated_at, updated_by) values (p_room_id, p_floor, null, now(), p_by)
  on conflict (room_id) do update
    set floor = excluded.floor, bridge = null, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end
$$;

-- A bridge replaces the floor number. A null bridge clears the admin value, floor or bridge, as a null floor does.
create function aule.config_set_room_bridge(p_room_id text, p_bridge text, p_by uuid)
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
  if p_bridge is not null and octet_length(p_bridge) > 8 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_bridge is not null and p_bridge not in ('coperto', 'scoperto') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if not exists (select 1 from aule.rooms r where r.id = p_room_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_bridge is null then
    delete from aule.room_floors f where f.room_id = p_room_id;
    return;
  end if;
  if not exists (select 1 from aule.room_floors f where f.room_id = p_room_id)
     and (select count(*) from aule.room_floors) >= 3000 then
    raise exception 'too_many_rooms' using errcode = 'P0001';
  end if;
  insert into aule.room_floors (room_id, floor, bridge, updated_at, updated_by) values (p_room_id, null, p_bridge, now(), p_by)
  on conflict (room_id) do update
    set floor = null, bridge = excluded.bridge, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
end
$$;
revoke all on function aule.config_set_room_bridge(text, text, uuid) from public, anon, authenticated, service_role;
grant execute on function aule.config_set_room_bridge(text, text, uuid) to postgres;

-- Only portal feeds enter here; xlsx, dimes and pdf feeds come only from their generated migrations.
create or replace function aule.config_add_feed(p_source text, p_ref text, p_label text, p_by uuid)
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
  if p_source <> 'portal' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_ref is null or char_length(p_ref) > 500 then
    raise exception 'feed_ref' using errcode = 'P0001';
  end if;
  if p_ref !~ '^[A-Z0-9]{2,12}$' then
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

-- Removal is immediate: its data, runs and room links go with the calendar, then orphan rooms and the derived tables.
-- Feeds an admin cannot add (xlsx, dimes, pdf) come only from generated migrations: deactivate them instead.
create or replace function aule.config_remove_calendar(p_id text)
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
  if exists (select 1 from aule.calendars c where c.id = p_id and c.source in ('xlsx', 'dimes', 'pdf')) then
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

create or replace function aule.config_overview()
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
          'buildingKey', v.building_key, 'floor', v.floor, 'bridge', v.bridge, 'floorSource', v.floor_source,
          'capacity', v.capacity)
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

create function public.admin_set_room_bridge(p_room_id text, p_bridge text)
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
  if octet_length(p_room_id) > 64 or octet_length(p_bridge) > 64 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform aule.config_set_room_bridge(p_room_id, p_bridge, aule.current_uid());
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.admin_set_room_bridge(text, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_room_bridge(text, text) to authenticated;

set role postgres;
revoke create on schema public from aule_config;
revoke create on schema aule from aule_config;
