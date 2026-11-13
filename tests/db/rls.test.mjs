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

function cleanup(uids) {
  const list = uids.map((u) => `'${u}'`).join(',');
  sql(`
    begin;
    delete from public.lanterns where uid in (${list}) or (body like '[test]%' and not seeded);
    delete from public.warmths where uid in (${list});
    delete from public.reports where uid in (${list});
    delete from public.waves where from_uid in (${list}) or to_uid in (${list}) or place like '[test]%';
    with d as (
      delete from public.threads
       where a_uid in (${list}) or b_uid in (${list}) or a_place like '[test]%' or b_place like '[test]%'
       returning km
    )
    update public.world_totals
       set threads_total = greatest(0, threads_total - (select count(*) from d)),
           km_total = greatest(0, km_total - coalesce((select sum(km) from d), 0))
     where id;
    delete from public.echoes where uid in (${list}) or place like '[test]%';
    delete from public.zone_days where place like '[test]%';
    delete from public.rate_events where uid in (${list});
    commit;
  `);
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

const A_POS = { lat: 64.15, lon: -21.94, place: '[test] Reykjavik', tz: 'Atlantic/Reykjavik', zone: 0 };
const B_POS = { lat: -1.29, lon: 36.82, place: '[test] Nairobi', tz: 'Africa/Nairobi', zone: 3 };
const TEST_ZONE = 13;

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
  console.log(`sessions: ${users.filter((u) => u.reused).length} reused, ${users.filter((u) => !u.reused).length} new`);
  check('anonymous sign-in gives three distinct anonymous users',
    new Set(uids).size === 3 && users.every((u) => u.session.user.is_anonymous === true));

  if (!NO_CLEANUP) cleanup(uids); // clear residue from an earlier, interrupted run

  const anon = newClient(); // no session at all

  // ── no session ────────────────────────────────────────────────────────────
  {
    const lantern = { p_body: '[test] no session', p_question_id: 0, p_lat: 1, p_lon: 1, p_place: '[test] Nowhere', p_tz: 'Etc/UTC' };
    let r = await anon.rpc('release_lantern', lantern);
    check('no session: release_lantern refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('check_in', { p_lat: 1, p_lon: 1, p_place: '[test] Nowhere', p_tz: 'Etc/UTC', p_zone: 1 });
    check('no session: check_in refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('send_wave', { p_to: uidA, p_lat: 1, p_lon: 1, p_place: '[test] Nowhere' });
    check('no session: send_wave refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('warm_lantern', { p_id: '00000000-0000-0000-0000-000000000000' });
    check('no session: warm_lantern refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.rpc('report_lantern', { p_id: '00000000-0000-0000-0000-000000000000' });
    check('no session: report_lantern refused', !!r.error && /not_authenticated/.test(r.error.message), msg(r));
    r = await anon.from('lanterns').insert({ day: today(), question_id: 0, body: '[test] direct', lat: 0, lon: 0, place: '[test] X', tz: 'Etc/UTC' });
    check('no session: direct insert into lanterns refused', !!r.error, msg(r));
    r = await anon.from('zone_days').insert({ day: today(), zone: 5, place: '[test] X' });
    check('no session: direct insert into zone_days refused', !!r.error, msg(r));
    r = await anon.from('lanterns').select('id, body, place, seeded');
    check('no session: can read seeded lanterns', !r.error && r.data.filter((l) => l.seeded).length === 6, msg(r));
    check('seeded lanterns are labelled as from One Sky',
      !r.error && r.data.filter((l) => l.seeded).every((l) => l.body.startsWith('From One Sky:') && l.place !== 'One Sky'));
  }

  // ── signed in: no direct writes, no private reads ─────────────────────────
  {
    const rows = {
      lanterns: { day: today(), question_id: 0, body: '[test] direct', lat: 0, lon: 0, place: '[test] X', tz: 'Etc/UTC' },
      warmths: { lantern_id: '00000000-0000-0000-0000-000000000000', uid: uidA },
      reports: { lantern_id: '00000000-0000-0000-0000-000000000000', uid: uidA },
      waves: { from_uid: uidA, to_uid: uidB, lat: 0, lon: 0, place: '[test] X' },
      threads: { a_uid: uidA, b_uid: uidB, a_lat: 0, a_lon: 0, a_place: '[test] X', b_lat: 1, b_lon: 1, b_place: '[test] Y', km: 1 },
      echoes: { uid: uidA, lat: 0, lon: 0, place: '[test] X', tz: 'Etc/UTC', zone: 1 },
      zone_days: { day: today(), zone: 5, place: '[test] X' },
      rate_events: { uid: uidA, kind: 'x' },
      world_totals: { id: true, threads_total: 999, km_total: 999 },
    };
    const patch = {
      lanterns: { warmth: 999 }, warmths: { uid: uidB }, reports: { uid: uidB }, waves: { place: 'x' },
      threads: { km: 999 }, echoes: { place: 'x' }, zone_days: { place: 'x' }, rate_events: { kind: 'y' },
      world_totals: { threads_total: 999 },
    };
    const anyCol = {
      lanterns: 'id', warmths: 'lantern_id', reports: 'lantern_id', waves: 'id', threads: 'id',
      echoes: 'uid', zone_days: 'zone', rate_events: 'uid', world_totals: 'id',
    };
    for (const t of Object.keys(rows)) {
      const ins = await A.from(t).insert(rows[t]);
      const upd = await A.from(t).update(patch[t]).not(anyCol[t], 'is', null);
      const del = await A.from(t).delete().not(anyCol[t], 'is', null);
      check(`signed in: insert/update/delete on ${t} refused`, !!ins.error && !!upd.error && !!del.error,
        `insert: ${msg(ins)} | update: ${msg(upd)} | delete: ${msg(del)}`);
    }
    for (const t of ['waves', 'reports', 'rate_events', 'echoes', 'world_totals']) {
      const r = await A.from(t).select('*').limit(1);
      check(`signed in: cannot read ${t}`, !!r.error, msg(r));
    }
    let r = await A.from('lanterns').select('uid').limit(1);
    check('signed in: cannot read lanterns.uid', !!r.error, msg(r));
    r = await A.from('lanterns').select('*').limit(1);
    check('signed in: select * on lanterns refused (must list columns)', !!r.error, msg(r));
    r = await A.from('lanterns').select('reports, hidden').limit(1);
    check('signed in: cannot read lanterns.reports/hidden', !!r.error, msg(r));
    r = await A.from('threads').select('a_uid').limit(1);
    const r2 = await A.from('threads').select('b_uid').limit(1);
    check('signed in: cannot read threads.a_uid / b_uid', !!r.error && !!r2.error, `${msg(r)} | ${msg(r2)}`);
    r = await A.from('lanterns').select('id,day,question_id,body,lat,lon,place,tz,warmth,seeded,created_at').limit(1);
    check('signed in: documented lantern columns are readable', !r.error && r.data.length === 1, msg(r));
    r = await A.from('threads').select('id,a_lat,a_lon,a_place,b_lat,b_lon,b_place,km,created_at').limit(1);
    check('signed in: documented thread columns are readable', !r.error, msg(r));
    r = await A.rpc('_rate_take', { p_uid: uidA, p_kind: 'x', p_window: '1 hour', p_max: 1 });
    const r3 = await A.rpc('_prune');
    check('signed in: internal helper functions are not callable', !!r.error && !!r3.error, `${msg(r)} | ${msg(r3)}`);
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
  const base = { p_question_id: 7, p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: A_POS.place, p_tz: A_POS.tz };
  const rejects = [
    ['link (url)', '[test] look at http://example.com', 'link'],
    ['link (bare domain)', '[test] visit example.com today', 'link'],
    ['contact (@handle)', '[test] message me @someone', 'contact'],
    ['contact (email)', '[test] write to me at a.b@mail.example', 'contact'],
    ['contact (phone)', '[test] call 555 123 4567 now', 'contact'],
    ['too_long', '[test] ' + 'x'.repeat(140), 'too_long'],
    ['empty', '   \n\t  ', 'empty'],
    ['blocked', '[test] this is shit', 'blocked'],
  ];
  for (const [name, body, want] of rejects) {
    const r = await A.rpc('release_lantern', { ...base, p_body: body });
    check(`release_lantern rejects ${name}`, !!r.error && r.error.message === want, msg(r));
  }
  {
    const r = await A.rpc('release_lantern', { ...base, p_body: '[test] ok', p_lat: 91 });
    check('release_lantern rejects latitude 91', !!r.error && r.error.message === 'invalid_input', msg(r));
  }
  let L1;
  {
    const r = await A.rpc('release_lantern', { ...base, p_body: '  [test]   hello \n  world  ' });
    L1 = r.data;
    check('release_lantern works and cleans whitespace',
      !r.error && L1?.body === '[test] hello world' && L1.warmth === 0 && L1.seeded === false &&
      L1.day === today() && L1.question_id === 7 && L1.place === A_POS.place, msg(r));
    check('release_lantern result carries no uid / reports / hidden',
      !!L1 && !('uid' in L1) && !('reports' in L1) && !('hidden' in L1), JSON.stringify(L1));
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
    const r = await B.rpc('release_lantern', { ...base, p_lat: B_POS.lat, p_lon: B_POS.lon, p_place: B_POS.place, p_tz: B_POS.tz, p_body: '[test] from the other side' });
    L2 = r.data;
    check('second user releases a lantern', !r.error && !!L2?.id, msg(r));
    const ev = await events.wait((e) => e.table === 'lanterns' && e.eventType === 'INSERT' && e.new?.id === L2?.id);
    check('realtime: insert made by another session is received', !!ev && ev.new.body === '[test] from the other side');
    check('realtime: lantern payload has no uid / reports / hidden',
      !!ev && !('uid' in ev.new) && !('reports' in ev.new) && !('hidden' in ev.new), ev ? Object.keys(ev.new).join(',') : 'no event');
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
    const bad = await A.rpc('warm_lantern', { p_id: '00000000-0000-0000-0000-000000000000' });
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
    // Hide the other test lantern as well, so nothing from the test stays visible.
    for (const c of [A, B, C]) await c.rpc('report_lantern', { p_id: L1.id });
    const gone1 = await A.from('lanterns').select('id').eq('id', L1.id);
    check('test lanterns are hidden after the run', !gone1.error && gone1.data.length === 0, msg(gone1));
  }

  // ── send_wave ─────────────────────────────────────────────────────────────
  {
    const self = await A.rpc('send_wave', { p_to: uidA, p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: A_POS.place });
    check('send_wave to yourself is refused', !!self.error && self.error.message === 'invalid_target', msg(self));
    const ab = await A.rpc('send_wave', { p_to: uidB, p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: A_POS.place });
    check('send_wave A to B returns thread null', !ab.error && ab.data && ab.data.thread === null, msg(ab));
    const ba = await B.rpc('send_wave', { p_to: uidA, p_lat: B_POS.lat, p_lon: B_POS.lon, p_place: B_POS.place });
    const t = ba.data?.thread;
    const want = km(A_POS.lat, A_POS.lon, B_POS.lat, B_POS.lon);
    check('send_wave B to A returns a thread', !ba.error && !!t?.id, msg(ba));
    check(`thread km is plausible (got ${t?.km}, expected about ${want.toFixed(0)})`, !!t && Math.abs(t.km - want) < want * 0.005);
    check('thread: a is the earlier waver, b the caller, no uids',
      !!t && t.a_place === A_POS.place && t.b_place === B_POS.place && Math.abs(t.a_lat - A_POS.lat) < 0.01 &&
      Math.abs(t.b_lon - B_POS.lon) < 0.01 && !('a_uid' in t) && !('b_uid' in t), JSON.stringify(t));
    const ab2 = await A.rpc('send_wave', { p_to: uidB, p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: A_POS.place });
    const ba2 = await B.rpc('send_wave', { p_to: uidA, p_lat: B_POS.lat, p_lon: B_POS.lon, p_place: B_POS.place });
    check('a second mutual wave within 24h makes no second thread',
      !ab2.error && ab2.data.thread === null && !ba2.error && ba2.data.thread === null, `${msg(ab2)} | ${msg(ba2)}`);
    const rows = await C.from('threads').select('id, km, a_place, b_place').eq('id', t?.id);
    check('thread row is readable by a third user', !rows.error && rows.data.length === 1, msg(rows));
    const ev = await events.wait((e) => e.table === 'threads' && e.new?.id === t?.id);
    check('realtime: thread insert is received without uids', !!ev && !('a_uid' in ev.new) && !('b_uid' in ev.new));
    const mA = (await A.rpc('my_marks')).data;
    const mB = (await B.rpc('my_marks')).data;
    const mC = (await C.rpc('my_marks')).data;
    check('my_marks lists the thread for both ends only',
      mA.threads.includes(t?.id) && mB.threads.includes(t?.id) && !mC.threads.includes(t?.id), JSON.stringify({ mA, mB, mC }));
    const s = (await A.rpc('world_stats')).data;
    check('world_stats counts the new thread and its km',
      s.threads_total === stats0.threads_total + 1 && Math.abs(s.km_total - stats0.km_total - t.km) <= 1, JSON.stringify(s));
  }

  // ── check_in / world_stats / recent_echoes ────────────────────────────────
  {
    const bad1 = await A.rpc('check_in', { p_lat: 0, p_lon: 181, p_place: '[test] X', p_tz: 'Etc/UTC', p_zone: 1 });
    const bad2 = await A.rpc('check_in', { p_lat: 0, p_lon: 0, p_place: '[test] X', p_tz: 'Etc/UTC', p_zone: 24 });
    const bad3 = await A.rpc('check_in', { p_lat: 0, p_lon: 0, p_place: 'x'.repeat(61), p_tz: 'Etc/UTC', p_zone: 1 });
    const bad4 = await A.rpc('check_in', { p_lat: 0, p_lon: 0, p_place: 'visit example.com', p_tz: 'Etc/UTC', p_zone: 1 });
    check('check_in validates lon, zone, place length and place content',
      [bad1, bad2, bad3, bad4].every((r) => r.error?.message === 'invalid_input'), [bad1, bad2, bad3, bad4].map(msg).join(' | '));
    const r = await A.rpc('check_in', { p_lat: A_POS.lat, p_lon: A_POS.lon, p_place: A_POS.place, p_tz: A_POS.tz, p_zone: TEST_ZONE });
    check('check_in succeeds', !r.error, msg(r));
    const z = await B.from('zone_days').select('day, zone, place, lit_at').eq('day', today()).eq('zone', TEST_ZONE);
    check('check_in lights the zone for today', !z.error && z.data.length === 1 && z.data[0].place === A_POS.place, msg(z));
    const ev = await events.wait((e) => e.table === 'zone_days' && e.new?.zone === TEST_ZONE);
    check('realtime: zone_days insert is received', !!ev);
    const s = await B.rpc('world_stats');
    check('world_stats reflects the lit zone and the light',
      !s.error && s.data.zones_today.includes(TEST_ZONE) && s.data.lights_today >= 1 && s.data.lights_48h >= 1 && s.data.day === today(), msg(s));
    check('world_stats has every documented field',
      !s.error && ['threads_total', 'km_total', 'lanterns_48h', 'lights_today', 'lights_48h', 'zones_today', 'day'].every((k) => k in s.data));
    const anonStats = await anon.rpc('world_stats');
    check('world_stats is readable without a session', !anonStats.error && Array.isArray(anonStats.data.zones_today), msg(anonStats));
    const e = await B.rpc('recent_echoes');
    const row = e.data?.find((x) => x.place === A_POS.place);
    check('recent_echoes returns the echo without a uid',
      !e.error && !!row && !('uid' in row) && Object.keys(row).sort().join(',') === 'last_seen,lat,lon,place', msg(e));
  }

  await A.removeAllChannels();
  await C.removeAllChannels();

  // ── cleanup ───────────────────────────────────────────────────────────────
  if (NO_CLEANUP) {
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
    const z = await A.from('zone_days').select('zone').like('place', '[test]%');
    const t = await A.from('threads').select('id').or('a_place.like.[test]*,b_place.like.[test]*');
    const l = await A.from('lanterns').select('id, seeded');
    const m = (await A.rpc('my_marks')).data;
    const e = (await A.rpc('recent_echoes')).data;
    check('after cleanup: no test rows remain and totals are restored',
      s.threads_total === stats0.threads_total && Math.abs(s.km_total - stats0.km_total) <= 1 &&
      z.data?.length === 0 && t.data?.length === 0 && m.lanterns.length === 0 && m.threads.length === 0 &&
      !e.some((x) => x.place.startsWith('[test]')) && l.data.filter((x) => x.seeded).length === 6,
      JSON.stringify({ s, z: z.data, t: t.data, m }));
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
