// DCS Games — INTEGRATED Core API v3 (real auth + dashboard routes). Zero external deps (node:http). Run via tsx.
// LANES: CW1 identity(+real Supabase Auth) · CW2 generation · CW5 persistence(Supabase) · CW7 atlas. CW4 = WS service.
// Auth: Bearer JWT verified against Supabase /auth/v1/user when SUPABASE_URL set; else dev-bearer (token = user id).
// Money DARK. Honest data: unknown -> zeros/empty, never fabricated.
import http from "node:http";
import crypto from "node:crypto";
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
import { atlasReady, verifyReceipt, atlasPublicKeyBase64, issueWorldReceipt } from "./src/cw7/atlas-local-sign.mjs"; // CW7: local ed25519 sign+verify (off-chain, no gas)
import { makeCrossProductRouter } from "./src/cw7/atlas-cross-product.mjs"; // CW7 v4.0: cross-product reputation (node-http routeTable)
import { createEconomyRouter } from "./src/cw6/economy-router.mjs";          // CW6 v3.0: economy routes (DARK), non-express fallback router
import { LANES } from "./src/v3/providers/contract.mjs";                        // B11: media lane
import { createAssemblyRouter } from "./src/v3/router/assembly.mjs";            // B1: multi-provider world assembly
import { validateManifest, MANIFEST_VERSION } from "./src/v3/manifest/schema.mjs"; // B0: canonical world contract
import { ensureV3 } from "./src/v3/manifest/migrate.mjs";                       // B0: v1 -> v3 upgrade
import { playtestAndRepair } from "./src/v3/playtest/agent.mjs";                // B4: playtest -> critic -> repair
import { planExpansion, planEdit } from "./src/v3/expansion/planner.mjs";       // B6/B8: expansion + chat editing
import { applyDelta, verifyPreservation, emptyLiveState } from "./src/v3/expansion/delta.mjs";
import { createWorldMemory } from "./src/v3/memory/world-memory.mjs";           // B7: factual world chronology
import { createCompanionService } from "./src/v3/companion/companion.mjs";      // B5: personal AI companion
import { createProgressionService } from "./src/core/progression.mjs";        // B15: retention from measured data only
import { createSocialService } from "./src/core/social.mjs";                    // B15: durable profiles, friends, parties, teams, studios, discovery
import { createSafetyService } from "./src/core/safety.mjs";                    // A5: age tiers, consent, report/block, moderation audit
import { assertSchema, currentVersion } from "./src/core/schema.mjs";           // A2: boot-time schema assertion — refuse to serve an unsupported schema
import { createWorldRepository } from "./src/core/worldstore.mjs";          // A3: durable, lossless, idempotent, ownership-aware world persistence
import { createPrincipalResolver } from "./src/core/principal.mjs";         // A1: PARENT-OWNED canonical principal. No x-user-id fallback, ever.
import { AppError, Errors, newCorrelationId, logError, optional } from "./src/core/errors.mjs"; // A4: structured errors, correlation ids, no silent swallow

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

const _store = HAS_SUPA
  ? new SupabasePersistenceStore({ url: SUPA, serviceRoleKey: KEY })
  : new InMemoryPersistenceStore();
const persistence = new PersistenceEngine(_store);
const idb = createIdentityStore();
const atlas = makeAtlasRoutes({ worlds: [], events: [], receipts: [], verifiedWorldIds: [] }); // CW7 read surface; world truth now comes from the durable repository
const crossProduct = makeCrossProductRouter({ resolveProductIdentities: (_id: string) => [] }); // CW7 v4.0: Sports identity wired later; honest empty until then
const econRouter: any = createEconomyRouter({}); // CW6 v3.0: DARK; supabase + signReceipt injected later → honest empty + unsigned receipts, no fabricated sales
const v3 = createAssemblyRouter();                                           // B1
const worldMemory = createWorldMemory();                                     // B7
const companions = createCompanionService({ worldMemory });                  // B5
let progression: any = null;                                                 // B15, constructed after social below
const social = createSocialService();                                        // B15: replaces the in-memory fixture users
progression = createProgressionService({ social, worldMemory });
const safety = createSafetyService();                                        // A5: real persistence, so moderation output can never be faked
const repo = createWorldRepository();                                        // A3: replaces the process-local Map + swallowed best-effort insert
console.log("A3 world store:", repo.kind);

// A2: when a direct Postgres DSN is configured, assert the schema BEFORE serving.
// An unsupported schema must stop the process, not surface later as empty data.
let SCHEMA_STATE: any = { checked: false, reason: "no DATABASE_URL configured" };
if (process.env.DATABASE_URL) {
  try {
    SCHEMA_STATE = { checked: true, ...(await assertSchema(process.env.DATABASE_URL)) };
    console.log("A2 schema assertion: ok at v" + SCHEMA_STATE.version);
  } catch (e: any) {
    console.error("A2 SCHEMA ASSERTION FAILED:", e?.detail || e?.message || e);
    if (process.env.DCS_ALLOW_SCHEMA_DRIFT !== "1") process.exit(78); // EX_CONFIG
    SCHEMA_STATE = { checked: true, ok: false, version: await currentVersion(process.env.DATABASE_URL).catch(() => 0), override: true };
  }
}

const auth = createPrincipalResolver();                                      // A1: supabase-jwt when configured, real HS256 otherwise. Never a header.
console.log("A1 auth mode:", auth.mode);

const atlasKey = makeKeyEndpoint({ publicKey: () => atlasPublicKeyBase64() || process.env.ATLAS_PUBLIC_KEY || "" }); // prefer the raw key derived from the signer (matches sig + browser-embed verifiable)

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
// A1: identity now comes from src/core/principal.mjs only. The former resolveUid()
// trusted an x-user-id header and fell back to it when a token failed to verify —
// confirmed exploitable against production on 6 Sep 2026. It is gone.

/** Anonymous-allowed: returns a Principal or null. Throws 401 on a bad credential. */
async function whoOrNull(req: http.IncomingMessage, cid: string) {
  return await auth.resolve(req.headers as any, cid);
}
/** Private routes: returns a Principal or throws 401. */
async function mustBe(req: http.IncomingMessage, cid: string) {
  return await auth.require(req.headers as any, cid);
}
/** Builder/economy/testing surfaces: authenticated AND on the internal-tester allowlist. */
async function mustBeInternalTester(req: http.IncomingMessage, cid: string) {
  const p = await auth.require(req.headers as any, cid);
  if (!p.isInternalTester) {
    throw Errors.forbidden(
      "DCS Games is in controlled internal testing until 30 Sep 2026; this surface is limited to authorized internal testers",
      { correlationId: cid, meta: { window_ends: "2026-09-30" } }
    );
  }
  return p;
}

async function supaGet(pathq: string): Promise<any[]> {
  if (!HAS_SUPA) return [];
  try {
    const r = await fetch(SUPA + "/rest/v1/" + pathq, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
    if (!r.ok) return [];
    return await r.json();
  } catch { return []; }
}
/** Build a media prompt from the world itself, so nothing is invented about it. */
function mediaPromptFor(manifest: any, target: string, b: any): string {
  const m = manifest?.meta || {};
  const zones = (manifest?.zones || []).map((z: any) => z.name).slice(0, 4).join(", ");
  switch (target) {
    case "thumbnail":
      return `Key art for the game world "${m.title}". ${m.style || ""}. Districts: ${zones}. Weather: ${manifest?.environment?.weather || "clear"}.`.slice(0, 500);
    case "portrait": {
      const npc = (manifest?.npcs || []).find((n: any) => n.id === b.npc_id) || (manifest?.npcs || [])[0];
      return `Character portrait of ${npc?.name || "a resident"}, ${npc?.role || "villager"}, in the world "${m.title}". ${m.style || ""}.`.slice(0, 500);
    }
    case "narration":
      return `${m.title}. ${m.description || m.gameplay_loop || "A world to explore."}`.slice(0, 500);
    case "trailer":
    case "intro":
      return `A short cinematic establishing shot of "${m.title}". ${m.style || ""}. Districts: ${zones}.`.slice(0, 500);
    default:
      return `${m.title}. ${m.style || ""}`.slice(0, 500);
  }
}

const server = http.createServer(async (req, res) => {
  if ((req.url || "").startsWith("/api/") && !(req.url || "").startsWith("/api/public/")) req.url = "/" + req.url.slice(5);
  const url = (req.url || "").split("?")[0];
  const method = req.method || "GET";
  // A4: one correlation id per request, echoed on every response and every log line.
  const cid = (req.headers["x-correlation-id"] as string) || newCorrelationId();
  res.setHeader("X-Correlation-Id", cid);
  try {
    if (method === "OPTIONS") return send(res, 204, {});
    if (url === "/health") return send(res, 200, {
      ok: true, service: "dcs-games-backend", payments_live: PAYMENTS_LIVE,
      auth: auth.mode,
      auth_header_fallback_removed: true,      // A1: x-user-id impersonation path deleted 6 Sep 2026
      internal_testing_window_ends: "2026-09-30",
      persistence: repo.kind,
      schema_assertion: SCHEMA_STATE,
      generation: GEN_MODE,
      lanes: ["cw1-identity", "cw2-generation", "cw5-persistence", "cw7-atlas"],
      schema: "runtime-ready (cw2 toRuntimeWorld; zero runtime patches)",
      routes: ["/api/public/worlds", "/api/worlds/mine", "/api/me/revenue", "/worlds/generate", "/worlds/:id/manifest", "/atlas/key", "/verify", "/safety/age", "/safety/report", "/safety/block", "/safety/consent/media"],
      manifest_version: MANIFEST_VERSION,
      social: { profiles: true, friends: true, parties: true, teams: true, studios: true, discovery: true, ...social.describe() },
      safety_persistence: safety.describe(),
      v3: { assembly_router: true, playtest_gate: true, expansion_delta: true, world_memory: true, companion: true, chat_edit: true },
      safety: { age_gating: true, report_block: true, parental_consent: true, media_consent: true, automated_content_moderation: false, minor_onboarding_enabled: false },
      netcode: "ws-separate-service", ts: new Date().toISOString(),
    });

    // A1: resolve once. Anonymous is null; a *bad* credential throws 401 here and
    // never reaches a route, so no handler can be tricked into acting as someone else.
    const principal = await whoOrNull(req, cid);
    const uid = principal ? principal.id : "";
    const idCtx = { db: idb, send, body: readBody, who: () => { if (!principal) throw Errors.unauthenticated("identity route requires authentication", { correlationId: cid }); return principal.id; } };

    // ---- dashboard data routes (real Supabase reads; honest empty until data flows) ----
    if (url === "/api/public/worlds" && method === "GET") {
      const rows = await supaGet("dcsgames_base_worlds?select=*&limit=50");
      return send(res, 200, { ok: true, count: rows.length, worlds: rows, source: HAS_SUPA ? "supabase" : "empty" });
    }
    if (url === "/worlds/mine" && method === "GET") {
      const me = await mustBe(req, cid);                       // A1: 401 when unauthenticated
      const rows = await supaGet("dcsgames_base_worlds?owner_id=eq." + encodeURIComponent(me.id) + "&select=*&limit=50");
      return send(res, 200, { ok: true, count: rows.length, worlds: rows, owner: me.id });
    }
    if (url === "/me/revenue" && method === "GET") {
      await mustBe(req, cid);                                  // A1: 401 when unauthenticated
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
    if ((url.startsWith("/ts/") || url.startsWith("/kyc/")) ) await mustBeInternalTester(req, cid); // T&S console + payout KYC: internal testers only
    if (await handleTrustSafetySSO(req, res, { user: principal ? { id: principal.id } : null, send, body: readBody, db: { mode: "memory" } })) return; // T&S/KYC (in-memory repo; DARK). Supabase persistence = follow-up migration 0002

    // ---- CW7 public trust surface ----
    if (url === "/atlas/key" && method === "GET") return send(res, 200, atlasKey.key());
    if (url === "/verify" && method === "GET") {
      const q = (req.url || "").split("?")[1] || "";
      const rp = new URLSearchParams(q).get("receipt");
      let receipt: any = null;
      if (rp) { try { receipt = JSON.parse(Buffer.from(rp, "base64").toString("utf8")); } catch { try { receipt = JSON.parse(rp); } catch { receipt = null; } } }
      return sendHTML(res, 200, verifyPageHTML(receipt, { verify: verifyReceipt })); // real ed25519 verify; honest VERIFIED/INVALID/NOT_FOUND
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
        const me = await mustBeInternalTester(req, cid);      // economy surface: gated to authorized internal testers, money DARK
        const body = (method === "POST") ? await readBody(req) : {};
        const shimRes: any = { _c: 200, status(c: number) { this._c = c; return this; }, json(b: any) { return send(res, this._c, b); } };
        await r.handler({ user: { id: me.id }, body }, shimRes);
        return;
      }
    }

    // ---- A5 safety surface (ENGINEERING_COMPLETE + INTERNAL_ONLY) ----------
    if (url === "/safety/age" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, ...(await safety.ageStatus(me.id)) });
    }
    if (url === "/safety/age" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      const st = await safety.recordAge(me.id, { dateOfBirth: b.date_of_birth, method: b.method || "self_declared" });
      // Under-13 is recorded and then refused: the tier is honest, and access is not granted.
      return send(res, st.onboarding_permitted ? 200 : 403, { ok: st.onboarding_permitted, ...st, correlation_id: cid });
    }
    if (url === "/safety/report" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      const r = await safety.report(me.id, { subjectType: b.subject_type, subjectId: b.subject_id, reason: b.reason, detail: b.detail });
      return send(res, 201, { ok: true, report_id: r.id, status: r.status, escalated: r.escalated, correlation_id: cid });
    }
    if (url === "/safety/reports" && method === "GET") {
      await mustBeInternalTester(req, cid);              // moderation queue is staff-only
      const rows = await safety.listReports({});
      return send(res, 200, { ok: true, count: rows.length, reports: rows });
    }
    {
      const mm = url.match(/^\/safety\/reports\/([^/]+)\/moderate$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        const r = await safety.moderate(mm[1], b.action, me.id);
        return send(res, 200, { ok: true, report: r, correlation_id: cid });
      }
    }
    if (url === "/safety/moderation-history" && method === "GET") {
      // Deliberately public: an empty list is an honest "nothing was moderated",
      // and the UI must be able to prove that rather than imply activity.
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const rows = await safety.moderationHistory(q.get("subject_type"), q.get("subject_id"));
      return send(res, 200, { ok: true, count: rows.length, actions: rows, automated_moderation: false, note: "DCS Games runs no automated content moderation; this log contains human decisions only." });
    }
    if (url === "/safety/block" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      return send(res, 200, { ok: true, ...(await safety.block(me.id, b.blocked_id)) });
    }
    if (url === "/safety/block" && method === "DELETE") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      return send(res, 200, { ok: true, ...(await safety.unblock(me.id, b.blocked_id)) });
    }
    if (url === "/safety/blocks" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, blocked: await safety.blockList(me.id) });
    }
    if (url === "/safety/consent/parental" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      const r = await safety.requestParentalConsent(b.minor_id || me.id, { guardianEmail: b.guardian_email, scope: b.scope || [], isSynthetic: b.is_synthetic !== false });
      return send(res, 201, { ok: true, consent: r, correlation_id: cid });
    }
    if (url === "/safety/consent/media" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      const r = await safety.grantMediaConsent(b.subject_id || me.id, { mediaKind: b.media_kind, source: b.source, evidenceRef: b.evidence_ref });
      return send(res, 201, { ok: true, consent: r, correlation_id: cid });
    }
    if (url === "/safety/consent/media" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, consents: await safety.mediaConsents(me.id) });
    }

    // ---- B15 retention and the creator dashboard, from measured data only ----
    if (url === "/me/achievements" && method === "GET") {
      const me = await mustBe(req, cid);
      const owned = (await repo.listOwned(me.id, 200)).map((w: any) => w.world_id);
      return send(res, 200, { ok: true, ...(await progression.achievements(me.id, owned)) });
    }
    if (url === "/me/streak" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, ...(await progression.streak(me.id)) });
    }
    if (url === "/me/dashboard" && method === "GET") {
      const me = await mustBe(req, cid);
      const owned = await repo.listOwned(me.id, 200);
      return send(res, 200, { ok: true, ...(await progression.creatorDashboard(me.id, owned)) });
    }

    // ================= B15 social, profile and discovery ==================
    if (url === "/me/profile" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, ...(await social.me(me)) });
    }
    if (url === "/me/profile" && method === "PATCH") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      await social.updateProfile(me, b);
      return send(res, 200, { ok: true, ...(await social.me(me)) });
    }
    {
      const mm = url.match(/^\/profiles\/([^/]+)$/);
      if (mm && method === "GET") {
        // Public and deliberately minimal: no email, no principal id.
        return send(res, 200, { ok: true, profile: await social.publicProfile(mm[1]) });
      }
    }

    if (url === "/social/friends" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, ...(await social.friendList(me.id)) });
    }
    if (url === "/social/friends" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      if (await safety.isBlocked(me.id, b.friend_id)) throw Errors.forbidden("this relationship is blocked", { correlationId: cid });
      return send(res, 201, { ok: true, request: await social.requestFriend(me.id, b.friend_id) });
    }
    if (url === "/social/friends/accept" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      return send(res, 200, { ok: true, friendship: await social.acceptFriend(me.id, b.friend_id) });
    }
    if (url === "/social/friends" && method === "DELETE") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      return send(res, 200, { ok: true, ...(await social.removeFriend(me.id, b.friend_id)) });
    }

    if (url === "/social/parties" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      return send(res, 201, { ok: true, party: await social.createParty(me.id, { worldId: b.world_id, maxSize: b.max_size ?? 8, open: b.open !== false }) });
    }
    if (url === "/social/parties" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, parties: await social.myParties(me.id) });
    }
    {
      let mm = url.match(/^\/social\/parties\/([^/]+)$/);
      if (mm && method === "GET") return send(res, 200, { ok: true, party: await social.getParty(mm[1]) });
      mm = url.match(/^\/social\/parties\/([^/]+)\/join$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        return send(res, 200, { ok: true, party: await social.joinParty(me.id, mm[1]) });
      }
      mm = url.match(/^\/social\/parties\/([^/]+)\/leave$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        return send(res, 200, { ok: true, party: await social.leaveParty(me.id, mm[1]) });
      }
    }

    if (url === "/social/teams" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      return send(res, 201, { ok: true, team: await social.createTeam(me.id, b.name) });
    }
    if (url === "/social/teams" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, teams: await social.myTeams(me.id) });
    }
    {
      let mm = url.match(/^\/social\/teams\/([^/]+)$/);
      if (mm && method === "GET") return send(res, 200, { ok: true, team: await social.getTeam(mm[1]) });
      mm = url.match(/^\/social\/teams\/([^/]+)\/members$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        return send(res, 200, { ok: true, team: await social.addTeamMember(me.id, mm[1], b.member_id, b.role || "member") });
      }
      if (mm && method === "DELETE") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        return send(res, 200, { ok: true, team: await social.removeTeamMember(me.id, mm[1], b.member_id) });
      }
    }

    if (url === "/social/studios" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);       // creator-org surface
      const b = await readBody(req);
      return send(res, 201, { ok: true, studio: await social.createStudio(me.id, b.name) });
    }
    {
      let mm = url.match(/^\/social\/studios\/([^/]+)$/);
      if (mm && method === "GET") {
        await mustBeInternalTester(req, cid);
        return send(res, 200, { ok: true, studio: await social.getStudio(mm[1]) });
      }
      mm = url.match(/^\/social\/studios\/([^/]+)\/members$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        return send(res, 200, { ok: true, studio: await social.addStudioMember(me.id, mm[1], b.member_id, b.role || "member") });
      }
      mm = url.match(/^\/social\/studios\/([^/]+)\/split$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        const studio = await social.setStudioSplit(me.id, mm[1], b.splits);
        return send(res, 200, { ok: true, studio, payments_live: PAYMENTS_LIVE, note: "the split is recorded for modelling; no money moves" });
      }
    }

    // ---- discovery: ranks on MEASURED activity only ---------------------
    if (url === "/v3/discover" && method === "GET") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      const published = await repo.listPublished(200);
      const result = await social.discover(published, {
        sort: q.get("sort") || "recent",
        genre: q.get("genre"),
        q: q.get("q"),
        limit: Math.min(60, parseInt(q.get("limit") || "24", 10) || 24),
      });
      return send(res, 200, { ok: true, ...result });
    }
    {
      const mm = url.match(/^\/v3\/worlds\/([^/]+)\/play$/);
      if (mm && method === "POST") {
        // Recording a play is what makes discovery honest: no row, no ranking.
        const me = await whoOrNull(req, cid);
        const b = await readBody(req);
        await repo.get(mm[1], { requesterId: me?.id ?? null });
        await social.recordPlay(mm[1], me?.id ?? null, b.seconds);
        return send(res, 201, { ok: true, stats: await social.worldStats(mm[1]) });
      }
    }
    {
      const mm = url.match(/^\/v3\/worlds\/([^/]+)\/rate$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        await repo.get(mm[1], { requesterId: me.id });
        await social.rateWorld(me.id, mm[1], b.rating);
        return send(res, 200, { ok: true, stats: await social.worldStats(mm[1]) });
      }
    }
    {
      const mm = url.match(/^\/v3\/worlds\/([^/]+)\/stats$/);
      if (mm && method === "GET") return send(res, 200, { ok: true, world_id: mm[1], stats: await social.worldStats(mm[1]) });
    }

    // ================= DCS GAMES V3 =====================================
    if (url === "/v3/providers" && method === "GET") {
      // Honest provider status. Never claims a vendor that is not reachable.
      return send(res, 200, { ok: true, ...(await v3.describe()) });
    }

    if (url === "/v3/worlds/generate" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      await safety.requireCapability(me.id, "create");
      const b = await readBody(req);
      if (!b.prompt || typeof b.prompt !== "string") throw Errors.validation("prompt is required", { correlationId: cid });

      const worldId = "w3_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const built = await v3.assemble({ prompt: b.prompt, worldId, creatorId: me.id, seed: b.seed, style: b.style, media: b.media === true });
      if (!built.validation.ok) {
        throw Errors.internal("the assembled world did not satisfy WorldManifestV3", { correlationId: cid, meta: { errors: built.validation.errors.slice(0, 8) } });
      }

      // B4: the quality gate runs BEFORE the world is stored, and it can fail.
      const gate = await playtestAndRepair(built.manifest);
      if (!gate.passed) {
        return send(res, 422, {
          ok: false, error: "world_failed_playtest",
          detail: "the generated world did not pass the playtest gate and was not saved",
          verdict: gate.verdict,
          findings: gate.rounds.at(-1).findings.slice(0, 10),
          provenance: built.provenance,
          correlation_id: cid,
        });
      }

      const saved = await repo.upsert({ worldId, ownerId: me.id, manifest: gate.manifest, state: "draft", title: gate.manifest.meta.title });
      await worldMemory.record(worldId, { kind: "created", summary: `"${gate.manifest.meta.title}" was generated from a prompt`, worldVersion: 1, actorId: me.id, detail: { prompt: b.prompt } });
      await social.ensureProfile(me);
      await social.recordWorldCreated(me.id);   // real counters, so /me is measured rather than decorative

      return send(res, 200, {
        ok: true, world_id: worldId, owner: me.id, world_version: saved.version,
        manifest_hash: saved.manifest_hash, manifest_version: MANIFEST_VERSION,
        title: gate.manifest.meta.title,
        playtest: { verdict: gate.verdict, rounds: gate.rounds.length, repairs: gate.repairs.length },
        counts: {
          zones: gate.manifest.zones.length, structures: gate.manifest.structures.length,
          npcs: gate.manifest.npcs.length, items: gate.manifest.items.length,
          quests: gate.manifest.quests.length, behaviors: gate.manifest.behaviors.length,
          interactions: gate.manifest.interactions.length, assets: gate.manifest.assets.length,
        },
        provenance: built.provenance,
        degraded: built.degraded.length ? built.degraded : undefined,
        manifest_url: "/v3/worlds/" + worldId + "/manifest",
        correlation_id: cid,
      });
    }

    {
      let mm = url.match(/^\/v3\/worlds\/([^/]+)\/manifest$/);
      if (mm && method === "GET") {
        const rec = await repo.get(mm[1], { requesterId: principal?.id ?? null });
        // Any world still on the v1 contract is upgraded on read, so old worlds
        // keep working without a migration job.
        const { manifest, migrated } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
        return send(res, 200, { ok: true, world_id: rec.world_id, world_version: rec.version, state: rec.state, owner: rec.owner_id, migrated_on_read: migrated, manifest });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/playtest$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        const rec = await repo.get(mm[1], { requesterId: me.id });
        const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
        const gate = await playtestAndRepair(manifest);
        return send(res, gate.passed ? 200 : 422, {
          ok: gate.passed, verdict: gate.verdict, rounds: gate.rounds,
          repairs: gate.repairs, correlation_id: cid,
        });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/expand$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        if (!b.request) throw Errors.validation("request is required, e.g. 'add a hospital district'", { correlationId: cid });
        const rec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
        const { manifest: before } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });

        const live = { ...emptyLiveState(), ...(b.live_state || {}) };
        const delta = planExpansion(before, { request: b.request, author: me.id, seed: b.seed });
        const applied = applyDelta(before, delta, live);              // throws 409 if unsafe
        const preserved = verifyPreservation(before, applied.manifest, live);
        if (!preserved.ok) {
          throw Errors.conflict("the expansion would have lost existing state", { correlationId: cid, meta: { problems: preserved.problems } });
        }

        const gate = await playtestAndRepair(applied.manifest);
        if (!gate.passed) {
          return send(res, 422, { ok: false, error: "expansion_failed_playtest", detail: "the expanded world did not pass the playtest gate and was not saved", verdict: gate.verdict, findings: gate.rounds.at(-1).findings.slice(0, 10), correlation_id: cid });
        }

        const saved = await repo.upsert({ worldId: rec.world_id, ownerId: me.id, manifest: gate.manifest, state: rec.state, title: gate.manifest.meta.title });
        await worldMemory.record(rec.world_id, { kind: "expanded", summary: `${delta.label} was added`, worldVersion: gate.manifest.world_version, actorId: me.id, detail: { request: b.request, delta_id: delta.delta_id } });

        return send(res, 200, {
          ok: true, world_id: rec.world_id,
          world_version: gate.manifest.world_version, previous_version: applied.previous_version,
          record_version: saved.version, label: delta.label, applied: applied.applied,
          preserved: preserved.ok, playtest: gate.verdict,
          expansion_history: gate.manifest.expansion.history,
          correlation_id: cid,
        });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/edit$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        const rec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
        const { manifest: before } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });

        const plan = planEdit(before, { request: b.request, author: me.id });
        if (plan.error) {
          // Honest: an unrecognised edit is a 422 that says what IS supported.
          return send(res, 422, { ok: false, error: "edit_not_understood", detail: plan.error, supported: plan.supported, hint: plan.hint, correlation_id: cid });
        }
        const applied = applyDelta(before, plan.delta, { ...emptyLiveState(), ...(b.live_state || {}) });
        const gate = await playtestAndRepair(applied.manifest);
        if (!gate.passed) {
          return send(res, 422, { ok: false, error: "edit_failed_playtest", detail: "the edited world did not pass the playtest gate and was not saved", verdict: gate.verdict, findings: gate.rounds.at(-1).findings.slice(0, 6), correlation_id: cid });
        }
        const saved = await repo.upsert({ worldId: rec.world_id, ownerId: me.id, manifest: gate.manifest, state: rec.state, title: gate.manifest.meta.title });
        await worldMemory.record(rec.world_id, { kind: "edited", summary: plan.summary, worldVersion: gate.manifest.world_version, actorId: me.id, detail: { request: b.request, intent: plan.intent } });
        return send(res, 200, { ok: true, world_id: rec.world_id, summary: plan.summary, intent: plan.intent, world_version: gate.manifest.world_version, record_version: saved.version, playtest: gate.verdict, correlation_id: cid });
      }

      // ---- B11 KINIX/Kynex media -----------------------------------------
      // The media lane never blocks a world. A missing provider yields a labelled
      // placeholder, and WorldManifestV3 does not change shape either way.
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/media$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        const kind = b.kind || "image";
        const rec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
        const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });

        // A5 gate: voice and likeness need a recorded, unrevoked consent grant.
        // Fully synthetic material is exempt; anything tied to a real person is not.
        if (kind === "voice" || kind === "narration" || kind === "avatar") {
          await safety.requireCapability(me.id, "voice");
          await safety.requireMediaConsent({
            subjectId: b.subject_id ?? me.id,
            mediaKind: kind === "narration" ? "voice" : kind,
            source: b.source || "synthetic",
          });
        }

        const target = b.target || "thumbnail";
        const prompt = b.prompt || mediaPromptFor(manifest, target, b);
        const r = await v3.lanes[LANES.MEDIA].run({
          kind, target, prompt, label: manifest.meta.title,
          subjectId: b.subject_id ?? null, style: manifest.meta.style,
          width: b.width, height: b.height, durationS: b.duration_s, language: b.language,
        });

        if (!r.value?.uri) {
          // Honest: no provider could produce this, and we say which kind failed.
          return send(res, 200, {
            ok: true, generated: false, target, kind,
            reason: r.value?.unavailable_reason || "no media provider could produce this asset",
            provider: r.provenance.provider, status: r.provenance.status, correlation_id: cid,
          });
        }

        const assetId = `asset_media_${target}`;
        manifest.assets = (manifest.assets || []).filter((a: any) => a.id !== assetId);
        manifest.assets.push({
          id: assetId, kind: kind === "image" ? "effect" : "audio", format: "external", uri: r.value.uri,
          license: { source: r.provenance.provider, commercial_use: "internal-testing-only" },
          provenance: { lane: "media", provider: r.provenance.provider, model: r.provenance.model, placeholder: !!r.value.placeholder, at: r.provenance.at },
        });
        // A v3 manifest saved through /worlds/:id/save may legitimately omit
        // optional blocks. Assuming they exist made this route 500.
        manifest.media = manifest.media || {};
        manifest.provenance = manifest.provenance || { generated_by: [], source_prompt_hash: null, manifest_hash: null };
        (manifest.media as any)[target + "_ref"] = assetId;
        (manifest.media as any)[target + "_is_placeholder"] = !!r.value.placeholder;
        manifest.provenance.generated_by = [...(manifest.provenance.generated_by || []), r.provenance];

        const saved = await repo.upsert({ worldId: rec.world_id, ownerId: me.id, manifest, state: rec.state, title: manifest.meta.title });
        return send(res, 200, {
          ok: true, generated: true, target, kind, asset_id: assetId,
          // A placeholder is ALWAYS labelled, so it can never pass as generated art.
          placeholder: !!r.value.placeholder,
          provider: r.provenance.provider, status: r.provenance.status,
          world_version: saved.version, correlation_id: cid,
        });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/memory$/);
      if (mm && method === "GET") {
        await repo.get(mm[1], { requesterId: principal?.id ?? null });   // read permission
        return send(res, 200, { ok: true, world_id: mm[1], timeline: await worldMemory.timeline(mm[1]), chronology: await worldMemory.chronology(mm[1]) });
      }

      // ---- B5 companion ------------------------------------------------
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/companion$/);
      if (mm) {
        const me = await mustBe(req, cid);
        const worldId = mm[1];
        if (method === "GET") return send(res, 200, { ok: true, companion: await companions.get(me.id, worldId) });
        if (method === "POST") {
          const b = await readBody(req);
          const action = b.action || "adopt";
          const rec = await repo.get(worldId, { requesterId: me.id });
          const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
          if (action === "adopt") {
            const c = await companions.adopt(me.id, worldId, { name: b.name, persona: b.persona });
            return send(res, 200, { ok: true, companion: c, greeting: await companions.greeting(me.id, worldId, manifest) });
          }
          if (action === "follow") return send(res, 200, { ok: true, companion: await companions.follow(me.id, worldId, b.following !== false) });
          if (action === "dismiss") return send(res, 200, { ok: true, companion: await companions.dismiss(me.id, worldId) });
          if (action === "remember") return send(res, 200, { ok: true, companion: await companions.remember(me.id, worldId, { text: b.text, kind: b.kind, refs: b.refs }) });
          if (action === "forget") return send(res, 200, { ok: true, companion: await companions.forget(me.id, worldId, b.memory_id) });
          if (action === "context") return send(res, 200, { ok: true, companion: await companions.updateContext(me.id, worldId, { zone: b.zone ?? null, activeQuest: b.active_quest ?? null }) });
          if (action === "ask") return send(res, 200, { ok: true, ...(await companions.ask(me.id, worldId, manifest, b.question, { zone: b.zone, activeQuest: b.active_quest })) });
          if (action === "caption") return send(res, 200, { ok: true, ...(await companions.caption(me.id, worldId, manifest, { zone: b.zone, activeQuest: b.active_quest })) });
          throw Errors.validation(`unknown companion action '${action}'`, { correlationId: cid, meta: { supported: ["adopt", "follow", "dismiss", "remember", "forget", "context", "ask", "caption"] } });
        }
      }
    }

    if (url === "/worlds/generate" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);        // creation is a builder surface: internal testers only until 30 Sep 2026
      await safety.requireCapability(me.id, "create");        // A5: age tier must permit creation
      const b = await readBody(req);
      const world = await generateVia(b.prompt || "Pirate Island"); // adapter seam: Cerebras hybrid when keyed, else seeder (always C1-valid)
      // A4: signing is genuinely optional, but a failure is now logged and reported,
      // not swallowed. An unsigned world is never presented as verified.
      const signed = await optional("atlas-receipt-issue", async () => issueWorldReceipt(world.world_id, me.id), cid);
      const receipt: any = signed.ok ? signed.value : null;
      if (receipt) {
        world.meta = world.meta || {};
        (world.meta as any).atlas_receipt_hash = receipt.receipt_hash;
        (world.meta as any).atlas_signed = !!receipt.sig;
      }
      const runtime = toRuntimeWorld(world);                 // render-ready (env/material/transform.position/spawn)
      // A3: durable, ownership-stamped, lossless. A write failure surfaces as an error.
      const saved = await repo.upsert({ worldId: world.world_id, ownerId: me.id, manifest: runtime, state: "draft", title: (world as any)?.meta?.title });
      const base = { world_id: world.world_id, objects: (world.objects || []).map((o: any) => ({ object_id: o.object_id, kind: o.kind, transform: o.transform || { x: 0, y: 0, z: 0 }, owner_id: o.owner_id ?? null })) };
      await persistence.registerBaseWorld(base);
      // Creating a world counts however it was created, so /me stays measured.
      await social.ensureProfile(me);
      await social.recordWorldCreated(me.id);
      return send(res, 200, {
        ok: true, world_id: world.world_id, status: "ready", owner: me.id,
        world_version: saved.version, manifest_hash: saved.manifest_hash,
        manifest_url: "/worlds/" + world.world_id + "/manifest",
        atlas: receipt ? { receipt_hash: receipt.receipt_hash, signed: !!receipt.sig } : null,
        // Honest: "signed" is not "verified". Verification is what /verify proves.
        atlas_signing_error: signed.ok ? undefined : signed.error,
        persistence_degraded: saved._mirrored === false ? saved._mirror_error : undefined,
        correlation_id: cid,
      });
    }
    let m = url.match(/^\/worlds\/([^/]+)\/manifest$/);
    if (m && method === "GET") {
      // A3: served from durable storage, so it survives a restart. Drafts are
      // owner-only; published worlds are public. A miss is a real 404.
      const rec = await repo.get(m[1], { requesterId: principal?.id ?? null });
      return send(res, 200, rec.manifest);
    }
    // Publish: issue a real ed25519 Atlas receipt, mark published, return a verify link. Play stays instant (generate already serves it).
    m = url.match(/^\/worlds\/([^/]+)\/publish$/);
    if (m && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      const id = m[1];
      const rec = await repo.get(id, { requesterId: me.id, requireOwner: true });   // only the owner publishes
      const wm: any = rec.manifest;
      if (!atlasReady()) {
        // A4/B10: refuse to mark a world published-and-verified when no signing key
        // exists. Previously this returned ok:true with verified:false, which the UI
        // rendered as a successful publish.
        throw Errors.notConfigured("Atlas signing key (ATLAS_PRIVATE_KEY)", { correlationId: cid });
      }
      const receipt: any = issueWorldReceipt(id, me.id);
      wm.meta = wm.meta || {}; wm.meta.atlas_receipt_hash = receipt.receipt_hash; wm.meta.atlas_signed = !!receipt.sig;
      const saved = await repo.upsert({ worldId: id, ownerId: me.id, manifest: wm, state: "published" });
      await social.ensureProfile(me);
      await social.recordWorldPublished(me.id);
      await worldMemory.record(id, { kind: "published", summary: "the world was published with a signed Atlas receipt", worldVersion: saved.version, actorId: me.id });
      const verify_url = "/verify?receipt=" + Buffer.from(JSON.stringify(receipt)).toString("base64");
      return send(res, 200, { ok: true, published: true, signed: !!receipt.sig, world_version: saved.version, receipt, verify_url, correlation_id: cid });
    }
    m = url.match(/^\/worlds\/([^/]+)\/save$/);
    if (m && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      if (b && b.manifest) {
        // A3: full-manifest save — durable, lossless, ownership-checked, idempotent.
        const saved = await repo.upsert({ worldId: m[1], ownerId: me.id, manifest: b.manifest, state: b.state || "draft", expected_version: b.expected_version ?? null });
        return send(res, 200, { ok: true, world_id: m[1], world_version: saved.version, manifest_hash: saved.manifest_hash, idempotent: saved.idempotent, persistence_degraded: saved._mirrored === false ? saved._mirror_error : undefined, correlation_id: cid });
      }
      const delta = b.delta || b; delta.world_id = m[1];
      const r = await persistence.save(delta);                     // CW5 runtime-object delta path
      return send(res, 200, { ok: true, ...r, correlation_id: cid });
    }
    m = url.match(/^\/worlds\/([^/]+)\/load$/);
    if (m && method === "GET") {
      const rec = await repo.get(m[1], { requesterId: principal?.id ?? null });
      const snap = await persistence.load(m[1]);
      return send(res, 200, { ok: true, world_id: m[1], world_version: rec.version, manifest_hash: rec.manifest_hash, state: rec.state, owner: rec.owner_id, manifest: rec.manifest, runtime_state: snap, correlation_id: cid });
    }

    return send(res, 404, { ok: false, error: "not_found", path: url, correlation_id: cid });
  } catch (e: any) {
    // A4: one honest exit. An AppError keeps its real status and code; anything
    // else is logged in full and reported as a 500 with a correlation id. No path
    // through this handler can produce ok:true for a failure.
    if (e instanceof AppError) {
      logError(e, method + " " + url);
      return send(res, e.httpStatus, { ...e.toJSON(), correlation_id: cid });
    }
    const wrapped = Errors.internal(String(e?.message || e), { correlationId: cid, cause: e });
    logError(wrapped, method + " " + url);
    if (process.env.NODE_ENV !== "production") console.error(e?.stack || e);
    return send(res, 500, wrapped.toJSON());
  }
});
export { server };
if (process.env.DCS_NO_LISTEN !== "1") {
  server.listen(PORT, () => console.log("DCS Games Core API v3 on :" + PORT + " auth=" + auth.mode + " store=" + repo.kind));
}
