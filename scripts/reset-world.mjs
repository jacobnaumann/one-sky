// Wipes everything visitors have made from the live One Sky database, so a launch starts clean.
//
//   node scripts/reset-world.mjs        print the row counts, change nothing
//   node scripts/reset-world.mjs --yes  print the counts, wipe, print the counts again
//
// Deleted: every non-seeded lantern (with its warmths and reports), all threads, waves, echoes,
// echo_waves, zone_days and rate_events. Reset: world_totals to zero; warmth and reports on the seeded welcome
// lanterns to zero; limits to their defaults. Kept: the seeded lanterns, places, auth users.
//
// Needs the Supabase CLI, logged in and linked to the project (`supabase db query --linked`).
// It uses the CLI's own login; no database password or service key is read by this script.

import { execSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YES = process.argv.includes('--yes');

function sql(text) {
  const file = join(tmpdir(), `onesky-reset-${process.pid}.sql`);
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

const COUNTS = `
  select
    (select count(*) from public.lanterns where not seeded)        as lanterns_visitor,
    (select count(*) from public.lanterns where seeded)            as lanterns_seeded,
    (select coalesce(sum(warmth), 0) from public.lanterns where seeded)  as seeded_warmth,
    (select coalesce(sum(reports), 0) from public.lanterns where seeded) as seeded_reports,
    (select count(*) from public.warmths)      as warmths,
    (select count(*) from public.reports)      as reports,
    (select count(*) from public.threads)      as threads,
    (select count(*) from public.waves)        as waves,
    (select count(*) from public.echoes)       as echoes,
    (select count(*) from public.echo_waves)   as echo_waves,
    (select count(*) from public.zone_days)    as zone_days,
    (select count(*) from public.rate_events)  as rate_events,
    (select threads_total from public.world_totals) as threads_total,
    (select round(km_total) from public.world_totals) as km_total,
    (select count(*) from public.limits where value <> def) as limits_changed,
    (select count(*) from public.places)       as places,
    (select count(*) from auth.users)          as auth_users`;

function counts() {
  const [head, row] = sql(COUNTS).replace(/\r/g, '').trim().split('\n');
  const cols = head.split(',');
  const vals = (row ?? '').split(',');
  return Object.fromEntries(cols.map((c, i) => [c, vals[i]]));
}

function show(title, c) {
  console.log(title);
  for (const [k, v] of Object.entries(c)) console.log(`  ${k.padEnd(18)} ${v}`);
}

const before = counts();
show('Before:', before);

if (!YES) {
  console.log('\nNothing was changed. Run again with --yes to wipe all visitor-generated data.');
  process.exit(0);
}

sql(`
  begin;
  delete from public.warmths;
  delete from public.reports;
  delete from public.lanterns where not seeded;
  update public.lanterns set warmth = 0, reports = 0, hidden = false, hidden_at = null where seeded;
  delete from public.threads;
  delete from public.waves;
  delete from public.echoes;
  delete from public.echo_waves;
  delete from public.zone_days;
  delete from public.rate_events;
  update public.world_totals set threads_total = 0, km_total = 0 where id;
  update public.limits set value = def where value <> def;
  commit;
`);

const after = counts();
show('\nAfter:', after);

const mustBeZero = ['lanterns_visitor', 'seeded_warmth', 'seeded_reports', 'warmths', 'reports', 'threads', 'waves',
  'echoes', 'echo_waves', 'zone_days', 'rate_events', 'threads_total', 'km_total', 'limits_changed'];
const left = mustBeZero.filter((k) => after[k] !== '0');
// A visitor with the page open can check in between the wipe and the recount; that is not a failure
// of the wipe, but it is reported.
if (left.length) console.log(`\nNOTE  not zero after the wipe (live visitors may have written since): ${left.join(', ')}`);
if (after.lanterns_seeded !== before.lanterns_seeded || +after.auth_users < +before.auth_users || after.places !== before.places) {
  console.log('\nFAIL  seeded lanterns, places or auth users changed');
  process.exit(1);
}
console.log('\nDone. Auth users, places and the seeded welcome lanterns were kept.');
