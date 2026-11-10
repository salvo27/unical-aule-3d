begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- Feeds seeded by the generated migration 20261110090500_xlsx_feeds.sql from config/diam.json.
select is((select count(*)::int from aule.calendars where source = 'xlsx'), 8, 'eight DIAm xlsx feeds, one per sheet of config/diam.json');
select set_eq(
  $$select id::text, ref from aule.calendars where source = 'xlsx'$$,
  $$values
    ('fffd0b8fe522c44866e6ed7d', 'LT|I ANNO - Ambiente'),
    ('fffdf92377298b291ac2fa49', 'LT|I ANNO - Mare'),
    ('fffde498a7840b1210acfeed', 'LT|II ANNO - Ambiente'),
    ('fffd38245a16a1233b0ff727', 'LT|II ANNO - Mare'),
    ('fffd8e5298735dff3fda0042', 'LT|III ANNO - Ambiente'),
    ('fffd0f4fb57efc3ee540973b', 'LT|III ANNO - Mare'),
    ('fffd93cbfff7d03c4044f546', 'LM|1° LM Ambiente'),
    ('fffd27111a385a1ae3cd25cc', 'LM|2° LM Ambiente')$$,
  'feed ids and refs equal feedId of the TS code');
select is(
  (select count(*)::int from aule.calendars where source = 'xlsx' and id = aule.synthetic_id('fffd', 'xlsx|' || ref)),
  8, 'every xlsx feed id is the synthetic id of its ref, also with a non ASCII sheet name');
select is((select count(*)::int from aule.calendars where source = 'xlsx' and active), 8, 'every xlsx feed is active');
select is(
  (select count(*)::int from aule.calendars
    where source = 'xlsx' and aule.plain(label, 1, 160) and label like 'DIAm · Orario %' and label like '% (xlsx)'),
  8, 'every xlsx feed has a plain DIAm label');
select ok(
  (select bool_and(ref ~ '^(LT|LM)\|[^|]+$' and aule.plain(ref, 1, 200) and ref !~* '-OK$') from aule.calendars where source = 'xlsx'),
  'every ref is a file kind and a sheet name without the -OK suffix');

-- Applying the rows again changes nothing.
select lives_ok(
  $$insert into aule.calendars (id, source, ref, label) values ('fffd0b8fe522c44866e6ed7d', 'xlsx', 'LT|I ANNO - Ambiente', 'Altro nome') on conflict do nothing$$,
  'a repeated feed row is ignored');
select is(
  (select label from aule.calendars where id = 'fffd0b8fe522c44866e6ed7d'),
  'DIAm · Orario 1° anno LT Ingegneria per l''Ambiente e la Sicurezza del Territorio 2026/2027 (xlsx)',
  'the existing label is kept');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label) values ('fffd00000000000000000000', 'xlsx', 'LT|IV ANNO - Prova', 'Foglio di prova')$$,
  '23514', null, 'an xlsx feed id must equal the synthetic id of its ref');

select * from finish();
rollback;
