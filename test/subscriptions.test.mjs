// Capability 77 — DCS Plus subscriptions, recovered and BUILT_DARK.
//
// The build this replaces served one hard-coded `{plan:"dcs_plus",status:"active"}`
// out of an in-memory Map, for a user nobody had charged, behind a table that no
// migration created. The point of this file is to prove the replacement cannot
// do any of that: no customer can subscribe, every stored row is a comped
// internal-test grant, and the darkness check is able to FAIL.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createSubscriptionsService,
  PLANS, PLAN_IDS, GRANT_STATUSES, PAID_STATUSES, MONEY_SHAPED,
  INTERNAL_WINDOW_ENDS, SUBSCRIPTIONS_DDL,
} from "../src/core/subscriptions.mjs";

const svc = (extra = {}) => createSubscriptionsService({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-sub-")), ...extra });

const STAFF = { id: "staff_1", isInternalTester: true };
const TESTER = { id: "tester_1", isInternalTester: true };
const CUSTOMER = { id: "cust_1", isInternalTester: false };

// ============================================================ the money guard

test("77 GATE: a customer subscribing is REFUSED with 503, not given a free plan", async () => {
  const s = svc();
  await assert.rejects(
    () => s.subscribe(CUSTOMER.id, "dcs_plus"),
    (e) => e.httpStatus === 503 && /no PSP is integrated/.test(e.detail)
  );
  // The refusal must not leave a subscription behind.
  const st = await s.statusFor(CUSTOMER.id);
  assert.equal(st.plan, "free");
  assert.equal(st.status, "none");
  assert.equal((await s.listGrants()).count, 0);
});

test("77 GATE: the refusal says plainly that a plan was NOT granted instead", async () => {
  const s = svc();
  await assert.rejects(() => s.subscribe(CUSTOMER.id), (e) => {
    assert.match(e.detail, /a plan is not granted for free instead/);
    assert.equal(e.meta.psp_integrated, false);
    assert.equal(e.meta.window_ends, INTERNAL_WINDOW_ENDS);
    return true;
  });
});

test("77 GATE: PAYMENTS_LIVE=1 does not make subscribing possible — there is still no PSP", async () => {
  const s = svc({ PAYMENTS_LIVE: "1" });
  await assert.rejects(
    () => s.subscribe(CUSTOMER.id, "dcs_plus"),
    (e) => e.httpStatus === 503 && /no PSP is integrated/.test(e.detail)
  );
  assert.equal(s.describe().payments_live, true);
  assert.equal(s.describe().psp_integrated, false);
  assert.equal(s.describe().subscribable, false);
});

test("77 GATE: a refused attempt is recorded, because demand is the only honest output", async () => {
  const s = svc();
  await assert.rejects(() => s.subscribe(CUSTOMER.id, "dcs_plus"), (e) => e.httpStatus === 503);
  const ev = await s.eventsFor(CUSTOMER.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].event, "subscribe_refused");
  assert.equal(ev[0].plan, "dcs_plus");
});

test("77 GATE: there is no paid status to write into", async () => {
  const s = svc();
  const g = await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  assert.ok(GRANT_STATUSES.includes(g.status));
  for (const bad of PAID_STATUSES) assert.ok(!GRANT_STATUSES.includes(bad), `'${bad}' must not be writable`);
  assert.ok(!PAID_STATUSES.includes(g.status));
});

// ============================================================== the test grant

test("77: a comped grant is permanently marked test_mode, comped and unpaid", async () => {
  const s = svc();
  const g = await s.grantTestPlan(STAFF, TESTER, "dcs_plus", { reason: "entitlement smoke test" });
  assert.equal(g.plan, "dcs_plus");
  assert.equal(g.status, "comped");
  assert.equal(g.test_mode, true);
  assert.equal(g.comped, true);
  assert.equal(g.paid, false);
  assert.equal(g.price_minor, 0);
  assert.equal(g.granted_by, STAFF.id);
  assert.equal(g.reason, "entitlement smoke test");
  assert.match(g.note, /Nobody was charged/);
});

test("77: the grant survives a fresh service over the same directory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dcs-sub-"));
  const a = createSubscriptionsService({ DCS_DATA_DIR: dir });
  await a.grantTestPlan(STAFF, TESTER, "dcs_plus");
  // The old build kept this in a Map, so a restart erased it.
  const b = createSubscriptionsService({ DCS_DATA_DIR: dir });
  const st = await b.statusFor(TESTER.id);
  assert.equal(st.plan, "dcs_plus");
  assert.equal(st.active_grant, true);
  assert.equal(st.comped, true);
});

test("77: only an internal tester can comp a plan", async () => {
  const s = svc();
  await assert.rejects(
    () => s.grantTestPlan({ id: "rando", isInternalTester: false }, TESTER, "dcs_plus"),
    (e) => e.httpStatus === 403 && /only an internal tester can comp/.test(e.detail)
  );
  await assert.rejects(() => s.grantTestPlan(null, TESTER, "dcs_plus"), (e) => e.httpStatus === 401);
});

test("77: a customer cannot be comped either — that would be an unbillable plan", async () => {
  const s = svc();
  await assert.rejects(
    () => s.grantTestPlan(STAFF, CUSTOMER, "dcs_plus"),
    (e) => e.httpStatus === 403 && /a customer cannot be billed for it/.test(e.detail)
  );
  assert.equal((await s.statusFor(CUSTOMER.id)).plan, "free");
});

test("77: 'free' cannot be granted — it is the absence of a subscription", async () => {
  const s = svc();
  await assert.rejects(() => s.grantTestPlan(STAFF, TESTER, "free"), (e) => e.httpStatus === 422);
  await assert.rejects(() => s.grantTestPlan(STAFF, TESTER, "gold"), (e) => e.httpStatus === 422);
});

test("77: a grant cannot outlive the controlled internal window", async () => {
  const s = svc();
  await assert.rejects(
    () => s.grantTestPlan(STAFF, TESTER, "dcs_plus", { expiresAt: "2027-01-01" }),
    (e) => e.httpStatus === 422 && /cannot outlive the internal window/.test(e.detail)
  );
  const g = await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  assert.ok(new Date(g.expires_at).getTime() <= new Date(INTERNAL_WINDOW_ENDS + "T23:59:59Z").getTime());
});

test("77: an expired grant reads as free and says it expired", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus", { expiresAt: "2026-01-01" });
  const st = await s.statusFor(TESTER.id);
  assert.equal(st.plan, "free", "an expired grant must not still entitle");
  assert.equal(st.active_grant, false);
  assert.equal(st.expired, true, "it must say it expired rather than quietly reverting");
});

test("77: revoking is authorised, audited and takes effect", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  await assert.rejects(() => s.revokeTestPlan({ id: "rando", isInternalTester: false }, TESTER.id), (e) => e.httpStatus === 403);
  await assert.rejects(() => s.revokeTestPlan(STAFF, "nobody"), (e) => e.httpStatus === 404);
  const r = await s.revokeTestPlan(STAFF, TESTER.id);
  assert.equal(r.status, "revoked");
  assert.ok(r.revoked_at);
  const st = await s.statusFor(TESTER.id);
  assert.equal(st.plan, "free");
  assert.equal(st.active_grant, false);
  const ev = await s.eventsFor(TESTER.id);
  assert.deepEqual(ev.map((e) => e.event).sort(), ["granted", "revoked"]);
});

test("77: granting twice replaces the grant rather than stacking rows", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus", { reason: "first" });
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus", { reason: "second" });
  const g = await s.listGrants();
  assert.equal(g.count, 1);
  assert.equal(g.grants[0].reason, "second");
});

// ============================================================== entitlements

test("77: everyone who was never comped is free, with the free allowance", async () => {
  const s = svc();
  const e = await s.entitlementsFor("someone", { level: "builder", publishedCount: 0 });
  assert.equal(e.plan, "free");
  assert.equal(e.dcs_plus_effective, false);
  assert.equal(e.dcs_plus_paid, false);
  const credits = e.entitlements.find((x) => x.key === "publish_credits");
  assert.equal(credits.value, 1);
  assert.equal(credits.remaining, 1);
  assert.match(e.note, /Upgrading is not available/);
});

test("77: a comped plan reports the DCS Plus allowance, flagged as comped not paid", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  const e = await s.entitlementsFor(TESTER.id, { level: "publisher", publishedCount: 3 });
  assert.equal(e.plan, "dcs_plus");
  assert.equal(e.dcs_plus_effective, true);
  assert.equal(e.dcs_plus_paid, false, "a comped grant must never read as paid");
  assert.equal(e.comped, true);
  assert.equal(e.test_mode, true);
  const credits = e.entitlements.find((x) => x.key === "publish_credits");
  assert.equal(credits.value, 10);
  assert.equal(credits.remaining, 7);
  assert.match(e.note, /not a purchase/);
});

test("77: an unlimited allowance is null plus a flag, never a silent zero", async () => {
  const s = svc();
  const e = await s.entitlementsFor("v", { level: "verified_builder", publishedCount: 40 });
  const credits = e.entitlements.find((x) => x.key === "publish_credits");
  assert.equal(credits.value, null);
  assert.equal(credits.unlimited, true);
  assert.equal(credits.remaining, null);
  assert.equal(JSON.parse(JSON.stringify(credits)).value, null, "Infinity must not survive as 0 through JSON");
});

test("77 GATE: no entitlement is money-shaped, and each refusal is named", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  const e = await s.entitlementsFor(TESTER.id, { level: "publisher" });
  for (const ent of e.entitlements) {
    assert.ok(!MONEY_SHAPED.includes(ent.key), `'${ent.key}' is money-shaped and must not be granted`);
  }
  for (const key of MONEY_SHAPED) {
    const w = e.withheld.find((x) => x.key === key);
    assert.ok(w, `'${key}' must be refused by name, not merely absent`);
    assert.equal(w.granted, false);
    assert.match(w.why, /money is disabled/);
  }
  assert.equal(e.price_minor, 0);
  assert.equal(e.list_price_minor, null);
});

test("77: every reported entitlement names the code that actually enforces it", async () => {
  const s = svc();
  const e = await s.entitlementsFor("anyone");
  assert.ok(e.entitlements.length > 0);
  for (const ent of e.entitlements) {
    assert.equal(ent.enforced, true);
    assert.match(ent.enforced_by, /identity-core\.mjs/);
  }
});

// ================================================================= catalogue

test("77: no plan carries a price, and the missing price is stated not filled in", async () => {
  const s = svc();
  const c = s.plans();
  assert.equal(c.purchasable, false);
  assert.equal(c.psp_integrated, false);
  for (const p of c.plans) {
    assert.equal(p.price_minor, 0);
    assert.equal(p.list_price_minor, null);
    assert.equal(p.purchasable, false);
    assert.match(p.price_note, /\S/);
  }
  assert.deepEqual(PLANS.map((p) => p.id), PLAN_IDS);
});

// =================================================================== the check

test("77 GATE: assertDark passes over a fully exercised subscriptions service", async () => {
  const s = svc();
  await assert.rejects(() => s.subscribe(CUSTOMER.id, "dcs_plus"), (e) => e.httpStatus === 503);
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus", { reason: "smoke" });
  await s.grantTestPlan(STAFF, { id: "tester_2", isInternalTester: true }, "dcs_plus");
  await s.revokeTestPlan(STAFF, "tester_2");
  const d = await s.assertDark();
  assert.equal(d.dark, true, `money leaked: ${JSON.stringify(d.problems)}`);
  assert.deepEqual(d.problems, []);
});

test("77 GATE: assertDark FAILS if a row is given a price directly", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  const file = path.join(s.dir, "subscriptions.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  rows[0].price_minor = 49900;
  fs.writeFileSync(file, JSON.stringify(rows));
  const d = await s.assertDark();
  assert.equal(d.dark, false, "the check must be able to fail, or it proves nothing");
  assert.match(d.problems.join(" "), /carries a price/);
});

test("77 GATE: assertDark FAILS on the exact fixture row the old build shipped", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  const file = path.join(s.dir, "subscriptions.json");
  // {"plan":"dcs_plus","status":"active"} — what capability 77 used to return.
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  rows[0].status = "active";
  rows[0].comped = false;
  rows[0].test_mode = false;
  fs.writeFileSync(file, JSON.stringify(rows));
  const d = await s.assertDark();
  assert.equal(d.dark, false);
  const joined = d.problems.join(" ");
  assert.match(joined, /paid status 'active'/);
  assert.match(joined, /not marked comped/);
  assert.match(joined, /not marked test_mode/);
});

test("77 GATE: assertDark FAILS if a grant is edited to outlive the internal window", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  const file = path.join(s.dir, "subscriptions.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  rows[0].expires_at = "2030-01-01T00:00:00.000Z";
  fs.writeFileSync(file, JSON.stringify(rows));
  const d = await s.assertDark();
  assert.equal(d.dark, false);
  assert.match(d.problems.join(" "), /outlives the internal window/);
});

test("77 GATE: assertDark FAILS while PAYMENTS_LIVE is set", async () => {
  const s = svc({ PAYMENTS_LIVE: "1" });
  const d = await s.assertDark();
  assert.equal(d.dark, false);
  assert.match(d.problems.join(" "), /PAYMENTS_LIVE is set/);
});

// ================================================================ reporting

test("77: with nobody comped, listGrants is an honest empty rather than a fixture", async () => {
  const s = svc();
  const g = await s.listGrants();
  assert.equal(g.count, 0);
  assert.deepEqual(g.grants, []);
  assert.equal(g.total_price_minor, 0);
  assert.equal(g.paid_count, 0);
  assert.match(g.note, /No subscription has ever been granted/);
});

test("77: the grant totals are real sums over real rows, and they are zero", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  await s.grantTestPlan(STAFF, { id: "tester_2", isInternalTester: true }, "dcs_plus");
  const g = await s.listGrants();
  assert.equal(g.count, 2);
  assert.equal(g.total_price_minor, 0);
  assert.equal(g.paid_count, 0);
});

test("77: the service reports where it persists and that nothing is subscribable", async () => {
  const s = svc();
  const d = s.describe();
  assert.equal(d.persistence, "file");
  assert.equal(d.payments_live, false);
  assert.equal(d.subscribable, false);
  // The schema half of the invariant is in the chain now, and whether it has
  // been APPLIED is unknown from this process — which it says, rather than
  // implying a durability it cannot see.
  assert.equal(d.schema_applied, null, "this process cannot see which migrations a database has run");
  assert.equal(d.schema_migration, "migrations/0008_subscriptions_dark.sql");
  assert.match(d.schema_note, /not knowable from this process/);
  // The claim is checked against the disk rather than believed.
  assert.ok(fs.existsSync(path.join(import.meta.dirname, "..", d.schema_migration)), "describe() names a migration that must actually exist");
});

test("77: the DDL holds the same invariant the code holds", async () => {
  // The marketplace holds its guard in code AND in migration 0006. This service
  // can only ship half of that from this lane, so the other half is specified
  // here and checked, rather than assumed.
  assert.match(SUBSCRIPTIONS_DDL, /price_minor\s+integer\s+not null default 0 check \(price_minor = 0\)/);
  assert.match(SUBSCRIPTIONS_DDL, /check \(test_mode = true and comped = true and price_minor = 0\)/);
  assert.match(SUBSCRIPTIONS_DDL, /check \(status in \('comped','revoked'\)\)/);
  for (const bad of PAID_STATUSES) {
    assert.ok(!new RegExp("'" + bad + "'").test(SUBSCRIPTIONS_DDL.split("create table")[1]), `the DDL must not permit status '${bad}'`);
  }
});

test("77: an anonymous caller cannot subscribe", async () => {
  const s = svc();
  await assert.rejects(() => s.subscribe(null, "dcs_plus"), (e) => e.httpStatus === 401);
  await assert.rejects(() => s.subscribe("someone", "gold"), (e) => e.httpStatus === 422);
});

// ============================================== the never-expiring grant (R3)
//
// The default expiry protected the careless caller but not the deliberate one:
// grantTestPlan(..., { expiresAt: null }) wrote expires_at:null and isLive()
// treated a row with no expiry as live forever — a comped plan that outlives the
// controlled internal window, which is the one thing it may not do. Migration
// 0008 declares the column NOT NULL; the service now agrees with it.

test("R3 GATE: a test grant cannot be made never-expiring", async () => {
  const s = svc();
  for (const bad of [null, ""]) {
    await assert.rejects(
      () => s.grantTestPlan(STAFF, TESTER, "dcs_plus", { expiresAt: bad }),
      (e) => e.httpStatus === 422 && /must expire/.test(e.detail),
    );
  }
  assert.equal((await s.listGrants()).count, 0, "the refusal must not leave a row behind");
});

test("R3 GATE: a row with no expiry does not entitle, and assertDark fails on it", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus");
  const file = path.join(s.dir, "subscriptions.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  rows[0].expires_at = null;                       // an import, or a hand edit
  fs.writeFileSync(file, JSON.stringify(rows));

  const st = await s.statusFor(TESTER.id);
  assert.equal(st.plan, "free", "a grant that never ends must not still entitle");
  assert.equal(st.active_grant, false);
  const d = await s.assertDark();
  assert.equal(d.dark, false, "the check must be able to fail, or it proves nothing");
  assert.match(d.problems.join(" "), /never expires/);
});

test("R3: the exported DDL has not drifted from migrations/0008", async () => {
  const applied = fs.readFileSync(path.join(import.meta.dirname, "..", "migrations", "0008_subscriptions_dark.sql"), "utf8");
  for (const guard of [
    "check (plan in ('free','dcs_plus'))",
    "check (status in ('comped','revoked'))",
    "check (test_mode = true and comped = true and price_minor = 0)",
    "expires_at   timestamptz not null",
    "check (expires_at <= timestamptz '2026-10-01T00:00:00Z')",
  ]) {
    assert.ok(applied.includes(guard), `migration 0008 must hold: ${guard}`);
    assert.ok(SUBSCRIPTIONS_DDL.includes(guard), `SUBSCRIPTIONS_DDL must mirror: ${guard}`);
  }
});

// ================================================ a comp is never revenue (R3)

test("R3 GATE: comping does not move any money-shaped total, count or aggregate", async () => {
  const s = svc();
  await s.grantTestPlan(STAFF, TESTER, "dcs_plus", { reason: "entitlement smoke test" });
  await s.grantTestPlan(STAFF, { id: "tester_2", isInternalTester: true }, "dcs_plus");
  const g = await s.listGrants();
  assert.equal(g.count, 2, "two grants exist");
  assert.equal(g.comped_count, 2, "and both are comped");
  assert.equal(g.paid_count, 0, "none is a sale");
  assert.equal(g.total_price_minor, 0);
  assert.equal(g.revenue_minor, 0, "a count of grants is not a count of sales");
  for (const row of g.grants) {
    assert.equal(row.price_minor, 0);
    assert.equal(row.comped, true);
    assert.equal(row.test_mode, true);
    assert.ok(!PAID_STATUSES.includes(row.status));
  }
  // And the entitlement side reports the same separation.
  const ent = await s.entitlementsFor(TESTER.id, { level: "explorer", publishedCount: 0 });
  assert.equal(ent.dcs_plus_effective, true);
  assert.equal(ent.dcs_plus_paid, false);
  assert.equal(ent.price_minor, 0);
});
