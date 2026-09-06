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
