-- Course timetables for the weeks ahead. The run window reaches 45 days ahead instead of 15: the sources that hold a
-- weekly plan already repeat it up to the end of the semester, and the window was the only thing cutting it short.
-- Measured on the PDF feeds before the change: at most 471 lessons per feed at 45 days, against a cap of 5000.
alter table aule.settings alter column window_ahead_days set default 45;
update aule.settings set window_ahead_days = 45 where window_ahead_days < 45;

-- The timetable of a course can now start up to 60 days ahead, the most the run window may be set to.
-- Days past the window simply hold no lessons. Room lessons keep their 21 days: the map never looks further.
-- Replaced as its NOLOGIN owner, like when it was created.
grant create on schema aule to aule_reader;
set role aule_reader;

create or replace function aule.course_timetable_at(p_now timestamptz, p_keys text[], p_from date, p_days integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today date;
  v_stale_after interval;
  v_from timestamptz;
  v_to timestamptz;
  v_missing text[];
  v_stale boolean;
  v_lessons jsonb;
begin
  if p_now is null or p_keys is null or p_from is null or p_days is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if coalesce(array_ndims(p_keys), 0) <> 1 or cardinality(p_keys) > 12 or array_position(p_keys, null) is not null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if exists (select 1 from unnest(p_keys) as k(v) where char_length(k.v) <> 32 or k.v !~ '^[0-9a-f]{32}$') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if (select count(distinct k.v) from unnest(p_keys) as k(v)) <> cardinality(p_keys) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  begin
    perform p_from::aule.iso_day;
  exception when check_violation then
    raise exception 'invalid' using errcode = 'P0001';
  end;
  v_today := aule.rome_day(p_now);
  if p_from < v_today - 21 or p_from > v_today + 60 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_days < 1 or p_days > 14 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  select s.stale_after into v_stale_after from aule.settings s;
  v_from := aule.rome_midnight(p_from);
  v_to := aule.rome_midnight(p_from + p_days);

  with nh as materialized (
    select a.room_id, a.lesson_id, a.starts_at, a.ends_at
    from aule.active_overrides(p_now) a
    where a.kind = 'lesson_not_held' and a.source = 'approved'
  ),
  -- Same rule as aule.room_rows_at.
  fresh_cal as materialized (
    select d.calendar_id
    from aule.calendar_data d
    where not coalesce(p_now - d.fetched_at > v_stale_after or p_now < d.window_from or p_now >= d.window_to, true)
  ),
  grp as (
    select distinct u.title_text, d.degree
    from aule.unique_lessons u
    cross join lateral (
      select c.label as degree from unnest(u.courses) as c(label)
      union all
      select '' where cardinality(u.courses) = 0
    ) d
    where aule.is_course(u.title_text, u.courses)
  ),
  want as materialized (
    select g.title_text, g.degree, k.key
    from grp g
    cross join lateral (select aule.course_key(g.title_text, g.degree) as key) k
    where k.key = any (p_keys)
  ),
  -- Every lesson of the requested courses, on any day: freshness looks at all of them.
  mine as materialized (
    select u.id, u.title, u.starts_at, u.ends_at, u.status, u.room_ids, u.calendar_ids, w.key
    from want w
    join aule.unique_lessons u on u.title_text = w.title_text
      and (w.degree = any (u.courses) or (w.degree = '' and cardinality(u.courses) = 0))
      and aule.is_course(u.title_text, u.courses)
  ),
  miss as materialized (
    select k.v as key from unnest(p_keys) as k(v) where not exists (select 1 from want w where w.key = k.v)
  ),
  -- A missing course may belong to any calendar: then every calendar must be fresh, and at least one must exist.
  st as (
    select exists (
        select 1 from mine m cross join lateral unnest(m.calendar_ids) as c(id)
        where not exists (select 1 from fresh_cal f where f.calendar_id = c.id)
      )
      or (exists (select 1 from miss) and (
        not exists (select 1 from fresh_cal)
        or exists (
          select 1 from aule.calendar_data d where not exists (select 1 from fresh_cal f where f.calendar_id = d.calendar_id))
      )) as stale
  ),
  -- One more than the cap, to tell a full answer from one that would be cut.
  win as (
    select m.key, m.id, m.title, m.starts_at, m.ends_at, m.room_ids,
      (m.status = 'cancelled' or not exists (
        select 1 from unnest(m.room_ids) as x(room_id)
        where not exists (
          select 1 from nh
          where nh.room_id = x.room_id and nh.lesson_id = m.id and nh.starts_at = m.starts_at and nh.ends_at = m.ends_at
        )
      )) as cancelled
    from mine m
    where m.ends_at > v_from and m.starts_at < v_to
    order by m.starts_at, m.id collate "C", m.key collate "C"
    limit 601
  )
  select
    coalesce((select array_agg(i.key order by i.key collate "C") from miss i), '{}'),
    coalesce((select s.stale from st s), true),
    coalesce((
      select jsonb_agg(jsonb_build_object(
          'key', w.key,
          'id', w.id::text,
          'title', w.title,
          'start', aule.ms(w.starts_at),
          'end', aule.ms(w.ends_at),
          'status', case when w.cancelled then 'cancelled' else 'active' end,
          'rooms', rm.rooms
        ) order by w.starts_at, w.id collate "C", w.key collate "C")
      from win w
      cross join lateral (
        select coalesce(jsonb_agg(jsonb_build_object(
            'id', v.id::text,
            'name', v.name,
            'buildingName', nullif(v.building_name, ''),
            'floor', v.floor
          ) order by x.i), '[]'::jsonb) as rooms
        from (
          select r.room_id, min(r.i) as i from unnest(w.room_ids) with ordinality as r(room_id, i) group by r.room_id
        ) x
        join aule.room_view v on v.id = x.room_id
      ) rm), '[]'::jsonb)
  into v_missing, v_stale, v_lessons;

  if jsonb_array_length(v_lessons) > 600 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  return jsonb_build_object('now', aule.ms(p_now), 'from', aule.ms(v_from), 'to', aule.ms(v_to), 'stale', v_stale,
    'missing', to_jsonb(v_missing), 'lessons', v_lessons);
end
$$;
revoke all on function aule.course_timetable_at(timestamptz, text[], date, integer) from public, anon, authenticated, service_role;

set role postgres;
revoke create on schema aule from aule_reader;
