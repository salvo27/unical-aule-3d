begin;
create extension if not exists pgtap with schema extensions;
select plan(22);

-- Feeds seeded by the generated migration 20261110091000_pdf_feeds.sql from config/pdf.json (profiles discag, disu).
select is((select count(*)::int from aule.calendars where source = 'pdf'), 24, 'every pdf feed comes from the generated migration');
select is((select count(distinct added_at)::int from aule.calendars where source = 'pdf'), 24, 'one added_at per feed, in the order of the file');
select is((select count(*)::int from aule.calendars where source = 'pdf' and ref like 'discag:%'), 6, 'six DISCAG pdf feeds, one per file');
select set_eq(
  $$select id::text, ref from aule.calendars where source = 'pdf' and ref like 'discag:%'$$,
  $$values
    ('fffdbb5f2dc57f2a783e969d', 'discag:0881'),
    ('fffd1e708ad8fd149250da22', 'discag:0884'),
    ('fffdd314dd400c2b2c00305d', 'discag:0882'),
    ('fffdac7d8285cbbadcab44c7', 'discag:0883'),
    ('fffd4b778f293ca60ebaef61', 'discag:0885'),
    ('fffddbaa031332cc90979e94', 'discag:0880')$$,
  'feed ids and refs equal feedId of the TS code');
select is(
  (select count(*)::int from aule.calendars where source = 'pdf' and ref like 'discag:%' and id = aule.synthetic_id('fffd', 'pdf|' || ref)),
  6, 'every pdf feed id is the synthetic id of its ref');
select ok(
  (select bool_and(ref ~ '^discag:[0-9]{4}$') from aule.calendars where source = 'pdf' and ref like 'discag:%'),
  'every ref is the profile and a course code');
select is((select count(*)::int from aule.calendars where source = 'pdf' and ref like 'discag:%' and active), 6, 'every DISCAG feed is active');
select is(
  (select count(*)::int from aule.calendars
    where source = 'pdf' and ref like 'discag:%' and aule.plain(label, 1, 160) and label like 'DISCAG · Orario %' and label like '% (PDF)'),
  6, 'every DISCAG feed has a plain label');

-- DiSU: one feed per PDF file, the ref is the profile and the key of the file.
select is((select count(*)::int from aule.calendars where source = 'pdf' and ref like 'disu:%'), 18, 'eighteen DiSU pdf feeds, one per file');
select set_eq(
  $$select id::text, ref from aule.calendars where source = 'pdf' and ref like 'disu:%'$$,
  $$values
    ('fffd31f119968caf169d9195', 'disu:cd-l3'),
    ('fffd3469e0e7f372783344c8', 'disu:cd-l20'),
    ('fffdd39fd53b36cc1881263d', 'disu:fs-l5'),
    ('fffd15f1d1f7aa8bece94bb8', 'disu:fs-l42'),
    ('fffdeabc04f29a79a6ce02c8', 'disu:let-classico'),
    ('fffdf1ee2b6a269867c31ff2', 'disu:let-moderno'),
    ('fffd5327f3005f6535eaa0eb', 'disu:let-beniculturali'),
    ('fffd18c18810ee9d15453d61', 'disu:lbc-l10-classico'),
    ('fffddcd223a08df6bdc7aec6', 'disu:lbc-l10-moderno'),
    ('fffd4f7964b80ace655be002', 'disu:lbc-l1-archeologico'),
    ('fffd7fcd070f70c97b4a5543', 'disu:lbc-l1-moderno'),
    ('fffde5b85f33092244080d76', 'disu:lcm'),
    ('fffdff0985930222bc184d15', 'disu:fm'),
    ('fffd6c3b1b65080ef4e9af61', 'disu:lcs'),
    ('fffdfc5cadb2e5a64d659b08', 'disu:llm'),
    ('fffd28aeef88d7d04220712b', 'disu:sa'),
    ('fffd0dd65bda2136038f7b12', 'disu:sf'),
    ('fffdd6acdb2cba99da722e8e', 'disu:sspc')$$,
  'DiSU feed ids and refs equal feedId of the TS code');
select is(
  (select count(*)::int from aule.calendars where source = 'pdf' and ref like 'disu:%' and id = aule.synthetic_id('fffd', 'pdf|' || ref)),
  18, 'every DiSU feed id is the synthetic id of its ref');
select ok(
  (select bool_and(ref ~ '^disu:[a-z0-9-]{1,40}$') from aule.calendars where source = 'pdf' and ref like 'disu:%'),
  'every DiSU ref is the profile and the key of a file');
select is((select count(*)::int from aule.calendars where source = 'pdf' and ref like 'disu:%' and active), 18, 'every DiSU feed is active');
select is(
  (select count(*)::int from aule.calendars
    where source = 'pdf' and ref like 'disu:%' and aule.plain(label, 1, 160) and label like 'DiSU · Orario %' and label like '% 2026/2027 1S (PDF)'),
  18, 'every DiSU feed has a plain label');

-- Applying the rows again changes nothing.
select lives_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values ('fffdbb5f2dc57f2a783e969d', 'pdf', 'discag:0881', 'Altro nome') on conflict do nothing$$,
  'a repeated feed row is ignored');
select is(
  (select label::text from aule.calendars where id = 'fffdbb5f2dc57f2a783e969d'),
  'DISCAG · Orario Economia Aziendale (L) 2026/2027 1S (PDF)',
  'the existing label is kept');

-- Ref rules after the split of calendars_url_ref.
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values (aule.synthetic_id('fffd', 'pdf|discag 0999'), 'pdf', 'discag 0999', 'Orario di prova')$$,
  '23514', null, 'a pdf ref is a profile and a key');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values (aule.synthetic_id('fffd', 'pdf|DISCAG:0999'), 'pdf', 'DISCAG:0999', 'Orario di prova')$$,
  '23514', null, 'the profile of a pdf ref is lower case');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label) values ('fffd00000000000000000000', 'pdf', 'prova:0999', 'Orario di prova')$$,
  '23514', null, 'a pdf feed id must equal the synthetic id of its ref');
select lives_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values (aule.synthetic_id('fffd', 'pdf|prova:0999'), 'pdf', 'prova:0999', 'Orario di prova')$$,
  'a pdf feed of another profile is accepted');
select lives_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values (aule.synthetic_id('fffd', 'pdf|https://www.unical.it/orario-di-prova.pdf'), 'pdf', 'https://www.unical.it/orario-di-prova.pdf', 'Orario PDF')$$,
  'a pdf feed with a canonical unical URL is still accepted');
select throws_ok(
  $$insert into aule.calendars (id, source, ref, label)
    values (aule.synthetic_id('fffd', 'dimes|prova:0999'), 'dimes', 'prova:0999', 'Orario di prova')$$,
  '23514', null, 'a dimes feed still needs a canonical url');

select * from finish();
rollback;
