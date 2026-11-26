begin;
create extension if not exists pgtap with schema extensions;
select plan(84);

-- Runs one statement as a role. Result as text, or '!<sqlstate>' with the message of P0001 errors.
create function pg_temp.as_role(p_role text, q text, p jsonb default null)
returns text
language plpgsql
as $$
declare
  r text;
begin
  execute format('set local role %I', p_role);
  if p is null then
    execute q into r;
  else
    execute q into r using p;
  end if;
  reset role;
  return r;
exception when others then
  return '!' || sqlstate || case when sqlstate = 'P0001' then ' ' || sqlerrm else '' end;
end
$$;
create function pg_temp.j(p text) returns jsonb language sql immutable as $$
  select case when p like '{%' then p::jsonb else jsonb_build_object('error', p) end
$$;

-- Days are counted from today in Rome, the day menu_put keeps periods against.
create function pg_temp.today() returns date language sql stable as $$
  select aule.rome_day(now())
$$;
create function pg_temp.d(n integer) returns text language sql stable as $$
  select to_char(pg_temp.today() + n, 'YYYY-MM-DD')
$$;
create function pg_temp.iso(t timestamptz) returns text language sql immutable as $$
  select to_char(t at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
create function pg_temp.dish(p_line text, p_name text, p_frozen boolean default false) returns jsonb language sql immutable as $$
  select jsonb_build_object('line', p_line, 'name', p_name, 'frozen', p_frozen)
$$;
-- The first dish names the tag, so a test can tell which period a day was read from.
create function pg_temp.meal(p_tag text default 'A') returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'first', jsonb_build_array(pg_temp.dish('C', 'Pasta al pomodoro ' || p_tag), pg_temp.dish('V', 'Minestra di legumi')),
    'second', jsonb_build_array(pg_temp.dish('M', 'Pollo arrosto', true), pg_temp.dish('PF', 'Merluzzo gratinato', true)),
    'side', jsonb_build_array(pg_temp.dish('NML', 'Insalata mista')))
$$;
create function pg_temp.day(n integer, p_lunch boolean default true, p_dinner boolean default true, p_tag text default 'A')
returns jsonb language sql stable as $$
  select jsonb_build_object('day', pg_temp.d(n),
    'lunch', case when p_lunch then pg_temp.meal(p_tag) else 'null'::jsonb end,
    'dinner', case when p_dinner then pg_temp.meal(p_tag) else 'null'::jsonb end)
$$;
create function pg_temp.menu(p_starts integer, p_ends integer, p_days jsonb,
  p_source text default 'https://www.unical.it/media/medias/2026/Menu_settimana_48.pdf')
returns jsonb language sql stable as $$
  select jsonb_build_object('startsOn', pg_temp.d(p_starts), 'endsOn', pg_temp.d(p_ends), 'source', p_source, 'days', p_days)
$$;
-- Today with both meals, tomorrow lunch only, the day after dinner only, given out of order.
create function pg_temp.valid() returns jsonb language sql stable as $$
  select pg_temp.menu(0, 6, jsonb_build_array(pg_temp.day(0), pg_temp.day(2, false, true), pg_temp.day(1, true, false)))
$$;
create function pg_temp.put(p jsonb) returns text language sql as $$
  select pg_temp.as_role('aule_sync', 'select aule_sync.menu_put($1)::text', p)
$$;
create function pg_temp.rd(p_from integer, p_days integer, p_now timestamptz default now()) returns text language sql as $$
  select pg_temp.as_role('aule_reader',
    format('select aule.canteen_menu_at(%L, %L, %L)::text', p_now, pg_temp.today() + p_from, p_days))
$$;
create function pg_temp.days_of(p text) returns text[] language sql immutable as $$
  select array(select e ->> 'day' from jsonb_array_elements(pg_temp.j(p) -> 'days') with ordinality as x(e, i) order by x.i)
$$;
create function pg_temp.tags_of(p text) returns text[] language sql immutable as $$
  select array(
    select coalesce(e -> 'lunch', e -> 'dinner') -> 'first' -> 0 ->> 'name'
    from jsonb_array_elements(pg_temp.j(p) -> 'days') with ordinality as x(e, i) order by x.i)
$$;

-- As in the grants test: temp types named like built-in types never reach the code aule_sync runs as aule_ingest.
-- First, so that no earlier call in this session has compiled menu_put already.
set local role aule_sync;
create function pg_temp.shadowed(v anyelement) returns pg_catalog.bool
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'shadowed' using errcode = 'P0001';
end $$;
create function pg_temp.exercise_menu() returns pg_catalog.text
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  v_day pg_catalog.text;
  v_dish pg_catalog.jsonb;
  v_result pg_catalog.jsonb;
begin
  -- Today in Rome, as aule.rome_day computes it: aule_sync cannot use schema aule.
  v_day := pg_catalog.to_char(pg_catalog.now() at time zone 'Europe/Rome', 'YYYY-MM-DD');
  v_dish := pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('line', 'C', 'name', 'Pasta', 'frozen', false));
  v_result := aule_sync.menu_put(pg_catalog.jsonb_build_object('startsOn', v_day, 'endsOn', v_day,
    'source', 'https://www.unical.it/media/medias/2026/menu.pdf',
    'days', pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('day', v_day,
      'lunch', pg_catalog.jsonb_build_object('first', v_dish, 'second', v_dish, 'side', v_dish), 'dinner', null))));
  return 'menu ' || (v_result ->> 'days');
exception when others then
  return 'menu ' || sqlerrm;
end $$;
create domain pg_temp.text as pg_catalog.text check (pg_temp.shadowed(value));
create domain pg_temp.jsonb as pg_catalog.jsonb check (pg_temp.shadowed(value));
create domain pg_temp.json as pg_catalog.json check (pg_temp.shadowed(value));
create domain pg_temp.timestamptz as pg_catalog.timestamptz check (pg_temp.shadowed(value));
create domain pg_temp.date as pg_catalog.date check (pg_temp.shadowed(value));
create domain pg_temp.uuid as pg_catalog.uuid check (pg_temp.shadowed(value));
create domain pg_temp.bool as pg_catalog.bool check (pg_temp.shadowed(value));
create domain pg_temp.int2 as pg_catalog.int2 check (pg_temp.shadowed(value));
create domain pg_temp.int4 as pg_catalog.int4 check (pg_temp.shadowed(value));
create domain pg_temp.int8 as pg_catalog.int8 check (pg_temp.shadowed(value));
create domain pg_temp.float8 as pg_catalog.float8 check (pg_temp.shadowed(value));
create domain pg_temp.name as pg_catalog.name check (pg_temp.shadowed(value));
create temp table menu_shadow_outcome as select pg_temp.exercise_menu() as outcome;
grant select on menu_shadow_outcome to postgres;
drop domain pg_temp.text, pg_temp.jsonb, pg_temp.json, pg_temp.timestamptz, pg_temp.date, pg_temp.uuid, pg_temp.bool,
  pg_temp.int2, pg_temp.int4, pg_temp.int8, pg_temp.float8, pg_temp.name;
reset role;
select is((select outcome from menu_shadow_outcome), 'menu 1', 'temp types named like built-in types never reach menu_put');

delete from aule.canteen_menus;

-- Edges that are accepted.
select is(pg_temp.j(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,name}', to_jsonb(repeat('à', 120))))),
  '{"ok": true, "days": 3}'::jsonb, 'a name of 120 characters is accepted');
select is(pg_temp.j(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,dinner,side}',
    (select jsonb_agg(pg_temp.dish('V', 'Contorno ' || i)) from generate_series(1, 8) i)))),
  '{"ok": true, "days": 3}'::jsonb, '8 dishes in a course are accepted');
select is(pg_temp.j(pg_temp.put(pg_temp.menu(0, 70, (select jsonb_agg(pg_temp.day(i, true, false)) from generate_series(0, 69) i)))),
  '{"ok": true, "days": 70}'::jsonb, '70 days in a period of 71 days are accepted');

-- A valid put, read back.
select is(pg_temp.j(pg_temp.put(pg_temp.valid())), '{"ok": true, "days": 3}'::jsonb, 'aule_sync stores a period');
select is(
  (select array[count(*)::text, min(ends_on - starts_on)::text, min(source), bool_and(fetched_at = now())::text,
      min(starts_on)::text] from aule.canteen_menus),
  array['1', '6', 'https://www.unical.it/media/medias/2026/Menu_settimana_48.pdf', 'true', pg_temp.d(0)],
  'the same start replaces the period: one row with the new end, source and fetch time');
select is((select days from aule.canteen_menus), jsonb_build_array(pg_temp.day(0), pg_temp.day(1, true, false), pg_temp.day(2, false, true)),
  'the days are stored as given, in date order');
select is(pg_temp.j(pg_temp.rd(0, 7)),
  jsonb_build_object('days', jsonb_build_array(pg_temp.day(0), pg_temp.day(1, true, false), pg_temp.day(2, false, true)),
    'source', 'https://www.unical.it/media/medias/2026/Menu_settimana_48.pdf', 'fetchedAt', pg_temp.iso(now())),
  'the reader gets the days in date order, the source and the fetch time');
select is(pg_temp.j(pg_temp.rd(1, 1)),
  jsonb_build_object('days', jsonb_build_array(pg_temp.day(1, true, false)),
    'source', 'https://www.unical.it/media/medias/2026/Menu_settimana_48.pdf', 'fetchedAt', pg_temp.iso(now())),
  'a window of one day gets that day only');
select is(pg_temp.j(pg_temp.rd(7, 7)), '{"days": [], "source": null, "fetchedAt": null}'::jsonb,
  'a window without stored days is empty, without source and fetch time');
select is(pg_temp.j(pg_temp.rd(-3, 4)) -> 'days', jsonb_build_array(pg_temp.day(0)), 'days before the period are left out');
select is(pg_temp.j(pg_temp.as_role('anon', 'select public.canteen_menu()::text')), pg_temp.j(pg_temp.rd(0, 7)),
  'anon reads today and the next 6 days by default');
select is(pg_temp.j(pg_temp.as_role('anon', format('select public.canteen_menu(%L, 1)::text', pg_temp.today() + 2))) -> 'days',
  jsonb_build_array(pg_temp.day(2, false, true)), 'anon reads a chosen window');

-- Every refusal is the closed code, and nothing is written before the whole payload is valid.
create temp table before_refusals as select jsonb_agg(to_jsonb(m) order by m.starts_on) as rows from aule.canteen_menus m;
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,line}', '"X"')), '!P0001 invalid', 'an unknown line is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,line}', '"c"')), '!P0001 invalid', 'a line in lower case is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,line}', 'null')), '!P0001 invalid', 'a null line is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,name}', to_jsonb(repeat('a', 121)))), '!P0001 invalid',
  'a name of 121 characters is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,name}', '""')), '!P0001 invalid', 'an empty name is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,name}', '" Pasta"')), '!P0001 invalid',
  'a name with a leading space is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,name}', '"Pasta\tal sugo"')), '!P0001 invalid',
  'a name with a control character is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,name}', '12')), '!P0001 invalid', 'a name that is a number is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,frozen}', '"no"')), '!P0001 invalid',
  'frozen must be a boolean');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0,price}', '3')), '!P0001 invalid', 'an unknown dish key is refused');
select is(pg_temp.put(pg_temp.valid() #- '{days,0,lunch,first,0,frozen}'), '!P0001 invalid', 'a missing dish key is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first,0}', '"Pasta"')), '!P0001 invalid', 'a dish must be an object');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first}', '[]')), '!P0001 invalid', 'a course without dishes is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,dinner,side}',
    (select jsonb_agg(pg_temp.dish('V', 'Contorno ' || i)) from generate_series(1, 9) i))), '!P0001 invalid',
  'a course of 9 dishes is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,first}', '{}')), '!P0001 invalid', 'a course must be an array');
select is(pg_temp.put(pg_temp.valid() #- '{days,0,lunch,side}'), '!P0001 invalid', 'a meal without side dishes is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch,dessert}', '[]')), '!P0001 invalid', 'an unknown course is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,lunch}', '"chiuso"')), '!P0001 invalid', 'a meal must be an object or null');
select is(pg_temp.put(pg_temp.menu(0, 6, jsonb_build_array(pg_temp.day(0, false, false)))), '!P0001 invalid',
  'a day without lunch and dinner is refused');
select is(pg_temp.put(pg_temp.valid() #- '{days,0,dinner}'), '!P0001 invalid', 'a day without the dinner key is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,note}', '"x"')), '!P0001 invalid', 'an unknown day key is refused');
select is(pg_temp.put(pg_temp.menu(0, 6, jsonb_build_array(pg_temp.day(7)))), '!P0001 invalid', 'a day after the period is refused');
select is(pg_temp.put(pg_temp.menu(1, 6, jsonb_build_array(pg_temp.day(0)))), '!P0001 invalid', 'a day before the period is refused');
select is(pg_temp.put(pg_temp.menu(0, 6, jsonb_build_array(pg_temp.day(0), pg_temp.day(0, true, false)))), '!P0001 invalid',
  'a day given twice is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days,0,day}', to_jsonb(to_char(pg_temp.today(), 'DD/MM/YYYY')))), '!P0001 invalid',
  'a day in another form is refused');
select is(pg_temp.put(pg_temp.valid() || '{"note": "x"}'), '!P0001 invalid', 'an unknown key is refused');
select is(pg_temp.put(pg_temp.valid() - 'source'), '!P0001 invalid', 'a missing key is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{startsOn}', '20261126')), '!P0001 invalid', 'a start that is a number is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{startsOn}', '"2027-02-30"')), '!P0001 invalid', 'an impossible start is refused');
select is(pg_temp.put(jsonb_build_object('startsOn', '2019-12-30', 'endsOn', '2019-12-31', 'source',
    'https://www.unical.it/media/medias/2019/menu.pdf', 'days', jsonb_build_array(pg_temp.day(0) || '{"day": "2019-12-30"}'))),
  '!P0001 invalid', 'a day before 2020 is refused');
select is(pg_temp.put(pg_temp.menu(3, 2, jsonb_build_array(pg_temp.day(2)))), '!P0001 invalid', 'an end before the start is refused');
select is(pg_temp.put(pg_temp.menu(0, 71, jsonb_build_array(pg_temp.day(0)))), '!P0001 invalid', 'a period of 72 days is refused');
select is(pg_temp.put(pg_temp.menu(0, 70, (select jsonb_agg(pg_temp.day(i, true, false)) from generate_series(0, 70) i))),
  '!P0001 invalid', '71 days are refused');
select is(pg_temp.put(pg_temp.menu(0, 6, '[]')), '!P0001 invalid', 'a period without days is refused');
select is(pg_temp.put(jsonb_set(pg_temp.valid(), '{days}', '{}')), '!P0001 invalid', 'days must be an array');
select is(
  array[pg_temp.put(pg_temp.menu(0, 6, pg_temp.valid() -> 'days', 'http://www.unical.it/media/medias/2026/menu.pdf')),
    pg_temp.put(pg_temp.menu(0, 6, pg_temp.valid() -> 'days', 'https://www.unical.it.example.com/media/medias/2026/menu.pdf')),
    pg_temp.put(pg_temp.menu(0, 6, pg_temp.valid() -> 'days', 'https://example.com/media/medias/2026/menu.pdf')),
    pg_temp.put(pg_temp.menu(0, 6, pg_temp.valid() -> 'days', 'https://www.unical.it/media/medias/2026/menu.html')),
    pg_temp.put(pg_temp.menu(0, 6, pg_temp.valid() -> 'days', 'https://www.unical.it/media/medias/2026/../menu.pdf')),
    pg_temp.put(pg_temp.menu(0, 6, pg_temp.valid() -> 'days', 'https://www.unical.it/media/medias/26/menu.pdf')),
    pg_temp.put(pg_temp.menu(0, 6, pg_temp.valid() -> 'days', 'https://www.unical.it/media/medias/2026/menu.pdf?x=1')),
    pg_temp.put(jsonb_set(pg_temp.valid(), '{source}', 'null'))],
  array_fill('!P0001 invalid'::text, array[8]), 'a source outside the media files of www.unical.it is refused');
select is(pg_temp.put('[]'), '!P0001 invalid', 'a payload that is not an object is refused');
select is(pg_temp.as_role('aule_sync', 'select aule_sync.menu_put(null)::text'), '!P0001 invalid', 'a null payload is refused');
select is(pg_temp.put(pg_temp.valid() || jsonb_build_object('pad', repeat('x', 2000000))), '!P0001 invalid',
  'a payload over 2 MB is refused');
select is((select jsonb_agg(to_jsonb(m) order by m.starts_on) from aule.canteen_menus m), (select rows from before_refusals),
  'a refused put changes nothing');

-- A newer file wins on the days it shares with an older one; ties go to the later start.
delete from aule.canteen_menus;
insert into aule.canteen_menus (starts_on, ends_on, source, days, fetched_at) values
  (pg_temp.today() - 1, pg_temp.today() + 5, 'https://www.unical.it/media/medias/2026/menu_a.pdf',
    jsonb_build_array(pg_temp.day(-1, true, true, 'A'), pg_temp.day(0, true, true, 'A'), pg_temp.day(1, true, true, 'A')),
    now() - interval '1 hour'),
  (pg_temp.today(), pg_temp.today() + 6, 'https://www.unical.it/media/medias/2026/menu_b.pdf',
    jsonb_build_array(pg_temp.day(0, true, true, 'B'), pg_temp.day(2, true, true, 'B'), pg_temp.day(6, true, true, 'B')),
    now() - interval '2 hours');
select is(
  array[pg_temp.days_of(pg_temp.rd(-1, 8)), pg_temp.tags_of(pg_temp.rd(-1, 8))],
  array[array[pg_temp.d(-1), pg_temp.d(0), pg_temp.d(1), pg_temp.d(6)],
    array['Pasta al pomodoro A', 'Pasta al pomodoro A', 'Pasta al pomodoro A', 'Pasta al pomodoro B']],
  'each day comes from the newest period that contains it, even where that period lists no meal');
select is(pg_temp.j(pg_temp.rd(-1, 8)) - 'days',
  jsonb_build_object('source', 'https://www.unical.it/media/medias/2026/menu_a.pdf', 'fetchedAt', pg_temp.iso(now() - interval '1 hour')),
  'the source is the one of the first day, the fetch time the newest of the periods used');
select is(pg_temp.j(pg_temp.rd(2, 5)) - 'days',
  jsonb_build_object('source', 'https://www.unical.it/media/medias/2026/menu_b.pdf', 'fetchedAt', pg_temp.iso(now() - interval '2 hours')),
  'a window that uses only the older period gives its source and fetch time');
update aule.canteen_menus set fetched_at = now() where starts_on = pg_temp.today();
select is(
  array[pg_temp.days_of(pg_temp.rd(-1, 8)), pg_temp.tags_of(pg_temp.rd(-1, 8))],
  array[array[pg_temp.d(-1), pg_temp.d(0), pg_temp.d(2), pg_temp.d(6)],
    array['Pasta al pomodoro A', 'Pasta al pomodoro B', 'Pasta al pomodoro B', 'Pasta al pomodoro B']],
  'when the other file is newer, it wins on the shared days');
update aule.canteen_menus set fetched_at = now();
select is(pg_temp.tags_of(pg_temp.rd(0, 1)), array['Pasta al pomodoro B'], 'with the same fetch time the later start wins');

-- Periods that ended more than 14 days ago are dropped by the next put.
delete from aule.canteen_menus;
insert into aule.canteen_menus (starts_on, ends_on, source, days) values
  (pg_temp.today() - 20, pg_temp.today() - 15, 'https://www.unical.it/media/medias/2026/menu_old.pdf', jsonb_build_array(pg_temp.day(-15))),
  (pg_temp.today() - 19, pg_temp.today() - 14, 'https://www.unical.it/media/medias/2026/menu_kept.pdf', jsonb_build_array(pg_temp.day(-14)));
select is(pg_temp.j(pg_temp.put(pg_temp.valid())) ->> 'ok', 'true', 'a put after old periods succeeds');
select is(array(select starts_on - pg_temp.today() from aule.canteen_menus order by starts_on), array[-19, 0],
  'the period that ended 15 days ago is gone, the one that ended 14 days ago is kept');

-- The window of the reader: 21 days back, 60 ahead, 1 to 14 days, as the course timetable.
delete from aule.canteen_menus;
select is(
  array[pg_temp.rd(-22, 1), pg_temp.rd(61, 1), pg_temp.rd(null, 1), pg_temp.rd(0, 0), pg_temp.rd(0, 15), pg_temp.rd(0, -1),
    pg_temp.rd(0, null), pg_temp.rd(0, 1, null)],
  array_fill('!P0001 invalid'::text, array[8]), 'a day too far back or ahead, a wrong count or a missing value is invalid');
select is(
  array[pg_temp.j(pg_temp.rd(-21, 14)) ->> 'days', pg_temp.j(pg_temp.rd(60, 14)) ->> 'days'],
  array['[]', '[]'], '21 days back and 60 days ahead, 14 days long, are accepted');
select is(pg_temp.as_role('aule_reader', 'select aule.canteen_menu_at(now(), date ''2019-12-31'', 1)::text'), '!P0001 invalid',
  'a day before 2020 is invalid');
select is(
  array[pg_temp.as_role('anon', 'select public.canteen_menu(null, 15)::text'),
    pg_temp.as_role('anon', 'select public.canteen_menu(date ''2099-12-31'')::text'),
    pg_temp.as_role('anon', 'select public.canteen_menu(date ''2000-01-01'', 1)::text')],
  array_fill('!P0001 invalid'::text, array[3]), 'the public wrapper refuses the same values');

-- Only aule_sync writes, only through menu_put; anon only reads, only through the public wrapper.
select is(pg_temp.as_role('anon', 'select aule_sync.menu_put($1)::text', pg_temp.valid()), '!42501', 'anon cannot call menu_put');
select is(pg_temp.as_role('authenticated', 'select aule_sync.menu_put($1)::text', pg_temp.valid()), '!42501',
  'authenticated cannot call menu_put');
select is(pg_temp.as_role('service_role', 'select aule_sync.menu_put($1)::text', pg_temp.valid()), '!42501',
  'service_role cannot call menu_put');
select is(pg_temp.as_role('aule_reader', 'select aule_sync.menu_put($1)::text', pg_temp.valid()), '!42501',
  'the reader cannot call menu_put');
select is(pg_temp.as_role('anon', 'select count(*)::text from aule.canteen_menus'), '!42501', 'anon cannot read the table');
select is(pg_temp.as_role('aule_sync', 'select count(*)::text from aule.canteen_menus'), '!42501', 'aule_sync cannot read the table');
select is(pg_temp.as_role('anon', 'select aule.canteen_menu_at(now(), aule.rome_day(now()), 7)::text'), '!42501',
  'anon cannot reach the internal reader');
select is(pg_temp.as_role('authenticated', 'select public.canteen_menu()::text'), '!42501', 'authenticated cannot read the menu');
select is(pg_temp.as_role('aule_sync', 'select public.canteen_menu()::text'), '!42501', 'aule_sync cannot read the menu');

-- Owners, security, grants and the table.
select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'aule_sync.menu_put(jsonb)'::regprocedure and p.prosecdef and p.provolatile = 'v'
      and p.proowner = 'aule_ingest'::regrole and p.proconfig @> array['search_path=""']),
  1, 'menu_put runs as aule_ingest with an empty search_path');
select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'public.canteen_menu(date, integer)'::regprocedure and p.prosecdef and p.provolatile = 's'
      and p.proowner = 'aule_reader'::regrole and p.proconfig @> array['search_path=""']),
  1, 'the public wrapper is stable, runs as aule_reader and has an empty search_path');
select is(
  (select count(*)::int from pg_proc p
    where p.oid = 'aule.canteen_menu_at(timestamptz, date, integer)'::regprocedure and not p.prosecdef and p.provolatile = 's'
      and p.proowner = 'aule_reader'::regrole and p.proconfig @> array['search_path=""']),
  1, 'the internal reader never writes, runs as the caller and has an empty search_path');
select set_eq(
  $$select p.proname::text, r.role from pg_proc p
    cross join unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    where p.oid in ('aule_sync.menu_put(jsonb)'::regprocedure, 'public.canteen_menu(date, integer)'::regprocedure,
        'aule.canteen_menu_at(timestamptz, date, integer)'::regprocedure)
      and pg_get_userbyid(p.proowner) <> r.role and has_function_privilege(r.role, p.oid, 'EXECUTE')$$,
  $$values ('menu_put', 'aule_sync'), ('canteen_menu', 'anon')$$,
  'besides the owners, only aule_sync runs menu_put and only anon the public wrapper');
select ok((select relrowsecurity from pg_class where oid = 'aule.canteen_menus'::regclass), 'RLS is enabled on the menu table');
select set_eq(
  $$select r.role, string_agg(p.letter, '' order by p.ord)
    from unnest(array['public', 'anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    cross join (values (1, 'S', 'SELECT'), (2, 'I', 'INSERT'), (3, 'U', 'UPDATE'), (4, 'D', 'DELETE'),
      (5, 'T', 'TRUNCATE'), (6, 'R', 'REFERENCES'), (7, 'G', 'TRIGGER')) as p(ord, letter, priv)
    where has_table_privilege(r.role, 'aule.canteen_menus', p.priv)
    group by 1$$,
  $$values ('aule_reader', 'S'), ('aule_ingest', 'SIUD')$$,
  'the reader selects, the ingest owner writes, nobody else touches the table');
select is_empty(
  $$select r.role, n.nsp from unnest(array['aule', 'aule_sync', 'public']) as n(nsp)
    cross join unnest(array['anon', 'authenticated', 'service_role', 'aule_sync', 'aule_reader', 'aule_ingest', 'aule_config']) as r(role)
    where has_schema_privilege(r.role, n.nsp, 'CREATE')$$,
  'the migration leaves no role able to create in aule, aule_sync or public');
select throws_ok(
  $$insert into aule.canteen_menus (starts_on, ends_on, source, days)
    values (date '2026-11-23', date '2026-11-29', 'https://www.unical.it/media/menu.pdf', '[]')$$,
  '23514', null, 'the table refuses a source outside the media files');
select throws_ok(
  $$insert into aule.canteen_menus (starts_on, ends_on, source, days)
    values (date '2026-11-23', date '2027-02-02', 'https://www.unical.it/media/medias/2026/menu.pdf', '[]')$$,
  '23514', null, 'the table refuses a period longer than 71 days');
select throws_ok(
  $$insert into aule.canteen_menus (starts_on, ends_on, source, days)
    values (date '2026-11-23', date '2026-11-22', 'https://www.unical.it/media/medias/2026/menu.pdf', '[]')$$,
  '23514', null, 'the table refuses an end before the start');
select throws_ok(
  $$insert into aule.canteen_menus (starts_on, ends_on, source, days)
    values (date '2026-11-23', date '2026-11-29', 'https://www.unical.it/media/medias/2026/menu.pdf', '{}')$$,
  '23514', null, 'the table refuses days that are not an array');

select * from finish();
rollback;
