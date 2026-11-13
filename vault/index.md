---
tags: [one-sky, index]
updated: 2026-11-13
---

# One Sky — vault index

A real-time 3D Earth, lit by the actual sun, where every person with the page open is a light where
they are. People wave to each other across the planet, release lanterns answering one daily question,
and together try to light all 24 time zones in a day.

## Current state

- 2026-11-13 17:15 UTC — **Live and finished for hand-off** at https://jacobnaumann.github.io/one-sky/ (repo `jacobnaumann/one-sky`, Supabase `evktxfawnualbbmoujip`).
- Features: live Earth with real sun; presence, gaze, waves, threads, ripples; lanterns (release, warm, report, translate); 24-zone ring; echoes and echo waves; Drift; watch a day pass; postcard; move my light; generative sound.
- Reviewed and acted on: two security reviews, two bug/regression hunts, a design critique, two first-time-visitor passes, measured audio levels.
- Tests: unit 127; live database 192; multi-visitor browser tests 4, passing on production in Chromium, Firefox and WebKit.
- Live database holds only the 6 welcome lanterns (test data reset).

## Open items

- [ ] Someone with speakers should listen to the sound once (samples: `node scripts/audio-qa.mjs --wav`)
- [ ] Try it on a real iPhone and a real Android phone
- [ ] After the demo: put `anonymous_users` back to 30 in `supabase/config.toml` and push; consider Turnstile captcha
- [ ] Clean dead/overridden CSS in `src/styles.css` (list in the 17:15 log entry's regression report)
- [ ] Larger fixes noted under Known limits in [[architecture]]: database-backed roster instead of trusting presence keys; `my_marks()` returning the other party's uid
- [ ] `places` table must be regenerated in a migration if `scripts/gen-tz.py` regenerates `tzdata.ts`
- [ ] The Supabase free project pauses after about a week without use

## Map

- [[architecture]] — how the system fits together, where things live, invariants
- [[operations]] — run, test, deploy; where config and secrets live
- [[log/2026-11-13]] — build day one

## Log index

- [[log/2026-11-13]]

## How to keep this vault

- Read this file and the newest log before starting work.
- One log file per working day (UTC): `vault/log/YYYY-MM-DD.md`.
- Entry format:

  ```
  ## HH:MM UTC: title
  - **What:** what changed
  - **Why:** the reason
  - **Decisions:** choices made, including guesses made without the owner
  - **Verified:** what was actually run or checked, and the result
  - **Commit:** hash or "none"
  ```

- After each task: append an entry, update Current state and Open items here.
- Architectural decisions also go into [[architecture]]; changes to running/deploying go into [[operations]].
- Never write secret values anywhere in the vault.
- Commit vault changes with the work.
