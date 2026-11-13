---
tags: [one-sky, index]
updated: 2026-11-13
---

# One Sky — vault index

A real-time 3D Earth, lit by the actual sun, where every person with the page open is a light where
they are. People wave to each other across the planet, release lanterns answering one daily question,
and together try to light all 24 time zones in a day.

## Current state

- 2026-11-13 07:40 UTC — **Live** at https://jacobnaumann.github.io/one-sky/ (repo `jacobnaumann/one-sky`, Supabase `evktxfawnualbbmoujip`).
- Working and tested on production: presence, gaze, waves, threads, ripples, lanterns (release/warm/report/translate), 24-zone ring, echoes, drift, postcard, move-my-light, sound engine (levels measured, never listened to).
- Backend hardened after a security review; visitor data reset to the 6 seeded lanterns.
- In progress: design critique and client bug hunt by independent reviewers.

## Open items

- [x] Scaffold, globe, backend, presence/waves/threads, lanterns, ring, sound, arrival, postcard, mobile
- [x] Deploy to GitHub Pages; multi-visitor tests on production
- [x] Security review and fixes
- [ ] Act on the design critique
- [ ] Act on the client bug hunt
- [ ] Act on the measured-audio report
- [ ] Final reset of test data, final deploy, hand-off summary
- [ ] After the demo: consider lowering the anonymous sign-in limit back to 30/hour (`supabase/config.toml`)
- [ ] Someone with speakers should listen to the sound once

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
