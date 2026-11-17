-- v1 (single owner) -> v2 (multi-user). Existing data becomes user 1.
-- Afterwards insert the owner as users.id = 1 by hand (so no email lives in this repo).
CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL DEFAULT '', created TEXT NOT NULL);
CREATE TABLE routines2 (uid INTEGER NOT NULL, id TEXT NOT NULL, pos INTEGER NOT NULL, day TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL, sub TEXT NOT NULL DEFAULT '', ex TEXT NOT NULL, PRIMARY KEY (uid, id));
INSERT INTO routines2 SELECT 1, id, pos, day, name, sub, ex FROM routines;
DROP TABLE routines;
ALTER TABLE routines2 RENAME TO routines;

CREATE TABLE sets2 (uid INTEGER NOT NULL, wid TEXT NOT NULL, d TEXT NOT NULL, r TEXT NOT NULL, ex TEXT NOT NULL,
  s INTEGER NOT NULL, w REAL, reps INTEGER, t INTEGER, skip INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (uid, wid, ex, s));
INSERT INTO sets2 SELECT 1, wid, d, r, ex, s, w, reps, t, skip FROM sets;
DROP INDEX IF EXISTS sets_ex_d;
DROP TABLE sets;
ALTER TABLE sets2 RENAME TO sets;

-- old sessions can only have belonged to the owner
CREATE TABLE sessions2 (hash TEXT PRIMARY KEY, uid INTEGER NOT NULL, created TEXT NOT NULL);
INSERT INTO sessions2 SELECT hash, 1, created FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions2 RENAME TO sessions;
