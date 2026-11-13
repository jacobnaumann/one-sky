-- One Sky: breakers that fail toward ordinary visitors, wave confirmation, echo handle privacy.
--
--  1. my_wavers(): who waved at the caller in the last 10 minutes, so a client can confirm a
--     "wave" realtime broadcast before showing it.
--  2. Global ceilings keep a reserve for ordinary visitors instead of closing for everyone:
--     send_wave still makes a thread above the hourly ceiling when both ends have fewer than two
--     threads in 24 h; release_lantern still takes a uid's first lantern of the UTC day. Both stop
--     at twice the ceiling. A global refusal of a lantern raises 'sky_busy', not 'rate_limited'.
--     Tripping the auto-hide breaker buys nothing: while it is tripped only first lanterns of the
--     day are accepted, and _prune() hides the reported backlog a few at a time.
--     A limits.value of 0 means "none allowed" everywhere.
--  3. An echo's public handle (eid) is replaced when its owner returns after 30 minutes away, and
--     recent_echoes() rounds last_seen down to 10 minutes.
--  4. wave_echo at the 40-pending cap replaces the oldest pending row instead of dropping the new one.
--
-- Every signature and return shape is unchanged.

-- ───────────────────────────── my_wavers ─────────────────────────────

-- Uids are not secret (see the note in 20261113050000_hardening.sql): the caller already sees the
-- sender's uid as a presence key. This only says which of them really waved.
create function public.my_wavers() returns json
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select json_agg(s.from_uid)
       from (select distinct w.from_uid from waves w
              where w.to_uid = auth.uid() and w.created_at > now() - interval '10 minutes') s),
    '[]'::json);
$$;

-- ───────────────────────────── check_in / recent_echoes ─────────────────────────────

-- As before, plus: an echo row last seen more than 30 minutes ago gets a fresh eid, so the handle
-- does not link visits hours apart. Pending echo_waves are keyed by to_uid, so none are lost.
create or replace function public.check_in(p_lat real, p_lon real, p_place text, p_tz text, p_zone int)
returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_pl places;
  v_zone int;
begin
  v_pl := _place(p_tz, p_lat, p_lon);
  if p_zone is not null and (p_zone < 0 or p_zone > 23) then raise exception 'invalid_input'; end if;
  v_zone := _zone_for_tz(p_tz, p_zone);

  if not _rate_take(v_uid, 'check_in', interval '1 hour', 30) then return; end if;

  insert into echoes (uid, lat, lon, place, tz, zone, last_seen)
  values (v_uid, p_lat, p_lon, v_pl.city, v_pl.tz, v_zone, now())
  on conflict (uid) do update
    set lat = excluded.lat, lon = excluded.lon, place = excluded.place,
        tz = excluded.tz, zone = excluded.zone, last_seen = now(),
        eid = case when echoes.last_seen < now() - interval '30 minutes'
                   then gen_random_uuid() else echoes.eid end;

  -- _rate_take holds the per-uid lock, so this count cannot be raced by the same uid.
  if (select count(*) from zone_days where day = _utc_day() and uid = v_uid) < _limit('zones_per_uid_day') then
    insert into zone_days (day, zone, place, uid) values (_utc_day(), v_zone, v_pl.city, v_uid)
    on conflict do nothing;
  end if;
end $$;

-- Same rows, order and limit; last_seen is rounded down to 10 minutes.
create or replace function public.recent_echoes()
returns table (eid uuid, lat real, lon real, place text, last_seen timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.eid, e.lat, e.lon, e.place, date_bin('10 minutes', e.last_seen, 'epoch'::timestamptz)
    from echoes e
   where e.last_seen > now() - interval '48 hours'
     and e.uid is distinct from auth.uid()
   order by e.last_seen desc
   limit 400;
$$;

-- ───────────────────────────── release_lantern ─────────────────────────────

-- Order of refusals: the caller's own budget first ('rate_limited'), then the sky ('sky_busy').
--   * At or above lanterns_global_hour lanterns in the last hour, only a uid's first lantern of the
--     UTC day is taken, and at twice the ceiling nothing is.
--   * While the auto-hide breaker is tripped (autohide_per_hour or more lanterns auto-hidden in the
--     last hour), only a uid's first lantern of the UTC day is taken.
create or replace function public.release_lantern(p_body text, p_question_id int, p_lat real, p_lon real,
                                                  p_place text, p_tz text)
returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_body text := _squash(p_body);
  v_pl places;
  v_problem text;
  v_lat float8;
  v_lon float8;
  v_row lanterns;
  v_day_start timestamptz := (_utc_day()::timestamp at time zone 'utc');
  v_first boolean;
  v_hour bigint;
  v_cap bigint;
begin
  if v_body = '' then raise exception 'empty'; end if;
  if char_length(v_body) > 140 then raise exception 'too_long'; end if;
  v_problem := _text_problem(v_body);
  if v_problem is not null then raise exception '%', v_problem; end if;

  v_pl := _place(p_tz, p_lat, p_lon);
  if p_question_id is null or p_question_id < 0 or p_question_id > 100000 then
    raise exception 'invalid_input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  if exists (select 1 from rate_events
              where uid = v_uid and kind = 'lantern' and at > now() - interval '30 seconds')
     or (select count(*) from rate_events
          where uid = v_uid and kind = 'lantern' and at >= v_day_start) >= 5 then
    raise exception 'rate_limited';
  end if;

  -- Under the per-uid lock, so two parallel calls cannot both be "first of the day".
  v_first := not exists (select 1 from lanterns where uid = v_uid and created_at >= v_day_start);

  select count(*) into v_hour from lanterns where created_at > now() - interval '1 hour';
  v_cap := _limit('lanterns_global_hour');
  if v_hour >= v_cap and (not v_first or v_hour >= 2 * v_cap) then
    raise exception 'sky_busy';
  end if;
  if not v_first
     and (select count(*) from lanterns where hidden_at > now() - interval '1 hour') >= _limit('autohide_per_hour') then
    raise exception 'sky_busy';
  end if;

  insert into rate_events (uid, kind) values (v_uid, 'lantern');

  v_lat := greatest(-89.5, least(89.5, v_pl.lat + (random() * 2 - 1) * 0.5));
  v_lon := v_pl.lon + (random() * 2 - 1) * 0.5;
  v_lon := v_lon - 360 * floor((v_lon + 180) / 360);

  insert into lanterns (uid, day, question_id, body, lat, lon, place, tz)
  values (v_uid, _utc_day(), p_question_id, v_body,
          round(v_lat::numeric, 3)::real, round(v_lon::numeric, 3)::real, v_pl.city, v_pl.tz)
  returning * into v_row;

  return _lantern_json(v_row);
end $$;

-- ───────────────────────────── report_lantern ─────────────────────────────

-- As before, plus: a report of your own lantern is a silent no-op (no budget spent), and an
-- autohide_per_hour of 0 hides nothing.
create or replace function public.report_lantern(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_reports int;
  v_hide boolean;
begin
  -- Nothing to report (unknown, seeded, already hidden, expired, the caller's own, or already
  -- reported by this uid): return without spending budget.
  if not exists (select 1 from lanterns
                  where id = p_id and not seeded and not hidden
                    and uid is distinct from v_uid
                    and created_at > now() - interval '48 hours') then
    return;
  end if;
  if exists (select 1 from reports where lantern_id = p_id and uid = v_uid) then return; end if;

  if not _rate_take(v_uid, 'report', interval '24 hours', _limit('reports_per_day')) then
    raise exception 'rate_limited';
  end if;

  select reports into v_reports from lanterns
   where id = p_id and not seeded and not hidden for update;
  if not found then return; end if;

  insert into reports (lantern_id, uid) values (p_id, v_uid) on conflict do nothing;
  if not found then return; end if;

  -- Breaker: a report brigade cannot empty the sky at once. At the hourly ceiling reports are
  -- still counted but nothing more is hidden here; _prune() hides the backlog a few at a time.
  v_hide := v_reports + 1 >= 3
    and (select count(*) from lanterns where hidden_at > now() - interval '1 hour') < _limit('autohide_per_hour');

  update lanterns
     set reports = reports + 1,
         hidden = v_hide,
         hidden_at = case when v_hide then now() end
   where id = p_id;

  -- A hidden row no longer passes the select policy, so postgres_changes cannot announce it.
  -- Tell open clients over the public `sky` channel instead. Best effort only.
  if v_hide then
    begin
      perform realtime.send(jsonb_build_object('id', p_id), 'lantern_hidden', 'sky', false);
    exception when others then null;
    end;
  end if;
end $$;

-- ───────────────────────────── send_wave ─────────────────────────────

-- As before, except the global hourly breaker: at or above threads_global_hour threads in the last
-- hour a thread is still made when both ends have fewer than two threads in the last 24 hours, up
-- to twice the ceiling. Burning that reserve costs one fresh identity per thread.
create or replace function public.send_wave(p_to uuid, p_lat real, p_lon real, p_place text, p_tz text default null)
returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_tz text;
  v_pl places;
  v_theirs waves;
  v_thread threads;
  v_cap int;
  v_mine_n bigint;
  v_their_n bigint;
  v_hour bigint;
  v_glob bigint;
begin
  if p_to is null or p_to = v_uid then raise exception 'invalid_target'; end if;
  perform _check_geo(p_lat, p_lon);
  -- Older clients send no zone: use the one from their last check_in.
  v_tz := coalesce(p_tz, (select e.tz from echoes e where e.uid = v_uid));
  v_pl := _place(v_tz, p_lat, p_lon);

  if not _rate_take(v_uid, 'wave', interval '1 minute', _limit('wave_per_min')) then
    raise exception 'rate_limited';
  end if;

  -- One lock per unordered pair, so two waves crossing in flight make one thread, not two.
  perform pg_advisory_xact_lock(
    hashtextextended(least(v_uid, p_to)::text || greatest(v_uid, p_to)::text, 1));

  insert into waves (from_uid, to_uid, lat, lon, place) values (v_uid, p_to, p_lat, p_lon, v_pl.city);

  select * into v_theirs from waves
   where to_uid = v_uid and from_uid = p_to and created_at > now() - interval '10 minutes'
   order by created_at desc limit 1;
  if not found then return json_build_object('thread', null); end if;

  if exists (select 1 from threads
              where created_at > now() - interval '24 hours'
                and ((a_uid = v_uid and b_uid = p_to) or (a_uid = p_to and b_uid = v_uid))) then
    return json_build_object('thread', null);
  end if;

  -- Growth limits: per participant per day, and a global hourly breaker with a reserve.
  v_cap := _limit('threads_per_uid_day');
  select count(*) into v_mine_n from threads
   where created_at > now() - interval '24 hours' and (a_uid = v_uid or b_uid = v_uid);
  select count(*) into v_their_n from threads
   where created_at > now() - interval '24 hours' and (a_uid = p_to or b_uid = p_to);
  if v_mine_n >= v_cap or v_their_n >= v_cap then
    return json_build_object('thread', null);
  end if;

  select count(*) into v_hour from threads where created_at > now() - interval '1 hour';
  v_glob := _limit('threads_global_hour');
  if v_hour >= v_glob and (v_hour >= 2 * v_glob or v_mine_n >= 2 or v_their_n >= 2) then
    return json_build_object('thread', null);
  end if;

  insert into threads (a_uid, b_uid, a_lat, a_lon, a_place, b_lat, b_lon, b_place, km)
  values (p_to, v_uid, v_theirs.lat, v_theirs.lon, v_theirs.place, p_lat, p_lon, v_pl.city,
          _km(v_theirs.lat, v_theirs.lon, p_lat, p_lon))
  returning * into v_thread;

  update world_totals set threads_total = threads_total + 1, km_total = km_total + v_thread.km
   where id;

  return json_build_object('thread', json_build_object(
    'id', v_thread.id,
    'a_lat', v_thread.a_lat, 'a_lon', v_thread.a_lon, 'a_place', v_thread.a_place,
    'b_lat', v_thread.b_lat, 'b_lon', v_thread.b_lon, 'b_place', v_thread.b_place,
    'km', v_thread.km, 'created_at', v_thread.created_at));
end $$;

-- ───────────────────────────── wave_echo ─────────────────────────────

-- As before, except at the cap: with 40 rows pending for the recipient, a new sender's wave
-- replaces the oldest pending row instead of being dropped.
create or replace function public.wave_echo(p_eid uuid, p_lat real, p_lon real, p_tz text)
returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_pl places;
  v_to uuid;
begin
  v_pl := _place(p_tz, p_lat, p_lon);

  select e.uid into v_to from echoes e where e.eid = p_eid;
  if not found then raise exception 'not_found'; end if;
  if v_to = v_uid then raise exception 'invalid_target'; end if;

  if not _rate_take(v_uid, 'echo_wave', interval '1 hour', _limit('echo_wave_per_hour')) then
    raise exception 'rate_limited';
  end if;

  -- One lock per recipient (seed 2: not the per-uid lock _rate_take holds, so two visitors waving
  -- at each other's echoes cannot deadlock), so the cap below cannot be raced past.
  perform pg_advisory_xact_lock(hashtextextended(v_to::text, 2));

  -- At most 40 pending per recipient. A repeat from the same sender only refreshes its own row.
  if not exists (select 1 from echo_waves where to_uid = v_to and from_uid = v_uid) then
    delete from echo_waves
     where id in (select id from echo_waves where to_uid = v_to
                   order by created_at desc, id desc offset 39);
  end if;

  insert into echo_waves (to_uid, from_uid, from_place, from_tz, from_lat, from_lon)
  values (v_to, v_uid, v_pl.city, v_pl.tz, p_lat, p_lon)
  on conflict (to_uid, from_uid) do update
    set created_at = now(), from_place = excluded.from_place, from_tz = excluded.from_tz,
        from_lat = excluded.from_lat, from_lon = excluded.from_lon;

  return json_build_object('ok', true);
end $$;

-- ───────────────────────────── housekeeping ─────────────────────────────

-- As before, plus catch-up for the auto-hide breaker: up to 5 lanterns per run that gathered three
-- reports while the breaker was tripped are hidden (oldest first; only ones still inside the 48 h
-- in which a lantern is visible), and announced on `sky` exactly as report_lantern does.
create or replace function public._prune() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  delete from lanterns where not seeded and created_at < now() - interval '7 days';
  delete from waves where created_at < now() - interval '15 minutes';
  delete from threads where created_at < now() - interval '14 days';
  delete from rate_events
   where (kind = 'wave' and at < now() - interval '5 minutes')
      or (kind in ('warm', 'check_in') and at < now() - interval '2 hours')
      or at < now() - interval '2 days';
  delete from echoes where last_seen < now() - interval '3 days';
  delete from echo_waves where created_at < now() - interval '7 days';

  for v_id in
    update lanterns set hidden = true, hidden_at = now()
     where id in (select l.id from lanterns l
                   where l.reports >= 3 and not l.hidden and not l.seeded
                     and l.created_at > now() - interval '48 hours'
                   order by l.created_at, l.id
                   limit 5
                   for update skip locked)
    returning id
  loop
    begin
      perform realtime.send(jsonb_build_object('id', v_id), 'lantern_hidden', 'sky', false);
    exception when others then null;
    end;
  end loop;
end $$;

-- ───────────────────────────── privileges ─────────────────────────────

revoke execute on function public.my_wavers() from public, anon, authenticated;
grant execute on function public.my_wavers() to anon, authenticated;

notify pgrst, 'reload schema';
