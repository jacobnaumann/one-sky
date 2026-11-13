---
tags: [one-sky, architecture]
updated: 2026-11-13
---

# Architecture

See [[index]] for state and [[operations]] for how to run it.

## Shape

```
Browser (static site on GitHub Pages)
  ├─ globe/   Three.js scene, GLSL shaders, lights, arcs, lanterns
  ├─ ui/      hand-written DOM UI (no framework)
  ├─ audio/   Web Audio generative sound
  ├─ lib/     pure functions: sun position, great-circle math, tz table, moderation, daily question
  └─ net/     Supabase client: anonymous auth, Realtime presence + broadcast, RPC calls
                    │
Supabase ───────────┘
  ├─ Auth: anonymous sign-in (stable per-visitor id, no personal data)
  ├─ Realtime channel `sky`: Presence (who is here), Broadcast (gaze, waves)
  └─ Postgres: lanterns, warmths, threads, echoes, reports, zone_days
       writes only through rate-limited security-definer functions; RLS on every table
```

## Where things live (planned)

| Path | Contents |
|---|---|
| `src/globe/` | scene, earth/atmosphere shaders, instanced lights, great-circle arcs, lanterns, ring |
| `src/net/` | supabase client, presence, broadcast, db calls |
| `src/ui/` | arrival, HUD, lantern composer/reader, toasts, postcard |
| `src/audio/` | pad, notes, chimes |
| `src/lib/` | sun, geo, tz table, moderation, questions |
| `supabase/migrations/` | schema, policies, functions |
| `tests/` | unit (Vitest) and end-to-end (Playwright) |
| `vault/` | this memory |

## Invariants — do not break

1. **No fake people.** Live lights are real presences. Echoes and seeded lanterns are labelled.
2. **No precise location.** Position = time-zone centre or a city the visitor chose. No IP lookup, no GPS.
3. **No direct table writes from the client.** All writes go through rate-limited functions.
4. **No secrets in the repo or vault.** Only the public anon key ships to the client.
5. **The page must work with the backend down** — the globe, sun and sound still run; social features say they are offline.
6. **Free-text is only lanterns**, capped at 140 chars, links stripped, filtered client-side and in the database.

## Decisions

- 2026-11-13 — GitHub Pages + Supabase, because those are the only two services this machine is signed in to.
- 2026-11-13 — Location from the browser's IANA time zone rather than IP or GPS: no prompt, no third-party call, coarse by construction.
- 2026-11-13 — No UI framework; the globe is the interface and the DOM layer is small.
- 2026-11-13 — npm rather than pnpm: the project sits in a OneDrive folder and pnpm's symlinked store is unreliable there.
