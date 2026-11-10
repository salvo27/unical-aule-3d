-- Room floors from the "Strutture" pages and maps of the departments, read on 2026-11-10, with the owner's choices for
-- the doubtful rooms. A room on one of the two bridges keeps the bridge instead of a number: 'coperto' is the pedestrian
-- one, 'scoperto' the vehicular one above it. A floor or bridge already set by an admin is kept.
select pg_advisory_xact_lock(hashtextextended('aule_admin', 0));

alter table aule.room_floors alter column floor drop not null;
alter table aule.room_floors add column bridge text;
alter table aule.room_floors add constraint room_floors_bridge check (bridge in ('coperto', 'scoperto'));
alter table aule.room_floors add constraint room_floors_place check ((floor is null) <> (bridge is null));

insert into aule.room_floors (room_id, floor, bridge)
select v.room_id::aule.hex24, v.floor::aule.floor, v.bridge
from (values
  ('5fc6b253d0ffc7001bffc0c4', 1, null), -- Cubo 4A, L1
  ('6184f6fddbe894001894829a', 1, null), -- Cubo 4A, L2
  ('5fc6b253d0ffc7001bffc0c6', 1, null), -- Cubo 4A, L3
  ('64ef39097b22ad003fa4f261', 1, null), -- Cubo 4A, L4
  ('5fc6b253d0ffc7001bffc0c8', 1, null), -- Cubo 4A, L5
  ('5fc6b253d0ffc7001bffc0da', 0, null), -- Cubo 4D, B5
  ('5fc6b253d0ffc7001bffc0dc', 1, null), -- Cubo 4D, B6
  ('5fc6b253d0ffc7001bffc0e4', 4, null), -- Cubo 5B, 5B2
  ('5fc6b253d0ffc7001bffc0e2', 4, null), -- Cubo 5B, 5B3
  ('5fc6b253d0ffc7001bffc0d2', 2, null), -- Cubo 5C, 5C1
  ('5fc6b253d0ffc7001bffc0d4', 2, null), -- Cubo 5C, 5C2
  ('5fc6b253d0ffc7001bffc0d6', 4, null), -- Cubo 5C, 5C3
  ('5fc6b253d0ffc7001bffc0d8', 4, null), -- Cubo 5C, 5C4
  ('61de8c66ed0cae0018afba16', 4, null), -- Cubo 6C, Aula Covello
  ('5fc6b257d0ffc7001bffc242', 4, null), -- Cubo 12B, Aula Restauro
  ('63f71c67a9476c00b59a3390', 3, null), -- Cubo 15B, Aula A
  ('63f71cc6784b6d0086877cbd', 3, null), -- Cubo 15B, Aula B
  ('63f71d29f71425001c36b534', 3, null), -- Cubo 15B, Aula F
  ('61def7f18dbe410017549f2a', 1, null), -- Cubo 15B, Aula Informatica
  ('5fc6b253d0ffc7001bffc0cc', 3, null), -- Cubo 15B, AULA MAGNA
  ('5fc6b253d0ffc7001bffc0de', 3, null), -- Cubo 15B, C
  ('5fc6b253d0ffc7001bffc0e0', 3, null), -- Cubo 15B, E
  ('5fc6b253d0ffc7001bffc0e8', 1, null), -- Cubo 15B, M
  ('5fc6b253d0ffc7001bffc0ea', 1, null), -- Cubo 15B, N
  ('5fc6b252d0ffc7001bffc06a', 6, null), -- Cubo 15C, CH-15-6A-3T
  ('5fc6b252d0ffc7001bffc06c', 6, null), -- Cubo 15C, CH-15-6B-1M
  ('6762e74208f809001fd92849', 7, null), -- Cubo 15C, CH-15-7A
  ('5fc6b252d0ffc7001bffc078', 2, null), -- Cubo 15C, SEMINARI
  ('6267b13ff016d50f3c5618c7', null, 'scoperto'), -- Cubo 16C, LAB 16C
  ('5fc6b255d0ffc7001bffc196', 0, null), -- Cubo 17B, AURORA
  ('5fc6b255d0ffc7001bffc1be', 0, null), -- Cubo 17B, NETTUNO
  ('5fc6b252d0ffc7001bffc06e', 6, null), -- Cubo 17C, CH-17-6A-2T
  ('5fc6b252d0ffc7001bffc070', 6, null), -- Cubo 17C, CH-17-6B-2M
  ('5fc6b252d0ffc7001bffc072', 7, null), -- Cubo 17C, CH-17-7A-1T
  ('6762e6d708f809001fd9283f', 7, null), -- Cubo 17C, CH-17-7B
  ('5fc6b253d0ffc7001bffc0ee', 0, null), -- Cubo 18B, AULA APOLLO
  ('5fc6b253d0ffc7001bffc0f0', 2, null), -- Cubo 18B, AULA ATHENA
  ('5fc6b253d0ffc7001bffc0f8', 2, null), -- Cubo 18B, AULA HERA
  ('63da2e06a46cd1111cf19d37', 0, null), -- Cubo 18B, Aula Ventura
  ('5fc6b253d0ffc7001bffc0fc', 2, null), -- Cubo 18B, AULA ZEUS
  ('5fc6b253d0ffc7001bffc0fa', null, 'scoperto'), -- Cubo 19B, Consolidata 19B2
  ('5fc6b253d0ffc7001bffc0ec', null, 'coperto'), -- Cubo 20B, AULA A
  ('5fc6b253d0ffc7001bffc0f2', null, 'coperto'), -- Cubo 20B, AULA B
  ('5fc6b254d0ffc7001bffc162', null, 'scoperto'), -- Cubo 29B, 29B2
  ('5fc6b254d0ffc7001bffc164', null, 'scoperto'), -- Cubo 29B, 29B3
  ('5fc6b254d0ffc7001bffc160', null, 'coperto'), -- Cubo 29B, Consolidata 29B1
  ('5fc6b255d0ffc7001bffc1b8', null, 'coperto'), -- Cubo 29C, Consolidata 29C1-Iris
  ('6267c4fc8559050f6b9db546', 0, null), -- Cubo 30A, LAB 30A
  ('5fc6b253d0ffc7001bffc098', 0, null), -- Cubo 30A, SALA A
  ('642a8ee996e4e30084c59c22', 2, null), -- Cubo 30B, Collaborativa
  ('5fc6b252d0ffc7001bffc07a', 2, null), -- Cubo 30B, MT 10
  ('5fc6b252d0ffc7001bffc07c', 2, null), -- Cubo 30B, MT 11
  ('5fc6b252d0ffc7001bffc07e', 2, null), -- Cubo 30B, MT 12
  ('5fc6b252d0ffc7001bffc08c', 0, null), -- Cubo 30B, MT4
  ('5fc6b252d0ffc7001bffc092', 0, null), -- Cubo 30B, MT6
  ('5fc6b256d0ffc7001bffc1e8', 0, null), -- Cubo 30C, E/F
  ('5fc6b256d0ffc7001bffc1ea', 2, null), -- Cubo 30C, FIS 1
  ('5fc6b256d0ffc7001bffc1ec', 2, null), -- Cubo 30C, FIS 2
  ('5fc6b256d0ffc7001bffc1ee', 2, null), -- Cubo 30C, FIS 3
  ('5fc6b256d0ffc7001bffc1f0', 2, null), -- Cubo 30C, FIS 4
  ('ffff4ec99c98e9bdab35901a', 0, null), -- Cubo 30C, G
  ('642a8e57cb9284002c9bf870', 1, null), -- Cubo 31A, DEA
  ('6267b84920067a19a1d1ae8c', 1, null), -- Cubo 31A, LAB 31A
  ('5fc6b252d0ffc7001bffc084', 1, null), -- Cubo 31A, Laboratorio di didattica delle scienze empiriche
  ('5fc6b252d0ffc7001bffc08e', 0, null), -- Cubo 31A, MT5
  ('5fc6b252d0ffc7001bffc090', 0, null), -- Cubo 31A, MT5 BIS
  ('6267c5d504b40019d0240d6b', 2, null), -- Cubo 31B, LAB 31B
  ('5fc6b252d0ffc7001bffc080', 2, null), -- Cubo 31B, MT 13
  ('5fc6b252d0ffc7001bffc082', 2, null), -- Cubo 31B, MT 14
  ('5fc6b252d0ffc7001bffc086', 0, null), -- Cubo 31B, MT1
  ('6731d9421a4261001ec14245', 0, null), -- Cubo 31B, MT23
  ('5fc6b256d0ffc7001bffc1d6', 0, null), -- Cubo 31C, A
  ('5fc6b256d0ffc7001bffc1d8', 4, null), -- Cubo 31C, AULA SEMINARI
  ('5fc6b256d0ffc7001bffc1de', 0, null), -- Cubo 31C, B/C
  ('5fc6b256d0ffc7001bffc1e6', 0, null), -- Cubo 31C, D
  ('5fc6b256d0ffc7001bffc1f4', 3, null), -- Cubo 31C, INFORMATICA 1
  ('5fc6b256d0ffc7001bffc1f6', 3, null), -- Cubo 31C, INFORMATICA 2
  ('5fc6b257d0ffc7001bffc254', 2, null), -- Cubo 31C, Laboratorio di Elettromagnetismo e Ottica
  ('ffff978cb3f23c610773028a', null, 'scoperto'), -- Cubo 32B, 32B2
  ('ffff3cda0d856ee7850d9f87', null, 'scoperto'), -- Cubo 32B, 32B3
  ('5fc6b254d0ffc7001bffc112', null, 'coperto'), -- Cubo 32B, Consolidata 32B1
  ('5fc6b256d0ffc7001bffc1e0', 6, null), -- Cubo 32C, 32C2
  ('5fc6b256d0ffc7001bffc1e2', 6, null), -- Cubo 32C, 32C3
  ('5fc6b256d0ffc7001bffc1e4', 4, null), -- Cubo 32C, Consolidata 32C1
  ('5fc6b254d0ffc7001bffc130', 1, null), -- Cubo 39B, 39B 1A
  ('5fc6b254d0ffc7001bffc132', 1, null), -- Cubo 39B, 39B 1B
  ('5fc6b254d0ffc7001bffc134', 1, null), -- Cubo 39B, 39B 1C
  ('5fc6b254d0ffc7001bffc148', 2, null), -- Cubo 39C, 39 C 2B
  ('5fc6b254d0ffc7001bffc146', 1, null), -- Cubo 39C, 39C 1A
  ('5fc6b254d0ffc7001bffc136', 2, null), -- Cubo 39C, 39C 2A
  ('ffff5417d9d8c137ae022128', 6, null), -- Cubo 39C, Aula collab. 39C
  ('ffff16683b5b5fe525a34219', 0, null), -- Cubo 39C, DIAM E
  ('ffff49faf79e3ff2631240fb', 2, null), -- Cubo 39C, DIAM F
  ('ffffe02b089c791970f21a20', 2, null), -- Cubo 39C, DIAM G
  ('ffffb1e7c0a77bc5929406a9', 2, null), -- Cubo 39C, DIAM H
  ('ffff2e3237993d9711e57710', 3, null), -- Cubo 39C, MOD 3A
  ('ffff2d8ab5d21e8ce4aa1276', null, 'coperto'), -- Cubo 39C, MOD 4
  ('ffff0e9187c5b7a6fe891a16', null, 'coperto'), -- Cubo 39C, MOD 5
  ('5fc6b254d0ffc7001bffc144', 4, null), -- Cubo 40B, Consolidata 40B1-DINCI
  ('63524942d07a3e0cfd3e8e99', 7, null), -- Cubo 40B, LABINFO40B - Sala B
  ('635244157735f207681eeaa9', 7, null), -- Cubo 40C, LABINFO40B - Sala A
  ('ffff77b39f0c2fe36a2f2f2a', 0, null), -- Cubo 41B, 41B 0A
  ('5fc6b254d0ffc7001bffc13c', 6, null), -- Cubo 41B, 41B 6A
  ('ffffbdf294644802417870d0', 2, null), -- Cubo 41B, DS 5
  ('ffffaa6d3a3762943d73efb8', 2, null), -- Cubo 41B, DS 6
  ('ffffe1629f9d0c0fa7b3bf93', 2, null), -- Cubo 41B, DS 7
  ('ffff3cf629a42554130f0aba', 2, null), -- Cubo 41B, DS 8
  ('5fc6b254d0ffc7001bffc102', 0, null), -- Cubo 41B, DS4
  ('ffffb9e405a69439f53756f9', 1, null), -- Cubo 41C, Laboratorio didattico 41C
  ('5fc6b253d0ffc7001bffc0b6', 2, null), -- Cubo 42B, DIAM - B EXDS9
  ('ffff6349252fafb21aa6f075', 2, null), -- Cubo 42B, DIAM B
  ('ffffac4ad7e2dcd48be2c411', 2, null), -- Cubo 42B, DIAM C
  ('ffff8ea9541f43d6372e431b', 2, null), -- Cubo 42B, DIAM D
  ('ffff001feb48b4064c7696f7', 3, null), -- Cubo 42C, Aula di automatica
  ('ffff2d9e51fb0136fadda443', 1, null), -- Cubo 42C, Laboratorio di elettronica
  ('ffff6fb06a5dd9664b0de1f4', 0, null), -- Cubo 42D, I1
  ('ffff5f8e8498ff80f3f0b9c1', 0, null), -- Cubo 42D, I2
  ('ffff10107704a7accadeb9e3', 0, null), -- Cubo 42D, LABINFO42D
  ('ffff272ff02ab596f15a3f3d', null, 'scoperto'), -- Cubo 43B, 43B2
  ('5fc6b254d0ffc7001bffc12c', null, 'scoperto'), -- Cubo 43B, 43B3
  ('5fc6b253d0ffc7001bffc0fe', null, 'coperto'), -- Cubo 43B, Consolidata 43B1
  ('5fc6b253d0ffc7001bffc100', null, 'coperto'), -- Cubo 43C, Consolidata 43C1
  ('5fc6b254d0ffc7001bffc13a', null, 'coperto'), -- Cubo 44B, 44B 4A
  ('5fc6b254d0ffc7001bffc104', 1, null), -- Cubo 44C, M1
  ('5fc6b254d0ffc7001bffc106', 1, null), -- Cubo 44C, M2
  ('5fc6b254d0ffc7001bffc108', 1, null), -- Cubo 44C, M3
  ('5fc6b254d0ffc7001bffc13e', 0, null), -- Cubo 45B, 45B 01
  ('5fc6b254d0ffc7001bffc140', 0, null), -- Cubo 45B, 45B 02
  ('5fc6b254d0ffc7001bffc142', 0, null), -- Cubo 45B, 45B 03
  ('6409ec570c21c0029be9fc21', null, 'scoperto'), -- Cubo 45B, Aula seminari
  ('6409ecca761fa9037a1fd23b', 0, null) -- Cubo 46B, LABORATORIO DIDATTICO INGEGNERIA DEI TRASPORTI
) as v(room_id, floor, bridge)
on conflict (room_id) do nothing;

do $$
begin
  if (select count(*) from aule.room_floors) > 3000 then
    raise exception 'too_many_rooms' using errcode = 'P0001';
  end if;
end
$$;
