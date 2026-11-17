// lift-api: public reads, owner-only writes.
//   GET    /data      -> {routines, sets}            (anyone)
//   POST   /login     {credential} -> {token}        (Google ID token must be ALLOWED_EMAIL)
//   POST   /logout                                   (auth)
//   POST   /sets      {rows:[...]}                   (auth, idempotent)
//   PUT    /routines  {routines:[...]}               (auth, replaces all)

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), { status: status || 200, headers: { "content-type": "application/json", ...cors } });

async function sha256(s) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function authed(req, env) {
  const tok = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!tok) return false;
  return !!(await env.DB.prepare("SELECT 1 FROM sessions WHERE hash=?").bind(await sha256(tok)).first());
}

const str = (v, n) => String(v ?? "").slice(0, n);
const numOrNull = v => (v === null || v === undefined || v === "" || !isFinite(+v) ? null : +v);

export default {
  async fetch(req, env) {
    const origin = req.headers.get("origin") || "";
    const allowed = env.ALLOWED_ORIGINS.split(",");
    const cors = allowed.includes(origin)
      ? { "access-control-allow-origin": origin, "access-control-allow-headers": "authorization,content-type",
          "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-max-age": "86400", vary: "origin" }
      : {};
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    const { pathname } = new URL(req.url);
    try {
      if (req.method === "GET" && pathname === "/data") {
        const [r, s] = await env.DB.batch([
          env.DB.prepare("SELECT id, day, name, sub, ex FROM routines ORDER BY pos"),
          env.DB.prepare("SELECT wid, d, r, ex, s, w, reps, t, skip FROM sets ORDER BY d, wid, s"),
        ]);
        return json({
          routines: r.results.map(x => ({ ...x, ex: JSON.parse(x.ex) })),
          sets: s.results,
        }, 200, { ...cors, "cache-control": "no-store" });
      }

      if (req.method === "POST" && pathname === "/login") {
        const { credential } = await req.json();
        // Google verifies the signature for us; we check audience, email and expiry.
        const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential || ""));
        const t = r.ok ? await r.json() : {};
        const ok = t.aud === env.GOOGLE_CLIENT_ID && t.email_verified === "true" &&
          String(t.email).toLowerCase() === String(env.ALLOWED_EMAIL).toLowerCase() && +t.exp * 1000 > Date.now();
        if (!ok) return json({ error: "not allowed" }, 403, cors);
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, "0")).join("");
        await env.DB.prepare("INSERT INTO sessions (hash, created) VALUES (?, ?)").bind(await sha256(token), new Date().toISOString()).run();
        return json({ token }, 200, cors);
      }

      if (!(await authed(req, env))) return json({ error: "auth" }, 401, cors);

      if (req.method === "POST" && pathname === "/logout") {
        const tok = req.headers.get("authorization").replace(/^Bearer /, "");
        await env.DB.prepare("DELETE FROM sessions WHERE hash=?").bind(await sha256(tok)).run();
        return json({ ok: true }, 200, cors);
      }

      if (req.method === "POST" && pathname === "/sets") {
        const { rows } = await req.json();
        if (!Array.isArray(rows) || rows.length > 500) return json({ error: "bad rows" }, 400, cors);
        const stmt = env.DB.prepare("INSERT OR IGNORE INTO sets (wid, d, r, ex, s, w, reps, t, skip) VALUES (?,?,?,?,?,?,?,?,?)");
        if (rows.length) await env.DB.batch(rows.map(x => stmt.bind(
          str(x.wid, 64), str(x.d, 10), str(x.r, 32), str(x.ex, 100), x.s | 0,
          numOrNull(x.w), numOrNull(x.reps), numOrNull(x.t), x.skip ? 1 : 0)));
        return json({ ok: true, n: rows.length }, 200, cors);
      }

      if (req.method === "PUT" && pathname === "/routines") {
        const { routines } = await req.json();
        if (!Array.isArray(routines) || !routines.length || routines.length > 20) return json({ error: "bad routines" }, 400, cors);
        const ins = env.DB.prepare("INSERT INTO routines (id, pos, day, name, sub, ex) VALUES (?,?,?,?,?,?)");
        await env.DB.batch([
          env.DB.prepare("DELETE FROM routines"),
          ...routines.map((r, i) => ins.bind(str(r.id, 32), i, str(r.day, 20), str(r.name, 60), str(r.sub, 100),
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
