-- One Sky: leave a wave for an echo.
--
-- An echo is a visitor who was here in the last 48 hours and has left. A live visitor can leave a
-- wave for one; the echo's owner collects it (once) the next time they arrive.
--
-- Echoes are keyed by uid, which clients never see in tables. `eid` is an opaque public handle for
-- one echo row, so a client can name an echo without learning whose it is.

-- ───────────────────────────── echoes.eid ─────────────────────────────

alter table public.echoes add column eid uuid not null default gen_random_uuid();
alter table public.echoes add constraint echoes_eid_key unique (eid);

-- Return type changes, so drop and recreate. Same rows, order and limit as before, plus eid, minus
-- the caller's own echo (nobody is shown themselves as someone who has left).
drop function public.recent_echoes();

create function public.recent_echoes()
returns table (eid uuid, lat real, lon real, place text, last_seen timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select e.eid, e.lat, e.lon, e.place, e.last_seen
    from echoes e
   where e.last_seen > now() - interval '48 hours'
     and e.uid is distinct from auth.uid()
   order by e.last_seen desc
   limit 400;
$$;

-- ───────────────────────────── echo_waves ─────────────────────────────
-- Pending waves, one per (recipient, sender). No client access; read only through
-- collect_echo_waves(), which never returns a uid.

create table public.echo_waves (
  id         bigint generated always as identity primary key,
  to_uid     uuid not null,
  from_uid   uuid not null,
  from_place text not null,
  from_tz    text not null,
  from_lat   real not null,
  from_lon   real not null,
  created_at timestamptz not null default now(),
  unique (to_uid, from_uid)
);
create index echo_waves_to_uid_idx on public.echo_waves (to_uid);
alter table public.echo_waves enable row level security;
revoke all on public.echo_waves from public, anon, authenticated;

insert into public.limits (key, value, def) values
  ('echo_wave_per_hour', 12, 12);  -- wave_echo calls per uid per hour

-- ───────────────────────────── client-facing functions ─────────────────────────────

-- The caller's place is checked exactly as in send_wave: zone must be in places, position inside
-- its jitter box, and the stored name is places.city.
create function public.wave_echo(p_eid uuid, p_lat real, p_lon real, p_tz text)
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

  -- At most 40 pending per recipient. A repeat from the same sender only refreshes its own row,
  -- so it is always allowed.
  if (select count(*) from echo_waves where to_uid = v_to) >= 40
     and not exists (select 1 from echo_waves where to_uid = v_to and from_uid = v_uid) then
    return json_build_object('ok', true);
  end if;

  insert into echo_waves (to_uid, from_uid, from_place, from_tz, from_lat, from_lon)
  values (v_to, v_uid, v_pl.city, v_pl.tz, p_lat, p_lon)
  on conflict (to_uid, from_uid) do update
    set created_at = now(), from_place = excluded.from_place, from_tz = excluded.from_tz,
        from_lat = excluded.from_lat, from_lon = excluded.from_lon;

  return json_build_object('ok', true);
end $$;

-- Delivered once: every row addressed to the caller is deleted; the newest 20 of the last 7 days
-- are returned.
create function public.collect_echo_waves() returns json
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := _uid();
  v_out json;
begin
  with d as (
    delete from echo_waves where to_uid = v_uid
    returning from_place, from_tz, from_lat, from_lon, created_at
  ), top as (
    select * from d
     where created_at > now() - interval '7 days'
     order by created_at desc
     limit 20
  )
  select coalesce(json_agg(json_build_object(
           'place', from_place, 'tz', from_tz, 'lat', from_lat, 'lon', from_lon,
           'created_at', created_at) order by created_at desc), '[]'::json)
    into v_out from top;
  return v_out;
end $$;

-- ───────────────────────────── housekeeping ─────────────────────────────

-- As before, plus undelivered echo waves after 7 days. The echo_wave limiter's window is 1 h and
-- its rate_events are kept 2 days.
create or replace function public._prune() returns void
language sql security definer set search_path = public, pg_temp as $$
  delete from lanterns where not seeded and created_at < now() - interval '7 days';
  delete from waves where created_at < now() - interval '15 minutes';
  delete from threads where created_at < now() - interval '14 days';
  delete from rate_events
   where (kind = 'wave' and at < now() - interval '5 minutes')
      or (kind in ('warm', 'check_in') and at < now() - interval '2 hours')
      or at < now() - interval '2 days';
  delete from echoes where last_seen < now() - interval '3 days';
  delete from echo_waves where created_at < now() - interval '7 days';
$$;

-- ───────────────────────────── privileges ─────────────────────────────

revoke execute on function
  public.recent_echoes(),
  public.wave_echo(uuid, real, real, text),
  public.collect_echo_waves()
from public, anon, authenticated;

grant execute on function
  public.recent_echoes(),
  public.wave_echo(uuid, real, real, text),
  public.collect_echo_waves()
to anon, authenticated;

notify pgrst, 'reload schema';
