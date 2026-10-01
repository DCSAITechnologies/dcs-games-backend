// A minimal PostgREST stand-in for the durability tests: the subset of the wire
// protocol src/core/collection.mjs speaks (paged GET with Range, ping GET with
// limit, upsert POST with on_conflict, DELETE by eq filters). Rows live in THIS
// process, so a server or repo process under test can be killed and restarted
// and still find what it wrote — which is the point: the database outlives the
// process.
//
// `failTables` makes those tables answer 404 PGRST205 ("not in the schema
// cache"), which is what a missing table looks like to a real client.
import http from "node:http";

export async function startFakePostgrest({ failTables = [], failAll = false } = {}) {
  const tables = new Map();                       // table -> Map(keyString -> row)
  const requests = [];
  const tbl = (t) => { if (!tables.has(t)) tables.set(t, new Map()); return tables.get(t); };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    const m = /^\/rest\/v1\/([A-Za-z0-9_]+)$/.exec(u.pathname);
    let body = "";
    for await (const c of req) body += c;
    requests.push({ method: req.method, path: u.pathname, search: u.search });
    const reply = (code, obj, headers = {}) => { res.writeHead(code, { "content-type": "application/json", ...headers }); res.end(obj === undefined ? "" : JSON.stringify(obj)); };
    if (failAll) return reply(500, { message: "fake postgrest: failing every request" });
    if (!m) return reply(200, {});                                   // OpenAPI root and anything else
    const t = m[1];
    if (failTables.includes(t)) return reply(404, { code: "PGRST205", message: `Could not find the table 'public.${t}' in the schema cache` });
    const rows = tbl(t);
    if (req.method === "GET") {
      let all = [...rows.values()];
      for (const [k, v] of u.searchParams) {
        if (["select", "order", "limit", "offset"].includes(k)) continue;
        if (v.startsWith("eq.")) all = all.filter((r) => String(r[k]) === decodeURIComponent(v.slice(3)));
      }
      if (u.searchParams.get("limit")) return reply(200, all.slice(0, Number(u.searchParams.get("limit"))));
      const range = req.headers.range;
      if (range) {
        const [a, b] = range.split("-").map(Number);
        if (a > 0 && a >= all.length) return reply(416, { message: "range not satisfiable" });
        return reply(206, all.slice(a, b + 1));
      }
      return reply(200, all);
    }
    if (req.method === "POST") {
      const keys = (u.searchParams.get("on_conflict") || "id").split(",");
      const incoming = JSON.parse(body || "[]");
      for (const r of Array.isArray(incoming) ? incoming : [incoming]) {
        const k = JSON.stringify(keys.map((c) => r[c]));
        rows.set(k, { ...(rows.get(k) || {}), ...r });
      }
      return reply(201, undefined);
    }
    if (req.method === "DELETE") {
      for (const [k, r] of rows) {
        let hit = true;
        for (const [c, v] of u.searchParams) if (v.startsWith("eq.") && String(r[c]) !== decodeURIComponent(v.slice(3))) hit = false;
        if (hit) rows.delete(k);
      }
      return reply(204, undefined);
    }
    return reply(405, { message: "method not supported by the fake" });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    rows: (t) => [...tbl(t).values()],
    requests,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
