---
tags: [one-sky, architecture]
updated: 2026-11-13
---

# Architecture

See [[index]] for state and [[operations]] for how to run it.

## Shape

```
Browser (static site on GitHub Pages)
  ├─ globe/   Three.js scene + GLSL (Earth, atmosphere, stars, points, arcs, ring, ripples)
  ├─ ui/      hand-written DOM helpers (no framework), postcard composer
  ├─ audio/   Web Audio generative sound
  ├─ lib/     pure functions: sun, geo, tz table, time, questions, moderation
  ├─ net/     Supabase client: anonymous auth, Realtime presence + broadcast, RPC calls
  └─ main.ts  orchestration: state, cards, toasts, feed, arrival, ring, drift
                    │
Supabase project evktxfawnualbbmoujip (us-east-1)
  ├─ Auth: anonymous sign-in only
  ├─ Realtime channel `sky` (public): Presence = who is here; Broadcast = gaze, wave, ripple, lantern_hidden
  │    + postgres_changes on lanterns, threads, zone_days
  └─ Postgres: lanterns, warmths, reports, waves, threads, echoes, echo_waves, zone_days, rate_events, world_totals, places, limits
       RLS on every table; writes only through rate-limited SECURITY DEFINER functions
```

## Where things live

| Path | Contents |
|---|---|
| `index.html` | all static markup, CSP meta tag, OG tags |
| `src/main.ts` | app state and every interaction; exposes `window.__onesky` for tests |
| `src/globe/globe.ts` | `Globe` class: scene, camera/orbit controls, picking, `wave()`, `addThread()`, `ripple()`, `setRing()`, `flyTo()`, adaptive quality |
| `src/globe/shaders.ts` | all GLSL |
| `src/net/sky.ts` | `Sky` class: connect, presence validation, broadcasts, RPC wrappers |
| `src/net/config.ts` | Supabase URL + public anon key |
| `src/audio/engine.ts` | `AudioEngine`: bed, twinkles, event sounds; D major pentatonic |
| `src/lib/tz.ts`, `tzdata.ts` | 418 places (IANA zone → city, country, lat/lon); `placeForTimeZone`, `placeByTz`, `jitter` |
| `src/lib/sun.ts` | subsolar point, sun direction, solar elevation, sky state |
| `src/lib/geo.ts` | lat/lon ↔ vec3 (matches Three sphere UVs), great-circle distance and arcs |
| `src/lib/questions.ts` | 70 daily questions, chosen by UTC day |
| `src/lib/moderation.ts` | client-side lantern text filter (server repeats it) |
| `src/ui/dom.ts` | `h()`, `rich()`, modal, toast, feed, count-up |
| `src/ui/postcard.ts` | canvas-composed share image |
| `supabase/migrations/` | schema, policies, functions, hardening |
| `tests/unit/` | Vitest |
| `tests/e2e/sky.spec.ts` | Playwright, multiple visitors in separate contexts/time zones |
| `tests/db/rls.test.mjs` | live database policy + RPC checks |
| `scripts/` | `gen-tz.py`, `shots.mjs` / `shot-one.mjs` (visual QA), `og.mjs`, `audio-qa.mjs`, `reset-world.mjs` |

## How the main flows work

- **Arrival:** `boot()` builds the globe and connects as a *watcher* (subscribed, not tracked). "Step into the sky" → `enter()` starts audio, flies the camera to the visitor's place, then `sky.appear(me)` tracks presence and calls `check_in` (which lights the visitor's zone for the UTC day).
- **Place:** `Intl…timeZone` → `placeForTimeZone` → city centre + deterministic per-browser jitter (≤0.6°). Stored override in `localStorage['onesky.tz']`.
- **Wave:** broadcast `{from,to}` (ids only) + RPC `send_wave`. Receivers resolve both ends from presence. A reverse wave within 10 minutes makes the RPC insert a `threads` row; everyone learns of it from postgres_changes. A client decides a thread is "mine" by asking `my_marks()`.
- **Lantern:** RPC `release_lantern` → row → postgres_changes INSERT to everyone. Warmth via `warm_lantern` (UPDATE event). Three reports hide it; `lantern_hidden` broadcast is a hint the client confirms by re-selecting.
- **Ring:** `zone_days(day, zone)`; first check-in from a zone inserts the row; clients render 24 segments.
- **Echo wave:** `recent_echoes()` returns an opaque `eid` per echo (never the uid). `wave_echo(eid, …)` stores one pending wave per sender per recipient; `collect_echo_waves()` returns and deletes the caller's pending waves on arrival.
- **Ripple:** broadcast `{from}` only; the shader draws up to 6 concurrent rings from uniforms `uRipO/uRipT`.

## Invariants — do not break

1. **No fake people.** Live lights are real presences. Echoes and seeded lanterns are labelled.
2. **No precise location.** Position = time-zone city + small jitter, or a city the visitor chose. No IP lookup, no GPS.
3. **No direct table writes from the client.** All writes go through rate-limited functions.
4. **Never `select *`** on `lanterns` or `threads`: uid columns are not granted; list columns (`LANTERN_COLS`, `THREAD_COLS` in `sky.ts`).
5. **Never trust realtime payload content.** Presence and broadcasts can be sent by anyone with the public key. Read only ids from them; names and positions come from our own tz table (presence) or the database. Remote text reaches the DOM only as text nodes (`h()` children, `rich()`, `textContent`) — never `innerHTML`.
6. **No secrets in the repo or vault.** Only the public anon key ships to the client.
7. **The page must work with the backend down** — globe, sun and sound still run; social features say they are offline.
8. **Free-text is only lanterns**, 140 chars, filtered on the client and again in the database.
9. `latLonToVec3` convention (lon 0 → +x, lon 90°E → −z) must match the equirectangular textures; do not change one without the other.

## Known limits (accepted, documented)

From two security reviews. None leaks data or lets anyone put free text in front of others; all are nuisance or fairness limits of an anonymous, account-less design.

- **Presence keys are client-chosen and are the anonymous auth uids.** Anyone on the public channel can see them, can follow one light across a session, and can track a second presence under someone else's key (which may displace that person's shown city among the 418 allowed places). A real fix is a database-backed roster with presence only as a liveness hint.
- **People are matched by position in a few places** (`syncThreaded`, thread ownership, echo-wave "Wave back"). A fake presence parked on someone's coordinates is treated as that person. Fix: have `my_marks()` return the other party's uid.
- **Realtime quotas.** Anyone can hold sockets open or burn the message rate; real visitors then see "out of reach". The globe keeps working offline.
- **Gaze and ripple broadcasts can be spoofed** for ids that are present; bounded (one gaze marker per id; ripples: 15 s per sender, one per 2.5 s and six per 30 s overall).
- **Waves to me are confirmed against the database** (`my_wavers()`) before a banner or sound, so they cannot be forged by broadcast; third-party wave arcs are decoration only and are budgeted (10 per 10 s).
- **No captcha on anonymous sign-in** (150 per hour per IP for the demo; put it back to 30 afterwards). Throwaway identities can inflate warmth and stats, close the ring (8 identities), and push against the global ceilings. The ceilings are tiered so first-time visitors still get through.
- **Echo handles (`eid`)** are public pseudonyms; they rotate after 30 minutes away and `last_seen` is rounded to 10 minutes.
- **A word blocklist is always bypassable;** reports (three hide a lantern) are the backstop.
- **No `frame-ancestors`** (cannot be set from a meta tag on GitHub Pages); a framed page could only enter, wave or ripple.
- **`'self'` in the CSP and `localStorage` are shared with any other site on `jacobnaumann.github.io`.**

## Decisions

- 2026-11-13 — GitHub Pages + Supabase, because those are the only two services this machine is signed in to.
- 2026-11-13 — Location from the browser's IANA time zone rather than IP or GPS: no prompt, no third-party call, coarse by construction.
- 2026-11-13 — No UI framework; the globe is the interface and the DOM layer is small.
- 2026-11-13 — npm rather than pnpm: the project sits in a OneDrive folder and pnpm's symlinked store is unreliable there.
- 2026-11-13 — Column-level grants instead of owner tables to hide uids; verified to work with postgres_changes.
- 2026-11-13 — After a security review: stopped trusting broadcast/presence content (see invariant 5); removed the `thread` broadcast entirely; server validates places against a `places` table and computes zones itself.
- 2026-11-13 — Anonymous sign-in rate limit raised 30 → 150 per hour per IP so a room of people on one network can all join. Consider lowering after the demo.
- 2026-11-13 — Commits use the GitHub no-reply address so the owner's personal email is not published in a public repo.
- 2026-11-13 — Adaptive quality: if average frame time exceeds ~37 ms the globe lowers resolution, then drops bloom. `?hq` pins full quality (used by screenshot scripts); `?low` forces the low tier.
