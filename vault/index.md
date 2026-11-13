---
tags: [one-sky, index]
updated: 2026-11-13
---

# One Sky — vault index

A real-time 3D Earth, lit by the actual sun, where every person with the page open is a light where
they are. People wave to each other across the planet, release lanterns answering one daily question,
and together try to light all 24 time zones in a day.

## Current state

- 2026-11-13 06:20 UTC — Plan approved. Vault and `CLAUDE.md` created. No code yet.
- Not deployed.

## Open items

- [ ] Scaffold Vite + TypeScript + Three.js project, git init
- [ ] The Earth: day/night shader from real sun position, city lights, atmosphere, stars, camera
- [ ] Supabase project, schema, RLS, rate-limited functions
- [ ] Presence, gaze, waves, threads
- [ ] Lanterns, daily question, warmth, translation
- [ ] Daily ring (24 time zones), world stats, echoes
- [ ] Sound, arrival sequence, postcard
- [ ] Mobile layout, reduced motion, fallbacks
- [ ] Deploy to GitHub Pages
- [ ] Multi-client tests against production
- [ ] Independent reviews (design, security, code) and fixes
- [ ] README, final hand-off

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
