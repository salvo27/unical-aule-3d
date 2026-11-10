begin;
create extension if not exists pgtap with schema extensions;
select plan(12);

-- Floors imported by 20261110091200_room_floors.sql from the department pages.
select is((select count(*)::int from aule.room_floors), 106, '106 imported room floors');
select ok(
  (select bool_and(room_id ~ '^[0-9a-f]{24}$' and floor between -2 and 12 and updated_by is null) from aule.room_floors),
  'every id is hex24, every floor is in -2..12, no admin is named');
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
select is(
  (select count(*)::int from aule.room_floors where room_id in (
    '5fc6b254d0ffc7001bffc13a', '5fc6b254d0ffc7001bffc160', 'ffff2d8ab5d21e8ce4aa1276', '5fc6b253d0ffc7001bffc0ec',
    '6409ec570c21c0029be9fc21', '5fc6b253d0ffc7001bffc0f4', '63454e0fecfc6300e80afe85')),
  0, 'doubtful rooms are not imported');

-- The floor reaches the room once the timetable holds it.
insert into aule.rooms (id, name, code, building_name, services, building_key_guess, room_key, name_compact, search_text) values
  ('5fc6b253d0ffc7001bffc0cc', 'AULA MAGNA', 'AU_0001', 'Cubo 15B', '{}', 'cubo-15b', 'magna', 'magna', 'aula magna cubo 15b');
select results_eq(
  $$select floor, floor_source from aule.room_view where id = '5fc6b253d0ffc7001bffc0cc'$$,
  $$values (3, 'admin'::text)$$,
  'the imported floor is the admin floor of the room');

-- A floor set by an admin before the import is kept: the import statement again, on a changed row.
update aule.room_floors set floor = 9 where room_id = '5fc6b253d0ffc7001bffc0cc';
insert into aule.room_floors (room_id, floor)
select v.room_id::aule.hex24, v.floor::aule.floor
from (values ('5fc6b253d0ffc7001bffc0cc', 3), ('5fc6b256d0ffc7001bffc1d8', 4)) as v(room_id, floor)
on conflict (room_id) do nothing;
select is((select floor::integer from aule.room_floors where room_id = '5fc6b253d0ffc7001bffc0cc'), 9, 'the admin value is kept');
select is((select count(*)::int from aule.room_floors), 106, 'a repeated import adds nothing');

-- The admin API still changes and clears an imported floor.
select lives_ok($$select aule.config_set_room_floor('5fc6b253d0ffc7001bffc0cc', 2, null)$$, 'the admin sets another floor');
select is((select floor::integer from aule.room_floors where room_id = '5fc6b253d0ffc7001bffc0cc'), 2, 'the new floor is stored');
select lives_ok($$select aule.config_set_room_floor('5fc6b253d0ffc7001bffc0cc', null, null)$$, 'the admin clears the floor');
select results_eq(
  $$select floor, floor_source from aule.room_view where id = '5fc6b253d0ffc7001bffc0cc'$$,
  $$values (null::integer, null::text)$$,
  'a cleared floor leaves the room without floor');

select throws_ok(
  $$insert into aule.room_floors (room_id, floor) values ('ffffffffffffffffffffffff', 13)$$,
  '23514', null, 'the floor domain refuses 13');

select * from finish();
rollback;
