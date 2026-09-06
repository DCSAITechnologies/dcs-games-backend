// B15 — the marketplace backend, prepared while money stays DARK.
//
// Round-2 called this "doubly dark": the router had no database client and its
// three tables did not exist. It is now built and testable, and the point of
// this file is to prove that no path through it can produce a non-zero amount.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMarketplaceService, SELLER_BPS, PLATFORM_BPS, LISTING_KINDS } from "../src/core/marketplace.mjs";

const svc = (extra = {}) => createMarketplaceService({ DCS_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "dcs-mkt-")), ...extra });

async function listed(m, sellerId = "seller") {
  return await m.createListing(sellerId, { title: "Ashfall Harbour", kind: "world", worldId: "w1" });
}

// =========================================================== the money guard

test("B15 GATE: setting a price is REFUSED, not silently zeroed", async () => {
  const m = svc();
  await assert.rejects(
    () => m.createListing("seller", { title: "Ashfall", priceMinor: 49900 }),
    (e) => e.httpStatus === 403 && /silently free/.test(e.detail)
  );
});

test("B15 GATE: every listing is zero-priced and marked test mode", async () => {
  const m = svc();
  const l = await listed(m);
  assert.equal(l.price_minor, 0);
  assert.equal(l.test_mode, true);
  const b = await m.browse();
  assert.equal(b.dark, true);
  assert.equal(b.payments_live, false);
  assert.match(b.note, /non-transactable/);
});

test("B15 GATE: acquiring transfers ownership at zero cost and settles nothing", async () => {
  const m = svc();
  const l = await listed(m);
  const r = await m.acquire("buyer", l.id);
  assert.equal(r.payments_live, false);
  assert.equal(r.ownership.acquired_price_minor, 0);
  assert.equal(r.ledger.gross_minor, 0);
  assert.equal(r.ledger.seller_minor, 0);
  assert.equal(r.ledger.platform_minor, 0);
  assert.equal(r.ledger.status, "test");
  // The split SHAPE is recorded so the model can be reviewed, at zero.
  assert.deepEqual(r.ledger.split_bps, { seller: SELLER_BPS, platform: PLATFORM_BPS });
});

test("B15 GATE: assertDark passes over a fully exercised marketplace", async () => {
  const m = svc();
  await m.createStorefront("seller", { name: "Nova Store" });
  const a = await listed(m, "seller");
  const b = await m.createListing("seller", { title: "A prop", kind: "asset" });
  await m.acquire("buyer", a.id);
  await m.acquire("buyer2", b.id);
  const d = await m.assertDark();
  assert.equal(d.dark, true, `money leaked: ${JSON.stringify(d.problems)}`);
  assert.deepEqual(d.problems, []);
});

test("B15 GATE: assertDark FAILS if a priced row ever appears", async () => {
  const m = svc();
  const l = await listed(m);
  // Simulate corruption: write a price directly past the service.
  const file = path.join(m.dir, "listings.json");
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  rows[0].price_minor = 999;
  fs.writeFileSync(file, JSON.stringify(rows));
  const d = await m.assertDark();
  assert.equal(d.dark, false, "the check must be able to fail, or it proves nothing");
  assert.match(d.problems[0], /carries a price/);
  void l;
});

test("B15 GATE: with payments enabled, acquiring is REFUSED — there is no PSP", async () => {
  const m = svc({ PAYMENTS_LIVE: "1" });
  const l = await m.createListing("seller", { title: "Ashfall", priceMinor: 49900 });
  assert.equal(l.price_minor, 0, "the service still refuses to record a price it cannot charge");
  await assert.rejects(
    () => m.acquire("buyer", l.id),
    (e) => e.httpStatus === 503 && /no PSP is integrated/.test(e.detail)
  );
});

test("B15: the ledger totals are real sums over real rows, and they are zero", async () => {
  const m = svc();
  const l = await listed(m);
  await m.acquire("buyer", l.id);
  const led = await m.ledgerFor("buyer");
  assert.equal(led.entries.length, 1);
  assert.equal(led.gross_minor, 0);
  assert.equal(led.seller_minor, 0);
  assert.equal(led.settled_count, 0);
  assert.equal(led.payments_live, false);
  assert.match(led.note, /nothing can be while payments are disabled/);
});

test("B15: the split model always balances, at any hypothetical gross", async () => {
  const m = svc();
  for (const gross of [0, 1, 99, 100, 4999, 49900, 1234567]) {
    const s = m.splitFor(gross);
    assert.equal(s.seller_minor + s.platform_minor, s.gross_minor, `split does not balance at ${gross}`);
    assert.equal(s.settles, false, "modelling a split must never imply it settles");
  }
  assert.equal(m.splitFor(10000).seller_minor, 7000);
  assert.equal(m.splitFor(10000).platform_minor, 3000);
  // Rounding remainder goes to the platform, so a creator is never short-changed
  // by more than the rounding and the books always balance.
  assert.equal(m.splitFor(1).seller_minor, 0);
  assert.equal(m.splitFor(1).platform_minor, 1);
});

// ================================================================ ownership

test("B15: acquiring twice is idempotent", async () => {
  const m = svc();
  const l = await listed(m);
  await m.acquire("buyer", l.id);
  const again = await m.acquire("buyer", l.id);
  assert.equal(again.idempotent, true);
  assert.equal((await m.ownedBy("buyer")).length, 1);
});

test("B15: you cannot acquire your own listing", async () => {
  const m = svc();
  const l = await listed(m, "seller");
  await assert.rejects(() => m.acquire("seller", l.id), (e) => e.httpStatus === 422);
});

test("B15: an unlisted item can no longer be acquired", async () => {
  const m = svc();
  const l = await listed(m);
  await m.unlist("seller", l.id);
  await assert.rejects(() => m.acquire("buyer", l.id), (e) => e.httpStatus === 404);
  assert.equal((await m.browse()).count, 0);
});

test("B15: only the seller can unlist", async () => {
  const m = svc();
  const l = await listed(m, "seller");
  await assert.rejects(() => m.unlist("someone-else", l.id), (e) => e.httpStatus === 404);
});

// =============================================================== storefronts

test("B15: a listing cannot be attached to someone else's storefront", async () => {
  const m = svc();
  const sf = await m.createStorefront("seller", { name: "Nova Store" });
  await assert.rejects(
    () => m.createListing("impostor", { storefrontId: sf.id, title: "Not mine" }),
    (e) => e.httpStatus === 403
  );
  const ok = await m.createListing("seller", { storefrontId: sf.id, title: "Mine" });
  assert.equal(ok.storefront_id, sf.id);
});

test("B15: validation refuses a bad kind, a missing title and an anonymous seller", async () => {
  const m = svc();
  await assert.rejects(() => m.createListing("s", { title: "x", kind: "unicorn" }), (e) => e.httpStatus === 422);
  await assert.rejects(() => m.createListing("s", { title: "" }), (e) => e.httpStatus === 422);
  await assert.rejects(() => m.createListing(null, { title: "Ashfall" }), (e) => e.httpStatus === 401);
  assert.ok(LISTING_KINDS.includes("world"));
});

test("B15: the service reports where it persists and that payments are off", async () => {
  const m = svc();
  const d = m.describe();
  assert.equal(d.payments_live, false);
  assert.equal(d.persistence, "file");
});
