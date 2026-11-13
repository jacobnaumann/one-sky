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
    delete from public.reports where uid in (${list});
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
  console.log(`sessions: ${users.filter((u) => u.reused).length} reused, ${users.filter((u) => !u.reused).length} new`);
  check('anonymous sign-in gives three distinct anonymous users',
    new Set(uids).size === 3 && users.every((u) => u.session.user.is_anonymous === true));

  if (!NO_CLEANUP) cleanup(uids); // clear residue from an earlier, interrupted run

  const anon = newClient(); // no session at all

  // ── auth configuration ────────────────────────────────────────────────────
  {
    const fresh = newClient();
    const r = await fresh.auth.signInAnonymously();
    check('auth: a fresh anonymous sign-in still works', !r.error && r.data?.user?.is_anonymous === true, r.error?.message);
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
    check('seeded lanterns are labelled as from One Sky',
      !r.error && r.data.filter((l) => l.seeded).every((l) => l.body.startsWith('From One Sky:') && l.place !== 'One Sky'));
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
    };
    const patch = {
      lanterns: { warmth: 999 }, warmths: { uid: uidB }, reports: { uid: uidB }, waves: { place: 'x' },
      threads: { km: 999 }, echoes: { place: 'x' }, zone_days: { place: 'x' }, rate_events: { kind: 'y' },
      world_totals: { threads_total: 999 }, places: { city: 'x' }, limits: { value: 999999 },
    };
    const anyCol = {
      lanterns: 'id', warmths: 'lantern_id', reports: 'lantern_id', waves: 'id', threads: 'id',
      echoes: 'uid', zone_days: 'zone', rate_events: 'uid', world_totals: 'id', places: 'tz', limits: 'key',
    };
    for (const t of Object.keys(rows)) {
      const ins = await A.from(t).insert(rows[t]);
      const upd = await A.from(t).update(patch[t]).not(anyCol[t], 'is', null);
      const del = await A.from(t).delete().not(anyCol[t], 'is', null);
      check(`signed in: insert/update/delete on ${t} refused`, !!ins.error && !!upd.error && !!del.error,
        `insert: ${msg(ins)} | update: ${msg(upd)} | delete: ${msg(del)}`);
    }
    for (const t of ['waves', 'reports', 'rate_events', 'echoes', 'world_totals', 'places', 'limits']) {
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
        (select count(*) from public.places p where not exists (select 1 from pg_timezone_names n where n.name = p.tz)) as unknown_tz,
        (select schedule from cron.job where jobname = 'one-sky-prune') as prune_schedule,
        (select count(*) from cron.job where jobname = 'one-sky-prune-anon' and command like '%is_anonymous%30 days%') as anon_job,
        has_table_privilege((select username from cron.job where jobname = 'one-sky-prune-anon'), 'auth.users', 'DELETE') as anon_job_allowed,
        (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity) as tables_without_rls`);
    check('every SECURITY DEFINER function has search_path = public, pg_temp', h.bad_path === '0', JSON.stringify(h));
    check('send_wave has exactly one overload', h.send_wave_fns === '1', JSON.stringify(h));
    check('places holds the 418 rows of the client table', h.places === String(PLACES.size) && PLACES.size === 418, JSON.stringify(h));
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
    const zones = sqlRows(`select tz, public._zone_for_tz(tz, null) as z from public.places order by tz`);
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
      select public._prune();
      select (select string_agg(kind, ',' order by kind) from public.rate_events where uid = '${u}') as kinds,
             (select count(*) from public.waves where from_uid = '${u}') as waves,
             (select count(*) from public.threads where a_uid = '${u}') as threads;`);
    check('_prune keeps what each limiter still needs and drops the rest',
      p.kinds === 'check_in,lantern,report,warm,wave' && p.waves === '1' && p.threads === '1', JSON.stringify(p));
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

  // Global ceiling, then text that must be accepted. The per-uid lantern budget (1 per 30 s,
  // 5 per day) is cleared between rounds so this does not take minutes.
  {
    sql(`update public.limits set value = 0 where key = 'lanterns_global_hour';
         delete from public.rate_events where kind = 'lantern' and uid in (${list});`);
    const r = await A.rpc('release_lantern', { ...base, p_body: '[test] over the ceiling' });
    check('release_lantern: global hourly ceiling raises rate_limited', !!r.error && r.error.message === 'rate_limited', msg(r));
    sql(`update public.limits set value = def where key = 'lanterns_global_hour';`);

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
    const made = [];
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
    const r2 = await B.rpc('report_lantern', { p_id: L2.id });
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
    const over = await A.rpc('report_lantern', { p_id: L1.id });
    check('report_lantern: sixth report in 24 hours raises rate_limited', !!over.error && over.error.message === 'rate_limited', msg(over));

    // Breaker: with the hourly auto-hide ceiling reached, three reports are recorded but hide nothing.
    sql(`update public.limits set value = 0 where key = 'autohide_per_hour';
         delete from public.rate_events where kind = 'report' and uid = '${uidA}';`);
    const rr = [];
    for (const c of [A, B, C]) rr.push(await c.rpc('report_lantern', { p_id: L1.id }));
    const vis = await A.from('lanterns').select('id').eq('id', L1.id);
    const [st] = sqlRows(`
      update public.limits set value = def where key = 'autohide_per_hour';
      select reports, hidden, hidden_at is null as no_stamp,
             (select count(*) from public.reports where lantern_id = '${L1.id}') as report_rows
        from public.lanterns where id = '${L1.id}'`);
    check('auto-hide breaker: reports are recorded but the lantern stays visible',
      rr.every((r) => !r.error) && vis.data?.length === 1 && st.reports === '3' && st.hidden === 'false' && st.no_stamp === 'true' && st.report_rows === '3',
      `${rr.map(msg).join(' | ')} ${JSON.stringify(st)}`);
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

    const mA = (await A.rpc('my_marks')).data;
    const mB = (await B.rpc('my_marks')).data;
    const mC = (await C.rpc('my_marks')).data;
    check('my_marks lists the thread for both ends only',
      mA.threads.includes(t?.id) && mB.threads.includes(t?.id) && !mC.threads.includes(t?.id) && mC.threads.includes(t2?.id), JSON.stringify({ mA, mB, mC }));
    const s = (await A.rpc('world_stats')).data;
    check('world_stats counts the new threads and their km',
      s.threads_total === stats0.threads_total + threadsMade && Math.abs(s.km_total - stats0.km_total - kmMade) <= 2, JSON.stringify(s));

    // Budget: 8 per minute. A has sent one since the reset above, so seven more pass.
    const burst = [];
    for (let i = 0; i < 8; i++) burst.push(await wave(A, uidB, A_POS, { p_tz: A_POS.tz }));
    check('send_wave: eight per minute, the ninth raises rate_limited',
      burst.slice(0, 7).every((r) => !r.error) && burst[7].error?.message === 'rate_limited', burst.map(msg).join(' | ').slice(0, 300));
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
    check('recent_echoes returns the echo without a uid',
      !e.error && !!row && !('uid' in row) && Object.keys(row).sort().join(',') === 'last_seen,lat,lon,place', msg(e));
    check('recent_echoes carries no client-supplied place text', !e.error && !e.data.some((x) => x.place === FORGED));
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
      cleanup(uids);
    } catch (e) {
      err = String(e.stderr || e.message).slice(0, 300);
    }
    check('cleanup ran', !err, err);
    const s = (await A.rpc('world_stats')).data;
    const l = await A.from('lanterns').select('id, seeded, body');
    const m = (await A.rpc('my_marks')).data;
    const [left] = sqlRows(`
      select (select count(*) from public.lanterns where uid in (${list}))
           + (select count(*) from public.warmths where uid in (${list}))
           + (select count(*) from public.reports where uid in (${list}))
           + (select count(*) from public.waves where from_uid in (${list}) or to_uid in (${list}))
           + (select count(*) from public.threads where a_uid in (${list}) or b_uid in (${list}))
           + (select count(*) from public.echoes where uid in (${list}))
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
