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
import { createIdentityStore, handleIdentity, retiredSocialRoutes } from "./src/cw1/identity-slice.mjs";
import { handleTrustSafetySSO } from "./src/cw1/ts-sso-kyc-slice.mjs"; // CW1 v3.0: T&S console + payout-KYC, reconciled to gateway auth
import { makeAtlasRoutes } from "./src/cw7/atlas-routes.mjs";
import { verifyPageHTML } from "./src/cw7/atlas-verify-page.mjs"; // CW7: renderable public verify view
import { makeKeyEndpoint } from "./src/cw7/atlas-key.mjs";       // CW7: GET /atlas/key (real ed25519 public key from env, honest when unset)
import { atlasReady, verifyReceipt, atlasPublicKeyBase64, issueWorldReceipt, signedFields } from "./src/cw7/atlas-local-sign.mjs"; // CW7: local ed25519 sign+verify (off-chain, no gas)
import { makeCrossProductRouter } from "./src/cw7/atlas-cross-product.mjs"; // CW7 v4.0: cross-product reputation (node-http routeTable)
import { createEconomyRouter } from "./src/cw6/economy-router.mjs";          // CW6 v3.0: economy routes (DARK), non-express fallback router
import { LANES } from "./src/v3/providers/contract.mjs";                        // B11: media lane
import { createAssemblyRouter } from "./src/v3/router/assembly.mjs";            // B1: multi-provider world assembly
import { validateManifest, MANIFEST_VERSION } from "./src/v3/manifest/schema.mjs"; // B0: canonical world contract
import { ensureV3 } from "./src/v3/manifest/migrate.mjs";                       // B0: v1 -> v3 upgrade
import { playtestAndRepair } from "./src/v3/playtest/agent.mjs";                // B4: playtest -> critic -> repair
import { planExpansion, planEdit } from "./src/v3/expansion/planner.mjs";       // B6/B8: expansion + chat editing
import { forkWorld, attributionChain, forkPolicyOf, FORK_POLICIES } from "./src/v3/expansion/fork.mjs"; // remix/fork with provenance
import { planStitch, recordStitch, stitchSummary, checkStitchPermission } from "./src/v3/expansion/stitch.mjs"; // 9.2: world stitching
import { applyDelta, verifyPreservation, emptyLiveState, newDelta } from "./src/v3/expansion/delta.mjs";
import { planRollback, recordRollback } from "./src/v3/expansion/rollback.mjs";              // B6: rollback as a new version, never a rewind
import { diffManifests } from "./src/v3/expansion/diff.mjs";                 // B6: what actually changed between two versions
import { createSubscriptionsService } from "./src/core/subscriptions.mjs";
import path from "node:path";
import { createCollection } from "./src/core/collection.mjs";                 // durable rows for the issued-receipt store
import { createLiveStateService, mergeLiveState, cw5RuntimeStateSource, companionMemorySource } from "./src/core/livestate.mjs";
import { readBuildInfo } from "./src/core/build-info.mjs";
import { createPlayerProgressService, playerProgressSources } from "./src/core/playerprogress.mjs";  // what the SERVER observed a player do  // B2: the server reads player-held state instead of asking the client for it   // B15: subscriptions, built DARK — nothing is purchasable
import { createWorldMemory } from "./src/v3/memory/world-memory.mjs";           // B7: factual world chronology
import { createCompanionService } from "./src/v3/companion/companion.mjs";      // B5: personal AI companion
import { createNpcMemory } from "./src/v3/companion/npc-memory.mjs";            // 9.5: NPC memory + procedural quests from RECORDED state
import { createVerificationService } from "./src/core/verification.mjs";       // P2: email/phone verification with a real provider seam
import { createJobService } from "./src/core/jobs.mjs";                        // P1: asynchronous world generation
import { createMarketplaceService } from "./src/core/marketplace.mjs";        // B15: marketplace backend, money DARK
import { createProgressionService } from "./src/core/progression.mjs";        // B15: retention from measured data only
import { createSocialService } from "./src/core/social.mjs";                    // B15: durable profiles, friends, parties, teams, studios, discovery
import { createSafetyService } from "./src/core/safety.mjs";                    // A5: age tiers, consent, report/block, moderation audit
import { assertSchema, currentVersion } from "./src/core/schema.mjs";           // A2: boot-time schema assertion — refuse to serve an unsupported schema
import { createWorldRepository, manifestHash } from "./src/core/worldstore.mjs";          // A3: durable, lossless, idempotent, ownership-aware world persistence
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
// CW7 v4.0 cross-product reputation. The Sports product is a separate service;
// set DCS_SPORTS_IDENTITY_URL to wire it. Until then this resolves to nothing and
// the endpoint reports honestly empty rather than inventing a unified score.
const SPORTS_URL = (process.env.DCS_SPORTS_IDENTITY_URL || "").replace(/\/$/, "");
const SPORTS_KEY = process.env.DCS_SPORTS_IDENTITY_KEY || "";
const crossProductStatus = SPORTS_URL && SPORTS_KEY ? "AVAILABLE" : "UNAVAILABLE";
const crossProduct = makeCrossProductRouter({ resolveProductIdentities: (_id: string) => [] });
// CW6 v3.0: DARK; constructed with no database client, so its live branch is
// unreachable by construction.
//
// DO NOT DELETE THIS AS DEAD CODE. It looks unused — nothing dispatches it —
// but the retirement block below reads `econRouter._routes` to decide which
// paths answer 410. That is what stops the retired-route list drifting from the
// routes that actually used to exist. Removing this construction makes every
// CW6 path fall through to the catch-all 404 instead of the 410 that names its
// replacement, and the server stops booting. (Tried it; 92 API tests failed.)
const econRouter: any = createEconomyRouter({});
const v3 = createAssemblyRouter();                                           // B1
const worldMemory = createWorldMemory();                                     // B7
const companions = createCompanionService({ worldMemory });                  // B5
const npcMemory = createNpcMemory({ worldMemory });                          // 9.5
// B2: what players actually hold, read from the estate's own records.
// Every route that can destroy content used to take this from the REQUEST BODY,
// so the protection was opt-in by the caller it protects against: omitting
// live_state left inventory, companion memory and quest progress unchecked.
// Issued Atlas receipts, kept so a third party can actually FETCH one.
// The embed snippet and its descriptor both told external sites to
// GET /api/atlas/receipt/:id and no such route existed, so every embedded
// badge resolved a 404 and showed UNVERIFIABLE. A public verification
// ecosystem that cannot serve the document being verified is not one.
const atlasReceipts = createCollection({
  dir: path.join(process.env.DCS_DATA_DIR || path.join(process.cwd(), ".dcs-data"), "atlas"),
  name: "receipts", table: null, primaryKey: ["receipt_hash"], env: process.env,
});
const playerProgress = createPlayerProgressService();
// The quest and NPC seams were null sources that refused rather than pretended.
// They now read what the server itself OBSERVED — a spawn placement it performed
// and a dialogue turn it served — never a claim a client sent. They report
// PARTIAL, so those categories are still never counted as fully determined.
const liveStateSvc = createLiveStateService({
  persistence, companions,
  sources: [
    cw5RuntimeStateSource({ persistence }),
    companionMemorySource({ companions }),
    ...playerProgressSources({ progress: playerProgress }),
  ],
});
const market = createMarketplaceService();                                   // B15: prepared, and dark at the schema level
const verification = createVerificationService();                            // P2
const jobsvc = createJobService();                                           // P1: async generation
// A job left "running" by a previous process is marked interrupted here. Without
// this it would report "running" forever, which the UI would faithfully repeat.
const BOOT_ID = crypto.randomUUID();
const bootReconcile = await jobsvc.reconcileOnBoot(BOOT_ID);
if (bootReconcile.interrupted) console.warn("P1 jobs marked interrupted on boot:", bootReconcile.interrupted);
const subs = createSubscriptionsService();                                    // B15: no PSP, so nothing can be bought; internal testers can be comped
const safety = createSafetyService();                                        // A5: real persistence, so moderation output can never be faked
// social is constructed AFTER safety and subs because it takes both as required
// collaborators. A live block must stop a friendship forming through EVERY path,
// not only the one route that remembered to check — so the check lives in the
// service and cannot be constructed away. And a comped tester's profile must
// report the allowance they actually have, while still never reading as revenue.
const social = createSocialService(process.env, { safety, subscriptions: subs });
const progression = createProgressionService({ social, worldMemory });
const repo = createWorldRepository();                                        // A3: replaces the process-local Map + swallowed best-effort insert
console.log("A3 world store:", repo.kind);

// A2: when a direct Postgres DSN is configured, assert the schema BEFORE serving.
// An unsupported schema must stop the process, not surface later as empty data.
const BUILD_INFO = readBuildInfo();
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

// A1: refuse to SERVE with a per-boot random secret.
//
// createPrincipalResolver falls back to "local-hs256-ephemeral" — a secret
// generated fresh on every start — when neither Supabase nor DCS_AUTH_SECRET is
// configured. That is a reasonable default for a library used in a test, and a
// silent disaster for a deployment: every token becomes invalid on restart, so
// every user is signed out by a deploy and nobody is told why. Worse, it looks
// exactly like a working configuration until the first restart.
//
// The library keeps the fallback; the SERVER refuses it, because the server is
// the thing that gets deployed. Opting in has to be deliberate and has to be
// written down somewhere a reviewer can see it.
if (auth.mode === "local-hs256-ephemeral" && process.env.DCS_ALLOW_EPHEMERAL_AUTH !== "1") {
  console.error(JSON.stringify({
    level: "fatal",
    auth: auth.mode,
    detail: "Refusing to start: no SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY and no DCS_AUTH_SECRET, so the auth secret would be random per boot and every token would stop working at the next restart.",
    fix: "Set DCS_AUTH_SECRET (or configure Supabase). For a throwaway local run only, set DCS_ALLOW_EPHEMERAL_AUTH=1 to accept tokens that die with the process.",
    ts: new Date().toISOString(),
  }));
  process.exit(78);   // EX_CONFIG, as the schema assertion uses
}
console.log("A1 auth mode:", auth.mode);

const atlasKey = makeKeyEndpoint({ publicKey: () => atlasPublicKeyBase64() || process.env.ATLAS_PUBLIC_KEY || "" }); // prefer the raw key derived from the signer (matches sig + browser-embed verifiable)

/**
 * Which origins may call this API from a browser.
 *
 * Every response used to carry `Access-Control-Allow-Origin: *` unconditionally,
 * which made the ALLOWED_ORIGINS variable dead configuration — it sat in the
 * Railway environment looking exactly like a security control and enforced
 * nothing. A setting that appears to restrict something and does not is worse
 * than no setting, because it is believed.
 *
 * With ALLOWED_ORIGINS unset the answer is still `*`. That is deliberate: a
 * local or freshly provisioned instance should not be mysteriously unreachable,
 * and /health says which mode is in force so it cannot be assumed. When the
 * variable IS set, only the listed origins are echoed; anything else gets no
 * ACAO header at all and the browser blocks the read.
 *
 * A leading `*.` entry matches one level of subdomain, which is what Cloudflare
 * preview deployments need — every preview gets a fresh `<hash>.<project>.pages.dev`
 * host, so listing them individually is impossible.
 */
const ALLOWED_ORIGINS: string[] = String(process.env.ALLOWED_ORIGINS || "")
  .split(",").map((o) => o.trim()).filter(Boolean);
export const CORS_MODE = ALLOWED_ORIGINS.length ? "allowlist" : "open";

export function originAllowed(origin: string, allowed: string[] = ALLOWED_ORIGINS): boolean {
  if (!allowed.length) return true;
  if (!origin) return false;

  // Split scheme from host on both sides. An earlier version tested
  // `entry.startsWith("*.")`, which is false for the way these are actually
  // written — `https://*.dcs-games.pages.dev` — so no wildcard ever matched
  // and every preview would have been blocked.
  const split = (v: string) => {
    const m = /^(https?:\/\/)?(.*)$/.exec(v.trim());
    return { scheme: (m?.[1] || "").toLowerCase(), host: (m?.[2] || "").toLowerCase() };
  };
  const o = split(origin);

  for (const raw of allowed) {
    if (raw === "*") return true;
    const e = split(raw);
    if (e.scheme && o.scheme && e.scheme !== o.scheme) continue;
    if (e.host === o.host) return true;
    if (e.host.startsWith("*.")) {
      const suffix = e.host.slice(1);                // "*.example.com" -> ".example.com"
      // Exactly one level. The dot is required, so "evil-example.com" cannot
      // pass as ".example.com", and "a.b.example.com" is a different host.
      if (o.host.endsWith(suffix)) {
        const label = o.host.slice(0, -suffix.length);
        if (label.length > 0 && !label.includes(".")) return true;
      }
    }
  }
  return false;
}

/** CORS headers for this particular response, based on the origin that asked. */
function corsFor(res: http.ServerResponse) {
  const origin = (res as any).__dcsOrigin || "";
  if (!ALLOWED_ORIGINS.length) {
    return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "*" };
  }
  const h: Record<string, string> = {
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
    // The answer depends on the request's Origin, so caches must key on it.
    Vary: "Origin",
  };
  if (originAllowed(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function send(res: http.ServerResponse, code: number, body: any) {
  res.writeHead(code, { "Content-Type": "application/json", ...corsFor(res) });
  res.end(JSON.stringify(body));
}
function sendHTML(res: http.ServerResponse, code: number, html: string) {
  const { "Access-Control-Allow-Origin": acao, Vary } = corsFor(res) as any;
  const h: Record<string, string> = { "Content-Type": "text/html; charset=utf-8" };
  if (acao) h["Access-Control-Allow-Origin"] = acao;
  if (Vary) h.Vary = Vary;
  res.writeHead(code, h);
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
/**
 * Live state for a world, determined by the SERVER, with any client-supplied
 * state folded in additively on top.
 *
 * Client evidence can only ever ADD a hold, never remove one, so omitting
 * `live_state` is no longer a way to opt out of the check that stops a rollback
 * or an expansion deleting a player's property.
 */
/**
 * Register a v3 world with the CW5 persistence engine.
 *
 * Only the legacy POST /worlds/generate did this, so worlds made through the v3
 * stack — which is every world made today — had no base world. persistence.load()
 * then THROWS for them, which meant the two live-state categories that DO have a
 * real durable source (owned entities and inventory) reported UNAVAILABLE for
 * exactly the worlds people create. The protection was honest about being blind,
 * but it was blind.
 *
 * A v3 structure id IS the CW5 object id — src/v3/manifest/migrate.mjs maps
 * objects[].object_id to structures[].id — so the base is derived from the
 * manifest rather than invented.
 */
async function registerV3BaseWorld(worldId: string, manifest: any, cid: string) {
  const objects = (manifest?.structures || []).map((sct: any) => ({
    object_id: sct.id,
    kind: sct.kind || sct.archetype || "structure",
    transform: sct.transform?.position || sct.position || { x: 0, y: 0, z: 0 },
    owner_id: sct.owner_id ?? null,
  }));
  // Best effort by design: a world must still be created if the runtime engine
  // is unavailable. It is reported rather than swallowed, and liveStateFor will
  // then say it could not determine ownership rather than saying nothing is held.
  return await optional("cw5-register-base-world", () => persistence.registerBaseWorld({ world_id: worldId, schema_version: "1.0", objects }), cid);
}

async function liveStateFor(worldId: string, supplied: any) {
  const determined = await liveStateSvc.liveStateFor(worldId);
  const merged = mergeLiveState(determined.live_state, supplied || null);
  return {
    live: merged.live_state,
    determined,
    added: merged.added,
    supplied: !!supplied && Object.keys(supplied).length > 0,
  };
}

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

async function supaGet(pathq: string, cid?: string): Promise<any[]> {
  if (!HAS_SUPA) return [];
  // A rejected key, a missing table and a genuinely empty result used to be one
  // answer — an empty array, which the handlers then sent as
  // {ok:true, count:0, source:"supabase"}. That is a fabricated measurement of
  // zero, and it is exactly what errors.mjs exists to prevent: a degraded read
  // must be visible. An upstream failure is now an upstream failure.
  let r: Response;
  try {
    r = await fetch(SUPA + "/rest/v1/" + pathq, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  } catch (e: any) {
    throw Errors.upstream("supabase", String(e?.message || e), { correlationId: cid });
  }
  if (!r.ok) throw Errors.upstream("supabase", `HTTP ${r.status} for ${pathq.split("?")[0]}`, { correlationId: cid });
  return await r.json();
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
  // Carried on the response, not in a module variable: handlers await, and a
  // shared variable would hand one request's origin to another's reply.
  (res as any).__dcsOrigin = (req.headers.origin as string) || "";
  try {
    if (method === "OPTIONS") return send(res, 204, {});
    if (url === "/health" && method === "GET") return send(res, 200, {
      ok: true, service: "dcs-games-backend", payments_live: PAYMENTS_LIVE,
      build: BUILD_INFO,
      cors: { mode: CORS_MODE, allowed: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : null },
      auth: auth.mode,
      auth_header_fallback_removed: true,      // A1: x-user-id impersonation path deleted 6 Sep 2026
      internal_testing_window_ends: "2026-09-30",
      persistence: repo.kind,
      schema_assertion: SCHEMA_STATE,
      generation: GEN_MODE,
      lanes: ["cw1-identity", "cw2-generation", "cw5-persistence", "cw7-atlas"],
      schema: "runtime-ready (cw2 toRuntimeWorld; zero runtime patches)",
      // A hand-maintained route list drifts the moment someone adds a route and
      // forgets. This is the real surface, grouped, and a test asserts every one
      // of them actually responds.
      // A route list without methods is not a description of the surface: half
      // these paths only answer POST, and a GET against them is a plain 404.
      // Each entry carries its method so a drift check can actually probe it.
      routes: {
        // The V2 surface is still live and still carries real traffic; leaving
        // it out of the inventory made it look retired when it is not.
        world_v2: ["POST /worlds/generate", "GET /worlds/mine", "GET /worlds/:id/manifest", "POST /worlds/:id/save", "GET /worlds/:id/load", "POST /worlds/:id/publish"],
        world: ["POST /v3/worlds/generate", "POST /v3/worlds/generate/async", "GET /v3/worlds/:id/manifest", "POST /v3/worlds/:id/playtest", "POST /v3/worlds/:id/expand", "POST /v3/worlds/:id/edit", "POST /v3/worlds/:id/stitch", "POST /v3/worlds/:id/fork", "GET /v3/worlds/:id/versions", "POST /v3/worlds/:id/rollback", "GET /v3/worlds/:id/diff", "GET /v3/worlds/:id/memory", "POST /v3/worlds/:id/companion", "POST /v3/worlds/:id/media", "GET /v3/worlds/:id/attribution", "GET /v3/worlds/:id/parts", "POST /v3/worlds/:id/quests/generate", "POST /v3/worlds/:id/stitch/preview", "GET /v3/worlds/:id/versions/:n", "GET /v3/worlds/:id/npcs/:npc/memory"],
        discovery: ["GET /v3/discover", "GET /api/public/worlds", "GET /api/public/stats", "POST /v3/worlds/:id/play", "POST /v3/worlds/:id/rate", "GET /v3/worlds/:id/stats"],
        identity: ["POST /auth/signup", "POST /auth/login", "GET /me/home", "GET /me/profile", "GET /me/achievements", "GET /me/streak", "GET /me/dashboard", "GET /profiles/:username", "GET /verify/status", "POST /verify/:channel/start", "POST /verify/:channel/confirm"],
        social: ["GET /social/friends", "POST /social/friends/accept", "GET /social/parties", "GET /social/teams", "POST /social/studios", "GET /social/orgs", "GET /social/orgs/:id", "POST /social/orgs/:id/members", "DELETE /social/orgs/:id/members", "POST /social/orgs/:id/seats", "GET /social/parties/:id", "POST /social/parties/:id/join", "POST /social/parties/:id/leave", "GET /social/studios/:id", "POST /social/studios/:id/members", "POST /social/studios/:id/split", "GET /social/teams/:id", "POST /social/teams/:id/members", "DELETE /social/teams/:id/members"],
        marketplace: ["GET /v3/marketplace", "GET /v3/marketplace/split", "POST /v3/marketplace/storefronts", "POST /v3/marketplace/listings", "DELETE /v3/marketplace/listings/:id", "POST /v3/marketplace/listings/:id/acquire", "GET /v3/marketplace/owned", "GET /v3/marketplace/ledger", "GET /v3/marketplace/assert-dark"],
        subscriptions: ["GET /v3/subscriptions/plans", "POST /v3/subscriptions/subscribe", "POST /v3/subscriptions/grant", "POST /v3/subscriptions/revoke", "GET /v3/subscriptions/grants", "GET /v3/subscriptions/assert-dark", "GET /me/subscription", "GET /me/entitlements"],
        safety: ["GET /safety/age", "GET /safety/blocks", "POST /safety/consent/parental", "POST /safety/report", "GET /safety/reports", "POST /safety/block", "GET /safety/consent/media", "GET /safety/moderation-history", "POST /safety/reports/:id/moderate"],
        jobs: ["GET /v3/jobs", "GET /v3/jobs/:id"],
        trust: ["GET /health", "GET /atlas/key", "DELETE /verify/:channel", "GET /atlas/receipt/:id", "GET /verify", "GET /v3/providers"],
        retired: ["GET /api/marketplace (410)", "GET /api/me/payouts (410)", "GET /me/revenue (410)", ...retiredSocialRoutes()],
      },
      manifest_version: MANIFEST_VERSION,
      social: { profiles: true, friends: true, parties: true, teams: true, studios: true, discovery: true, ...social.describe() },
      safety_persistence: safety.describe(),
      verification: verification.describe(),
      live_state: liveStateSvc.describe(),
      player_progress: playerProgress.describe(),
      cross_product: {
        status: crossProductStatus,
        products: crossProductStatus === "AVAILABLE" ? ["games", "sports"] : ["games"],
        note: crossProductStatus === "AVAILABLE" ? null : "No second product is wired, so a cross-product reputation cannot be computed. The endpoint returns an honest empty result rather than a score.",
      },
      marketplace: { ...market.describe(), legacy_cw6_routes: "retired (410)" },
      // Reported so /health cannot imply a capability that is absent: there is
      // no PSP, so nothing is subscribable, and the endpoint says so rather
      // than letting a caller infer it from the presence of a plans route.
      subscriptions: subs.describe(),
      jobs: { async_generation: true, boot_id: BOOT_ID, interrupted_on_boot: bootReconcile.interrupted },
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
      // This asked the database for EVERY row with EVERY column and answered it
      // to an anonymous caller: no state filter, no owner filter, whole
      // manifests. Unpublished drafts, in other words, on a route named public.
      // It was invisible to every test because in file mode supaGet returns [].
      // It now goes through the repository, which applies the same permission
      // rules as every other read and returns discovery cards, not manifests.
      const worlds = await repo.listPublished(50);
      return send(res, 200, { ok: true, count: worlds.length, worlds, source: repo.kind });
    }
    // Public platform figures, MEASURED.
    //
    // The site called /api/public/stats and nothing served it, so every page
    // showing a platform number fell back to the bundled SEED sample set. That
    // is the exact failure assets/dcs-truth.js was written to prevent after a
    // forensic audit found the site asserting $1.5M paid to creators, 842,000
    // items sold and 12.4M players — figures no system had ever measured.
    //
    // Every number here is counted from the store at request time. There is no
    // branch that estimates, projects or rounds up, and a platform with nothing
    // on it answers zero rather than something encouraging. `measured_at` and
    // `source` are included so a caller can tell a real count from a cache.
    if (url === "/api/public/stats" && method === "GET") {
      const published = await repo.listPublished(1000);
      const statsFor = await social._statsIndex();
      let plays = 0, seconds = 0, rated = 0;
      const creators = new Set<string>();
      for (const w of published) {
        if (w.owner_id) creators.add(String(w.owner_id));
        const st: any = statsFor(w.world_id);
        plays += st.plays || 0;
        seconds += st.total_seconds || 0;
        rated += st.rating_count || 0;
      }
      return send(res, 200, {
        ok: true,
        published_worlds: published.length,
        creators_with_a_published_world: creators.size,
        plays,
        play_seconds: seconds,
        ratings: rated,
        // Deliberately ABSENT: a platform-wide unique player count. The stats
        // index exposes unique players per world, and summing that across
        // worlds counts anyone who played two of them twice. A number labelled
        // "unique players" that is not unique is exactly the kind of figure the
        // truth layer exists to keep off this site, and no number is better
        // than a wrong one.
        unique_players: null,
        unique_players_note: "not counted platform-wide; summing per-world uniques would double-count anyone who played more than one world",
        // Said plainly: these are counts of what exists, not projections, and
        // the listing they are counted over is capped.
        basis: "counted from the world store and measured play/rating records at request time",
        counted_over: Math.min(published.length, 1000),
        measured_at: new Date().toISOString(),
        source: repo.kind,
      });
    }

    // The signed-in landing page, from the caller's own real records.
    // Reached as /api/me/home too: server.mts:375 rewrites /api/* to /* for
    // everything except /api/public/*, so this is the one canonical path.
    if (url === "/me/home" && method === "GET") {
      const me = await mustBe(req, cid);
      const [mine, profile] = await Promise.all([
        repo.listOwned(me.id, 50),
        social.me(me).catch(() => null),
      ]);
      const statsFor = await social._statsIndex();
      let plays = 0;
      for (const w of mine) plays += (statsFor(w.world_id) as any)?.plays || 0;
      return send(res, 200, {
        ok: true,
        principal_id: me.id,
        profile,
        worlds: { total: mine.length, published: mine.filter((w: any) => w.state === "published").length, drafts: mine.filter((w: any) => w.state !== "published").length },
        plays_of_my_worlds: plays,
        recent: mine.slice(0, 8).map((w: any) => ({ world_id: w.world_id, title: w.title, state: w.state, version: w.version, updated_at: w.updated_at })),
        measured_at: new Date().toISOString(),
      });
    }

    if (url === "/worlds/mine" && method === "GET") {
      const me = await mustBe(req, cid);                       // A1: 401 when unauthenticated
      const rows = await supaGet("dcsgames_base_worlds?owner_id=eq." + encodeURIComponent(me.id) + "&select=*&limit=50");
      return send(res, 200, { ok: true, count: rows.length, worlds: rows, owner: me.id });
    }
    if (url === "/me/revenue" && method === "GET") {
      // RETIRED. This answered 200 with hard-coded zeros and a 70/30 split that
      // settles nothing. A 200 invites a client to render "your revenue: 0" as
      // though it were a measurement, and invites a developer to build on a
      // shape no service produces. There is no revenue while payments are dark,
      // and saying so with a 410 is the honest answer — the same treatment the
      // CW6 economy routes got.
      return send(res, 410, {
        ok: false, error: "gone",
        detail: "Revenue reporting does not exist. Payments are dark: no sale can occur, so there is nothing to report. This route previously returned hard-coded zeros, which was indistinguishable from a real measurement of zero.",
        replacement: "/v3/marketplace/ledger for test-mode acquisitions, /v3/marketplace/assert-dark to confirm nothing has been sold",
        payments_live: PAYMENTS_LIVE, correlation_id: cid,
      });
    }

    // ---- REAL AUTH: proxy signup/login to Supabase Auth (returns a real JWT) ----
    const ANON = process.env.SUPABASE_ANON_KEY || KEY;
    // Without Supabase these fell through to the legacy-auth retirement, which
    // answers 410 with `superseded_by` naming the route the caller just called.
    // The retirement is correct — the old handler took a principal id from the
    // request body with no credential — but a retirement notice is not an
    // implementation, and pointing it at itself tells a reader the endpoint
    // moved when in fact nothing is there. Staging and production configure
    // Supabase, so this bites local and CI runs, which is where someone is most
    // likely to be trying to understand why login does not work.
    if (!HAS_SUPA && method === "POST" && (url === "/auth/signup" || url === "/auth/login")) {
      throw Errors.notConfigured(
        "email/password authentication (SUPABASE_URL and SUPABASE_ANON_KEY are not set on this deployment)",
        { correlationId: cid, meta: { auth_mode: auth.mode } }
      );
    }
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
    // The slice serves /payout/kyc and /payout/kyc/start; there is no /kyc/...
    // path in it at all, so that prefix gated NOTHING and the payout-KYC shell
    // was reachable by any authenticated caller. The gate now names the prefixes
    // the slice actually serves.
    if (url.startsWith("/ts/") || url.startsWith("/kyc/") || url.startsWith("/payout/")) {
      await mustBeInternalTester(req, cid);   // T&S console + payout KYC: internal testers only
    }
    if (await handleTrustSafetySSO(req, res, { user: principal ? { id: principal.id } : null, send, body: readBody, db: { mode: "memory" } })) return; // T&S/KYC (in-memory repo; DARK). Supabase persistence = follow-up migration 0002

    // ---- CW7 public trust surface ----
    if (url === "/atlas/key" && method === "GET") return send(res, 200, atlasKey.key());
    {
      // The receipt an embedded badge fetches. PUBLIC and unauthenticated by
      // design: the entire point is that a third party can check our attestation
      // without asking us to be trusted. Served in CANONICAL form — aliases
      // resolved, fallbacks applied — so a verifier that follows /atlas/key
      // rebuilds exactly the bytes the key signed. Both /api/... and the bare
      // path answer, because the snippet has always used the /api prefix.
      const rm = url.match(/^(?:\/api)?\/atlas\/receipt\/([^/]+)$/);
      if (rm && method === "GET") {
        const row: any = await atlasReceipts.one((x: any) => x.receipt_hash === rm[1] || x.receipt?.receipt_id === rm[1]);
        if (!row) throw Errors.notFound(`atlas receipt ${rm[1]}`, { correlationId: cid });
        const r = row.receipt;
        return send(res, 200, {
          ok: true,
          ...signedFields(r),                       // the canonical body, field for field
          sig: r.sig, signer: r.signer, ts: r.ts, receipt_hash: r.receipt_hash,
          canonical: true,
          note: "Rebuild the signed body from GET /atlas/key's canonical_fields, canonical_aliases and canonical_fallbacks, then verify sig against public_key.",
          correlation_id: cid,
        });
      }
    }
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

    // CW6 economy routes — RETIRED in favour of /v3/marketplace.
    //
    // Round-2 called this "doubly dark": the router was constructed with no
    // database client so its live branch was unreachable, and its three tables
    // did not exist. Its checkout also derived the buyer from the x-user-id
    // header, which is the impersonation path A1 removed.
    //
    // /v3/marketplace replaces it with a durable store, real authorisation, and
    // a money guard enforced by CHECK constraints rather than by convention.
    // Keeping two economy surfaces alive is how one of them quietly rots, so
    // this one answers 410 and names its replacement.
    {
      const r = (econRouter as any)._routes.find((x: any) => x.method === method && x.path === apiPath);
      if (r) {
        const replacement = apiPath.startsWith("/api/me/payouts") ? "/v3/marketplace/ledger" : "/v3/marketplace";
        return send(res, 410, {
          ok: false, error: "gone",
          detail: "this economy surface had no durable store and derived its buyer from the x-user-id header; it has been retired",
          superseded_by: replacement,
          payments_live: PAYMENTS_LIVE,
          correlation_id: cid,
        });
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
      // A block with no subject used to answer 200. Someone who believes they
      // have blocked a person and has not is worse off than someone told the
      // call failed, so this refuses instead of quietly doing nothing.
      if (!b.blocked_id) throw Errors.validation("blocked_id is required: who is being blocked", { correlationId: cid });
      return send(res, 200, { ok: true, ...(await safety.block(me.id, b.blocked_id)) });
    }
    if (url === "/safety/block" && method === "DELETE") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      if (!b.blocked_id) throw Errors.validation("blocked_id is required: whose block is being lifted", { correlationId: cid });
      return send(res, 200, { ok: true, ...(await safety.unblock(me.id, b.blocked_id)) });
    }
    if (url === "/safety/blocks" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, blocked: await safety.blockList(me.id) });
    }
    if (url === "/safety/consent/parental" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      // requestedBy is the AUTHENTICATED caller, never a body field. Without it
      // safety.mjs refuses the whole route rather than write a consent record
      // that cannot be attributed to anyone — a forgeable row about a minor is
      // worse than no row.
      const r = await safety.requestParentalConsent(b.minor_id || me.id, {
        guardianEmail: b.guardian_email, scope: b.scope || [],
        isSynthetic: b.is_synthetic !== false, requestedBy: me.id,
      });
      return send(res, 201, { ok: true, consent: r, correlation_id: cid });
    }
    if (url === "/safety/consent/media" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      // The subject is the CALLER, and naming somebody else is REFUSED rather
      // than quietly redirected — a caller who believes they recorded a consent
      // for another person must be told they did not. This used to take the
      // subject from the request body with no check, so any account could grant
      // a voice-and-likeness consent for anybody and then pass the gate that
      // consent exists to hold shut.
      if (b.subject_id != null && String(b.subject_id) !== String(me.id)) {
        throw Errors.forbidden(
          "a person's voice and likeness consent can only be recorded by that person",
          { correlationId: cid, meta: { subject_id: b.subject_id } }
        );
      }
      const r = await safety.grantMediaConsent(me.id, { mediaKind: b.media_kind, source: b.source, evidenceRef: b.evidence_ref, grantedBy: me.id });
      return send(res, 201, { ok: true, consent: r, correlation_id: cid });
    }
    if (url === "/safety/consent/media" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, consents: await safety.mediaConsents(me.id) });
    }

    // ---- B15 marketplace. Prepared, gated, and DARK at the schema level ----
    if (url === "/v3/marketplace" && method === "GET") {
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      return send(res, 200, { ok: true, ...(await market.browse({ kind: q.get("kind"), sellerId: q.get("seller") })) });
    }
    if (url === "/v3/marketplace/storefronts" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      const b = await readBody(req);
      return send(res, 201, { ok: true, storefront: await market.createStorefront(me.id, { name: b.name, description: b.description, studioId: b.studio_id }) });
    }
    if (url === "/v3/marketplace/listings" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      const b = await readBody(req);
      // Only your own world may be listed.
      if (b.world_id) await repo.get(b.world_id, { requesterId: me.id, requireOwner: true });
      const listing = await market.createListing(me.id, {
        storefrontId: b.storefront_id, worldId: b.world_id, kind: b.kind || "world",
        title: b.title, description: b.description, priceMinor: b.price_minor ?? 0,
      });
      return send(res, 201, { ok: true, listing, payments_live: PAYMENTS_LIVE });
    }
    {
      let mm = url.match(/^\/v3\/marketplace\/listings\/([^/]+)$/);
      if (mm && method === "DELETE") {
        const me = await mustBeInternalTester(req, cid);
        return send(res, 200, { ok: true, listing: await market.unlist(me.id, mm[1]) });
      }
      mm = url.match(/^\/v3\/marketplace\/listings\/([^/]+)\/acquire$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        return send(res, 200, { ok: true, ...(await market.acquire(me.id, mm[1])) });
      }
    }
    // ---- B15 subscriptions, built DARK ------------------------------------
    // Nothing here can be bought. subscribe() refuses in BOTH PAYMENTS_LIVE
    // states because the refusal is on "no PSP is integrated", not on the flag —
    // flipping an environment variable must not be able to start taking money.
    // An internal tester can be COMPED, and the row says so forever, so no later
    // read or export can mistake a test grant for revenue.
    if (url === "/v3/subscriptions/plans" && method === "GET") {
      return send(res, 200, { ok: true, ...subs.plans(), correlation_id: cid });
    }
    if (url === "/v3/subscriptions/subscribe" && method === "POST") {
      const me = await mustBe(req, cid);
      const b = await readBody(req);
      // Always throws. The attempt is recorded first: a refused subscribe is
      // evidence of demand and must not vanish because it was correctly refused.
      return send(res, 200, { ok: true, ...(await subs.subscribe(me.id, b.plan || "dcs_plus")) });
    }
    if (url === "/v3/subscriptions/grant" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      const b = await readBody(req);
      const subjectId = String(b.principal_id || "").trim();
      if (!subjectId) throw Errors.validation("principal_id is required: who is being comped", { correlationId: cid });
      const subject = { id: subjectId, isInternalTester: auth.isInternalTesterId(subjectId) };
      const row = await subs.grantTestPlan(me, subject, b.plan || "dcs_plus", {
        reason: b.reason ?? null,
        // Absent means the service default (the window end). An explicit null
        // would mean "never expires", which the window does not permit.
        ...(b.expires_at === undefined ? {} : { expiresAt: b.expires_at }),
      });
      return send(res, 200, { ok: true, grant: row, payments_live: PAYMENTS_LIVE, correlation_id: cid });
    }
    if (url === "/v3/subscriptions/revoke" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      const b = await readBody(req);
      const pid = String(b.principal_id || "").trim();
      if (!pid) throw Errors.validation("principal_id is required: whose grant is being revoked", { correlationId: cid });
      return send(res, 200, { ok: true, grant: await subs.revokeTestPlan(me, pid), correlation_id: cid });
    }
    if (url === "/v3/subscriptions/grants" && method === "GET") {
      await mustBeInternalTester(req, cid);
      return send(res, 200, { ok: true, ...(await subs.listGrants()), correlation_id: cid });
    }
    if (url === "/v3/subscriptions/assert-dark" && method === "GET") {
      // Same shape as /v3/marketplace/assert-dark: a 500 if money is NOT dark,
      // so a monitor can watch this rather than trusting a claim in a document.
      const r = await subs.assertDark();
      return send(res, r.dark ? 200 : 500, { ok: r.dark, ...r, payments_live: PAYMENTS_LIVE, correlation_id: cid });
    }
    if (url === "/me/subscription" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, ...(await subs.statusFor(me.id)), correlation_id: cid });
    }
    if (url === "/me/entitlements" && method === "GET") {
      const me = await mustBe(req, cid);
      const profile = await social.me(me);
      return send(res, 200, {
        ok: true,
        ...(await subs.entitlementsFor(me.id, { level: profile.level, publishedCount: profile.worlds_published ?? 0 })),
        correlation_id: cid,
      });
    }

    if (url === "/v3/marketplace/owned" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, owned: await market.ownedBy(me.id), payments_live: PAYMENTS_LIVE });
    }
    if (url === "/v3/marketplace/ledger" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, ...(await market.ledgerFor(me.id)) });
    }
    if (url === "/v3/marketplace/split" && method === "GET") {
      // Modelling only: what a split WOULD be. It never settles anything.
      const q = new URLSearchParams((req.url || "").split("?")[1] || "");
      return send(res, 200, { ok: true, ...market.splitFor(q.get("gross_minor") || 0), payments_live: PAYMENTS_LIVE });
    }
    if (url === "/v3/marketplace/assert-dark" && method === "GET") {
      // A public, checkable statement that no money exists anywhere in here.
      const r = await market.assertDark();
      return send(res, r.dark ? 200 : 500, { ok: r.dark, ...r, payments_live: PAYMENTS_LIVE });
    }

    // ---- P2 verification. The code is never returned, in any mode. --------
    if (url === "/verify/status" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, ...(await verification.statusFor(me.id)), providers: verification.describe() });
    }
    {
      let mm = url.match(/^\/verify\/([^/]+)\/start$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        const dest = b.destination || (mm[1] === "email" ? me.email : null);
        if (!dest) throw Errors.validation(`a ${mm[1]} destination is required`, { correlationId: cid });
        return send(res, 200, { ok: true, ...(await verification.start(me.id, mm[1], dest)), correlation_id: cid });
      }
      mm = url.match(/^\/verify\/([^/]+)\/confirm$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        const r = await verification.confirm(me.id, mm[1], b.code);
        // Verification changes a trust signal, so the recomputed level is
        // returned with it and the profile picks it up on the next read.
        await social.setVerification(me.id, mm[1], true, r.dev_mode);
        return send(res, 200, { ok: true, ...r, profile: await social.me(me), correlation_id: cid });
      }
      mm = url.match(/^\/verify\/([^/]+)$/);
      if (mm && method === "DELETE") {
        const me = await mustBe(req, cid);
        const r = await verification.revoke(me.id, mm[1]);
        await social.setVerification(me.id, mm[1], false, false);
        return send(res, 200, { ok: true, ...r });
      }
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
      if (mm && method === "GET") {
        // A party's membership is not public. An invite-only party is refused
        // outright; an open one returns size and room, which is what a join
        // button needs — never the member list, the leader or the world.
        const me = await mustBe(req, cid);
        return send(res, 200, { ok: true, party: await social.getParty(mm[1], me.id) });
      }
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
      if (mm && method === "GET") {
        const me = await mustBe(req, cid);
        return send(res, 200, { ok: true, team: await social.getTeam(mm[1], me.id) });
      }
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

    // ---- B15 orgs. Durable, and the caller's role is actually checked. ----
    if (url === "/social/orgs" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      const b = await readBody(req);
      return send(res, 201, { ok: true, org: await social.createOrg(me.id, { name: b.name, seats: b.seats ?? 5 }) });
    }
    if (url === "/social/orgs" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, orgs: await social.myOrgs(me.id) });
    }
    {
      let mm = url.match(/^\/social\/orgs\/([^/]+)$/);
      if (mm && method === "GET") {
        const me = await mustBe(req, cid);
        return send(res, 200, { ok: true, org: await social.getOrg(mm[1], me.id) });
      }
      mm = url.match(/^\/social\/orgs\/([^/]+)\/members$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        return send(res, 200, { ok: true, org: await social.addOrgMember(me.id, mm[1], b.member_id, b.role || "member") });
      }
      if (mm && method === "DELETE") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        return send(res, 200, { ok: true, org: await social.removeOrgMember(me.id, mm[1], b.member_id) });
      }
      mm = url.match(/^\/social\/orgs\/([^/]+)\/seats$/);
      if (mm && method === "POST") {
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        return send(res, 200, { ok: true, org: await social.setOrgSeats(me.id, mm[1], b.seats), payments_live: PAYMENTS_LIVE });
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
        // Membership, not merely the tester allowlist: this returned the member
        // list with each member's principal id, role and revenue split to any
        // internal tester. Its three siblings — org, team and party — were all
        // closed this sprint; this is the one that was missed.
        const me = await mustBeInternalTester(req, cid);
        return send(res, 200, { ok: true, studio: await social.getStudio(mm[1], me.id) });
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
        // Which is exactly why it must be ATTRIBUTABLE. Anonymously, 25 requests
        // took a world from 0 to 25 plays and 360,000 seconds of watch time —
        // no credential, no rate limit, no dedupe — and /v3/discover ranks on
        // that. An engagement signal anyone can move without being anyone is
        // not a measurement.
        const me = await mustBe(req, cid);
        const b = await readBody(req);
        const rec = await repo.get(mm[1], { requesterId: me.id });
        await social.recordPlay(mm[1], me.id, b.seconds);
        {
          // The server placed this player at the world's spawn, so it can say so.
          // optional(), not required(): a progress-store failure must never fail a
          // play, and the degradation is honest — live state then reports the
          // category unknown rather than empty.
          const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
          await optional("player-progress-entry", () => playerProgress.recordWorldEntry({ principal: me, worldId: rec.world_id, manifest, worldVersion: rec.version }), cid);
          await optional("player-progress-reconcile", () => playerProgress.reconcileQuests({ principal: me, worldId: rec.world_id, manifest, worldVersion: rec.version }), cid);
        }
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
      if (mm && method === "GET") {
        // The ONLY world route that answered without asking whether the caller
        // may see the world. A draft's play counts, unique players and rating
        // were readable by anyone with the id — and it answered for worlds that
        // do not exist too. Every sibling route takes this permission check.
        await repo.get(mm[1], { requesterId: principal?.id ?? null });
        return send(res, 200, { ok: true, world_id: mm[1], stats: await social.worldStats(mm[1]) });
      }
    }

    // ================= DCS GAMES V3 =====================================
    if (url === "/v3/providers" && method === "GET") {
      // Honest provider status. Never claims a vendor that is not reachable.
      return send(res, 200, { ok: true, ...(await v3.describe()) });
    }

    // ---- P1 asynchronous generation -------------------------------------
    //
    // A premium-lane generation takes ~147s. Holding the request open times out
    // behind proxies and tells the creator nothing about which stage is running.
    if (url === "/v3/worlds/generate/async" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      await safety.requireCapability(me.id, "create");
      const b = await readBody(req);
      if (!b.prompt || typeof b.prompt !== "string") throw Errors.validation("prompt is required", { correlationId: cid });

      const worldId = "w3_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const job = await jobsvc.create({
        kind: "world_generate",
        principalId: me.id,
        bootId: BOOT_ID,
        input: { prompt: b.prompt, world_id: worldId, style: b.style, media: b.media === true, image_data_url: b.image_data_url },
      });

      jobsvc.run(job.id, BOOT_ID, async (ctx) => {
        const built = await v3.assemble({
          prompt: b.prompt, worldId, creatorId: me.id, seed: b.seed, style: b.style,
          media: b.media === true,
          image: b.image_data_url ? { dataUrl: b.image_data_url, mime: b.image_mime } : undefined,
          // Each lane reports the moment it ACTUALLY finishes, with the provider
          // that answered. Nothing here advances on a timer.
          onLane: async (phase, lane, detail) => {
            if (phase === "start") await ctx.startStage(lane, detail);
            else await ctx.finishStage(lane, detail);
          },
        });
        if (!b.image_data_url) await ctx.skipStage("vision", "no reference image was supplied");
        if (b.media !== true) await ctx.skipStage("media", "key art was not requested");
        if (!built.validation.ok) {
          throw Errors.internal("the assembled world did not satisfy WorldManifestV3", { meta: { errors: built.validation.errors.slice(0, 8) } });
        }

        await ctx.startStage("playtest");
        const gate = await playtestAndRepair(built.manifest);
        await ctx.finishStage("playtest", `${gate.verdict}${gate.repairs.length ? ` after ${gate.repairs.length} repair(s)` : ""}`);
        if (!gate.passed) {
          throw Errors.validation("the generated world did not pass the playtest gate and was not saved", {
            meta: { verdict: gate.verdict, findings: gate.rounds.at(-1).findings.slice(0, 10) },
          });
        }

        await ctx.startStage("save");
        const saved = await repo.upsert({ worldId, ownerId: me.id, manifest: gate.manifest, state: "draft", title: gate.manifest.meta.title });
        await worldMemory.record(worldId, { kind: "created", summary: `"${gate.manifest.meta.title}" was generated from a prompt`, worldVersion: 1, actorId: me.id, detail: { prompt: b.prompt } });
        await social.ensureProfile(me);
        await social.recordWorldCreated(me.id);
        await ctx.finishStage("save", `world version ${saved.version}`);

        return {
          world_id: worldId, title: gate.manifest.meta.title, world_version: saved.version,
          manifest_hash: saved.manifest_hash,
          counts: {
            zones: gate.manifest.zones.length, structures: gate.manifest.structures.length,
            npcs: gate.manifest.npcs.length, items: gate.manifest.items.length,
            quests: gate.manifest.quests.length, behaviors: gate.manifest.behaviors.length,
            interactions: gate.manifest.interactions.length, assets: gate.manifest.assets.length,
          },
          playtest: { verdict: gate.verdict, repairs: gate.repairs.length },
          provenance: built.provenance,
          manifest_url: "/v3/worlds/" + worldId + "/manifest",
        };
      });

      // 202: accepted, not finished. The client polls the job.
      return send(res, 202, { ok: true, job_id: job.id, world_id: worldId, state: job.state, stages: job.stages.map((s: any) => ({ id: s.id, label: s.label, optional: !!s.optional })), poll: "/v3/jobs/" + job.id, correlation_id: cid });
    }

    if (url === "/v3/jobs" && method === "GET") {
      const me = await mustBe(req, cid);
      return send(res, 200, { ok: true, jobs: await jobsvc.listFor(me.id) });
    }
    {
      let mm = url.match(/^\/v3\/jobs\/([^/]+)$/);
      if (mm && method === "GET") {
        const me = await mustBe(req, cid);
        return send(res, 200, { ok: true, job: await jobsvc.get(mm[1], me.id) });
      }
      if (mm && method === "DELETE") {
        const me = await mustBe(req, cid);
        return send(res, 200, { ok: true, job: await jobsvc.cancel(mm[1], me.id) });
      }
    }

    if (url === "/v3/worlds/generate" && method === "POST") {
      const me = await mustBeInternalTester(req, cid);
      await safety.requireCapability(me.id, "create");
      const b = await readBody(req);
      if (!b.prompt || typeof b.prompt !== "string") throw Errors.validation("prompt is required", { correlationId: cid });

      const worldId = "w3_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      // 9.1 multimodal: an optional reference image is READ into a description
      // that conditions generation. The bytes never enter the manifest.
      const built = await v3.assemble({
        prompt: b.prompt, worldId, creatorId: me.id, seed: b.seed, style: b.style,
        media: b.media === true,
        image: b.image_data_url ? { dataUrl: b.image_data_url, mime: b.image_mime } : undefined,
      });
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
          // A rejected world is discarded, so without this there is no way to
          // find out WHY the repair pass could not save it — which is how two
          // unimplemented repairs survived to be found one at a time on
          // staging. Say what was attempted, what was declined and on what.
          repair_log: gate.rounds.map((r) => ({
            round: r.round,
            verdict: r.verdict,
            findings: (r.findings || []).map((f) => f.id),
            repaired: r.repairs || [],
            not_repaired: (r.skipped_repairs || []).map((sk) => ({ fix: sk.fix, id: sk.id, why: sk.why })),
          })),
          counts: {
            zones: (gate.manifest.zones || []).length,
            structures: (gate.manifest.structures || []).length,
            npcs: (gate.manifest.npcs || []).length,
            items: (gate.manifest.items || []).length,
            quests: (gate.manifest.quests || []).length,
            interactions: (gate.manifest.interactions || []).length,
          },
          provenance: built.provenance,
          correlation_id: cid,
        });
      }

      const saved = await repo.upsert({ worldId, ownerId: me.id, manifest: gate.manifest, state: "draft", title: gate.manifest.meta.title });
      // The world now exists to the runtime as well as to the store, so player
      // ownership and inventory become checkable for it.
      await registerV3BaseWorld(worldId, gate.manifest, cid);
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
        // What the system thought the reference image showed, and whether it was used.
        reference_image: built.visual_reading ? { conditioned: built.conditioning.conditioned, reason: built.conditioning.reason, reading: built.visual_reading } : undefined,
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
        // The hash travels with the manifest so a client can verify what it
        // received. Without it, /versions was the only place the hash appeared,
        // and a caller loading a world had no way to check integrity at all.
        // It is computed over the manifest being RETURNED, so a world upgraded
        // on read hashes to what the caller actually got, not to what is stored.
        return send(res, 200, { ok: true, world_id: rec.world_id, world_version: rec.version, state: rec.state, owner: rec.owner_id, migrated_on_read: migrated, manifest_hash: manifestHash(manifest), manifest });
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

        const live = (await liveStateFor(mm[1], b.live_state)).live;
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
        const applied = applyDelta(before, plan.delta, (await liveStateFor(mm[1], b.live_state)).live);
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

          // The source is NOT taken on trust, and it does not default to the
          // exempt value.
          //
          // It used to be `source: b.source || "synthetic"`, and
          // requireMediaConsent returns permitted immediately for "synthetic".
          // So the entire voice-and-likeness gate came off by omitting a field —
          // while `subject_id` could still name a real person and was forwarded
          // to the provider regardless. A default that disables a consent check
          // is the wrong default no matter how the field is spelled.
          //
          // A claim of "synthetic" is only credible when the material is tied to
          // nobody. If a subject is named, the claim contradicts itself, and the
          // contradiction is refused rather than resolved in the caller's favour.
          const named = b.subject_id ?? null;
          if (b.source === "synthetic" && named !== null) {
            throw Errors.validation(
              "material cannot be declared synthetic while naming a subject; a likeness of a real person needs a recorded consent grant",
              { correlationId: cid, meta: { subject_id: named, media_kind: kind } }
            );
          }
          await safety.requireMediaConsent({
            subjectId: named ?? me.id,
            mediaKind: kind === "narration" ? "voice" : kind,
            // Absent means unknown, and unknown is not exempt.
            source: b.source === "synthetic" ? "synthetic" : (b.source || "unknown"),
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

      // ---- 9.2 world stitching: join two worlds, preserving both ----------
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/stitch$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        await safety.requireCapability(me.id, "create");
        const b = await readBody(req);
        if (!b.guest_world_id) throw Errors.validation("guest_world_id is required", { correlationId: cid });

        const hostRec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
        const guestRec = await repo.get(b.guest_world_id, { requesterId: me.id });
        const host = { world_id: hostRec.world_id, owner_id: hostRec.owner_id, state: hostRec.state, version: hostRec.version, manifest: ensureV3(hostRec.manifest, { worldVersion: hostRec.version, creatorId: hostRec.owner_id }).manifest };
        const guest = { world_id: guestRec.world_id, owner_id: guestRec.owner_id, state: guestRec.state, version: guestRec.version, manifest: ensureV3(guestRec.manifest, { worldVersion: guestRec.version, creatorId: guestRec.owner_id }).manifest };

        const { delta, stitch } = planStitch(host, guest, { stitcherId: me.id, side: b.side || "east", gap: b.gap, label: b.label });
        const live = (await liveStateFor(mm[1], b.live_state)).live;
        const applied = applyDelta(host.manifest, delta, live);        // throws 409 if unsafe
        const preserved = verifyPreservation(host.manifest, applied.manifest, live);
        if (!preserved.ok) {
          throw Errors.conflict("the stitch would have lost existing state", { correlationId: cid, meta: { problems: preserved.problems } });
        }
        recordStitch(applied.manifest, stitch);

        const gate = await playtestAndRepair(applied.manifest);
        if (!gate.passed) {
          return send(res, 422, {
            ok: false, error: "stitch_failed_playtest",
            detail: "the joined world did not pass the playtest gate and was not saved",
            verdict: gate.verdict, findings: gate.rounds.at(-1).findings.slice(0, 10),
            stitch, correlation_id: cid,
          });
        }

        const saved = await repo.upsert({ worldId: host.world_id, ownerId: me.id, manifest: gate.manifest, state: hostRec.state, title: gate.manifest.meta.title });
        await worldMemory.record(host.world_id, {
          kind: "expanded",
          summary: `"${stitch.guest_title || stitch.guest_world_id}" was stitched into this world`,
          worldVersion: gate.manifest.world_version, actorId: me.id, detail: { guest_world_id: stitch.guest_world_id, namespace: stitch.namespace },
        });

        return send(res, 200, {
          ok: true, world_id: host.world_id,
          world_version: gate.manifest.world_version, previous_version: applied.previous_version,
          record_version: saved.version,
          stitch, preserved: preserved.ok, playtest: gate.verdict,
          summary: stitchSummary(gate.manifest),
          correlation_id: cid,
        });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/stitch\/preview$/);
      if (mm && method === "POST") {
        // Dry run: what WOULD be joined, and whether it is permitted. Saves nothing.
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        const hostRec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
        const guestRec = await repo.get(b.guest_world_id, { requesterId: me.id });
        const host = { world_id: hostRec.world_id, owner_id: hostRec.owner_id, state: hostRec.state, version: hostRec.version, manifest: ensureV3(hostRec.manifest, { worldVersion: hostRec.version, creatorId: hostRec.owner_id }).manifest };
        const guest = { world_id: guestRec.world_id, owner_id: guestRec.owner_id, state: guestRec.state, version: guestRec.version, manifest: ensureV3(guestRec.manifest, { worldVersion: guestRec.version, creatorId: guestRec.owner_id }).manifest };
        const perm = checkStitchPermission(host, guest, me.id);
        if (!perm.ok) return send(res, 200, { ok: true, permitted: false, ...perm, correlation_id: cid });
        const { stitch } = planStitch(host, guest, { stitcherId: me.id, side: b.side || "east", gap: b.gap });
        return send(res, 200, { ok: true, permitted: true, stitch, correlation_id: cid });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/parts$/);
      if (mm && method === "GET") {
        const rec = await repo.get(mm[1], { requesterId: principal?.id ?? null });
        const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
        return send(res, 200, { ok: true, world_id: rec.world_id, ...stitchSummary(manifest) });
      }

      // ---- remix / fork, with permanent attribution and money dark ---------
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/fork$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        await safety.requireCapability(me.id, "create");
        const b = await readBody(req);
        // Read as a stranger would: a draft is not forkable, and this proves it.
        const source = await repo.get(mm[1], { requesterId: me.id });
        const { manifest: forked, attribution } = forkWorld(
          { world_id: source.world_id, owner_id: source.owner_id, state: source.state, version: source.version, manifest: ensureV3(source.manifest, { worldVersion: source.version, creatorId: source.owner_id }).manifest },
          { forkerId: me.id, newWorldId: "w3_" + crypto.randomUUID().replace(/-/g, "").slice(0, 16), title: b.title }
        );
        const gate = await playtestAndRepair(forked);
        if (!gate.passed) {
          return send(res, 422, { ok: false, error: "fork_failed_playtest", detail: "the forked world did not pass the playtest gate and was not saved", verdict: gate.verdict, correlation_id: cid });
        }
        const saved = await repo.upsert({ worldId: forked.world_id, ownerId: me.id, manifest: gate.manifest, state: "draft", title: gate.manifest.meta.title });
        await worldMemory.record(forked.world_id, { kind: "created", summary: `remixed from "${attribution.forked_from_title || attribution.forked_from_world_id}"`, worldVersion: 1, actorId: me.id, detail: attribution });
        await social.ensureProfile(me);
        await social.recordWorldCreated(me.id);
        return send(res, 200, {
          ok: true, world_id: forked.world_id, world_version: saved.version,
          title: gate.manifest.meta.title, attribution,
          payments_live: PAYMENTS_LIVE,
          revenue_policy: gate.manifest.meta.revenue_policy,
          playtest: gate.verdict, correlation_id: cid,
        });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/attribution$/);
      if (mm && method === "GET") {
        const rec = await repo.get(mm[1], { requesterId: principal?.id ?? null });
        const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
        return send(res, 200, { ok: true, world_id: rec.world_id, fork_policy: forkPolicyOf(manifest), policies: FORK_POLICIES, ...attributionChain(manifest) });
      }

      // ---- 9.5 NPC memory: only what was actually recorded --------------
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/npcs\/([^/]+)\/memory$/);
      if (mm && method === "GET") {
        const rec = await repo.get(mm[1], { requesterId: principal?.id ?? null });
        const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
        // This is the server conducting a dialogue turn with a named NPC for an
        // authenticated principal — which is what "someone a player has met"
        // means. The evidence recorded is the artefact the server produced, not
        // a flag a caller set.
        const lines = await npcMemory.linesFor(rec.world_id, mm[2], manifest);
        if (principal) {
          await optional("player-progress-npc", () => playerProgress.recordNpcDialogueServed({ principal, worldId: rec.world_id, npcId: mm[2], manifest, lines, worldVersion: rec.version }), cid);
          await optional("player-progress-reconcile", () => playerProgress.reconcileQuests({ principal, worldId: rec.world_id, manifest, worldVersion: rec.version }), cid);
        }
        return send(res, 200, { ok: true, ...lines });
      }

      mm = url.match(/^\/v3\/worlds\/([^/]+)\/quests\/generate$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        const rec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
        const { manifest } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
        const gen = await npcMemory.proceduralQuest(rec.world_id, manifest, { giverNpcId: b.giver_npc_id, seed: b.seed });

        if (b.apply === true) {
          // Applying it goes through the SAME delta path as any other change, so
          // the playtest gate still decides whether it ships.
          const delta = newDelta({ label: gen.quest.title, author: me.id, reason: "procedural quest" });
          delta.add.quests.push(gen.quest);
          const applied = applyDelta(manifest, delta, emptyLiveState());
          const gate = await playtestAndRepair(applied.manifest);
          if (!gate.passed) {
            return send(res, 422, { ok: false, error: "quest_failed_playtest", detail: "the generated quest did not pass the playtest gate and was not saved", verdict: gate.verdict, quest: gen.quest, correlation_id: cid });
          }
          const saved = await repo.upsert({ worldId: rec.world_id, ownerId: me.id, manifest: gate.manifest, state: rec.state, title: gate.manifest.meta.title });
          await worldMemory.record(rec.world_id, { kind: "edited", summary: `a quest was added: ${gen.quest.title}`, worldVersion: gate.manifest.world_version, actorId: me.id });
          return send(res, 200, { ok: true, applied: true, ...gen, world_version: gate.manifest.world_version, record_version: saved.version, playtest: gate.verdict, correlation_id: cid });
        }
        return send(res, 200, { ok: true, applied: false, ...gen, correlation_id: cid });
      }

      // ---- retained world versions (what rollback and diff target) --------
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/versions$/);
      if (mm && method === "GET") {
        return send(res, 200, { ok: true, world_id: mm[1], versions: await repo.listVersions(mm[1], { requesterId: principal?.id ?? null }) });
      }
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/versions\/(\d+)$/);
      if (mm && method === "GET") {
        const v = await repo.getVersion(mm[1], Number(mm[2]), { requesterId: principal?.id ?? null });
        return send(res, 200, { ok: true, world_id: mm[1], version: v.version, manifest_hash: v.manifest_hash, label: v.label, created_at: v.created_at, manifest: v.manifest });
      }

      // ---- B6 rollback -----------------------------------------------------
      // A rollback is a NEW version, never a rewind: the chronicle only ever
      // grows, so "we went back to v3" stays visible instead of looking like v3
      // was never left. It refuses rather than repairs when a player owns
      // something the target does not contain — a world is not the creator's
      // alone once people have built in it.
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/rollback$/);
      if (mm && method === "POST") {
        const me = await mustBeInternalTester(req, cid);
        const b = await readBody(req);
        const toVersion = Number(b.to_version);
        if (!Number.isInteger(toVersion) || toVersion < 1) throw Errors.validation("to_version must be a version number to roll back to", { correlationId: cid });

        const rec = await repo.get(mm[1], { requesterId: me.id, requireOwner: true });
        const target = await repo.getVersion(mm[1], toVersion, { requesterId: me.id });
        const { manifest: current } = ensureV3(rec.manifest, { worldVersion: rec.version, creatorId: rec.owner_id });
        // The TARGET gets the same treatment. A version retained before the v3
        // migration is still a legitimate rollback target — refusing it would
        // mean the oldest history a world has is the part it can never return
        // to. It is migrated on the way back, exactly as the current manifest is
        // migrated on the way in, and then has to pass the same playtest gate.
        const { manifest: targetV3 } = ensureV3(target.manifest, { worldVersion: target.version, creatorId: rec.owner_id });

        // A world that has never been expanded carries no world_version of its
        // own — only applyDelta and the migrator write one. The repository's
        // version number is the authority for "which version is this", so it is
        // stamped in where the manifest is silent. A manifest that DOES carry
        // one keeps it, because its chronology is validated against it.
        // The world_id is the same story: the record knows it, the manifest may
        // not carry it, and a rollback must be able to prove both sides name the
        // same world before it touches anything.
        const stamp = (m: any, v: number) => ({
          ...m,
          world_id: m?.world_id ?? rec.world_id,
          world_version: Number.isInteger(m?.world_version) && m.world_version >= 1 ? m.world_version : v,
        });
        const currentM = stamp(current, Number(rec.version));
        const targetM = stamp(targetV3, Number(target.version));

        // Client-supplied live state is ADDITIVE evidence of what players hold,
        // never the whole of it: a caller that simply omits it must not thereby
        // get permission to demolish. Manifest-recorded ownership is checked
        // independently inside planRollback, and the response says plainly how
        // far the live-state check reached so nobody reads silence as safety.
        // Derive completions BEFORE they gate a deletion: a quest added since the
        // evidence was gathered must still be reconciled against it.
        await optional("player-progress-reconcile-world", () => playerProgress.reconcileWorld(rec.world_id, currentM, rec.version), cid);
        const ls = await liveStateFor(rec.world_id, b.live_state);
        const live = ls.live;
        const { manifest, record } = planRollback(currentM, targetM, {
          actorId: me.id, toVersion, liveState: live, reason: b.reason ?? null,
          // The number the caller sent came from GET /versions, which lists the
          // REPOSITORY's counter. The manifest keeps its own, and the two skew
          // whenever a state-only save (a publish) bumps the record without
          // touching the manifest — so a rollback refused with "the manifest
          // supplied is v2, not the v3 that was asked for", blaming the caller
          // for a version the server itself had just offered. Saying which
          // counter the number is in removes the guess entirely.
          versionCounter: "record",
          // Deliberately NOT passing toManifestHash. That assertion exists for a
          // caller who SUPPLIES a manifest and must prove it is the snapshot it
          // claims to be. This route fetches the version from the store by
          // number and then migrates and stamps it, so its hash legitimately
          // differs from the stored one — asserting equality here would refuse
          // every rollback whose target predates the current manifest format.
        });

        const gate = await playtestAndRepair(manifest);
        if (!gate.passed) {
          // An old version that no longer passes today's gate is not silently
          // shipped: the world stays where it is and the caller is told why.
          return send(res, 422, { ok: false, error: "rollback_failed_playtest", detail: `v${toVersion} does not pass the current playtest gate, so the world was not changed`, verdict: gate.verdict, findings: gate.rounds.at(-1).findings.slice(0, 10), correlation_id: cid });
        }

        const saved = await repo.upsert({ worldId: rec.world_id, ownerId: me.id, manifest: gate.manifest, state: rec.state, title: gate.manifest.meta.title });
        // Written through the seam rollback.mjs exports, which builds the event
        // from the history RECORD rather than from what this route believes.
        // Hand-rolling it here put the versions inside `detail`, while a
        // rolled_back event requires them at the top level — so this threw AFTER
        // the world had already been saved: the rollback happened, the caller
        // was told it failed, and the chronicle entry was lost. That is exactly
        // the inconsistency the append-only chronicle exists to prevent.
        await recordRollback(worldMemory, rec.world_id, { manifest: gate.manifest, record });

        return send(res, 200, {
          ok: true, world_id: rec.world_id, rolled_back_to: toVersion,
          world_version: gate.manifest.world_version, record_version: saved.version,
          ownership_preserved: record.ownership_preserved || [],
          live_state_checked: ls.determined.determined,
          live_state_not_checked: ls.determined.undetermined,
          live_state_complete: ls.determined.complete,
          live_state_from_client: ls.supplied ? ls.added : null,
          live_state_note: ls.determined.note,
          diff: diffManifests(currentM, gate.manifest).summary,
          playtest: gate.verdict, correlation_id: cid,
        });
      }

      // ---- what actually changed between two retained versions -------------
      mm = url.match(/^\/v3\/worlds\/([^/]+)\/diff$/);
      if (mm && method === "GET") {
        const q = new URLSearchParams((req.url || "").split("?")[1] || "");
        const from = Number(q.get("from")), to = Number(q.get("to"));
        if (!Number.isInteger(from) || !Number.isInteger(to)) throw Errors.validation("from and to must both be version numbers, e.g. ?from=1&to=3", { correlationId: cid });
        const requesterId = principal?.id ?? null;
        const a = await repo.getVersion(mm[1], from, { requesterId });
        const bV = await repo.getVersion(mm[1], to, { requesterId });
        return send(res, 200, { ok: true, world_id: mm[1], from, to, ...diffManifests(a.manifest, bV.manifest) });
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
      // A prompt is the whole of what the caller asked for. `b.prompt || "Pirate
      // Island"` meant {"prompt":""} and {"prompt":null} answered 200 with a
      // pirate world handed back as the caller's own creation — the one thing a
      // generator must never do. The generator itself refuses an empty prompt;
      // this default was the only thing standing between it and the route.
      if (!b.prompt || typeof b.prompt !== "string" || !b.prompt.trim()) {
        throw Errors.validation("prompt is required, and describes the world to build", { correlationId: cid });
      }
      const world = await generateVia(b.prompt); // adapter seam: Cerebras hybrid when keyed, else seeder (always C1-valid)
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
      // Stored so GET /atlas/receipt/:id can serve it. Keyed on the hash, which
      // is what the receipt is identified by everywhere else.
      await optional("atlas-receipt-store", () => atlasReceipts.upsert((x: any) => x.receipt_hash === receipt.receipt_hash, {
        receipt_hash: receipt.receipt_hash, subject_id: id, receipt, issued_at: new Date().toISOString(),
      }), cid);
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
        //
        // `state` is NOT taken from the body, and a request that sends one is
        // refused rather than quietly ignored.
        //
        // It used to be `state: b.state || "draft"`, which was two defects in
        // one expression. Sending "published" created a published, discoverable
        // world while walking past every gate the publish route exists to
        // enforce — internal-tester check, ownership, the playtest gate, and
        // the Atlas signing key, which publish refuses to proceed without
        // precisely so that nothing is ever marked published-and-verified
        // unsigned. And because `repo.upsert`'s owner check only fires when a
        // record already exists, any authenticated account could do it on an
        // unclaimed id. The `|| "draft"` half was the mirror image: an ordinary
        // save of an ALREADY published world silently unpublished it.
        //
        // Publishing is a separate authorised action. Saving is saving.
        if (b.state !== undefined) {
          throw Errors.validation(
            "a save cannot change a world's state; publish it with POST /worlds/:id/publish, which checks ownership and signs an Atlas receipt",
            { correlationId: cid, meta: { rejected_state: String(b.state) } }
          );
        }
        // Structural sanity only, deliberately.
        //
        // This is the V2 save route. V2 worlds are not V3-shaped, and stored
        // worlds that DO declare `manifest_version: "3.0.0"` are not all
        // complete — partial manifests are saved legitimately mid-edit.
        // Validating against WorldManifestV3 here rejected all of them, which is
        // a compatibility break dressed up as a fix; full validation belongs on
        // the V3 write paths, where a complete manifest is the actual contract
        // (generate already refuses to store one that fails it).
        //
        // What remains is the part that cannot be argued with: a manifest has to
        // be an object. An array or a string reaching the store corrupts a world
        // in a way nothing downstream can interpret.
        if (!b.manifest || typeof b.manifest !== "object" || Array.isArray(b.manifest)) {
          throw Errors.validation("manifest must be an object", { correlationId: cid });
        }
        const prior = await repo.get(m[1], { requesterId: me.id }).catch(() => null);
        const saved = await repo.upsert({ worldId: m[1], ownerId: me.id, manifest: b.manifest, state: prior?.state || "draft", expected_version: b.expected_version ?? null });
        return send(res, 200, { ok: true, world_id: m[1], world_version: saved.version, manifest_hash: saved.manifest_hash, idempotent: saved.idempotent, persistence_degraded: saved._mirrored === false ? saved._mirror_error : undefined, correlation_id: cid });
      }
      // The runtime-delta path. Two things must be true and neither was checked:
      // the caller must be allowed to shape THIS world, and the delta must only
      // act on the caller's own behalf. Without the first, any authenticated
      // account could rewrite any world's runtime objects; without the second,
      // a delta could set another player's inventory or hand itself ownership.
      // Both feed livestate, which decides whether a rollback may delete things.
      const delta = b.delta || b; delta.world_id = m[1];
      await repo.get(m[1], { requesterId: me.id, requireOwner: true });
      const r = await persistence.save(delta, { actorId: me.id });
      return send(res, 200, { ok: true, ...r, correlation_id: cid });
    }
    m = url.match(/^\/worlds\/([^/]+)\/load$/);
    if (m && method === "GET") {
      const rec = await repo.get(m[1], { requesterId: principal?.id ?? null });
      // A world that has never been played has no runtime state, and that is not
      // an error. The runtime registers a "base world" when a world is generated
      // or entered; a world created through POST /worlds/:id/save has simply
      // never been through that, so persistence.load threw "base world not
      // found" and a plain save-then-load — the most basic thing the V2 surface
      // does — answered 500 with an internal message.
      //
      // Only that specific absence is tolerated. Any other failure still raises,
      // because a runtime snapshot that exists and cannot be read is a real
      // fault and must not be flattened into "no state".
      let snap = null;
      let runtimeUnavailable: string | null = null;
      try {
        snap = await persistence.load(m[1]);
      } catch (e: any) {
        if (!/base world .* not found/i.test(String(e?.message || e))) throw e;
        runtimeUnavailable = "this world has no runtime state yet";
      }
      return send(res, 200, { ok: true, world_id: m[1], world_version: rec.version, manifest_hash: rec.manifest_hash, state: rec.state, owner: rec.owner_id, manifest: rec.manifest, runtime_state: snap, runtime_note: runtimeUnavailable ?? undefined, correlation_id: cid });
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
    // The real message is LOGGED, never sent. An unexpected exception carries
    // whatever the runtime put in it — an ENOENT or EACCES names a container
    // filesystem path, a database error names relations and columns — and this
    // is the one path that reaches a client without anyone having decided what
    // it says. The correlation id is how an operator gets from the client's
    // report to the full detail in the log.
    const internal = Errors.internal(String(e?.message || e), { correlationId: cid, cause: e });
    logError(internal, method + " " + url);
    if (process.env.NODE_ENV !== "production") console.error(e?.stack || e);
    const safe = Errors.internal("an unexpected error occurred; quote the correlation id", { correlationId: cid });
    return send(res, 500, safe.toJSON());
  }
});
export { server };
if (process.env.DCS_NO_LISTEN !== "1") {
  server.listen(PORT, () => console.log("DCS Games Core API v3 on :" + PORT + " auth=" + auth.mode + " store=" + repo.kind));
}
