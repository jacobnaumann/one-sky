-- Supabase loads the safeupdate module for API roles: an UPDATE without a WHERE clause is refused
-- (21000). send_wave updated the single world_totals row without one, so no thread could be made.
-- Same function as in the init migration, with the totals update keyed on the row id.

create or replace function public.send_wave(p_to uuid, p_lat real, p_lon real, p_place text)
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

  update world_totals set threads_total = threads_total + 1, km_total = km_total + v_thread.km
   where id;

  return json_build_object('thread', json_build_object(
    'id', v_thread.id,
    'a_lat', v_thread.a_lat, 'a_lon', v_thread.a_lon, 'a_place', v_thread.a_place,
    'b_lat', v_thread.b_lat, 'b_lon', v_thread.b_lon, 'b_place', v_thread.b_place,
    'km', v_thread.km, 'created_at', v_thread.created_at));
end $$;
