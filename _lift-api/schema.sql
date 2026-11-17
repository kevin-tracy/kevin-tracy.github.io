-- users: only emails listed here can sign in. Add one with:
--   wrangler d1 execute lift --remote --command "INSERT INTO users (email, created) VALUES ('someone@gmail.com', datetime())"
CREATE TABLE IF NOT EXISTS users (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  email   TEXT UNIQUE NOT NULL,    -- lowercase
  name    TEXT NOT NULL DEFAULT '',-- filled from Google on sign-in
  created TEXT NOT NULL
);

-- routines: one row per routine per user, exercises stored as a JSON array
CREATE TABLE IF NOT EXISTS routines (
  uid  INTEGER NOT NULL,
  id   TEXT NOT NULL,
  pos  INTEGER NOT NULL,
  day  TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  sub  TEXT NOT NULL DEFAULT '',
  ex   TEXT NOT NULL,              -- [{name, kind:"wr"|"time", sets, reps, w}]
  PRIMARY KEY (uid, id)
);

-- sets: one row per logged set. (uid, wid, ex, s) is unique so retried syncs never duplicate.
CREATE TABLE IF NOT EXISTS sets (
  uid  INTEGER NOT NULL,
  wid  TEXT NOT NULL,              -- workout id (generated on the phone when the workout starts)
  d    TEXT NOT NULL,              -- YYYY-MM-DD
  r    TEXT NOT NULL,              -- routine id
  ex   TEXT NOT NULL,              -- exercise name
  s    INTEGER NOT NULL,           -- set number, 1-based
  w    REAL,                       -- lbs (0 = bodyweight)
  reps INTEGER,
  t    INTEGER,                    -- seconds, for timed exercises
  skip INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, wid, ex, s)
);

-- device sessions: sha256 of a random token handed out after Google sign-in
CREATE TABLE IF NOT EXISTS sessions (
  hash    TEXT PRIMARY KEY,
  uid     INTEGER NOT NULL,
  created TEXT NOT NULL
);
