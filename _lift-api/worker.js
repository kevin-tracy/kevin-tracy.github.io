// lift-api: every request except sign-in needs a session. Only emails in `users` can sign in.
//   POST   /login     {credential} -> {token}     Google ID token; first sign-in copies the owner's routines
//   POST   /logout
//   GET    /me        -> {id, name}
//   GET    /users     -> [{id, name}]              everyone, for read-only viewing
//   GET    /data?u=ID -> {routines, sets}          your own by default, anyone's read-only
//   POST   /sets      {rows:[...]}                 your own, idempotent
//   PUT    /routines  {routines:[...]}             replaces all of your own

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json", "cache-control": "no-store", ...cors } });

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const bearer = req => (req.headers.get("authorization") || "").replace(/^Bearer /, "");

const str = (v, n) => String(v ?? "").slice(0, n);
const numOrNull = v => (v === null || v === undefined || v === "" || !isFinite(+v) ? null : +v);

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    const cors = env.ALLOWED_ORIGINS.split(",").includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization,content-type",
          "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-max-age": "86400", vary: "origin" }
      : {};
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url), path = url.pathname, DB = env.DB;
    try {
      if (req.method === "POST" && path === "/login") {
        const { credential } = await req.json();
        // Google verifies the signature for us; we check audience, verified email and expiry.
        const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential || ""));
        const t = r.ok ? await r.json() : {};
        const email = String(t.email || "").toLowerCase();
        if (t.aud !== env.GOOGLE_CLIENT_ID || t.email_verified !== "true" || +t.exp * 1000 <= Date.now())
          return json({ error: "not allowed" }, 403, cors);
        const user = await DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first();
        if (!user) return json({ error: "not allowed" }, 403, cors);

        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join("");
        const now = new Date().toISOString();
        await DB.batch([
          DB.prepare("UPDATE users SET name=? WHERE id=?").bind(str(t.name || email.split("@")[0], 60), user.id),
          DB.prepare("INSERT INTO sessions (hash, uid, created) VALUES (?,?,?)").bind(await sha256(token), user.id, now),
          // first sign-in: start from a copy of the owner's routines
          DB.prepare(`INSERT INTO routines (uid, id, pos, day, name, sub, ex)
            SELECT ?, id, pos, day, name, sub, ex FROM routines
            WHERE uid=(SELECT id FROM users WHERE email=?) AND NOT EXISTS (SELECT 1 FROM routines WHERE uid=?)`)
            .bind(user.id, String(env.ALLOWED_EMAIL).toLowerCase(), user.id),
        ]);
        return json({ token }, 200, cors);
      }

      const me = await DB.prepare("SELECT u.id, u.name FROM sessions s JOIN users u ON u.id=s.uid WHERE s.hash=?")
        .bind(await sha256(bearer(req))).first();
      if (!me) return json({ error: "auth" }, 401, cors);

      if (req.method === "GET" && path === "/me") return json(me, 200, cors);

      if (req.method === "GET" && path === "/users") {
        const { results } = await DB.prepare("SELECT id, name FROM users WHERE name<>'' ORDER BY name").all();
        return json(results, 200, cors);
      }

      if (req.method === "GET" && path === "/data") {
        const uid = url.searchParams.has("u") ? +url.searchParams.get("u") : me.id;
        const [r, s] = await DB.batch([
          DB.prepare("SELECT id, day, name, sub, ex FROM routines WHERE uid=? ORDER BY pos").bind(uid),
          DB.prepare("SELECT wid, d, r, ex, s, w, reps, t, skip FROM sets WHERE uid=? ORDER BY d, wid, s").bind(uid),
        ]);
        return json({ routines: r.results.map(x => ({ ...x, ex: JSON.parse(x.ex) })), sets: s.results }, 200, cors);
      }

      if (req.method === "POST" && path === "/logout") {
        await DB.prepare("DELETE FROM sessions WHERE hash=?").bind(await sha256(bearer(req))).run();
        return json({ ok: true }, 200, cors);
      }

      if (req.method === "POST" && path === "/sets") {
        const { rows } = await req.json();
        if (!Array.isArray(rows) || rows.length > 500) return json({ error: "bad rows" }, 400, cors);
        const stmt = DB.prepare("INSERT OR IGNORE INTO sets (uid, wid, d, r, ex, s, w, reps, t, skip) VALUES (?,?,?,?,?,?,?,?,?,?)");
        if (rows.length) await DB.batch(rows.map(x => stmt.bind(me.id,
          str(x.wid, 64), str(x.d, 10), str(x.r, 32), str(x.ex, 100), x.s | 0,
          numOrNull(x.w), numOrNull(x.reps), numOrNull(x.t), x.skip ? 1 : 0)));
        return json({ ok: true, n: rows.length }, 200, cors);
      }

      if (req.method === "PUT" && path === "/routines") {
        const { routines } = await req.json();
        if (!Array.isArray(routines) || routines.length > 30) return json({ error: "bad routines" }, 400, cors);
        const ins = DB.prepare("INSERT INTO routines (uid, id, pos, day, name, sub, ex) VALUES (?,?,?,?,?,?,?)");
        await DB.batch([
          DB.prepare("DELETE FROM routines WHERE uid=?").bind(me.id),
          ...routines.map((r, i) => ins.bind(me.id, str(r.id, 32), i, str(r.day, 20), str(r.name, 60) || "Routine", str(r.sub, 100),
            JSON.stringify((r.ex || []).slice(0, 40).map(e => ({
              name: str(e.name, 100), kind: e.kind === "time" ? "time" : "wr",
              sets: Math.max(1, Math.min(20, e.sets | 0)), reps: str(e.reps, 10), w: numOrNull(e.w) || 0,
            }))))),
        ]);
        return json({ ok: true }, 200, cors);
      }

      return json({ error: "not found" }, 404, cors);
    } catch (e) {
      return json({ error: "server" }, 500, cors);
    }
  },
};
