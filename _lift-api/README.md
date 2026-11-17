# Lift — workout tracker at kevintracy.info/lift

A deliberately minimal, Hevy-style lifting log. Each signed-in person has their own routines
(e.g. Mon/Tue/Wed/Fri). Starting a routine shows every exercise with last time's numbers
pre-filled; you confirm each set with ✓ (or change the numbers first) and tap Finish.

- **Live page:** https://kevintracy.info/lift/ (GitHub Pages, `main` branch of this repo)
- **API:** https://lift-api.kevt-laser.workers.dev (Cloudflare Worker + D1 SQLite)
- **Sign-in:** Google Identity Services, restricted to emails in the `users` table

> This repo is **public**. Never commit email addresses, tokens or secrets. The Google
> Client ID and the Worker URL are public by design.

---

## 1. Architecture

```
 phone / laptop browser                         Cloudflare                      Google
┌──────────────────────────┐   fetch + Bearer  ┌───────────────────────┐
│ lift/index.html          │ ────────────────▶ │ Worker  lift-api      │
│  one file, no build step │                   │  _lift-api/worker.js  │
│  localStorage cache      │ ◀──────────────── │                       │
│  outbox of unsynced sets │       JSON        │  D1 database "lift"   │
└──────────┬───────────────┘                   │  users / routines /   │
           │ "Sign in with Google" (GIS)        │  sets / sessions      │
           ▼                                    └──────────┬────────────┘
   accounts.google.com ── ID token ──▶ page ──▶ POST /login │ tokeninfo check
                                                            └──────────────▶ oauth2.googleapis.com
```

- **Static page** (`lift/index.html`): HTML + CSS + vanilla JS in one file (~370 lines). No
  framework, bundler or dependencies. Google's sign-in script is loaded only on the sign-in screen.
- **Worker** (`_lift-api/worker.js`): ~110 lines, no dependencies. All auth and per-user
  isolation is enforced here; the page is never trusted.
- **Database:** Cloudflare D1 (SQLite), database name `lift`, binding `env.DB`.

### Why `_lift-api/` is safe in a public Pages repo
GitHub Pages builds this repo with Jekyll (there is no `.nojekyll`), and Jekyll skips folders
starting with `_`. So `kevintracy.info/_lift-api/...` returns 404. **Don't add a `.nojekyll`
file**, or this folder (including this README) would start being published.

---

## 2. Files

| Path | What it is |
|---|---|
| `lift/index.html` | The whole front end. Styles at the top, one `<script>` at the bottom. |
| `_lift-api/worker.js` | Cloudflare Worker: auth, CORS and every endpoint. |
| `_lift-api/wrangler.jsonc` | Worker config: name, D1 binding, public vars (`GOOGLE_CLIENT_ID`, `ALLOWED_ORIGINS`). |
| `_lift-api/schema.sql` | Current schema (v2, multi-user). Use it for a fresh database. |
| `_lift-api/seed.sql` | The owner's four original routines, as `uid = 1`. |
| `_lift-api/migrate-v2.sql` | One-off migration from single-user v1 to multi-user v2. Already applied to prod; kept for history. |
| `_lift-api/.gitignore` | Ignores `.dev.vars` and `.wrangler/` (local D1 state). |
| `_lift-api/.dev.vars` | *(not committed)* Local-only secrets for `wrangler dev`, e.g. `ALLOWED_EMAIL=owner@example.com`. |

Database backups are kept **outside** the repo in `~/devel/lift-backups/`.

---

## 3. Data model (D1)

```sql
users    (id INTEGER PK AUTOINCREMENT, email TEXT UNIQUE /* lowercase */, name TEXT /* from Google */, created TEXT)
routines (uid, id TEXT, pos INT, day TEXT, name TEXT, sub TEXT, ex TEXT /* JSON */,      PRIMARY KEY (uid, id))
sets     (uid, wid TEXT, d TEXT, r TEXT, ex TEXT, s INT, w REAL, reps INT, t INT, skip INT, PRIMARY KEY (uid, wid, ex, s))
sessions (hash TEXT PK /* sha256 of device token */, uid INT, created TEXT)
```

- **`routines.ex`** is a JSON array: `[{name, kind: "wr"|"time", sets, reps: "6-8", w}]`.
  `reps` is a string so ranges work. `w` is the default weight used only when there is no
  history yet; `0` means bodyweight. Timed exercises (`kind: "time"`) log seconds in `sets.t`.
- **`routines.day`** is `""` or a weekday name. `sub` is the optional "Focus" text.
- **`sets`** has one row per set. `wid` is a workout id (a UUID made on the phone at Start),
  `d` the local date `YYYY-MM-DD`, `r` the routine id, `ex` the exercise **name**, `s` the
  1-based set number. Skipped or unchecked sets are stored with `skip = 1`.
- **Idempotency:** the primary key `(uid, wid, ex, s)` plus `INSERT OR IGNORE` means a retried
  sync never duplicates sets.
- **"Previous" values are matched by exercise name** across all of a user's routines (Lateral
  Delt Raises on Friday shows Monday's numbers). Renaming an exercise starts a fresh history.
- **The owner is `users.id = 1`.** The Worker secret `ALLOWED_EMAIL` holds the owner's email.
  It is used only to pick whose routines a new user copies on first sign-in. Being allowed to
  sign in is decided by the `users` table.

---

## 4. API

Every route except `/login` needs `Authorization: Bearer <device token>`.

| Method & path | Body / query | Returns | Notes |
|---|---|---|---|
| `POST /login` | `{credential}` (Google ID token) | `{token}` | Verifies via Google's `tokeninfo` endpoint: `aud` must equal `GOOGLE_CLIENT_ID`, the email must be verified and not expired, and it must be in `users`. Then updates `users.name`, creates a session, and copies the owner's routines if the user has none. |
| `POST /logout` | | `{ok}` | Deletes this device's session. |
| `GET /me` | | `{id, name}` | |
| `GET /users` | | `[{id, name}]` | Users who have signed in at least once (`name <> ''`). Used for "Other lifters". |
| `GET /data` | `?u=<id>` optional | `{routines, sets}` | Your own data, or another user's when `u` is given (read-only by construction: no write route takes a uid). |
| `POST /sets` | `{rows:[…]}` (≤500) | `{ok, n}` | Always writes as the caller's uid. |
| `PUT /routines` | `{routines:[…]}` (≤30) | `{ok}` | **Replaces all** of the caller's routines in one transaction (handles add, rename, delete and reorder). Inputs are clamped: names ≤60 chars, ≤40 exercises, sets 1–20. |

- **CORS:** only origins listed in `ALLOWED_ORIGINS` (`https://kevintracy.info,http://localhost:8765`)
  get CORS headers. Add an origin there if the page is ever served elsewhere.
- **Errors:** `401 {"error":"auth"}` means a missing or expired session; the page drops its token
  and shows sign-in. `403 {"error":"not allowed"}` means a bad Google token or an email not on the list.
- **Device tokens** never expire on their own. They end only on Sign out or when deleted from `sessions`.

---

## 5. Front end (`lift/index.html`)

### Screens (hash routes)
| Route | View | Notes |
|---|---|---|
| *(no token)* | `signin` | Only Google's button. Nothing is visible signed out. |
| `#/` | `home` | Routine cards, "In progress" banner, **+ Add routine**, **Other lifters**, Sign out. |
| `#/r/<id>` | `routine` | Exercises with `last: …` values; **Edit** and **Start**/**Resume**. |
| `#/r/<id>/edit` | `edit` | Name/Day/Focus, then per exercise: name, Type (Weight/Time), Sets, Reps, lbs, ↑, ✕. **+ Add exercise**, **Delete routine**, **Save**. Changes live in `draft` until Save. |
| `#/w` | `workout` | The active workout. Columns: Set, Previous, lbs, Reps, ✓. Skip per exercise, Discard, Finish. |
| `#/u/<uid>` | `other` | Someone else's routines (read-only, fetched on demand into the `others` cache). |
| `#/u/<uid>/r/<id>` | `other` | Someone else's routine with their `last: …` values. |

Rendering is plain `innerHTML` from template strings. Events are handled by delegated
`click`/`input` listeners keyed on `data-a` (action), `data-f` (exercise field), `data-rf`
(routine field), `data-i` (exercise index) and `data-j` (set index).

### localStorage keys (all prefixed `lift.`)
| Key | Contents |
|---|---|
| `lift.v` | Cache format version (currently `3`). Bumping it clears old caches on load (see the top of the script). |
| `lift.token` | Device session token from `/login`. |
| `lift.routines`, `lift.log` | Cached copies of your routines and sets, so the page draws instantly and works offline. |
| `lift.active` | The in-progress workout. Saved on **every keystroke and ✓**, so reloading or closing the tab loses nothing. |
| `lift.outbox` | Finished-workout set rows not yet confirmed by the API. |
| `lift.dirty` | Set when routines were edited locally but not yet `PUT` to the API. |
| `lift.me`, `lift.users` | Who you are, and the list of other lifters. |

### Sync (`sync()`)
Runs on load, after Finish or Save, and on the browser's `online` event:
1. `POST /sets` with the outbox, and remove those rows only after success.
2. `PUT /routines` if `dirty`.
3. Fetch `/data`, `/me` and `/users` in parallel and refresh the caches. `log` is the server's
   sets plus anything still in the outbox.
4. Re-render, **unless an input or select has focus** (so typing is never interrupted).

Sign out warns if the outbox isn't empty, then clears every `lift.*` key except `lift.v`.

### Workout logic
- **Start** builds `lift.active` from the routine. Each set is pre-filled from the most recent
  non-skipped session of that exercise name (`previous()`), falling back to the routine's
  default weight and the low end of the rep range.
- **Finish** asks once if some sets are unchecked (those are logged as `skip`), appends the rows
  to `log` and the outbox, and syncs.

---

## 6. Local development

Prerequisites: Node **22.12+** (wrangler refuses older; the owner's Mac has Homebrew Node 26),
and `wrangler` installed globally. With npm 12+, install wrangler with its dependencies' setup
scripts allowed, or local dev breaks:
```bash
npm install -g --allow-scripts=esbuild,workerd wrangler
```

Run two servers:
```bash
# page, served from the repo root, at http://localhost:8765/lift/
cd ~/devel/kevin-tracy.github.io && python3 -m http.server 8765
```
```bash
# API with a local SQLite copy at http://127.0.0.1:8787
cd ~/devel/kevin-tracy.github.io/_lift-api && wrangler dev --port 8787 --ip 127.0.0.1
```
The page picks its API by hostname: `localhost` → `http://127.0.0.1:8787`, anything else →
the production Worker. **Use `localhost`, not `127.0.0.1`, for the page**, or it will talk to
production.

Fresh local database:
```bash
cd _lift-api
wrangler d1 execute lift --local --file=schema.sql
wrangler d1 execute lift --local --command "INSERT INTO users (id,email,name,created) VALUES (1,'owner@example.com','Owner',datetime())"
wrangler d1 execute lift --local --file=seed.sql
printf 'ALLOWED_EMAIL=owner@example.com\n' > .dev.vars
```

**Signing in locally without Google.** Insert a session for a made-up token, then put that token
in the page's localStorage:
```bash
H=$(printf 'local-test-token' | shasum -a 256 | cut -d' ' -f1)
wrangler d1 execute lift --local --command "INSERT INTO sessions (hash,uid,created) VALUES ('$H',1,'test')"
```
```js
// in the browser console on http://localhost:8765/lift/
localStorage['lift.token'] = JSON.stringify('local-test-token'); location.reload();
```
Add a second user (`id 2`) with its own token the same way to test isolation and "Other lifters".
The real Google button also renders on `http://localhost:8765`, because that origin is authorized.

---

## 7. Deploying

**Worker / API:**
```bash
cd ~/devel/kevin-tracy.github.io/_lift-api && wrangler deploy
```

**Page:** commit and push to `main`. GitHub Pages usually serves it within about 60 seconds.
```bash
git push origin main
```
To confirm it's live, check for a string from your change:
```bash
curl -s https://kevintracy.info/lift/ | grep -c 'some string from your change'
```

**Order matters for breaking changes:** migrate the database, deploy the Worker, then push the
page. Phones keep cached data and may run an old page for a while, so keep the API
backward-compatible where you can.

---

## 8. Operations

All of these run from `_lift-api/` against production (`--remote`).

**Add a person** (both steps are needed):
1. Google Cloud Console → project **lift** → **Google Auth Platform → Audience → Test users** → add
   their Gmail. The OAuth app is in *Testing* mode (max 100 test users). Publishing it would
   require Google's branding review.
2. Add them to the allowed list:
   ```bash
   wrangler d1 execute lift --remote --command "INSERT INTO users (email, created) VALUES ('someone@gmail.com', datetime())"
   ```
   Their `name` fills in from Google on first sign-in. Until then they don't appear under "Other lifters".

**Remove a person / revoke their devices:**
```bash
wrangler d1 execute lift --remote --command "DELETE FROM sessions WHERE uid=(SELECT id FROM users WHERE email='someone@gmail.com')"
wrangler d1 execute lift --remote --command "DELETE FROM users WHERE email='someone@gmail.com'"   # their routines/sets remain unless deleted too
```

**Look at data:**
```bash
wrangler d1 execute lift --remote --command "SELECT id, name FROM users"
wrangler d1 execute lift --remote --command "SELECT d, ex, s, w, reps FROM sets WHERE uid=1 ORDER BY d DESC LIMIT 30"
```

**Back up** (do this before any migration):
```bash
wrangler d1 export lift --remote --output ~/devel/lift-backups/lift-$(date +%Y%m%d-%H%M).sql
```
D1 also has built-in point-in-time recovery: `wrangler d1 time-travel --help`.

**Secrets:** `wrangler secret put ALLOWED_EMAIL` sets the owner email that new users copy
routines from. It isn't stored in the repo.

**Schema changes:** SQLite can't alter primary keys, so do it the way `migrate-v2.sql` does:
create `table2`, copy the rows, drop the old table, rename. Test against the local database first.
It still holds realistic data if you haven't wiped `.wrangler/`.

---

## 9. External accounts & config

| Thing | Where | Value / note |
|---|---|---|
| Google OAuth client | Google Cloud project **lift** → Clients → "lift web" | Client ID `634279737389-s25tjhmhkc3ncs3uddvd309gat185016.apps.googleusercontent.com` (public; it's in the page). The client secret is **not used**; don't add it anywhere. |
| Authorized JS origins | same client | `https://kevintracy.info`, `http://localhost:8765`, `http://localhost`. Add an origin here (and to `ALLOWED_ORIGINS`) if the page moves. Changes can take minutes to apply. |
| Consent screen | Google Auth Platform | App name "Lift", **Testing** status, no logo (a logo triggers verification). |
| Cloudflare | owner's account, workers.dev subdomain `kevt-laser` | Worker `lift-api`, D1 database `lift` (id in `wrangler.jsonc`). `wrangler login` is done on the owner's Mac. |
| Domain | `CNAME` → `kevintracy.info` | Served by GitHub Pages, not Cloudflare. |

---

## 10. Product decisions (the owner's preferences — keep them)

- **As simple and fast as possible:** one HTML file, no framework, no build, no runtime
  dependencies. Load third-party scripts only when needed.
- **Phone first,** but it must look fine on desktop (single centered column, max 560px). Dark theme.
- **Logging = weight × reps only**, or seconds for timed exercises. No RPE, notes, rest timer or
  workout clock.
- **The target line shows only sets × reps** (e.g. `3 × 6-8`). No weight there, and no
  coaching/rest notes anywhere (both were removed at the owner's request).
- **Pre-fill from last time;** ✓ confirms the set. Edit the number first if it changed.
- **Skip is per exercise.** No adding or swapping exercises mid-workout.
- **Confirmations ask once,** never twice (Discard, Delete routine, Remove exercise, Finish with
  unchecked sets, Sign out with unsynced sets).
- **No highlighting of "today's" routine.**
- **Nothing is public;** sign-in comes first. Signed-in users can view each other read-only.
- **New users start with a copy of the owner's routines.**
- **Deferred:** history graphs. When added, they should use **Plotly**, loaded lazily (e.g. the
  `plotly-basic` dist), only on a history screen.

---

## 11. Gotchas

- **Don't serve the page from `127.0.0.1`.** It would use the production API (the switch is on `hostname === "localhost"`).
- **`crypto.randomUUID()` needs a secure context.** `https` and `localhost` are fine; a LAN IP over plain http is not.
- **Testing on a real phone against a local API** won't work as-is (the page points at the production API for any non-localhost host). Test on the deployed site, or temporarily change `API`.
- **Bump `lift.v` when the cache format changes.** Right now that wipes caches only when signed out. Read the line at the top of the script before changing it, so you don't silently drop someone's unsynced outbox.
- **Exercise renames split history** (see the data model). A future "rename" feature should also `UPDATE sets SET ex=…`.
- **`PUT /routines` replaces everything.** Always send the full list.
- **Keep emails and secrets out of committed files.** The repo is public; insert users via `wrangler d1 execute`, never in a committed `.sql` file.
- **History of this project:** prototype with a mock backend (fake data) → single-user D1 + Google sign-in with public read → multi-user (current). `migrate-v2.sql` is the v1→v2 step.
