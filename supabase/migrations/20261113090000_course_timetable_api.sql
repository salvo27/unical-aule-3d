-- Course timetable API for other clients: course search and the lessons of chosen courses.
-- A course is the pair (title_text, degree course label). A lesson with two labels belongs to both pairs,
-- a lesson without labels to (title_text, ''). Teacher names never leave, not even as an empty field.
-- Owner aule_reader (SELECT only). anon reaches only the two public wrappers.

-- The functions are created as their NOLOGIN owner, so the default EXECUTE of PUBLIC is revoked one by one.
grant create on schema aule to aule_reader;
grant create on schema public to aule_reader;
set role aule_reader;

-- The only place that builds a course key. chr(31) is in neither part: aule.plain refuses control characters.
create function aule.course_key(p_title_text text, p_degree text)
returns text
language sql
immutable
set search_path = ''
as $$
  select md5(p_title_text || chr(31) || p_degree)
$$;
revoke all on function aule.course_key(text, text) from public, anon, authenticated, service_role;

-- Exams, bookings and other commitments are stored under three fixed titles without a degree course: they are not courses.
create function aule.is_course(p_title_text text, p_courses text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select not (cardinality(p_courses) = 0 and p_title_text in ('esame', 'prenotazione', 'altro impegno'))
$$;
revoke all on function aule.is_course(text, text[]) from public, anon, authenticated, service_role;

-- Courses whose title holds every token of the query (rank 0) come before those that need the degree label too (rank 1).
create function aule.courses_at(p_now timestamptz, p_query text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tokens text[];
  v_courses jsonb;
begin
  if p_now is null or p_query is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if char_length(p_query) > 60 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  begin
    perform p_query::aule.search_text;
  exception when check_violation then
    raise exception 'invalid' using errcode = 'P0001';
  end;
  v_tokens := string_to_array(p_query, ' ');

  -- strpos, never LIKE: % and _ are valid query characters.
  with nh as materialized (
    select a.room_id, a.lesson_id, a.starts_at, a.ends_at
    from aule.active_overrides(p_now) a
    where a.kind = 'lesson_not_held' and a.source = 'approved'
  ),
  pairs as materialized (
    select u.id, u.title, u.title_text, u.year, u.starts_at, u.ends_at, u.status, u.room_ids, d.degree
    from aule.unique_lessons u
    cross join lateral (
      select distinct c.label as degree from unnest(u.courses) as c(label)
      union all
      select '' where cardinality(u.courses) = 0
    ) d
    where aule.is_course(u.title_text, u.courses)
  ),
  g as (
    select p.title_text, p.degree, min(p.title collate "C") as title, min(p.year) as year
    from pairs p
    group by p.title_text, p.degree
  ),
  m as (
    select g.title_text, g.degree, g.title, g.year,
      case
        when not exists (
          select 1 from unnest(v_tokens) as t(tok)
          where strpos(g.title_text, t.tok) = 0 and strpos(replace(g.title_text, ' ', ''), t.tok) = 0) then 0
        when not exists (
          select 1 from unnest(v_tokens) as t(tok)
          where strpos(g.title_text, t.tok) = 0 and strpos(replace(g.title_text, ' ', ''), t.tok) = 0
            and strpos(f.degree_text, t.tok) = 0 and strpos(replace(f.degree_text, ' ', ''), t.tok) = 0) then 1
      end as rank
    from g
    -- The label folded as searchText() folds the query: no accents, lower case.
    cross join lateral (
      select lower(regexp_replace(normalize(g.degree, NFD), '[\u0300-\u036f]', '', 'g')) as degree_text
    ) f
  ),
  best as (
    select m.title_text, m.degree, m.title, m.year, m.rank
    from m
    where m.rank is not null
    order by m.rank, m.title_text collate aule."it_num", m.degree collate aule."it_num", m.title_text collate "C",
      m.degree collate "C"
    limit 40
  ),
  -- Lessons still to end, with the first of their rooms where they are held, as aule.search_at pairs them.
  cand as (
    select p.title_text, p.degree, p.id, p.starts_at, p.ends_at, r.name as room_name, r.building_name
    from pairs p
    join best b on b.title_text = p.title_text and b.degree = p.degree
    cross join lateral (
      select v.name, v.building_name
      from unnest(p.room_ids) with ordinality as x(room_id, i)
      join aule.room_view v on v.id = x.room_id
      where not exists (
        select 1 from nh
        where nh.room_id = x.room_id and nh.lesson_id = p.id and nh.starts_at = p.starts_at and nh.ends_at = p.ends_at
      )
      order by x.i
      limit 1
    ) r
    where p.status = 'active' and p.ends_at > p_now
  ),
  nx as (
    select distinct on (c.title_text, c.degree) c.title_text, c.degree, c.starts_at, c.ends_at, c.room_name, c.building_name
    from cand c
    order by c.title_text, c.degree, c.starts_at, c.id collate "C"
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'key', aule.course_key(b.title_text, b.degree),
      'title', b.title,
      'degree', b.degree,
      'year', b.year,
      'next', case when n.title_text is null then null else jsonb_build_object(
        'start', aule.ms(n.starts_at),
        'end', aule.ms(n.ends_at),
        'roomName', n.room_name,
        'buildingName', nullif(n.building_name, '')) end
    ) order by b.rank, b.title_text collate aule."it_num", b.degree collate aule."it_num", b.title_text collate "C",
      b.degree collate "C"), '[]'::jsonb)
  into v_courses
  from best b
  left join nx n on n.title_text = b.title_text and n.degree = b.degree;

  return jsonb_build_object('courses', v_courses);
end
$$;
revoke all on function aule.courses_at(timestamptz, text) from public, anon, authenticated, service_role;

-- One entry per lesson and requested course it belongs to. Unknown keys are not an error: they are listed in "missing".
create function aule.course_timetable_at(p_now timestamptz, p_keys text[], p_from date, p_days integer)
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
  if p_from < v_today - 21 or p_from > v_today + 21 then
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

-- Public wrappers: size checks first, then the internal function; only closed codes leave.

create function public.search_courses(p_query text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_query is null or octet_length(p_query) > 240 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  return aule.courses_at(now(), p_query);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.search_courses(text) from public, anon, authenticated, service_role;
grant execute on function public.search_courses(text) to anon;

create function public.course_timetable(p_keys text[], p_from date default null, p_days integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_keys is null or cardinality(p_keys) > 12 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if octet_length(array_to_string(p_keys, '', '')) > 384 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  return aule.course_timetable_at(now(), p_keys, coalesce(p_from, aule.rome_day(now())), coalesce(p_days, 7));
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.course_timetable(text[], date, integer) from public, anon, authenticated, service_role;
grant execute on function public.course_timetable(text[], date, integer) to anon;

set role postgres;
revoke create on schema public from aule_reader;
revoke create on schema aule from aule_reader;
