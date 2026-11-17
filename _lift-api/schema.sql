-- routines: one row per routine, exercises stored as a JSON array
CREATE TABLE IF NOT EXISTS routines (
  id   TEXT PRIMARY KEY,
  pos  INTEGER NOT NULL,
  day  TEXT NOT NULL,
  name TEXT NOT NULL,
  sub  TEXT NOT NULL DEFAULT '',
  ex   TEXT NOT NULL            -- [{name, kind:"wr"|"time", sets, reps, w}]
);

-- sets: one row per logged set. (wid, ex, s) is unique so retried syncs never duplicate.
CREATE TABLE IF NOT EXISTS sets (
  wid  TEXT NOT NULL,           -- workout id (generated on the phone when the workout starts)
  d    TEXT NOT NULL,           -- YYYY-MM-DD
  r    TEXT NOT NULL,           -- routine id
  ex   TEXT NOT NULL,           -- exercise name
  s    INTEGER NOT NULL,        -- set number, 1-based
  w    REAL,                    -- lbs (0 = bodyweight)
  reps INTEGER,
  t    INTEGER,                 -- seconds, for timed exercises
  skip INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (wid, ex, s)
);
CREATE INDEX IF NOT EXISTS sets_ex_d ON sets (ex, d);

-- device sessions: sha256 of a random token handed out after Google sign-in
CREATE TABLE IF NOT EXISTS sessions (
  hash    TEXT PRIMARY KEY,
  created TEXT NOT NULL
);
