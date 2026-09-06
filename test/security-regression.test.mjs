// Security regressions — one test per defect fixed this sprint, written so the
// defect cannot come back quietly.
//
// Each test names the property being protected and carries, in a comment, the
// exact defect it exists to prevent returning. Nothing here starts a server:
// the modules are the chokepoints, so the modules are what is asserted.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPrincipalResolver, signLocalToken, verifyLocalToken } from "../src/core/principal.mjs";
import { createVerificationService } from "../src/core/verification.mjs";
import { createMarketplaceService } from "../src/core/marketplace.mjs";
import { createSocialService } from "../src/core/social.mjs";
import { createSubscriptionsService, INTERNAL_WINDOW_ENDS, PAID_STATUSES } from "../src/core/subscriptions.mjs";
import { WorldRepository, FileWorldStore, VersionHistoryStore } from "../src/core/worldstore.mjs";

const SECRET = "regression-secret-not-a-real-key";
const local = (o = {}) => createPrincipalResolver({ localSecret: SECRET, supabaseUrl: "", supabaseKey: "", ...o });
const tmpEnv = (prefix, extra = {}) => ({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), ...extra });
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// ============================================================ auth: principal
//
// DEFECT (Round-2 P0, confirmed live in production 6 Sep 2026):
//   GET /api/worlds/mine
//   Authorization: Bearer nope
//   x-user-id: victim-uuid
//   -> HTTP 200 {"ok":true,"owner":"victim-uuid"}
// An unverifiable token fell through to an attacker-controlled header, so any
// caller could act as any user by naming them. src/core/principal.mjs is now the
// single place a request becomes an identity, and it has no header path at all.

test("a request header can never, on its own, authenticate a caller", async () => {
  // Prevents the return of: x-user-id treated as an identity.
  await assert.rejects(
    () => local().resolve({ "x-user-id": "victim-uuid" }),
    (e) => e.code === "unauthenticated" && e.httpStatus === 401 && /x-user-id is not an authentication mechanism/.test(e.detail)
  );
});

test("an unverifiable token is refused rather than falling through to a header", async () => {
  // Prevents the return of: the exact live P0 request above. The header names are
  // lower-cased because that is the shape node:http hands the resolver; the
  // variants cover the ways the same request can arrive on the wire.
  for (const headers of [
    { authorization: "Bearer nope", "x-user-id": "victim-uuid" },
    { authorization: "bearer nope", "x-user-id": "victim-uuid" },
    { authorization: "Bearer   nope  ", "x-user-id": "victim-uuid" },
    { authorization: ["Bearer nope"], "x-user-id": ["victim-uuid"] },
  ]) {
    await assert.rejects(
      () => local().resolve(headers),
      (e) => e.httpStatus === 401 && e.code === "invalid_token",
      `headers ${JSON.stringify(headers)} must 401`
    );
  }
});

test("a valid token identifies its own subject and a forged header is ignored", async () => {
  // Prevents the return of: the header winning over, or merging with, the token.
  const p = await local().resolve({
    authorization: "Bearer " + signLocalToken(SECRET, { sub: "user-alice", email: "alice@dcsai.ai" }),
    "x-user-id": "victim-uuid",
  });
  assert.equal(p.id, "user-alice");
  assert.equal(p.source, "local-hs256");
  assert.ok(!JSON.stringify(p).includes("victim-uuid"), "no attacker-supplied value may reach the principal");
});

test("a token that declares no algorithm is refused", async () => {
  // Prevents the return of: alg:none, the classic unsigned-JWT bypass.
  const t = `${b64u({ alg: "none", typ: "JWT" })}.${b64u({ sub: "user-admin", exp: 4e9 })}.`;
  await assert.rejects(() => local().resolve({ authorization: "Bearer " + t }),
    (e) => e.httpStatus === 401 && e.detail === "unsupported algorithm");
});

test("a token that substitutes a different algorithm is refused", async () => {
  // Prevents the return of: alg confusion — an asymmetric alg whose "verification"
  // would use a public value as an HMAC secret, or a case-varied alg that slips
  // past a loose comparison.
  for (const alg of ["RS256", "ES256", "HS512", "hs256", "None", "", null]) {
    const t = `${b64u({ alg, typ: "JWT" })}.${b64u({ sub: "user-admin", exp: 4e9 })}.sig`;
    await assert.rejects(() => local().resolve({ authorization: "Bearer " + t }),
      (e) => e.httpStatus === 401, `alg=${JSON.stringify(alg)} must be refused`);
  }
});

test("a token signed with another secret is refused", async () => {
  // Prevents the return of: an unverified signature being accepted as proof.
  await assert.rejects(
    () => local().resolve({ authorization: "Bearer " + signLocalToken("attacker-secret", { sub: "user-alice" }) }),
    (e) => e.httpStatus === 401 && e.detail === "signature mismatch"
  );
});

test("an expired token is refused", async () => {
  // Prevents the return of: an unbounded session surviving revocation.
  await assert.rejects(
    () => local().resolve({ authorization: "Bearer " + signLocalToken(SECRET, { sub: "user-alice" }, -10) }),
    (e) => e.detail === "token expired"
  );
  assert.throws(() => verifyLocalToken(SECRET, signLocalToken(SECRET, { sub: "u" }, -1)), /expired/);
});

test("a token carrying no subject is refused", async () => {
  // Prevents the return of: a principal with an undefined id, which downstream
  // ownership filters would have matched far too widely.
  await assert.rejects(() => local().resolve({ authorization: "Bearer " + signLocalToken(SECRET, { email: "x@y.z" }) }),
    (e) => e.detail === "token carries no subject");
});

test("an unreachable auth service fails closed rather than open", async () => {
  // Prevents the return of: a network failure being treated as "probably fine".
  const r = createPrincipalResolver({
    supabaseUrl: "https://example.supabase.co", supabaseKey: "svc",
    fetch: async () => { throw new Error("ECONNREFUSED"); },
  });
  await assert.rejects(() => r.resolve({ authorization: "Bearer whatever", "x-user-id": "victim-uuid" }),
    (e) => e.httpStatus === 502 && e.code === "upstream_failure");
});

test("an auth service rejection never yields a header identity", async () => {
  // Prevents the return of: the P0, in the supabase-backed mode specifically.
  const r = createPrincipalResolver({
    supabaseUrl: "https://example.supabase.co", supabaseKey: "svc",
    fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });
  await assert.rejects(() => r.resolve({ authorization: "Bearer bad", "x-user-id": "victim-uuid" }),
    (e) => e.code === "invalid_token" && !JSON.stringify(e.toJSON()).includes("victim-uuid"));
});

test("an auth service answering without a subject is refused", async () => {
  // Prevents the return of: a 200 with an empty body being read as a login.
  const r = createPrincipalResolver({
    supabaseUrl: "https://example.supabase.co", supabaseKey: "svc",
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  });
  await assert.rejects(() => r.resolve({ authorization: "Bearer good" }), (e) => e.code === "invalid_token");
});

// ======================================================= verification: the code
//
// DEFECT: the previous build returned the verification code in the HTTP response
// body as `_devCode`. Any authenticated user could therefore verify their own
// address without ever receiving anything — and computeLevel treats
// email_verified as a TRUST signal that unlocks the publisher level and its
// publish credits. A verification you can grant yourself is not a verification.

/** A provider that captures what it was asked to send, standing in for a real one. */
function capturing(channel) {
  const sent = [];
  return { sent, provider: { channel, name: "test-" + channel, status: () => "AVAILABLE", async send(a) { sent.push(a); return { delivered: true }; } } };
}

test("no verification response ever carries the code that was sent", async () => {
  // Prevents the return of: _devCode, under any name.
  const cap = capturing("email");
  const svc = createVerificationService(tmpEnv("dcs-sec-ver-"), { email: cap.provider });
  const started = await svc.start("p1", "email", "alice@dcsai.ai");
  assert.equal(cap.sent.length, 1);
  const code = cap.sent[0].code;
  assert.match(code, /^\d{6}$/);
  assert.ok(!JSON.stringify(started).includes(code), "the issued code must not appear in the start response");
  assert.equal(started.code, undefined);
  assert.ok(!Object.keys(started).some((k) => /code/i.test(k)), `no field may be named for the code: ${Object.keys(started)}`);

  const confirmed = await svc.confirm("p1", "email", code);
  assert.equal(confirmed.verified, true);
  assert.ok(!JSON.stringify(confirmed).includes(code), "the code must not be echoed back on success either");
});

test("no verification response carries the code in dev mode either", async () => {
  // Prevents the return of: a "just for testing" branch that leaks the code.
  // Dev mode exists so an internal tester can complete the loop with no provider
  // contract; the code must reach the SERVER LOG and nowhere else.
  const logged = [];
  const warn = console.warn;
  console.warn = (line) => logged.push(line);
  try {
    const svc = createVerificationService(tmpEnv("dcs-sec-dev-", { DCS_VERIFICATION_DEV_MODE: "1" }));
    const started = await svc.start("p1", "email", "alice@dcsai.ai");
    const entry = logged.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.verification_dev_mode);
    assert.ok(entry && /^\d{6}$/.test(entry.code), "dev mode must write the code to the server log");
    assert.ok(!JSON.stringify(started).includes(entry.code), "dev mode must not put the code in the response");
    assert.equal(started.dev_mode, true, "a dev-mode challenge must declare itself, so it cannot pass as real");
    const confirmed = await svc.confirm("p1", "email", entry.code);
    assert.equal(confirmed.dev_mode, true, "a dev-mode verification stays permanently marked as one");
    const status = await svc.statusFor("p1");
    assert.equal(status.trustworthy, false, "a dev-mode verification is not evidence of address ownership");
  } finally {
    console.warn = warn;
  }
});

test("with no delivery provider a challenge is refused rather than answered with a code", async () => {
  // Prevents the return of: issuing a code nobody can receive and handing it back.
  const svc = createVerificationService(tmpEnv("dcs-sec-nop-"));
  await assert.rejects(() => svc.start("p1", "email", "alice@dcsai.ai"),
    (e) => e.code === "not_configured" && e.httpStatus === 503 && !/\d{6}/.test(JSON.stringify(e.toJSON())));
  assert.equal((await svc.statusFor("p1")).email_verified, false);
});

test("a wrong code is rejected without disclosing the right one", async () => {
  // Prevents the return of: a hint, a partial match, or the code in an error.
  const cap = capturing("email");
  const svc = createVerificationService(tmpEnv("dcs-sec-wrong-"), { email: cap.provider });
  await svc.start("p1", "email", "alice@dcsai.ai");
  const code = cap.sent[0].code;
  await assert.rejects(() => svc.confirm("p1", "email", "000000"), (e) => {
    const body = JSON.stringify(e.toJSON());
    return e.code === "validation_failed" && !body.includes(code);
  });
});

// ========================================================= marketplace: money
//
// DEFECT: Round-2 called the economy "doubly dark" — the router was constructed
// with no database client so its live branch was unreachable, and its tables did
// not exist. The rebuilt module must hold one invariant: no code path can
// produce a non-zero amount while payments are off.

test("the marketplace reports itself dark and every stored amount is zero", async () => {
  // Prevents the return of: an unverifiable claim that money is off.
  const m = createMarketplaceService(tmpEnv("dcs-sec-mkt-"));
  const l = await m.createListing("seller", { title: "Ashfall Harbour", kind: "world", worldId: "w1" });
  await m.acquire("buyer", l.id);
  const dark = await m.assertDark();
  assert.equal(dark.dark, true, `marketplace is not dark: ${dark.problems.join("; ")}`);
  assert.deepEqual(dark.problems, []);
  assert.equal(l.price_minor, 0);
  assert.equal(m.describe().payments_live, false);
});

test("a price cannot be set on a listing while payments are disabled", async () => {
  // Prevents the return of: a price accepted and silently zeroed, so a creator
  // believes they are selling something when they are giving it away.
  const m = createMarketplaceService(tmpEnv("dcs-sec-price-"));
  await assert.rejects(
    () => m.createListing("seller", { title: "Ashfall Harbour", priceMinor: 49900 }),
    (e) => e.httpStatus === 403 && /silently free/.test(e.detail)
  );
  assert.equal((await m.browse()).count, 0, "the refused listing must not have been created");
});

test("the dark invariant is checkable and fails loudly when payments are switched on", async () => {
  // Prevents the return of: assertDark() passing vacuously. If this test ever
  // passes with PAYMENTS_LIVE=1, the check has stopped checking anything.
  const m = createMarketplaceService(tmpEnv("dcs-sec-live-", { PAYMENTS_LIVE: "1" }));
  const dark = await m.assertDark();
  assert.equal(dark.dark, false);
  assert.ok(dark.problems.some((p) => /PAYMENTS_LIVE/.test(p)));
});

test("acquiring a listing settles nothing even through the full flow", async () => {
  // Prevents the return of: an ownership transfer that records a paid acquisition.
  const m = createMarketplaceService(tmpEnv("dcs-sec-acq-"));
  const l = await m.createListing("seller", { title: "Ashfall Harbour", kind: "world" });
  const r = await m.acquire("buyer", l.id);
  assert.equal(r.ownership.acquired_price_minor, 0);
  assert.equal(r.ledger.gross_minor, 0);
  assert.equal(r.ledger.status, "test");
  assert.equal((await m.ledgerFor("seller")).settled_count, 0);
});

// ============================================================== social: orgs
//
// DEFECT (Round-2 capability 87): orgs had seat-check logic over an in-memory
// store, no tables, and NO permission check on adding a member. Anyone could add
// themselves to any org and then read it, because an org was readable by anyone.

test("an org is not readable by someone who is not a member", async () => {
  // Prevents the return of: an org readable by anyone who knows its id.
  const s = createSocialService(tmpEnv("dcs-sec-org-"));
  const org = await s.createOrg("owner-1", { name: "Northgate Studios", seats: 5 });
  await assert.rejects(() => s.getOrg(org.id, "outsider"),
    (e) => e.code === "forbidden" && e.httpStatus === 403 && /only to its members/.test(e.detail));
  assert.equal((await s.getOrg(org.id, "owner-1")).id, org.id, "a member must still be able to read it");
  assert.deepEqual(await s.myOrgs("outsider"), []);
});

test("an outsider cannot add themselves to an org", async () => {
  // Prevents the return of: the exact capability-87 escalation — self-add, then read.
  const s = createSocialService(tmpEnv("dcs-sec-selfadd-"));
  const org = await s.createOrg("owner-1", { name: "Northgate Studios", seats: 5 });
  await assert.rejects(() => s.addOrgMember("outsider", org.id, "outsider", "admin"),
    (e) => e.httpStatus === 403);
  await assert.rejects(() => s.getOrg(org.id, "outsider"), (e) => e.httpStatus === 403);
});

test("a plain member cannot add members to an org", async () => {
  // Prevents the return of: an unprivileged member growing an org they only joined.
  const s = createSocialService(tmpEnv("dcs-sec-member-"));
  const org = await s.createOrg("owner-1", { name: "Northgate Studios", seats: 5 });
  await s.addOrgMember("owner-1", org.id, "member-1", "member");
  await assert.rejects(() => s.addOrgMember("member-1", org.id, "member-2", "member"),
    (e) => e.code === "forbidden" && /owner or admin/.test(e.detail));
  assert.equal((await s.getOrg(org.id, "owner-1")).seats_used, 2, "the refused member must not have been added");
});

test("only an owner or admin can grow an org, and never past its seats", async () => {
  // Prevents the return of: seat enforcement that exists in comments only.
  const s = createSocialService(tmpEnv("dcs-sec-seats-"));
  const org = await s.createOrg("owner-1", { name: "Northgate Studios", seats: 2 });
  await s.addOrgMember("owner-1", org.id, "member-1", "member");
  await assert.rejects(() => s.addOrgMember("owner-1", org.id, "member-2", "member"),
    (e) => e.code === "conflict" && /no seats left/.test(e.detail));
  assert.equal((await s.getOrg(org.id, "owner-1")).payments_live, false, "seats are capacity, never a charge");
});

test("an org's billing owner cannot be removed by a member", async () => {
  // Prevents the return of: an org takeover by eviction.
  const s = createSocialService(tmpEnv("dcs-sec-owner-"));
  const org = await s.createOrg("owner-1", { name: "Northgate Studios", seats: 5 });
  await s.addOrgMember("owner-1", org.id, "member-1", "member");
  await assert.rejects(() => s.removeOrgMember("member-1", org.id, "owner-1"), (e) => e.httpStatus === 403);
  await assert.rejects(() => s.removeOrgMember("owner-1", org.id, "owner-1"),
    (e) => e.httpStatus === 403 && /billing owner cannot be removed/.test(e.detail));
});

// ================================================== subscriptions: the grant
//
// DEFECT: capability 77 kept subscriptions in an in-memory Map seeded with one
// hard-coded `{ plan: "dcs_plus", status: "active" }` row for the founder,
// behind a table no migration created. The rebuilt module must hold two things:
// a customer cannot be handed a plan, and a comped internal grant cannot become
// permanent.

test("subscribing refuses rather than quietly granting a free plan", async () => {
  // Prevents the return of: a caller believing they subscribed, and a row that
  // the first genuine billing run cannot tell from a paid one.
  const s = createSubscriptionsService(tmpEnv("dcs-sec-sub-"));
  await assert.rejects(() => s.subscribe("customer-1", "dcs_plus"),
    (e) => e.httpStatus === 503 && e.code === "not_configured");
  const st = await s.statusFor("customer-1");
  assert.equal(st.plan, "free");
  assert.equal(st.active_grant, false);
  assert.equal(st.paid, false);
  assert.equal((await s.listGrants()).count, 0, "a refused subscribe must not create a subscription");
  assert.equal((await s.assertDark()).dark, true);
});

test("a comped grant cannot be created without an expiry inside the internal window", async () => {
  // Prevents the return of: a permanent "internal test" plan. An explicit null
  // used to pass straight through to the row, so the default protected the
  // careless caller and not the deliberate one — the grant then never expired
  // and assertDark, which only compared a present expiry against the window,
  // reported it as fine.
  const s = createSubscriptionsService(tmpEnv("dcs-sec-grant-"));
  const granter = { id: "tester-1", isInternalTester: true };
  const subject = { id: "tester-2", isInternalTester: true };
  for (const never of [null, ""]) {
    await assert.rejects(() => s.grantTestPlan(granter, subject, "dcs_plus", { expiresAt: never }),
      (e) => e.httpStatus === 422 && /must expire/.test(e.detail), `expiresAt=${JSON.stringify(never)} must be refused`);
  }
  await assert.rejects(() => s.grantTestPlan(granter, subject, "dcs_plus", { expiresAt: "2027-01-01" }),
    (e) => e.httpStatus === 422 && /outlive/.test(e.detail));
  assert.equal((await s.listGrants()).count, 0, "no refused grant may leave a row behind");

  const row = await s.grantTestPlan(granter, subject);
  assert.ok(row.expires_at, "the default grant must carry an expiry");
  assert.ok(new Date(row.expires_at).getTime() <= new Date(INTERNAL_WINDOW_ENDS + "T23:59:59Z").getTime());
  assert.equal(row.price_minor, 0);
  assert.equal(row.paid, false);
  assert.ok(!PAID_STATUSES.includes(row.status), `'${row.status}' is a paid status`);
  assert.equal((await s.assertDark()).dark, true);
});

test("the subscription dark invariant fails loudly when payments are switched on", async () => {
  // Prevents the return of: assertDark() passing vacuously.
  const s = createSubscriptionsService(tmpEnv("dcs-sec-sublive-", { PAYMENTS_LIVE: "1" }));
  const dark = await s.assertDark();
  assert.equal(dark.dark, false);
  assert.ok(dark.problems.some((p) => /PAYMENTS_LIVE/.test(p)));
});

// ================================================== persistence: other people's worlds
//
// DEFECT: the Round-2 store kept manifests in a process-local Map with no
// ownership at all, so any caller who knew a world id had the world. The durable
// store owns the ownership rules now; these hold them.

const repoIn = (prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return new WorldRepository(new FileWorldStore(path.join(dir, "worlds")), new VersionHistoryStore(path.join(dir, "world-versions")));
};

test("a draft world is readable only by its creator", async () => {
  // Prevents the return of: an unreleased world readable by anyone with its id.
  const repo = repoIn("dcs-sec-world-");
  await repo.upsert({ worldId: "w1", ownerId: "victim", manifest: { meta: { title: "unreleased" } }, state: "draft" });
  await assert.rejects(() => repo.get("w1", { requesterId: "attacker" }), (e) => e.httpStatus === 403);
  await assert.rejects(() => repo.get("w1", { requesterId: null }), (e) => e.httpStatus === 403);
  await assert.rejects(() => repo.get("w1", { requesterId: "attacker", requireOwner: true }), (e) => e.httpStatus === 403);
  assert.equal((await repo.get("w1", { requesterId: "victim" })).state, "draft");
  // Publishing changes who may read it, and nothing else about who owns it.
  await repo.upsert({ worldId: "w1", ownerId: "victim", manifest: { meta: { title: "released" } }, state: "published" });
  assert.equal((await repo.get("w1", { requesterId: "attacker" })).owner_id, "victim");
  await assert.rejects(() => repo.get("w1", { requesterId: "attacker", requireOwner: true }), (e) => e.httpStatus === 403);
});

test("another creator cannot overwrite a world they do not own", async () => {
  // Prevents the return of: an id-keyed upsert with no ownership rule.
  const repo = repoIn("dcs-sec-upsert-");
  await repo.upsert({ worldId: "w1", ownerId: "victim", manifest: { meta: { title: "mine" } }, state: "draft" });
  await assert.rejects(
    () => repo.upsert({ worldId: "w1", ownerId: "attacker", manifest: { meta: { title: "HIJACKED" } }, state: "published" }),
    (e) => e.httpStatus === 403
  );
  const after = await repo.get("w1", { requesterId: "victim" });
  assert.equal(after.title, "mine");
  assert.equal(after.state, "draft", "a refused write must not have changed the world's state either");
});

test("a retained world version cannot be rewritten", async () => {
  // Prevents the return of: a rollback target that can be edited after the fact,
  // which would make the whole retained history unfalsifiable.
  const repo = repoIn("dcs-sec-versions-");
  await repo.upsert({ worldId: "w1", ownerId: "victim", manifest: { meta: { title: "v1" } }, state: "draft" });
  await repo.upsert({ worldId: "w1", ownerId: "victim", manifest: { meta: { title: "v2" } }, state: "draft" });
  const v1 = await repo.getVersion("w1", 1, { requesterId: "victim" });
  assert.equal(v1.manifest.meta.title, "v1");
  // Re-saving the same version number must not replace what was recorded.
  const again = await repo.versions.put("w1", 1, { world_id: "w1", version: 1, manifest: { meta: { title: "REWRITTEN" } }, manifest_hash: "x" });
  assert.equal(again.already_recorded, true);
  assert.equal((await repo.getVersion("w1", 1, { requesterId: "victim" })).manifest.meta.title, "v1");
  assert.deepEqual((await repo.listVersions("w1", { requesterId: "victim" })).map((v) => v.version), [1, 2]);
});

// =============================================================================
// SECOND PASS — Lane L, 6 Sep 2026.
//
// Everything above is a regression for a defect already fixed. Everything below
// is an attack on the fixes that landed THIS sprint — the delta actor binding,
// the version-visibility gate, the "one source of truth for friends, parties,
// teams and studios", and the entrypoint boot guards — on the assumption that
// each is incomplete.
//
// src/cw5/cw5_persistence.ts uses TypeScript parameter properties, which Node's
// strip-only type support refuses, so this file cannot import it. The delta
// scenarios are therefore run ONCE in a tsx child process and asserted here.
// The child is the reproduction: it is a plain script, and its source is below.
// =============================================================================

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));

function runInTsx(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cw5-probe-"));
  const file = path.join(dir, "probe.mts");
  fs.writeFileSync(file, source);
  const out = execFileSync(process.execPath, ["--import", "tsx", file], {
    encoding: "utf8", cwd: REPO, stdio: ["ignore", "pipe", "pipe"],
  });
  const last = out.trim().split("\n").filter(Boolean).pop();
  return JSON.parse(last);
}

/**
 * One delta scenario, applied to a world that already contains an object owned
 * by "victim". `actorId` is always "attacker": an authenticated principal who
 * is NOT the victim. (POST /worlds/:id/save additionally requires world
 * ownership, so in the live route the attacker is the world's creator — which
 * is precisely the party the rollback live-state guard exists to constrain.)
 */
const DELTA_PROBE = `
import { PersistenceEngine, InMemoryPersistenceStore } from ${JSON.stringify(REPO + "src/cw5/cw5_persistence.ts")};
import { cw5RuntimeStateSource } from ${JSON.stringify(REPO + "src/core/livestate.mjs")};

async function scenario(ops: any, actorId: any = "attacker") {
  const store = new InMemoryPersistenceStore();
  const engine = new PersistenceEngine(store);
  await engine.registerBaseWorld({
    world_id: "w1", schema_version: "1.0",
    objects: [{ object_id: "victim_house", kind: "house", transform: { x: 0, y: 0, z: 0 }, owner_id: "victim" }],
  } as any);
  const out: any = { saved: null, save_error: null, load_error: null, owned: null, objects: null, inventories: null };
  try {
    await engine.save({ world_id: "w1", seq: 1, ops } as any, { actorId });
    out.saved = true;
  } catch (e: any) { out.saved = false; out.save_error = String(e && e.message || e); }
  try {
    const snap: any = await engine.load("w1");
    out.objects = snap.objects;
    out.inventories = snap.inventories;
    const src = cw5RuntimeStateSource({ persistence: engine });
    out.owned = (await src.read("w1")).owned_entity_ids;
  } catch (e: any) { out.load_error = String(e && e.message || e); }
  return out;
}

const results: any = {};
results.strip_owner   = await scenario([{ op: "place_object", object_id: "victim_house", kind: "house", owner_id: null }]);
results.remove_owned  = await scenario([{ op: "remove_object", object_id: "victim_house" }]);
results.move_owned    = await scenario([{ op: "move_object", object_id: "victim_house", transform: { x: 99 } }]);
results.name_other    = await scenario([{ op: "place_object", object_id: "x", owner_id: "victim" }]);
results.inv_other     = await scenario([{ op: "set_inventory", player_id: "victim", inventory: [] }]);
results.no_actor      = await scenario([], null);
results.unknown_op    = await scenario([{ op: "totally_bogus", player_id: "victim" }]);
results.cased_op      = await scenario([{ op: "Set_Inventory", player_id: "victim", inventory: [] }]);
results.ops_string    = await scenario("set_inventory" as any);
results.ctor_op       = await scenario([{ op: "constructor" }]);
results.null_op       = await scenario([null]);
results.coerced_owner = await scenario([{ op: "set_inventory", player_id: ["attacker"], inventory: [{ item_id: "i1", qty: 1 }] }]);
results.nested_ops    = await scenario([{ op: "place_object", object_id: "n", ops: [{ op: "set_inventory", player_id: "victim", inventory: [] }] }]);
results.proto_var     = await scenario([{ op: "var_set", key: "__proto__", value: { polluted: 1 } }]);
results.economy_op    = await scenario([{ op: "economy", balances: { victim: 0, attacker: 999999 } }]);
results.npc_op        = await scenario([{ op: "npc_state", npc_id: "victim", state: { owned_by: "attacker" } }]);
results.prototype_polluted = ({} as any).polluted ?? null;
console.log(JSON.stringify(results));
`;

const delta = runInTsx(DELTA_PROBE);

// ================================================ the delta actor binding

test("DEFECT, OPEN: a delta can strip another player's ownership by re-placing their object", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: HIGH.
  //
  // assertActorBound (src/cw5/cw5_persistence.ts:249-259) refuses an op that
  // NAMES another player:
  //     if (v != null && String(v) !== String(actorId)) throw ...
  // The `v != null` clause is documented as "an op may leave an actor-bound
  // field null (an unowned object)". But applyOp's place_object
  // (src/cw5/cw5_persistence.ts:145-157) REPLACES the object wholesale:
  //     state.objects.set(op.object_id, { ..., owner_id: op.owner_id ?? null })
  // so re-placing an EXISTING object with owner_id null does not create an
  // unowned object — it takes an owned one away from its owner. The check looks
  // only at the op, never at the object the op lands on.
  //
  // REPRODUCTION (run in the child above): a world holds victim_house owned by
  // "victim". Actor "attacker" saves
  //     { op: "place_object", object_id: "victim_house", kind: "house", owner_id: null }
  // -> ACCEPTED, and livestate's owned_entity_ids for the world drops from
  // ["victim_house"] to [].
  //
  // WHY IT MATTERS: src/core/livestate.mjs:162 counts a hold only when
  // `o.owner_id` is truthy, and planRollback refuses a rollback that would
  // delete a held entity. The docstring on ACTOR_BOUND_FIELDS names this exact
  // outcome — "a stripped owner_id licenses a deletion" — and the check it
  // guards permits it.
  //
  // FIX BELONGS IN src/cw5/cw5_persistence.ts:249-259 — an actor-bound field
  // must be compared against the CURRENT owner of the object the op addresses,
  // not only against the value in the op: an op may not clear or overwrite an
  // owner that is neither null nor the actor.
  assert.equal(delta.strip_owner.load_error, null, "self-check: the world still loads");
  assert.equal(
    delta.strip_owner.saved, false,
    "a delta that takes victim_house away from 'victim' must be refused, whatever value it writes",
  );
  assert.deepEqual(
    delta.strip_owner.owned, ["victim_house"],
    "after the delta, the server no longer believes anybody holds victim_house",
  );
});

test("DEFECT, OPEN: remove_object is not actor-bound and deletes another player's property outright", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: HIGH.
  //
  // ACTOR_BOUND_FIELDS (src/cw5/cw5_persistence.ts:236-240) lists
  // set_inventory, place_object and move_object. remove_object is absent
  // because the OP carries no person field — but the person is on the STORED
  // OBJECT, and the check never looks at stored state. applyOp
  // (src/cw5/cw5_persistence.ts:169-173) then does an unconditional
  // state.objects.delete(op.object_id).
  //
  // REPRODUCTION: actor "attacker" saves
  //     { op: "remove_object", object_id: "victim_house" }
  // -> ACCEPTED; the object is gone from the snapshot and from
  // owned_entity_ids. The delta path deletes a player's property directly,
  // which is the outcome the whole live-state guard on rollback exists to
  // prevent — reached by a route that does not consult it.
  //
  // FIX BELONGS IN src/cw5/cw5_persistence.ts:236-240 and :249-259 — binding
  // has to be expressed over the object's current owner, so remove_object and
  // move_object are covered by the same rule as place_object.
  assert.equal(
    delta.remove_owned.saved, false,
    "a delta may not delete an object owned by somebody other than the actor",
  );
  assert.deepEqual(delta.remove_owned.owned, ["victim_house"]);
});

test("DEFECT, OPEN: a delta can move another player's object, because move_object binds only its own field", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: MEDIUM.
  // move_object IS in ACTOR_BOUND_FIELDS, for owner_id — but an op that simply
  // omits owner_id passes the check and still mutates the transform of an
  // object owned by someone else. The binding is on the field the op happens to
  // carry, not on the object it acts upon.
  // FIX: src/cw5/cw5_persistence.ts:249-259, as above.
  assert.equal(
    delta.move_owned.saved, false,
    "a delta may not relocate an object owned by somebody other than the actor",
  );
});

test("DEFECT, OPEN: an op kind the engine cannot apply is accepted and permanently breaks the world", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: MEDIUM (availability,
  // unrecoverable).
  //
  // save() validates world_id, seq and the actor binding
  // (src/cw5/cw5_persistence.ts:262-275) and never validates op.op.
  // ACTOR_BOUND_FIELDS has no entry for an unknown kind, so the loop skips it
  // and the delta is APPENDED. applyOp's default branch
  // (src/cw5/cw5_persistence.ts:207-210) then throws
  //     Unknown op type: totally_bogus
  // on every subsequent load(), writeSnapshot() and replayOnBase(). The store
  // is append-only by design, so there is no way to take the delta back: the
  // world's runtime state is unreadable for good.
  //
  // A case-varied spelling of a REAL op does the same thing ("Set_Inventory"),
  // which is the more likely accident.
  //
  // Downstream: src/core/livestate.mjs treats a throwing source as UNDETERMINED
  // — correctly — so from then on every rollback of that world is refused for
  // want of evidence. One malformed save disables rollback for the world.
  //
  // Reachable only by the world's owner (server.mts:1516 requires ownership),
  // so it is self-inflicted — but it is silent, permanent, and acknowledged
  // with ok:true.
  //
  // FIX BELONGS IN src/cw5/cw5_persistence.ts:262-275 — reject an op whose kind
  // applyOp does not implement, at SAVE time, before it is durable.
  assert.equal(
    delta.unknown_op.saved, false,
    `save accepted an op the engine cannot apply; every later load now fails with: ${delta.unknown_op.load_error}`,
  );
  assert.equal(delta.cased_op.saved, false, "a case-varied spelling of a real op is not a real op");
  assert.equal(delta.ops_string.saved, false, "a delta whose ops is a string is not a list of ops");
});

test("DEFECT, OPEN: an op kind inherited from Object.prototype crashes the binding check", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: LOW (robustness).
  // ACTOR_BOUND_FIELDS is an object LITERAL, so the lookup
  //     ACTOR_BOUND_FIELDS[op.op] || []
  // (src/cw5/cw5_persistence.ts:252) resolves through the prototype chain:
  // op.op === "constructor" yields the Object constructor, which is truthy, so
  // the `|| []` never fires and `for (const f of fields)` throws
  // "fields is not iterable". An ops array containing null throws
  // "Cannot read properties of null". Both surface as a 500 through
  // server.mts's catch-all rather than as a refusal, so a malformed body is
  // reported as an internal fault of ours.
  // FIX BELONGS IN src/cw5/cw5_persistence.ts:236-240 — build the table with
  // Object.create(null) (or guard with Object.hasOwn), and reject an op that is
  // not a plain object before reading from it.
  assert.match(
    String(delta.ctor_op.save_error), /^save:/,
    `an op kind of "constructor" must be refused by the binding, not crash it (got: ${delta.ctor_op.save_error})`,
  );
  assert.match(
    String(delta.null_op.save_error), /^save:/,
    `an ops array containing null must be refused, not crash (got: ${delta.null_op.save_error})`,
  );
});

// ------------------------------------------ the actor binding, where it HOLDS

test("a delta naming another player directly is refused, in every bound field", async () => {
  // The core of the fix, and it works. Both ops that carry a person field
  // refuse to write somebody else's name.
  assert.equal(delta.name_other.saved, false);
  assert.match(delta.name_other.save_error, /may not act on another player's behalf/);
  assert.equal(delta.inv_other.saved, false);
  assert.match(delta.inv_other.save_error, /sets player_id='victim'/);
});

test("a delta from nobody in particular is refused", async () => {
  assert.equal(delta.no_actor.saved, false);
  assert.match(delta.no_actor.save_error, /an actor is required/);
});

test("an actor-bound field that only String()s equal cannot address a different player", async () => {
  // The binding compares with String(), so player_id ["attacker"] passes for
  // actor "attacker". That is safe because the property write coerces
  // identically — the inventory lands under "attacker" and nowhere else — so
  // the loose comparison cannot be turned into a write against another player.
  assert.equal(delta.coerced_owner.saved, true, "String()-equal is the actor, so this is their own write");
  assert.deepEqual(Object.keys(delta.coerced_owner.inventories), ["attacker"]);
});

test("an op nested inside another op is inert, not a second op", async () => {
  // A nested `ops` array is read by neither assertActorBound nor applyOp, so it
  // cannot smuggle a set_inventory for another player past the binding.
  assert.equal(delta.nested_ops.saved, true);
  assert.deepEqual(delta.nested_ops.inventories, {});
});

test("a var_set of __proto__ does not pollute Object.prototype", async () => {
  assert.equal(delta.proto_var.saved, true, "it is the actor's own variable");
  assert.equal(delta.prototype_polluted, null, "and it must not reach Object.prototype");
});

test("OBSERVED, not a defect today: economy and npc_state ops are unbound and can name a person", async () => {
  // Neither op is in ACTOR_BOUND_FIELDS, and both accept arbitrary person-shaped
  // keys: `{ op: "economy", balances: { attacker: 999999 } }` and
  // `{ op: "npc_state", npc_id: "victim", ... }` are both stored.
  //
  // NOT a defect today: nothing reads the economy map (payments are dark and
  // src/core/livestate.mjs deliberately does not treat npc_states as evidence a
  // player holds anything, and says so at :62-68). Recorded because the delta
  // store is the record any future economy is built on, so the day something
  // reads it, these two ops are already forgeable. Pinned so that day is loud.
  assert.equal(delta.economy_op.saved, true);
  assert.deepEqual(delta.economy_op.owned, ["victim_house"], "and it changes no hold");
  assert.equal(delta.npc_op.saved, true);
  assert.deepEqual(delta.npc_op.owned, ["victim_house"]);
});

// ==================================== authorisation across the whole surface

const SERVER_SRC = fs.readFileSync(path.join(REPO, "server.mts"), "utf8");
const TS_SLICE_SRC = fs.readFileSync(path.join(REPO, "src/cw1/ts-sso-kyc-slice.mjs"), "utf8");

const socialIn = (prefix) => createSocialService(tmpEnv(prefix));

test("DEFECT, OPEN: a party is readable by anyone who has its id, including anonymously", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: MEDIUM — another
  // principal's data in the response of an unauthenticated route.
  //
  // server.mts:717:
  //     if (mm && method === "GET") return send(res, 200, { ok: true, party: await social.getParty(mm[1]) });
  // No mustBe, no whoOrNull, no membership test — and src/core/social.mjs:479
  // getParty(partyId) takes no requester either, so there is nowhere the check
  // could have been made. An anonymous caller with a party id receives the full
  // member list, the leader's principal id, the world the party is in, and the
  // party's open/closed state — INCLUDING for a party created with open:false,
  // which is the estate's own marker for "invite only".
  //
  // The same sprint closed exactly this on orgs: getOrg(orgId, requesterId)
  // refuses with "this org is visible only to its members" (src/core/social.mjs).
  // The commit message says "two open reads closed"; parties and teams are the
  // two that were not.
  //
  // FIX BELONGS IN src/core/social.mjs:479 (getParty must take a requester and
  // refuse a non-member, as getOrg does) and server.mts:717 (which must then
  // pass one, behind mustBe).
  const social = socialIn("party-read-");
  const party = await social.createParty("leader", { worldId: "w-secret", maxSize: 4, open: false });
  await assert.rejects(
    () => social.getParty(party.id),
    "an invite-only party must not be readable with no requester at all",
  );
});

test("DEFECT, OPEN: a team's full membership is readable by anyone who has its id", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: MEDIUM.
  // server.mts:741 and src/core/social.mjs:545 — the same shape as the party
  // read above. getTeam returns the team name, the owner's principal id and
  // every member row (member_id + role) to a caller who presented no
  // credential. Compare addTeamMember/removeTeamMember immediately below it,
  // which DO check the caller's role — so the write side is authorised and the
  // read side is open.
  // FIX BELONGS IN src/core/social.mjs:545 and server.mts:741.
  const social = socialIn("team-read-");
  const team = await social.createTeam("owner", "Secret Team");
  await assert.rejects(
    () => social.getTeam(team.id),
    "a team's membership must not be readable with no requester at all",
  );
});

test("DEFECT, OPEN: listVersions hides published versions from everyone but the owner", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: MEDIUM — the
  // version-visibility gate added this sprint is half-applied, and the list and
  // the item disagree about the same version.
  //
  // _versionVisible (src/core/worldstore.mjs:~336) gates on v.state:
  //     return v.state === "published";
  // VersionHistoryStore.put writes `state` into the retained record — but
  // VersionHistoryStore.list (src/core/worldstore.mjs:~232) projects only
  //     { version, manifest_hash, label, created_by, created_at }
  // and DROPS state. So for every non-owner, v.state is undefined and
  // listVersions returns [] — even for a world whose every version was saved
  // published. getVersion() reads the full record via versions.get(), which
  // keeps state, and serves the very same version to the very same caller.
  //
  // REPRODUCTION (below): a world published from v1, two published versions.
  //   listVersions(requesterId: "stranger") -> []
  //   getVersion(1, requesterId: "stranger") -> the manifest
  //
  // Fails CLOSED on the list, so nothing leaks — but GET /v3/worlds/:id/versions
  // (server.mts:1309) is the route rollback and diff are discovered through, and
  // it reports that a published world has no history.
  //
  // FIX BELONGS IN src/core/worldstore.mjs:~232 — project `state` in
  // VersionHistoryStore.list, so the gate has the field it reads.
  const repo = repoIn("versions-visible-");
  await repo.upsert({ worldId: "pw", ownerId: "owner", manifest: { meta: { title: "one" } }, state: "published" });
  await repo.upsert({ worldId: "pw", ownerId: "owner", manifest: { meta: { title: "two" } }, state: "published" });

  const asOwner = await repo.listVersions("pw", { requesterId: "owner" });
  assert.equal(asOwner.length, 2, "self-check: two versions were retained");
  const item = await repo.getVersion("pw", 1, { requesterId: "stranger" });
  assert.equal(item.version, 1, "self-check: getVersion serves this version to a stranger");

  const asStranger = await repo.listVersions("pw", { requesterId: "stranger" });
  assert.equal(
    asStranger.length, 2,
    "listVersions and getVersion must agree: a version the item route serves must appear in the list route",
  );
});

test("DEFECT, OPEN: 403-vs-404 tells an unauthenticated caller which world ids exist", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: LOW.
  // src/core/worldstore.mjs get():
  //     if (!r) throw Errors.notFound(`world ${worldId}`);                    -> 404
  //     ... throw Errors.forbidden("this world is a draft ...")               -> 403
  // The two answers differ, so an anonymous caller learns whether a world id
  // exists by the status code alone — an enumeration oracle on
  // GET /v3/worlds/:id/manifest, /versions, /diff, /memory, /parts,
  // /attribution and /worlds/:id/load, all of which pass
  // `requesterId: principal?.id ?? null`. src/core/social.mjs getOrg has the
  // same 404/403 split.
  //
  // Mitigating, and the reason this is LOW rather than MEDIUM: world ids are
  // "w3_" + 16 hex characters and org ids are randomly generated, so the oracle
  // confirms a candidate id rather than enumerating a space. It is still a
  // disclosure the route did not intend, and the fix is free.
  //
  // FIX BELONGS IN src/core/worldstore.mjs get() — answer notFound for a world
  // the caller may not read, so "not yours" and "not there" are indistinguishable.
  const repo = repoIn("world-oracle-");
  await repo.upsert({ worldId: "exists-but-private", ownerId: "owner", manifest: { meta: {} }, state: "draft" });
  const statusOf = async (id) => {
    try { await repo.get(id, { requesterId: null }); return 200; }
    catch (e) { return e.httpStatus; }
  };
  const present = await statusOf("exists-but-private");
  const absent = await statusOf("no-such-world-at-all");
  assert.equal(
    present, absent,
    `a stranger gets ${present} for a world that exists and ${absent} for one that does not, which is an existence oracle`,
  );
});

test("DEFECT, CLOSED: the payout-KYC routes are inside the internal-tester prefix gate", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: LOW.
  // server.mts:378 gates the trust-and-safety console and payout KYC:
  //     if ((url.startsWith("/ts/") || url.startsWith("/kyc/"))) await mustBeInternalTester(...)
  //     // "T&S console + payout KYC: internal testers only"
  // The slice it guards serves payout KYC at "/payout/kyc" and
  // "/payout/kyc/start" (src/cw1/ts-sso-kyc-slice.mjs:76,80) — neither begins
  // with "/kyc/", so neither is gated. There is no path "/kyc/..." in the slice
  // at all, so the second prefix matches nothing that exists.
  //
  // Impact is limited: both routes refuse an anonymous caller and act only on
  // the caller's own row, and KYC is dark. But the gate does not do what its
  // own comment says, and the day the KYC shell is wired to a provider it will
  // be reachable by every authenticated account rather than by testers.
  //
  // FIX BELONGS IN server.mts:378 — gate the paths the slice actually serves
  // ("/payout/"), or move the check into the slice beside the routes.
  const slicePaths = [...TS_SLICE_SRC.matchAll(/path === "(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(slicePaths.includes("/payout/kyc"), "self-check: the slice still serves this path");
  // Match the gate however it is spelled — the previous form pinned one exact
  // line, so fixing the gate broke the check that verified it. What must stay
  // true is that SOME prefix test guards mustBeInternalTester and that it covers
  // the paths the slice serves.
  const gate = SERVER_SRC.match(/if \([^\n]*url\.startsWith\([^\n]*\)[^\n]*\)\s*\{?[\s\S]{0,200}?mustBeInternalTester/);
  assert.ok(gate, "self-check: an internal-tester prefix gate still exists");
  const prefixes = [...gate[0].matchAll(/startsWith\("([^"]+)"\)/g)].map((m) => m[1]);
  for (const p of ["/payout/kyc", "/payout/kyc/start"]) {
    assert.ok(
      prefixes.some((pre) => p.startsWith(pre)),
      `${p} is served by the T&S/KYC slice but is not covered by the gate's prefixes ${JSON.stringify(prefixes)}`,
    );
  }
});

test("DEFECT, OPEN: the CW1 mock server's boot guard fails OPEN when NODE_ENV is unset", async () => {
  // DEFECT, OPEN (found by Lane L, 6 Sep 2026). SEVERITY: MEDIUM.
  //
  // src/cw1/mock-server.mjs:259-263:
  //     if (NODE_ENV === "production" || (NODE_ENV && NODE_ENV !== "development" && DCS_ALLOW_MOCK_SERVER !== "1"))
  // With NODE_ENV UNSET — the default for a bare `node src/cw1/mock-server.mjs`,
  // and for most base container images — the first disjunct is false and the
  // second short-circuits on the falsy NODE_ENV. The guard does not fire and the
  // fixture STARTS: it seeds users, returns verification codes in responses, and
  // its who() (src/cw1/mock-server.mjs:54) treats the bearer token as a raw user
  // id, so any caller can be any user.
  //
  // The sibling entrypoint gets it right — src/cw1/service.mjs:132 is
  //     if (NODE_ENV !== "development" && DCS_ALLOW_CW1_SERVICE !== "1")
  // which fails CLOSED on an unset NODE_ENV. The two guards were written for the
  // same reason and only one of them holds.
  //
  // REPRODUCTION (below): spawn the mock with NODE_ENV and DCS_ALLOW_MOCK_SERVER
  // both unset and PORT=0 (an ephemeral port, so this cannot collide with
  // anything). It must exit 78; it listens instead.
  //
  // FIX BELONGS IN src/cw1/mock-server.mjs:259-263 — require an explicit
  // opt-in, exactly as service.mjs does.
  const env = { ...process.env, PORT: "0" };
  delete env.NODE_ENV;
  delete env.DCS_ALLOW_MOCK_SERVER;
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [path.join(REPO, "src/cw1/mock-server.mjs")], { env, cwd: REPO, stdio: ["ignore", "pipe", "pipe"] });
  const outcome = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); resolve({ exited: false, code: null }); }, 2500);
    child.on("exit", (code) => { clearTimeout(timer); resolve({ exited: true, code }); });
  });
  assert.equal(
    outcome.code, 78,
    `the mock fixture must refuse to start without an explicit opt-in (exited=${outcome.exited}, code=${outcome.code})`,
  );
});

// ============================================================ HOLDS — regressions

test("publishing a world does not retroactively expose the drafts it passed through", async () => {
  // The version-visibility fix, from the side that DOES work: getVersion gates
  // on the state the version was saved in, so a draft-era version stays private
  // after the world is published. (listVersions is broken for an unrelated
  // reason — see the DEFECT above — so it is not asserted here.)
  const repo = repoIn("version-state-");
  await repo.upsert({ worldId: "w", ownerId: "owner", manifest: { meta: { title: "private draft" } }, state: "draft" });
  await repo.upsert({ worldId: "w", ownerId: "owner", manifest: { meta: { title: "public" } }, state: "published" });

  await assert.rejects(
    () => repo.getVersion("w", 1, { requesterId: "stranger" }),
    (e) => e.httpStatus === 403,
    "version 1 was written while the world was private and must stay private",
  );
  const v2 = await repo.getVersion("w", 2, { requesterId: "stranger" });
  assert.equal(v2.manifest.meta.title, "public");
  const own = await repo.getVersion("w", 1, { requesterId: "owner" });
  assert.equal(own.manifest.meta.title, "private draft", "the owner keeps their own history");
});

test("a version with no recorded state is treated as private, not as published", async () => {
  // A version retained before the state field existed has no provable state.
  // The gate must read that as "private", never as "publishable by default".
  const repo = repoIn("version-legacy-");
  await repo.upsert({ worldId: "w", ownerId: "owner", manifest: { meta: {} }, state: "published" });
  const raw = await repo.versions.get("w", 1);
  delete raw.state;
  fs.writeFileSync(repo.versions._p("w", 1), JSON.stringify(raw));
  await assert.rejects(
    () => repo.getVersion("w", 1, { requesterId: "stranger" }),
    (e) => e.httpStatus === 403,
    "a version whose state is unknown must not be served to a stranger",
  );
});

test("an org read is refused to a non-member, and the refusal names no member", async () => {
  // The read that WAS closed this sprint. Pinned, and pinned against leaking
  // the membership through the error message it refuses with.
  const social = socialIn("org-read-");
  const org = await social.createOrg("billing-owner", { name: "Acme", seats: 3 });
  await assert.rejects(
    () => social.getOrg(org.id, "stranger"),
    (e) => e.httpStatus === 403 && !JSON.stringify(e.toJSON ? e.toJSON() : e).includes("billing-owner"),
    "a non-member is refused, and is told nothing about who IS a member",
  );
});

test("a world's error messages disclose no manifest, owner or title to a stranger", async () => {
  // The 403/404 split is recorded as a defect above. Independently of that, the
  // BODY of a refusal must carry nothing about the world it refuses.
  const repo = repoIn("world-leak-");
  await repo.upsert({ worldId: "w-secret", ownerId: "owner-uuid", manifest: { meta: { title: "Unreleased" } }, state: "draft" });
  try {
    await repo.get("w-secret", { requesterId: "stranger" });
    assert.fail("a stranger must not read a draft");
  } catch (e) {
    const body = JSON.stringify(e.toJSON ? e.toJSON() : { message: e.message });
    assert.equal(body.includes("owner-uuid"), false, "the refusal must not name the owner");
    assert.equal(body.includes("Unreleased"), false, "the refusal must not name the title");
  }
});

test("the ephemeral-auth boot guard is a refusal to serve, not a warning", async () => {
  // The guard added this sprint. Asserted on the source because it is a
  // process-level exit in server.mts's module body: a test cannot import
  // server.mts to observe it without starting a server.
  const guard = SERVER_SRC.match(/if \(auth\.mode === "local-hs256-ephemeral"[\s\S]{0,900}?\n\}/);
  assert.ok(guard, "the ephemeral-auth guard must still exist in server.mts");
  assert.match(guard[0], /DCS_ALLOW_EPHEMERAL_AUTH !== "1"/, "the opt-out must be explicit");
  assert.match(guard[0], /process\.exit\(78\)/, "and it must exit, not warn");
});

test("the CW1 identity service refuses to start without an explicit opt-in", async () => {
  // The sibling of the mock-server guard, which is written correctly. This is
  // the control for the DEFECT above: if this one ever regresses to the
  // mock's shape, the difference the defect rests on has been lost.
  const src = fs.readFileSync(path.join(REPO, "src/cw1/service.mjs"), "utf8");
  const guard = src.match(/if \(process\.env\.NODE_ENV !== "development"[\s\S]{0,700}?process\.exit\(78\);/);
  assert.ok(guard, "src/cw1/service.mjs must refuse to start unless NODE_ENV=development or the opt-in is set");
  assert.match(guard[0], /DCS_ALLOW_CW1_SERVICE !== "1"/);
});

test("a verification code is never returned by default, and only one caller opts in", async () => {
  // The opt-in added this sprint, checked from both ends.
  //
  // src/cw1/verification.mjs issue() returns the code ONLY when a caller passes
  // { returnCodeForMockOnly: true }. Exactly one call site does — the runnable
  // development mock — and src/cw1/service.mjs calls issue() without it. The
  // legacy identity-slice routes that used to leak it now answer 410, and
  // src/core/verification.mjs (what server.mts actually uses) has no code field
  // in any mode.
  //
  // NOTE, and it is the point of the mock-server boot-guard defect above: this
  // default is safe only because the one caller that opts in is not supposed to
  // be runnable. That guard fails open with NODE_ENV unset.
  const { createVerificationStore } = await import("../src/cw1/verification.mjs");
  const store = createVerificationStore();
  const issued = store.issue("u1", "email");
  assert.equal(issued.ok, true);
  assert.equal("_devCode" in issued, false, "the code must not be in the response by default");
  assert.equal(JSON.stringify(issued).match(/\d{6}/), null, "and no six-digit value may appear anywhere in it");
  assert.equal("_devCode" in store.issue("u2", "email", { returnCodeForMockOnly: true }), true, "self-check: the opt-in still exists");

  const optIns = [];
  for (const rel of ["src/cw1/service.mjs", "src/cw1/mock-server.mjs", "src/cw1/identity-slice.mjs", "server.mts"]) {
    if (/returnCodeForMockOnly:\s*true/.test(fs.readFileSync(path.join(REPO, rel), "utf8"))) optIns.push(rel);
  }
  assert.deepEqual(optIns, ["src/cw1/mock-server.mjs"], "only the development mock may ask for the code back");

  const core = fs.readFileSync(path.join(REPO, "src/core/verification.mjs"), "utf8");
  const code = core.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert.equal(/_devCode/.test(code), false, "the real verification service has no _devCode field at all");
});

test("no module on the auth or persistence path carries a literal secret", async () => {
  // A standing check against the class the _devCode leak belonged to: a secret
  // written where a reader can see it. Comments are stripped first, so a
  // comment DESCRIBING a past leak is not mistaken for one.
  for (const rel of ["src/core/verification.mjs", "src/core/principal.mjs", "src/cw5/cw5_persistence.ts", "src/core/worldstore.mjs", "src/cw7/atlas-local-sign.mjs"]) {
    const code = fs.readFileSync(path.join(REPO, rel), "utf8").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    assert.equal(
      /(?:secret|password|api[_-]?key|private[_-]?key)\s*[:=]\s*["'][A-Za-z0-9+/_-]{16,}["']/i.test(code),
      false,
      `${rel} must not carry a literal secret`,
    );
  }
});
