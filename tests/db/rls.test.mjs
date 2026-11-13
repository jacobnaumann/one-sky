// Live database test for One Sky. Runs against the real Supabase project with three anonymous
// sessions and checks the security model and every client-facing function.
//
//   node tests/db/rls.test.mjs              run, then delete everything the test created
//   node tests/db/rls.test.mjs --no-cleanup run only (rows stay; next run needs a cleanup first)
//
// Sessions are cached in .secrets/test-sessions.json (git-ignored) so repeated runs do not burn
// the per-IP anonymous sign-up limit (30/hour).
// Cleanup needs the Supabase CLI, logged in and linked to the project (`supabase db query --linked`).
// It uses the CLI's own login; no database password or service key is read by this script.

import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SESSIONS_FILE = join(ROOT, '.secrets', 'test-sessions.json');
const NO_CLEANUP = process.argv.includes('--no-cleanup');

// Read the public config straight from the client source so the test and the app cannot drift.
const cfg = readFileSync(join(ROOT, 'src', 'net', 'config.ts'), 'utf8');
const SUPABASE_URL = /SUPABASE_URL\s*=\s*'([^']+)'/.exec(cfg)[1];
const SUPABASE_ANON_KEY = /SUPABASE_ANON_KEY\s*=\s*'([^']+)'/.exec(cfg)[1];

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${detail ? `  -- ${detail}` : ''}`);
  }
}
const msg = (r) => (r.error ? `${r.error.code ?? ''} ${r.error.message}` : `no error, data=${JSON.stringify(r.data)?.slice(0, 120)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

function newClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function signIn(saved) {
  const c = newClient();
  if (saved?.refresh_token) {
    const { data, error } = await c.auth.refreshSession({ refresh_token: saved.refresh_token });
    if (!error && data.session) return { c, session: data.session, reused: true };
  }
  const { data, error } = await c.auth.signInAnonymously();
  if (error) throw new Error(`anonymous sign-in failed: ${error.message}`);
  return { c, session: data.session, reused: false };
}

function sql(text) {
  const file = join(tmpdir(), `onesky-test-${process.pid}.sql`);
  writeFileSync(file, text);
  try {
    return execSync(`supabase db query --linked -o csv -f "${file}"`, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    rmSync(file, { force: true });
  }
}

// Runs a query and returns its rows as objects (all values are strings; NULL becomes 'NULL').
function sqlRows(text) {
  const out = sql(text).replace(/\r/g, '').trim();
  if (!out) return [];
  const parse = (line) => {
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    return cells;
  };
  const [head, ...lines] = out.split('\n');
  const cols = parse(head);
  return lines.map((l) => Object.fromEntries(parse(l).map((v, i) => [cols[i], v])));
}

// Test rows are found by uid only: place names can no longer be forged, so there is no '[test]' place.
function cleanup(uids) {
  const list = uids.map((u) => `'${u}'`).join(',');
  sql(`
    begin;
    update public.limits set value = def where value <> def;
    delete from public.lanterns where uid in (${list}) or (body like '[test]%' and not seeded);
    delete from public.warmths where uid in (${list});
    delete from public.reports where uid in (${list}) or uid = '${GHOST}';
    delete from public.waves where from_uid in (${list}) or to_uid in (${list});
    with d as (
      delete from public.threads
       where a_uid in (${list}) or b_uid in (${list})
       returning km
    )
    update public.world_totals
       set threads_total = greatest(0, threads_total - (select count(*) from d)),
           km_total = greatest(0, km_total - coalesce((select sum(km) from d), 0))
     where id;
    delete from public.echoes where uid in (${list});
    delete from public.echo_waves where from_uid in (${list}) or to_uid in (${list});
    delete from public.zone_days where uid in (${list});
    delete from public.rate_events where uid in (${list});
    commit;
  `);
}

// The client's place table, read from the client source so the test and the app cannot drift.
const tzsrc = readFileSync(join(ROOT, 'src', 'lib', 'tzdata.ts'), 'utf8');
const rawStart = tzsrc.indexOf('[', tzsrc.indexOf('RAW_PLACES: RawPlace[] =') + 22);
const RAW_PLACES = JSON.parse(tzsrc.slice(rawStart, tzsrc.indexOf('];', rawStart) + 1).replace(/,\s*\]$/, ']'));
const PLACES = new Map(RAW_PLACES.map(([tz, lat, lon, city]) =>
  [tz, { tz, lat, lon, city: city || tz.slice(tz.lastIndexOf('/') + 1).replace(/_/g, ' ') }]));

// The client's city table (src/lib/cities.ts). A city's place key on the server is 'g' + geonameid.
const citysrc = readFileSync(join(ROOT, 'src', 'lib', 'cities.ts'), 'utf8');
const CITY_TZS = JSON.parse(/CITY_TZS: string\[\] = (\[[^\]]*\]);/.exec(citysrc)[1]);
const citiesStart = citysrc.indexOf('[[', citysrc.indexOf('RAW_CITIES: RawCity[] ='));
const RAW_CITIES = JSON.parse(citysrc.slice(citiesStart, citysrc.indexOf(']];', citiesStart) + 2));
const cityPos = (name, cc, region = null) => {
  const c = RAW_CITIES.find((x) => x[1] === name && x[2] === cc && (region === null || x[3] === region));
  if (!c) throw new Error(`city not in cities.ts: ${name}, ${cc}`);
  return { tz: `g${c[0]}`, city: c[1], lat: c[4], lon: c[5], zone: CITY_TZS[c[6]] };
};
const MADISON = cityPos('Madison', 'US', 'WI'); // America/Chicago
const PUNE = cityPos('Pune', 'IN'); // Asia/Kolkata, a half-hour zone

// Same arithmetic as zoneIndex() in src/lib/time.ts.
function jsZone(tz, date = new Date()) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, +x.value]));
  const local = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const minutes = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const hours = Math.round(minutes / 60);
  return ((hours % 24) + 24) % 24;
}

function km(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Collects realtime events and lets a test wait for one that matches.
function inbox() {
  const items = [];
  const waiters = [];
  return {
    push(x) {
      items.push(x);
      for (const w of [...waiters]) w();
    },
    wait(pred, ms = 12000) {
      return new Promise((res) => {
        const tryNow = () => {
          const hit = items.find(pred);
          if (hit) {
            clearTimeout(timer);
            waiters.splice(waiters.indexOf(tryNow), 1);
            res(hit);
          }
        };
        const timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(tryNow), 1);
          res(null);
        }, ms);
        waiters.push(tryNow);
        tryNow();
      });
    },
  };
}

function subscribed(channel, ms = 15000) {
  return new Promise((res) => {
    const t = setTimeout(() => res('TIMED_OUT_LOCAL'), ms);
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        clearTimeout(t);
        res(status);
      }
    });
  });
}

// Positions as a client would send them: inside the jitter box of the place, with a place name
// the server must ignore.
const FORGED = 'Atlantis <b>free money</b>';
const A_POS = { lat: 64.15, lon: -21.94, tz: 'Atlantic/Reykjavik', city: 'Reykjavík' };
const B_POS = { lat: -1.29, lon: 36.82, tz: 'Africa/Nairobi', city: 'Nairobi' };
const C_POS = { lat: 35.9, lon: 139.5, tz: 'Asia/Tokyo', city: 'Tokyo' };
const ZERO_ID = '00000000-0000-0000-0000-000000000000';
const GHOST = '11111111-2222-4333-8444-777777777777'; // a reporter that is nobody; rows are cleaned up
const near = (a, b, eps) => Math.abs(a - b) <= eps;

async function main() {
  // ── sessions ──────────────────────────────────────────────────────────────
  let saved = [];
  try {
    saved = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
  } catch {}
  const users = [];
  for (let i = 0; i < 3; i++) users.push(await signIn(saved[i]));
  if (existsSync(dirname(SESSIONS_FILE)) || mkdirSync(dirname(SESSIONS_FILE), { recursive: true }) || true) {
    writeFileSync(
      SESSIONS_FILE,
      JSON.stringify(users.map((u) => ({ uid: u.session.user.id, refresh_token: u.session.refresh_token }))),
    );
  }
  const [A, B, C] = users.map((u) => u.c);
  const [uidA, uidB, uidC] = users.map((u) => u.session.user.id);
  const uids = [uidA, uidB, uidC];
  const list = uids.map((u) => `'${u}'`).join(',');
  const allUids = [...uids]; // plus the fresh user D, once it exists; used for cleanup
  console.log(`sessions: ${users.filter((u) => u.reused).length} reused, ${users.filter((u) => !u.reused).length} new`);
  check('anonymous sign-in gives three distinct anonymous users',
    new Set(uids).size === 3 && users.every((u) => u.session.user.is_anonymous === true));

  if (!NO_CLEANUP) cleanup(uids); // clear residue from an earlier, interrupted run

  const anon = newClient(); // no session at all

  // ── auth configuration ────────────────────────────────────────────────────
  // The fresh user (D) is also the "identity that has done nothing today" for the breaker tests.
  const D = newClient();
  let uidD = ZERO_ID;
  {
    const r = await D.auth.signInAnonymously();
    check('auth: a fresh anonymous sign-in still works', !r.error && r.data?.user?.is_anonymous === true, r.error?.message);
    if (r.data?.user?.id) { uidD = r.data.user.id; allUids.push(uidD); }
    const e = await newClient().auth.signUp({ email: `onesky-test-${Date.now()}@example.com`, password: `pw-${Date.now()}-Aa1!` });
    check('auth: e-mail sign-up is disabled', !!e.error && !e.data?.user, e.error ? `${e.error.code} ${e.error.message}` : 'sign-up was accepted');
  }

  // ── no session ────────────────────────────────────────────────────────────
  {
    const lantern = { p_body: '[test] no session', p_question_id: 0, p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: FORGED, p_tz: A_POS.tz };
    let r = await anon.rpc('release_lantern', lantern);
    check('no session: release_lantern refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('check_in', { p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: FORGED, p_tz: A_POS.tz, p_zone: 1 });
    check('no session: check_in refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('send_wave', { p_to: uidA, p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: FORGED });
    check('no session: send_wave refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('warm_lantern', { p_id: ZERO_ID });
    check('no session: warm_lantern refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('wave_echo', { p_eid: ZERO_ID, p_lat: A_POS.lat, p_lon: A_POS.lon, p_tz: A_POS.tz });
    check('no session: wave_echo refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('collect_echo_waves');
    check('no session: collect_echo_waves refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.from('echo_waves').select('id').limit(1);
    check('no session: cannot read echo_waves', !!r.error, msg(r));
    r = await anon.rpc('my_wavers');
    check('no session: my_wavers returns []', !r.error && Array.isArray(r.data) && r.data.length === 0, msg(r));
    r = await anon.rpc('report_lantern', { p_id: ZERO_ID });
    check('no session: report_lantern refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.from('lanterns').insert({ day: today(), question_id: 0, body: '[test] direct', lat: 0, lon: 0, place: '[test] X', tz: 'Etc/UTC' });
    check('no session: direct insert into lanterns refused', !!r.error, msg(r));
    r = await anon.from('zone_days').insert({ day: today(), zone: 5, place: '[test] X' });
    check('no session: direct insert into zone_days refused', !!r.error, msg(r));
    r = await anon.from('places').select('tz').limit(1);
    const r2 = await anon.from('limits').select('key').limit(1);
    check('no session: cannot read places / limits', !!r.error && !!r2.error, `${msg(r)} | ${msg(r2)}`);
    r = await anon.from('lanterns').select('id, body, place, seeded');
    check('no session: can read seeded lanterns', !r.error && r.data.filter((l) => l.seeded).length === 6, msg(r));
    // Since 20261113060000_seed_copy the body has no "From One Sky:" prefix: the client card labels
    // a seeded lantern from its `seeded` flag.
    check('seeded lanterns carry a real place and no redundant "From One Sky:" prefix',
      !r.error && r.data.filter((l) => l.seeded).every((l) => l.body.length > 0 && !l.body.startsWith('From One Sky:') && l.place !== 'One Sky'));
  }

  // ── signed in: no direct writes, no private reads ─────────────────────────
  {
    const rows = {
      lanterns: { day: today(), question_id: 0, body: '[test] direct', lat: 0, lon: 0, place: '[test] X', tz: 'Etc/UTC' },
      warmths: { lantern_id: ZERO_ID, uid: uidA },
      reports: { lantern_id: ZERO_ID, uid: uidA },
      waves: { from_uid: uidA, to_uid: uidB, lat: 0, lon: 0, place: '[test] X' },
      threads: { a_uid: uidA, b_uid: uidB, a_lat: 0, a_lon: 0, a_place: '[test] X', b_lat: 1, b_lon: 1, b_place: '[test] Y', km: 1 },
      echoes: { uid: uidA, lat: 0, lon: 0, place: '[test] X', tz: 'Etc/UTC', zone: 1 },
      zone_days: { day: today(), zone: 5, place: '[test] X' },
      rate_events: { uid: uidA, kind: 'x' },
      world_totals: { id: true, threads_total: 999, km_total: 999 },
      places: { tz: 'Test/Nowhere', city: '[test] X', country: 'X', lat: 0, lon: 0 },
      limits: { key: 'x', value: 1, def: 1 },
      echo_waves: { to_uid: uidB, from_uid: uidA, from_place: '[test] X', from_tz: 'Etc/UTC', from_lat: 0, from_lon: 0 },
    };
    const patch = {
      lanterns: { warmth: 999 }, warmths: { uid: uidB }, reports: { uid: uidB }, waves: { place: 'x' },
      threads: { km: 999 }, echoes: { place: 'x' }, zone_days: { place: 'x' }, rate_events: { kind: 'y' },
      world_totals: { threads_total: 999 }, places: { city: 'x' }, limits: { value: 999999 }, echo_waves: { from_place: 'x' },
    };
    const anyCol = {
      lanterns: 'id', warmths: 'lantern_id', reports: 'lantern_id', waves: 'id', threads: 'id',
      echoes: 'uid', zone_days: 'zone', rate_events: 'uid', world_totals: 'id', places: 'tz', limits: 'key', echo_waves: 'id',
    };
    for (const t of Object.keys(rows)) {
      const ins = await A.from(t).insert(rows[t]);
      const upd = await A.from(t).update(patch[t]).not(anyCol[t], 'is', null);
      const del = await A.from(t).delete().not(anyCol[t], 'is', null);
      check(`signed in: insert/update/delete on ${t} refused`, !!ins.error && !!upd.error && !!del.error,
        `insert: ${msg(ins)} | update: ${msg(upd)} | delete: ${msg(del)}`);
    }
    for (const t of ['waves', 'reports', 'rate_events', 'echoes', 'world_totals', 'places', 'limits', 'echo_waves']) {
      const r = await A.from(t).select('*').limit(1);
      check(`signed in: cannot read ${t}`, !!r.error, msg(r));
    }
    let r = await A.from('lanterns').select('uid').limit(1);
    check('signed in: cannot read lanterns.uid', !!r.error, msg(r));
    r = await A.from('lanterns').select('*').limit(1);
    check('signed in: select * on lanterns refused (must list columns)', !!r.error, msg(r));
    r = await A.from('lanterns').select('reports, hidden').limit(1);
    let r2 = await A.from('lanterns').select('hidden_at').limit(1);
    check('signed in: cannot read lanterns.reports/hidden/hidden_at', !!r.error && !!r2.error, `${msg(r)} | ${msg(r2)}`);
    r = await A.from('zone_days').select('uid').limit(1);
    check('signed in: cannot read zone_days.uid', !!r.error, msg(r));
    r = await A.from('threads').select('a_uid').limit(1);
    r2 = await A.from('threads').select('b_uid').limit(1);
    check('signed in: cannot read threads.a_uid / b_uid', !!r.error && !!r2.error, `${msg(r)} | ${msg(r2)}`);
    r = await A.from('lanterns').select('id,day,question_id,body,lat,lon,place,tz,warmth,seeded,created_at').limit(1);
    check('signed in: documented lantern columns are readable', !r.error && r.data.length === 1, msg(r));
    r = await A.from('threads').select('id,a_lat,a_lon,a_place,b_lat,b_lon,b_place,km,created_at').limit(1);
    check('signed in: documented thread columns are readable', !r.error, msg(r));
    const internal = [
      ['_rate_take', { p_uid: uidA, p_kind: 'x', p_window: '1 hour', p_max: 1 }],
      ['_prune', {}],
      ['_limit', { p_key: 'wave_per_min' }],
      ['_place', { p_tz: A_POS.tz, p_lat: A_POS.lat, p_lon: A_POS.lon }],
      ['_zone_for_tz', { p_tz: A_POS.tz, p_fallback: 0 }],
      ['_squash', { p: 'x' }],
      ['_text_problem', { p: 'x' }],
      ['_uid', {}],
    ];
    const res = [];
    for (const [fn, args] of internal) res.push([fn, await A.rpc(fn, args)]);
    check('signed in: internal helper functions are not callable', res.every(([, x]) => !!x.error),
      res.filter(([, x]) => !x.error).map(([fn]) => fn).join(','));
  }

  // ── database-side hardening (checked through the CLI) ─────────────────────
  {
    const [h] = sqlRows(`
      select
        (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
            and (p.proconfig is null or not 'search_path=public, pg_temp' = any(p.proconfig))) as bad_path,
        (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'send_wave') as send_wave_fns,
        (select count(*) from public.places) as places,
        (select count(*) from public.places p where p.tz = p.zone_tz and p.jitter = 0.61::real and p.tz !~ '^g[0-9]+$') as zone_places,
        (select count(*) from public.places p where p.tz ~ '^g[1-9][0-9]*$' and p.jitter = 0.21::real and p.zone_tz <> p.tz) as city_places,
        (select count(distinct p.zone_tz) from public.places p where not exists (select 1 from pg_timezone_names n where n.name = p.zone_tz)) as unknown_tz,
        (select city || '|' || country || '|' || lat || '|' || lon || '|' || zone_tz from public.places where tz = '${MADISON.tz}') as madison,
        (select schedule from cron.job where jobname = 'one-sky-prune') as prune_schedule,
        (select count(*) from cron.job where jobname = 'one-sky-prune-anon' and command like '%is_anonymous%30 days%') as anon_job,
        has_table_privilege((select username from cron.job where jobname = 'one-sky-prune-anon'), 'auth.users', 'DELETE') as anon_job_allowed,
        (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity) as tables_without_rls`);
    check('every SECURITY DEFINER function has search_path = public, pg_temp', h.bad_path === '0', JSON.stringify(h));
    check('send_wave has exactly one overload', h.send_wave_fns === '1', JSON.stringify(h));
    check('places holds the 418 zone rows of the client table (key = zone, jitter 0.61)', h.zone_places === String(PLACES.size) && PLACES.size === 418, JSON.stringify(h));
    check('places holds the 11,585 cities of the client table (key g<geonameid>, jitter 0.21): 418 + 11,585 rows in all',
      h.city_places === String(RAW_CITIES.length) && RAW_CITIES.length === 11585 && h.places === String(418 + 11585), JSON.stringify(h));
    check('places: a city row carries the plain name, the country name, the client coordinates and the real zone',
      h.madison === `Madison|United States|${MADISON.lat}|${MADISON.lon}|America/Chicago` && MADISON.zone === 'America/Chicago' && MADISON.tz === 'g5261457', JSON.stringify(h));
    check('prune job runs every 10 minutes', h.prune_schedule === '*/10 * * * *', JSON.stringify(h));
    check('daily anonymous-user prune job exists and its role may delete from auth.users',
      h.anon_job === '1' && h.anon_job_allowed === 'true', JSON.stringify(h));
    check('RLS is on for every public table', h.tables_without_rls === '0', JSON.stringify(h));
    if (h.unknown_tz !== '0') console.log(`NOTE  ${h.unknown_tz} place zone(s) unknown to this Postgres: the client's p_zone is used for them`);

    // A function created now must not be callable by the API roles. Never committed.
    const [d] = sqlRows(`
      begin;
      create function public._tmp_probe() returns int language sql as 'select 1';
      select has_function_privilege('anon', 'public._tmp_probe()', 'execute') as anon,
             has_function_privilege('authenticated', 'public._tmp_probe()', 'execute') as authed;`);
    const [gone] = sqlRows(`select count(*) as n from pg_proc where proname = '_tmp_probe'`);
    check('default privileges: a new function is not executable by anon / authenticated',
      d.anon === 'false' && d.authed === 'false' && gone.n === '0', JSON.stringify({ d, gone }));

    // Zones: the server must agree with the client's zoneIndex() for every place.
    const zones = sqlRows(`select tz, public._zone_for_tz(zone_tz, null) as z from public.places where tz = zone_tz order by tz`);
    const z = Object.fromEntries(zones.map((r) => [r.tz, +r.z]));
    const now = new Date();
    for (const [tz, want] of [['Asia/Kolkata', 6], ['America/St_Johns', 21], ['Pacific/Marquesas', 15], ['Asia/Kathmandu', 6]]) {
      check(`zone: ${tz} is band ${want} on the server and in JS`, z[tz] === want && jsZone(tz, now) === want, `server ${z[tz]}, js ${jsZone(tz, now)}`);
    }
    // The server and this Node can carry different tzdata releases (a zone that changed its rules
    // recently is then one band apart); anything else is a bug in the arithmetic.
    const diff = zones.filter((r) => +r.z !== jsZone(r.tz, now));
    const band = (r) => Math.min((+r.z - jsZone(r.tz, now) + 24) % 24, (jsZone(r.tz, now) - +r.z + 24) % 24);
    const text = diff.map((r) => `${r.tz}: server ${r.z}, js ${jsZone(r.tz, now)}`).join(' ; ');
    check('zone: server and client agree for all 418 places (tzdata skew of one band allowed for a few)',
      zones.length === 418 && diff.every((r) => band(r) === 1) && diff.length <= 12, text);
    if (diff.length) console.log(`NOTE  ${diff.length} zone(s) one band apart, server tzdata vs Node tzdata ${process.versions.tz}: ${text}`);

    // Pruning, inside a transaction that is never committed (so nothing is announced or lost).
    const u = '11111111-2222-4333-8444-555555555555';
    const v = '11111111-2222-4333-8444-666666666666';
    const [p] = sqlRows(`
      begin;
      insert into public.rate_events (uid, kind, at) values
        ('${u}', 'wave', now() - interval '6 minutes'), ('${u}', 'wave', now() - interval '4 minutes'),
        ('${u}', 'warm', now() - interval '3 hours'), ('${u}', 'warm', now() - interval '1 hour'),
        ('${u}', 'check_in', now() - interval '3 hours'), ('${u}', 'check_in', now() - interval '1 hour'),
        ('${u}', 'report', now() - interval '3 days'), ('${u}', 'report', now() - interval '25 hours'),
        ('${u}', 'lantern', now() - interval '3 days'), ('${u}', 'lantern', now() - interval '25 hours');
      insert into public.waves (from_uid, to_uid, lat, lon, place, created_at) values
        ('${u}', '${v}', 0, 0, 'x', now() - interval '16 minutes'), ('${u}', '${v}', 0, 0, 'x', now() - interval '11 minutes');
      insert into public.threads (a_uid, b_uid, a_lat, a_lon, a_place, b_lat, b_lon, b_place, km, created_at) values
        ('${u}', '${v}', 0, 0, 'x', 1, 1, 'y', 1, now() - interval '15 days'),
        ('${u}', '${v}', 0, 0, 'x', 1, 1, 'y', 1, now() - interval '13 days');
      insert into public.echo_waves (to_uid, from_uid, from_place, from_tz, from_lat, from_lon, created_at) values
        ('${u}', '${v}', 'x', 'Etc/UTC', 0, 0, now() - interval '8 days'),
        ('${v}', '${u}', 'x', 'Etc/UTC', 0, 0, now() - interval '6 days');
      insert into public.lanterns (uid, day, question_id, body, lat, lon, place, tz, reports, seeded, created_at)
        select '${u}', public._utc_day(), 0, '[test] prune ' || chr(96 + g), 0, 0, 'x', 'Etc/UTC',
               case when g = 8 then 2 else 3 end, g = 9,
               now() - case when g = 10 then interval '50 hours' else interval '47 hours' - g * interval '1 minute' end
          from generate_series(1, 10) g;
      select public._prune();
      select (select string_agg(kind, ',' order by kind) from public.rate_events where uid = '${u}') as kinds,
             (select count(*) from public.waves where from_uid = '${u}') as waves,
             (select count(*) from public.threads where a_uid = '${u}') as threads,
             (select count(*) from public.echo_waves where to_uid in ('${u}', '${v}')) as echo_waves,
             (select string_agg(right(body, 1), '' order by created_at) from public.lanterns
               where uid = '${u}' and hidden and hidden_at is not null) as caught_up,
             (select count(*) from public.lanterns where uid = '${u}' and hidden <> (hidden_at is not null)) as half_hidden;`);
    check('_prune keeps what each limiter still needs and drops the rest',
      p.kinds === 'check_in,lantern,report,warm,wave' && p.waves === '1' && p.threads === '1' && p.echo_waves === '1', JSON.stringify(p));
    // Rows a-g have three reports (oldest first), h has two, i is seeded, j is past its 48 hours.
    check('_prune catch-up hides at most 5 lanterns with three reports per run, oldest first, never seeded ones',
      p.caught_up === 'abcde' && p.half_hidden === '0', JSON.stringify(p));
  }

  const stats0 = (await A.rpc('world_stats')).data;

  // ── realtime subscriptions (A listens) ────────────────────────────────────
  const events = inbox();
  const dbChannel = A.channel('test-db')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'lanterns' }, (p) => events.push({ table: 'lanterns', ...p }))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'threads' }, (p) => events.push({ table: 'threads', ...p }))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'zone_days' }, (p) => events.push({ table: 'zone_days', ...p }));
  const skyChannel = C.channel('sky').on('broadcast', { event: 'lantern_hidden' }, (p) => events.push({ table: 'broadcast', ...p }));
  const [s1, s2] = await Promise.all([subscribed(dbChannel), subscribed(skyChannel)]);
  check('realtime: postgres_changes channel subscribes', s1 === 'SUBSCRIBED', s1);
  check('realtime: sky broadcast channel subscribes', s2 === 'SUBSCRIBED', s2);
  await sleep(2500); // let the server finish registering the postgres_changes filters

  // ── release_lantern ───────────────────────────────────────────────────────
  const lanternArgs = (pos, body) => ({ p_body: body, p_question_id: 7, p_lat: pos.lat, p_lon: pos.lon, p_place: FORGED, p_tz: pos.tz });
  const base = lanternArgs(A_POS, '');
  const rejects = [
    ['link (url)', '[test] look at http://example.com', 'link'],
    ['link (bare domain)', '[test] visit example.com today', 'link'],
    ['link (full-width dot)', '[test] visit example．com today', 'link'],
    ['contact (@handle)', '[test] message me @someone', 'contact'],
    ['contact (email)', '[test] write to me at a.b@mail.example', 'contact'],
    ['contact (phone)', '[test] call 555 123 4567 now', 'contact'],
    ['too_long', '[test] ' + 'x'.repeat(140), 'too_long'],
    ['empty', '   \n\t  ', 'empty'],
    ['empty (only invisible characters)', ' ​‍⁠﻿­ ', 'empty'],
    ['blocked', '[test] this is shit', 'blocked'],
    ['blocked inside a word (clusterfuck)', '[test] what a clusterfuck', 'blocked'],
    ['blocked split by zero-width characters', '[test] f​u‍c⁠k this', 'blocked'],
    ['blocked split by a soft hyphen', '[test] bi­tch', 'blocked'],
    ['blocked under a bidi override', '[test] ‮fuck‬', 'blocked'],
    ['blocked in full-width letters', '[test] ｆｕｃｋ', 'blocked'],
    ['blocked in mathematical letters', '[test] \u{1D41F}\u{1D42E}\u{1D41C}\u{1D424}', 'blocked'],
    ['blocked with accents', '[test] fúck and fück', 'blocked'],
    ['blocked in capitals', '[test] FUCK', 'blocked'],
    ['stacked combining marks (zalgo)', '[test] hé̂̃̄llo', 'blocked'],
    ['stacked Thai marks', '[test] ก้้้้้้', 'blocked'],
  ];
  for (const [name, body, want] of rejects) {
    const r = await A.rpc('release_lantern', { ...base, p_body: body });
    check(`release_lantern rejects ${name}`, !!r.error && r.error.message === want, msg(r));
  }
  {
    const bad = [
      ['latitude 91', { p_lat: 91 }],
      ['a zone that is not in the place table', { p_tz: 'Etc/UTC' }],
      ['a zone name in the wrong case', { p_tz: 'atlantic/reykjavik' }],
      ['a missing zone', { p_tz: null }],
      ['a latitude 0.7 degrees from the place', { p_lat: A_POS.lat + 0.7 }],
      ['a longitude 0.7 degrees from the place', { p_lon: A_POS.lon - 0.7 }],
      ['a position in another place', { p_lat: B_POS.lat, p_lon: B_POS.lon }],
    ];
    for (const [name, over] of bad) {
      const r = await A.rpc('release_lantern', { ...base, p_body: '[test] ok', ...over });
      check(`release_lantern rejects ${name}`, !!r.error && r.error.message === 'invalid_input', msg(r));
    }
  }
  const centre = (l) => PLACES.get(l.tz);
  const inBox = (l) => !!l && near(l.lat, centre(l).lat, 0.5011) && near(l.lon, centre(l).lon, 0.5011);
  let L1;
  {
    const r = await A.rpc('release_lantern', { ...base, p_body: '  [test]   hello \n  world  ' });
    L1 = r.data;
    check('release_lantern works and cleans whitespace',
      !r.error && L1?.body === '[test] hello world' && L1.warmth === 0 && L1.seeded === false &&
      L1.day === today() && L1.question_id === 7, msg(r));
    check('release_lantern ignores the client place text and uses places.city', L1?.place === A_POS.city && L1?.tz === A_POS.tz, JSON.stringify(L1));
    check('lantern sits within 0.5 degrees of the place centre, not at the caller position',
      inBox(L1) && !(L1.lat === A_POS.lat && L1.lon === A_POS.lon), JSON.stringify(L1));
    check('release_lantern result carries no uid / reports / hidden',
      !!L1 && !('uid' in L1) && !('reports' in L1) && !('hidden' in L1) && !('hidden_at' in L1), JSON.stringify(L1));
    const again = await A.rpc('release_lantern', { ...base, p_body: '[test] too soon' });
    check('release_lantern enforces one per 30 seconds', !!again.error && again.error.message === 'rate_limited', msg(again));
    const seen = await B.from('lanterns').select('id, body').eq('id', L1?.id);
    check('another user can read the new lantern', !seen.error && seen.data.length === 1, msg(seen));
  }
  {
    const ev = await events.wait((e) => e.table === 'lanterns' && e.eventType === 'INSERT' && e.new?.id === L1?.id);
    // The insert above came from A's own session; the cross-session case is checked with L2 below.
    check('realtime: lantern insert arrives', !!ev);
  }
  let L2;
  {
    const r = await B.rpc('release_lantern', lanternArgs(B_POS, '[test] from the other side'));
    L2 = r.data;
    check('second user releases a lantern', !r.error && !!L2?.id && L2.place === B_POS.city, msg(r));
    const ev = await events.wait((e) => e.table === 'lanterns' && e.eventType === 'INSERT' && e.new?.id === L2?.id);
    check('realtime: insert made by another session is received', !!ev && ev.new.body === '[test] from the other side');
    check('realtime: lantern payload has no uid / reports / hidden',
      !!ev && !('uid' in ev.new) && !('reports' in ev.new) && !('hidden' in ev.new) && !('hidden_at' in ev.new), ev ? Object.keys(ev.new).join(',') : 'no event');
  }

  const made = []; // lanterns released in the acceptance rounds: { who: 0 | 1 | 2, ...lantern }
  // Global ceiling, then text that must be accepted. The per-uid lantern budget (1 per 30 s,
  // 5 per day) is cleared between rounds so this does not take minutes.
  {
    sql(`update public.limits set value = 0 where key = 'lanterns_global_hour';
         delete from public.rate_events where kind = 'lantern' and uid in (${list});`);
    const r = await A.rpc('release_lantern', { ...base, p_body: '[test] over the ceiling' });
    const r0 = await C.rpc('release_lantern', lanternArgs(C_POS, '[test] over the ceiling, first today'));
    check('release_lantern: a global ceiling of 0 raises sky_busy, even for a first lantern of the day',
      r.error?.message === 'sky_busy' && r0.error?.message === 'sky_busy', `${msg(r)} | ${msg(r0)}`);

    // Reserve: with the ceiling at exactly the number of lanterns in the last hour, a uid that has
    // released today is refused and a uid's first lantern of the day is taken.
    const atCeiling = `update public.limits set value = (select count(*) from public.lanterns where created_at > now() - interval '1 hour') where key = 'lanterns_global_hour';`;
    const clearBudget = `delete from public.rate_events where kind = 'lantern' and uid in (${list}, '${uidD}');`;
    sql(atCeiling);
    const busyA = await A.rpc('release_lantern', { ...base, p_body: '[test] at the ceiling' });
    const firstC = await C.rpc('release_lantern', lanternArgs(C_POS, '[test] first of the day'));
    sql(clearBudget + atCeiling);
    const secondC = await C.rpc('release_lantern', lanternArgs(C_POS, '[test] second of the day'));
    check('release_lantern: at the global ceiling a uid that released today gets sky_busy',
      busyA.error?.message === 'sky_busy' && secondC.error?.message === 'sky_busy', `${msg(busyA)} | ${msg(secondC)}`);
    check('release_lantern: at the global ceiling a first lantern of the UTC day is still taken',
      !firstC.error && firstC.data?.body === '[test] first of the day', msg(firstC));
    // Hard ceiling at twice the limit: three or more lanterns in the last hour, limit floor(n / 2).
    sql(`update public.limits set value = (select count(*) / 2 from public.lanterns where created_at > now() - interval '1 hour') where key = 'lanterns_global_hour';`);
    const hardD = await D.rpc('release_lantern', lanternArgs(B_POS, '[test] past twice the ceiling'));
    check('release_lantern: at twice the global ceiling even a first lantern of the day gets sky_busy',
      hardD.error?.message === 'sky_busy', msg(hardD));
    // The caller's own limit still says rate_limited, and is checked first.
    sql(clearBudget + `update public.limits set value = 0 where key = 'lanterns_global_hour';
         insert into public.rate_events (uid, kind) values ('${uidA}', 'lantern');`);
    const own = await A.rpc('release_lantern', { ...base, p_body: '[test] too soon, busy sky' });
    check('release_lantern: the per-uid limit still raises rate_limited', own.error?.message === 'rate_limited', msg(own));
    sql(clearBudget + `update public.limits set value = def where key = 'lanterns_global_hour';`);

    const accepts = [
      ['words that only look rude', '[test] Scunthorpe assess classic cocktail Dickens Essex shiitake Hancock night snigger'],
      ['Japanese', '[test] 今日はいい天気ですね。ガンバレ、パパ'],
      ['Arabic with harakat', '[test] السَّلامُ عَلَيْكُمْ وَرَحْمَةُ اللهِ'],
      ['Hindi', '[test] नमस्ते दुनियाँ, क्षत्रिय हूँ, ज़िंदगी'],
      ['Thai', '[test] สวัสดีครับ น้ำ ที่นี่ ผู้ใหญ่'],
      ['emoji (ZWJ sequence and variation selector)', '[test] hi \u{1F468}‍\u{1F469}‍\u{1F467} ❤️ \u{1F30D}'],
      ['accented Latin', '[test] Café déjà vu à Zürich, mañana Việt Nam, café'],
      ['Persian with ZWNJ', '[test] می‌خواهم'],
    ];
    for (let i = 0; i < accepts.length; i += 3) {
      if (i > 0) sql(`delete from public.rate_events where kind = 'lantern' and uid in (${list});`);
      const round = accepts.slice(i, i + 3);
      const rs = await Promise.all(round.map(([, body], k) =>
        [A, B, C][k].rpc('release_lantern', lanternArgs([A_POS, B_POS, C_POS][k], body))));
      round.forEach(([name, body], k) => {
        const got = rs[k].data;
        check(`release_lantern accepts ${name}`, !rs[k].error && got?.body === body.normalize('NFKC') && inBox(got),
          rs[k].error ? msg(rs[k]) : JSON.stringify(got));
        if (got) made.push({ who: k, ...got });
      });
    }
    const fromA = made.filter((l) => l.who === 0);
    check('two lanterns from the same position get different coordinates',
      fromA.length >= 2 && new Set([L1, ...fromA].map((l) => `${l.lat},${l.lon}`)).size === fromA.length + 1,
      JSON.stringify(fromA.map((l) => [l.lat, l.lon])));
  }

  // ── warm_lantern ──────────────────────────────────────────────────────────
  {
    const w1 = await B.rpc('warm_lantern', { p_id: L1.id });
    const w2 = await B.rpc('warm_lantern', { p_id: L1.id });
    check('warm_lantern is idempotent per user', !w1.error && w1.data === 1 && !w2.error && w2.data === 1, `${msg(w1)} | ${msg(w2)}`);
    const w3 = await C.rpc('warm_lantern', { p_id: L1.id });
    check('warm_lantern increments across users', !w3.error && w3.data === 2, msg(w3));
    const row = await A.from('lanterns').select('warmth').eq('id', L1.id).single();
    check('warmth is visible on the lantern row', !row.error && row.data.warmth === 2, msg(row));
    const ev = await events.wait((e) => e.table === 'lanterns' && e.eventType === 'UPDATE' && e.new?.id === L1.id && e.new.warmth === 2);
    check('realtime: warmth update is received', !!ev);
    const mine = await B.from('warmths').select('lantern_id, uid');
    check('warmths: a user sees only their own rows', !mine.error && mine.data.length === 1 && mine.data[0].uid === uidB, msg(mine));
    const bad = await A.rpc('warm_lantern', { p_id: ZERO_ID });
    check('warm_lantern on an unknown id raises not_found', !!bad.error && bad.error.message === 'not_found', msg(bad));
    const mA = (await A.rpc('my_marks')).data;
    const mB = (await B.rpc('my_marks')).data;
    check('my_marks lists own lanterns and warmed lanterns',
      mA?.lanterns?.includes(L1.id) && !mA.lanterns.includes(L2.id) && mB?.warmed?.includes(L1.id) && mB.lanterns.includes(L2.id) && mA.warmed.length === 0,
      JSON.stringify({ mA, mB }));
    const mAnon = await anon.rpc('my_marks');
    check('my_marks without a session is empty', !mAnon.error && mAnon.data.lanterns.length === 0 && mAnon.data.threads.length === 0, msg(mAnon));
  }

  // ── report_lantern ────────────────────────────────────────────────────────
  {
    const r1 = await A.rpc('report_lantern', { p_id: L2.id });
    const r1b = await A.rpc('report_lantern', { p_id: L2.id }); // same user twice counts once
    const r2 = await D.rpc('report_lantern', { p_id: L2.id }); // not B: L2 is B's own, which would not count
    const still = await C.from('lanterns').select('id').eq('id', L2.id);
    check('two distinct reports do not hide a lantern', !r1.error && !r1b.error && !r2.error && still.data?.length === 1, `${msg(r1)} | ${msg(r2)} | ${msg(still)}`);
    const r3 = await C.rpc('report_lantern', { p_id: L2.id });
    const gone = await A.from('lanterns').select('id').eq('id', L2.id);
    check('third distinct report hides the lantern', !r3.error && !gone.error && gone.data.length === 0, `${msg(r3)} | ${msg(gone)}`);
    const w = await A.rpc('warm_lantern', { p_id: L2.id });
    check('hidden lantern cannot be warmed', !!w.error && w.error.message === 'not_found', msg(w));
    const ev = await events.wait((e) => e.table === 'broadcast' && e.payload?.id === L2.id);
    check('realtime: lantern_hidden broadcast on channel sky', !!ev);

    // Budget is only spent on a report that can count: not on unknown, seeded, hidden or repeated ones.
    const seeded = (await A.from('lanterns').select('id').eq('seeded', true).limit(1)).data?.[0]?.id;
    const n1 = await A.rpc('report_lantern', { p_id: ZERO_ID });
    const n2 = await A.rpc('report_lantern', { p_id: seeded });
    const n3 = await A.rpc('report_lantern', { p_id: L2.id });
    // Then fill A's day (5 per rolling 24 h) with four more spent slots, one of them 23 hours old.
    const [spent] = sqlRows(`
      with before as (
        select (select count(*) from public.rate_events where uid = '${uidA}' and kind = 'report') as reports,
               (select count(*) from public.rate_events where uid = '${uidA}' and kind = 'warm') as warms_a,
               (select count(*) from public.rate_events where uid = '${uidB}' and kind = 'warm') as warms_b,
               (select hidden_at is not null from public.lanterns where id = '${L2.id}') as l2_hidden_at,
               (select reports from public.lanterns where id = '${seeded}') as seeded_reports
      ), ins as (
        insert into public.rate_events (uid, kind, at) values
          ('${uidA}', 'report', now() - interval '23 hours'), ('${uidA}', 'report', now()),
          ('${uidA}', 'report', now()), ('${uidA}', 'report', now())
        returning 1
      )
      select before.*, (select count(*) from ins) as added from before`);
    check('report_lantern spends no budget on unknown, seeded, hidden or repeated reports',
      !n1.error && !n2.error && !n3.error && spent.reports === '1' && spent.seeded_reports === '0', JSON.stringify(spent));
    check('warm_lantern spends no budget on an unknown lantern or a repeat', spent.warms_a === '0' && spent.warms_b === '1', JSON.stringify(spent));
    check('auto-hide stamps hidden_at', spent.l2_hidden_at === 'true', JSON.stringify(spent));
    const fromB = made.find((l) => l.who === 1);
    const over = await A.rpc('report_lantern', { p_id: fromB?.id ?? ZERO_ID });
    check('report_lantern: sixth report in 24 hours raises rate_limited', !!fromB && !!over.error && over.error.message === 'rate_limited', msg(over));

    // Breaker: with the hourly auto-hide ceiling reached, three reports are recorded but hide nothing.
    // L1 is A's own lantern: A's report is a silent no-op, so the third reporter is a made-up uid.
    sql(`update public.limits set value = 0 where key = 'autohide_per_hour';
         delete from public.rate_events where kind = 'report' and uid = '${uidA}';
         insert into public.reports (lantern_id, uid) values ('${L1.id}', '${GHOST}');
         update public.lanterns set reports = 1 where id = '${L1.id}';`);
    const rr = [];
    for (const c of [A, B, C]) rr.push(await c.rpc('report_lantern', { p_id: L1.id }));
    const vis = await A.from('lanterns').select('id').eq('id', L1.id);
    const [st] = sqlRows(`
      select reports, hidden, hidden_at is null as no_stamp,
             (select count(*) from public.reports where lantern_id = '${L1.id}') as report_rows,
             (select count(*) from public.reports where lantern_id = '${L1.id}' and uid = '${uidA}') as own_rows,
             (select count(*) from public.rate_events where uid = '${uidA}' and kind = 'report') as own_spent
        from public.lanterns where id = '${L1.id}'`);
    check('auto-hide breaker: reports are recorded but the lantern stays visible',
      rr.every((r) => !r.error) && vis.data?.length === 1 && st.reports === '3' && st.hidden === 'false' && st.no_stamp === 'true' && st.report_rows === '3',
      `${rr.map(msg).join(' | ')} ${JSON.stringify(st)}`);
    check('report_lantern: reporting your own lantern is a silent no-op that spends no budget',
      !rr[0].error && st.own_rows === '0' && st.own_spent === '0', `${msg(rr[0])} ${JSON.stringify(st)}`);

    // While the breaker is tripped, only a uid's first lantern of the UTC day is taken. D has
    // released nothing; A has.
    const clearBudget = `delete from public.rate_events where kind = 'lantern' and uid in (${list}, '${uidD}');`;
    sql(clearBudget);
    const trippedA = await A.rpc('release_lantern', { ...base, p_body: '[test] breaker tripped' });
    const trippedD = await D.rpc('release_lantern', lanternArgs(B_POS, '[test] breaker tripped, first today'));
    sql(clearBudget);
    const trippedD2 = await D.rpc('release_lantern', lanternArgs(B_POS, '[test] breaker tripped, second today'));
    check('auto-hide breaker tripped: release_lantern raises sky_busy for a uid that released today',
      trippedA.error?.message === 'sky_busy' && trippedD2.error?.message === 'sky_busy', `${msg(trippedA)} | ${msg(trippedD2)}`);
    check('auto-hide breaker tripped: a first lantern of the UTC day is still taken', !trippedD.error && !!trippedD.data?.id, msg(trippedD));

    // Catch-up: the next prune hides the lantern the breaker let stand, and announces it.
    const [cu] = sqlRows(`
      update public.limits set value = def where key = 'autohide_per_hour';
      select public._prune();
      select hidden, hidden_at is not null as stamped,
             (select count(*) from public.lanterns where seeded and hidden) as seeded_hidden
        from public.lanterns where id = '${L1.id}'`);
    const goneL1 = await B.from('lanterns').select('id').eq('id', L1.id);
    check('_prune catch-up hides a lantern that reached three reports while the breaker was tripped',
      cu.hidden === 'true' && cu.stamped === 'true' && cu.seeded_hidden === '0' && !goneL1.error && goneL1.data.length === 0, JSON.stringify(cu));
    const evL1 = await events.wait((e) => e.table === 'broadcast' && e.payload?.id === L1.id);
    check('realtime: lantern_hidden broadcast for a lantern hidden by _prune catch-up', !!evL1);
    sql(clearBudget);
    const calm = await A.rpc('release_lantern', { ...base, p_body: '[test] breaker calm again' });
    check('auto-hide breaker not tripped: a second lantern of the day is taken again', !calm.error && !!calm.data?.id, msg(calm));
  }

  // ── send_wave ─────────────────────────────────────────────────────────────
  let threadsMade = 0;
  let kmMade = 0;
  {
    const wave = (c, to, pos, extra = {}) => c.rpc('send_wave', { p_to: to, p_lat: pos.lat, p_lon: pos.lon, p_place: FORGED, ...extra });
    const self = await wave(A, uidA, A_POS, { p_tz: A_POS.tz });
    check('send_wave to yourself is refused', !!self.error && self.error.message === 'invalid_target', msg(self));
    const noTz = await wave(A, uidB, A_POS);
    check('send_wave without p_tz and without an earlier check_in raises invalid_input', !!noTz.error && noTz.error.message === 'invalid_input', msg(noTz));
    const badTz = await wave(A, uidB, A_POS, { p_tz: 'Etc/UTC' });
    const far = await wave(A, uidB, { lat: A_POS.lat, lon: A_POS.lon + 0.8 }, { p_tz: A_POS.tz });
    const elsewhere = await wave(A, uidB, B_POS, { p_tz: A_POS.tz });
    check('send_wave rejects an unknown zone and a position outside the place',
      [badTz, far, elsewhere].every((r) => r.error?.message === 'invalid_input'), [badTz, far, elsewhere].map(msg).join(' | '));
    const ab = await wave(A, uidB, A_POS, { p_tz: A_POS.tz });
    check('send_wave A to B (five arguments) returns thread null', !ab.error && ab.data && ab.data.thread === null, msg(ab));
    {
      const wB = await B.rpc('my_wavers');
      const wA = await A.rpc('my_wavers');
      const wC = await C.rpc('my_wavers');
      check('my_wavers: the recipient sees the sender uid; sender and bystander see nothing',
        !wB.error && JSON.stringify(wB.data) === JSON.stringify([uidA]) && !wA.error && Array.isArray(wA.data) && wA.data.length === 0 &&
        !wC.error && Array.isArray(wC.data) && wC.data.length === 0, `${msg(wB)} | ${msg(wA)} | ${msg(wC)}`);
    }

    // B is a deployed client: four named arguments, the zone comes from its last check_in.
    const ci = await B.rpc('check_in', { p_lat: B_POS.lat, p_lon: B_POS.lon, p_place: B_POS.city, p_tz: B_POS.tz, p_zone: 3 });
    const ba = await wave(B, uidA, B_POS);
    const t = ba.data?.thread;
    const want = km(A_POS.lat, A_POS.lon, B_POS.lat, B_POS.lon);
    check('send_wave B to A with the old four arguments returns a thread', !ci.error && !ba.error && !!t?.id, `${msg(ci)} | ${msg(ba)}`);
    if (t) { threadsMade++; kmMade += t.km; }
    check(`thread km is plausible (got ${t?.km}, expected about ${want.toFixed(0)})`, !!t && Math.abs(t.km - want) < want * 0.005);
    check('thread: a is the earlier waver, b the caller, places from the table, no uids',
      !!t && t.a_place === A_POS.city && t.b_place === B_POS.city && Math.abs(t.a_lat - A_POS.lat) < 0.01 &&
      Math.abs(t.b_lon - B_POS.lon) < 0.01 && !('a_uid' in t) && !('b_uid' in t), JSON.stringify(t));
    const farB = await wave(B, uidA, A_POS);
    check('send_wave with four arguments checks the position against the checked-in place',
      !!farB.error && farB.error.message === 'invalid_input', msg(farB));
    const ab2 = await wave(A, uidB, A_POS, { p_tz: A_POS.tz });
    const ba2 = await wave(B, uidA, B_POS);
    check('a second mutual wave within 24h makes no second thread',
      !ab2.error && ab2.data.thread === null && !ba2.error && ba2.data.thread === null, `${msg(ab2)} | ${msg(ba2)}`);
    {
      // Two waves from A are pending for B. The age check runs in a transaction that is never committed.
      const wB = await B.rpc('my_wavers');
      const [old] = sqlRows(`
        begin;
        update public.waves set created_at = now() - interval '11 minutes' where to_uid = '${uidB}';
        select set_config('request.jwt.claims', '{"sub":"${uidB}","role":"authenticated"}', true);
        select (select count(*) from public.waves where to_uid = '${uidB}') as n, auth.uid()::text as me, public.my_wavers()::text as w;`);
      check('my_wavers: distinct uids, and only waves of the last 10 minutes',
        !wB.error && JSON.stringify(wB.data) === JSON.stringify([uidA]) && old.n === '2' && old.me === uidB && old.w === '[]',
        `${msg(wB)} ${JSON.stringify(old)}`);
    }
    const rows = await C.from('threads').select('id, km, a_place, b_place').eq('id', t?.id);
    check('thread row is readable by a third user', !rows.error && rows.data.length === 1, msg(rows));
    const ev = await events.wait((e) => e.table === 'threads' && e.new?.id === t?.id);
    check('realtime: thread insert is received without uids', !!ev && !('a_uid' in ev.new) && !('b_uid' in ev.new));

    // Per-uid thread limit (A already has one thread), then the global hourly breaker.
    sql(`update public.limits set value = 1 where key = 'threads_per_uid_day';`);
    const ca = await wave(C, uidA, C_POS, { p_tz: C_POS.tz });
    const ac = await wave(A, uidC, A_POS, { p_tz: A_POS.tz });
    check('send_wave: a uid at its daily thread limit gets thread null', !ca.error && !ac.error && ac.data.thread === null, `${msg(ca)} | ${msg(ac)}`);
    sql(`update public.limits set value = def where key = 'threads_per_uid_day';
         update public.limits set value = 0 where key = 'threads_global_hour';`);
    const ac2 = await wave(A, uidC, A_POS, { p_tz: A_POS.tz });
    check('send_wave: global hourly thread breaker gives thread null', !ac2.error && ac2.data.thread === null, msg(ac2));
    sql(`update public.limits set value = def where key = 'threads_global_hour';
         delete from public.rate_events where kind = 'wave' and uid in (${list});`);
    const ac3 = await wave(A, uidC, A_POS, { p_tz: A_POS.tz });
    const t2 = ac3.data?.thread;
    check('send_wave: with the limits back, the same pair gets its thread', !ac3.error && !!t2?.id && t2.a_place === C_POS.city, msg(ac3));
    if (t2) { threadsMade++; kmMade += t2.km; }

    // Reserve above the global ceiling. A now has two threads in 24 h; B, C and D have one, one, none.
    const threadsAtCeiling = `update public.limits set value = (select count(*) from public.threads where created_at > now() - interval '1 hour') where key = 'threads_global_hour';`;
    sql(threadsAtCeiling);
    const da = await wave(D, uidA, C_POS, { p_tz: C_POS.tz });
    const ad = await wave(A, uidD, A_POS, { p_tz: A_POS.tz });
    check('send_wave: above the global ceiling a uid with two threads in 24 h gets thread null',
      !da.error && !ad.error && ad.data.thread === null, `${msg(da)} | ${msg(ad)}`);
    // Hard ceiling at twice the limit (two or more threads in the last hour, limit floor(n / 2)).
    sql(`update public.limits set value = (select count(*) / 2 from public.threads where created_at > now() - interval '1 hour') where key = 'threads_global_hour';`);
    const bc = await wave(B, uidC, B_POS, { p_tz: B_POS.tz });
    const cb = await wave(C, uidB, C_POS, { p_tz: C_POS.tz });
    check('send_wave: at twice the global ceiling nobody gets a thread', !bc.error && !cb.error && cb.data.thread === null, `${msg(bc)} | ${msg(cb)}`);
    sql(threadsAtCeiling);
    const bc2 = await wave(B, uidC, B_POS, { p_tz: B_POS.tz });
    const t3 = bc2.data?.thread;
    check('send_wave: above the global ceiling two uids with fewer than two threads still get theirs',
      !bc2.error && !!t3?.id && t3.a_place === C_POS.city && t3.b_place === B_POS.city, msg(bc2));
    if (t3) { threadsMade++; kmMade += t3.km; }
    sql(`update public.limits set value = def where key = 'threads_global_hour';
         delete from public.rate_events where kind = 'wave' and uid in (${list});`);

    const mA = (await A.rpc('my_marks')).data;
    const mB = (await B.rpc('my_marks')).data;
    const mC = (await C.rpc('my_marks')).data;
    check('my_marks lists the thread for both ends only',
      mA.threads.includes(t?.id) && mB.threads.includes(t?.id) && !mC.threads.includes(t?.id) && mC.threads.includes(t2?.id), JSON.stringify({ mA, mB, mC }));
    const s = (await A.rpc('world_stats')).data;
    check('world_stats counts the new threads and their km',
      s.threads_total === stats0.threads_total + threadsMade && Math.abs(s.km_total - stats0.km_total - kmMade) <= 2, JSON.stringify(s));

    // Budget: 8 per minute, counted from the reset above.
    const burst = [];
    for (let i = 0; i < 9; i++) burst.push(await wave(A, uidB, A_POS, { p_tz: A_POS.tz }));
    check('send_wave: eight per minute, the ninth raises rate_limited',
      burst.slice(0, 8).every((r) => !r.error) && burst[8].error?.message === 'rate_limited', burst.map(msg).join(' | ').slice(0, 300));
  }

  // ── check_in / world_stats / recent_echoes ────────────────────────────────
  {
    const ok = { p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: FORGED, p_tz: A_POS.tz, p_zone: 0 };
    const bads = [
      { ...ok, p_lon: 181 }, { ...ok, p_zone: 24 }, { ...ok, p_tz: 'Etc/UTC' }, { ...ok, p_tz: 'Atlantic/Reykjavik; drop' },
      { ...ok, p_lat: A_POS.lat - 0.7 }, { ...ok, p_lat: B_POS.lat, p_lon: B_POS.lon },
    ];
    const rs = [];
    for (const b of bads) rs.push(await A.rpc('check_in', b));
    check('check_in validates lon, zone, zone name and distance from the place',
      rs.every((r) => r.error?.message === 'invalid_input'), rs.map(msg).join(' | '));

    // A sends a forged place and a wrong zone; the server stores the table's city and its own zone.
    const r = await A.rpc('check_in', { ...ok, p_zone: 13 });
    check('check_in succeeds', !r.error, msg(r));
    // B sends a wrong zone for a half-hour place.
    const k = PLACES.get('Asia/Kolkata');
    const rk = await B.rpc('check_in', { p_lat: k.lat + 0.3, p_lon: k.lon - 0.3, p_place: FORGED, p_tz: k.tz, p_zone: 0 });
    const zA = jsZone(A_POS.tz);
    const [e1] = sqlRows(`
      select (select place || '|' || zone from public.echoes where uid = '${uidA}') as a,
             (select place || '|' || zone from public.echoes where uid = '${uidB}') as b,
             (select count(*) from public.zone_days where day = public._utc_day() and zone = ${zA}) as lit,
             (select count(*) from public.zone_days where uid = '${uidA}' and zone = 13) as forged_zone`);
    check('check_in stores places.city and the server-side zone, not the client values',
      !rk.error && e1.a === `${A_POS.city}|${zA}` && e1.b === 'Kolkata|6' && e1.lit === '1' && e1.forged_zone === '0', `${msg(rk)} ${JSON.stringify(e1)}`);

    // C: at most three zones lit per uid per UTC day; the echo is still updated on the fourth.
    const s0 = (await C.rpc('world_stats')).data;
    const picks = [];
    for (const p of PLACES.values()) {
      const z = jsZone(p.tz);
      if (!s0.zones_today.includes(z) && !picks.some((x) => x.z === z)) picks.push({ ...p, z });
      if (picks.length === 4) break;
    }
    if (picks.length < 4) {
      console.log(`SKIP  zone limit and zone realtime checks: only ${picks.length} unlit zones left today`);
    } else {
      const cr = [];
      for (const p of picks) cr.push(await C.rpc('check_in', { p_lat: p.lat, p_lon: p.lon, p_place: FORGED, p_tz: p.tz, p_zone: p.z }));
      const [zl] = sqlRows(`
        select (select string_agg(zone::text, ',' order by lit_at) from public.zone_days where uid = '${uidC}' and day = public._utc_day()) as zones,
               (select tz || '|' || zone from public.echoes where uid = '${uidC}') as echo`);
      check('check_in: a uid lights at most three zones a day, the echo still moves',
        cr.every((x) => !x.error) && zl.zones === picks.slice(0, 3).map((p) => p.z).join(',') && zl.echo === `${picks[3].tz}|${picks[3].z}`,
        `${cr.map(msg).join(' | ')} ${JSON.stringify(zl)}`);
      const z = await B.from('zone_days').select('day, zone, place, lit_at').eq('day', today()).eq('zone', picks[0].z);
      check('check_in lights the zone for today with the table city', !z.error && z.data.length === 1 && z.data[0].place === picks[0].city, msg(z));
      const ev = await events.wait((e) => e.table === 'zone_days' && e.new?.zone === picks[0].z);
      check('realtime: zone_days insert is received without a uid', !!ev && !('uid' in ev.new), ev ? Object.keys(ev.new).join(',') : 'no event');
      const s1 = (await B.rpc('world_stats')).data;
      check('world_stats shows the three lit zones and not the fourth',
        picks.slice(0, 3).every((p) => s1.zones_today.includes(p.z)) && !s1.zones_today.includes(picks[3].z), JSON.stringify(s1.zones_today));
    }

    const s = await B.rpc('world_stats');
    check('world_stats reflects the lit zone and the light',
      !s.error && s.data.zones_today.includes(zA) && s.data.lights_today >= 3 && s.data.lights_48h >= 3 && s.data.day === today(), msg(s));
    check('world_stats has every documented field',
      !s.error && ['threads_total', 'km_total', 'lanterns_48h', 'lights_today', 'lights_48h', 'zones_today', 'day'].every((k2) => k2 in s.data));
    const anonStats = await anon.rpc('world_stats');
    check('world_stats is readable without a session', !anonStats.error && Array.isArray(anonStats.data.zones_today), msg(anonStats));
    const e = await B.rpc('recent_echoes');
    const row = e.data?.find((x) => x.place === A_POS.city && near(x.lat, A_POS.lat, 0.001) && near(x.lon, A_POS.lon, 0.001));
    check('recent_echoes returns the echo with an eid and without a uid',
      !e.error && !!row && !('uid' in row) && Object.keys(row).sort().join(',') === 'eid,last_seen,lat,lon,place' &&
      /^[0-9a-f-]{36}$/.test(row.eid) && !uids.includes(row.eid), msg(e));
    check('recent_echoes carries no client-supplied place text', !e.error && !e.data.some((x) => x.place === FORGED));
    const stamps = (e.data ?? []).map((x) => Date.parse(x.last_seen));
    check('recent_echoes rounds last_seen down to 10 minutes, newest first',
      stamps.length > 0 && stamps.every((ms) => ms % 600000 === 0 && ms <= Date.now() + 60000) &&
      Date.now() - Date.parse(row?.last_seen) < 660000 && stamps.every((ms, i) => i === 0 || ms <= stamps[i - 1]),
      JSON.stringify((e.data ?? []).slice(0, 5).map((x) => x.last_seen)));
    const anonEchoes = await anon.rpc('recent_echoes');
    check('recent_echoes is readable without a session', !anonEchoes.error && anonEchoes.data.some((x) => x.eid === row?.eid), msg(anonEchoes));
  }

  // ── wave_echo / collect_echo_waves ────────────────────────────────────────
  {
    // A handle lasts one visit: a check_in more than 30 minutes after the last one replaces it.
    const ci = { p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: FORGED, p_tz: A_POS.tz, p_zone: 0 };
    const eidOf = () => sqlRows(`select eid from public.echoes where uid = '${uidA}'`)[0]?.eid;
    const eid0 = eidOf();
    const c1 = await A.rpc('check_in', ci);
    const eid1 = eidOf();
    sql(`update public.echoes set last_seen = now() - interval '31 minutes' where uid = '${uidA}';`);
    const stale = await B.rpc('recent_echoes');
    const c2 = await A.rpc('check_in', ci);
    const eid2 = eidOf();
    const c3 = await A.rpc('check_in', ci);
    const eid3 = eidOf();
    check('check_in keeps the echo eid within 30 minutes and replaces it after',
      !c1.error && !c2.error && !c3.error && !!eid0 && eid1 === eid0 && eid2 !== eid1 && /^[0-9a-f-]{36}$/.test(eid2) && eid3 === eid2,
      JSON.stringify({ eid0, eid1, eid2, eid3 }));
    const gone = await B.rpc('wave_echo', { p_eid: eid1, p_lat: B_POS.lat, p_lon: B_POS.lon, p_tz: B_POS.tz });
    check('wave_echo to a replaced eid raises not_found',
      !stale.error && stale.data.some((x) => x.eid === eid1) && gone.error?.message === 'not_found', msg(gone));

    const eids = Object.fromEntries(sqlRows(`select uid, eid from public.echoes where uid in (${list})`).map((r) => [r.uid, r.eid]));
    const eA = await A.rpc('recent_echoes');
    const eB = await B.rpc('recent_echoes');
    check('recent_echoes: user A appears as an echo to B, by eid',
      !eB.error && !!eids[uidA] && eB.data.some((x) => x.eid === eids[uidA] && x.place === A_POS.city), msg(eB));
    check('recent_echoes excludes the caller own echo',
      !eA.error && !eB.error && !!eids[uidB] && !eA.data.some((x) => x.eid === eids[uidA]) && !eB.data.some((x) => x.eid === eids[uidB]) &&
      eA.data.some((x) => x.eid === eids[uidB]), `${msg(eA)} | ${msg(eB)}`);

    const we = (c, eid, pos, over = {}) => c.rpc('wave_echo', { p_eid: eid, p_lat: pos.lat, p_lon: pos.lon, p_tz: pos.tz, ...over });
    const bad = [
      await we(B, eids[uidA], B_POS, { p_tz: 'Etc/UTC' }),
      await we(B, eids[uidA], B_POS, { p_tz: null }),
      await we(B, eids[uidA], B_POS, { p_lat: B_POS.lat + 0.7 }),
      await we(B, eids[uidA], A_POS, { p_tz: B_POS.tz }),
    ];
    check('wave_echo rejects an unknown or missing zone and a position outside the place',
      bad.every((r) => r.error?.message === 'invalid_input'), bad.map(msg).join(' | '));
    const own = await we(B, eids[uidB], B_POS);
    check('wave_echo to your own echo is refused', !!own.error && own.error.message === 'invalid_target', msg(own));
    const unknown = await we(B, ZERO_ID, B_POS);
    check('wave_echo to an unknown eid raises not_found', !!unknown.error && unknown.error.message === 'not_found', msg(unknown));
    const byUid = await we(B, uidA, B_POS);
    check('wave_echo does not accept a uid in place of an eid', !!byUid.error && byUid.error.message === 'not_found', msg(byUid));
    const [spent0] = sqlRows(`select count(*) as n from public.rate_events where uid = '${uidB}' and kind = 'echo_wave'`);
    check('wave_echo spends no budget on a refused call', spent0.n === '0', JSON.stringify(spent0));

    const ok1 = await we(B, eids[uidA], B_POS);
    check('wave_echo from B to the echo of A returns ok', !ok1.error && ok1.data?.ok === true && Object.keys(ok1.data).join(',') === 'ok', msg(ok1));
    const ok2 = await we(B, eids[uidA], B_POS);
    const [pend] = sqlRows(`select count(*) as n, min(from_place) as place from public.echo_waves where to_uid = '${uidA}'`);
    check('wave_echo twice from the same sender keeps one pending row, with places.city',
      !ok2.error && pend.n === '1' && pend.place === B_POS.city, `${msg(ok2)} ${JSON.stringify(pend)}`);

    sql(`update public.limits set value = 0 where key = 'echo_wave_per_hour';`);
    const limited = await we(C, eids[uidA], C_POS);
    sql(`update public.limits set value = def where key = 'echo_wave_per_hour';`);
    check('wave_echo: over the hourly budget raises rate_limited', !!limited.error && limited.error.message === 'rate_limited', msg(limited));

    const none = await B.rpc('collect_echo_waves');
    check('collect_echo_waves for someone with nothing pending returns []', !none.error && Array.isArray(none.data) && none.data.length === 0, msg(none));
    const got = await A.rpc('collect_echo_waves');
    const w = got.data?.[0];
    check('collect_echo_waves returns the one wave with the canonical place of the sender',
      !got.error && Array.isArray(got.data) && got.data.length === 1 && w.place === B_POS.city && w.tz === B_POS.tz &&
      near(w.lat, B_POS.lat, 0.001) && near(w.lon, B_POS.lon, 0.001) && !Number.isNaN(Date.parse(w.created_at)), msg(got));
    check('collect_echo_waves item has exactly place, tz, lat, lon, created_at (no uid)',
      !!w && Object.keys(w).sort().join(',') === 'created_at,lat,lon,place,tz', JSON.stringify(w));
    const again = await A.rpc('collect_echo_waves');
    const [leftover] = sqlRows(`select count(*) as n from public.echo_waves where to_uid = '${uidA}'`);
    check('collect_echo_waves delivers once: the second call returns []',
      !again.error && Array.isArray(again.data) && again.data.length === 0 && leftover.n === '0', `${msg(again)} ${JSON.stringify(leftover)}`);

    // Cap: 40 pending per recipient; the 41st sender replaces the oldest pending row. Stale rows
    // are deleted on collect without being returned, and at most 20 come back.
    sql(`insert into public.echo_waves (to_uid, from_uid, from_place, from_tz, from_lat, from_lon, created_at)
         select '${uidA}', gen_random_uuid(), 'x' || g, 'Etc/UTC', 0, 0,
                now() - case when g <= 5 then interval '8 days' else g * interval '1 minute' end
           from generate_series(1, 40) g;`);
    const capped = await we(C, eids[uidA], C_POS);
    const capSql = `select count(*) as n, count(*) filter (where from_uid = '${uidC}') as mine,
        count(*) filter (where from_place = 'x1') as oldest, count(*) filter (where from_place = 'x2') as second
        from public.echo_waves where to_uid = '${uidA}'`;
    const [cap] = sqlRows(capSql);
    check('wave_echo: at 40 pending the new wave replaces the oldest pending row',
      !capped.error && capped.data?.ok === true && cap.n === '40' && cap.mine === '1' && cap.oldest === '0' && cap.second === '1',
      `${msg(capped)} ${JSON.stringify(cap)}`);
    const capped2 = await we(C, eids[uidA], C_POS);
    const [cap2] = sqlRows(capSql);
    check('wave_echo: a repeat from a sender already pending at the cap evicts nothing',
      !capped2.error && cap2.n === '40' && cap2.mine === '1' && cap2.second === '1', `${msg(capped2)} ${JSON.stringify(cap2)}`);
    const many = await A.rpc('collect_echo_waves');
    const [after] = sqlRows(`select count(*) as n from public.echo_waves where to_uid = '${uidA}'`);
    check('collect_echo_waves returns the newest 20 of the last 7 days and deletes everything',
      !many.error && many.data.length === 20 && many.data[0].place === C_POS.city && many.data[1].place === 'x6' &&
      many.data[19].place === 'x24' && after.n === '0',
      `${msg(many)} ${JSON.stringify(after)}`);
  }

  // ── city places: key 'g' || geonameid, real zone in zone_tz, 0.21 degree box ──
  {
    sql(`delete from public.rate_events where uid = '${uidD}' and kind in ('lantern', 'wave', 'check_in', 'echo_wave');`);
    const ci = (c, pos, over = {}) => c.rpc('check_in', { p_lat: pos.lat, p_lon: pos.lon, p_place: FORGED, p_tz: pos.tz, p_zone: 0, ...over });
    const echoOf = (uid) => sqlRows(`select place || '|' || tz || '|' || zone as e from public.echoes where uid = '${uid}'`)[0]?.e;

    // A half-hour zone, with a forged p_zone: the ring zone comes from the city's real time zone.
    const p1 = await ci(D, PUNE);
    check('check_in with a city key in a half-hour zone stores the city, the key and the zone of its real time zone',
      !p1.error && PUNE.zone === 'Asia/Kolkata' && echoOf(uidD) === `Pune|${PUNE.tz}|6`, `${msg(p1)} ${echoOf(uidD)}`);

    const bad = [
      ['an unknown city key (g1)', await ci(D, MADISON, { p_tz: 'g1' })],
      ['a city key in the wrong case', await ci(D, MADISON, { p_tz: MADISON.tz.toUpperCase() })],
      ['a geonameid without the g', await ci(D, MADISON, { p_tz: MADISON.tz.slice(1) })],
      ['a latitude 0.3 degrees from the city', await ci(D, MADISON, { p_lat: MADISON.lat + 0.3 })],
      ['a longitude 0.3 degrees from the city', await ci(D, MADISON, { p_lon: MADISON.lon - 0.3 })],
      ['a city key at the centre of its zone place', await ci(D, { ...PLACES.get(MADISON.zone), tz: MADISON.tz })],
      ['a zone key at a city of that zone', await ci(D, { ...MADISON, tz: MADISON.zone })],
    ];
    for (const [name, r] of bad) check(`check_in rejects ${name}`, r.error?.message === 'invalid_input', msg(r));
    const nb = PLACES.get('Africa/Nairobi');
    const wide = await ci(D, { ...nb, lat: nb.lat + 0.5, lon: nb.lon - 0.5 });
    check('check_in: 0.5 degrees from the centre is still accepted for a zone key', !wide.error && !!echoOf(uidD)?.startsWith('Nairobi|Africa/Nairobi|'), `${msg(wide)} ${echoOf(uidD)}`);
    const edge = await ci(D, { ...MADISON, lat: MADISON.lat + 0.2, lon: MADISON.lon - 0.2 });
    check('check_in: 0.2 degrees from the centre is accepted for a city key', !edge.error, msg(edge));

    const zM = jsZone(MADISON.zone);
    const m1 = await ci(D, MADISON, { p_zone: (zM + 7) % 24 });
    const [lit] = sqlRows(`select count(*) as n from public.zone_days where day = public._utc_day() and zone = ${zM}`);
    check('check_in with a city key at the city coordinates works and lights the zone of its real time zone',
      !m1.error && echoOf(uidD) === `Madison|${MADISON.tz}|${zM}` && lit.n === '1', `${msg(m1)} ${echoOf(uidD)} ${JSON.stringify(lit)}`);
    const seenEcho = await A.rpc('recent_echoes');
    check('recent_echoes shows a city visitor by the city name',
      !seenEcho.error && seenEcho.data.some((x) => x.place === 'Madison' && near(x.lat, MADISON.lat, 0.001) && near(x.lon, MADISON.lon, 0.001)), msg(seenEcho));

    // Lantern: the name is the city, tz is the real IANA zone (clients format local time with it).
    const lr = await D.rpc('release_lantern', lanternArgs(PUNE, '[test] from a city'));
    const lc = lr.data;
    check('release_lantern with a city key returns place = the city name and tz = the real IANA zone',
      !lr.error && lc?.place === 'Pune' && lc?.tz === 'Asia/Kolkata', msg(lr));
    check('a city lantern sits within 0.2 degrees of the city centre',
      !!lc && near(lc.lat, PUNE.lat, 0.2011) && near(lc.lon, PUNE.lon, 0.2011), JSON.stringify(lc));
    const lrow = await A.from('lanterns').select('place, tz').eq('id', lc?.id ?? ZERO_ID);
    check('the city lantern row read over REST carries the real zone, not the key',
      !lrow.error && lrow.data.length === 1 && lrow.data[0].place === 'Pune' && lrow.data[0].tz === 'Asia/Kolkata', msg(lrow));
    const lbad = await D.rpc('release_lantern', { ...lanternArgs(PUNE, '[test] unknown key'), p_tz: 'g1' });
    const lfar = await D.rpc('release_lantern', { ...lanternArgs(PUNE, '[test] too far'), p_lat: PUNE.lat - 0.3 });
    check('release_lantern rejects an unknown city key and a position 0.3 degrees from the city',
      lbad.error?.message === 'invalid_input' && lfar.error?.message === 'invalid_input', `${msg(lbad)} | ${msg(lfar)}`);

    // Thread between a city-key visitor (D, old four-argument call: the key comes from its last
    // check_in) and a zone-key visitor (B).
    const wave = (c, to, pos, extra = {}) => c.rpc('send_wave', { p_to: to, p_lat: pos.lat, p_lon: pos.lon, p_place: FORGED, ...extra });
    const wbad = await wave(D, uidB, MADISON, { p_tz: 'g1' });
    const wfar = await wave(D, uidB, { lat: MADISON.lat, lon: MADISON.lon + 0.3 }, { p_tz: MADISON.tz });
    check('send_wave rejects an unknown city key and a position 0.3 degrees from the city',
      wbad.error?.message === 'invalid_input' && wfar.error?.message === 'invalid_input', `${msg(wbad)} | ${msg(wfar)}`);
    const db = await wave(D, uidB, MADISON);
    const bd = await wave(B, uidD, B_POS, { p_tz: B_POS.tz });
    const tc = bd.data?.thread;
    const wantKm = km(MADISON.lat, MADISON.lon, B_POS.lat, B_POS.lon);
    check('send_wave between a city-key visitor and a zone-key visitor makes a thread with the right place names',
      !db.error && db.data?.thread === null && !bd.error && !!tc?.id && tc.a_place === 'Madison' && tc.b_place === B_POS.city &&
      near(tc.a_lat, MADISON.lat, 0.001) && near(tc.a_lon, MADISON.lon, 0.001), `${msg(db)} | ${msg(bd)}`);
    check(`city thread km is plausible (got ${tc?.km}, expected about ${wantKm.toFixed(0)})`, !!tc && Math.abs(tc.km - wantKm) < wantKm * 0.005);
    // And the other way round, city key sent explicitly: C (zone key) first, then D.
    const cd = await wave(C, uidD, C_POS, { p_tz: C_POS.tz });
    const dc = await wave(D, uidC, MADISON, { p_tz: MADISON.tz });
    const tc2 = dc.data?.thread;
    check('send_wave with an explicit city key completes a thread started by a zone-key visitor',
      !cd.error && !dc.error && !!tc2?.id && tc2.a_place === C_POS.city && tc2.b_place === 'Madison', `${msg(cd)} | ${msg(dc)}`);

    // Echo wave from a city-key visitor: the recipient gets the city name and the real zone.
    const eidA = sqlRows(`select eid from public.echoes where uid = '${uidA}'`)[0]?.eid;
    const ebad = await D.rpc('wave_echo', { p_eid: eidA, p_lat: MADISON.lat, p_lon: MADISON.lon, p_tz: 'g1' });
    const efar = await D.rpc('wave_echo', { p_eid: eidA, p_lat: MADISON.lat + 0.3, p_lon: MADISON.lon, p_tz: MADISON.tz });
    check('wave_echo rejects an unknown city key and a position 0.3 degrees from the city',
      ebad.error?.message === 'invalid_input' && efar.error?.message === 'invalid_input', `${msg(ebad)} | ${msg(efar)}`);
    const eok = await D.rpc('wave_echo', { p_eid: eidA, p_lat: MADISON.lat, p_lon: MADISON.lon, p_tz: MADISON.tz });
    const [stored] = sqlRows(`select from_place || '|' || from_tz as v from public.echo_waves where to_uid = '${uidA}' and from_uid = '${uidD}'`);
    const got = await A.rpc('collect_echo_waves');
    const w = got.data?.[0];
    check('wave_echo + collect_echo_waves from a city-key visitor returns the city name and the real zone',
      !eok.error && eok.data?.ok === true && stored?.v === 'Madison|America/Chicago' && !got.error && got.data.length === 1 &&
      w.place === 'Madison' && w.tz === 'America/Chicago' && near(w.lat, MADISON.lat, 0.001) && near(w.lon, MADISON.lon, 0.001),
      `${msg(eok)} ${JSON.stringify(stored)} ${msg(got)}`);

    const [keys] = sqlRows(`
      select (select count(*) from public.lanterns where tz ~ '^g[0-9]+$') as lantern_keys,
             (select count(*) from public.echo_waves where from_tz ~ '^g[0-9]+$') as echo_wave_keys,
             (select tz from public.echoes where uid = '${uidD}') as echo_key`);
    check('no place key is stored where clients read a time zone; echoes.tz keeps the key',
      keys.lantern_keys === '0' && keys.echo_wave_keys === '0' && keys.echo_key === MADISON.tz, JSON.stringify(keys));

    const pr = await D.from('places').select('tz, zone_tz, jitter').eq('tz', MADISON.tz);
    const pa = await anon.from('places').select('tz, city, zone_tz').limit(1);
    check('places (city rows, new columns) is not readable via REST, signed in or not', !!pr.error && !!pa.error, `${msg(pr)} | ${msg(pa)}`);
  }

  await A.removeAllChannels();
  await C.removeAllChannels();

  // ── cleanup ───────────────────────────────────────────────────────────────
  if (NO_CLEANUP) {
    sql(`update public.limits set value = def where value <> def;`);
    console.log('cleanup skipped (--no-cleanup): test rows remain in the database');
  } else {
    let err = '';
    try {
      cleanup(allUids);
    } catch (e) {
      err = String(e.stderr || e.message).slice(0, 300);
    }
    check('cleanup ran', !err, err);
    const s = (await A.rpc('world_stats')).data;
    const l = await A.from('lanterns').select('id, seeded, body');
    const m = (await A.rpc('my_marks')).data;
    const list = allUids.map((u) => `'${u}'`).join(',');
    const [left] = sqlRows(`
      select (select count(*) from public.lanterns where uid in (${list}))
           + (select count(*) from public.warmths where uid in (${list}))
           + (select count(*) from public.reports where uid in (${list}) or uid = '${GHOST}')
           + (select count(*) from public.waves where from_uid in (${list}) or to_uid in (${list}))
           + (select count(*) from public.threads where a_uid in (${list}) or b_uid in (${list}))
           + (select count(*) from public.echoes where uid in (${list}))
           + (select count(*) from public.echo_waves where from_uid in (${list}) or to_uid in (${list}))
           + (select count(*) from public.zone_days where uid in (${list}))
           + (select count(*) from public.rate_events where uid in (${list})) as residue,
             (select count(*) from public.limits where value <> def) as limits_changed`);
    check('after cleanup: no test rows remain, limits are at their defaults, totals are restored',
      s.threads_total === stats0.threads_total && Math.abs(s.km_total - stats0.km_total) <= 2 &&
      left.residue === '0' && left.limits_changed === '0' && m.lanterns.length === 0 && m.threads.length === 0 &&
      !l.data.some((x) => x.body.startsWith('[test]')) && l.data.filter((x) => x.seeded).length === 6,
      JSON.stringify({ s, left, m }));
  }
}

try {
  await main();
} catch (e) {
  failed++;
  console.log(`FAIL  test run aborted  -- ${e?.stack || e}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
