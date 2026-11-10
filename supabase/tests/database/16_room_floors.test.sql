begin;
create extension if not exists pgtap with schema extensions;
select plan(36);

-- Runs one query as anon through the public wrappers; an error comes back as {"error": ...}.
create function pg_temp.anon(q text)
returns jsonb
language plpgsql
as $$
declare
  r jsonb;
begin
  set local role anon;
  execute q into r;
  reset role;
  return r;
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || sqlerrm);
end
$$;
create function pg_temp.place(p jsonb) returns jsonb language sql immutable as $$
  select jsonb_build_object('floor', p -> 'floor', 'bridge', p -> 'bridge')
$$;

-- Floors and bridges imported by 20261110091200_room_floors.sql from the department pages and the owner's choices.
select is((select count(*)::int from aule.room_floors), 131, '131 imported rooms');
select results_eq(
  $$select count(*) filter (where floor is not null)::int, count(*) filter (where bridge = 'coperto')::int,
      count(*) filter (where bridge = 'scoperto')::int from aule.room_floors$$,
  $$values (112, 10, 9)$$,
  '112 floor numbers, 10 rooms on the ponte coperto, 9 on the ponte scoperto');
select ok(
  (select bool_and(room_id ~ '^[0-9a-f]{24}$' and (floor is null) <> (bridge is null) and coalesce(floor between -2 and 12, true)
      and updated_by is null)
    from aule.room_floors),
  'every id is hex24, every row has a floor in -2..12 or a bridge, never both, no admin is named');
select set_eq(
  $$select room_id::text, floor::integer from aule.room_floors where room_id in (
    '5fc6b253d0ffc7001bffc0cc', '5fc6b256d0ffc7001bffc1d8', '5fc6b254d0ffc7001bffc144', 'ffff77b39f0c2fe36a2f2f2a',
    '5fc6b252d0ffc7001bffc07a', '5fc6b252d0ffc7001bffc072', '5fc6b253d0ffc7001bffc0b6', 'ffff6349252fafb21aa6f075',
    '5fc6b256d0ffc7001bffc1e4', '5fc6b254d0ffc7001bffc142')$$,
  $$values ('5fc6b253d0ffc7001bffc0cc', 3), ('5fc6b256d0ffc7001bffc1d8', 4), ('5fc6b254d0ffc7001bffc144', 4),
    ('ffff77b39f0c2fe36a2f2f2a', 0), ('5fc6b252d0ffc7001bffc07a', 2), ('5fc6b252d0ffc7001bffc072', 7),
    ('5fc6b253d0ffc7001bffc0b6', 2), ('ffff6349252fafb21aa6f075', 2), ('5fc6b256d0ffc7001bffc1e4', 4),
    ('5fc6b254d0ffc7001bffc142', 0)$$,
  'spot values: numbered floor, bridges, synthetic id, ex alias, cube without letter, roman numeral, code match');
select set_eq(
  $$select room_id::text, bridge from aule.room_floors where bridge is not null$$,
  $$values
    ('5fc6b254d0ffc7001bffc112', 'coperto'), ('5fc6b253d0ffc7001bffc0fe', 'coperto'), ('5fc6b253d0ffc7001bffc100', 'coperto'),
    ('ffff2d8ab5d21e8ce4aa1276', 'coperto'), ('ffff0e9187c5b7a6fe891a16', 'coperto'), ('5fc6b255d0ffc7001bffc1b8', 'coperto'),
    ('5fc6b254d0ffc7001bffc160', 'coperto'), ('5fc6b254d0ffc7001bffc13a', 'coperto'), ('5fc6b253d0ffc7001bffc0ec', 'coperto'),
    ('5fc6b253d0ffc7001bffc0f2', 'coperto'),
    ('ffff978cb3f23c610773028a', 'scoperto'), ('ffff3cda0d856ee7850d9f87', 'scoperto'), ('ffff272ff02ab596f15a3f3d', 'scoperto'),
    ('5fc6b254d0ffc7001bffc12c', 'scoperto'), ('6267b13ff016d50f3c5618c7', 'scoperto'), ('5fc6b253d0ffc7001bffc0fa', 'scoperto'),
    ('5fc6b254d0ffc7001bffc162', 'scoperto'), ('5fc6b254d0ffc7001bffc164', 'scoperto'), ('6409ec570c21c0029be9fc21', 'scoperto')$$,
  'the rooms on the bridges, as the owner decided');
select set_eq(
  $$select room_id::text, floor::integer from aule.room_floors where room_id in (
    '63524942d07a3e0cfd3e8e99', '635244157735f207681eeaa9', 'ffff5417d9d8c137ae022128', 'ffffb9e405a69439f53756f9',
    'ffff2d9e51fb0136fadda443', 'ffff10107704a7accadeb9e3')$$,
  $$values ('63524942d07a3e0cfd3e8e99', 7), ('635244157735f207681eeaa9', 7), ('ffff5417d9d8c137ae022128', 6),
    ('ffffb9e405a69439f53756f9', 1), ('ffff2d9e51fb0136fadda443', 1), ('ffff10107704a7accadeb9e3', 0)$$,
  'the labs matched by description get the floor of the list');
select is(
  (select count(*)::int from aule.room_floors where room_id in (
    '5fc6b253d0ffc7001bffc0f4', '5fc6b253d0ffc7001bffc0f6', '63454d2792a825011d7f3050', '63454e0fecfc6300e80afe85')),
  0, 'the four rooms of cube 20B still in doubt are not imported');

-- The floor reaches the room once the timetable holds it; a bridge room has no floor, not even a seed one.
delete from aule.calendar_data;
delete from aule.rooms;
insert into aule.rooms (id, name, code, building_name, services, building_key_guess, room_key, name_compact, search_text) values
  ('5fc6b253d0ffc7001bffc0cc', 'AULA MAGNA', 'AU_0001', 'Cubo 15B', '{}', 'cubo-15b', 'magna', 'magna', 'aula magna cubo 15b'),
  ('5fc6b254d0ffc7001bffc112', 'Consolidata 32B1', 'AU_0002', 'Cubo 32B', '{}', 'cubo-32b', 'consolidata32b1', 'consolidata32b1',
    'consolidata 32b1 cubo 32b'),
  ('6267b13ff016d50f3c5618c7', 'LAB 16C', 'AU_0003', 'Cubo 16C', '{}', 'cubo-16c', 'lab16c', 'lab16c', 'lab 16c cubo 16c'),
  ('a1a1a1a1a1a1a1a1a1a1a1a1', 'MT2', 'AU_0004', 'Cubo 31B', '{}', 'cubo-31b', 'mt2', 'mt2', 'mt2 cubo 31b');
select results_eq(
  $$select floor, bridge, floor_source from aule.room_view where id = '5fc6b253d0ffc7001bffc0cc'$$,
  $$values (3, null::text, 'admin'::text)$$,
  'the imported floor is the admin floor of the room');
select results_eq(
  $$select floor, bridge, floor_source from aule.room_view where id = '5fc6b254d0ffc7001bffc112'$$,
  $$values (null::integer, 'coperto'::text, 'admin'::text)$$,
  'an imported bridge is the admin value of the room, without a floor');
select results_eq(
  $$select floor, bridge, floor_source from aule.room_view where id = 'a1a1a1a1a1a1a1a1a1a1a1a1'$$,
  $$values (0, null::text, 'seed'::text)$$,
  'control: the seed floor of a room without an admin value');
select lives_ok($$select aule.config_set_room_bridge('a1a1a1a1a1a1a1a1a1a1a1a1', 'scoperto', null)$$, 'the SQL editor puts a room on a bridge');
select results_eq(
  $$select floor, bridge, floor_source from aule.room_view where id = 'a1a1a1a1a1a1a1a1a1a1a1a1'$$,
  $$values (null::integer, 'scoperto'::text, 'admin'::text)$$,
  'the bridge hides the seed floor');

-- The read API: "bridge" next to "floor" in every room object; the map counts a bridge room on slice 4 or 5.
insert into aule.calendars (id, label) values ('161616161616161616161616', 'Calendario di prova') on conflict (id) do nothing;
insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to)
values ('161616161616161616161616', now(), now() - interval '168 hours', now() + interval '336 hours');
insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
  title_text, direct_text, course_text)
values ('161616161616161616161616', 'c1c1c1c1c1c1c1c1c1c1c1c1', 'GEOMETRIA', aule.from_ms(aule.ms(now())) - interval '1 hour',
  aule.from_ms(aule.ms(now())) + interval '1 hour', 'active', '', '{}', null, '{}', '{5fc6b254d0ffc7001bffc112}',
  'geometria', 'geometria', 'geometria');
do $$ begin perform aule.refresh_timetable(); end $$;
create temp table st as select pg_temp.anon('select public.room_status()') as j;
select is(
  (select pg_temp.place(r) || jsonb_build_object('state', r -> 'state') from st, jsonb_array_elements(st.j -> 'rooms') r
    where r ->> 'id' = '5fc6b254d0ffc7001bffc112'),
  '{"floor": null, "bridge": "coperto", "state": "busy"}'::jsonb,
  'room_status: a bridge room has a bridge and no floor');
select is(
  (select pg_temp.place(r) from st, jsonb_array_elements(st.j -> 'rooms') r where r ->> 'id' = '5fc6b253d0ffc7001bffc0cc'),
  '{"floor": 3, "bridge": null}'::jsonb,
  'room_status: a room with a floor has a null bridge');
select is((select j #> '{buildings,cubo-32b}' from st),
  '{"floors": {"4": {"free": 0, "busy": 1, "unknown": 0}}, "unplaced": {"free": 0, "busy": 0, "unknown": 0},
    "total": {"free": 0, "busy": 1, "unknown": 0}}'::jsonb,
  'a room on the ponte coperto counts on slice 4, not as unplaced');
select is((select j #> '{buildings,cubo-16c,floors}' from st), '{"5": {"free": 0, "busy": 0, "unknown": 1}}'::jsonb,
  'a room on the ponte scoperto counts on slice 5');
select is((select j #> '{buildings,cubo-31b}' from st),
  '{"floors": {"5": {"free": 0, "busy": 0, "unknown": 1}}, "unplaced": {"free": 0, "busy": 0, "unknown": 0},
    "total": {"free": 0, "busy": 0, "unknown": 1}}'::jsonb,
  'a seeded room put on a bridge leaves its seed floor');
select is(
  pg_temp.place(pg_temp.anon($$select public.room_lessons('5fc6b254d0ffc7001bffc112')$$) -> 'room'),
  '{"floor": null, "bridge": "coperto"}'::jsonb,
  'room_lessons: the room carries its bridge');
select is(
  pg_temp.place(pg_temp.anon($$select public.search_rooms('32b1')$$) #> '{rooms,0}'),
  '{"floor": null, "bridge": "coperto"}'::jsonb,
  'search_rooms: a room hit carries its bridge');
select is(
  pg_temp.place(pg_temp.anon($$select public.search_rooms('geometria')$$) #> '{lessons,0}'),
  '{"floor": null, "bridge": "coperto"}'::jsonb,
  'search_rooms: a lesson hit carries the bridge of its room');

-- A floor set by an admin before the import is kept: the import statement again, on changed rows.
update aule.room_floors set floor = 9 where room_id = '5fc6b253d0ffc7001bffc0cc';
update aule.room_floors set floor = 4, bridge = null where room_id = '5fc6b254d0ffc7001bffc112';
insert into aule.room_floors (room_id, floor, bridge)
select v.room_id::aule.hex24, v.floor::aule.floor, v.bridge
from (values ('5fc6b253d0ffc7001bffc0cc', 3, null), ('5fc6b254d0ffc7001bffc112', null, 'coperto')) as v(room_id, floor, bridge)
on conflict (room_id) do nothing;
select results_eq(
  $$select room_id::text, floor::integer, bridge from aule.room_floors
    where room_id in ('5fc6b253d0ffc7001bffc0cc', '5fc6b254d0ffc7001bffc112') order by room_id$$,
  $$values ('5fc6b253d0ffc7001bffc0cc', 9, null::text), ('5fc6b254d0ffc7001bffc112', 4, null::text)$$,
  'the admin values are kept');
select is((select count(*)::int from aule.room_floors), 132, 'a repeated import adds nothing');

-- The admin API changes and clears an imported floor or bridge; a floor replaces a bridge and the other way round.
select lives_ok($$select aule.config_set_room_floor('5fc6b253d0ffc7001bffc0cc', 2, null)$$, 'the admin sets another floor');
select is((select floor::integer from aule.room_floors where room_id = '5fc6b253d0ffc7001bffc0cc'), 2, 'the new floor is stored');
select lives_ok($$select aule.config_set_room_bridge('5fc6b253d0ffc7001bffc0cc', 'coperto', null)$$, 'the admin sets a bridge');
select results_eq($$select floor::integer, bridge from aule.room_floors where room_id = '5fc6b253d0ffc7001bffc0cc'$$,
  $$values (null::integer, 'coperto'::text)$$, 'the bridge replaces the floor');
select lives_ok($$select aule.config_set_room_floor('5fc6b253d0ffc7001bffc0cc', 1, null)$$, 'the admin sets a floor again');
select results_eq($$select floor::integer, bridge from aule.room_floors where room_id = '5fc6b253d0ffc7001bffc0cc'$$,
  $$values (1, null::text)$$, 'the floor replaces the bridge');
select lives_ok($$select aule.config_set_room_floor('5fc6b253d0ffc7001bffc0cc', null, null)$$, 'the admin clears the floor');
select results_eq(
  $$select floor, bridge, floor_source from aule.room_view where id = '5fc6b253d0ffc7001bffc0cc'$$,
  $$values (null::integer, null::text, null::text)$$,
  'a cleared floor leaves the room without floor');
select lives_ok($$select aule.config_set_room_bridge('a1a1a1a1a1a1a1a1a1a1a1a1', null, null)$$, 'the admin clears the bridge');
select results_eq(
  $$select floor, bridge, floor_source from aule.room_view where id = 'a1a1a1a1a1a1a1a1a1a1a1a1'$$,
  $$values (0, null::text, 'seed'::text)$$,
  'a cleared bridge gives the seed floor back');
select throws_ok($$select aule.config_set_room_bridge('5fc6b253d0ffc7001bffc0cc', 'pedonale', null)$$, 'P0001', 'invalid',
  'a bridge is coperto or scoperto');

-- Invalid rows never reach the table.
select throws_ok(
  $$insert into aule.room_floors (room_id, floor) values ('ffffffffffffffffffffffff', 13)$$,
  '23514', null, 'the floor domain refuses 13');
select throws_ok(
  $$insert into aule.room_floors (room_id, floor, bridge) values ('ffffffffffffffffffffffff', 4, 'coperto')$$,
  '23514', null, 'a room has a floor or a bridge, not both');
select throws_ok(
  $$insert into aule.room_floors (room_id) values ('ffffffffffffffffffffffff')$$,
  '23514', null, 'a row without floor and bridge is refused');

select * from finish();
rollback;
