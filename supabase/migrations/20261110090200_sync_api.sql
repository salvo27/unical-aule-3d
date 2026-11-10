-- Sync API: schema aule_sync, reachable only by the aule_sync role, plus the rebuild of the derived tables.
-- Every function runs as the NOLOGIN owner aule_ingest, validates its input first and raises closed codes only.
-- Run states: open -> finished | aborted | abandoned.
-- aule_sync logs in and may create temp objects, and with search_path = '' pg_temp is searched first for type
-- names: every type in these bodies (and in the helpers they call) is written with its schema.

create schema aule_sync;
revoke all on schema aule_sync from public, anon, authenticated, service_role;
grant usage on schema aule_sync to aule_sync;

-- One copy per lesson id (newest fetch, ties by calendar id). A lower priority copy is dropped only when one
-- higher priority copy has the same times, all of its rooms and is active (or both are cancelled), so dropping
-- never frees a room. Deletes, never truncate, so readers keep the old rows until commit.
create function aule.refresh_timetable()
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
  select distinct lr.room_id, c.cal
  from aule.lesson_rooms lr
  join aule.unique_lessons u on u.id = lr.lesson_id, unnest(u.calendar_ids) as c(cal);
end
$$;
revoke all on function aule.refresh_timetable() from public, anon, authenticated, service_role;
grant execute on function aule.refresh_timetable() to aule_config;

create function aule_sync.ping()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));
  return 'ok';
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.ping() from public, anon, authenticated, service_role;
grant execute on function aule_sync.ping() to aule_sync;

-- Opens a run: abandons an expired one, enforces the cooldown and the daily cap, fixes the window in Rome days.
create function aule_sync.sync_begin(p_trigger text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now pg_catalog.timestamptz := now();
  v_settings aule.settings%rowtype;
  v_open aule.sync_runs%rowtype;
  v_day pg_catalog.date;
  v_from pg_catalog.timestamptz;
  v_to pg_catalog.timestamptz;
  v_trigger aule.sync_trigger;
  v_run bigint;
begin
  if p_trigger is null or char_length(p_trigger) > 20 or p_trigger not in ('schedule', 'poll', 'manual') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));
  select * into strict v_settings from aule.settings;

  select * into v_open from aule.sync_runs r where r.state = 'open' for update;
  if found then
    if v_open.started_at > v_now - v_settings.run_lease and v_open.last_seen_at > v_now - v_settings.run_idle then
      raise exception 'run_open' using errcode = 'P0001';
    end if;
    update aule.sync_runs set state = 'abandoned', failure = 'abandoned', finished_at = v_now where id = v_open.id;
    delete from aule.sync_run_calendars where run_id = v_open.id;
    delete from aule.staged_rooms where run_id = v_open.id;
  end if;

  if exists (select 1 from aule.sync_runs r where r.started_at > v_now - v_settings.request_cooldown) then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;
  if (select count(*) from aule.sync_runs r where r.started_at > v_now - interval '24 hours') >= v_settings.max_runs_per_day then
    raise exception 'too_many_runs' using errcode = 'P0001';
  end if;

  v_day := aule.rome_day(v_now);
  v_from := aule.rome_midnight(v_day - v_settings.window_back_days);
  v_to := aule.rome_midnight(v_day + v_settings.window_ahead_days);
  v_trigger := case
    when p_trigger <> 'poll' then p_trigger
    when exists (select 1 from aule.run_requests q where q.kind = 'sync' and q.pending and q.requested_at <= v_now) then 'request'
    else 'schedule'
  end::aule.sync_trigger;

  insert into aule.sync_runs (trigger, state, started_at, last_seen_at, window_from, window_to)
  values (v_trigger, 'open', v_now, v_now, v_from, v_to)
  returning id into v_run;
  insert into aule.sync_run_calendars (run_id, calendar_id, source, ref, position)
  select v_run, c.id, c.source, c.ref, row_number() over (order by aule.source_rank(c.source), c.added_at, c.id)
  from aule.calendars c
  where c.active;
  -- A request made after this transaction started stays pending for the next run.
  update aule.run_requests set pending = false, served_at = v_now
  where kind = 'sync' and pending and requested_at <= v_now;

  -- Rooms without a room key can never be matched, so the directory leaves them out.
  return jsonb_build_object(
    'run', v_run,
    'from', aule.ms(v_from),
    'to', aule.ms(v_to),
    'calendars', coalesce((
      select jsonb_agg(jsonb_build_object('id', rc.calendar_id, 'source', rc.source, 'ref', rc.ref) order by rc.position)
      from aule.sync_run_calendars rc
      where rc.run_id = v_run), '[]'::pg_catalog.jsonb),
    'rooms', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'buildingKey', d.building_key_guess, 'roomKey', d.room_key) order by d.id)
      from (
        select r.id, r.building_key_guess, r.room_key
        from aule.rooms r
        where r.id !~ '^fff' and r.building_key_guess is not null and r.room_key <> ''
        order by r.id
        limit 3000
      ) d), '[]'::pg_catalog.jsonb)
  );
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.sync_begin(text) from public, anon, authenticated, service_role;
grant execute on function aule_sync.sync_begin(text) to aule_sync;

-- Stages one calendar, all or nothing: size, shape, values, then window.
create function aule_sync.sync_put_calendar(p_run bigint, p_calendar text, p_payload jsonb)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_state aule.run_state;
  v_run_from bigint;
  v_run_to bigint;
  v_source aule.feed_source;
  v_rooms pg_catalog.jsonb;
  v_lessons pg_catalog.jsonb;
  v_from bigint;
  v_to bigint;
  v_skipped integer;
begin
  if p_run is null or p_run < 1
     or p_calendar is null or char_length(p_calendar) <> 24 or p_calendar !~ '^[0-9a-f]{24}$'
     or p_payload is null then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));

  select r.state, aule.ms(r.window_from), aule.ms(r.window_to) into v_state, v_run_from, v_run_to
  from aule.sync_runs r where r.id = p_run for update;
  if not found then
    raise exception 'run_missing' using errcode = 'P0001';
  end if;
  if v_state <> 'open' then
    raise exception 'run_closed' using errcode = 'P0001';
  end if;
  select rc.source into v_source from aule.sync_run_calendars rc where rc.run_id = p_run and rc.calendar_id = p_calendar;
  if not found then
    raise exception 'calendar_unknown' using errcode = 'P0001';
  end if;
  if exists (select 1 from aule.staged_calendars sc where sc.run_id = p_run and sc.calendar_id = p_calendar) then
    raise exception 'calendar_done' using errcode = 'P0001';
  end if;

  v_rooms := p_payload -> 'rooms';
  v_lessons := p_payload -> 'lessons';
  if octet_length(p_payload::pg_catalog.text) > 16000000
     or (case when jsonb_typeof(v_lessons) = 'array' then jsonb_array_length(v_lessons) > 20000 else false end)
     or (case when jsonb_typeof(v_rooms) = 'array' then jsonb_array_length(v_rooms) > 3000 else false end) then
    raise exception 'payload_size' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload_shape' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_object_keys(p_payload)) <> 5
     or not p_payload ?& array['from', 'to', 'skipped', 'rooms', 'lessons']
     or jsonb_typeof(p_payload -> 'from') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'to') is distinct from 'number'
     or jsonb_typeof(p_payload -> 'skipped') is distinct from 'number'
     or jsonb_typeof(v_rooms) is distinct from 'array'
     or jsonb_typeof(v_lessons) is distinct from 'array' then
    raise exception 'payload_shape' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_rooms) e(v)
    where case when jsonb_typeof(v) is distinct from 'object' then true else
      (select count(*) from jsonb_object_keys(v)) <> 11
      or not v ?& array['id', 'name', 'code', 'buildingName', 'capacity', 'effectiveCapacity', 'services',
        'buildingKeyGuess', 'roomKey', 'nameCompact', 'searchText']
      or jsonb_typeof(v -> 'id') is distinct from 'string'
      or jsonb_typeof(v -> 'name') is distinct from 'string'
      or jsonb_typeof(v -> 'code') is distinct from 'string'
      or jsonb_typeof(v -> 'buildingName') is distinct from 'string'
      or jsonb_typeof(v -> 'capacity') not in ('number', 'null')
      or jsonb_typeof(v -> 'effectiveCapacity') not in ('number', 'null')
      or jsonb_typeof(v -> 'buildingKeyGuess') not in ('string', 'null')
      or jsonb_typeof(v -> 'roomKey') is distinct from 'string'
      or jsonb_typeof(v -> 'nameCompact') is distinct from 'string'
      or jsonb_typeof(v -> 'searchText') is distinct from 'string'
      or case when jsonb_typeof(v -> 'services') is distinct from 'array' then true
        else exists (select 1 from jsonb_array_elements(v -> 'services') s(x) where jsonb_typeof(x) <> 'string') end
    end
  ) or exists (
    select 1 from jsonb_array_elements(v_lessons) e(v)
    where case when jsonb_typeof(v) is distinct from 'object' then true else
      (select count(*) from jsonb_object_keys(v)) <> 13
      or not v ?& array['id', 'title', 'start', 'end', 'status', 'kind', 'courses', 'year', 'teachers', 'roomIds',
        'titleText', 'directText', 'courseText']
      or jsonb_typeof(v -> 'id') is distinct from 'string'
      or jsonb_typeof(v -> 'title') is distinct from 'string'
      or jsonb_typeof(v -> 'start') is distinct from 'number'
      or jsonb_typeof(v -> 'end') is distinct from 'number'
      or jsonb_typeof(v -> 'status') is distinct from 'string'
      or jsonb_typeof(v -> 'kind') is distinct from 'string'
      or jsonb_typeof(v -> 'year') not in ('number', 'null')
      or jsonb_typeof(v -> 'titleText') is distinct from 'string'
      or jsonb_typeof(v -> 'directText') is distinct from 'string'
      or jsonb_typeof(v -> 'courseText') is distinct from 'string'
      or case when jsonb_typeof(v -> 'courses') is distinct from 'array' then true
        else exists (select 1 from jsonb_array_elements(v -> 'courses') s(x) where jsonb_typeof(x) <> 'string') end
      or case when jsonb_typeof(v -> 'teachers') is distinct from 'array' then true
        else exists (select 1 from jsonb_array_elements(v -> 'teachers') s(x) where jsonb_typeof(x) <> 'string') end
      or case when jsonb_typeof(v -> 'roomIds') is distinct from 'array' then true
        else exists (select 1 from jsonb_array_elements(v -> 'roomIds') s(x) where jsonb_typeof(x) <> 'string') end
    end
  ) then
    raise exception 'payload_shape' using errcode = 'P0001';
  end if;

  begin
    v_from := (p_payload ->> 'from')::bigint;
    v_to := (p_payload ->> 'to')::bigint;
    v_skipped := (p_payload ->> 'skipped')::integer;
  exception when others then
    raise exception 'payload_value' using errcode = 'P0001';
  end;
  if v_skipped not between 0 and 20000
     or exists (select 1 from jsonb_array_elements(v_rooms) e(v) group by v ->> 'id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(v_lessons) e(v) group by v ->> 'id' having count(*) > 1) then
    raise exception 'payload_value' using errcode = 'P0001';
  end if;

  -- Planner rooms come only from Planner; other sources bring synthetic rooms or point at a known Planner room.
  -- A Planner event that is not a lesson carries only its label: its free text may name people.
  if v_source = 'planner' then
    if exists (select 1 from jsonb_array_elements(v_lessons) e(v) where v ->> 'id' ~ '^fff')
       or exists (select 1 from jsonb_array_elements(v_rooms) e(v) where v ->> 'id' ~ '^fff')
       or exists (
         select 1
         from jsonb_array_elements(v_lessons) e(v)
         cross join lateral jsonb_array_elements_text(v -> 'roomIds') x(id)
         where not exists (select 1 from jsonb_array_elements(v_rooms) r(w) where w ->> 'id' = x.id)
       )
       or exists (
         select 1
         from jsonb_array_elements(v_lessons) e(v)
         where regexp_replace(lower(normalize(v ->> 'kind', NFD)), '[^a-z]', '', 'g') <> 'attivitadidattica'
           and not (
             (v ->> 'title', v ->> 'titleText') in (('Esame', 'esame'), ('Prenotazione', 'prenotazione'),
               ('Altro impegno', 'altro impegno'))
             and v ->> 'directText' = v ->> 'titleText' and v ->> 'courseText' = v ->> 'titleText'
             and jsonb_array_length(v -> 'teachers') = 0 and jsonb_array_length(v -> 'courses') = 0)
       ) then
      raise exception 'payload_value' using errcode = 'P0001';
    end if;
  else
    if exists (select 1 from jsonb_array_elements(v_lessons) e(v) where v ->> 'id' !~ '^fffe')
       or exists (select 1 from jsonb_array_elements(v_rooms) e(v) where v ->> 'id' !~ '^ffff')
       or exists (
         select 1
         from jsonb_array_elements(v_lessons) e(v)
         cross join lateral jsonb_array_elements_text(v -> 'roomIds') x(id)
         where not exists (select 1 from jsonb_array_elements(v_rooms) r(w) where w ->> 'id' = x.id)
           and (x.id ~ '^fff' or not (
             exists (select 1 from aule.rooms k where k.id = x.id)
             or exists (select 1 from aule.staged_rooms k where k.run_id = p_run and k.id = x.id)))
       ) then
      raise exception 'payload_value' using errcode = 'P0001';
    end if;
  end if;

  if not (v_run_from <= v_from and v_from < v_to and v_to <= v_run_to) then
    raise exception 'payload_window' using errcode = 'P0001';
  end if;

  begin
    insert into aule.staged_calendars (run_id, calendar_id, outcome, failure, fetched_at, window_from, window_to, lessons, skipped)
    values (p_run, p_calendar, 'ok', null, now(), aule.from_ms(v_from), aule.from_ms(v_to), jsonb_array_length(v_lessons), v_skipped);

    insert into aule.staged_lessons (run_id, calendar_id, id, title, starts_at, ends_at, status, kind, courses, year, teachers,
      room_ids, title_text, direct_text, course_text)
    select p_run, p_calendar, v ->> 'id', v ->> 'title',
      aule.from_ms((v ->> 'start')::bigint), aule.from_ms((v ->> 'end')::bigint),
      (v ->> 'status')::aule.lesson_status, v ->> 'kind',
      array(select t.x from jsonb_array_elements_text(v -> 'courses') with ordinality t(x, i) order by t.i),
      (v ->> 'year')::smallint,
      array(select t.x from jsonb_array_elements_text(v -> 'teachers') with ordinality t(x, i) order by t.i),
      array(select t.x from jsonb_array_elements_text(v -> 'roomIds') with ordinality t(x, i) order by t.i),
      v ->> 'titleText', v ->> 'directText', v ->> 'courseText'
    from jsonb_array_elements(v_lessons) e(v);

    -- The same room comes with many calendars: last write wins.
    insert into aule.staged_rooms (run_id, id, name, code, building_name, capacity, effective_capacity, services,
      building_key_guess, room_key, name_compact, search_text)
    select p_run, v ->> 'id', v ->> 'name', v ->> 'code', v ->> 'buildingName',
      (v ->> 'capacity')::integer, (v ->> 'effectiveCapacity')::integer,
      array(select t.x from jsonb_array_elements_text(v -> 'services') with ordinality t(x, i) order by t.i),
      v ->> 'buildingKeyGuess', v ->> 'roomKey', v ->> 'nameCompact', v ->> 'searchText'
    from jsonb_array_elements(v_rooms) e(v)
    on conflict (run_id, id) do update set
      name = excluded.name, code = excluded.code, building_name = excluded.building_name,
      capacity = excluded.capacity, effective_capacity = excluded.effective_capacity, services = excluded.services,
      building_key_guess = excluded.building_key_guess, room_key = excluded.room_key,
      name_compact = excluded.name_compact, search_text = excluded.search_text;
  exception when others then
    raise exception 'payload_value' using errcode = 'P0001';
  end;

  if exists (
    select 1 from aule.staged_lessons sl
    where sl.run_id = p_run and sl.calendar_id = p_calendar
      and (sl.ends_at <= aule.from_ms(v_from) or sl.starts_at >= aule.from_ms(v_to))
  ) then
    raise exception 'payload_window' using errcode = 'P0001';
  end if;

  update aule.sync_runs set last_seen_at = now() where id = p_run;
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.sync_put_calendar(bigint, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function aule_sync.sync_put_calendar(bigint, text, jsonb) to aule_sync;

create function aule_sync.sync_fail_calendar(p_run bigint, p_calendar text, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_state aule.run_state;
begin
  if p_run is null or p_run < 1
     or p_calendar is null or char_length(p_calendar) <> 24 or p_calendar !~ '^[0-9a-f]{24}$'
     or p_code is null or char_length(p_code) > 20
     or p_code not in ('network', 'timeout', 'http_status', 'too_large', 'bad_json', 'bad_shape', 'bad_html', 'too_many',
       'wrong_period', 'rejected', 'unsupported', 'unexpected') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));

  select r.state into v_state from aule.sync_runs r where r.id = p_run for update;
  if not found then
    raise exception 'run_missing' using errcode = 'P0001';
  end if;
  if v_state <> 'open' then
    raise exception 'run_closed' using errcode = 'P0001';
  end if;
  if not exists (select 1 from aule.sync_run_calendars rc where rc.run_id = p_run and rc.calendar_id = p_calendar) then
    raise exception 'calendar_unknown' using errcode = 'P0001';
  end if;
  if exists (select 1 from aule.staged_calendars sc where sc.run_id = p_run and sc.calendar_id = p_calendar) then
    raise exception 'calendar_done' using errcode = 'P0001';
  end if;

  insert into aule.staged_calendars (run_id, calendar_id, outcome, failure, fetched_at)
  values (p_run, p_calendar, 'failed', p_code, now());
  update aule.sync_runs set last_seen_at = now() where id = p_run;
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.sync_fail_calendar(bigint, text, text) from public, anon, authenticated, service_role;
grant execute on function aule_sync.sync_fail_calendar(bigint, text, text) to aule_sync;

-- Publishes the staged calendars in one transaction, or aborts an implausible run and keeps the timetable.
-- A failed calendar keeps its previous lessons (fail closed).
create function aule_sync.sync_finish(p_run bigint)
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
revoke all on function aule_sync.sync_finish(bigint) from public, anon, authenticated, service_role;
grant execute on function aule_sync.sync_finish(bigint) to aule_sync;

create function aule_sync.sync_abort(p_run bigint, p_code text)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_state aule.run_state;
begin
  if p_run is null or p_run < 1
     or p_code is null or char_length(p_code) > 20
     or p_code not in ('client_id', 'network', 'timeout', 'http_status', 'too_large', 'bad_json', 'bad_shape', 'unexpected') then
    raise exception 'invalid' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));

  select r.state into v_state from aule.sync_runs r where r.id = p_run for update;
  if not found then
    raise exception 'run_missing' using errcode = 'P0001';
  end if;
  if v_state <> 'open' then
    raise exception 'run_closed' using errcode = 'P0001';
  end if;

  update aule.sync_runs set state = 'aborted', failure = p_code, finished_at = now() where id = p_run;
  delete from aule.sync_run_calendars where run_id = p_run;
  delete from aule.staged_rooms where run_id = p_run;
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.sync_abort(bigint, text) from public, anon, authenticated, service_role;
grant execute on function aule_sync.sync_abort(bigint, text) to aule_sync;

create function aule_sync.discover_begin()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_now pg_catalog.timestamptz := now();
  v_cooldown interval;
  v_started pg_catalog.timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));
  select s.request_cooldown into strict v_cooldown from aule.settings s;
  select d.started_at into strict v_started from aule.discover_state d for update;
  if v_started > v_now - v_cooldown then
    raise exception 'too_soon' using errcode = 'P0001';
  end if;

  update aule.discover_state set started_at = v_now where id;
  update aule.run_requests set pending = false, served_at = v_now
  where kind = 'discover' and pending and requested_at <= v_now;

  return jsonb_build_object(
    'sources', coalesce((select jsonb_agg(s.url order by s.position) from aule.sources s), '[]'::pg_catalog.jsonb),
    'known', coalesce((select jsonb_agg(c.id order by c.id) from aule.calendars c where c.source = 'planner'), '[]'::pg_catalog.jsonb)
  );
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.discover_begin() from public, anon, authenticated, service_role;
grant execute on function aule_sync.discover_begin() to aule_sync;

-- Replaces the proposals and the page failures; calendars already configured are skipped.
create function aule_sync.put_proposals(p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_items pg_catalog.jsonb;
  v_failures pg_catalog.jsonb;
  v_found integer;
  v_failed integer;
begin
  if p_payload is null then
    raise exception 'payload_shape' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('aule_sync', 0));

  v_items := p_payload -> 'items';
  v_failures := p_payload -> 'failures';
  if octet_length(p_payload::pg_catalog.text) > 500000
     or (case when jsonb_typeof(v_items) = 'array' then jsonb_array_length(v_items) > 600 else false end)
     or (case when jsonb_typeof(v_failures) = 'array' then jsonb_array_length(v_failures) > 60 else false end) then
    raise exception 'payload_size' using errcode = 'P0001';
  end if;

  if jsonb_typeof(p_payload) <> 'object' then
    raise exception 'payload_shape' using errcode = 'P0001';
  end if;
  if (select count(*) from jsonb_object_keys(p_payload)) <> 2
     or not p_payload ?& array['items', 'failures']
     or jsonb_typeof(v_items) is distinct from 'array'
     or jsonb_typeof(v_failures) is distinct from 'array'
     or exists (
       select 1 from jsonb_array_elements(v_items) e(v)
       where case when jsonb_typeof(v) is distinct from 'object' then true else
         (select count(*) from jsonb_object_keys(v)) <> 3
         or not v ?& array['id', 'label', 'source']
         or jsonb_typeof(v -> 'id') is distinct from 'string'
         or jsonb_typeof(v -> 'label') is distinct from 'string'
         or jsonb_typeof(v -> 'source') is distinct from 'string'
       end)
     or exists (
       select 1 from jsonb_array_elements(v_failures) e(v)
       where case when jsonb_typeof(v) is distinct from 'object' then true else
         (select count(*) from jsonb_object_keys(v)) <> 2
         or not v ?& array['source', 'failure']
         or jsonb_typeof(v -> 'source') is distinct from 'string'
         or jsonb_typeof(v -> 'failure') is distinct from 'string'
       end) then
    raise exception 'payload_shape' using errcode = 'P0001';
  end if;

  if exists (select 1 from jsonb_array_elements(v_items) e(v) group by v ->> 'id' having count(*) > 1)
     or exists (select 1 from jsonb_array_elements(v_items) e(v) where v ->> 'id' !~ '^[0-9a-f]{24}$' or v ->> 'id' ~ '^fff')
     or exists (
       select 1 from (
         select v ->> 'source' as url from jsonb_array_elements(v_items) e(v)
         union all
         select v ->> 'source' from jsonb_array_elements(v_failures) e(v)
       ) u
       where not exists (select 1 from aule.sources s where s.url = u.url)) then
    raise exception 'payload_value' using errcode = 'P0001';
  end if;

  begin
    delete from aule.proposals where true;
    delete from aule.discover_failures where true;
    insert into aule.proposals (calendar_id, label, source, found_at)
    select e.v ->> 'id', e.v ->> 'label', e.v ->> 'source', now()
    from jsonb_array_elements(v_items) with ordinality e(v, i)
    where not exists (select 1 from aule.calendars c where c.id = e.v ->> 'id')
    order by e.i;
    get diagnostics v_found = row_count;
    insert into aule.discover_failures (position, source, failure)
    select e.i, e.v ->> 'source', e.v ->> 'failure'
    from jsonb_array_elements(v_failures) with ordinality e(v, i);
    get diagnostics v_failed = row_count;
  exception when others then
    raise exception 'payload_value' using errcode = 'P0001';
  end;

  update aule.discover_state set finished_at = now(), found = v_found where id;
  return jsonb_build_object('found', v_found, 'failures', v_failed);
exception
  when sqlstate 'P0001' or insufficient_privilege then raise;
  when others then raise exception 'internal' using errcode = 'P0001';
end
$$;
revoke all on function aule_sync.put_proposals(jsonb) from public, anon, authenticated, service_role;
grant execute on function aule_sync.put_proposals(jsonb) to aule_sync;

-- Hand the functions to the NOLOGIN owner. Grants made above move with the ownership.
grant create on schema aule_sync to aule_ingest;
alter function aule_sync.ping() owner to aule_ingest;
alter function aule_sync.sync_begin(text) owner to aule_ingest;
alter function aule_sync.sync_put_calendar(bigint, text, jsonb) owner to aule_ingest;
alter function aule_sync.sync_fail_calendar(bigint, text, text) owner to aule_ingest;
alter function aule_sync.sync_finish(bigint) owner to aule_ingest;
alter function aule_sync.sync_abort(bigint, text) owner to aule_ingest;
alter function aule_sync.discover_begin() owner to aule_ingest;
alter function aule_sync.put_proposals(jsonb) owner to aule_ingest;
revoke create on schema aule_sync from aule_ingest;

grant create on schema aule to aule_ingest;
alter function aule.refresh_timetable() owner to aule_ingest;
revoke create on schema aule from aule_ingest;
-- postgres runs the rebuild from the SQL editor and the tests; only the new owner can grant it.
set role aule_ingest;
grant execute on function aule.refresh_timetable() to postgres;
reset role;
