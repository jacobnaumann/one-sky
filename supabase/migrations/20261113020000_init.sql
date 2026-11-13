-- One Sky: schema, policies, functions, realtime, housekeeping, seed.
-- Invariants: RLS on every table; no direct client writes; uids never readable by clients.

-- ───────────────────────────── tables ─────────────────────────────

create table public.lanterns (
  id          uuid primary key default gen_random_uuid(),
  uid         uuid null,
  day         date not null,
  question_id int  not null,
  body        text not null check (char_length(body) between 1 and 140),
  lat         real not null check (lat between -90 and 90),
  lon         real not null check (lon between -180 and 180),
  place       text not null check (char_length(place) <= 60),
  tz          text not null check (char_length(tz) <= 64),
  warmth      int  not null default 0,
  reports     int  not null default 0,
  hidden      boolean not null default false,
  seeded      boolean not null default false,
  created_at  timestamptz not null default now()
);
create index lanterns_created_at_idx on public.lanterns (created_at desc);
create index lanterns_uid_idx on public.lanterns (uid, created_at desc);

create table public.warmths (
  lantern_id uuid not null references public.lanterns on delete cascade,
  uid        uuid not null,
  primary key (lantern_id, uid)
);
create index warmths_uid_idx on public.warmths (uid);

create table public.reports (
  lantern_id uuid not null references public.lanterns on delete cascade,
  uid        uuid not null,
  primary key (lantern_id, uid)
);

create table public.waves (
  id         bigint generated always as identity primary key,
  from_uid   uuid not null,
  to_uid     uuid not null,
  lat        real not null,
  lon        real not null,
  place      text not null,
  created_at timestamptz not null default now()
);
create index waves_pair_idx on public.waves (to_uid, from_uid, created_at);
create index waves_created_at_idx on public.waves (created_at);

create table public.threads (
  id         uuid primary key default gen_random_uuid(),
  a_uid      uuid not null,
  b_uid      uuid not null,
  a_lat      real not null,
  a_lon      real not null,
  a_place    text not null,
  b_lat      real not null,
  b_lon      real not null,
  b_place    text not null,
  km         real not null,
  created_at timestamptz not null default now()
);
create index threads_a_idx on public.threads (a_uid, b_uid, created_at desc);
create index threads_b_idx on public.threads (b_uid, a_uid, created_at desc);
create index threads_created_at_idx on public.threads (created_at desc);

create table public.echoes (
  uid       uuid primary key,
  lat       real not null,
  lon       real not null,
  place     text not null,
  tz        text not null,
  zone      int  not null check (zone between 0 and 23),
  last_seen timestamptz not null default now()
);
create index echoes_last_seen_idx on public.echoes (last_seen desc);

create table public.zone_days (
  day    date not null,
  zone   int  not null check (zone between 0 and 23),
  place  text not null,
  lit_at timestamptz not null default now(),
  primary key (day, zone)
);

create table public.rate_events (
  uid  uuid not null,
  kind text not null,
  at   timestamptz not null default now()
);
create index rate_events_idx on public.rate_events (uid, kind, at);
create index rate_events_at_idx on public.rate_events (at);

-- Running totals so world_stats() never has to scan threads.
create table public.world_totals (
  id            boolean primary key default true check (id),
  threads_total bigint not null default 0,
  km_total      double precision not null default 0
);
insert into public.world_totals (id) values (true);

-- ───────────────────────── RLS and privileges ─────────────────────────

alter table public.lanterns     enable row level security;
alter table public.warmths      enable row level security;
alter table public.reports      enable row level security;
alter table public.waves        enable row level security;
alter table public.threads      enable row level security;
alter table public.echoes       enable row level security;
alter table public.zone_days    enable row level security;
alter table public.rate_events  enable row level security;
alter table public.world_totals enable row level security;

-- Supabase grants ALL on new public tables to anon/authenticated by default. Take it all away,
-- then hand back only column-level SELECT on what a client may see.
revoke all on public.lanterns, public.warmths, public.reports, public.waves, public.threads,
              public.echoes, public.zone_days, public.rate_events, public.world_totals
  from public, anon, authenticated;

grant select (id, day, question_id, body, lat, lon, place, tz, warmth, seeded, created_at)
  on public.lanterns to anon, authenticated;
grant select (id, a_lat, a_lon, a_place, b_lat, b_lon, b_place, km, created_at)
  on public.threads to anon, authenticated;
grant select (day, zone, place, lit_at) on public.zone_days to anon, authenticated;
grant select (lantern_id, uid) on public.warmths to anon, authenticated;

create policy lanterns_select on public.lanterns for select to anon, authenticated
  using (not hidden and (seeded or created_at > now() - interval '48 hours'));
create policy threads_select on public.threads for select to anon, authenticated
  using (true);
create policy zone_days_select on public.zone_days for select to anon, authenticated
  using (true);
create policy warmths_select_own on public.warmths for select to anon, authenticated
  using (uid = (select auth.uid()));

-- ───────────────────────── internal helpers ─────────────────────────

create function public._uid() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v uuid := auth.uid();
begin
  if v is null then raise exception 'not_authenticated'; end if;
  return v;
end $$;

-- Takes one slot of a (uid, kind) budget. Serialised per uid so parallel calls cannot overshoot.
create function public._rate_take(p_uid uuid, p_kind text, p_window interval, p_max int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_uid::text, 0));
  select count(*) into n from rate_events
   where uid = p_uid and kind = p_kind and at > now() - p_window;
  if n >= p_max then return false; end if;
  insert into rate_events (uid, kind) values (p_uid, p_kind);
  return true;
end $$;

create function public._squash(p text) returns text
language sql immutable set search_path = public as $$
  select btrim(regexp_replace(regexp_replace(coalesce(p, ''), '[[:cntrl:]]', ' ', 'g'), '\s+', ' ', 'g'));
$$;

-- Returns null when clean, otherwise the machine-readable reason.
create function public._text_problem(p text) returns text
language sql immutable set search_path = public as $$
  select case
    when p ~* '(https?:|ftp:|www\.|://)'
      or p ~* '\m[a-z0-9-]+\.(com|net|org|io|co|ly|gg|tv|cc|app|dev|xyz|info|biz|link|ru|uk|de|fr|nl|br|cn|jp|au)\M'
      or p ~* '[a-z0-9]\.[a-z]{2,}/'
      or p ~* '\m[a-z0-9-]+\s*(\(dot\)|\[dot\]|\sdot\s)\s*(com|net|org|io)\M'
      then 'link'
    when p ~ '@\s*[[:alnum:]_]'
      or p ~* '\m(at)\s+[a-z0-9-]+\s+dot\s+[a-z]{2,}\M'
      or p ~ '(\d[\s().+-]*){8,}'
      then 'contact'
    when p ~* '\m(f+u+c+k+\w*|motherf\w+|sh[i1]+t+\w*|bullshit|c+u+n+t+s?|b[i1]tch\w*|a+s+s+h+o+l+e+s?|d[i1]ckhead\w*|c[o0]cks?|cocksuck\w*|pussy|pussies|wh[o0]res?|sluts?|bastards?|wank\w*|twats?|jizz|cum|rape[ds]?|rapist\w*|raping|porn\w*|n[i1]gg(er|a|ah|uh)s?|f[a4]gg?(ot)?s?|k[i1]kes?|sp[i1]cs?|ch[i1]nks?|g[o0]{2}ks?|wetbacks?|tr[a4]nn(y|ie)s?|retard\w*|dykes?|coons?|paki(s)?|kys|kill\s+yourself|nazis?|hitler)\M'
      then 'blocked'
    else null
  end;
$$;

create function public._check_geo(p_lat real, p_lon real) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p_lat is null or p_lon is null
     or p_lat = 'NaN'::real or p_lon = 'NaN'::real
     or p_lat < -90 or p_lat > 90 or p_lon < -180 or p_lon > 180 then
    raise exception 'invalid_input';
  end if;
end $$;

-- A place is a city name from the client's table, but it is still client-supplied text that other
-- people see, so it gets the same link/contact/blocklist screen as a lantern.
create function public._clean_place(p text) returns text
language plpgsql immutable set search_path = public as $$
declare v text := _squash(p);
begin
  if char_length(v) < 1 or char_length(v) > 60 or _text_problem(v) is not null then
    raise exception 'invalid_input';
  end if;
  return v;
end $$;

create function public._check_tz(p text) returns void
language plpgsql immutable set search_path = public as $$
begin
  if p is null or p !~ '^[A-Za-z0-9_+/-]{1,64}$' then raise exception 'invalid_input'; end if;
end $$;

create function public._utc_day() returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'utc')::date;
$$;

create function public._km(lat1 real, lon1 real, lat2 real, lon2 real) returns real
language sql immutable set search_path = public as $$
  select (2 * 6371 * asin(sqrt(least(1.0, greatest(0.0,
    power(sin(radians(lat2::float8 - lat1) / 2), 2)
    + cos(radians(lat1::float8)) * cos(radians(lat2::float8))
      * power(sin(radians(lon2::float8 - lon1) / 2), 2))))))::real;
$$;

create function public._lantern_json(l public.lanterns) returns json
language sql immutable set search_path = public as $$
  select json_build_object(
    'id', l.id, 'day', l.day, 'question_id', l.question_id, 'body', l.body,
    'lat', l.lat, 'lon', l.lon, 'place', l.place, 'tz', l.tz,
    'warmth', l.warmth, 'seeded', l.seeded, 'created_at', l.created_at);
$$;

-- ───────────────────────── client-facing functions ─────────────────────────

create function public.check_in(p_lat real, p_lon real, p_place text, p_tz text, p_zone int)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _uid();
  v_place text;
begin
  perform _check_geo(p_lat, p_lon);
  perform _check_tz(p_tz);
  v_place := _clean_place(p_place);
  if p_zone is null or p_zone < 0 or p_zone > 23 then raise exception 'invalid_input'; end if;

  if not _rate_take(v_uid, 'check_in', interval '1 hour', 30) then return; end if;

  insert into echoes (uid, lat, lon, place, tz, zone, last_seen)
  values (v_uid, p_lat, p_lon, v_place, p_tz, p_zone, now())
  on conflict (uid) do update
    set lat = excluded.lat, lon = excluded.lon, place = excluded.place,
        tz = excluded.tz, zone = excluded.zone, last_seen = now();

  insert into zone_days (day, zone, place) values (_utc_day(), p_zone, v_place)
  on conflict do nothing;
end $$;

create function public.release_lantern(p_body text, p_question_id int, p_lat real, p_lon real,
                                       p_place text, p_tz text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _uid();
  v_body text := _squash(p_body);
  v_place text;
  v_problem text;
  v_row lanterns;
begin
  if v_body = '' then raise exception 'empty'; end if;
  if char_length(v_body) > 140 then raise exception 'too_long'; end if;
  v_problem := _text_problem(v_body);
  if v_problem is not null then raise exception '%', v_problem; end if;

  perform _check_geo(p_lat, p_lon);
  perform _check_tz(p_tz);
  v_place := _clean_place(p_place);
  if p_question_id is null or p_question_id < 0 or p_question_id > 100000 then
    raise exception 'invalid_input';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_uid::text, 0));
  if exists (select 1 from rate_events
              where uid = v_uid and kind = 'lantern' and at > now() - interval '30 seconds')
     or (select count(*) from rate_events
          where uid = v_uid and kind = 'lantern'
            and at >= (_utc_day()::timestamp at time zone 'utc')) >= 5 then
    raise exception 'rate_limited';
  end if;
  insert into rate_events (uid, kind) values (v_uid, 'lantern');

  insert into lanterns (uid, day, question_id, body, lat, lon, place, tz)
  values (v_uid, _utc_day(), p_question_id, v_body, p_lat, p_lon, v_place, p_tz)
  returning * into v_row;

  return _lantern_json(v_row);
end $$;

create function public.warm_lantern(p_id uuid) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _uid();
  v_warmth int;
begin
  if not _rate_take(v_uid, 'warm', interval '1 hour', 60) then
    raise exception 'rate_limited';
  end if;

  select warmth into v_warmth from lanterns
   where id = p_id and not hidden and (seeded or created_at > now() - interval '48 hours');
  if not found then raise exception 'not_found'; end if;

  insert into warmths (lantern_id, uid) values (p_id, v_uid) on conflict do nothing;
  if found then
    update lanterns set warmth = warmth + 1 where id = p_id returning warmth into v_warmth;
  end if;
  return v_warmth;
end $$;

create function public.report_lantern(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _uid();
  v_was_hidden boolean;
  v_hidden boolean;
begin
  if not _rate_take(v_uid, 'report', interval '24 hours', 20) then
    raise exception 'rate_limited';
  end if;

  -- Welcome notes from the project cannot be reported away.
  select hidden into v_was_hidden from lanterns where id = p_id and not seeded for update;
  if not found then return; end if;

  insert into reports (lantern_id, uid) values (p_id, v_uid) on conflict do nothing;
  if not found then return; end if;

  update lanterns
     set reports = reports + 1, hidden = hidden or reports + 1 >= 3
   where id = p_id
   returning hidden into v_hidden;

  -- A hidden row no longer passes the select policy, so postgres_changes cannot announce it.
  -- Tell open clients over the public `sky` channel instead. Best effort only.
  if v_hidden and not v_was_hidden then
    begin
      perform realtime.send(jsonb_build_object('id', p_id), 'lantern_hidden', 'sky', false);
    exception when others then null;
    end;
  end if;
end $$;

create function public.send_wave(p_to uuid, p_lat real, p_lon real, p_place text)
returns json
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := _uid();
  v_place text;
  v_theirs waves;
  v_thread threads;
begin
  if p_to is null or p_to = v_uid then raise exception 'invalid_target'; end if;
  perform _check_geo(p_lat, p_lon);
  v_place := _clean_place(p_place);

  if not _rate_take(v_uid, 'wave', interval '1 minute', 30) then
    raise exception 'rate_limited';
  end if;

  -- One lock per unordered pair, so two waves crossing in flight make one thread, not two.
  perform pg_advisory_xact_lock(
    hashtextextended(least(v_uid, p_to)::text || greatest(v_uid, p_to)::text, 1));

  insert into waves (from_uid, to_uid, lat, lon, place) values (v_uid, p_to, p_lat, p_lon, v_place);

  select * into v_theirs from waves
   where to_uid = v_uid and from_uid = p_to and created_at > now() - interval '10 minutes'
   order by created_at desc limit 1;
  if not found then return json_build_object('thread', null); end if;

  if exists (select 1 from threads
              where created_at > now() - interval '24 hours'
                and ((a_uid = v_uid and b_uid = p_to) or (a_uid = p_to and b_uid = v_uid))) then
    return json_build_object('thread', null);
  end if;

  insert into threads (a_uid, b_uid, a_lat, a_lon, a_place, b_lat, b_lon, b_place, km)
  values (p_to, v_uid, v_theirs.lat, v_theirs.lon, v_theirs.place, p_lat, p_lon, v_place,
          _km(v_theirs.lat, v_theirs.lon, p_lat, p_lon))
  returning * into v_thread;

  update world_totals set threads_total = threads_total + 1, km_total = km_total + v_thread.km;

  return json_build_object('thread', json_build_object(
    'id', v_thread.id,
    'a_lat', v_thread.a_lat, 'a_lon', v_thread.a_lon, 'a_place', v_thread.a_place,
    'b_lat', v_thread.b_lat, 'b_lon', v_thread.b_lon, 'b_place', v_thread.b_place,
    'km', v_thread.km, 'created_at', v_thread.created_at));
end $$;

create function public.recent_echoes()
returns table (lat real, lon real, place text, last_seen timestamptz)
language sql stable security definer set search_path = public as $$
  select e.lat, e.lon, e.place, e.last_seen
    from echoes e
   where e.last_seen > now() - interval '48 hours'
   order by e.last_seen desc
   limit 400;
$$;

create function public.world_stats() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'threads_total', t.threads_total,
    'km_total', round(t.km_total),
    'lanterns_48h', (select count(*) from lanterns
                      where not hidden and created_at > now() - interval '48 hours'),
    'lights_today', (select count(*) from echoes
                      where last_seen >= (_utc_day()::timestamp at time zone 'utc')),
    'lights_48h', (select count(*) from echoes where last_seen > now() - interval '48 hours'),
    'zones_today', coalesce((select json_agg(zone order by zone) from zone_days
                              where day = _utc_day()), '[]'::json),
    'day', _utc_day())
  from world_totals t;
$$;

create function public.my_marks() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'lanterns', coalesce((select json_agg(id) from lanterns where uid = auth.uid()), '[]'::json),
    'warmed', coalesce((select json_agg(lantern_id) from warmths where uid = auth.uid()), '[]'::json),
    'threads', coalesce((select json_agg(id) from threads
                          where a_uid = auth.uid() or b_uid = auth.uid()), '[]'::json));
$$;

create function public._prune() returns void
language sql security definer set search_path = public as $$
  delete from lanterns where not seeded and created_at < now() - interval '7 days';
  delete from waves where created_at < now() - interval '1 hour';
  delete from rate_events where at < now() - interval '2 days';
  delete from echoes where last_seen < now() - interval '3 days';
$$;

-- Supabase's default privileges hand EXECUTE to anon/authenticated directly, so revoking from
-- PUBLIC alone is not enough.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function
  public.check_in(real, real, text, text, int),
  public.release_lantern(text, int, real, real, text, text),
  public.warm_lantern(uuid),
  public.report_lantern(uuid),
  public.send_wave(uuid, real, real, text),
  public.recent_echoes(),
  public.world_stats(),
  public.my_marks()
to anon, authenticated;

-- ───────────────────────────── realtime ─────────────────────────────

alter publication supabase_realtime add table public.lanterns, public.threads, public.zone_days;

-- ─────────────────────────── housekeeping ───────────────────────────

create extension if not exists pg_cron;
select cron.schedule('one-sky-prune', '7 * * * *', $$select public._prune()$$);

-- ─────────────────────────────── seed ───────────────────────────────

insert into public.lanterns (uid, day, question_id, body, lat, lon, place, tz, seeded) values
  (null, public._utc_day(), 0, 'From One Sky: welcome. Someone, somewhere, is awake with you right now.',
     64.15, -21.94, 'Reykjavik', 'Atlantic/Reykjavik', true),
  (null, public._utc_day(), 0, 'From One Sky: every light you see is a real person with this page open. Wave at one.',
     -1.29, 36.82, 'Nairobi', 'Africa/Nairobi', true),
  (null, public._utc_day(), 0, 'From One Sky: lanterns are short notes left for strangers. Leave one; it drifts for two days.',
     35.01, 135.77, 'Kyoto', 'Asia/Tokyo', true),
  (null, public._utc_day(), 0, 'From One Sky: when two people wave back at each other, a thread stays between them.',
     -33.05, -71.62, 'Valparaíso', 'America/Santiago', true),
  (null, public._utc_day(), 0, 'From One Sky: the day starts here. Help light all twenty-four hours of it.',
     -36.85, 174.76, 'Auckland', 'Pacific/Auckland', true),
  (null, public._utc_day(), 0, 'From One Sky: nobody here has a name, only a place. Be kind to the places.',
     38.72, -9.14, 'Lisbon', 'Europe/Lisbon', true);
