---
tags: [one-sky, operations]
updated: 2026-11-13
---

# Operations

See [[index]] and [[architecture]].

## Run

Not scaffolded yet. Planned: `npm install`, `npm run dev`.

## Test

Planned: `npm test` (Vitest unit tests), `npm run e2e` (Playwright, multiple browser contexts).

## Deploy

Planned: push to `main` → GitHub Actions builds → GitHub Pages.

## Config and secrets (locations only, never values)

| Thing | Where it lives |
|---|---|
| Supabase URL + anon key (public) | `src/net/config.ts` (to be created) |
| Supabase DB password | `.secrets/` in the project root, git-ignored, local only |
| Supabase service-role key | never stored; fetch from the Supabase dashboard / CLI when needed |
| GitHub auth | `gh` keyring on this machine |
