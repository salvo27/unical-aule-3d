-- Rooms each feed has used, kept across empty and failed runs. A room links to every calendar holding one of its
-- lessons and to every feed that used it lately, so a feed that stops sending lessons (outside its semester, or
-- failing) still makes the room grey while the feed is stale or out of its window, never free.
-- Retention: a link not seen for 9600 hours (400 days) is dropped, so a feed keeps the rooms of a whole academic year.
-- The link lives while the feed has data: deactivated feeds lose it at the next sync_finish, removed ones at once.

create table aule.feed_rooms (
  calendar_id aule.hex24 not null references aule.calendar_data (calendar_id) on delete cascade,
  room_id aule.hex24 not null,
  last_seen timestamptz not null,
  primary key (calendar_id, room_id)
);
alter table aule.feed_rooms enable row level security;
revoke all on aule.feed_rooms from public, anon, authenticated, service_role, aule_sync;
grant select, insert, update, delete on aule.feed_rooms to aule_ingest;
create policy feed_rooms_aule_ingest on aule.feed_rooms for all to aule_ingest using (true) with check (true);

-- The rooms of the lessons already stored, or the first empty run after this migration would lose them.
select pg_advisory_xact_lock(hashtextextended('aule_sync', 0));
insert into aule.feed_rooms (calendar_id, room_id, last_seen)
select distinct l.calendar_id, x.id, d.fetched_at
from aule.lessons l
join aule.calendar_data d on d.calendar_id = l.calendar_id
cross join lateral unnest(l.room_ids) as x(id);

-- Only the owner replaces a function: the new bodies are created as the NOLOGIN owners, which keeps owner and grants.
grant create on schema aule to aule_ingest;
grant create on schema aule_sync to aule_ingest;
set role aule_ingest;

-- As before, plus the links of aule.feed_rooms in aule.room_calendars, which the read API checks for freshness.
create or replace function aule.refresh_timetable()
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
begin
  delete from aule.room_calendars where true;
  delete from aule.lesson_rooms where true;
  delete from aule.unique_lessons where true;

  insert into aule.unique_lessons (id, calendar_id, source, title, starts_at, ends_at, status, kind, courses, year, teachers,
    room_ids, title_text, direct_text, course_text, calendar_ids)
  with copies as (
    select distinct on (l.id) l.*, c.source
    from aule.lessons l
    join aule.calendar_data d on d.calendar_id = l.calendar_id
    join aule.calendars c on c.id = l.calendar_id
    order by l.id, d.fetched_at desc, l.calendar_id
  )
  select r.id, r.calendar_id, r.source, r.title, r.starts_at, r.ends_at, r.status, r.kind, r.courses, r.year, r.teachers,
    r.room_ids, r.title_text, r.direct_text, r.course_text,
    array(select l2.calendar_id::pg_catalog.text from aule.lessons l2 where l2.id = r.id order by 1)
  from copies r
  where not exists (
    select 1 from copies p
    where aule.source_rank(p.source) < aule.source_rank(r.source)
      and p.starts_at = r.starts_at and p.ends_at = r.ends_at and p.room_ids @> r.room_ids
      and (p.status = 'active' or r.status = 'cancelled')
  );

  insert into aule.lesson_rooms (room_id, lesson_id, starts_at, ends_at, status, title)
  select distinct x.room_id, u.id, u.starts_at, u.ends_at, u.status, u.title
  from aule.unique_lessons u, unnest(u.room_ids) as x(room_id);

  insert into aule.room_calendars (room_id, calendar_id)
  select lr.room_id, c.cal
  from aule.lesson_rooms lr
  join aule.unique_lessons u on u.id = lr.lesson_id, unnest(u.calendar_ids) as c(cal)
  union
  select f.room_id, f.calendar_id
  from aule.feed_rooms f;
end
$$;

-- As before, plus the room links of every ok calendar with lessons and the retention of the old ones.
create or replace function aule_sync.sync_finish(p_run bigint)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now pg_catalog.timestamptz := now();
  v_settings aule.settings%rowtype;
  v_state aule.run_state;
  v_k pg_catalog.text[];
  v_ok integer;
  v_failed integer;
  v_staged bigint;
  v_last_good pg_catalog.timestamptz;
  v_prev bigint;
  v_new bigint;
  v_rooms integer;
  v_lessons integer;
begin
  if p_run is null or p_run < 1 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  select * into strict v_settings from aule.settings;

  select r.state into v_state from aule.sync_runs r where r.id = p_run for update;
  if not found then
    raise exception 'run_missing' using errcode = 'P0001';
  end if;
  if v_state <> 'open' then
    raise exception 'run_closed' using errcode = 'P0001';
  end if;

  insert into aule.staged_calendars (run_id, calendar_id, outcome, failure, fetched_at)
  select rc.run_id, rc.calendar_id, 'failed', 'missing', v_now
  from aule.sync_run_calendars rc
  where rc.run_id = p_run
    and not exists (select 1 from aule.staged_calendars sc where sc.run_id = rc.run_id and sc.calendar_id = rc.calendar_id);

  -- Only calendars still active now count; staging of removed or deactivated ones is ignored.
  v_k := array(
    select rc.calendar_id::pg_catalog.text
    from aule.sync_run_calendars rc
    join aule.calendars c on c.id = rc.calendar_id
    where rc.run_id = p_run and c.active);

  select count(*) filter (where sc.outcome = 'ok'), count(*) filter (where sc.outcome = 'failed'),
    coalesce(sum(sc.lessons) filter (where sc.outcome = 'ok'), 0)
  into v_ok, v_failed, v_staged
  from aule.staged_calendars sc
  where sc.run_id = p_run and sc.calendar_id = any(v_k);

  select max(r.finished_at) into v_last_good from aule.sync_runs r where r.state = 'finished' and r.ok > 0;
  if v_last_good is not null and v_last_good > v_now - v_settings.implausible_age then
    select coalesce(sum(cr.lessons), 0), coalesce(sum(sc.lessons), 0) into v_prev, v_new
    from aule.staged_calendars sc
    join aule.calendar_runs cr on cr.calendar_id = sc.calendar_id and cr.outcome = 'ok'
    where sc.run_id = p_run and sc.outcome = 'ok' and sc.calendar_id = any(v_k);
  else
    v_prev := 0;
    v_new := 0;
  end if;

  if (v_ok >= 10 and v_staged = 0)
     or (v_prev >= v_settings.implausible_min_lessons and v_new < v_prev * v_settings.implausible_drop) then
    update aule.sync_runs set state = 'aborted', failure = 'implausible', finished_at = v_now, ok = v_ok, failed = v_failed
    where id = p_run;
    delete from aule.sync_run_calendars where run_id = p_run;
    delete from aule.staged_rooms where run_id = p_run;
    return jsonb_build_object('run', p_run, 'state', 'aborted', 'failure', 'implausible', 'ok', v_ok, 'failed', v_failed,
      'rooms', null, 'lessons', null);
  end if;

  -- Removes the room links of inactive calendars too (foreign key on calendar_data).
  delete from aule.calendar_data d using aule.calendars c where c.id = d.calendar_id and not c.active;
  delete from aule.calendar_runs cr using aule.calendars c where c.id = cr.calendar_id and not c.active;

  insert into aule.calendar_data (calendar_id, fetched_at, window_from, window_to)
  select sc.calendar_id, sc.fetched_at, sc.window_from, sc.window_to
  from aule.staged_calendars sc
  where sc.run_id = p_run and sc.outcome = 'ok' and sc.calendar_id = any(v_k)
  on conflict (calendar_id) do update set
    fetched_at = excluded.fetched_at, window_from = excluded.window_from, window_to = excluded.window_to;
  delete from aule.lessons l
  using aule.staged_calendars sc
  where sc.run_id = p_run and sc.outcome = 'ok' and sc.calendar_id = any(v_k) and l.calendar_id = sc.calendar_id;
  insert into aule.lessons (calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers, room_ids,
    title_text, direct_text, course_text)
  select sl.calendar_id, sl.id, sl.title, sl.starts_at, sl.ends_at, sl.status, sl.kind, sl.courses, sl.year, sl.teachers,
    sl.room_ids, sl.title_text, sl.direct_text, sl.course_text
  from aule.staged_lessons sl
  join aule.staged_calendars sc on sc.run_id = sl.run_id and sc.calendar_id = sl.calendar_id
  where sl.run_id = p_run and sc.outcome = 'ok' and sc.calendar_id = any(v_k);

  -- Empty and failed calendars keep their links; 9600 hours is the retention of the header.
  insert into aule.feed_rooms (calendar_id, room_id, last_seen)
  select distinct sl.calendar_id, x.id, sc.fetched_at
  from aule.staged_lessons sl
  join aule.staged_calendars sc on sc.run_id = sl.run_id and sc.calendar_id = sl.calendar_id
  cross join lateral unnest(sl.room_ids) as x(id)
  where sl.run_id = p_run and sc.outcome = 'ok' and sc.calendar_id = any(v_k)
  on conflict (calendar_id, room_id) do update set last_seen = excluded.last_seen;
  delete from aule.feed_rooms f where f.last_seen < v_now - interval '9600 hours';

  insert into aule.rooms (id, name, code, building_name, capacity, effective_capacity, services, building_key_guess,
    room_key, name_compact, search_text, updated_at)
  select sr.id, sr.name, sr.code, sr.building_name, sr.capacity, sr.effective_capacity, sr.services, sr.building_key_guess,
    sr.room_key, sr.name_compact, sr.search_text, v_now
  from aule.staged_rooms sr
  where sr.run_id = p_run
  on conflict (id) do update set
    name = excluded.name, code = excluded.code, building_name = excluded.building_name,
    capacity = excluded.capacity, effective_capacity = excluded.effective_capacity, services = excluded.services,
    building_key_guess = excluded.building_key_guess, room_key = excluded.room_key,
    name_compact = excluded.name_compact, search_text = excluded.search_text, updated_at = excluded.updated_at;

  insert into aule.calendar_runs (calendar_id, at, outcome, failure, lessons)
  select sc.calendar_id,
    case when sc.outcome = 'ok' then sc.fetched_at else v_now end,
    sc.outcome,
    sc.failure,
    case when sc.outcome = 'ok' then sc.lessons
      else (select count(*)::integer from aule.lessons l where l.calendar_id = sc.calendar_id) end
  from aule.staged_calendars sc
  where sc.run_id = p_run and sc.calendar_id = any(v_k)
  on conflict (calendar_id) do update set
    at = excluded.at, outcome = excluded.outcome, failure = excluded.failure, lessons = excluded.lessons;

  delete from aule.rooms r
  where not exists (select 1 from aule.lessons l, unnest(l.room_ids) as x(id) where x.id = r.id);

  perform aule.refresh_timetable();

  select count(*)::integer into v_rooms from aule.rooms;
  select count(*)::integer into v_lessons from aule.lessons;
  update aule.sync_runs
  set state = 'finished', finished_at = v_now, ok = v_ok, failed = v_failed, rooms = v_rooms, lessons = v_lessons
  where id = p_run;

  delete from aule.sync_run_calendars where run_id = p_run;
  delete from aule.staged_rooms where run_id = p_run;
  delete from aule.sync_runs r where r.state <> 'open' and r.started_at < v_now - v_settings.run_retention;

  return jsonb_build_object('run', p_run, 'state', 'finished', 'failure', null, 'ok', v_ok, 'failed', v_failed,
    'rooms', v_rooms, 'lessons', v_lessons);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;

set role postgres;
revoke create on schema aule_sync from aule_ingest;
revoke create on schema aule from aule_ingest;

grant create on schema aule to aule_config;
set role aule_config;

-- Removal is immediate: its data, runs and room links go with the calendar, then orphan rooms and the derived tables.
-- Feeds an admin cannot add (xlsx, dimes, pdf without a URL) come only from generated migrations: deactivate them instead.
create or replace function aule.config_remove_calendar(p_id text)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_id is null or octet_length(p_id) <> 24 then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  if p_id !~ '^[0-9a-f]{24}$' then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_admin', 0));
  if exists (
    select 1 from aule.calendars c
    where c.id = p_id and (c.source in ('xlsx', 'dimes') or (c.source = 'pdf' and aule.source_url_ok(c.ref) is not true))
  ) then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  delete from aule.calendars c where c.id = p_id;
  if not found then
    raise exception 'calendar_missing' using errcode = 'P0001';
  end if;
  delete from aule.rooms r where not exists (select 1 from aule.lessons l where r.id = any (l.room_ids));
  perform aule.refresh_timetable();
end
$$;

set role postgres;
revoke create on schema aule from aule_config;
