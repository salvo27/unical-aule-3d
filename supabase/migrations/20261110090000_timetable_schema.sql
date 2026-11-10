-- Timetable schema: roles, schema aule, helpers, domains, tables, grants, RLS and the room view.
-- Every privilege is explicit. Nothing in schema aule is reachable by anon, authenticated or service_role.

alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;

-- Roles survive a database reset, so they are created only when missing. LOGIN is never set here.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'aule_ingest') then
    create role aule_ingest nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aule_reader') then
    create role aule_reader nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aule_config') then
    create role aule_config nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'aule_sync') then
    create role aule_sync nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 2;
  end if;
end $$;
alter role aule_sync noinherit nocreatedb nocreaterole connection limit 2;
alter role aule_sync set statement_timeout = '60s';
alter role aule_sync set lock_timeout = '10s';
alter role aule_sync set idle_in_transaction_session_timeout = '60s';
alter role aule_sync set search_path = '';
alter role aule_ingest noinherit nocreatedb nocreaterole;
alter role aule_reader noinherit nocreatedb nocreaterole;
alter role aule_config noinherit nocreatedb nocreaterole;
grant aule_ingest, aule_reader, aule_config, aule_sync to postgres with inherit false, set true;

create schema aule;
revoke all on schema aule from public, anon, authenticated, service_role;
grant usage on schema aule to aule_reader, aule_ingest, aule_config;
grant usage on schema public to aule_reader, aule_config;

-- Pure helpers. Domain and table checks call them with the privileges of the writer.

-- A value that JS trim() would change, or that contains a control character, is refused. SQL never trims.
create function aule.plain(v text, min integer, max integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    v is not null
    and char_length(v) between min and max
    and v !~ '[\u0001-\u001f\u007f-\u009f]'
    and (char_length(v) = 0 or (
      v !~ '^[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
      and v !~ '[ \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]$'
    )),
    false)
$$;
revoke all on function aule.plain(text, integer, integer) from public, anon, authenticated, service_role;
grant execute on function aule.plain(text, integer, integer) to aule_reader, aule_ingest, aule_config;

-- The canonical href that sourceUrl() returns.
create function aule.source_url_ok(v text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    v is not null
    and char_length(v) <= 500
    and v ~ '^https://([a-z0-9-]+\.)*unical\.it/[!-~]*$'
    and v !~ '#',
    false)
$$;
revoke all on function aule.source_url_ok(text) from public, anon, authenticated, service_role;
grant execute on function aule.source_url_ok(text) to aule_reader, aule_ingest, aule_config;

create function aule.all_hex24(a text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when a is null or coalesce(array_ndims(a), 1) <> 1 then false
    else array_position(a, null) is null
      and not exists (select 1 from unnest(a) as e(v) where v !~ '^[0-9a-f]{24}$')
  end
$$;
revoke all on function aule.all_hex24(text[]) from public, anon, authenticated, service_role;
grant execute on function aule.all_hex24(text[]) to aule_reader, aule_ingest, aule_config;

create function aule.texts_ok(a text[], max_count integer, max_len integer)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when a is null or max_count is null or max_len is null or coalesce(array_ndims(a), 1) <> 1 then false
    else cardinality(a) <= max_count
      and not exists (select 1 from unnest(a) as e(v) where not aule.plain(v, 1, max_len))
  end
$$;
revoke all on function aule.texts_ok(text[], integer, integer) from public, anon, authenticated, service_role;
grant execute on function aule.texts_ok(text[], integer, integer) to aule_reader, aule_ingest, aule_config;

-- Same formula as syntheticId() in src/domain/ids.ts. Immutable because the database encoding is fixed.
create function aule.synthetic_id(prefix text, key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select prefix || left(encode(sha256(convert_to(key, 'UTF8')), 'hex'), 20)
$$;
revoke all on function aule.synthetic_id(text, text) from public, anon, authenticated, service_role;
grant execute on function aule.synthetic_id(text, text) to aule_reader, aule_ingest, aule_config;

create function aule.ms(t timestamptz)
returns bigint
language sql
immutable
set search_path = ''
as $$
  select floor(extract(epoch from t) * 1000)::bigint
$$;
revoke all on function aule.ms(timestamptz) from public, anon, authenticated, service_role;
grant execute on function aule.ms(timestamptz) to aule_reader, aule_ingest, aule_config;

create function aule.from_ms(ms bigint)
returns timestamptz
language sql
immutable
set search_path = ''
as $$
  select pg_catalog.timestamptz 'epoch' + ms * interval '1 millisecond'
$$;
revoke all on function aule.from_ms(bigint) from public, anon, authenticated, service_role;
grant execute on function aule.from_ms(bigint) to aule_reader, aule_ingest, aule_config;

create function aule.ms_exact(t timestamptz)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select t is not null and extract(epoch from t) * 1000 = floor(extract(epoch from t) * 1000)
$$;
revoke all on function aule.ms_exact(timestamptz) from public, anon, authenticated, service_role;
grant execute on function aule.ms_exact(timestamptz) to aule_reader, aule_ingest, aule_config;

create function aule.rome_day(t timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (t at time zone 'Europe/Rome')::pg_catalog.date
$$;
revoke all on function aule.rome_day(timestamptz) from public, anon, authenticated, service_role;
grant execute on function aule.rome_day(timestamptz) to aule_reader, aule_ingest, aule_config;

create function aule.rome_midnight(d date)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select d::timestamp at time zone 'Europe/Rome'
$$;
revoke all on function aule.rome_midnight(date) from public, anon, authenticated, service_role;
grant execute on function aule.rome_midnight(date) to aule_reader, aule_ingest, aule_config;

-- Local wall clock time in Rome, right on daylight saving days.
create function aule.rome_time(d date, t time)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select (d + t) at time zone 'Europe/Rome'
$$;
revoke all on function aule.rome_time(date, time) from public, anon, authenticated, service_role;
grant execute on function aule.rome_time(date, time) to aule_reader, aule_ingest, aule_config;

create function aule.default_shape(key text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case
    when starts_with(key, 'cubo-') then '{"floors":5,"baseLevel":0}'::pg_catalog.jsonb
    else '{"floors":2,"baseLevel":0}'::pg_catalog.jsonb
  end
$$;
revoke all on function aule.default_shape(text) from public, anon, authenticated, service_role;
grant execute on function aule.default_shape(text) to aule_reader, aule_ingest, aule_config;

-- Domains: mirror of src/domain/primitives.ts.
create domain aule.hex24 as text check (value ~ '^[0-9a-f]{24}$');
create domain aule.campus_key as text check (value ~ '^[a-z0-9-]{1,80}$');
create domain aule.label as text check (aule.plain(value, 1, 160));
create domain aule.floor as integer check (value between -2 and 12);
create domain aule.floor_count as integer check (value between 1 and 15);
create domain aule.base_level as integer check (value between 0 and 12);
create domain aule.source_url as text check (aule.source_url_ok(value));
-- The output of searchText(): normalized, lower case, single ASCII spaces, no combining marks.
create domain aule.search_text as text check (
  aule.plain(value, 1, 60)
  and value !~ '[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]'
  and value !~ '  '
  and value !~ '[\u0300-\u036f]'
  and value = lower(value)
);
create domain aule.iso_day as date check (value between date '2020-01-01' and date '2099-12-31');
create domain aule.portal_code as text check (value ~ '^[A-Z0-9]{2,12}$');
create domain aule.failure_code as text check (value in (
  'network', 'timeout', 'http_status', 'too_large', 'bad_json', 'bad_shape', 'bad_html', 'too_many',
  'wrong_period', 'client_id', 'rejected', 'unsupported', 'unexpected', 'missing', 'abandoned', 'implausible'
));
create domain aule.discover_failure as text check (value in (
  'network', 'http_status', 'redirect_blocked', 'not_html', 'too_large', 'too_many_redirects', 'unexpected'
));

create type aule.lesson_status as enum ('active', 'cancelled');
create type aule.sync_trigger as enum ('schedule', 'request', 'manual');
create type aule.run_state as enum ('open', 'finished', 'abandoned', 'aborted');
create type aule.run_kind as enum ('sync', 'discover');
create type aule.calendar_outcome as enum ('ok', 'failed');
create type aule.feed_source as enum ('planner', 'portal', 'dimes', 'xlsx', 'pdf');

-- Priority of a source when two sources hold the same lesson: lower wins.
create function aule.source_rank(s aule.feed_source)
returns integer
language sql
immutable
set search_path = ''
as $$
  select case s when 'planner' then 0 when 'portal' then 1 when 'dimes' then 2 when 'xlsx' then 3 when 'pdf' then 4 end
$$;
revoke all on function aule.source_rank(aule.feed_source) from public, anon, authenticated, service_role;
grant execute on function aule.source_rank(aule.feed_source) to aule_reader, aule_ingest, aule_config;

-- localeCompare(..., 'it', { numeric: true }): 'B9' before 'B10'.
create collation aule.it_num (provider = icu, locale = 'it-u-kn-true');

-- Configuration. Never references timetable tables: rooms come and go, configuration stays.

create table aule.settings (
  id boolean primary key default true check (id),
  stale_after interval not null default '30 hours' check (stale_after between '1 hour' and '240 hours'),
  window_back_days integer not null default 7 check (window_back_days between 1 and 30),
  window_ahead_days integer not null default 15 check (window_ahead_days between 1 and 60),
  late_after interval not null default '26 hours' check (late_after between '1 hour' and '240 hours'),
  run_lease interval not null default '25 minutes' check (run_lease between '1 minute' and '24 hours'),
  run_idle interval not null default '5 minutes' check (run_idle between '1 minute' and '24 hours'),
  request_cooldown interval not null default '15 minutes' check (request_cooldown between '0 minutes' and '24 hours'),
  max_runs_per_day integer not null default 12 check (max_runs_per_day between 1 and 96),
  sync_slots time[] not null default '{06:17,13:17}'
    check (cardinality(sync_slots) between 1 and 6 and array_position(sync_slots, null) is null),
  implausible_drop numeric not null default 0.5 check (implausible_drop between 0 and 1),
  implausible_min_lessons integer not null default 1000 check (implausible_min_lessons >= 0),
  implausible_age interval not null default '48 hours' check (implausible_age between '1 hour' and '720 hours'),
  run_retention interval not null default '1440 hours' check (run_retention between '24 hours' and '8760 hours')
);
insert into aule.settings default values;

create table aule.campus_buildings (
  key aule.campus_key primary key,
  name text not null check (aule.plain(name, 1, 100))
);

create table aule.room_seeds (
  building_key aule.campus_key not null references aule.campus_buildings (key) on delete cascade,
  room_key text not null check (room_key ~ '^[a-z0-9]{1,100}$'),
  floor aule.floor not null,
  primary key (building_key, room_key)
);

-- Feeds: Planner calendars (ref null) and the other sources (synthetic id from source and ref).
create table aule.calendars (
  id aule.hex24 primary key,
  source aule.feed_source not null default 'planner',
  ref text,
  label aule.label not null,
  active boolean not null default true,
  added_at timestamptz not null default now(),
  constraint calendars_ref check ((source = 'planner') = (ref is null)),
  constraint calendars_id check (
    (source = 'planner' and id !~ '^fff')
    or (source <> 'planner' and id = aule.synthetic_id('fffd', source::text || '|' || ref))
  ),
  constraint calendars_portal_ref check (source <> 'portal' or ref ~ '^[A-Z0-9]{2,12}$'),
  constraint calendars_url_ref check (source not in ('dimes', 'pdf') or aule.source_url_ok(ref)),
  constraint calendars_xlsx_ref check (source <> 'xlsx' or aule.plain(ref, 1, 200))
);

create table aule.sources (
  position smallint primary key check (position between 1 and 60),
  url aule.source_url not null unique
);

create table aule.room_floors (
  room_id aule.hex24 primary key,
  floor aule.floor not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create table aule.building_shapes (
  key aule.campus_key primary key references aule.campus_buildings (key) on delete cascade,
  floors aule.floor_count not null,
  base_level aule.base_level not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create table aule.building_links (
  planner_name text primary key check (aule.plain(planner_name, 1, 100)),
  campus_key aule.campus_key not null references aule.campus_buildings (key) on delete cascade,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);

create table aule.run_requests (
  kind aule.run_kind primary key,
  pending boolean not null default false,
  requested_at timestamptz,
  requested_by uuid references auth.users (id) on delete set null,
  served_at timestamptz,
  check (not pending or requested_at is not null)
);
insert into aule.run_requests (kind) values ('sync'), ('discover');

create table aule.proposals (
  calendar_id aule.hex24 primary key,
  label aule.label not null,
  source aule.source_url not null,
  found_at timestamptz not null default now()
);

create table aule.discover_state (
  id boolean primary key default true check (id),
  started_at timestamptz,
  finished_at timestamptz,
  found integer not null default 0 check (found between 0 and 600)
);
insert into aule.discover_state default values;

create table aule.discover_failures (
  position smallint primary key check (position between 1 and 60),
  source aule.source_url not null,
  failure aule.discover_failure not null
);

-- Timetable: written only by the aule_sync functions, aule.refresh_timetable() and calendar removal.

create table aule.rooms (
  id aule.hex24 primary key,
  name text not null check (aule.plain(name, 1, 100)),
  code text not null check (aule.plain(code, 0, 50)),
  building_name text not null check (aule.plain(building_name, 0, 100)),
  capacity integer check (capacity between 1 and 5000),
  effective_capacity integer check (effective_capacity between 1 and 5000),
  services text[] not null check (aule.texts_ok(services, 15, 60)),
  building_key_guess aule.campus_key,
  room_key text not null check (room_key ~ '^[a-z0-9]{0,100}$'),
  name_compact text not null check (char_length(name_compact) between 1 and 100 and name_compact !~ '\s'),
  search_text text not null check (aule.plain(search_text, 1, 400)),
  updated_at timestamptz not null default now()
);

create table aule.calendar_data (
  calendar_id aule.hex24 primary key references aule.calendars (id) on delete cascade,
  fetched_at timestamptz not null,
  window_from timestamptz not null,
  window_to timestamptz not null,
  check (window_to > window_from)
);

create table aule.lessons (
  calendar_id aule.hex24 not null references aule.calendar_data (calendar_id) on delete cascade,
  id aule.hex24 not null,
  title text not null check (aule.plain(title, 1, 300)),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status aule.lesson_status not null,
  kind text not null check (aule.plain(kind, 0, 100)),
  courses text[] not null check (aule.texts_ok(courses, 10, 200)),
  year smallint check (year between 1 and 6),
  teachers text[] not null check (aule.texts_ok(teachers, 10, 121)),
  room_ids text[] not null check (cardinality(room_ids) between 1 and 10 and aule.all_hex24(room_ids)),
  title_text text not null check (aule.plain(title_text, 1, 300)),
  direct_text text not null check (aule.plain(direct_text, 1, 2000)),
  course_text text not null check (aule.plain(course_text, 1, 5000)),
  primary key (calendar_id, id),
  check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours'),
  check (aule.ms_exact(starts_at) and aule.ms_exact(ends_at))
);
create index lessons_id on aule.lessons (id);

create table aule.calendar_runs (
  calendar_id aule.hex24 primary key references aule.calendars (id) on delete cascade,
  at timestamptz not null,
  outcome aule.calendar_outcome not null,
  failure aule.failure_code,
  lessons integer not null check (lessons >= 0),
  check ((outcome = 'ok') = (failure is null))
);

-- Run states: open -> finished | aborted | abandoned. At most one open run.
create table aule.sync_runs (
  id bigint generated always as identity primary key,
  trigger aule.sync_trigger not null,
  state aule.run_state not null default 'open',
  started_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  finished_at timestamptz,
  window_from timestamptz not null,
  window_to timestamptz not null,
  ok integer not null default 0 check (ok >= 0),
  failed integer not null default 0 check (failed >= 0),
  rooms integer check (rooms >= 0),
  lessons integer check (lessons >= 0),
  failure aule.failure_code,
  check (window_to > window_from),
  check ((state = 'open') = (finished_at is null)),
  check ((state in ('aborted', 'abandoned')) = (failure is not null))
);
create unique index sync_runs_one_open on aule.sync_runs ((true)) where state = 'open';
create index sync_runs_started_at on aule.sync_runs (started_at);

-- No foreign key to calendars: a calendar can be removed during a run.
create table aule.sync_run_calendars (
  run_id bigint references aule.sync_runs (id) on delete cascade,
  calendar_id aule.hex24,
  source aule.feed_source not null,
  ref text,
  position integer not null,
  primary key (run_id, calendar_id)
);

create table aule.staged_calendars (
  run_id bigint,
  calendar_id aule.hex24,
  outcome aule.calendar_outcome not null,
  failure aule.failure_code,
  fetched_at timestamptz not null default now(),
  window_from timestamptz,
  window_to timestamptz,
  lessons integer not null default 0 check (lessons >= 0),
  skipped integer not null default 0 check (skipped between 0 and 20000),
  primary key (run_id, calendar_id),
  foreign key (run_id, calendar_id) references aule.sync_run_calendars on delete cascade,
  check ((outcome = 'ok') = (failure is null)),
  check ((outcome = 'ok') = (window_from is not null and window_to is not null)),
  check (window_to > window_from)
);

create table aule.staged_lessons (
  run_id bigint,
  calendar_id aule.hex24 not null,
  id aule.hex24 not null,
  title text not null check (aule.plain(title, 1, 300)),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status aule.lesson_status not null,
  kind text not null check (aule.plain(kind, 0, 100)),
  courses text[] not null check (aule.texts_ok(courses, 10, 200)),
  year smallint check (year between 1 and 6),
  teachers text[] not null check (aule.texts_ok(teachers, 10, 121)),
  room_ids text[] not null check (cardinality(room_ids) between 1 and 10 and aule.all_hex24(room_ids)),
  title_text text not null check (aule.plain(title_text, 1, 300)),
  direct_text text not null check (aule.plain(direct_text, 1, 2000)),
  course_text text not null check (aule.plain(course_text, 1, 5000)),
  primary key (run_id, calendar_id, id),
  foreign key (run_id, calendar_id) references aule.staged_calendars on delete cascade,
  check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours'),
  check (aule.ms_exact(starts_at) and aule.ms_exact(ends_at))
);

create table aule.staged_rooms (
  run_id bigint references aule.sync_runs (id) on delete cascade,
  id aule.hex24,
  name text not null check (aule.plain(name, 1, 100)),
  code text not null check (aule.plain(code, 0, 50)),
  building_name text not null check (aule.plain(building_name, 0, 100)),
  capacity integer check (capacity between 1 and 5000),
  effective_capacity integer check (effective_capacity between 1 and 5000),
  services text[] not null check (aule.texts_ok(services, 15, 60)),
  building_key_guess aule.campus_key,
  room_key text not null check (room_key ~ '^[a-z0-9]{0,100}$'),
  name_compact text not null check (char_length(name_compact) between 1 and 100 and name_compact !~ '\s'),
  search_text text not null check (aule.plain(search_text, 1, 400)),
  primary key (run_id, id)
);

-- Derived: rebuilt by aule.refresh_timetable(), the only source for every reader.

create table aule.unique_lessons (
  id aule.hex24 primary key,
  calendar_id aule.hex24 not null,
  source aule.feed_source not null,
  title text not null check (aule.plain(title, 1, 300)),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status aule.lesson_status not null,
  kind text not null check (aule.plain(kind, 0, 100)),
  courses text[] not null check (aule.texts_ok(courses, 10, 200)),
  year smallint check (year between 1 and 6),
  teachers text[] not null check (aule.texts_ok(teachers, 10, 121)),
  room_ids text[] not null check (cardinality(room_ids) between 1 and 10 and aule.all_hex24(room_ids)),
  title_text text not null check (aule.plain(title_text, 1, 300)),
  direct_text text not null check (aule.plain(direct_text, 1, 2000)),
  course_text text not null check (aule.plain(course_text, 1, 5000)),
  calendar_ids text[] not null check (cardinality(calendar_ids) >= 1 and aule.all_hex24(calendar_ids)),
  check (ends_at > starts_at and ends_at - starts_at <= interval '12 hours'),
  check (aule.ms_exact(starts_at) and aule.ms_exact(ends_at))
);
create index unique_lessons_room_ids on aule.unique_lessons using gin (room_ids);
create index unique_lessons_starts_at on aule.unique_lessons (starts_at);

create table aule.lesson_rooms (
  room_id aule.hex24,
  lesson_id aule.hex24,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status aule.lesson_status not null,
  title text not null,
  primary key (room_id, lesson_id)
);
create index lesson_rooms_room_starts_at on aule.lesson_rooms (room_id, starts_at);

create table aule.room_calendars (
  room_id aule.hex24,
  calendar_id aule.hex24,
  primary key (room_id, calendar_id)
);

-- Grants: S = select, I = insert, U = update, D = delete. One permissive policy per role with a grant.

alter table aule.settings enable row level security;
revoke all on aule.settings from public, anon, authenticated, service_role, aule_sync;
grant select on aule.settings to aule_reader, aule_ingest, aule_config;
create policy settings_aule_reader on aule.settings for all to aule_reader using (true) with check (true);
create policy settings_aule_ingest on aule.settings for all to aule_ingest using (true) with check (true);
create policy settings_aule_config on aule.settings for all to aule_config using (true) with check (true);

alter table aule.campus_buildings enable row level security;
revoke all on aule.campus_buildings from public, anon, authenticated, service_role, aule_sync;
grant select on aule.campus_buildings to aule_reader, aule_config;
create policy campus_buildings_aule_reader on aule.campus_buildings for all to aule_reader using (true) with check (true);
create policy campus_buildings_aule_config on aule.campus_buildings for all to aule_config using (true) with check (true);

alter table aule.room_seeds enable row level security;
revoke all on aule.room_seeds from public, anon, authenticated, service_role, aule_sync;
grant select on aule.room_seeds to aule_reader, aule_config;
create policy room_seeds_aule_reader on aule.room_seeds for all to aule_reader using (true) with check (true);
create policy room_seeds_aule_config on aule.room_seeds for all to aule_config using (true) with check (true);

alter table aule.room_floors enable row level security;
revoke all on aule.room_floors from public, anon, authenticated, service_role, aule_sync;
grant select on aule.room_floors to aule_reader;
grant select, insert, update, delete on aule.room_floors to aule_config;
create policy room_floors_aule_reader on aule.room_floors for all to aule_reader using (true) with check (true);
create policy room_floors_aule_config on aule.room_floors for all to aule_config using (true) with check (true);

alter table aule.building_shapes enable row level security;
revoke all on aule.building_shapes from public, anon, authenticated, service_role, aule_sync;
grant select on aule.building_shapes to aule_reader;
grant select, insert, update, delete on aule.building_shapes to aule_config;
create policy building_shapes_aule_reader on aule.building_shapes for all to aule_reader using (true) with check (true);
create policy building_shapes_aule_config on aule.building_shapes for all to aule_config using (true) with check (true);

alter table aule.building_links enable row level security;
revoke all on aule.building_links from public, anon, authenticated, service_role, aule_sync;
grant select on aule.building_links to aule_reader;
grant select, insert, update, delete on aule.building_links to aule_config;
create policy building_links_aule_reader on aule.building_links for all to aule_reader using (true) with check (true);
create policy building_links_aule_config on aule.building_links for all to aule_config using (true) with check (true);

alter table aule.calendars enable row level security;
revoke all on aule.calendars from public, anon, authenticated, service_role, aule_sync;
grant select on aule.calendars to aule_ingest;
grant select, insert, update, delete on aule.calendars to aule_config;
create policy calendars_aule_ingest on aule.calendars for all to aule_ingest using (true) with check (true);
create policy calendars_aule_config on aule.calendars for all to aule_config using (true) with check (true);

alter table aule.sources enable row level security;
revoke all on aule.sources from public, anon, authenticated, service_role, aule_sync;
grant select on aule.sources to aule_ingest;
grant select, insert, update, delete on aule.sources to aule_config;
create policy sources_aule_ingest on aule.sources for all to aule_ingest using (true) with check (true);
create policy sources_aule_config on aule.sources for all to aule_config using (true) with check (true);

alter table aule.rooms enable row level security;
revoke all on aule.rooms from public, anon, authenticated, service_role, aule_sync;
grant select on aule.rooms to aule_reader;
grant select, insert, update, delete on aule.rooms to aule_ingest;
grant select, delete on aule.rooms to aule_config;
create policy rooms_aule_reader on aule.rooms for all to aule_reader using (true) with check (true);
create policy rooms_aule_ingest on aule.rooms for all to aule_ingest using (true) with check (true);
create policy rooms_aule_config on aule.rooms for all to aule_config using (true) with check (true);

alter table aule.calendar_data enable row level security;
revoke all on aule.calendar_data from public, anon, authenticated, service_role, aule_sync;
grant select on aule.calendar_data to aule_reader, aule_config;
grant select, insert, update, delete on aule.calendar_data to aule_ingest;
create policy calendar_data_aule_reader on aule.calendar_data for all to aule_reader using (true) with check (true);
create policy calendar_data_aule_ingest on aule.calendar_data for all to aule_ingest using (true) with check (true);
create policy calendar_data_aule_config on aule.calendar_data for all to aule_config using (true) with check (true);

alter table aule.lessons enable row level security;
revoke all on aule.lessons from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.lessons to aule_ingest;
grant select on aule.lessons to aule_config;
create policy lessons_aule_ingest on aule.lessons for all to aule_ingest using (true) with check (true);
create policy lessons_aule_config on aule.lessons for all to aule_config using (true) with check (true);

alter table aule.calendar_runs enable row level security;
revoke all on aule.calendar_runs from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.calendar_runs to aule_ingest;
grant select on aule.calendar_runs to aule_config;
create policy calendar_runs_aule_ingest on aule.calendar_runs for all to aule_ingest using (true) with check (true);
create policy calendar_runs_aule_config on aule.calendar_runs for all to aule_config using (true) with check (true);

alter table aule.sync_runs enable row level security;
revoke all on aule.sync_runs from public, anon, authenticated, service_role, aule_sync;
revoke all on sequence aule.sync_runs_id_seq from public, anon, authenticated, service_role, aule_sync;
grant select on aule.sync_runs to aule_reader, aule_config;
grant select, insert, update, delete on aule.sync_runs to aule_ingest;
create policy sync_runs_aule_reader on aule.sync_runs for all to aule_reader using (true) with check (true);
create policy sync_runs_aule_ingest on aule.sync_runs for all to aule_ingest using (true) with check (true);
create policy sync_runs_aule_config on aule.sync_runs for all to aule_config using (true) with check (true);

alter table aule.sync_run_calendars enable row level security;
revoke all on aule.sync_run_calendars from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.sync_run_calendars to aule_ingest;
create policy sync_run_calendars_aule_ingest on aule.sync_run_calendars for all to aule_ingest using (true) with check (true);

alter table aule.staged_calendars enable row level security;
revoke all on aule.staged_calendars from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.staged_calendars to aule_ingest;
create policy staged_calendars_aule_ingest on aule.staged_calendars for all to aule_ingest using (true) with check (true);

alter table aule.staged_lessons enable row level security;
revoke all on aule.staged_lessons from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.staged_lessons to aule_ingest;
create policy staged_lessons_aule_ingest on aule.staged_lessons for all to aule_ingest using (true) with check (true);

alter table aule.staged_rooms enable row level security;
revoke all on aule.staged_rooms from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.staged_rooms to aule_ingest;
create policy staged_rooms_aule_ingest on aule.staged_rooms for all to aule_ingest using (true) with check (true);

alter table aule.unique_lessons enable row level security;
revoke all on aule.unique_lessons from public, anon, authenticated, service_role, aule_sync;
grant select on aule.unique_lessons to aule_reader;
grant select, insert, update, delete on aule.unique_lessons to aule_ingest;
create policy unique_lessons_aule_reader on aule.unique_lessons for all to aule_reader using (true) with check (true);
create policy unique_lessons_aule_ingest on aule.unique_lessons for all to aule_ingest using (true) with check (true);

alter table aule.lesson_rooms enable row level security;
revoke all on aule.lesson_rooms from public, anon, authenticated, service_role, aule_sync;
grant select on aule.lesson_rooms to aule_reader;
grant select, insert, update, delete on aule.lesson_rooms to aule_ingest;
create policy lesson_rooms_aule_reader on aule.lesson_rooms for all to aule_reader using (true) with check (true);
create policy lesson_rooms_aule_ingest on aule.lesson_rooms for all to aule_ingest using (true) with check (true);

alter table aule.room_calendars enable row level security;
revoke all on aule.room_calendars from public, anon, authenticated, service_role, aule_sync;
grant select on aule.room_calendars to aule_reader;
grant select, insert, update, delete on aule.room_calendars to aule_ingest;
create policy room_calendars_aule_reader on aule.room_calendars for all to aule_reader using (true) with check (true);
create policy room_calendars_aule_ingest on aule.room_calendars for all to aule_ingest using (true) with check (true);

alter table aule.run_requests enable row level security;
revoke all on aule.run_requests from public, anon, authenticated, service_role, aule_sync;
grant select on aule.run_requests to aule_reader;
grant select, update on aule.run_requests to aule_ingest, aule_config;
create policy run_requests_aule_reader on aule.run_requests for all to aule_reader using (true) with check (true);
create policy run_requests_aule_ingest on aule.run_requests for all to aule_ingest using (true) with check (true);
create policy run_requests_aule_config on aule.run_requests for all to aule_config using (true) with check (true);

alter table aule.proposals enable row level security;
revoke all on aule.proposals from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.proposals to aule_ingest;
grant select on aule.proposals to aule_config;
create policy proposals_aule_ingest on aule.proposals for all to aule_ingest using (true) with check (true);
create policy proposals_aule_config on aule.proposals for all to aule_config using (true) with check (true);

alter table aule.discover_state enable row level security;
revoke all on aule.discover_state from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.discover_state to aule_ingest;
grant select on aule.discover_state to aule_config;
create policy discover_state_aule_ingest on aule.discover_state for all to aule_ingest using (true) with check (true);
create policy discover_state_aule_config on aule.discover_state for all to aule_config using (true) with check (true);

alter table aule.discover_failures enable row level security;
revoke all on aule.discover_failures from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.discover_failures to aule_ingest;
grant select on aule.discover_failures to aule_config;
create policy discover_failures_aule_ingest on aule.discover_failures for all to aule_ingest using (true) with check (true);
create policy discover_failures_aule_config on aule.discover_failures for all to aule_config using (true) with check (true);

-- Building key and floor resolved at read time: admin link first, then the guessed key if it is a campus key;
-- admin floor first, then the seed by resolved key and room key.
create view aule.room_view with (security_invoker = true) as
select r.id, r.name, r.code, r.building_name, r.capacity, r.effective_capacity, r.services,
  r.name_compact, r.search_text, k.key as building_key,
  coalesce(f.floor, s.floor)::integer as floor,
  case when f.room_id is not null then 'admin' when s.floor is not null then 'seed' end as floor_source
from aule.rooms r
cross join lateral (
  select coalesce(
    (select bl.campus_key from aule.building_links bl where bl.planner_name = r.building_name),
    (select cb.key from aule.campus_buildings cb where cb.key = r.building_key_guess)
  )::text as key
) k
left join aule.room_floors f on f.room_id = r.id
left join aule.room_seeds s on s.building_key = k.key and s.room_key = r.room_key;
revoke all on aule.room_view from public, anon, authenticated, service_role, aule_sync;
grant select on aule.room_view to aule_reader, aule_config;

-- The read functions see only what the map needs from the requests table.
grant select (room_id, kind, category, lesson_id, starts_at, ends_at, status, created_by) on public.room_requests to aule_reader;
create policy room_requests_aule_reader on public.room_requests for select to aule_reader using (true);
