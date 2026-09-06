// Lane R — complete authorisation audit of the HTTP surface.
//
// Boots the REAL server.mts in a child process (the pattern
// test/api-integration.test.mjs established) and drives EVERY route in the
// router as four kinds of caller:
//
//   ANON    — no credential at all
//   USER    — a valid token, authenticated, NOT on the internal-tester allowlist
//   TESTER  — a valid token, internal tester, NOT the owner of anything here
//   OWNER   — a valid token, internal tester, owns every fixture below
//
// For each route the suite answers the five questions the audit asks:
//   1. is authentication required where it should be
//   2. is OWNERSHIP/MEMBERSHIP checked, not merely authentication
//   3. does the RESPONSE leak another principal's data
//   4. does the ERROR leak existence ("not yours" vs "does not exist")
//   5. is the route reachable by a different path (sub-path, trailing slash,
//      a method the router falls through on, %2e%2e or double encoding)
//
// Nothing here is allowed to weaken a check to make a test pass. Where the
// server is wrong the test is named `DEFECT, OPEN:` and FAILS on purpose,
// carrying the reproduction and the file+line where the fix belongs.
//
// Run: node --import tsx --test test/route-authz.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { signLocalToken } from "../src/core/principal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GB = path.resolve(HERE, "..");
const SECRET = "route-authz-secret";
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-authz-"));
const PORT = 8300 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
const ATLAS_SEED = crypto.randomBytes(32).toString("base64");
// Unique per run so the sha256(prompt) world ids the legacy generator mints
// cannot collide with a previous run's data directory.
const RUN = crypto.randomBytes(4).toString("hex");

// OWNER and TESTER are both on the allowlist AND carry the role, so every
// difference observed between them is ownership, never the testing window.
const TOKENS = {
  OWNER:  signLocalToken(SECRET, { sub: "user-owner",  email: "owner@dcsai.ai",  roles: ["internal_tester"] }, 7200),
  TESTER: signLocalToken(SECRET, { sub: "user-tester", email: "tester@dcsai.ai", roles: ["internal_tester"] }, 7200),
  USER:   signLocalToken(SECRET, { sub: "user-plain",  email: "plain@example.com" }, 7200),
};
const CALLERS = ["ANON", "USER", "TESTER", "OWNER"];

let proc;
/** Every fixture, all created through the API as the caller entitled to create it. */
const F = {};
/** Fresh worlds handed out one per mutating owner-path test, so order cannot matter. */
const SPARE = [];
/** Everything the suite observed, printed at the end as the route x caller table. */
const OBSERVED = [];

function baseEnv() {
  return {
    ...process.env,
    PORT: String(PORT),
    DCS_AUTH_SECRET: SECRET,
    DCS_DATA_DIR: DATA,
    PAYMENTS_LIVE: "0",                       // stays false, always
    NODE_ENV: "test",
    DCS_PROVIDERS_OFFLINE: "1",               // deterministic, free, no live LLM
    ATLAS_PRIVATE_KEY: ATLAS_SEED,            // so publish can genuinely sign
    DCS_INTERNAL_TESTERS: "owner@dcsai.ai,tester@dcsai.ai",
    SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "",
    CEREBRAS_API_KEY: "", CEREBRAS_API_KEY_1: "", CEREBRAS_API_KEY_2: "", CEREBRAS_KEY_2: "",
    DEEPSEEK_API_KEY: "", TOGETHER_API_KEY: "", DATABASE_URL: "",
  };
}

async function boot() {
  const p = spawn(process.execPath, ["--import", "tsx", path.join(GB, "server.mts")], {
    cwd: GB, env: baseEnv(), stdio: ["ignore", "pipe", "pipe"],
  });
  p.stdout.on("data", () => {});
  p.stderr.on("data", (d) => { if (process.env.DCS_TEST_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 200; i++) {
    try { if ((await fetch(BASE + "/health")).ok) return p; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  p.kill("SIGKILL");
  throw new Error("server did not become healthy");
}

/** One call, as one of the four caller kinds. */
async function call(who, method, url, body, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (who && who !== "ANON") headers.Authorization = "Bearer " + TOKENS[who];
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch(BASE + url, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* HTML or empty */ }
  return { status: r.status, body: json, text };
}

/** A request written straight onto the socket, so the client cannot normalise the path. */
function socketRequest(requestLine) {
  return new Promise((resolve) => {
    const s = net.connect(PORT, "127.0.0.1", () => {
      s.write(requestLine + " HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    });
    let d = "";
    s.on("data", (c) => (d += c));
    s.on("end", () => resolve({ status: parseInt((d.split("\r\n")[0] || "").split(" ")[1] || "0", 10), raw: d }));
    s.on("error", () => resolve({ status: 0, raw: "" }));
  });
}

/**
 * Create a world as `who` and return its id.
 *
 * The playtest gate is real and a generated world can genuinely fail it
 * (422 world_failed_playtest), which has nothing to do with authorisation.
 * Retrying with a different prompt keeps this suite about permissions.
 */
async function mintWorld(who, label) {
  let last = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = await call(who, "POST", "/v3/worlds/generate", { prompt: `${label} take ${attempt} ${RUN}` });
    if (r.status === 200) return r.body.world_id;
    last = r;
  }
  throw new Error(`could not mint a world for ${label}: ${last.status} ${String(last.text).slice(0, 300)}`);
}

const record = (method, url, cells, note) => OBSERVED.push({ method, url, cells, note });

/** Drive one route as all four callers and return {ANON,USER,TESTER,OWNER} statuses. */
async function sweep(method, url, body) {
  const cells = {};
  for (const who of CALLERS) cells[who] = (await call(who, method, url, body)).status;
  return cells;
}

before(async () => {
  proc = await boot();

  // ---- every principal records an adult age tier, or creation is refused ----
  for (const who of ["OWNER", "TESTER", "USER"]) {
    const r = await call(who, "POST", "/safety/age", { date_of_birth: "1990-01-01", method: "synthetic_test" });
    assert.equal(r.status, 200, `age assurance for ${who}`);
    assert.equal(r.body.age_tier, "adult");
  }

  // ---- worlds: one published (public), one draft (private) ----
  let r;
  F.draftWorld = await mintWorld("OWNER", "an owner draft");
  F.pubWorld = await mintWorld("OWNER", "an owner published world");
  r = await call("OWNER", "POST", `/worlds/${F.pubWorld}/publish`, {});
  assert.equal(r.status, 200, "publish: " + r.text.slice(0, 200));

  // A world owned by the TESTER, so cross-owner writes have a real target.
  F.testerWorld = await mintWorld("TESTER", "a tester world");

  // Disposable worlds, one per owner-path test that writes.
  for (let i = 0; i < 14; i++) SPARE.push(await mintWorld("OWNER", `spare world ${i}`));

  // ---- social fixtures, all owned by OWNER ----
  r = await call("OWNER", "POST", "/social/parties", { open: false, world_id: F.pubWorld });
  assert.equal(r.status, 201); F.privateParty = r.body.party.id;
  r = await call("OWNER", "POST", "/social/parties", { open: true, world_id: F.pubWorld });
  assert.equal(r.status, 201); F.openParty = r.body.party.id;
  r = await call("OWNER", "POST", "/social/teams", { name: "Owner Team" });
  assert.equal(r.status, 201); F.team = r.body.team.id;
  r = await call("OWNER", "POST", "/social/orgs", { name: "Owner Org", seats: 5 });
  assert.equal(r.status, 201); F.org = r.body.org.id;
  r = await call("OWNER", "POST", "/social/studios", { name: "Owner Studio" });
  assert.equal(r.status, 201); F.studio = r.body.studio.id;

  // ---- a job, a storefront, a listing ----
  r = await call("OWNER", "POST", "/v3/worlds/generate/async", { prompt: `an async world ${RUN}` });
  assert.equal(r.status, 202); F.job = r.body.job_id;
  r = await call("OWNER", "POST", "/v3/marketplace/storefronts", { name: "Owner Front" });
  assert.equal(r.status, 201); F.storefront = r.body.storefront.id;
  r = await call("OWNER", "POST", "/v3/marketplace/listings", { world_id: F.pubWorld, storefront_id: F.storefront, title: "Owner World" });
  assert.equal(r.status, 201); F.listing = r.body.listing.id;

  // ---- a filed report, so the moderation route has a subject ----
  r = await call("USER", "POST", "/safety/report", { subject_type: "world", subject_id: F.pubWorld, reason: "spam" });
  assert.equal(r.status, 201); F.report = r.body.report_id;

  // ---- an NPC id from the published world, for the npc-memory route ----
  r = await call("OWNER", "GET", `/v3/worlds/${F.pubWorld}/manifest`);
  F.npc = r.body.manifest.npcs[0].id;
  r = await call("OWNER", "GET", `/v3/worlds/${F.draftWorld}/manifest`);
  F.draftNpc = r.body.manifest.npcs[0].id;

  // The draft world gets insider-only engagement, so a leak of it is provable.
  await call("OWNER", "POST", `/v3/worlds/${F.draftWorld}/play`, { seconds: 42 });
  await call("OWNER", "POST", `/v3/worlds/${F.draftWorld}/rate`, { rating: 5 });

  // ids that were never created, for the existence-oracle comparisons
  F.missWorld = "w3_thisworldwasnevercreated";
  F.missParty = "pty_neverexisted";
  F.missTeam = "team_neverexisted";
  F.missOrg = "org_neverexisted";
  F.missStudio = "std_neverexisted";
  F.missJob = "job_neverexisted";
  F.missListing = "lst_neverexisted";
  F.missReport = "00000000-0000-4000-8000-000000000000";
});

after(() => {
  proc?.kill("SIGKILL");
  fs.rmSync(DATA, { recursive: true, force: true });
  if (process.env.DCS_AUTHZ_TABLE) {
    console.log("\n================ ROUTE x CALLER (observed status) ================");
    console.log("METHOD PATH".padEnd(58) + "ANON  USER  TESTER OWNER");
    for (const row of OBSERVED) {
      const l = `${row.method} ${row.url}`;
      console.log(
        l.slice(0, 57).padEnd(58) +
        String(row.cells.ANON ?? "-").padEnd(6) +
        String(row.cells.USER ?? "-").padEnd(6) +
        String(row.cells.TESTER ?? "-").padEnd(7) +
        String(row.cells.OWNER ?? "-") + (row.note ? "   " + row.note : "")
      );
    }
  }
});

// =====================================================================
// SECTION 1 — is authentication required where it should be?
//
// Every private route, driven with NO credential. The only acceptable
// answers are 401 (refused) or 410 (retired). A 200, a 403 or a 404 to an
// anonymous caller on a route that reads or writes a principal's data would
// mean the route decided something before it knew who was asking.
// =====================================================================
const PRIVATE_ROUTES = () => [
  ["GET", "/worlds/mine"],
  ["GET", "/api/worlds/mine"],
  ["GET", "/me"],
  ["GET", "/subscriptions"],
  ["GET", "/identity/portable"],
  ["POST", "/publish/check", {}],
  ["POST", "/invite", {}],
  ["GET", "/ts/reports"],
  ["GET", "/payout/kyc"],
  ["POST", "/payout/kyc/start", {}],
  ["POST", "/reports", { target_id: "user-owner", reason: "x" }],
  ["GET", "/safety/age"],
  ["POST", "/safety/age", { date_of_birth: "1990-01-01" }],
  ["POST", "/safety/report", { subject_type: "world", subject_id: "w", reason: "x" }],
  ["GET", "/safety/reports"],
  ["POST", `/safety/reports/${F.report}/moderate`, { action: "dismiss" }],
  ["POST", "/safety/block", { blocked_id: "user-x" }],
  ["DELETE", "/safety/block", { blocked_id: "user-x" }],
  ["GET", "/safety/blocks"],
  ["POST", "/safety/consent/parental", { minor_id: "user-x", guardian_email: "g@example.com" }],
  ["POST", "/safety/consent/media", { subject_id: "user-x", media_kind: "voice", source: "explicit_consent" }],
  ["GET", "/safety/consent/media"],
  ["POST", "/v3/marketplace/storefronts", { name: "x" }],
  ["POST", "/v3/marketplace/listings", { title: "x" }],
  ["DELETE", `/v3/marketplace/listings/${F.listing}`],
  ["POST", `/v3/marketplace/listings/${F.listing}/acquire`, {}],
  ["GET", "/v3/marketplace/owned"],
  ["GET", "/v3/marketplace/ledger"],
  ["POST", "/v3/subscriptions/subscribe", { plan: "dcs_plus" }],
  ["POST", "/v3/subscriptions/grant", { principal_id: "owner@dcsai.ai" }],
  ["POST", "/v3/subscriptions/revoke", { principal_id: "owner@dcsai.ai" }],
  ["GET", "/v3/subscriptions/grants"],
  ["GET", "/me/subscription"],
  ["GET", "/me/entitlements"],
  ["GET", "/verify/status"],
  ["POST", "/verify/email/start", { destination: "x@example.com" }],
  ["POST", "/verify/email/confirm", { code: "000000" }],
  ["DELETE", "/verify/email"],
  ["GET", "/me/achievements"],
  ["GET", "/me/streak"],
  ["GET", "/me/dashboard"],
  ["GET", "/me/profile"],
  ["PATCH", "/me/profile", { display_name: "x" }],
  ["GET", "/social/friends"],
  ["POST", "/social/friends", { friend_id: "user-owner" }],
  ["POST", "/social/friends/accept", { friend_id: "user-owner" }],
  ["DELETE", "/social/friends", { friend_id: "user-owner" }],
  ["POST", "/social/parties", { open: true }],
  ["GET", "/social/parties"],
  ["GET", `/social/parties/${F.privateParty}`],
  ["GET", `/social/parties/${F.openParty}`],
  ["POST", `/social/parties/${F.openParty}/join`, {}],
  ["POST", `/social/parties/${F.openParty}/leave`, {}],
  ["POST", "/social/teams", { name: "x" }],
  ["GET", "/social/teams"],
  ["GET", `/social/teams/${F.team}`],
  ["POST", `/social/teams/${F.team}/members`, { member_id: "user-x" }],
  ["DELETE", `/social/teams/${F.team}/members`, { member_id: "user-x" }],
  ["POST", "/social/orgs", { name: "x" }],
  ["GET", "/social/orgs"],
  ["GET", `/social/orgs/${F.org}`],
  ["POST", `/social/orgs/${F.org}/members`, { member_id: "user-x" }],
  ["DELETE", `/social/orgs/${F.org}/members`, { member_id: "user-x" }],
  ["POST", `/social/orgs/${F.org}/seats`, { seats: 9 }],
  ["POST", "/social/studios", { name: "x" }],
  ["GET", `/social/studios/${F.studio}`],
  ["POST", `/social/studios/${F.studio}/members`, { member_id: "user-x" }],
  ["POST", `/social/studios/${F.studio}/split`, { splits: [] }],
  ["POST", `/v3/worlds/${F.pubWorld}/rate`, { rating: 4 }],
  ["POST", "/v3/worlds/generate/async", { prompt: "x" }],
  ["GET", "/v3/jobs"],
  ["GET", `/v3/jobs/${F.job}`],
  ["DELETE", `/v3/jobs/${F.job}`],
  ["POST", "/v3/worlds/generate", { prompt: "x" }],
  ["POST", `/v3/worlds/${F.pubWorld}/playtest`, {}],
  ["POST", `/v3/worlds/${F.pubWorld}/expand`, { request: "add a park" }],
  ["POST", `/v3/worlds/${F.pubWorld}/edit`, { request: "rename it" }],
  ["POST", `/v3/worlds/${F.pubWorld}/media`, { kind: "image" }],
  ["POST", `/v3/worlds/${F.pubWorld}/stitch`, { guest_world_id: F.testerWorld }],
  ["POST", `/v3/worlds/${F.pubWorld}/stitch/preview`, { guest_world_id: F.testerWorld }],
  ["POST", `/v3/worlds/${F.pubWorld}/fork`, {}],
  ["POST", `/v3/worlds/${F.pubWorld}/quests/generate`, {}],
  ["POST", `/v3/worlds/${F.pubWorld}/rollback`, { to_version: 1 }],
  ["GET", `/v3/worlds/${F.pubWorld}/companion`],
  ["POST", `/v3/worlds/${F.pubWorld}/companion`, { action: "adopt" }],
  ["POST", "/worlds/generate", { prompt: "x" }],
  ["POST", `/worlds/${F.pubWorld}/publish`, {}],
  ["POST", `/worlds/${F.pubWorld}/save`, { manifest: {} }],
];

test("Q1: every private route refuses an anonymous caller", async () => {
  const bad = [];
  for (const [method, url, body] of PRIVATE_ROUTES()) {
    const r = await call("ANON", method, url, body);
    record(method, url, { ANON: r.status }, "anon-gate");
    // 401 is the right answer. 410 means the route is retired, which is also a
    // refusal. Anything else means an unauthenticated caller reached a decision.
    if (![401, 410].includes(r.status)) bad.push(`${method} ${url} -> ${r.status} ${r.text.slice(0, 120)}`);
  }
  assert.deepEqual(bad, [], "anonymous callers reached these routes:\n" + bad.join("\n"));
});

test("Q1: a malformed or expired credential is 401 and never falls back to anonymous", async () => {
  for (const token of ["garbage", "a.b.c", signLocalToken("the-wrong-secret", { sub: "user-owner" }, 3600), signLocalToken(SECRET, { sub: "user-owner" }, -10)]) {
    const r = await fetch(BASE + "/worlds/mine", { headers: { Authorization: "Bearer " + token } });
    assert.equal(r.status, 401, "a bad credential must be 401, never a silent anonymous read");
    const b = await r.json();
    assert.equal(b.ok, false);
    assert.ok(b.correlation_id, "every refusal carries a correlation id");
  }
});

// =====================================================================
// SECTION 2 — "logged in" is not "allowed".
//
// Every route that acts on a specific object, driven by a USER and by a
// TESTER who own NOTHING here. The expectation is the status each SHOULD
// return. Where the server disagrees the case is repeated below as a
// `DEFECT, OPEN:` test rather than being softened here.
// =====================================================================
const NON_OWNER_CASES = () => [
  // ---- worlds: a draft is private, a published world is public -------------
  { name: "GET a published manifest", method: "GET", url: `/v3/worlds/${F.pubWorld}/manifest`, USER: 200, TESTER: 200 },
  { name: "GET another creator's DRAFT manifest", method: "GET", url: `/v3/worlds/${F.draftWorld}/manifest`, USER: 404, TESTER: 404 },
  { name: "GET a published world's parts", method: "GET", url: `/v3/worlds/${F.pubWorld}/parts`, USER: 200, TESTER: 200 },
  { name: "GET another creator's DRAFT parts", method: "GET", url: `/v3/worlds/${F.draftWorld}/parts`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT attribution", method: "GET", url: `/v3/worlds/${F.draftWorld}/attribution`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT memory", method: "GET", url: `/v3/worlds/${F.draftWorld}/memory`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT versions", method: "GET", url: `/v3/worlds/${F.draftWorld}/versions`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT version body", method: "GET", url: `/v3/worlds/${F.draftWorld}/versions/1`, USER: 404, TESTER: 404 },
  { name: "GET a published world's UNPUBLISHED version body", method: "GET", url: `/v3/worlds/${F.pubWorld}/versions/1`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT diff", method: "GET", url: `/v3/worlds/${F.draftWorld}/diff?from=1&to=1`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT npc memory", method: "GET", url: `/v3/worlds/${F.draftWorld}/npcs/${F.draftNpc}/memory`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT legacy manifest", method: "GET", url: `/worlds/${F.draftWorld}/manifest`, USER: 404, TESTER: 404 },
  { name: "GET another creator's DRAFT runtime load", method: "GET", url: `/worlds/${F.draftWorld}/load`, USER: 404, TESTER: 404 },
  { name: "POST play on another creator's DRAFT", method: "POST", url: `/v3/worlds/${F.draftWorld}/play`, body: { seconds: 5 }, USER: 404, TESTER: 404 },
  { name: "POST rate another creator's DRAFT", method: "POST", url: `/v3/worlds/${F.draftWorld}/rate`, body: { rating: 4 }, USER: 404, TESTER: 404 },
  { name: "POST playtest another creator's DRAFT", method: "POST", url: `/v3/worlds/${F.draftWorld}/playtest`, body: {}, USER: 404, TESTER: 404 },
  { name: "POST companion on another creator's DRAFT", method: "POST", url: `/v3/worlds/${F.draftWorld}/companion`, body: { action: "adopt" }, USER: 404, TESTER: 404 },

  // ---- world WRITES belong to the owner alone -----------------------------
  { name: "POST expand another creator's world", method: "POST", url: `/v3/worlds/${F.pubWorld}/expand`, body: { request: "add a park" }, USER: 403, TESTER: 403 },
  { name: "POST edit another creator's world", method: "POST", url: `/v3/worlds/${F.pubWorld}/edit`, body: { request: "rename it" }, USER: 403, TESTER: 403 },
  { name: "POST media on another creator's world", method: "POST", url: `/v3/worlds/${F.pubWorld}/media`, body: { kind: "image" }, USER: 403, TESTER: 403 },
  { name: "POST stitch into another creator's world", method: "POST", url: `/v3/worlds/${F.pubWorld}/stitch`, body: { guest_world_id: F.testerWorld }, USER: 403, TESTER: 403 },
  { name: "POST stitch preview on another creator's world", method: "POST", url: `/v3/worlds/${F.pubWorld}/stitch/preview`, body: { guest_world_id: F.testerWorld }, USER: 403, TESTER: 403 },
  { name: "POST quests/generate on another creator's world", method: "POST", url: `/v3/worlds/${F.pubWorld}/quests/generate`, body: {}, USER: 403, TESTER: 403 },
  { name: "POST rollback another creator's world", method: "POST", url: `/v3/worlds/${F.pubWorld}/rollback`, body: { to_version: 1 }, USER: 403, TESTER: 403 },
  { name: "POST publish another creator's world", method: "POST", url: `/worlds/${F.pubWorld}/publish`, body: {}, USER: 403, TESTER: 403 },
  { name: "POST save a manifest over another creator's world", method: "POST", url: `/worlds/${F.pubWorld}/save`, body: { manifest: { meta: { title: "hijacked" } } }, USER: 403, TESTER: 403 },
  { name: "POST save a runtime delta over another creator's world", method: "POST", url: `/worlds/${F.pubWorld}/save`, body: { delta: { objects: [] } }, USER: 403, TESTER: 403 },
  { name: "POST list another creator's world for sale", method: "POST", url: "/v3/marketplace/listings", body: { world_id: F.pubWorld, title: "not mine" }, USER: 403, TESTER: 403 },

  // ---- the builder window: a plain USER is refused, a TESTER is not -------
  // 422 world_failed_playtest is the quality gate, not the authorisation gate:
  // either way the tester was ADMITTED and the plain user was not.
  { name: "POST /v3/worlds/generate", method: "POST", url: "/v3/worlds/generate", body: { prompt: `nonowner probe ${RUN}` }, USER: 403, TESTER: [200, 422] },
  { name: "POST /v3/worlds/generate/async", method: "POST", url: "/v3/worlds/generate/async", body: { prompt: `nonowner async ${RUN}` }, USER: 403, TESTER: 202 },
  { name: "POST /v3/marketplace/storefronts", method: "POST", url: "/v3/marketplace/storefronts", body: { name: "tester front" }, USER: 403, TESTER: 201 },
  { name: "GET /safety/reports (moderation queue)", method: "GET", url: "/safety/reports", USER: 403, TESTER: 200 },
  { name: "GET /v3/subscriptions/grants", method: "GET", url: "/v3/subscriptions/grants", USER: 403, TESTER: 200 },
  { name: "GET /payout/kyc", method: "GET", url: "/payout/kyc", USER: 403, TESTER: 200 },
  { name: "POST /social/orgs", method: "POST", url: "/social/orgs", body: { name: "tester org" }, USER: 403, TESTER: 201 },
  { name: "POST /social/studios", method: "POST", url: "/social/studios", body: { name: "tester studio" }, USER: 403, TESTER: 201 },

  // ---- social objects are private to their members ------------------------
  // 404 rather than 403 throughout: a refusal that says "exists, not yours"
  // confirms the id to a caller who may not see it. Same status, same code,
  // same detail as an object that was never created.
  { name: "GET another principal's invite-only party", method: "GET", url: `/social/parties/${F.privateParty}`, USER: 404, TESTER: 404 },
  { name: "JOIN another principal's invite-only party", method: "POST", url: `/social/parties/${F.privateParty}/join`, body: {}, USER: 404, TESTER: 404 },
  { name: "GET another principal's team", method: "GET", url: `/social/teams/${F.team}`, USER: 404, TESTER: 404 },
  { name: "ADD yourself to another principal's team", method: "POST", url: `/social/teams/${F.team}/members`, body: { member_id: "user-plain" }, USER: 404, TESTER: 404 },
  { name: "REMOVE a member of another principal's team", method: "DELETE", url: `/social/teams/${F.team}/members`, body: { member_id: "user-owner" }, USER: 404, TESTER: 404 },
  { name: "GET another principal's org", method: "GET", url: `/social/orgs/${F.org}`, USER: 404, TESTER: 404 },
  { name: "ADD yourself to another principal's org", method: "POST", url: `/social/orgs/${F.org}/members`, body: { member_id: "user-plain" }, USER: 404, TESTER: 404 },
  { name: "REMOVE a member of another principal's org", method: "DELETE", url: `/social/orgs/${F.org}/members`, body: { member_id: "user-owner" }, USER: 404, TESTER: 404 },
  { name: "CHANGE another principal's org seat count", method: "POST", url: `/social/orgs/${F.org}/seats`, body: { seats: 99 }, USER: 404, TESTER: 404 },
  { name: "ADD yourself to another principal's studio", method: "POST", url: `/social/studios/${F.studio}/members`, body: { member_id: "user-tester" }, USER: 403, TESTER: 404 },
  { name: "SET another principal's studio revenue split", method: "POST", url: `/social/studios/${F.studio}/split`, body: { splits: [{ member_id: "user-tester", split_bps: 10000 }] }, USER: 403, TESTER: 404 },

  // ---- jobs, listings and moderation --------------------------------------
  { name: "GET another principal's job", method: "GET", url: `/v3/jobs/${F.job}`, USER: 404, TESTER: 404 },
  { name: "CANCEL another principal's job", method: "DELETE", url: `/v3/jobs/${F.job}`, USER: 404, TESTER: 404 },
  { name: "UNLIST another creator's listing", method: "DELETE", url: `/v3/marketplace/listings/${F.listing}`, USER: 403, TESTER: 404 },
  { name: "MODERATE a report", method: "POST", url: `/safety/reports/${F.report}/moderate`, body: { action: "dismiss" }, USER: 403, TESTER: 200 },
];

test("Q2: a non-owner is refused every route that acts on someone else's object", async () => {
  const wrong = [];
  for (const c of NON_OWNER_CASES()) {
    const cells = {};
    for (const who of ["USER", "TESTER"]) {
      const r = await call(who, c.method, c.url, c.body);
      cells[who] = r.status;
      const want = Array.isArray(c[who]) ? c[who] : [c[who]];
      if (!want.includes(r.status)) {
        wrong.push(`${c.name}  [${who}]  expected ${want.join(" or ")}, got ${r.status}  ${String(r.text).slice(0, 150)}`);
      }
    }
    record(c.method, c.url, cells, c.name);
  }
  assert.deepEqual(wrong, [], "authorisation did not match the expected outcome:\n" + wrong.join("\n"));
});

// =====================================================================
// SECTION 3 — the owner reaches their own, and only their own.
// Mutating cases each get a FRESH world from the spare pool, so nothing in
// this suite depends on the order the tests happen to run in.
// =====================================================================
test("Q2: the owner reaches every route on their own objects", async () => {
  const wrong = [];
  const cases = [
    ["GET", `/worlds/mine`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/manifest`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/versions`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/versions/1`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/memory`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/parts`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/attribution`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/diff?from=1&to=1`, undefined, 200],
    ["GET", `/v3/worlds/${F.draftWorld}/npcs/${F.draftNpc}/memory`, undefined, 200],
    ["GET", `/worlds/${F.draftWorld}/manifest`, undefined, 200],
    ["GET", `/worlds/${F.draftWorld}/load`, undefined, 200],
    ["POST", `/v3/worlds/${F.draftWorld}/playtest`, {}, 200],
    ["GET", `/social/parties/${F.privateParty}`, undefined, 200],
    ["GET", `/social/teams/${F.team}`, undefined, 200],
    ["GET", `/social/orgs/${F.org}`, undefined, 200],
    ["GET", `/social/studios/${F.studio}`, undefined, 200],
    ["GET", `/v3/jobs/${F.job}`, undefined, 200],
    ["GET", "/v3/jobs", undefined, 200],
    ["GET", "/me/profile", undefined, 200],
    ["GET", "/me/dashboard", undefined, 200],
    ["GET", "/me/achievements", undefined, 200],
    ["GET", "/me/streak", undefined, 200],
    ["GET", "/me/subscription", undefined, 200],
    ["GET", "/me/entitlements", undefined, 200],
    ["GET", "/v3/marketplace/owned", undefined, 200],
    ["GET", "/v3/marketplace/ledger", undefined, 200],
    ["GET", "/safety/blocks", undefined, 200],
    ["GET", "/safety/consent/media", undefined, 200],
    ["GET", "/verify/status", undefined, 200],
    ["POST", `/social/orgs/${F.org}/members`, { member_id: "user-invitee" }, 200],
    ["POST", `/social/teams/${F.team}/members`, { member_id: "user-invitee" }, 200],
    ["POST", `/social/studios/${F.studio}/members`, { member_id: "user-invitee" }, 200],
    // mutating world routes, each on its own disposable world
    ["POST", `/v3/worlds/${SPARE[0]}/expand`, { request: "add a hospital district" }, 200],
    ["POST", `/v3/worlds/${SPARE[1]}/media`, { kind: "image", target: "thumbnail" }, 200],
    ["POST", `/v3/worlds/${SPARE[2]}/quests/generate`, {}, 200],
    // a rollback only goes backwards, so the world must have a v2 to come back from
    ["POST", `/v3/worlds/${SPARE[3]}/expand`, { request: "add a market district" }, 200],
    ["POST", `/v3/worlds/${SPARE[3]}/rollback`, { to_version: 1 }, 200],
    ["POST", `/v3/worlds/${SPARE[4]}/companion`, { action: "adopt" }, 200],
    ["POST", `/v3/worlds/${SPARE[5]}/stitch/preview`, { guest_world_id: SPARE[6] }, 200],
    ["POST", `/v3/worlds/${SPARE[7]}/stitch`, { guest_world_id: SPARE[8] }, 200],
    ["POST", `/worlds/${SPARE[9]}/publish`, {}, 200],
    ["POST", `/worlds/${SPARE[10]}/save`, { manifest: { meta: { title: "owner save" } } }, 200],
    ["POST", `/worlds/${SPARE[11]}/publish`, {}, 200],
  ];
  for (const [method, url, body, want] of cases) {
    const r = await call("OWNER", method, url, body);
    record(method, url, { OWNER: r.status }, "owner-path");
    if (r.status !== want) wrong.push(`OWNER ${method} ${url} expected ${want}, got ${r.status} ${String(r.text).slice(0, 160)}`);
  }
  assert.deepEqual(wrong, [], "the owner was refused their own:\n" + wrong.join("\n"));

  // Fork is the one route where being the owner is a REFUSAL: a creator expands
  // their own world, a stranger remixes it, and only a published world is
  // remixable at all. All three rules are authorisation rules, so all three are
  // asserted here rather than assumed.
  const own = await call("OWNER", "POST", `/v3/worlds/${SPARE[11]}/fork`, {});
  assert.equal(own.status, 422, "the owner forks nothing: " + String(own.text).slice(0, 160));
  const stranger = await call("TESTER", "POST", `/v3/worlds/${SPARE[11]}/fork`, {});
  assert.equal(stranger.status, 200, "a stranger may remix a PUBLISHED world: " + String(stranger.text).slice(0, 160));
  const draft = await call("TESTER", "POST", `/v3/worlds/${F.draftWorld}/fork`, {});
  assert.equal(draft.status, 404, "a stranger cannot remix a draft, and is told only that it is not there");
});

// =====================================================================
// SECTION 4 — does the RESPONSE leak another principal's data?
// =====================================================================
test("Q3: an open party shows capacity, never its members, leader or world", async () => {
  const r = await call("TESTER", "GET", `/social/parties/${F.openParty}`);
  assert.equal(r.status, 200);
  const p = r.body.party;
  assert.equal(p.redacted, true);
  assert.equal(p.leader_id, undefined, "a non-member must not learn who leads the party");
  assert.equal(p.world_id, undefined, "a non-member must not learn which world the party is in");
  assert.equal(p.members, undefined, "a non-member must not get the member list");
  assert.ok(typeof p.size === "number" && typeof p.max_size === "number", "capacity is what a join button needs");
  // and the member DOES get the whole record
  const own = await call("OWNER", "GET", `/social/parties/${F.openParty}`);
  assert.equal(own.body.party.leader_id, "user-owner");
});

test("Q3: /profiles/:username carries no email and no principal id", async () => {
  const r = await call("ANON", "GET", "/profiles/owner");
  assert.equal(r.status, 200);
  const s = JSON.stringify(r.body);
  assert.equal(r.body.profile.principal_id, undefined);
  assert.ok(!s.includes("owner@dcsai.ai"), "a public profile must never carry an email");
  assert.ok(!s.includes("user-owner"), "a public profile must never carry a principal id");
});

test("Q3: /me/* serves the caller's own data and never another principal's", async () => {
  for (const p of ["/me/profile", "/me/dashboard", "/me/achievements", "/me/streak", "/me/subscription", "/me/entitlements", "/worlds/mine", "/v3/jobs", "/social/friends", "/social/parties", "/social/teams", "/social/orgs", "/v3/marketplace/owned", "/v3/marketplace/ledger", "/safety/blocks", "/safety/consent/media", "/verify/status"]) {
    const r = await call("USER", "GET", p);
    assert.equal(r.status, 200, p);
    const s = JSON.stringify(r.body);
    assert.ok(!s.includes("user-owner"), `${p} leaked the owner's principal id`);
    assert.ok(!s.includes("owner@dcsai.ai"), `${p} leaked the owner's email`);
  }
});

test("Q3: a tester who is not a member gets nothing from another principal's team or org", async () => {
  for (const url of [`/social/teams/${F.team}`, `/social/orgs/${F.org}`]) {
    const r = await call("TESTER", "GET", url);
    // 404: the refusal must not confirm that the object exists either.
    assert.equal(r.status, 404, url);
    const s = JSON.stringify(r.body);
    assert.ok(!s.includes("user-owner"), `${url} named the owner in its refusal`);
    assert.ok(!s.includes("Owner Team") && !s.includes("Owner Org"), `${url} leaked the name in its refusal`);
  }
});

test("Q3/NOTE: a PUBLISHED world discloses its owner's principal id to anonymous callers", async () => {
  // Characterisation, not a defect claim: /v3/worlds/:id/manifest, /worlds/:id/load,
  // /v3/discover and /v3/marketplace all hand a raw principal id to an anonymous
  // caller, while GET /profiles/:username (server.mts:717-722) is deliberately built
  // to do the opposite ("no email, no principal id"). The two doctrines disagree.
  // Recorded here so the inconsistency is visible and a change is detected.
  const m = await call("ANON", "GET", `/v3/worlds/${F.pubWorld}/manifest`);
  assert.equal(m.status, 200);
  assert.equal(m.body.owner, "user-owner");
  const d = await call("ANON", "GET", "/v3/discover");
  assert.ok(d.body.worlds.some((w) => w.owner === "user-owner"));
  const mk = await call("ANON", "GET", "/v3/marketplace");
  assert.ok(mk.body.listings.some((l) => l.seller_id === "user-owner"));
  // No email ever escapes, in any of them.
  for (const r of [m, d, mk]) assert.ok(!JSON.stringify(r.body).includes("owner@dcsai.ai"));
});

// =====================================================================
// SECTION 5 — does the ERROR leak existence?
// "not yours" must be indistinguishable from "does not exist", in status AND
// body, for any caller who could have guessed the id.
// =====================================================================
/** Compare the answer for an object that exists but is not the caller's against one that was never created. */
async function oracle(who, method, existingUrl, missingUrl, body) {
  const a = await call(who, method, existingUrl, body);
  const b = await call(who, method, missingUrl, body);
  return { a, b, leaks: a.status !== b.status || (a.body?.error ?? null) !== (b.body?.error ?? null) };
}

test("Q4/CLOSED: a world read gives a stranger the same answer for private and non-existent", async () => {
  for (const who of ["ANON", "USER", "TESTER"]) {
    for (const [m, ex, ms] of [
      ["GET", `/v3/worlds/${F.draftWorld}/manifest`, `/v3/worlds/${F.missWorld}/manifest`],
      ["GET", `/v3/worlds/${F.draftWorld}/versions`, `/v3/worlds/${F.missWorld}/versions`],
      ["GET", `/v3/worlds/${F.draftWorld}/memory`, `/v3/worlds/${F.missWorld}/memory`],
      ["GET", `/worlds/${F.draftWorld}/manifest`, `/worlds/${F.missWorld}/manifest`],
      ["GET", `/worlds/${F.draftWorld}/load`, `/worlds/${F.missWorld}/load`],
    ]) {
      const o = await oracle(who, m, ex, ms);
      assert.equal(o.leaks, false, `${who} ${m} ${ex}: ${o.a.status}/${o.a.body?.error} vs missing ${o.b.status}/${o.b.body?.error}`);
      assert.equal(o.a.status, 404);
    }
  }
});

test("Q4/CLOSED: a retained version gives the same answer for private and non-existent", async () => {
  const o = await oracle("TESTER", "GET", `/v3/worlds/${F.pubWorld}/versions/1`, `/v3/worlds/${F.pubWorld}/versions/999`);
  assert.equal(o.leaks, false, "an unpublished version number must not be distinguishable from one that never existed");
  assert.equal(o.a.status, 404);
});

test("Q4/NOTE: the requireOwner write path answers 403 for a world that exists and 404 for one that does not", async () => {
  // src/core/worldstore.mjs:539-553 documents this as deliberate: a caller doing
  // an owner-only action "already knows the id exists". That reasoning holds for
  // a creator acting on their own library; it does NOT hold for a caller who
  // guessed the id, which is the exact threat model the READ side was fixed for.
  // Combined with the guessable legacy world ids proved below, this is a live
  // enumeration channel. Characterised rather than asserted away.
  const o = await oracle("TESTER", "POST", `/worlds/${F.pubWorld}/publish`, `/worlds/${F.missWorld}/publish`, {});
  assert.equal(o.a.status, 403, "exists-but-not-yours");
  assert.equal(o.b.status, 404, "never existed");
  assert.equal(o.leaks, true, "documented in worldstore.mjs:539-553 — see the report");
});

// =====================================================================
// SECTION 6 — can a route be reached by a different path?
// =====================================================================
test("Q5: a trailing slash, a doubled slash or a case change never reaches a gated handler", async () => {
  const variants = [
    "/worlds/mine/", "//worlds/mine", "/worlds//mine", "/API/worlds/mine", "/api/api/worlds/mine",
    "/me/profile/", "/me/Profile", "/safety/reports/", "/v3/subscriptions/grants/",
    `/social/studios/${F.studio}/`, `/social/teams/${F.team}/`, `/v3/jobs/${F.job}/`,
  ];
  for (const v of variants) {
    for (const who of ["ANON", "USER"]) {
      const r = await call(who, "GET", v);
      record("GET", v, { [who]: r.status }, "path-variant");
      assert.equal(r.status, 404, `${who} GET ${v} must not reach a handler: ${r.text.slice(0, 140)}`);
    }
  }
});

test("Q5: a method the router has no handler for is 404, never an ungated 200", async () => {
  for (const url of ["/worlds/mine", "/me/profile", "/v3/subscriptions/grants", `/social/studios/${F.studio}`, `/social/orgs/${F.org}`, `/v3/jobs/${F.job}`]) {
    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      const r = await call("ANON", method, url);
      record(method, url, { ANON: r.status }, "method-fallthrough");
      assert.ok([404, 401, 403, 422].includes(r.status), `${method} ${url} -> ${r.status}`);
      if (r.status === 200) assert.fail(`${method} ${url} answered 200 to an anonymous caller`);
    }
  }
});

test("Q5: OPTIONS preflight answers 204 with no body on a gated route", async () => {
  for (const url of ["/v3/subscriptions/grants", "/me/profile", `/social/studios/${F.studio}`]) {
    const r = await call("ANON", "OPTIONS", url);
    assert.equal(r.status, 204);
    assert.equal(r.text, "", "a preflight must not carry data");
  }
});

test("Q5/CLOSED: %2e%2e, double encoding and raw dot segments cannot escape the id space", async () => {
  // Driven straight onto the socket: fetch() resolves dot segments client-side,
  // so a %2e%2e sent through it never reaches the server as written. These are
  // the bytes an attacker actually puts on the wire.
  const lines = [
    "GET /v3/worlds/%2e%2e/manifest",
    "GET /v3/worlds/%2e%2e%2f%2e%2e/manifest",
    "GET /v3/worlds/..%2f..%2fetc%2fpasswd/manifest",
    "GET /v3/worlds/%252e%252e/manifest",
    "GET /v3/worlds/..%2F..%2F..%2F..%2Fetc%2Fpasswd/manifest",
    "GET /v3/worlds/%2e%2e%5c%2e%2e/manifest",
    "GET /v3/worlds/../manifest",
    "GET /v3/worlds/w3_x/../../worlds/mine",
    "GET /api/../worlds/mine",
    "GET /./worlds/mine",
    "GET /worlds/%2e%2e%2f%2e%2e%2f.dcs-data/manifest",
  ];
  for (const line of lines) {
    const r = await socketRequest(line);
    record("GET", line.slice(4), { ANON: r.status }, "traversal");
    // 422 = the id validator (src/core/worldstore.mjs:63) rejected it outright;
    // 404 = the router or the store had nothing there. Never a 200, and never
    // anything that looks like a manifest or a filesystem read.
    assert.ok([404, 422].includes(r.status), `${line} -> ${r.status}`);
    assert.ok(!/manifest_version|world_version|root:|BEGIN PRIVATE KEY/.test(r.raw), `${line} returned content`);
  }
});

test("Q5/CLOSED: x-user-id and its neighbours are inert", async () => {
  const anon = await call("ANON", "GET", "/worlds/mine", undefined, { "x-user-id": "user-owner" });
  assert.equal(anon.status, 401);
  assert.equal(anon.body.meta?.removed_header, "x-user-id");
  const bad = await fetch(BASE + "/worlds/mine", { headers: { Authorization: "Bearer nope", "x-user-id": "user-owner" } });
  assert.equal(bad.status, 401);
  for (const h of ["x-user-id", "x-principal-id", "x-uid", "x-forwarded-user"]) {
    const r = await call("USER", "GET", "/worlds/mine", undefined, { [h]: "user-owner" });
    assert.equal(r.status, 200);
    assert.equal(r.body.owner, "user-plain", `${h} must never override the token`);
  }
});

// =====================================================================
// SECTION 7 — DEFECTS. Each of these FAILS on purpose.
// =====================================================================

test("CLOSED: GET /social/studios/:id is members-only, and does not confirm the id to anyone else", async () => {
  // SEVERITY: HIGH — cross-principal membership and revenue-split disclosure.
  // REPRO: OWNER creates a studio; TESTER, who is on the internal-tester
  //   allowlist but is NOT a member of it, reads it and gets everything.
  // WHY IT SURVIVED: server.mts:844-848 gates the route with
  //   mustBeInternalTester and then calls social.getStudio(mm[1]) with NO
  //   requester at all. The sibling reads were all closed this sprint —
  //   getOrg (social.mjs:866), getTeam (social.mjs:711) and getParty
  //   (social.mjs:586) each take a requesterId and refuse a non-member.
  //   getStudio is the one that was reported as the same shape and not closed.
  // FIX: src/core/social.mjs:777 — `async getStudio(studioId, requesterId)`,
  //   refusing when the requester is not in studio_members; and
  //   server.mts:845 must pass `me.id`. Note the three internal callers —
  //   createStudio (social.mjs:774), addStudioMember (social.mjs:845) and
  //   setStudioSplit (social.mjs:820) — must pass the acting principal too.
  const r = await call("TESTER", "GET", `/social/studios/${F.studio}`);
  // 404, not 403: a non-member is told exactly what someone asking about a
  // studio that does not exist is told, so this cannot confirm an id either.
  assert.equal(
    r.status, 404,
    `a non-member read the studio: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`
  );
  const missing = await call("TESTER", "GET", "/social/studios/std_does_not_exist");
  assert.equal(missing.status, 404);
  assert.equal(r.body?.error, missing.body?.error, "the error code must not distinguish the two");
});

test("CLOSED: a voice/likeness consent can only be recorded by its own subject", async () => {
  // SEVERITY: CRITICAL — the A5 likeness gate is opt-in by the caller it exists
  //   to protect against, and the subject is never asked.
  // REPRO (each step verified):
  //   1. TESTER asks for voice media of user-owner   -> 403, no consent recorded
  //   2. USER (a plain, non-tester account) POSTs
  //      /safety/consent/media {subject_id:"user-owner", media_kind:"voice",
  //      source:"explicit_consent"}                  -> 201, row written
  //   3. GET /safety/consent/media as OWNER shows a grant OWNER never made
  //   4. TESTER asks for voice media of user-owner again -> 200, gate passed
  // WHY IT SURVIVED: server.mts:532-536 takes the subject straight from the
  //   request body — `safety.grantMediaConsent(b.subject_id || me.id, ...)` —
  //   with no check that the caller IS the subject, no staff role, and no
  //   record of who granted it (src/core/safety.mjs grantMediaConsent stores
  //   principal_id but never a granter). safety.requireMediaConsent
  //   (src/core/safety.mjs, used at server.mts:1152-1157) then honours it.
  // FIX: server.mts:532-536 must bind the grant to me.id, or require the
  //   subject's own attestation; src/core/safety.mjs grantMediaConsent should
  //   take and persist the granting principal so a forged row is attributable.
  const before = await call("TESTER", "POST", `/v3/worlds/${F.testerWorld}/media`, {
    kind: "voice", target: "narration", subject_id: "user-owner", source: "explicit_consent",
  });
  assert.equal(before.status, 403, "precondition: no consent exists for user-owner yet");

  const forged = await call("USER", "POST", "/safety/consent/media", {
    subject_id: "user-owner", media_kind: "voice", source: "explicit_consent", evidence_ref: "forged-by-a-stranger",
  });
  assert.ok(
    [401, 403].includes(forged.status),
    `a stranger recorded a voice consent for user-owner: ${forged.status} ${JSON.stringify(forged.body).slice(0, 260)}`
  );
});

test("DEFECT, OPEN: GET /v3/worlds/:id/stats serves a DRAFT world's play counts and ratings to anonymous callers", async () => {
  // SEVERITY: HIGH — insider-only engagement numbers for a private world.
  // REPRO: OWNER creates a draft, plays it and rates it. GET
  //   /v3/worlds/<draft>/manifest is a correct 404 for everyone else, but
  //   GET /v3/worlds/<draft>/stats answers 200 with
  //   {plays, unique_players, total_seconds, rating_count, rating_avg}
  //   to a caller with no credential at all.
  // WHY IT SURVIVED: server.mts:906-909 is the only world route with no
  //   repo.get() permission check before it answers — its neighbours
  //   /memory (server.mts:1477), /parts (server.mts:1270) and /attribution
  //   (server.mts:1306) all take one.
  // FIX: server.mts:907 — `await repo.get(mm[1], { requesterId: principal?.id ?? null })`
  //   before serving, exactly as server.mts:1477 does. Note this also removes
  //   the second half of the leak: today the route 200s for a world that does
  //   not exist, so a zeroed answer and a real one are distinguishable.
  const anon = await call("ANON", "GET", `/v3/worlds/${F.draftWorld}/stats`);
  const manifest = await call("ANON", "GET", `/v3/worlds/${F.draftWorld}/manifest`);
  assert.equal(manifest.status, 404, "precondition: the draft is private to everyone else");
  assert.equal(
    anon.status, 404,
    `an anonymous caller read a private world's engagement: ${anon.status} ${JSON.stringify(anon.body).slice(0, 240)}`
  );
});

test("DEFECT, OPEN: POST /auth/{login,signup,ensure} lets an anonymous caller write another principal's identity record", async () => {
  // SEVERITY: HIGH — unauthenticated cross-principal write, and a vended
  //   credential that is not one.
  // REPRO: with no credential, POST /auth/login {id:"user-owner", name:"PWNED"}
  //   -> 200. The slice creates/keeps a user row under the id the CALLER chose.
  //   GET /me, presented with user-owner's REAL and valid token, then returns
  //   name:"PWNED" — the attacker chose what the victim's own profile says.
  //   The same body also returns {token:"user-owner"}, which is not a credential:
  //   presenting it is a 401 "malformed token". A client that believes the field
  //   is a session token is broken by design.
  // WHY IT SURVIVED: src/cw1/identity-slice.mjs:115-119 runs BEFORE every gate
  //   in server.mts (it is dispatched at server.mts:388) and derives the subject
  //   from `b.id` with no auth at all. Its siblings in the same file were
  //   retired for exactly this class of problem (RETIRED_SOCIAL, lines 88-100;
  //   the verify routes at lines 145-149 were retired for returning a code).
  // FIX: src/cw1/identity-slice.mjs:115-119 — retire these three paths the way
  //   the sibling social routes were, or bind the row to the resolved principal
  //   and never to a caller-supplied id. The real signup/login path already
  //   exists at server.mts:372-388 behind Supabase.
  const attack = await call("ANON", "POST", "/auth/login", { id: "user-owner", name: "PWNED-BY-A-STRANGER" });
  assert.ok(
    [401, 403, 404, 410].includes(attack.status),
    `anonymous POST /auth/login accepted a caller-chosen principal id: ${attack.status} ${String(attack.text).slice(0, 220)}`
  );
});

test("DEFECT, OPEN: GET /me fabricates a profile for a principal that has no record", async () => {
  // SEVERITY: MEDIUM — a fabricated record served as a measurement, which is
  //   the estate's own stated line ("honest data: unknown -> zeros/empty,
  //   never fabricated", server.mts:4).
  // REPRO: USER holds a valid token but has never touched the identity slice's
  //   in-memory store. GET /me answers 200 with
  //   {initials:"", level:"explorer", email_verified:false, atlas_score:0, ...}
  //   and NO id field — buildMe(undefined). A client cannot tell this from a
  //   real, empty profile.
  // FIX: src/cw1/identity-slice.mjs:120 — 404 when db.users has no row for the
  //   principal, as the sibling /profile/:username route at line 121 already does.
  const r = await call("USER", "GET", "/me");
  assert.notEqual(r.status, 200, `GET /me invented a profile: ${r.status} ${String(r.text).slice(0, 200)}`);
});

test("DEFECT, OPEN: legacy world ids are sha256(prompt), so they are guessable and collide across principals", async () => {
  // SEVERITY: MEDIUM-HIGH — two consequences, both cross-principal.
  //   (a) POST /worlds/generate answers 403 "this world belongs to another
  //       creator" when a DIFFERENT principal already generated from that exact
  //       prompt, and 200 otherwise: a prompt-space existence oracle.
  //   (b) every legacy world's id is computable offline from a guessed prompt,
  //       with no request to this service at all. Chained with the /stats defect
  //       above, an anonymous caller reads a private world's engagement without
  //       ever having been shown an id.
  // REPRO: the id returned by POST /worlds/generate equals
  //   "world_" + sha256(prompt).slice(0,12), computed here locally.
  // WHY IT SURVIVED: src/cw2/generate.mjs:101 seeds the id with the prompt
  //   (`seed = prompt` at line 97). The v3 path does not — server.mts:1010
  //   uses crypto.randomUUID().
  // FIX: src/cw2/generate.mjs:101 — mint a random id as the v3 path does, and
  //   keep the prompt seed for the deterministic CONTENT only.
  const prompt = `a prompt only its author should know ${RUN}`;
  const predicted = "world_" + crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 12);
  const r = await call("OWNER", "POST", "/worlds/generate", { prompt });
  assert.equal(r.status, 200, "precondition: the owner can create");
  assert.notEqual(
    r.body.world_id, predicted,
    `the world id is a pure function of the prompt: predicted ${predicted} offline and the server returned the same`
  );
});

test("DEFECT, OPEN: a second creator learns another principal's prompt from POST /worlds/generate", async () => {
  // SEVERITY: MEDIUM — the observable half of the defect above.
  // REPRO: OWNER generates from prompt P. TESTER generates from the SAME P and
  //   gets 403 "this world belongs to another creator"; from an unused prompt,
  //   200. The status alone confirms whether a given prompt has been used, by
  //   whom it is owned being implied.
  // FIX: src/cw2/generate.mjs:101 (random id), and server.mts:1508-1516 should
  //   never surface an ownership conflict as the result of a CREATE.
  const shared = `a shared prompt ${RUN}`;
  const mine = await call("OWNER", "POST", "/worlds/generate", { prompt: shared });
  assert.equal(mine.status, 200, "precondition: owner creates first");
  const theirs = await call("TESTER", "POST", "/worlds/generate", { prompt: shared });
  const unused = await call("TESTER", "POST", "/worlds/generate", { prompt: `an unused prompt ${RUN}` });
  assert.equal(
    theirs.status, unused.status,
    `creating from a prompt another principal used answers ${theirs.status} while an unused prompt answers ${unused.status}`
  );
});

const ORACLE_CASES = () => [
  { what: "GET /social/teams/:id", method: "GET", exists: `/social/teams/${F.team}`, missing: `/social/teams/${F.missTeam}`, fix: "src/core/social.mjs:711-719 (getTeam) — refuse a non-member with the same status and body readTeam gives for an id that was never created" },
  { what: "GET /social/orgs/:id", method: "GET", exists: `/social/orgs/${F.org}`, missing: `/social/orgs/${F.missOrg}`, fix: "src/core/social.mjs:866-874 (getOrg) — same" },
  { what: "GET /social/parties/:id (invite-only)", method: "GET", exists: `/social/parties/${F.privateParty}`, missing: `/social/parties/${F.missParty}`, fix: "src/core/social.mjs:596-601 (getParty) — an invite-only party must answer as a party that does not exist" },
  { what: "POST /social/parties/:id/join (invite-only)", method: "POST", body: {}, exists: `/social/parties/${F.privateParty}/join`, missing: `/social/parties/${F.missParty}/join`, fix: "src/core/social.mjs:627 (joinParty)" },
  { what: "GET /v3/jobs/:id", method: "GET", exists: `/v3/jobs/${F.job}`, missing: `/v3/jobs/${F.missJob}`, fix: "src/core/jobs.mjs:95-99 (get) — a job belonging to another principal must answer 404, as worldstore.mjs:562 does for a world" },
  { what: "DELETE /v3/jobs/:id", method: "DELETE", exists: `/v3/jobs/${F.job}`, missing: `/v3/jobs/${F.missJob}`, fix: "src/core/jobs.mjs:146 (cancel), via the same get()" },
  { what: "DELETE /v3/marketplace/listings/:id", method: "DELETE", exists: `/v3/marketplace/listings/${F.listing}`, missing: `/v3/marketplace/listings/${F.missListing}`, fix: "src/core/marketplace.mjs:103-107 (unlist)" },
  { what: "GET /social/studios/:id", method: "GET", exists: `/social/studios/${F.studio}`, missing: `/social/studios/${F.missStudio}`, fix: "src/core/social.mjs:777 (getStudio) — today it 200s, which is worse than an oracle; see the studio defect above" },
];

test("CLOSED: the existence oracle is closed on teams, orgs, parties, jobs, listings and studios", async () => {
  // SEVERITY: MEDIUM — id-space enumeration by an authenticated caller.
  // The estate closed exactly this on worlds (src/core/worldstore.mjs:539-563)
  // and on retained versions (worldstore.mjs:588-598), with the reasoning
  // written out in full: "a caller who may not see a world is told exactly what
  // a caller asking about a world that was never created is told — same status,
  // same code, same detail string". That reasoning was never carried across to
  // the other id spaces. Each row below shows a status pair that separates
  // "exists, not yours" from "never existed".
  const leaks = [];
  for (const c of ORACLE_CASES()) {
    const o = await oracle("TESTER", c.method, c.exists, c.missing, c.body);
    record(c.method, c.exists, { TESTER: o.a.status }, "oracle-exists");
    record(c.method, c.missing, { TESTER: o.b.status }, "oracle-missing");
    if (o.leaks) {
      leaks.push(
        `${c.what}\n    exists-but-not-mine = ${o.a.status}/${o.a.body?.error}` +
        `\n    never existed        = ${o.b.status}/${o.b.body?.error}` +
        `\n    FIX: ${c.fix}`
      );
    }
  }
  assert.deepEqual(leaks, [], "these surfaces confirm which ids are real:\n" + leaks.join("\n"));
});

test("CLOSED: a play is attributable, so an anonymous caller cannot move a ranking signal", async () => {
  // SEVERITY: MEDIUM — unauthenticated write to another principal's ranking
  //   signal. /v3/discover "ranks on MEASURED activity only" (server.mts:864),
  //   and this is the measurement.
  // REPRO: 25 anonymous POSTs to /v3/worlds/<published>/play with
  //   {seconds: 999999} take plays from 0 to 25 and total_seconds to 360000
  //   (each call clamped to 14400s = 4h), with unique_players still 0. No
  //   credential, no rate limit, no dedupe.
  // WHY IT SURVIVED: server.mts:874-897 resolves the caller with whoOrNull and
  //   records the play for principal null. Recording anonymous plays is
  //   deliberate ("no row, no ranking"), but an unauthenticated, unbounded,
  //   repeatable write to a competitor's ranking is not.
  // FIX: server.mts:882 — an anonymous play must be de-duplicated or rate
  //   limited per source before social.recordPlay is called, or excluded from
  //   the ranking inputs that social.discover reads.
  const world = SPARE[12];
  await call("OWNER", "POST", `/worlds/${world}/publish`, {});
  const before = (await call("ANON", "GET", `/v3/worlds/${world}/stats`)).body.stats;
  for (let i = 0; i < 25; i++) await call("ANON", "POST", `/v3/worlds/${world}/play`, { seconds: 999999 });
  const after = (await call("ANON", "GET", `/v3/worlds/${world}/stats`)).body.stats;
  assert.ok(
    after.plays - before.plays <= 1,
    `25 anonymous calls added ${after.plays - before.plays} plays and ${after.total_seconds - before.total_seconds}s of watch time to another creator's world`
  );
});

test("DEFECT, OPEN: POST /subscriptions answers 200 to a caller with no credential", async () => {
  // SEVERITY: LOW — no data moves, but a money-adjacent route answers an
  //   unauthenticated caller with ok-shaped output, and its own sibling
  //   GET /subscriptions (src/cw1/identity-slice.mjs:133) requires auth.
  // REPRO: POST /subscriptions with no Authorization header -> 200
  //   {"status":"dark","note":"written by CW8 payments; DARK until DK flips"}
  // FIX: src/cw1/identity-slice.mjs:134 — call who(req) as the GET does, or
  //   retire the pair; /v3/subscriptions/* is the real surface.
  const r = await call("ANON", "POST", "/subscriptions", {});
  assert.equal(r.status, 401, `an anonymous caller got ${r.status} ${String(r.text).slice(0, 160)}`);
});

test("DEFECT, OPEN: /health answers every HTTP method, including the ones it has no handler for", async () => {
  // SEVERITY: LOW — no data exposure (the payload is public), but it is a real
  //   router fall-through: server.mts:289 matches on the path with no method
  //   guard, so POST/PUT/DELETE/PATCH /health all return the full 200 body.
  //   Every other route in the file pairs a path with a method.
  // FIX: server.mts:289 — `if (url === "/health" && method === "GET")`.
  const bad = [];
  for (const m of ["POST", "PUT", "DELETE", "PATCH"]) {
    const r = await call("ANON", m, "/health");
    if (r.status === 200) bad.push(`${m} /health -> 200`);
  }
  assert.deepEqual(bad, [], "a GET-only route answered other methods:\n" + bad.join("\n"));
});

// =====================================================================
// SECTION 8 — regressions that must stay closed.
// =====================================================================
test("CLOSED: money is dark on every surface that could report otherwise", async () => {
  const h = await call("ANON", "GET", "/health");
  assert.equal(h.body.payments_live, false);
  for (const p of ["/v3/marketplace/assert-dark", "/v3/subscriptions/assert-dark"]) {
    const r = await call("ANON", "GET", p);
    assert.equal(r.status, 200, `${p} would answer 500 if money were live`);
    assert.equal(r.body.ok, true);
  }
  const sub = await call("USER", "POST", "/v3/subscriptions/subscribe", { plan: "dcs_plus" });
  assert.equal(sub.status, 503, "nothing can be bought: there is no PSP");
});

test("CLOSED: the retired surfaces stay retired for every caller", async () => {
  for (const [method, url] of [["GET", "/me/revenue"], ["GET", "/friends"], ["GET", "/parties"], ["GET", "/teams"], ["GET", "/studios/x"], ["GET", "/orgs/x"], ["POST", "/verify/email/start"], ["POST", "/verify/email/confirm"]]) {
    for (const who of CALLERS) {
      const r = await call(who, method, url, method === "POST" ? {} : undefined);
      assert.equal(r.status, 410, `${who} ${method} ${url} -> ${r.status}`);
    }
  }
});

test("CLOSED: a non-tester is refused every builder surface with the window named", async () => {
  for (const [method, url, body] of [["POST", "/v3/worlds/generate", { prompt: "x" }], ["POST", "/worlds/generate", { prompt: "x" }], ["POST", "/v3/worlds/generate/async", { prompt: "x" }], ["GET", "/safety/reports"], ["GET", "/v3/subscriptions/grants"], ["POST", "/social/orgs", { name: "x" }], ["POST", "/social/studios", { name: "x" }], ["POST", "/v3/marketplace/storefronts", { name: "x" }]]) {
    const r = await call("USER", method, url, body);
    assert.equal(r.status, 403, `${method} ${url}`);
    assert.equal(r.body.error, "forbidden");
    assert.equal(r.body.meta?.window_ends, "2026-09-30", "the refusal must name the window it is enforcing");
  }
});

test("CLOSED: the T&S console and payout KYC are internal-tester only", async () => {
  for (const [method, url] of [["GET", "/ts/reports"], ["GET", "/payout/kyc"], ["POST", "/payout/kyc/start"]]) {
    assert.equal((await call("ANON", method, url, method === "POST" ? {} : undefined)).status, 401);
    assert.equal((await call("USER", method, url, method === "POST" ? {} : undefined)).status, 403);
  }
  // and the moderator queue refuses even an internal tester who is not a moderator
  assert.equal((await call("TESTER", "GET", "/ts/reports")).status, 403);
});

test("CLOSED: /verify does not reflect caller-supplied receipt content as HTML", async () => {
  const evil = Buffer.from(JSON.stringify({
    attestation: "<script>alert(1)</script>", attested_by: "<img src=x onerror=alert(2)>",
    subject_type: "world", subject_id: "y", sig: "z", signer: "s",
  })).toString("base64");
  const r = await fetch(BASE + "/verify?receipt=" + encodeURIComponent(evil));
  const html = await r.text();
  assert.equal(r.status, 200);
  // The page escapes < > & " (src/cw7/atlas-verify-page.mjs:10-12), so the
  // payload may appear as TEXT but must never appear as markup.
  assert.ok(!html.includes("<script>alert"), "a receipt must not be able to inject a script tag");
  assert.ok(!html.includes("<img "), "a receipt must not be able to inject an element with an event handler");
  assert.ok(html.includes("&lt;script&gt;"), "the payload is rendered as escaped text, which is the correct handling");
});

test("CLOSED: the public trust surface is public and carries no private data", async () => {
  for (const p of ["/atlas/key", "/atlas/builder/user-owner", "/atlas/world/" + F.pubWorld, "/api/atlas/cross/user-owner", "/v3/marketplace/assert-dark", "/v3/subscriptions/plans", "/v3/providers", "/safety/moderation-history", "/v3/marketplace/split?gross_minor=1000", "/api/public/worlds"]) {
    const r = await call("ANON", "GET", p);
    record("GET", p, { ANON: r.status }, "public");
    assert.equal(r.status, 200, p);
    assert.ok(!JSON.stringify(r.body).includes("owner@dcsai.ai"), `${p} leaked an email`);
  }
  const miss = await call("ANON", "GET", "/atlas/receipt/nothing-was-ever-issued-here");
  assert.equal(miss.status, 404);
});

test("CLOSED: a member's own writes are honoured and a self-removal is not privilege escalation", async () => {
  // The owner adds the tester to a team, the tester may then read it, and the
  // tester may remove THEMSELVES but not the owner.
  const t = await call("OWNER", "POST", "/social/teams", { name: "Shared Team" });
  const id = t.body.team.id;
  assert.equal((await call("TESTER", "GET", `/social/teams/${id}`)).status, 404, "not a member yet — and told nothing about whether it exists");
  assert.equal((await call("OWNER", "POST", `/social/teams/${id}/members`, { member_id: "user-tester" })).status, 200);
  assert.equal((await call("TESTER", "GET", `/social/teams/${id}`)).status, 200, "a member reads it");
  assert.equal((await call("TESTER", "POST", `/social/teams/${id}/members`, { member_id: "user-plain" })).status, 403, "a plain member cannot add");
  assert.equal((await call("TESTER", "DELETE", `/social/teams/${id}/members`, { member_id: "user-owner" })).status, 403, "a member cannot remove the owner");
  assert.equal((await call("TESTER", "DELETE", `/social/teams/${id}/members`, { member_id: "user-tester" })).status, 200, "a member may leave");
  assert.equal((await call("TESTER", "GET", `/social/teams/${id}`)).status, 404, "and loses the read afterwards");
});

test("CLOSED: a rating and a friendship cannot be cast on another principal's behalf", async () => {
  const w = SPARE[13];
  await call("OWNER", "POST", `/worlds/${w}/publish`, {});
  const a = await call("USER", "POST", `/v3/worlds/${w}/rate`, { rating: 1 });
  const b = await call("USER", "POST", `/v3/worlds/${w}/rate`, { rating: 1 });
  assert.equal(a.status, 200);
  assert.equal(b.body.stats.rating_count, 1, "one principal, one rating");
  await call("USER", "POST", "/social/friends", { friend_id: "user-owner" });
  const steal = await call("TESTER", "POST", "/social/friends/accept", { friend_id: "user-plain" });
  assert.equal(steal.status, 404, "a third party cannot accept a request addressed to someone else");
  const list = await call("OWNER", "GET", "/social/friends");
  assert.ok(list.body.incoming.some((x) => x.id === "user-plain"), "the request is still the owner's to accept");
});

test("CLOSED: /health advertises the surface and every advertised route answers its own method", async () => {
  const h = await call("ANON", "GET", "/health");
  assert.equal(h.status, 200);
  const advertised = Object.entries(h.body.routes)
    .filter(([group]) => group !== "retired")
    .flatMap(([, list]) => list);
  assert.ok(advertised.length > 40, "the advertised surface must not shrink silently");
  const missing = [];
  for (const entry of advertised) {
    const [method, tmpl] = entry.split(" ");
    // Every placeholder must be substituted, or the probe tests the router's
    // handling of a literal ":n" rather than the route. `:n` is a VERSION
    // NUMBER and the router matches it with (\d+), so leaving it literal made a
    // route that exists (server.mts, /v3/worlds/:id/versions/(\d+)) look like
    // drift. `\b` stops `/:n` from eating the `:n` inside `/:npc`.
    const url = tmpl
      .replace("/:id/", `/${F.pubWorld}/`)
      .replace(/\/:id$/, `/${F.pubWorld}`)
      .replace("/:username", "/owner")
      .replace("/:channel/", "/email/")
      // ...and at the end of a path too: DELETE /verify/:channel revokes a
      // verification. Substituting only the mid-path form left the trailing one
      // literal, which read as drift in a route that exists.
      .replace(/\/:channel$/, "/email")
      .replace(/\/:npc\b/, "/npc_any")
      .replace(/\/:n\b/, "/1");
    assert.doesNotMatch(url, /\/:/, `the drift probe left a placeholder unsubstituted in ${tmpl}`);
    const r = await call("OWNER", method, url, method === "GET" ? undefined : {});
    // Any answer but "the router has no such route" proves the advertisement is real.
    if (r.status === 404 && r.body?.path) missing.push(`${entry} -> router 404 at ${r.body.path}`);
  }
  assert.deepEqual(missing, [], "/health advertises routes the router does not serve:\n" + missing.join("\n"));
});
