---
tags: [one-sky, operations]
updated: 2026-11-13
---

# Operations

See [[index]] and [[architecture]].

## Live

- Site: https://jacobnaumann.github.io/one-sky/
- Repo: https://github.com/jacobnaumann/one-sky (public)
- Supabase project: `one-sky`, ref `evktxfawnualbbmoujip`, region us-east-1, in the TroveCircle organisation. (The separate TroveCircle project is unrelated and must not be touched.)

## Run

```bash
npm install
npm run dev          # http://localhost:5173 (talks to the live Supabase project)
```

URL flags: `?low` forces the low-power renderer, `?hq` pins full quality.

## Test

```bash
npx tsc --noEmit                 # types
npm test                         # Vitest unit tests (tests/unit)
npm run e2e                      # Playwright multi-visitor tests against the dev server (must be running)
ONE_SKY_URL=https://jacobnaumann.github.io/one-sky/ npm run e2e   # same tests against production
npx playwright test -c playwright.browsers.config.ts   # same e2e tests in Firefox and WebKit
node scripts/perf.mjs            # real-GPU frame times at several sizes
node tests/db/rls.test.mjs       # live database policy/RPC checks (needs supabase CLI logged in + linked)
node scripts/shots.mjs [url]     # visual QA: four visitors, screenshots into test-results/shots
node scripts/audio-qa.mjs        # measures the sound engine's real output levels
```

The e2e and db tests write real rows to the live database (bodies prefixed `[test]`). After running them:

```bash
node scripts/reset-world.mjs --yes   # wipes ALL visitor data (keeps the 6 seeded lanterns). Destructive: only before launch or after tests.
```

Playwright needs its browser once: `npx playwright install chromium`.

## Deploy

- Front end: push to `main` → `.github/workflows/deploy.yml` runs unit tests, builds, publishes to GitHub Pages. Watch with `gh run watch`.
- Database: add a file in `supabase/migrations/`, then `supabase db push` (project is linked; password via `SUPABASE_DB_PASSWORD` or `--password "$(cat .secrets/db-password.txt)"`).
- Auth settings: edit `supabase/config.toml`, then `supabase config push --project-ref evktxfawnualbbmoujip`. **It applies immediately without confirmation.** It currently ends with an unrelated Storage read error after Auth has been applied; re-run and look for "Remote Auth config is up to date".
- If the database function signatures change, deploy the database first, then the client.

## Moderation runbook

- Un-hide a lantern wrongly reported: `update lanterns set hidden=false, reports=0 where id='…'; delete from reports where lantern_id='…';` (via `supabase db query --linked`).
- Remove a lantern: `delete from lanterns where id='…';`
- Free tier: the project pauses after about a week without activity; restore it from the Supabase dashboard.

## Config and secrets (locations only, never values)

| Thing | Where it lives |
|---|---|
| Supabase URL + anon key (public) | `src/net/config.ts` |
| Supabase DB password | `.secrets/db-password.txt`, git-ignored, local only |
| Cached test-user sessions for the db test | `.secrets/test-sessions.json`, git-ignored |
| Supabase service-role key | never stored; Supabase dashboard if ever needed |
| Supabase CLI login | CLI keyring on this machine |
| GitHub auth | `gh` keyring on this machine |
