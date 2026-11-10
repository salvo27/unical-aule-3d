begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Feed seeded by the generated migration 20261110090800_dimes_feeds.sql from config/dimes.json.
select is((select count(*)::int from aule.calendars where source = 'dimes'), 1, 'one DIMES feed, the timetable app');
select set_eq(
  $$select id::text, ref from aule.calendars where source = 'dimes'$$,
  $$values ('fffd8f89e0e2c0fae1ea60a6', 'https://orariocorsi.dimes.unical.it/')$$,
  'feed id and ref equal feedId of the TS code');
select is(
  (select count(*)::int from aule.calendars where source = 'dimes' and id = aule.synthetic_id('fffd', 'dimes|' || ref)),
  1, 'the feed id is the synthetic id of its ref');
select ok(
  (select bool_and(aule.source_url_ok(ref) and ref !~ '[?#]') from aule.calendars where source = 'dimes'),
  'the ref is a canonical unical.it URL without query');
select is((select count(*)::int from aule.calendars where source = 'dimes' and active), 1, 'the DIMES feed is active');
select is(
  (select count(*)::int from aule.calendars
    where source = 'dimes' and aule.plain(label, 1, 160) and label like 'DIMES · %'),
  1, 'the DIMES feed has a plain DIMES label');

-- Applying the row again changes nothing.
select lives_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values ('fffd8f89e0e2c0fae1ea60a6', 'dimes', 'https://orariocorsi.dimes.unical.it/', 'Altro nome') on conflict do nothing$$,
  'a repeated feed row is ignored');
select is(
  (select label::text from aule.calendars where id = 'fffd8f89e0e2c0fae1ea60a6'),
  'DIMES · Orario delle lezioni 2026/2027 (app Orario DIMES)',
  'the existing label is kept');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values ('fffd00000000000000000000', 'dimes', 'https://orario.prova.unical.it/', 'Orario di prova')$$,
  '23514', null, 'a dimes feed id must equal the synthetic id of its ref');

select * from finish();
rollback;
