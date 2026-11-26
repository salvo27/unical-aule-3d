-- Canteen menu: one row per menu file of the University (a period of at most 71 days), written by the menu sync through
-- aule_sync.menu_put and read by anon through public.canteen_menu.
-- Day = {"day": "YYYY-MM-DD", "lunch": Meal | null, "dinner": Meal | null}, at least one meal.
-- Meal = {"first": Dish[], "second": Dish[], "side": Dish[]}, 1 to 8 dishes each.
-- Dish = {"line": "C" | "V" | "M" | "PF" | "NML", "name": plain text of 1 to 120 characters, "frozen": boolean}.
-- A period is kept until 14 days after its last day (Rome calendar), then the next put drops it.

create table aule.canteen_menus (
  starts_on date primary key,
  ends_on date not null,
  source text not null,
  days jsonb not null,
  fetched_at timestamptz not null default now(),
  constraint canteen_menus_period check (ends_on >= starts_on and ends_on - starts_on <= 70),
  constraint canteen_menus_source check (source ~ '^https://www\.unical\.it/media/medias/[0-9]{4}/[A-Za-z0-9_.-]{1,200}\.pdf$'),
  constraint canteen_menus_days check (jsonb_typeof(days) = 'array')
);

-- Grants: S = select, I = insert, U = update, D = delete. One permissive policy per role with a grant.
alter table aule.canteen_menus enable row level security;
revoke all on aule.canteen_menus from public, anon, authenticated, service_role, aule_sync;
grant select on aule.canteen_menus to aule_reader;
grant select, insert, update, delete on aule.canteen_menus to aule_ingest;
create policy canteen_menus_aule_reader on aule.canteen_menus for all to aule_reader using (true) with check (true);
create policy canteen_menus_aule_ingest on aule.canteen_menus for all to aule_ingest using (true) with check (true);

-- Stores one period, all or nothing: size, shape, dishes, then dates. The same start replaces the stored period.
-- Every type in the body carries its schema: aule_sync logs in and may create temp types (see the sync API).
create function aule_sync.menu_put(p jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_today pg_catalog.date;
  v_starts pg_catalog.date;
  v_ends pg_catalog.date;
  v_source pg_catalog.text;
  v_days pg_catalog.jsonb;
begin
  if p is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));

  -- 70 days of two meals of 24 dishes of 120 four byte characters stay below 2 MB.
  if octet_length(p::pg_catalog.text) > 2000000 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p) <> 'object' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  v_days := p -> 'days';
  if (select count(*) from jsonb_object_keys(p)) <> 4
     or not p ?& array['startsOn', 'endsOn', 'source', 'days']
     or jsonb_typeof(p -> 'startsOn') is distinct from 'string'
     or jsonb_typeof(p -> 'endsOn') is distinct from 'string'
     or jsonb_typeof(p -> 'source') is distinct from 'string'
     or jsonb_typeof(v_days) is distinct from 'array' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_days) not between 1 and 70 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- Days: exactly three keys, a day in the strict form, two meals that are objects or null, not both null.
  if exists (
    select 1 from jsonb_array_elements(v_days) e(d)
    where coalesce(case when jsonb_typeof(d) is distinct from 'object' then true else
      (select count(*) from jsonb_object_keys(d)) <> 3
      or not d ?& array['day', 'lunch', 'dinner']
      or jsonb_typeof(d -> 'day') is distinct from 'string'
      or (d ->> 'day') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or jsonb_typeof(d -> 'lunch') not in ('object', 'null')
      or jsonb_typeof(d -> 'dinner') not in ('object', 'null')
      or (jsonb_typeof(d -> 'lunch') = 'null' and jsonb_typeof(d -> 'dinner') = 'null')
    end, true)
  ) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- Meals: exactly the three courses, each an array of 1 to 8 dishes. A null meal has no courses.
  if exists (
    select 1
    from jsonb_array_elements(v_days) e(d)
    cross join lateral (values (d -> 'lunch'), (d -> 'dinner')) m(meal)
    where case when jsonb_typeof(m.meal) is distinct from 'object' then false else coalesce(
      (select count(*) from jsonb_object_keys(m.meal)) <> 3
      or not m.meal ?& array['first', 'second', 'side']
      or exists (
        select 1 from (values (m.meal -> 'first'), (m.meal -> 'second'), (m.meal -> 'side')) c(list)
        where case when jsonb_typeof(c.list) is distinct from 'array' then true
          else jsonb_array_length(c.list) not between 1 and 8 end),
      true) end
  ) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- Dishes: exactly three keys, a line of the closed set, a plain name, a boolean.
  if exists (
    select 1
    from jsonb_array_elements(v_days) e(d)
    cross join lateral (values (d -> 'lunch'), (d -> 'dinner')) m(meal)
    cross join lateral (values (m.meal -> 'first'), (m.meal -> 'second'), (m.meal -> 'side')) c(list)
    cross join lateral jsonb_array_elements(c.list) x(dish)
    where coalesce(case when jsonb_typeof(x.dish) is distinct from 'object' then true else
      (select count(*) from jsonb_object_keys(x.dish)) <> 3
      or not x.dish ?& array['line', 'name', 'frozen']
      or jsonb_typeof(x.dish -> 'line') is distinct from 'string'
      or jsonb_typeof(x.dish -> 'name') is distinct from 'string'
      or jsonb_typeof(x.dish -> 'frozen') is distinct from 'boolean'
      or (x.dish ->> 'line') not in ('C', 'V', 'M', 'PF', 'NML')
      or not aule.plain(x.dish ->> 'name', 1, 120)
    end, true)
  ) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  -- Dates: real days from 2020 to 2099, a period of at most 71 days, each day once and inside it. The source file.
  if p ->> 'startsOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or p ->> 'endsOn' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  begin
    v_starts := (p ->> 'startsOn')::aule.iso_day;
    v_ends := (p ->> 'endsOn')::aule.iso_day;
    if v_ends < v_starts or v_ends - v_starts > 70
       or exists (
         select 1 from jsonb_array_elements(v_days) e(d)
         where (d ->> 'day')::aule.iso_day not between v_starts and v_ends)
       or exists (select 1 from jsonb_array_elements(v_days) e(d) group by d ->> 'day' having count(*) > 1) then
      raise exception 'invalid' using errcode = 'P0001';
    end if;
  exception when others then
    raise exception 'invalid' using errcode = 'P0001';
  end;
  v_source := p ->> 'source';
  if v_source !~ '^https://www\.unical\.it/media/medias/[0-9]{4}/[A-Za-z0-9_.-]{1,200}\.pdf$' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;

  v_today := aule.rome_day(now());
  begin
    insert into aule.canteen_menus (starts_on, ends_on, source, days, fetched_at)
    values (v_starts, v_ends, v_source,
      (select jsonb_agg(e.d order by e.d ->> 'day') from jsonb_array_elements(v_days) e(d)), now())
    on conflict (starts_on) do update set
      ends_on = excluded.ends_on, source = excluded.source, days = excluded.days, fetched_at = excluded.fetched_at;
  exception when others then
    raise exception 'invalid' using errcode = 'P0001';
  end;
  delete from aule.canteen_menus m where m.ends_on < v_today - 14;

  return jsonb_build_object('ok', true, 'days', jsonb_array_length(v_days));
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.menu_put(jsonb) from public, anon, authenticated, service_role;
grant execute on function aule_sync.menu_put(jsonb) to aule_sync;

-- The days of the window that a stored period lists, in date order. Each day of the window is read from the newest
-- period (fetched last, then the later start) whose dates contain it: a newer file replaces an older one on the days
-- they share, even where the newer one lists no meal. Bounds as the course timetable: 21 days back, 60 ahead, 1 to 14 days.
create function aule.canteen_menu_at(p_now timestamptz, p_from date, p_days integer)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_today pg_catalog.date;
  v_out pg_catalog.jsonb;
begin
  if p_now is null or p_from is null or p_days is null then
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

  with w as (
    select p_from + g.i as day from generate_series(0, p_days - 1) as g(i)
  ),
  pick as (
    select distinct on (w.day) w.day, m.source, m.fetched_at, m.days
    from w
    join aule.canteen_menus m on w.day between m.starts_on and m.ends_on
    order by w.day, m.fetched_at desc, m.starts_on desc
  ),
  hit as materialized (
    select p.day, p.source, p.fetched_at, e.v as obj
    from pick p
    cross join lateral jsonb_array_elements(p.days) as e(v)
    where (e.v ->> 'day')::pg_catalog.date = p.day
  )
  select jsonb_build_object(
    'days', coalesce((select jsonb_agg(h.obj order by h.day) from hit h), '[]'::pg_catalog.jsonb),
    'source', (select h.source from hit h order by h.day limit 1),
    'fetchedAt', (select to_char(max(h.fetched_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from hit h)
  ) into v_out;
  return v_out;
end
$$;
revoke all on function aule.canteen_menu_at(timestamptz, date, integer) from public, anon, authenticated, service_role;

-- Public wrapper: today in Rome and 7 days by default; only closed codes leave.
create function public.canteen_menu(p_from date default null, p_days integer default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return aule.canteen_menu_at(now(), coalesce(p_from, aule.rome_day(now())), coalesce(p_days, 7));
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function public.canteen_menu(date, integer) from public, anon, authenticated, service_role;
grant execute on function public.canteen_menu(date, integer) to anon;

-- Hand the functions to the NOLOGIN owners. Grants made above move with the ownership.
grant create on schema aule_sync to aule_ingest;
alter function aule_sync.menu_put(jsonb) owner to aule_ingest;
revoke create on schema aule_sync from aule_ingest;

grant create on schema aule to aule_reader;
alter function aule.canteen_menu_at(timestamptz, date, integer) owner to aule_reader;
revoke create on schema aule from aule_reader;

grant create on schema public to aule_reader;
alter function public.canteen_menu(date, integer) owner to aule_reader;
revoke create on schema public from aule_reader;
