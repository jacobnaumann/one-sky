# One Sky — instructions for every session

One Sky is a real-time 3D Earth where every person with the page open is a light where they are.
Static front end (Vite + TypeScript + Three.js) on GitHub Pages; Supabase for realtime and storage.

## Before doing anything

1. Read `vault/index.md`.
2. Read the newest file in `vault/log/`.

## After every task or major file change

1. Append a log entry to `vault/log/YYYY-MM-DD.md` (today, UTC) in this format:

   ```
   ## HH:MM UTC: title
   - **What:** …
   - **Why:** …
   - **Decisions:** …
   - **Verified:** …
   - **Commit:** …
   ```

2. Update **Current state** and **Open items** in `vault/index.md`; add new log files to the Log index (newest first).
3. Record architectural decisions in the log entry **and** update `vault/architecture.md`.
4. Update `vault/operations.md` whenever how the project is run, tested or deployed changes.
5. Commit vault changes together with the work they describe.

## Rules

- Never write secrets into the vault, the repo, or a commit. Say where a secret lives, never its value.
  The Supabase anon key is public by design and may appear in client config; the service-role key and
  database password may not appear anywhere tracked.
- No fake users. Anything on the globe that is not a live person must be labelled as what it is.
- No precise location. A light sits at a city: the visitor's time-zone city by default, a city they pick, or (only if they press "Use my location") the city nearest the position their browser reports. That position is used once on the device to choose the city and is never stored or sent.
- Report test results as they are, including failures and things not tested.
