-- Room floors from the "Strutture" pages and maps of the departments, read on 2026-11-10.
-- Only rooms whose floor no source leaves in doubt; a floor already set by an admin is kept.
select pg_advisory_xact_lock(hashtextextended('aule_admin', 0));

insert into aule.room_floors (room_id, floor)
select v.room_id::aule.hex24, v.floor::aule.floor
from (values
  ('5fc6b253d0ffc7001bffc0c4', 1), -- Cubo 4A, L1
  ('6184f6fddbe894001894829a', 1), -- Cubo 4A, L2
  ('5fc6b253d0ffc7001bffc0c6', 1), -- Cubo 4A, L3
  ('64ef39097b22ad003fa4f261', 1), -- Cubo 4A, L4
  ('5fc6b253d0ffc7001bffc0c8', 1), -- Cubo 4A, L5
  ('5fc6b253d0ffc7001bffc0da', 0), -- Cubo 4D, B5
  ('5fc6b253d0ffc7001bffc0dc', 1), -- Cubo 4D, B6
  ('5fc6b253d0ffc7001bffc0e4', 4), -- Cubo 5B, 5B2
  ('5fc6b253d0ffc7001bffc0e2', 4), -- Cubo 5B, 5B3
  ('5fc6b253d0ffc7001bffc0d2', 2), -- Cubo 5C, 5C1
  ('5fc6b253d0ffc7001bffc0d4', 2), -- Cubo 5C, 5C2
  ('5fc6b253d0ffc7001bffc0d6', 4), -- Cubo 5C, 5C3
  ('5fc6b253d0ffc7001bffc0d8', 4), -- Cubo 5C, 5C4
  ('61de8c66ed0cae0018afba16', 4), -- Cubo 6C, Aula Covello
  ('5fc6b257d0ffc7001bffc242', 4), -- Cubo 12B, Aula Restauro
  ('63f71c67a9476c00b59a3390', 3), -- Cubo 15B, Aula A
  ('63f71cc6784b6d0086877cbd', 3), -- Cubo 15B, Aula B
  ('63f71d29f71425001c36b534', 3), -- Cubo 15B, Aula F
  ('61def7f18dbe410017549f2a', 1), -- Cubo 15B, Aula Informatica
  ('5fc6b253d0ffc7001bffc0cc', 3), -- Cubo 15B, AULA MAGNA
  ('5fc6b253d0ffc7001bffc0de', 3), -- Cubo 15B, C
  ('5fc6b253d0ffc7001bffc0e0', 3), -- Cubo 15B, E
  ('5fc6b253d0ffc7001bffc0e8', 1), -- Cubo 15B, M
  ('5fc6b253d0ffc7001bffc0ea', 1), -- Cubo 15B, N
  ('5fc6b252d0ffc7001bffc06a', 6), -- Cubo 15C, CH-15-6A-3T
  ('5fc6b252d0ffc7001bffc06c', 6), -- Cubo 15C, CH-15-6B-1M
  ('6762e74208f809001fd92849', 7), -- Cubo 15C, CH-15-7A
  ('5fc6b252d0ffc7001bffc078', 2), -- Cubo 15C, SEMINARI
  ('5fc6b255d0ffc7001bffc196', 0), -- Cubo 17B, AURORA
  ('5fc6b255d0ffc7001bffc1be', 0), -- Cubo 17B, NETTUNO
  ('5fc6b252d0ffc7001bffc06e', 6), -- Cubo 17C, CH-17-6A-2T
  ('5fc6b252d0ffc7001bffc070', 6), -- Cubo 17C, CH-17-6B-2M
  ('5fc6b252d0ffc7001bffc072', 7), -- Cubo 17C, CH-17-7A-1T
  ('6762e6d708f809001fd9283f', 7), -- Cubo 17C, CH-17-7B
  ('5fc6b253d0ffc7001bffc0ee', 0), -- Cubo 18B, AULA APOLLO
  ('5fc6b253d0ffc7001bffc0f0', 2), -- Cubo 18B, AULA ATHENA
  ('5fc6b253d0ffc7001bffc0f8', 2), -- Cubo 18B, AULA HERA
  ('63da2e06a46cd1111cf19d37', 0), -- Cubo 18B, Aula Ventura
  ('5fc6b253d0ffc7001bffc0fc', 2), -- Cubo 18B, AULA ZEUS
  ('6267c4fc8559050f6b9db546', 0), -- Cubo 30A, LAB 30A
  ('5fc6b253d0ffc7001bffc098', 0), -- Cubo 30A, SALA A
  ('642a8ee996e4e30084c59c22', 2), -- Cubo 30B, Collaborativa
  ('5fc6b252d0ffc7001bffc07a', 2), -- Cubo 30B, MT 10
  ('5fc6b252d0ffc7001bffc07c', 2), -- Cubo 30B, MT 11
  ('5fc6b252d0ffc7001bffc07e', 2), -- Cubo 30B, MT 12
  ('5fc6b252d0ffc7001bffc08c', 0), -- Cubo 30B, MT4
  ('5fc6b252d0ffc7001bffc092', 0), -- Cubo 30B, MT6
  ('5fc6b256d0ffc7001bffc1e8', 0), -- Cubo 30C, E/F
  ('5fc6b256d0ffc7001bffc1ea', 2), -- Cubo 30C, FIS 1
  ('5fc6b256d0ffc7001bffc1ec', 2), -- Cubo 30C, FIS 2
  ('5fc6b256d0ffc7001bffc1ee', 2), -- Cubo 30C, FIS 3
  ('5fc6b256d0ffc7001bffc1f0', 2), -- Cubo 30C, FIS 4
  ('ffff4ec99c98e9bdab35901a', 0), -- Cubo 30C, G
  ('642a8e57cb9284002c9bf870', 1), -- Cubo 31A, DEA
  ('6267b84920067a19a1d1ae8c', 1), -- Cubo 31A, LAB 31A
  ('5fc6b252d0ffc7001bffc084', 1), -- Cubo 31A, Laboratorio di didattica delle scienze empiriche
  ('5fc6b252d0ffc7001bffc08e', 0), -- Cubo 31A, MT5
  ('5fc6b252d0ffc7001bffc090', 0), -- Cubo 31A, MT5 BIS
  ('6267c5d504b40019d0240d6b', 2), -- Cubo 31B, LAB 31B
  ('5fc6b252d0ffc7001bffc080', 2), -- Cubo 31B, MT 13
  ('5fc6b252d0ffc7001bffc082', 2), -- Cubo 31B, MT 14
  ('5fc6b252d0ffc7001bffc086', 0), -- Cubo 31B, MT1
  ('6731d9421a4261001ec14245', 0), -- Cubo 31B, MT23
  ('5fc6b256d0ffc7001bffc1d6', 0), -- Cubo 31C, A
  ('5fc6b256d0ffc7001bffc1d8', 4), -- Cubo 31C, AULA SEMINARI
  ('5fc6b256d0ffc7001bffc1de', 0), -- Cubo 31C, B/C
  ('5fc6b256d0ffc7001bffc1e6', 0), -- Cubo 31C, D
  ('5fc6b256d0ffc7001bffc1f4', 3), -- Cubo 31C, INFORMATICA 1
  ('5fc6b256d0ffc7001bffc1f6', 3), -- Cubo 31C, INFORMATICA 2
  ('5fc6b257d0ffc7001bffc254', 2), -- Cubo 31C, Laboratorio di Elettromagnetismo e Ottica
  ('5fc6b256d0ffc7001bffc1e0', 6), -- Cubo 32C, 32C2
  ('5fc6b256d0ffc7001bffc1e2', 6), -- Cubo 32C, 32C3
  ('5fc6b256d0ffc7001bffc1e4', 4), -- Cubo 32C, Consolidata 32C1
  ('5fc6b254d0ffc7001bffc130', 1), -- Cubo 39B, 39B 1A
  ('5fc6b254d0ffc7001bffc132', 1), -- Cubo 39B, 39B 1B
  ('5fc6b254d0ffc7001bffc134', 1), -- Cubo 39B, 39B 1C
  ('5fc6b254d0ffc7001bffc148', 2), -- Cubo 39C, 39 C 2B
  ('5fc6b254d0ffc7001bffc146', 1), -- Cubo 39C, 39C 1A
  ('5fc6b254d0ffc7001bffc136', 2), -- Cubo 39C, 39C 2A
  ('ffff16683b5b5fe525a34219', 0), -- Cubo 39C, DIAM E
  ('ffff49faf79e3ff2631240fb', 2), -- Cubo 39C, DIAM F
  ('ffffe02b089c791970f21a20', 2), -- Cubo 39C, DIAM G
  ('ffffb1e7c0a77bc5929406a9', 2), -- Cubo 39C, DIAM H
  ('ffff2e3237993d9711e57710', 3), -- Cubo 39C, MOD 3A
  ('5fc6b254d0ffc7001bffc144', 4), -- Cubo 40B, Consolidata 40B1-DINCI
  ('ffff77b39f0c2fe36a2f2f2a', 0), -- Cubo 41B, 41B 0A
  ('5fc6b254d0ffc7001bffc13c', 6), -- Cubo 41B, 41B 6A
  ('ffffbdf294644802417870d0', 2), -- Cubo 41B, DS 5
  ('ffffaa6d3a3762943d73efb8', 2), -- Cubo 41B, DS 6
  ('ffffe1629f9d0c0fa7b3bf93', 2), -- Cubo 41B, DS 7
  ('ffff3cf629a42554130f0aba', 2), -- Cubo 41B, DS 8
  ('5fc6b254d0ffc7001bffc102', 0), -- Cubo 41B, DS4
  ('5fc6b253d0ffc7001bffc0b6', 2), -- Cubo 42B, DIAM - B EXDS9
  ('ffff6349252fafb21aa6f075', 2), -- Cubo 42B, DIAM B
  ('ffffac4ad7e2dcd48be2c411', 2), -- Cubo 42B, DIAM C
  ('ffff8ea9541f43d6372e431b', 2), -- Cubo 42B, DIAM D
  ('ffff001feb48b4064c7696f7', 3), -- Cubo 42C, Aula di automatica
  ('ffff6fb06a5dd9664b0de1f4', 0), -- Cubo 42D, I1
  ('ffff5f8e8498ff80f3f0b9c1', 0), -- Cubo 42D, I2
  ('5fc6b254d0ffc7001bffc104', 1), -- Cubo 44C, M1
  ('5fc6b254d0ffc7001bffc106', 1), -- Cubo 44C, M2
  ('5fc6b254d0ffc7001bffc108', 1), -- Cubo 44C, M3
  ('5fc6b254d0ffc7001bffc13e', 0), -- Cubo 45B, 45B 01
  ('5fc6b254d0ffc7001bffc140', 0), -- Cubo 45B, 45B 02
  ('5fc6b254d0ffc7001bffc142', 0), -- Cubo 45B, 45B 03
  ('6409ecca761fa9037a1fd23b', 0) -- Cubo 46B, LABORATORIO DIDATTICO INGEGNERIA DEI TRASPORTI
) as v(room_id, floor)
on conflict (room_id) do nothing;

do $$
begin
  if (select count(*) from aule.room_floors) > 3000 then
    raise exception 'too_many_rooms' using errcode = 'P0001';
  end if;
end
$$;
