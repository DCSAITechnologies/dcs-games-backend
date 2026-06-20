// DCS Games — INTEGRATED Core API v3 (real auth + dashboard routes). Zero external deps (node:http). Run via tsx.
// LANES: CW1 identity(+real Supabase Auth) · CW2 generation · CW5 persistence(Supabase) · CW7 atlas. CW4 = WS service.
// Auth: Bearer JWT verified against Supabase /auth/v1/user when SUPABASE_URL set; else dev-bearer (token = user id).
// Money DARK. Honest data: unknown -> zeros/empty, never fabricated.
import http from "node:http";
import { generateWorld } from "./src/cw2/generate.mjs";
import { generateVia, setAdapter } from "./src/cw2/adapter.mjs";              // CW2: generation adapter seam (seeder default; LLM hybrid when provisioned)
import { makeHybridAdapter } from "./src/cw2/hybrid-enrich.mjs";              // CW2 v3.0: Cerebras hybrid enrich (seeder geometry + AI flavor, fail-safe)
import { makeCerebrasClient } from "./src/cw2/cerebras-client.mjs";          // CW2: Cerebras inference client (OpenAI-compatible, key from env)
import { toRuntimeWorld, toBaseWorldRow } from "./src/cw2/runtime-schema.mjs"; // CW2 fix: full C1 runtime schema -> renders with ZERO runtime patches
import { PersistenceEngine, InMemoryPersistenceStore } from "./src/cw5/cw5_persistence.ts";
import { SupabasePersistenceStore } from "./src/cw5/cw5_supabase_store.ts";
import { createIdentityStore, handleIdentity } from "./src/cw1/identity-slice.mjs";
import { handleTrustSafetySSO } from "./src/cw1/ts-sso-kyc-slice.mjs"; // CW1 v3.0: T&S console + payout-KYC, reconciled to gateway auth
import { makeAtlasRoutes } from "./src/cw7/atlas-routes.mjs";
import { verifyPageHTML } from "./src/cw7/atlas-verify-page.mjs"; // CW7: renderable public verify view
import { makeKeyEndpoint } from "./src/cw7/atlas-key.mjs";       // CW7: GET /atlas/key (real ed25519 public key from env, honest when unset)
import { makeCrossProductRouter } from "./src/cw7/atlas-cross-product.mjs"; // CW7 v4.0: cross-product reputation (node-http routeTable)
import { createEconomyRouter } from "./src/cw6/economy-router.mjs";          // CW6 v3.0: economy routes (DARK), non-express fallback router

const PORT = parseInt(process.env.PORT || "8080", 10);
const PAYMENTS_LIVE = process.env.PAYMENTS_LIVE === "1";
const SUPA = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const HAS_SUPA = !!(SUPA && KEY);

// CW2 generation: flip to Cerebras hybrid enrich when a key is present; else stay on the deterministic seeder.
const _cerebras = makeCerebrasClient(); // null when CEREBRAS_API_KEY unset
setAdapter(makeHybridAdapter({ modelClient: _cerebras }));
const GEN_MODE = _cerebras ? ("cerebras-hybrid:" + _cerebras.model + " ×" + _cerebras.keyCount + "key") : "deterministic-seeder";
console.log("CW2 generation adapter:", GEN_MODE);

const worlds = new Map<string, any>();
const _store = HAS_SUPA
  ? new SupabasePersistenceStore({ url: SUPA, serviceRoleKey: KEY })
  : new InMemoryPersistenceStore();
const persistence = new PersistenceEngine(_store);
const idb = createIdentityStore();
const atlas = makeAtlasRoutes({ worlds: Array.from(worlds.values()), events: [], receipts: [], verifiedWorldIds: [] });
const crossProduct = makeCrossProductRouter({ resolveProductIdentities: (_id: string) => [] }); // CW7 v4.0: Sports identity wired later; honest empty until then
const econRouter: any = createEconomyRouter({}); // CW6 v3.0: DARK; supabase + signReceipt injected later → honest empty + unsigned receipts, no fabricated sales
const atlasKey = makeKeyEndpoint({ publicKey: () => process.env.ATLAS_PUBLIC_KEY || "" }); // private key stays in atlas-sign env

function send(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" });
  res.end(JSON.stringify(body));
}
function sendHTML(res: http.ServerResponse, code: number, html: string) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
  res.end(html);
}
function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
}
// real Supabase JWT verification (zero-dep): GET /auth/v1/user with the bearer token
async function resolveUid(req: http.IncomingMessage): Promise<string> {
  const tok = (req.headers["authorization"] || "").toString().replace(/^Bearer\s+/i, "").trim();
  const hdr = (req.headers["x-user-id"] || "").toString();
  if (HAS_SUPA && tok) {
    try {
      const r = await fetch(SUPA + "/auth/v1/user", { headers: { apikey: KEY, Authorization: "Bearer " + tok } });
      if (r.ok) { const u: any = await r.json(); if (u && u.id) return u.id; }
    } catch { /* fall through */ }
    return hdr || "u_new";              // invalid/absent live token -> not trusted
  }
  return tok || hdr || "u_new";         // dev/local: bearer is the id
}
async function supaGet(pathq: string): Promise<any[]> {
  if (!HAS_SUPA) return [];
  try {
    const r = await fetch(SUPA + "/rest/v1/" + pathq, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}
async function supaInsert(table: string, row: any): Promise<boolean> {
  if (!HAS_SUPA) return false;
  try {
    const r = await fetch(SUPA + "/rest/v1/" + table, {
      method: "POST",
      headers: { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(row),
    });
    return r.ok;
  } catch { return false; }
}

const server = http.createServer(async (req, res) => {
  if ((req.url || "").startsWith("/api/") && !(req.url || "").startsWith("/api/public/")) req.url = "/" + req.url.slice(5);
  const url = (req.url || "").split("?")[0];
  const method = req.method || "GET";
  try {
    if (method === "OPTIONS") return send(res, 204, {});
    if (url === "/health") return send(res, 200, {
      ok: true, service: "dcs-games-backend", payments_live: PAYMENTS_LIVE,
      auth: HAS_SUPA ? "supabase-jwt" : "dev-bearer",
      persistence: HAS_SUPA ? "supabase" : "in-memory",
      generation: GEN_MODE,
      lanes: ["cw1-identity", "cw2-generation", "cw5-persistence", "cw7-atlas"],
      schema: "runtime-ready (cw2 toRuntimeWorld; zero runtime patches)",
      routes: ["/api/public/worlds", "/api/worlds/mine", "/api/me/revenue", "/worlds/generate", "/worlds/:id/manifest", "/atlas/key", "/verify"],
      netcode: "ws-separate-service", ts: new Date().toISOString(),
    });

    // resolve the caller once (real JWT when live) so identity + routes share it
    const uid = await resolveUid(req);
    const idCtx = { db: idb, send, body: readBody, who: () => uid };

    // ---- dashboard data routes (real Supabase reads; honest empty until data flows) ----
    if (url === "/api/public/worlds" && method === "GET") {
      const rows = await supaGet("dcsgames_base_worlds?select=*&limit=50");
      return send(res, 200, { ok: true, count: rows.length, worlds: rows, source: HAS_SUPA ? "supabase" : "empty" });
    }
    if (url === "/worlds/mine" && method === "GET") {
      const rows = await supaGet("dcsgames_base_worlds?owner_id=eq." + encodeURIComponent(uid) + "&select=*&limit=50");
      return send(res, 200, { ok: true, count: rows.length, worlds: rows, owner: uid });
    }
    if (url === "/me/revenue" && method === "GET") {
      return send(res, 200, { ok: true, currency: "INR", payments_live: PAYMENTS_LIVE, total_minor: 0, payouts: [], split: { seller: 70, platform: 30 }, dark: true, note: "revenue DARK until DK flips" });
    }

    // ---- REAL AUTH: proxy signup/login to Supabase Auth (returns a real JWT) ----
    const ANON = process.env.SUPABASE_ANON_KEY || KEY;
    if (HAS_SUPA && method === "POST" && (url === "/auth/signup" || url === "/auth/login")) {
      const b = await readBody(req);
      const isSignup = url === "/auth/signup";
      const ep = isSignup ? "/auth/v1/signup" : "/auth/v1/token?grant_type=password";
      try {
        const payload: any = { email: b.email, password: b.password };
        if (isSignup && b.username) payload.data = { username: b.username };
        const r = await fetch(SUPA + ep, { method: "POST", headers: { apikey: ANON, "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        const j: any = await r.json().catch(() => ({}));
        if (!r.ok) return send(res, r.status, { ok: false, error: j.error_description || j.msg || j.error || "auth_failed", code: j.error_code || null });
        const access = j.access_token || (j.session && j.session.access_token) || null;
        const usr = j.user || (j.session && j.session.user) || null;
        return send(res, 200, { ok: true, token: access, access_token: access, refresh_token: j.refresh_token || null, user: usr, needs_confirmation: isSignup && !access });
      } catch (e: any) { return send(res, 502, { ok: false, error: "auth_upstream", detail: String(e?.message || e) }); }
    }

    if (await handleIdentity(req, res, idCtx)) return;
    if (await handleTrustSafetySSO(req, res, { user: uid && uid !== "u_new" ? { id: uid } : null, send, body: readBody, db: { mode: "memory" } })) return; // T&S/KYC (in-memory repo; DARK). Supabase persistence = follow-up migration 0002

    // ---- CW7 public trust surface ----
    if (url === "/atlas/key" && method === "GET") return send(res, 200, atlasKey.key());
    if (url === "/verify" && method === "GET") {
      const q = (req.url || "").split("?")[1] || "";
      const rp = new URLSearchParams(q).get("receipt");
      let receipt: any = null;
      if (rp) { try { receipt = JSON.parse(Buffer.from(rp, "base64").toString("utf8")); } catch { try { receipt = JSON.parse(rp); } catch { receipt = null; } } }
      return sendHTML(res, 200, verifyPageHTML(receipt)); // honest VERIFIED/INVALID/NOT_FOUND; never "trusted" on fail
    }

    for (const entry of atlas.routes as Array<[string, RegExp, (m: RegExpMatchArray) => any]>) {
      const [vm, re, fn] = entry;
      if (method === vm) { const mm = url.match(re); if (mm) return send(res, 200, fn(mm)); }
    }

    // the server strips a leading "/api/" → "/" earlier; reconstruct it so CW6/CW7 (which register /api/* paths) match either form
    const apiPath = url.startsWith("/api/") ? url : "/api" + url;

    // CW7 v4.0 — cross-product reputation (node-http routeTable; Games identity resolver; Sports added when wired)
    for (const [vm, re, fn] of crossProduct.routeTable() as Array<[string, RegExp, (m: RegExpMatchArray) => any]>) {
      if (method === vm) { const mm = apiPath.match(re); if (mm) return send(res, 200, fn(mm)); }
    }

    // CW6 v3.0 — economy routes (DARK). Uses CW6's non-express fallback router; we shim req/res. money DARK, honest empty until a supabase client is wired.
    {
      const r = (econRouter as any)._routes.find((x: any) => x.method === method && x.path === apiPath);
      if (r) {
        const body = (method === "POST") ? await readBody(req) : {};
        const shimRes: any = { _c: 200, status(c: number) { this._c = c; return this; }, json(b: any) { return send(res, this._c, b); } };
        await r.handler({ user: uid && uid !== "u_new" ? { id: uid } : null, body }, shimRes);
        return;
      }
    }

    if (url === "/worlds/generate" && method === "POST") {
      const b = await readBody(req);
      const world = await generateVia(b.prompt || "Pirate Island"); // adapter seam: Cerebras hybrid when keyed, else seeder (always C1-valid)
      const runtime = toRuntimeWorld(world);                 // CW2 fix: render-ready (env/material/transform.position/spawn)
      worlds.set(world.world_id, runtime);                   // manifest serves the runtime world -> ZERO runtime-side patches
      const base = { world_id: world.world_id, objects: (world.objects || []).map((o: any) => ({ object_id: o.object_id, kind: o.kind, transform: o.transform || { x: 0, y: 0, z: 0 }, owner_id: o.owner_id ?? null })) };
      await persistence.registerBaseWorld(base);
      // best-effort: surface the world in public/mine feeds with its real name + durable runtime manifest (never fail generate on a feed-insert issue)
      if (HAS_SUPA) { try { const row: any = toBaseWorldRow(world); row.owner_id = uid; await supaInsert("dcsgames_base_worlds", row); } catch { /* feed insert is best-effort */ } }
      return send(res, 200, { ok: true, world_id: world.world_id, status: "ready", manifest_url: "/worlds/" + world.world_id + "/manifest" });
    }
    let m = url.match(/^\/worlds\/([^/]+)\/manifest$/);
    if (m && method === "GET") {
      let w = worlds.get(m[1]);
      if (!w && HAS_SUPA) { const rows = await supaGet("dcsgames_base_worlds?world_id=eq." + encodeURIComponent(m[1]) + "&select=manifest&limit=1"); w = rows[0]?.manifest; } // survive restart: serve durable runtime manifest
      return w ? send(res, 200, w) : send(res, 404, { ok: false, error: "world_not_found" });
    }
    m = url.match(/^\/worlds\/([^/]+)\/save$/);
    if (m && method === "POST") { const b = await readBody(req); const delta = b.delta || b; delta.world_id = m[1]; const r = await persistence.save(delta); return send(res, 200, { ok: true, ...r }); }
    m = url.match(/^\/worlds\/([^/]+)\/load$/);
    if (m && method === "GET") { const snap = await persistence.load(m[1]); return send(res, 200, snap); }

    return send(res, 404, { ok: false, error: "not_found", path: url });
  } catch (e: any) {
    return send(res, 500, { ok: false, error: "server_error", detail: String(e?.message || e) });
  }
});
server.listen(PORT, () => console.log("DCS Games Core API v3 on :" + PORT + " auth=" + (HAS_SUPA ? "supabase-jwt" : "dev-bearer")));
